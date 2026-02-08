# Codex watchdog (OpenClaw wake on completion)

## Goal
Get a reliable, immediate notification when a Codex CLI run finishes, without polling.

## MVP approach
Wrap the Codex command so it triggers an OpenClaw wake **on process exit**.

## Script
`/home/pete/clawd/scripts/codex-watch`

### Usage
```bash
cd /home/pete/projects/node-banana-polished
/home/pete/clawd/scripts/codex-watch "node-banana: create-dir UX" -- codex exec
```

- Streams output to console and logs it to:
  - `<repo>/.codex-watch/<timestamp>-<label>.log`
- On completion, sends:
  - `openclaw gateway call cron.wake --params '{"text":"...","mode":"now"}'`
- Exit code matches the wrapped command’s exit code.

## Notes
- Notification is best-effort: wrapper never fails if `openclaw` wake fails.
- Includes cwd + git branch (if available) + log path in the wake text.
