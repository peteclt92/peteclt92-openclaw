# OpenClaw core Phase 2 local patch notes (upstreamable shape)

These changes were applied **locally** to the installed OpenClaw package under:
`/home/pete/.npm-global/lib/node_modules/openclaw/dist/`

They define an upstreamable abstraction boundary (hook + canonical roomKey), but are not yet in an upstream repo.

## Modified files

### 1) `dist/plugins/hooks.js`
- Added new modifying hook runner: `runResolveRoomKey` for hook name `resolve_room_key`.
- Exported it from the global hook runner object.

### 2) `dist/telegram/bot-message-context.js`
- After computing `sessionKey`, calls the global hook runner for `resolve_room_key` (if present).
- Event payload includes: `{ roomKey, baseRoomKey, agentId, channel, accountId, peer, messageId, threadId }`.
- Allows plugins to return `{ roomKey }` to replace the canonical room key.
- Guarded with optional config escape hatch: `cfg.session.roomKeyHooksEnabled !== false`.

### 3) `dist/plugins/commands.js`
- Extended plugin command ctx with optional metadata:
  - `messageId`, `threadId`, `chatId`

### 4) `dist/telegram/bot-native-commands.js`
- Passes Telegram message metadata into `executePluginCommand` so `/project switch/new` can record `effectiveFromMessageId`.

## Why
- Enables Phase 2 “harder isolation” by letting plugins refine the canonical room/session key in a stable way.
- Avoids patching channel routing in ad-hoc ways from extensions.

## Rollback
- Set `plugins.entries.projects-ux.config.hardIsolation.enabled=false` and restart gateway.
- Or remove these local changes from the installed package and restart.
