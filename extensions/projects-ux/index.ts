import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

type Project = {
  id: string;
  name: string;
  archived?: boolean;
  createdAt: string;
  lastUsedAt?: string;
  note?: string;

  // Projects-scoped durable memory (managed by /memory).
  tokens?: string[];
};

type PendingWipe = {
  nonce: string;
  createdAtMs: number;
  kind: "all" | "project";
  projectId?: string;
  // Preview info (also returned to user)
  stamp: string;
  backupDir: string;
};

type PeerState = {
  version: 1;
  /** When false, route messages to the Classic (base) session (no :proj: suffix). */
  projectsEnabled?: boolean;

  activeProjectId: string;
  // Previously active project (used for deterministic switch semantics).
  previousProjectId?: string;
  // Message id from which the current activeProjectId becomes effective (channel-specific).
  effectiveFromMessageId?: number;
  lastProjectId?: string;
  pendingReset?: boolean;
  projects: Project[];

  // Global (cross-project) durable memory (managed by /memory global ...).
  globalTokens?: string[];

  // Guarded destructive ops.
  pendingWipe?: PendingWipe;
};

type Store = {
  version: 1;
  peers: Record<string, PeerState>;
};

function nowIso() {
  return new Date().toISOString();
}

function slugifyId(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function randomId(prefix = "p") {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function randomNonce(bytes = 4) {
  return crypto.randomBytes(bytes).toString("hex");
}

function formatBackupStamp(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function ensureDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown) {
  await ensureDir(filePath);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.rename(tmp, filePath);
}

function buildPeerKeyFromCommandCtx(ctx: { channel?: string; senderId?: string | null }) {
  const channel = (ctx.channel ?? "unknown").toLowerCase();
  const senderId = (ctx.senderId ?? "unknown").toString();
  return `${channel}:${senderId}`;
}

function extractTelegramDmPeerIdFromSessionKey(sessionKey: string): string | null {
  // Typical DM session key: agent:<agentId>:telegram:dm:<peerId>
  const m = sessionKey.toLowerCase().match(/:telegram:dm:([^:]+)$/);
  return m?.[1] ?? null;
}

function buildPeerKeyFromBeforeAgentStart(ctx: { sessionKey?: string; channelId?: string; conversationId?: string }) {
  const sessionKeyRaw = (ctx.sessionKey ?? "");
  const sessionKey = sessionKeyRaw.toLowerCase();
  const channel = (ctx.channelId ?? "unknown").toLowerCase();

  // Telegram: channelId may be undefined in some gateway contexts; detect via sessionKey.
  if (channel === "telegram" || sessionKey.includes(":telegram:")) {
    const peer = extractTelegramDmPeerIdFromSessionKey(sessionKey);
    if (peer) return `telegram:${peer}`;
  }

  const conv = (ctx.conversationId ?? "").trim();
  if (conv) return `${channel}:${conv}`;
  if (sessionKeyRaw) return `${channel}:${sessionKeyRaw}`;
  return `${channel}:unknown`;
}

function clampText(text: string, maxChars: number) {
  if (maxChars <= 0) return "";
  const t = text ?? "";
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}

function renderProjectList(projects: Project[]) {
  const active = projects.filter((p) => !p.archived);
  if (active.length === 0) return "(no projects)";
  return active
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt))
    .map((p) => `- ${p.name} (${p.id})`)
    .join("\n");
}

function buildProjectButtons(peer: PeerState | undefined) {
  const projects = peer?.projects ?? [];
  const active = projects.filter((p) => !p.archived);
  const top = active
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt))
    .slice(0, 8);

  // Telegram inline keyboard is rows of buttons.
  // Keep it simple: 2 columns.
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  // Mode toggle row first.
  // Button text should describe the action (not just display the current state).
  const enabled = peer?.projectsEnabled === true;
  rows.push([
    enabled
      ? { text: "Turn Projects OFF (Classic)", callback_data: "/projects off" }
      : { text: "Turn Projects ON", callback_data: "/projects on" },
  ]);

  for (let i = 0; i < top.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    const a = top[i];
    const b = top[i + 1];
    if (a) row.push({ text: a.name, callback_data: `/projects switch ${a.id}` });
    if (b) row.push({ text: b.name, callback_data: `/projects switch ${b.id}` });
    rows.push(row);
  }

  rows.push([{ text: "New project", callback_data: "/projects new" }]);
  rows.push([{ text: "More…", callback_data: "/projects more" }]);
  return rows;
}

async function loadStore(filePath: string): Promise<Store> {
  const data = await readJson<Store>(filePath);
  if (data && data.version === 1 && data.peers && typeof data.peers === "object") {
    return data;
  }
  return { version: 1, peers: {} };
}

