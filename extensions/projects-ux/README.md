# projects-ux

Projects mode UX plugin for OpenClaw.

## Reset / Wipe (safety contract)

This plugin owns its persistence under:

- `~/.openclaw/projects-ux/`

Reset/Wipe operations **never** delete transcripts/history (stored elsewhere).

### UI

- `/projects` shows a **More…** button.
- `/projects` → **More…** → **Reset…** provides:
  - **Remove (wipe) ONE project…** (primary)
  - **Wipe ALL projects…** (recovery)

### Guardrails

All destructive actions are:

- scoped **per DM / peer**
- two-step confirmed (arm → confirm)
- protected by a single-use nonce with ~120s expiry
- backed up automatically before any mutation

### Backups

Before mutation, the plugin copies the entire plugin directory to:

- `~/.openclaw/backup_projects_ux_YYYYMMDD-HHMMSS/projects-ux/`

The backup path is printed in-chat on success.

### Commands

- `/projects wipe` → arms **wipe-all** confirmation (no deletion)
- `/projects wipe confirm <nonce>` → wipe-all (for this peer)
- `/projects wipe project confirm <nonce> <projectId>` → wipe one project
- `/projects wipe cancel` → cancels a pending wipe

### Non-goals

- No transcript deletion.
- No core changes.
- No changes to global hardIsolation policy.
