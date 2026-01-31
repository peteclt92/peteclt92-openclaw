# Projects Phase 2 — Implementation Plan (durable across upstream updates)

## Goal
Provide **harder separation** between projects by routing messages into **separate session transcripts** per active project (and ideally separate FIFO/lane ordering), **without patching channel internals** (e.g., Telegram `dist/*` files) and in a way that survives upstream OpenClaw updates.

## Non-goals (Phase 2)
- No claims of fully isolated tool access or separate provider credentials.
- No advanced project lifecycle (rename/archive/export/share).

## Approach (recommended)
### A) Add a first-class core hook for session identity
Add a plugin hook to OpenClaw core (source, not `dist/`) so extensions can influence how session keys are derived.

**Proposed hook name (one of):**
- `resolve_session_key` (preferred: explicit)
- `session_key_suffix` (simpler)

**Hook contract (suggested):**
- Runs during inbound message context building, after the base route is chosen.
- Receives:
  - `channel`, `accountId`
  - `peer` (kind + id)
  - `agentId`
  - `baseSessionKey` (computed by core routing)
  - `threadId` (if applicable)
  - `messageId` (if the channel provides one)
  - optional: `isControlCommand`, `isSlashCommand` flags
- Returns either:
  - `{ sessionKey }` (full override), or
  - `{ sessionKeySuffix }` (appended by core with sanitization)

**Core responsibilities:**
- Sanitize suffix/override consistently.
- Ensure the chosen sessionKey is also the key used for:
  - transcript/history
  - lane/FIFO ordering
  - any per-session caches

### B) Implement Phase 2 inside `projects-ux` using the hook
Modify the Projects UX plugin to:
- Maintain **in-memory cached** peer state (avoid per-message file reads).
- Write updates atomically (already implemented as temp+rename).
- Provide deterministic session suffix `:proj:<activeProjectId>`.

### C) Determinism under concurrency
Address the “switch + next message” race by tying routing to **Telegram message ordering**:
- When handling `/project switch` or `/project new <name>`:
  - record `activeProjectId`
  - record `activeEffectiveFromMessageId = <the message_id of the switch command>`
- In the session-key hook:
  - if inbound message has `messageId` and there is an `activeEffectiveFromMessageId`:
    - apply project routing only when `messageId >= activeEffectiveFromMessageId`
  - otherwise fall back to the last known active project.

This makes routing stable even if messages arrive close together.

## Minimal scope for Phase 2
- Telegram DMs only.
- Gated behind config flag:
  - `plugins.entries.projects-ux.config.hardIsolation.enabled: true|false`

## Deliverables
1) Core: new hook + wiring in the router/session-key construction.
2) Plugin: implement hook handler and cached state + determinism.
3) Docs: Phase 2 README + config flag description.
4) Tests: manual test checklist in Telegram DM.

## Manual test checklist
- Create/switch projects; verify sessionKey changes per project.
- Verify message ordering: rapid switch + message still routes correctly.
- Restart gateway; verify persistence.
- Disable flag; verify all messages go to the default session.
