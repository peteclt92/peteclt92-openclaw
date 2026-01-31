# Projects Phase 2 — Rollback Checklist

Use this if Phase 2 routing causes missing replies, misrouting, or instability.

## Symptoms
- Telegram DM messages are received but no reply is sent
- Replies appear in the wrong project/session
- Increased latency or crashes during message processing

## Rollback Steps

### 1) Exit Projects mode (no restart)
If you just want to stop using per-project transcripts immediately:
- Run: `/project off`
- Verify the bot replies: "Projects OFF (Classic). Next messages go to Classic history."

This keeps projects intact; it just routes messages back to the classic (base) DM session.

### 2) Disable Phase 2 (preferred global rollback)
- Set the Projects UX Phase 2 flag to off in OpenClaw config:
  - `plugins.entries.projects-ux.config.hardIsolation.enabled = false`
- Restart gateway.

### 2) Remove/disable Projects UX plugin (last resort)
- Disable plugin entry:
  - `plugins.entries.projects-ux.enabled = false`
- Restart gateway.

### 3) Revert core hook changes (if Phase 2 required core modifications)
- Revert the OpenClaw core commit(s) that introduced the session-key hook / routing changes.
- Restart gateway.

## Post-rollback verification
- Send a Telegram DM: "ping"
- Expect a normal response in the baseline (non-project-isolated) session.
- Run `/project` and confirm the command UI still works (if plugin remains enabled).

## Data retention note
Project state is stored at:
- `~/.openclaw/projects-ux/state.json`

You can also force Classic mode per-DM by editing the state file and setting:
- `peers["telegram:<peerId>"].projectsEnabled = false`

Rollback does not delete state.
