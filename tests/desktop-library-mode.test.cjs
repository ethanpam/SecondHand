'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startMain, safeStorage, deferred, until } = require('./helpers/harness.cjs');
const realLaya = require('../desktop/laya.cjs');

async function setup(t, { userData, platform = 'win32', modules = {}, dialog = {} } = {}) {
  if (!userData) {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-library-'));
    t.after(() => fs.rm(userData, { recursive: true, force: true }));
  }
  let idle = 0;
  const app = await startMain({ userData, platform, dialog,
    electron: { safeStorage: safeStorage() }, systemIdleTime: () => idle,
    modules: { './laya.cjs': { ...realLaya, createLaya: options => ({ ...realLaya.createLaya(options), startUpdates() {} }) }, ...modules }
  });
  return { ...app, userData, setIdle: value => { idle = value; },
    poll: async () => {
      const timer = app.timers.filter(item => item.ms === 1000 && !item.cleared).at(-1);
      assert.ok(timer, 'idle monitor is armed');
      timer.cleared = true;
      await timer.callback();
    } };
}
const create = app => app.invoke('createVault', { password: 'synthetic library password', allowDeviceReset: true });

for (const platform of ['win32', 'darwin']) test(`${platform}: only OS inactivity expires at 120 seconds, deleting local data and preserving mode`, async t => {
  const app = await setup(t, { platform });
  await create(app);
  await app.invoke('saveProfile', { firstName: 'Synthetic' });
  await app.invoke('setLibraryMode', true);
  for (const name of ['vault.secondhand.before-import-example', 'vault.secondhand.orphan.tmp', 'touch-unlock.bin', 'setup-progress.json', 'device-reset.bin.interrupted.tmp', 'settings.json.interrupted.tmp']) {
    await fs.writeFile(path.join(app.userData, name), 'synthetic');
  }
  const original = path.join(app.userData, 'original.pdf');
  await fs.writeFile(original, 'original');
  app.setIdle(119); await app.poll();
  assert.equal((await app.invoke('status')).unlocked, true);
  await app.invoke('getData'); // Background IPC must not keep a patron session alive.
  app.setIdle(120); await app.poll();
  const status = await app.invoke('status');
  assert.equal(status.exists, false);
  assert.equal(status.unlocked, false);
  assert.equal(status.libraryMode, true);
  assert.equal(status.libraryErasing, false);
  assert.deepEqual(await fs.readFile(original, 'utf8'), 'original');
  const names = await fs.readdir(app.userData);
  assert.ok(!names.some(name => /^(vault.secondhand|device-reset|touch-unlock|setup-progress)/.test(name)));
  assert.ok(names.includes('library-mode.json'));
  const notifications = app.sent.length;
  await app.poll();
  assert.equal(app.sent.length, notifications, 'one reset per idle period');
  app.setIdle(0); await app.poll();
  await create(app);
  assert.equal((await app.invoke('getData')).profile.firstName, undefined);
});

test('disabled mode retains the vault; enabling requires an unlocked app and a boolean', async t => {
  const app = await setup(t);
  await assert.rejects(app.invoke('setLibraryMode', true), /Unlock/);
  await create(app);
  await assert.rejects(app.invoke('setLibraryMode', 'yes'), /Invalid setting/);
  await app.invoke('setLibraryMode', true);
  await app.invoke('setLibraryMode', false);
  assert.ok(!app.timers.some(timer => timer.ms === 1000 && !timer.cleared));
  assert.equal((await app.invoke('status')).exists, true);
  await assert.rejects(fs.access(path.join(app.userData, 'library-mode.json')), { code: 'ENOENT' });
});

test('restart erases a crashed patron session before access, even with a damaged mode marker', async t => {
  const app = await setup(t);
  await create(app); await app.invoke('setLibraryMode', true);
  await fs.writeFile(path.join(app.userData, 'library-mode.json'), 'damaged');
  const restarted = await setup(t, { userData: app.userData });
  assert.equal((await restarted.invoke('status')).exists, false);
  assert.equal((await restarted.invoke('status')).libraryMode, true);
});

test('manual lock does not cancel idle deletion; sleep and screen lock also erase', async t => {
  const app = await setup(t);
  await create(app); await app.invoke('setLibraryMode', true);
  await app.invoke('lock');
  app.setIdle(120); await app.poll();
  assert.equal((await app.invoke('status')).exists, false);
  for (const event of ['suspend', 'lock-screen']) {
    await create(app);
    await app.powerEvents.get(event)();
    assert.equal((await app.invoke('status')).exists, false);
  }
});

test('failed deletion keeps access blocked and retries without pretending data was erased', async t => {
  let fail = false;
  const app = await setup(t, { modules: { 'node:fs/promises': { ...fs, rm: async (file, options) => {
    if (fail && String(file).endsWith('device-reset.bin')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.rm(file, options);
  } } } });
  await create(app); await app.invoke('setLibraryMode', true);
  fail = true; app.setIdle(120); await app.poll();
  const status = await app.invoke('status');
  assert.equal(status.libraryErasing, true);
  assert.match(status.libraryError, /could not delete/);
  await assert.rejects(create(app), /could not delete/);
  await assert.rejects(app.invoke('unlock', 'synthetic library password'), /could not delete/);
  fail = false; await app.poll();
  assert.equal((await app.invoke('status')).exists, false);
  assert.equal((await app.invoke('status')).libraryError, null);
});

test('a pending restore cannot resurrect deleted data or return an old session result', async t => {
  const picker = deferred();
  const app = await setup(t, { dialog: { showOpenDialog: () => picker.promise } });
  await create(app); await app.invoke('setLibraryMode', true);
  const backup = path.join(app.userData, 'export.secondhand');
  await fs.copyFile(path.join(app.userData, 'vault.secondhand'), backup);
  await app.invoke('lock');
  const restore = app.invoke('importBackup');
  const rejected = assert.rejects(restore, /ended this session/);
  app.setIdle(120);
  const deletion = app.poll();
  await until(async () => !(await app.invoke('status')).exists, 'initial erase');
  await assert.rejects(create(app), /deleting local data/);
  picker.resolve({ canceled: false, filePaths: [backup] });
  await rejected; await deletion;
  assert.equal((await app.invoke('status')).exists, false);
  await fs.access(backup);
});


test('expiry clears patron approvals but keeps the installed extension connection', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-library-settings-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const extensionId = 'a'.repeat(32);
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ extensionId, autofillWithoutAsking: true,
    trustedSites: ['https://pantry.example'], alwaysAllowedSites: ['https://pantry.example'], allSites: true, householdNoteDismissed: true }));
  const app = await setup(t, { userData });
  await create(app); await app.invoke('setLibraryMode', true);
  app.setIdle(120); await app.poll();
  const status = await app.invoke('status');
  assert.equal(status.extensionId, extensionId);
  assert.equal(status.autofillWithoutAsking, false);
  assert.equal(status.allSites, false);
  assert.equal(status.householdNoteDismissed, false);
  assert.equal(status.trustedSites.length, 0);
  assert.equal(status.alwaysAllowedSites.length, 0);
});
