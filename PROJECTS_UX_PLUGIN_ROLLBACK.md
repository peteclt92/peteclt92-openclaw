# Projects UX Plugin — Rollback / Recovery

This is the break-glass rollback checklist for the **Projects UX plugin** (Phase 1).

Scope: This plugin is intended to be **purely additive UX** (project picker + `/project` commands + prompt framing). It should not modify Telegram transport behavior.

> Replace placeholders: `<pluginId>`, `<pluginPath>`, `<TIMESTAMP>`.

---

## 0) Snapshot current state

```bash
openclaw status
openclaw gateway status
```

---

## 1) Backup config + sessions (recommended before enabling/disabling plugins)

```bash
cp -av ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d-%H%M%S)
cp -av ~/.openclaw/agents ~/.openclaw/agents.bak.$(date +%Y%m%d-%H%M%S)
```

Optional full state backup:

```bash
cp -av ~/.openclaw ~/.openclaw.bak.$(date +%Y%m%d-%H%M%S)
```

---

## 2) Disable the plugin (fastest rollback)

### Option A — Disable via config (preferred)

Edit config:

```bash
nano ~/.openclaw/openclaw.json
# set: plugins.entries.<pluginId>.enabled = false
```

Restart:

```bash
systemctl --user restart openclaw-gateway.service
```

### Option B — Remove/disable the plugin directory (if installed as a local extension)

```bash
ls -la ~/.openclaw/extensions
mv ~/.openclaw/extensions/<pluginPath> ~/.openclaw/extensions/<pluginPath>.disabled.$(date +%Y%m%d-%H%M%S)
systemctl --user restart openclaw-gateway.service
```

### Option C — Uninstall if installed via npm

```bash
openclaw plugins list
# if the plugin was installed via npm:
openclaw plugins remove <pluginId> || true
# or:
npm remove -g <package-name>

systemctl --user restart openclaw-gateway.service
```

---

## 3) Restore known-good config

```bash
cp -av ~/.openclaw/openclaw.json.bak.<TIMESTAMP> ~/.openclaw/openclaw.json
systemctl --user restart openclaw-gateway.service
```

---

## 4) Inspect logs (to confirm what failed)

File log:

```bash
tail -n 200 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log
```

Systemd journal:

```bash
journalctl --user -u openclaw-gateway.service -n 200 --no-pager
journalctl --user -u openclaw-gateway.service -f
```

---

## 5) Nuclear reset (only if truly stuck)

```bash
systemctl --user stop openclaw-gateway.service
mv ~/.openclaw ~/.openclaw.bad.$(date +%Y%m%d-%H%M%S)
systemctl --user start openclaw-gateway.service
# then restore config backup or rerun configure
```