function sanitizeRoomKeySuffixToken(input: string) {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function withPeerState<T>(filePath: string, peerKey: string, fn: (peer: PeerState) => T): Promise<{ store: Store; result: T }> {
  const store = await loadStore(filePath);
  const existing = store.peers[peerKey];
  const peer: PeerState = existing && existing.version === 1
    ? existing
    : {
        version: 1,
        projectsEnabled: false,
        activeProjectId: "",
        projects: [],
      };

  const result = fn(peer);
  store.peers[peerKey] = peer;
  await writeJsonAtomic(filePath, store);
  return { store, result };
}

function ensureDefaultProject(peer: PeerState, defaultProjectName: string): boolean {
  let changed = false;

  // Migration: older versions used a default project name of "Inbox" (legacy).
  // Users read "Inbox" as "the classic chat", which is not true in Projects mode.
  // Rename legacy "Inbox" projects to the configured default (default: "General") and persist.
  for (const p of peer.projects) {
    const name = (p.name ?? "").trim().toLowerCase();
    const id = (p.id ?? "").trim().toLowerCase();
    if (name === "inbox" || id === "proj-inbox" || id.startsWith("inbox-")) {
      if (p.name !== defaultProjectName) {
        p.name = defaultProjectName;
        changed = true;
      }
    }
  }

  if (peer.projects.length === 0) {
    const id = `proj-${slugifyId(defaultProjectName) || "general"}`;
    const p: Project = {
      id,
      name: defaultProjectName,
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
      tokens: [],
    };
    peer.projects.push(p);
    peer.activeProjectId = id;
    peer.lastProjectId = id;
    peer.pendingReset = false;
    changed = true;
  }

  // Ensure tokens arrays exist.
  for (const p of peer.projects) {
    if (!Array.isArray(p.tokens)) {
      p.tokens = [];
      changed = true;
    }
  }
  if (!Array.isArray(peer.globalTokens)) {
    peer.globalTokens = [];
    changed = true;
  }

  if (!peer.activeProjectId) {
    const first = peer.projects.find((p) => !p.archived) ?? peer.projects[0];
    if (first) {
      peer.activeProjectId = first.id;
      changed = true;
    }
  }

  // Default OFF unless explicitly enabled.
  if (typeof peer.projectsEnabled !== "boolean") {
    peer.projectsEnabled = false;
    changed = true;
  }

  return changed;
}

function findProject(peer: PeerState, key: string): Project | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  const byId = peer.projects.find((p) => p.id === trimmed);
  if (byId) return byId;
  const lower = trimmed.toLowerCase();
  const byName = peer.projects.find((p) => p.name.toLowerCase() === lower);
  return byName ?? null;
}

