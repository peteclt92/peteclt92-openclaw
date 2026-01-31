import fs from "node:fs/promises";
import path from "node:path";

type Project = {
  id: string;
  name: string;
  archived?: boolean;
  createdAt: string;
  lastUsedAt?: string;
  note?: string;
};

type PeerState = {
  version: 1;
  activeProjectId: string;
  lastProjectId?: string;
  pendingReset?: boolean;
  projects: Project[];
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
  const channel = (ctx.channelId ?? "unknown").toLowerCase();
  const sessionKey = (ctx.sessionKey ?? "").toLowerCase();
  if (channel === "telegram") {
    const peer = extractTelegramDmPeerIdFromSessionKey(sessionKey);
    if (peer) return `telegram:${peer}`;
  }
  const conv = (ctx.conversationId ?? "").trim();
  if (conv) return `${channel}:${conv}`;
  if (sessionKey) return `${channel}:${sessionKey}`;
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

function buildSwitchButtons(projects: Project[]) {
  const active = projects.filter((p) => !p.archived);
  const top = active
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt))
    .slice(0, 8);

  // Telegram inline keyboard is rows of buttons.
  // Keep it simple: 2 columns.
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < top.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    const a = top[i];
    const b = top[i + 1];
    if (a) row.push({ text: a.name, callback_data: `/project switch ${a.id}` });
    if (b) row.push({ text: b.name, callback_data: `/project switch ${b.id}` });
    rows.push(row);
  }
  rows.push([{ text: "New project", callback_data: "/project new" }]);
  return rows;
}

async function loadStore(filePath: string): Promise<Store> {
  const data = await readJson<Store>(filePath);
  if (data && data.version === 1 && data.peers && typeof data.peers === "object") {
    return data;
  }
  return { version: 1, peers: {} };
}

async function withPeerState<T>(filePath: string, peerKey: string, fn: (peer: PeerState) => T): Promise<{ store: Store; result: T }> {
  const store = await loadStore(filePath);
  const existing = store.peers[peerKey];
  const peer: PeerState = existing && existing.version === 1
    ? existing
    : {
        version: 1,
        activeProjectId: "",
        projects: [],
      };

  const result = fn(peer);
  store.peers[peerKey] = peer;
  await writeJsonAtomic(filePath, store);
  return { store, result };
}

function ensureDefaultProject(peer: PeerState, defaultProjectName: string) {
  if (peer.projects.length === 0) {
    const id = `inbox-${slugifyId(defaultProjectName) || "inbox"}`;
    const p: Project = { id, name: defaultProjectName, createdAt: nowIso(), lastUsedAt: nowIso() };
    peer.projects.push(p);
    peer.activeProjectId = id;
    peer.lastProjectId = id;
    peer.pendingReset = false;
  }
  if (!peer.activeProjectId) {
    const first = peer.projects.find((p) => !p.archived) ?? peer.projects[0];
    if (first) peer.activeProjectId = first.id;
  }
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
  const defaultProjectName = String(cfg.defaultProjectName ?? "Inbox");
  const maxProjects = Number.isFinite(cfg.maxProjects) ? Math.trunc(cfg.maxProjects) : 50;
  const maxInjectedNoteChars = Number.isFinite(cfg.maxInjectedNoteChars) ? Math.trunc(cfg.maxInjectedNoteChars) : 600;
  const maxPrefixChars = Number.isFinite(cfg.maxPrefixChars) ? Math.trunc(cfg.maxPrefixChars) : 240;

  // -----------------------------
  // Commands
  // -----------------------------

  api.registerCommand({
    name: "project",
    description: "Manage bot-managed projects (Phase 1: UX only; no hard isolation).",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const peerKey = buildPeerKeyFromCommandCtx(ctx);
      const args = (ctx.args ?? "").trim();

      const help = () => ({
        text:
          "Projects (Phase 1): project switching + scoped context (not hard isolation).\n\n" +
          "Commands:\n" +
          "/project\n" +
          "/project list\n" +
          "/project new <name>\n" +
          "/project switch <name|id>\n",
      });

      // /project new (no args) -> prompt user
      if (args === "new") {
        return {
          text: "Usage: /project new <name>",
        };
      }

      const parts = args ? args.split(/\s+/) : [];
      const sub = (parts[0] ?? "").toLowerCase();

      if (!sub) {
        const store = await loadStore(storagePath);
        const peer = store.peers[peerKey] as PeerState | undefined;
        const p = peer?.projects?.find((x) => x.id === peer?.activeProjectId) ?? null;
        const current = p ? `${p.name} (${p.id})` : "(none)";
        return {
          text:
            `Active project: ${current}\n\n` +
            "Use /project list, /project new <name>, or /project switch <name|id>.",
          channelData: {
            telegram: {
              buttons: buildSwitchButtons(peer?.projects ?? []),
            },
          },
        };
      }

      if (sub === "help") return help();

      if (sub === "list") {
        const store = await loadStore(storagePath);
        const peer = store.peers[peerKey] as PeerState | undefined;
        if (!peer) return { text: "No projects yet. Use /project new <name>." };
        const active = peer.projects.find((p) => p.id === peer.activeProjectId);
        const header = active ? `Active: ${active.name} (${active.id})` : "Active: (none)";
        return {
          text: header + "\n\n" + renderProjectList(peer.projects),
          channelData: {
            telegram: {
              buttons: buildSwitchButtons(peer.projects),
            },
          },
        };
      }

      if (sub === "new") {
        const name = args.slice(3).trim(); // remove "new"
        if (!name) return { text: "Usage: /project new <name>" };

        const out = await withPeerState(storagePath, peerKey, (peer) => {
          ensureDefaultProject(peer, defaultProjectName);
          const existing = peer.projects.find((p) => !p.archived && p.name.toLowerCase() === name.toLowerCase());
          if (existing) {
            peer.activeProjectId = existing.id;
            peer.lastProjectId = existing.id;
            existing.lastUsedAt = nowIso();
            peer.pendingReset = true;
            return { ok: true, project: existing, existed: true };
          }
          const id = slugifyId(name);
          const finalId = id ? `proj-${id}` : randomId("proj");
          if (peer.projects.filter((p) => !p.archived).length >= maxProjects) {
            return { ok: false, error: `Project limit reached (${maxProjects}). Archive old projects first.` };
          }
          const project: Project = { id: finalId, name, createdAt: nowIso(), lastUsedAt: nowIso() };
          peer.projects.push(project);
          peer.activeProjectId = project.id;
          peer.lastProjectId = project.id;
          peer.pendingReset = true;
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
        if (!key) return { text: "Usage: /project switch <name|id>" };
        const out = await withPeerState(storagePath, peerKey, (peer) => {
          ensureDefaultProject(peer, defaultProjectName);
          const project = findProject(peer, key);
          if (!project || project.archived) {
            return { ok: false, error: `Project not found: ${key}` };
          }
          peer.activeProjectId = project.id;
          peer.lastProjectId = project.id;
          project.lastUsedAt = nowIso();
          peer.pendingReset = true;
          return { ok: true, project };
        });
        const res = out.result;
        if (!res.ok) return { text: res.error };
        return { text: `Switched to project: ${res.project.name} (${res.project.id})` };
      }

      return help();
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

      const store = await loadStore(storagePath);
      const peer = store.peers[peerKey] as PeerState | undefined;
      if (!peer) return undefined;

      ensureDefaultProject(peer, defaultProjectName);
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
        await writeJsonAtomic(storagePath, store);
      }

      const prependContext = clampText(prefixLines.join("\n"), maxPrefixChars);
      return { prependContext };
    },
    { priority: 100 }
  );
}
