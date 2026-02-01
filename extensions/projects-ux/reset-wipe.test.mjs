import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import projectsUx from './index.ts';

async function mkTempProjectsUxDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-ux-test-'));
  const projectsUxDir = path.join(root, 'projects-ux');
  await fs.mkdir(projectsUxDir, { recursive: true });
  return { root, projectsUxDir, statePath: path.join(projectsUxDir, 'state.json') };
}

function makeApi(storagePath) {
  const commands = new Map();
  const api = {
    pluginConfig: { storagePath, defaultProjectName: 'General' },
    resolvePath: (p) => p,
    registerCommand: (c) => commands.set(c.name, c.handler),
    // hooks used by the plugin (not needed for these tests)
    registerHook: () => {},
    on: () => {},
    pluginId: 'projects-ux',
    log: () => {},
  };
  projectsUx(api);
  const handler = commands.get('projects');
  assert.equal(typeof handler, 'function');
  return { handler };
}

async function readState(statePath) {
  const raw = await fs.readFile(statePath, 'utf8');
  return JSON.parse(raw);
}

test('wipe-all: wrong nonce is refused and clears pendingWipe', async () => {
  const { root, statePath } = await mkTempProjectsUxDir();
  const { handler } = makeApi(statePath);
  const ctxBase = { channel: 'telegram', senderId: 'u1', requireAuth: true };

  // init projects state
  await handler({ ...ctxBase, args: 'on', messageId: 1 });

  // arm wipe-all
  const arm = await handler({ ...ctxBase, args: 'wipe', messageId: 2 });
  assert.match(arm.text, /Confirm WIPE ALL|Confirm within 120s/i);

  const store1 = await readState(statePath);
  const peer = store1.peers['telegram:u1'];
  assert.ok(peer.pendingWipe);

  // wrong confirm clears pending
  const res = await handler({ ...ctxBase, args: 'wipe confirm deadbeef', messageId: 3 });
  assert.match(res.text, /Refused/i);

  const store2 = await readState(statePath);
  assert.ok(!store2.peers['telegram:u1'].pendingWipe);

  await fs.rm(root, { recursive: true, force: true });
});

test('wipe-one: default project cannot be wiped', async () => {
  const { root, statePath } = await mkTempProjectsUxDir();
  const { handler } = makeApi(statePath);
  const ctxBase = { channel: 'telegram', senderId: 'u1', requireAuth: true };

  await handler({ ...ctxBase, args: 'new p2', messageId: 1 });

  const res = await handler({ ...ctxBase, args: 'reset remove proj-general', messageId: 2 });
  assert.match(res.text, /Refused|default project/i);

  await fs.rm(root, { recursive: true, force: true });
});

test('wipe-all: confirm resets peer to Classic with only default project and creates backup dir', async () => {
  const { root, statePath, projectsUxDir } = await mkTempProjectsUxDir();
  const { handler } = makeApi(statePath);
  const ctxBase = { channel: 'telegram', senderId: 'u1', requireAuth: true };

  await handler({ ...ctxBase, args: 'new p2', messageId: 1 });

  const arm = await handler({ ...ctxBase, args: 'wipe', messageId: 2 });
  const store1 = await readState(statePath);
  const nonce = store1.peers['telegram:u1'].pendingWipe.nonce;

  const res = await handler({ ...ctxBase, args: `wipe confirm ${nonce}`, messageId: 3 });
  assert.match(res.text, /WIPED ALL projects state/i);

  const store2 = await readState(statePath);
  const peer = store2.peers['telegram:u1'];
  assert.equal(peer.projectsEnabled, false);
  assert.equal(peer.projects.length, 1);
  assert.equal(peer.projects[0].name, 'General');

  // Backup should exist in root
  const backups = (await fs.readdir(root)).filter((n) => n.startsWith('backup_projects_ux_'));
  assert.ok(backups.length >= 1);
  const backupDir = path.join(root, backups[0], 'projects-ux');
  const st = await fs.stat(backupDir);
  assert.ok(st.isDirectory());

  // projects-ux dir should still exist
  assert.ok((await fs.stat(projectsUxDir)).isDirectory());

  await fs.rm(root, { recursive: true, force: true });
});