export default function (api: any) {
  const cfg = api.pluginConfig ?? {};
  const storagePath = api.resolvePath?.(cfg.storagePath ?? "~/.openclaw/projects-ux/state.json") ?? "~/.openclaw/projects-ux/state.json";
  const defaultProjectName = String(cfg.defaultProjectName ?? "General");
  const maxProjects = Number.isFinite(cfg.maxProjects) ? Math.trunc(cfg.maxProjects) : 50;
  const maxInjectedNoteChars = Number.isFinite(cfg.maxInjectedNoteChars) ? Math.trunc(cfg.maxInjectedNoteChars) : 600;
  const maxPrefixChars = Number.isFinite(cfg.maxPrefixChars) ? Math.trunc(cfg.maxPrefixChars) : 240;

  const hardIsolationEnabled = Boolean(cfg?.hardIsolation?.enabled);
  const wipeConfirmTtlMs = 2 * 60 * 1000;

  const projectsUxDir = path.dirname(storagePath);
  const projectsUxParentDir = path.dirname(projectsUxDir);

  function buildWipePreview(peerKey: string, pending: PendingWipe) {
    return (
      "This will delete all Projects state for this DM (projects list + project-scoped memory + any plugin-managed global tokens).\n" +
      "It will NOT delete anything under ~/projects/ on disk.\n\n" +
      `Peer: ${peerKey}\n` +
      `Will delete: ${projectsUxDir}\n` +
      `Backup will be written to: ${pending.backupDir}\n\n` +
      "Confirm within 120s:\n" +
      `/projects wipe confirm ${pending.nonce}`
    );
  }

  async function wipeProjectsUxForPeer(peerKey: string, messageId?: number) {
    const store = await loadStore(storagePath);
    const existingPeer = store.peers[peerKey] as PeerState | undefined;

    // Preserve global policy settings; wipe resets only user data.
    const freshPeer: PeerState = {
      version: 1,
      projectsEnabled: false,
      activeProjectId: "",
      projects: [],
      previousProjectId: "",
      lastProjectId: "",
      pendingReset: false,
      effectiveFromMessageId: typeof messageId === "number" ? messageId : undefined,
      globalTokens: [],
      pendingWipe: undefined,
    };

    // Ensure one default project exists.
    ensureDefaultProject(freshPeer, defaultProjectName);

    // Write peer back.
    store.peers[peerKey] = freshPeer;
    await writeStoreAndRefreshCache(store);

    // Also reset in-memory cache entry if present.
    cachedStore = store;
    cachedStoreLoadedAtMs = Date.now();

    return { ok: true, peer: freshPeer, hadPeer: Boolean(existingPeer) };
  }

  async function backupAndResetProjectsUx(peerKey: string, pending: PendingWipe, messageId?: number) {
    const stamp = pending.stamp;
    const backupDir = pending.backupDir;
    const backupTarget = path.join(backupDir, "projects-ux");

    // Backup MUST happen before any mutation.
    await fs.mkdir(backupDir, { recursive: true });
    try {
      await fs.cp(projectsUxDir, backupTarget, { recursive: true });
    } catch (err: any) {
      // ENOENT is fine (no prior state). Any other backup failure aborts.
      if (err?.code === "ENOENT") {
        await fs.mkdir(backupTarget, { recursive: true });
      } else {
        throw err;
      }
    }

    // Atomic-ish: rename the plugin directory away.
    const deletingDir = `${projectsUxDir}.DELETING.${stamp}`;
    try {
      await fs.rename(projectsUxDir, deletingDir);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }

    // Recreate baseline directory immediately.
    await fs.mkdir(projectsUxDir, { recursive: true });

    // Preserve other peers and future plugin files by copying back the old directory contents,
    // then rewriting state.json for the target peer.
    try {
      await fs.cp(deletingDir, projectsUxDir, { recursive: true });
    } catch {
      // ok
    }

    // Reset only THIS peer's data.
    await wipeProjectsUxForPeer(peerKey, messageId);

    // Best-effort delete of the renamed dir.
    try {
      await fs.rm(deletingDir, { recursive: true, force: true });
    } catch {
      // keep it; backup already exists
    }

    return { ok: true, backupDir };
  }

  async function backupAndWipeOneProject(peerKey: string, pending: PendingWipe, projectId: string, messageId?: number) {
    const stamp = pending.stamp;
    const backupDir = pending.backupDir;
    const backupTarget = path.join(backupDir, "projects-ux");

    // Backup MUST happen before any mutation.
    await fs.mkdir(backupDir, { recursive: true });
    try {
      await fs.cp(projectsUxDir, backupTarget, { recursive: true });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        await fs.mkdir(backupTarget, { recursive: true });
      } else {
        return { ok: false, error: `Backup failed; aborting wipe. (${String(err?.code ?? err)})` };
      }
    }

    const store = await loadStore(storagePath);
    const peer = store.peers[peerKey] as PeerState | undefined;
    if (!peer) {
      return { ok: false, error: "Refused: no peer state." };
    }

    const changed = ensureDefaultProject(peer, defaultProjectName);
    if (changed) {
      store.peers[peerKey] = peer;
    }

    const defaultProjectId = `proj-${slugifyId(defaultProjectName) || "general"}`;
    if (projectId === defaultProjectId) {
      return { ok: false, error: "Refused: default project cannot be wiped." };
    }

    const target = peer.projects.find((p) => p.id === projectId && !p.archived) ?? null;
    if (!target) {
      return { ok: false, error: `Refused: unknown projectId: ${projectId}` };
    }

    // Remove only the target project's plugin-owned state.
    peer.projects = peer.projects.filter((p) => p.id !== projectId);

    const wasActive = peer.activeProjectId === projectId;
    const wasPrev = peer.previousProjectId === projectId;
    const wasLast = peer.lastProjectId === projectId;

    if (wasActive || wasPrev || wasLast) {
      peer.activeProjectId = defaultProjectId;
      peer.previousProjectId = undefined;
      peer.lastProjectId = defaultProjectId;
      peer.pendingReset = true;
    }

    // Preserve Projects mode flag.
    if (peer.projectsEnabled !== true && peer.projectsEnabled !== false) {
      peer.projectsEnabled = false;
    }

    if (typeof messageId === "number") {
      peer.effectiveFromMessageId = messageId;
    }

    // Ensure the peer has a valid default project.
    ensureDefaultProject(peer, defaultProjectName);

    store.peers[peerKey] = peer;
    await writeStoreAndRefreshCache(store);

    const active = peer.projects.find((p) => p.id === peer.activeProjectId) ?? peer.projects[0];

    return {
      ok: true,
      backupDir,
      projectName: target.name,
      projectsEnabled: peer.projectsEnabled === true,
      activeProjectName: active?.name ?? defaultProjectName,
    };
  }

  // In-memory store cache (avoid reading JSON on every inbound message).
  let cachedStore: Store | null = null;
  let cachedStoreLoadedAtMs = 0;
  let cachedStoreMtimeMs = 0;

  async function loadStoreCached(): Promise<Store> {
    const now = Date.now();
    // TTL-based refresh to cap stat() overhead.
    const ttlMs = 1000;
    if (cachedStore && now - cachedStoreLoadedAtMs < ttlMs) return cachedStore;

    try {
      const st = await fs.stat(storagePath);
      const mtime = st.mtimeMs;
      if (cachedStore && mtime === cachedStoreMtimeMs) {
        cachedStoreLoadedAtMs = now;
        return cachedStore;
      }
      const store = await loadStore(storagePath);
      cachedStore = store;
      cachedStoreLoadedAtMs = now;
      cachedStoreMtimeMs = mtime;
      return store;
    } catch {
      const store = await loadStore(storagePath);
      cachedStore = store;
      cachedStoreLoadedAtMs = now;
      cachedStoreMtimeMs = 0;
      return store;
    }
  }

  async function writeStoreAndRefreshCache(store: Store) {
    await writeJsonAtomic(storagePath, store);
    cachedStore = store;
    cachedStoreLoadedAtMs = Date.now();
    try {
      const st = await fs.stat(storagePath);
      cachedStoreMtimeMs = st.mtimeMs;
    } catch {
      cachedStoreMtimeMs = 0;
    }
  }

  // -----------------------------
  // Commands
  // -----------------------------

  const handleProjectsCommand = async (ctx: any) => {
      const peerKey = buildPeerKeyFromCommandCtx(ctx);
      const args = (ctx.args ?? "").trim();
      const messageId = typeof ctx.messageId === "number" ? ctx.messageId : undefined;

      const help = () => ({
        text:
          "Projects mode is a routing mode:\n" +
          "- Classic (OFF): one normal chat history\n" +
          "- Projects (ON): separate history per project\n\n" +
          "Commands:\n" +
          "/projects\n" +
          "/projects on\n" +
          "/projects off\n" +
          "/projects list\n" +
          "/projects new <name>\n" +
          "/projects switch <name|id>\n" +
          "/projects more\n" +
          "/projects wipe\n\n" +
          "Alias (deprecated): /project\n\n" +
          "Durable memory (scoped by default):\n" +
          "/memory remember <token>\n" +
          "/memory list\n" +
          "/memory global remember <token>\n" +
          "/memory global list\n",
      });

      // /projects new (no args) -> prompt user
      if (args === "new") {
        return {
          text: "Usage: /projects new <name>",
        };
      }

      const parts = args ? args.split(/\s+/) : [];
      const sub = (parts[0] ?? "").toLowerCase();

      if (!sub) {
        const store = await loadStore(storagePath);
        const peer = store.peers[peerKey] as PeerState | undefined;

        if (peer) {
          const changed = ensureDefaultProject(peer, defaultProjectName);
          if (changed) {
            store.peers[peerKey] = peer;
            await writeStoreAndRefreshCache(store);
          }
        }

        const enabled = peer?.projectsEnabled === true;
        const modeLine = enabled ? "Mode: Projects ON" : "Mode: Classic (Projects OFF)";

        const p = peer?.projects?.find((x) => x.id === peer?.activeProjectId) ?? null;
        const current = p ? `${p.name} (${p.id})` : "(none)";

        const warning = enabled
          ? ""
          : "\n\nProjects are OFF. Turning ON creates separate histories.";

        return {
          text:
            `${modeLine}${warning}\n\n` +
            `Active project: ${current}\n\n` +
            "Use /projects on/off, /projects list, /projects new <name>, or /projects switch <name|id>.",
          channelData: {
            telegram: {
              buttons: buildProjectButtons(peer),
            },
          },
        };
      }

      if (sub === "help") return help();

      if (sub === "debug") {
        const store = await loadStore(storagePath);
        const peer = store.peers[peerKey] as PeerState | undefined;
        if (!peer) {
          return {
            text:
              "No peer state yet.\n\n" +
              "Send /projects on or /projects new <name> to initialize Projects state for this DM.",
          };
        }

        const changed = ensureDefaultProject(peer, defaultProjectName);
        if (changed) {
          store.peers[peerKey] = peer;
          await writeStoreAndRefreshCache(store);
        }

        const enabled = peer.projectsEnabled === true;
        const active = peer.projects.find((p) => p.id === peer.activeProjectId) ?? null;
        const prev = peer.previousProjectId ?? "(none)";
        const eff = typeof peer.effectiveFromMessageId === "number" ? peer.effectiveFromMessageId : null;

        const suffix = active ? sanitizeRoomKeySuffixToken(active.id) : "";
        const routing =
          hardIsolationEnabled && enabled && suffix
            ? `will append :proj:${suffix} to the base DM session key`
            : "will NOT append any :proj: suffix (Classic/base session)";

        const lines = [
          `Mode: ${enabled ? "Projects ON" : "Classic (Projects OFF)"}`,
          `hardIsolationEnabled: ${hardIsolationEnabled ? "true" : "false"}`,
          `activeProject: ${active ? `${active.name} (${active.id})` : "(none)"}`,
          `previousProjectId: ${prev}`,
          `effectiveFromMessageId: ${eff ?? "(none)"}`,
          `Routing: ${routing}`,
        ];

        return { text: lines.join("\n") };
      }

      if (sub === "more") {
        return {
          text: "More…",
          channelData: {
            telegram: {
              buttons: [
                [{ text: "Back", callback_data: "/projects" }],
                [
                  { text: "Debug", callback_data: "/projects debug" },
                  { text: "Memory…", callback_data: "/projects memory" },
                ],
                [{ text: "Reset…", callback_data: "/projects reset" }],
              ],
            },
          },
        };
      }

      if (sub === "memory") {
        return {
          text:
            "Memory (scoped):\n" +
            "- /memory remember <token>\n" +
            "- /memory list\n\n" +
            "Global memory (explicit):\n" +
            "- /memory global remember <token>\n" +
            "- /memory global list\n\n" +
            "Note: transcripts are never modified by Projects reset/wipe.",
          channelData: {
            telegram: {
              buttons: [[{ text: "Back", callback_data: "/projects more" }]],
            },
          },
        };
      }

      if (sub === "reset") {
        const action = (parts[1] ?? "").toLowerCase();

        if (!action) {
          return {
            text:
              "Reset / Wipe (Projects-UX state for this DM)\n\n" +
              "- Remove (wipe) ONE project…\n" +
              "- Wipe ALL projects… (recovery)\n\n" +
              "Transcripts/history are never deleted.",
            channelData: {
              telegram: {
                buttons: [
                  [{ text: "Cancel", callback_data: "/projects more" }],
                  [{ text: "Remove (wipe) ONE project…", callback_data: "/projects reset remove" }],
                  [{ text: "Wipe ALL projects…", callback_data: "/projects wipe" }],
                ],
              },
            },
          };
        }

        if (action === "remove") {
          const projectId = parts[2] ?? "";
          const store = await loadStore(storagePath);
          const peer = store.peers[peerKey] as PeerState | undefined;
          if (!peer) return { text: "No Projects state yet for this DM." };

          const changed = ensureDefaultProject(peer, defaultProjectName);
          if (changed) {
            store.peers[peerKey] = peer;
            await writeStoreAndRefreshCache(store);
          }

          const defaultProjectId = `proj-${slugifyId(defaultProjectName) || "general"}`;
          const candidates = peer.projects.filter((p) => !p.archived && p.id !== defaultProjectId);

          // No id -> show picker
          if (!projectId) {
            if (candidates.length === 0) {
              return {
                text: "No removable projects (only the default project exists).",
                channelData: { telegram: { buttons: [[{ text: "Back", callback_data: "/projects reset" }]] } },
              };
            }

            const rows: Array<Array<{ text: string; callback_data: string }>> = [];
            for (let i = 0; i < candidates.length; i += 2) {
              const row: Array<{ text: string; callback_data: string }> = [];
              const a = candidates[i];
              const b = candidates[i + 1];
              if (a) row.push({ text: a.name, callback_data: `/projects reset remove ${a.id}` });
              if (b) row.push({ text: b.name, callback_data: `/projects reset remove ${b.id}` });
              rows.push(row);
            }
            rows.push([{ text: "Cancel", callback_data: "/projects reset" }]);

            return {
              text: "Select a project to wipe (default project cannot be removed):",
              channelData: { telegram: { buttons: rows } },
            };
          }

          // Arm per-project wipe confirmation
          if (projectId === defaultProjectId) {
            return { text: "Refused: default project cannot be wiped." };
          }
          const project = peer.projects.find((p) => p.id === projectId && !p.archived) ?? null;
          if (!project) {
            return { text: `Refused: unknown projectId: ${projectId}` };
          }

          const stamp = formatBackupStamp();
          const pending: PendingWipe = {
            kind: "project",
            projectId,
            nonce: randomNonce(4),
            createdAtMs: Date.now(),
            stamp,
            backupDir: path.join(projectsUxParentDir, `backup_projects_ux_${stamp}`),
          };
          peer.pendingWipe = pending;
          store.peers[peerKey] = peer;
          await writeStoreAndRefreshCache(store);

          return {
            text:
              `This will wipe ONE project for this DM:\n\n` +
              `Project: ${project.name} (${project.id})\n` +
              "Removes: project entry + project-scoped memory (plugin-owned).\n" +
              `Backup: ${pending.backupDir}\n\n` +
              "Confirm within 120s.",
            channelData: {
              telegram: {
                buttons: [
                  [{ text: "Cancel", callback_data: "/projects wipe cancel" }],
                  [{ text: "Confirm WIPE", callback_data: `/projects wipe project confirm ${pending.nonce} ${project.id}` }],
                ],
              },
            },
          };
        }

        return { text: "Unknown reset action." };
      }

      if (sub === "wipe") {
        const store = await loadStore(storagePath);
        const peer = (store.peers[peerKey] as PeerState | undefined) ?? {
          version: 1,
          projectsEnabled: false,
          activeProjectId: "",
          projects: [],
          globalTokens: [],
        };

        const action = (parts[1] ?? "").toLowerCase();

        const clearPending = async () => {
          if (peer.pendingWipe) {
            peer.pendingWipe = undefined;
            store.peers[peerKey] = peer;
            await writeStoreAndRefreshCache(store);
          }
        };

        // Cancel
        if (action === "cancel") {
          await clearPending();
          return { text: "Cancelled. Nothing was deleted." };
        }

        // Confirm ALL: /projects wipe confirm <nonce>
        if (action === "confirm") {
          const argNonce = parts[2] ?? "";
          const pending = peer.pendingWipe;
          if (!pending) return { text: "No wipe pending. Use /projects → More… → Reset…" };

          const expired = Date.now() - pending.createdAtMs > wipeConfirmTtlMs;
          const mismatch = !argNonce || argNonce !== pending.nonce || pending.kind !== "all";
          if (expired) {
            await clearPending();
            return { text: "Refused: nonce expired. Re-run Reset…" };
          }
          if (mismatch) {
            await clearPending();
            return { text: "Refused: nonce mismatch or wrong scope. Re-run Reset…" };
          }

          await clearPending();

          const res = await backupAndResetProjectsUx(peerKey, pending, messageId);
          return {
            text:
              "WIPED ALL projects state for this DM.\n" +
              `Backup: ${res.backupDir}\n` +
              "Mode: Classic (Projects OFF)\n" +
              "Active project: " + defaultProjectName + "\n\n" +
              "Next: /projects (or /projects debug)",
          };
        }

        // Confirm ONE: /projects wipe project confirm <nonce> <id>
        if (action === "project" && (parts[2] ?? "").toLowerCase() === "confirm") {
          const argNonce = parts[3] ?? "";
          const projectId = parts[4] ?? "";
          const pending = peer.pendingWipe;
          if (!pending) return { text: "No wipe pending. Use /projects → More… → Reset…" };

          const expired = Date.now() - pending.createdAtMs > wipeConfirmTtlMs;
          const mismatch =
            !argNonce ||
            argNonce !== pending.nonce ||
            pending.kind !== "project" ||
            !pending.projectId ||
            pending.projectId !== projectId;

          if (expired) {
            await clearPending();
            return { text: "Refused: nonce expired. Re-run Reset…" };
          }
          if (mismatch) {
            await clearPending();
            return { text: "Refused: nonce mismatch or wrong projectId. Re-run Reset…" };
          }

          // Execute per-project wipe.
          await clearPending();
          const res = await backupAndWipeOneProject(peerKey, pending, projectId, messageId);
          if (!res.ok) return { text: res.error };

          return {
            text:
              `WIPED project: ${res.projectName} (${projectId})\n` +
              `Backup: ${res.backupDir}\n\n` +
              `Mode: ${res.projectsEnabled ? "Projects ON" : "Classic (Projects OFF)"}\n` +
              `Active project: ${res.activeProjectName}\n\n` +
              "Next: /projects (or /projects debug)",
          };
        }

        // Arm WIPE ALL (legacy entrypoint): /projects wipe
        const stamp = formatBackupStamp();
        const pending: PendingWipe = {
          kind: "all",
          nonce: randomNonce(4),
          createdAtMs: Date.now(),
          stamp,
          backupDir: path.join(projectsUxParentDir, `backup_projects_ux_${stamp}`),
        };

        peer.pendingWipe = pending;
        store.peers[peerKey] = peer;
        await writeStoreAndRefreshCache(store);

        return {
          text:
            "This will WIPE ALL Projects-UX state for this DM (recovery).\n\n" +
            `Backup: ${pending.backupDir}\n` +
            "Confirm within 120s.",
          channelData: {
            telegram: {
              buttons: [
                [{ text: "Cancel", callback_data: "/projects wipe cancel" }],
                [{ text: "Confirm WIPE ALL", callback_data: `/projects wipe confirm ${pending.nonce}` }],
              ],
            },
          },
        };
      }

      if (sub === "on") {
        const out = await withPeerState(storagePath, peerKey, (peer) => {
          ensureDefaultProject(peer, defaultProjectName);
          peer.projectsEnabled = true;

          // Pick last project if still available, otherwise keep active or default.
          const last = peer.lastProjectId
            ? peer.projects.find((p) => p.id === peer.lastProjectId && !p.archived)
            : null;
          const active = peer.activeProjectId
            ? peer.projects.find((p) => p.id === peer.activeProjectId && !p.archived)
            : null;
          const chosen = last ?? active ?? peer.projects.find((p) => !p.archived) ?? peer.projects[0] ?? null;
          if (chosen) {
            peer.previousProjectId = peer.activeProjectId || peer.previousProjectId;
            peer.activeProjectId = chosen.id;
            peer.lastProjectId = chosen.id;
            chosen.lastUsedAt = nowIso();
            peer.pendingReset = true;
          }

          if (ctx.channel === "telegram" && typeof messageId === "number") {
            peer.effectiveFromMessageId = messageId;
          }

          return { ok: true, project: chosen };
        });

        const res = out.result;
        const p = res.project;
        const current = p ? `${p.name} (${p.id})` : "(none)";
        return { text: `Projects ON. Active: ${current}` };
      }

      if (sub === "off") {
        await withPeerState(storagePath, peerKey, (peer) => {
          ensureDefaultProject(peer, defaultProjectName);
          peer.projectsEnabled = false;

          if (ctx.channel === "telegram" && typeof messageId === "number") {
            // Store messageId so a future "on" can be deterministic, and to keep debugging simple.
            peer.effectiveFromMessageId = messageId;
          }

          return { ok: true };
        });

        return { text: "Projects OFF (Classic). Next messages go to Classic history." };
      }

      if (sub === "list") {
        const store = await loadStore(storagePath);
        const peer = store.peers[peerKey] as PeerState | undefined;
        if (!peer) {
          return { text: "Mode: Classic (Projects OFF)\n\nNo projects yet. Use /projects on, /projects new <name>." };
        }
        const changed = ensureDefaultProject(peer, defaultProjectName);
        if (changed) {
          store.peers[peerKey] = peer;
          await writeStoreAndRefreshCache(store);
        }
        const enabled = peer.projectsEnabled === true;
        const modeLine = enabled ? "Mode: Projects ON" : "Mode: Classic (Projects OFF)";
        const active = peer.projects.find((p) => p.id === peer.activeProjectId);
        const header = active ? `Active: ${active.name} (${active.id})` : "Active: (none)";
        return {
          text: modeLine + "\n" + header + "\n\n" + renderProjectList(peer.projects),
          channelData: {
            telegram: {
              buttons: buildProjectButtons(peer),
            },
          },
        };
      }

      if (sub === "new") {
        const name = args.slice(3).trim(); // remove "new"
        if (!name) return { text: "Usage: /projects new <name>" };

        const out = await withPeerState(storagePath, peerKey, (peer) => {
          ensureDefaultProject(peer, defaultProjectName);
          peer.projectsEnabled = true;
          const existing = peer.projects.find((p) => !p.archived && p.name.toLowerCase() === name.toLowerCase());
          if (existing) {
            peer.previousProjectId = peer.activeProjectId || peer.previousProjectId;
            peer.activeProjectId = existing.id;
            peer.lastProjectId = existing.id;
            existing.lastUsedAt = nowIso();
            peer.pendingReset = true;
            if (ctx.channel === "telegram" && typeof messageId === "number") {
              peer.effectiveFromMessageId = messageId;
            }
            return { ok: true, project: existing, existed: true };
          }
          const id = slugifyId(name);
          const finalId = id ? `proj-${id}` : randomId("proj");
          if (peer.projects.filter((p) => !p.archived).length >= maxProjects) {
            return { ok: false, error: `Project limit reached (${maxProjects}). Archive old projects first.` };
          }
          const project: Project = { id: finalId, name, createdAt: nowIso(), lastUsedAt: nowIso() };
          peer.projects.push(project);
          peer.previousProjectId = peer.activeProjectId || peer.previousProjectId;
          peer.activeProjectId = project.id;
          peer.lastProjectId = project.id;
          peer.pendingReset = true;
          if (ctx.channel === "telegram" && typeof messageId === "number") {
            peer.effectiveFromMessageId = messageId;
          }
          return { ok: true, project, existed: false };
        });

        const res = out.result;
        if (!res.ok) return { text: res.error };
        return {
          text: res.existed
            ? `Switched to existing project: ${res.project.name} (${res.project.id})`
            : `Created and switched to project: ${res.project.name} (${res.project.id})`,
        };
      }

      if (sub === "switch") {
        const key = args.slice("switch".length).trim();
        if (!key) return { text: "Usage: /projects switch <name|id>" };
        const out = await withPeerState(storagePath, peerKey, (peer) => {
          ensureDefaultProject(peer, defaultProjectName);
          peer.projectsEnabled = true;
          const project = findProject(peer, key);
          if (!project || project.archived) {
            return { ok: false, error: `Project not found: ${key}` };
          }
          peer.previousProjectId = peer.activeProjectId || peer.previousProjectId;
          peer.activeProjectId = project.id;
          peer.lastProjectId = project.id;
          project.lastUsedAt = nowIso();
          peer.pendingReset = true;
          if (ctx.channel === "telegram" && typeof messageId === "number") {
            peer.effectiveFromMessageId = messageId;
          }
          return { ok: true, project };
        });
        const res = out.result;
        if (!res.ok) return { text: res.error };
        return { text: `Switched to project: ${res.project.name} (${res.project.id})` };
      }

      return help();
  };

  api.registerCommand({
    name: "projects",
    description: "Manage Projects mode + project list/switching (Phase 1/2 UX + optional per-project routing).",
    acceptsArgs: true,
    requireAuth: true,
    handler: handleProjectsCommand,
  });

  // Durable memory surface.
  api.registerCommand({
    name: "memory",
    description: "Project-scoped memory (default) + global memory (explicit).",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const peerKey = buildPeerKeyFromCommandCtx(ctx);
      const args = (ctx.args ?? "").trim();
      const parts = args ? args.split(/\s+/) : [];
      const sub = (parts[0] ?? "").toLowerCase();

      const help = () => ({
        text:
          "Memory is separate from transcript history.\n" +
          "Default scope is the current project.\n\n" +
          "Commands:\n" +
          "/memory remember <token>\n" +
          "/memory list\n" +
          "/memory global remember <token>\n" +
          "/memory global list\n",
      });

      if (!sub || sub === "help") return help();

      const store = await loadStore(storagePath);
      const peer = store.peers[peerKey] as PeerState | undefined;
      if (!peer) {
        return {
          text:
            "No Projects state for this chat yet.\n\n" +
            "Run /projects on (or /projects new <name>) first, then use /memory remember ...\n" +
            "Or use /memory global remember ...",
        };
      }

      const changed = ensureDefaultProject(peer, defaultProjectName);
      if (changed) {
        store.peers[peerKey] = peer;
        await writeStoreAndRefreshCache(store);
      }

      const isGlobal = sub === "global";
      const sub2 = isGlobal ? (parts[1] ?? "").toLowerCase() : sub;
      const rest = isGlobal ? parts.slice(2).join(" ").trim() : parts.slice(1).join(" ").trim();

      if (isGlobal) {
        if (!sub2) return help();

        if (sub2 === "remember") {
          const token = rest.trim();
          if (!token) return { text: "Usage: /memory global remember <token>" };
          peer.globalTokens = Array.isArray(peer.globalTokens) ? peer.globalTokens : [];
          if (!peer.globalTokens.includes(token)) peer.globalTokens.push(token);
          store.peers[peerKey] = peer;
          await writeStoreAndRefreshCache(store);
          return { text: `Saved globally: ${token}` };
        }

        if (sub2 === "list") {
          const tokens = Array.isArray(peer.globalTokens) ? peer.globalTokens : [];
          if (tokens.length === 0) return { text: "No global tokens saved." };
          return { text: "Global tokens:\n" + tokens.map((t) => `- ${t}`).join("\n") };
        }

        return help();
      }

      // Project-scoped memory requires Projects mode ON so the scope is unambiguous.
      if (peer.projectsEnabled !== true) {
        return {
          text:
            "Projects are OFF (Classic).\n\n" +
            "Turn Projects ON to use project-scoped memory, or use /memory global ...\n\n" +
            "- /projects on\n" +
            "- /memory global remember <token>",
        };
      }

      const active = peer.projects.find((p) => p.id === peer.activeProjectId) ?? null;
      if (!active) return { text: "No active project." };
      if (!Array.isArray(active.tokens)) active.tokens = [];

      if (sub === "remember") {
        const token = rest.trim();
        if (!token) return { text: "Usage: /memory remember <token>" };
        if (!active.tokens.includes(token)) active.tokens.push(token);
        store.peers[peerKey] = peer;
        await writeStoreAndRefreshCache(store);
        return { text: `Saved in project ${active.name}: ${token}` };
      }

      if (sub === "list") {
        const tokens = Array.isArray(active.tokens) ? active.tokens : [];
        if (tokens.length === 0) return { text: `No tokens saved in project ${active.name}.` };
        return { text: `Tokens in project ${active.name}:\n` + tokens.map((t) => `- ${t}`).join("\n") };
      }

      return help();
    },
  });

  // Backward-compat alias. Keep docs/UI on /projects.
  api.registerCommand({
    name: "project",
    description: "(Deprecated) Alias for /projects.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const res = await handleProjectsCommand(ctx);
      if (!res) return res;

      const prefix = "Note: /project is deprecated — use /projects.\n\n";
      if (typeof (res as any).text === "string" && (res as any).text.trim()) {
        return { ...res, text: prefix + (res as any).text };
      }
      return { ...res, text: prefix.trim() };
    },
  });

  // -----------------------------
  // Prompt framing: one-shot anti-bleed guardrail
  // -----------------------------

  api.on(
    "before_agent_start",
    async (event: any, ctx: any) => {
      const peerKey = buildPeerKeyFromBeforeAgentStart({
        sessionKey: ctx?.sessionKey,
        channelId: ctx?.channelId,
        conversationId: ctx?.conversationId,
      });

      // Debug: log context + computed peerKey (even if no state found).
      try {
        const log = api?.logger?.info ? api.logger : null;
        const msg = `[projects-ux] before_agent_start ctx channelId=${String(ctx?.channelId)} conversationId=${String(ctx?.conversationId)} sessionKey=${String(ctx?.sessionKey)} -> peer=${peerKey}`;
        if (log) log.info(msg);
        else console.log(msg);
      } catch {
        // ignore
      }

      const store = await loadStoreCached();
      const peer = store.peers[peerKey] as PeerState | undefined;
      if (!peer) {
        try {
          const log = api?.logger?.info ? api.logger : null;
          const keys = Object.keys(store.peers ?? {}).slice(0, 10).join(",");
          const msg = `[projects-ux] no peer state for ${peerKey}. knownPeers=${keys}`;
          if (log) log.info(msg);
          else console.log(msg);
        } catch {
          // ignore
        }
        return undefined;
      }

      const changed = ensureDefaultProject(peer, defaultProjectName);
      if (changed) {
        store.peers[peerKey] = peer;
        await writeStoreAndRefreshCache(store);
      }
      if (peer.projectsEnabled !== true) return undefined;

      const active = peer.projects.find((p) => p.id === peer.activeProjectId) ?? null;
      if (!active) return undefined;

      const prefixLines: string[] = [];
      const basePrefix = `Active project: ${active.name} (${active.id}).`;
      prefixLines.push(basePrefix);

      // One-shot guardrail after switching.
      if (peer.pendingReset) {
        prefixLines.push(
          "Ignore any context not explicitly stated in this project's messages or notes. " +
            "If information is missing, proceed with minimal assumptions and state them."
        );
      }

      const note = active.note ? clampText(active.note, maxInjectedNoteChars).trim() : "";
      if (note) {
        prefixLines.push("Project notes (user-provided):");
        prefixLines.push(note);
      }

      // Clear pendingReset (one-shot).
      if (peer.pendingReset) {
        peer.pendingReset = false;
        store.peers[peerKey] = peer;
        await writeStoreAndRefreshCache(store);
      }

      const prependContext = clampText(prefixLines.join("\n"), maxPrefixChars);

      // Debug: log when we actually inject framing.
      try {
        const log = api?.logger?.info ? api.logger : null;
        const msg = `[projects-ux] before_agent_start inject peer=${peerKey} active=${active.id} pendingReset=${peer.pendingReset ? "true" : "false"} prependLen=${prependContext.length}`;
        if (log) log.info(msg);
        else console.log(msg);
      } catch {
        // ignore
      }

      return { prependContext };
    },
    { priority: 100 }
  );

  // Phase 2: hard isolation via per-project room key suffix.
  api.on(
    "resolve_room_key",
    async (event: any, ctx: any) => {
      if (!hardIsolationEnabled) return undefined;
      if (event?.channel !== "telegram") return undefined;
      if (event?.peer?.kind !== "dm") return undefined;

      const peerId = String(event?.peer?.id ?? "").trim();
      if (!peerId) return undefined;

      const peerKey = `telegram:${peerId}`;
      const store = await loadStoreCached();
      const peer = store.peers[peerKey] as PeerState | undefined;
      if (!peer) return undefined;

      const changed = ensureDefaultProject(peer, defaultProjectName);
      if (changed) {
        store.peers[peerKey] = peer;
        await writeStoreAndRefreshCache(store);
      }
      if (peer.projectsEnabled !== true) return undefined;

      const msgId = typeof event?.messageId === "number" ? event.messageId : undefined;
      const effectiveFrom = typeof peer.effectiveFromMessageId === "number" ? peer.effectiveFromMessageId : undefined;

      // Deterministic semantics: before the switch command's message_id, keep routing to previous project.
      const activeId =
        msgId != null && effectiveFrom != null && msgId < effectiveFrom
          ? (peer.previousProjectId ?? peer.activeProjectId)
          : peer.activeProjectId;

      const suffix = sanitizeRoomKeySuffixToken(activeId);
      if (!suffix) return undefined;

      const base = String(event?.roomKey ?? "").trim();
      if (!base) return undefined;

      return { roomKey: `${base}:proj:${suffix}` };
    },
    { priority: 100 }
  );
}
