'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const realLaya = require('../desktop/laya.cjs');
const { touchIdPlatform, createTouchIdUnlock } = require('../desktop/touch-id.cjs');
const { plain, until, startMain, safeStorage } = require('./helpers/harness.cjs');

const PASSWORD = 'synthetic touch password';
const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 3, 12);

async function folder(t) {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'secondhand-touch-id-main-'));
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));
  return userData;
}

// Runs the real main process and vault against a temporary folder, as a fresh app start. Only
// Touch ID (systemPreferences), the Keychain (safeStorage) and the clock are simulated: no real
// prompt is shown and no Keychain item is touched.
async function desktop(t, { userData, platform = 'darwin', canPrompt = true, encryptionAvailable = true, clock = { now: START }, dialog = {}, isPackaged = false, env = {} } = {}) {
  userData ||= await folder(t);
  const prompts = [];
  let answer = async () => {};
  let onUnseal = () => {};
  let onRemove = async () => {};
  const keychain = safeStorage({ available: encryptionAvailable, unsealing: () => onUnseal() });
  const systemPreferences = {
    canPromptTouchID: () => { if (platform !== 'darwin') assert.fail('Touch ID is asked about on macOS only'); return canPrompt; },
    promptTouchID: reason => { prompts.push(reason); return answer(); }
  };
  class SyntheticDate extends Date { static now() { return clock.now; } }
  const main = await startMain({ userData, platform, env, packaged: isPackaged, dialog, electron: { safeStorage: keychain, systemPreferences }, modules: {
    // main.cjs's own file removals wait for `removing`, so a test can act while one is under way.
    'node:fs/promises': { ...fsp, rm: async (file, options) => { await onRemove(file); return fsp.rm(file, options); } },
    './laya.cjs': { ...realLaya, createLaya: options => ({ ...realLaya.createLaya(options), startUpdates() {}, update() {} }) }
  }, globals: { Date: SyntheticDate } });
  const sealedPath = path.join(userData, 'touch-unlock.bin');
  return {
    userData, sealedPath, prompts, sent: main.sent, clock,
    // The milliseconds of every timer main.cjs set, in order.
    get timers() { return main.timers.map(timer => timer.ms); },
    answer: callback => { answer = callback; },
    unsealing: callback => { onUnseal = callback; },
    removing: callback => { onRemove = callback; },
    invoke: main.invoke,
    request: type => main.bridge({ id: 'synthetic', type }, { extensionId: 'a'.repeat(32) }),
    sealed: async () => JSON.parse(keychain.decryptString(await fsp.readFile(sealedPath))),
    slots: async () => JSON.parse(await fsp.readFile(path.join(userData, 'vault.secondhand'), 'utf8')).slots
  };
}

async function withTouchId(t, options) {
  const app = await desktop(t, options);
  const created = await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: true });
  await app.invoke('setTouchIdUnlock', { enabled: true, password: PASSWORD });
  return { app, recoveryKey: created.recoveryKey };
}

test('turning Touch ID on asks for the password, adds a Touch ID slot, and seals only a random key', async t => {
  const app = await desktop(t);
  const created = await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: true });
  assert.equal(created.status.touchIdSupported, true);
  assert.equal(created.status.touchId, 'off', 'off by default');
  const before = await app.slots();

  for (const request of [undefined, {}, { enabled: 'yes' }]) await assert.rejects(app.invoke('setTouchIdUnlock', request), /Invalid setting/);
  await assert.rejects(app.invoke('setTouchIdUnlock', { enabled: true, password: 'a wrong but long password' }), /That password isn’t right/);
  await assert.rejects(app.invoke('setTouchIdUnlock', { enabled: true }), /at least 12/);
  await assert.rejects(fsp.access(app.sealedPath), { code: 'ENOENT' }, 'nothing is sealed without the password');
  assert.deepEqual(Object.keys(await app.slots()).sort(), ['device', 'password', 'recovery']);
  assert.deepEqual(app.prompts, [], 'turning it on shows no Touch ID prompt');

  const on = await app.invoke('setTouchIdUnlock', { enabled: true, password: PASSWORD });
  assert.equal(on.touchId, 'ready');
  const sealed = await app.sealed();
  assert.deepEqual(Object.keys(sealed).sort(), ['key', 'version']);
  assert.equal(sealed.version, 2);
  assert.equal(Buffer.from(sealed.key, 'base64').length, 32);
  const slots = await app.slots();
  assert.deepEqual(Object.keys(slots).sort(), ['device', 'password', 'recovery', 'touchId']);
  for (const name of ['password', 'recovery', 'device']) assert.deepEqual(slots[name], before[name], `${name} slot unchanged`);
  const vaultText = await fsp.readFile(path.join(app.userData, 'vault.secondhand'), 'utf8');
  assert.equal(vaultText.includes(sealed.key), false, 'the Touch ID key is never in the vault file');
  const settings = await fsp.readFile(path.join(app.userData, 'settings.json'), 'utf8').catch(() => '');
  assert.equal(/touch/i.test(settings), false, 'nothing about Touch ID is saved in settings');
});

test('Touch ID unlocks like a password unlock: the same lock revision, the idle timer, and the saved information', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('saveProfile', { firstName: 'Touch Synthetic' });
  const locked = await app.invoke('lock');
  assert.equal(locked.touchId, 'ready');
  const timers = app.timers.length;
  const unlocked = await app.invoke('unlockWithTouchId');
  assert.deepEqual(app.prompts, ['unlock SecondHand']);
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.lockRevision, locked.lockRevision, 'an unlock never moves the lock revision');
  assert.deepEqual(app.timers.slice(timers), [10 * 60 * 1000], 'the idle auto-lock is armed');
  assert.equal((await app.invoke('getData')).profile.firstName, 'Touch Synthetic');
  assert.equal((await app.invoke('status')).touchId, 'ready');
});

// Touch ID stays available until it's turned off (the owner's choice): no password after a
// restart, and no time limit.
test('after a restart, Touch ID is ready and unlocks without the password first', async t => {
  const first = await withTouchId(t);
  await first.app.invoke('lock');
  const app = await desktop(t, { userData: first.app.userData, clock: { now: START + DAY } });
  const status = await app.invoke('status');
  assert.equal(status.unlocked, false);
  assert.equal(status.touchId, 'ready');
  assert.equal(plain(await app.request('status')).touchId, 'ready');
  const unlocked = await app.invoke('unlockWithTouchId');
  assert.equal(unlocked.unlocked, true);
  assert.deepEqual(app.prompts, ['unlock SecondHand']);
  await app.invoke('lock');
  assert.deepEqual(plain(await app.request('unlockWithTouchId')), { unlocked: true }, 'from Chrome too');
});

test('Touch ID has no time limit, whatever the clock says', async t => {
  const { app } = await withTouchId(t);
  for (const now of [START + 15 * DAY, START + 400 * DAY, START - 30 * DAY]) {
    await app.invoke('lock');
    app.clock.now = now;
    assert.equal((await app.invoke('status')).touchId, 'ready', new Date(now).toISOString());
    assert.equal((await app.invoke('unlockWithTouchId')).unlocked, true, new Date(now).toISOString());
  }
  assert.equal(app.prompts.length, 3);
});

test('a key sealed in the earlier format, with when the password was used, still unlocks and is never renewed', async t => {
  const first = await withTouchId(t);
  const { key } = await first.app.sealed();
  await first.app.invoke('lock');
  const earlier = { version: 1, passwordAt: START - 60 * DAY, key };
  await fsp.writeFile(first.app.sealedPath, `sealed:${Buffer.from(JSON.stringify(earlier)).toString('hex')}`);
  const app = await desktop(t, { userData: first.app.userData });
  assert.equal((await app.invoke('status')).touchId, 'ready');
  assert.equal((await app.invoke('unlockWithTouchId')).unlocked, true);
  await app.invoke('lock');
  await app.invoke('unlock', PASSWORD);
  assert.deepEqual(await app.sealed(), earlier, 'a password unlock leaves the sealed key as it is');
});

test('a cancelled or failed prompt doesn’t unlock, says why, and keeps Touch ID on', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  app.answer(async () => { throw new Error('Canceled by user.'); });
  await assert.rejects(app.invoke('unlockWithTouchId'), /^Error: Touch ID didn’t unlock SecondHand \(Canceled by user\.\)\. Enter your password\.$/);
  assert.deepEqual(plain(await app.request('unlockWithTouchId')), { unlocked: false, reason: 'cancelled' });
  const status = await app.invoke('status');
  assert.equal(status.unlocked, false);
  assert.equal(status.touchId, 'ready');
  assert.equal(app.prompts.length, 2);
  assert.equal((await app.invoke('unlock', PASSWORD)).unlocked, true, 'the password still works');
});

test('a lock while the Touch ID prompt is up cancels it', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  let approve;
  app.answer(() => new Promise(resolve => { approve = resolve; }));
  const attempt = app.invoke('unlockWithTouchId');
  for (let tries = 0; !approve && tries < 100; tries++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(approve, 'the prompt was shown');
  await app.invoke('lock');
  approve();
  await assert.rejects(attempt, /SecondHand locked while Touch ID was asking/);
  assert.equal((await app.invoke('status')).unlocked, false);
});

test('a lock that starts while the key is read after the prompt still wins', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  let locking;
  app.unsealing(() => { app.unsealing(() => {}); locking = app.invoke('lock'); });
  await assert.rejects(app.invoke('unlockWithTouchId'), /SecondHand locked while Touch ID was asking/);
  await locking;
  assert.equal((await app.invoke('status')).unlocked, false);
});

test('two Touch ID requests at once share one prompt', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  const [fromApp, fromChrome] = await Promise.all([app.invoke('unlockWithTouchId'), app.request('unlockWithTouchId')]);
  assert.equal(fromApp.unlocked, true);
  assert.deepEqual(plain(fromChrome), { unlocked: true });
  assert.deepEqual(app.prompts, ['unlock SecondHand']);
});

test('a cancelled prompt shared by the app and Chrome refuses both, asks once, and keeps Touch ID on', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  let cancel;
  // The first prompt waits to be cancelled; a second one would be cancelled at once.
  app.answer(() => cancel ? Promise.reject(new Error('Canceled by user.')) : new Promise((_resolve, reject) => { cancel = () => reject(new Error('Canceled by user.')); }));
  const fromApp = app.invoke('unlockWithTouchId').then(() => assert.fail('unlocked'), error => error.message);
  const fromChrome = app.request('unlockWithTouchId');
  await until(() => Boolean(cancel), 'the prompt to be up');
  cancel();
  assert.equal(await fromApp, 'Touch ID didn’t unlock SecondHand (Canceled by user.). Enter your password.');
  assert.deepEqual(plain(await fromChrome), { unlocked: false, reason: 'cancelled' });
  assert.deepEqual(app.prompts, ['unlock SecondHand'], 'one prompt');
  assert.equal((await app.invoke('status')).touchId, 'ready');
  app.answer(async () => {});
  assert.equal((await app.invoke('unlockWithTouchId')).unlocked, true, 'the next request asks again');
  assert.equal(app.prompts.length, 2);
});

test('a password unlock while the Touch ID prompt is up wins: Touch ID answers unlocked and reads no key', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  let approve;
  app.answer(() => new Promise(resolve => { approve = resolve; }));
  const attempt = app.invoke('unlockWithTouchId');
  await until(() => Boolean(approve), 'the prompt to be up');
  assert.equal((await app.invoke('unlock', PASSWORD)).unlocked, true);
  let reads = 0;
  app.unsealing(() => { reads++; });
  approve();
  assert.equal((await attempt).unlocked, true);
  assert.equal(reads, 0, 'the key isn’t read once the password won');
  assert.equal((await app.invoke('status')).touchId, 'ready');
});

test('a password unlock that finishes while Touch ID reads its key wins too', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  let password;
  app.unsealing(() => { app.unsealing(() => {}); password = app.invoke('unlock', PASSWORD); });
  assert.equal((await app.invoke('unlockWithTouchId')).unlocked, true);
  assert.equal((await password).unlocked, true);
  const status = await app.invoke('status');
  assert.equal(status.touchId, 'ready');
  assert.equal(status.touchIdNotice, null);
});

test('an unexpected error in a Touch ID unlock fails loudly, keeps Touch ID on, and the next request asks again', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  const vaultPath = path.join(app.userData, 'vault.secondhand');
  const bytes = await fsp.readFile(vaultPath);
  const sealed = await fsp.readFile(app.sealedPath);
  await fsp.writeFile(vaultPath, 'not an encrypted file');
  await assert.rejects(app.invoke('unlockWithTouchId'), /^Error: The local operation could not be completed\. Please try again\.$/);
  await assert.rejects(app.request('unlockWithTouchId'), /Invalid encrypted vault file/, 'Chrome gets the error, not a reason');
  const status = await app.invoke('status');
  assert.equal(status.touchId, 'ready');
  assert.equal(status.touchIdNotice, null);
  assert.deepEqual(await fsp.readFile(app.sealedPath), sealed, 'the key is kept');
  await fsp.writeFile(vaultPath, bytes);
  assert.equal((await app.invoke('unlockWithTouchId')).unlocked, true);
  assert.equal(app.prompts.length, 3);
});

test('turning Touch ID off removes its slot and the sealed key; the other slots stay', async t => {
  const { app } = await withTouchId(t);
  const slots = await app.slots();
  const off = await app.invoke('setTouchIdUnlock', { enabled: false });
  assert.equal(off.touchId, 'off');
  await assert.rejects(fsp.access(app.sealedPath), { code: 'ENOENT' });
  const after = await app.slots();
  assert.deepEqual(Object.keys(after).sort(), ['device', 'password', 'recovery']);
  for (const name of ['password', 'recovery', 'device']) assert.deepEqual(after[name], slots[name]);
  await app.invoke('lock');
  await assert.rejects(app.invoke('unlockWithTouchId'), /Touch ID is off/);
  assert.deepEqual(plain(await app.request('unlockWithTouchId')), { unlocked: false, reason: 'off' });
  assert.deepEqual(app.prompts, []);
  await assert.rejects(app.invoke('setTouchIdUnlock', { enabled: false }), /Unlock SecondHand first/);
});

// Only a damaged key file (its format or size) or a damaged Touch ID slot turns Touch ID off (#140).
test('a damaged key file or Touch ID slot turns Touch ID off with the reason, asks for the password, and the password removes the slot', async t => {
  const cases = [
    ['empty', () => Buffer.alloc(0), /because its key file on this Mac is damaged/],
    ['too large', () => Buffer.alloc(4097, 'a'), /because its key file on this Mac is damaged/],
    ['damaged inside', () => Buffer.from(`sealed:${Buffer.from('{"version":1').toString('hex')}`), /because its key file on this Mac is damaged/],
    ['the wrong shape', () => Buffer.from(`sealed:${Buffer.from(JSON.stringify({ version: 3, key: crypto.randomBytes(32).toString('base64') })).toString('hex')}`), /because its key file on this Mac is damaged/],
    ['a short key', () => Buffer.from(`sealed:${Buffer.from(JSON.stringify({ version: 2, key: crypto.randomBytes(16).toString('base64') })).toString('hex')}`), /because its key file on this Mac is damaged/],
    ['a key for other information', () => Buffer.from(`sealed:${Buffer.from(JSON.stringify({ version: 2, key: crypto.randomBytes(32).toString('base64') })).toString('hex')}`), /because its key doesn’t open your saved information/]
  ];
  for (const [name, bytes, reason] of cases) {
    const { app } = await withTouchId(t);
    await app.invoke('lock');
    await fsp.writeFile(app.sealedPath, bytes());
    const error = await app.invoke('unlockWithTouchId').then(() => assert.fail(`${name}: unlocked`), failure => failure);
    assert.match(error.message, /^Touch ID was turned off because .+\. Enter your password\.$/, name);
    assert.match(error.message, reason, name);
    await assert.rejects(fsp.access(app.sealedPath), { code: 'ENOENT' }, `${name}: the sealed key is removed`);
    const status = await app.invoke('status');
    assert.equal(status.unlocked, false, name);
    assert.equal(status.touchId, 'off', name);
    assert.match(status.touchIdNotice, reason, `${name}: the lock screen can say why`);
    assert.deepEqual(plain(await app.request('unlockWithTouchId')), { unlocked: false, reason: 'off' }, name);
    const unlocked = await app.invoke('unlock', PASSWORD);
    assert.equal(unlocked.touchIdNotice, null, `${name}: the password clears the notice`);
    assert.deepEqual(Object.keys(await app.slots()).sort(), ['device', 'password', 'recovery'], `${name}: the password unlock removes the slot`);
  }
});

// A Keychain that can't open the key now, or a key file that can't be read now, may work next time (#140).
test('a Keychain or file error doesn’t turn Touch ID off: Touch ID didn’t work this time, the key and slot stay, and it works next time', async t => {
  const cases = [
    ['the Keychain refuses', async app => { app.unsealing(() => { throw new Error('The Keychain is locked.'); }); }, async app => { app.unsealing(() => {}); },
      /^Error: Touch ID didn’t work this time \(this Mac’s Keychain couldn’t open its key\)\. Use your password\.$/],
    ['not sealed by this Mac', async app => { await fsp.writeFile(app.sealedPath, 'tampered'); }, async (app, sealed) => { await fsp.writeFile(app.sealedPath, sealed); },
      /^Error: Touch ID didn’t work this time \(this Mac’s Keychain couldn’t open its key\)\. Use your password\.$/],
    ['the key file can’t be read', async app => { await fsp.rm(app.sealedPath); await fsp.mkdir(app.sealedPath); },
      async (app, sealed) => { await fsp.rmdir(app.sealedPath); await fsp.writeFile(app.sealedPath, sealed); },
      /^Error: Touch ID didn’t work this time \(its key file on this Mac couldn’t be read \(EISDIR\)\)\. Use your password\.$/]
  ];
  for (const [name, fail, recover, message] of cases) {
    const { app } = await withTouchId(t);
    await app.invoke('lock');
    const sealed = await fsp.readFile(app.sealedPath);
    const slot = (await app.slots()).touchId;
    await fail(app);
    await assert.rejects(app.invoke('unlockWithTouchId'), message, name);
    assert.deepEqual(plain(await app.request('unlockWithTouchId')), { unlocked: false, reason: 'cancelled' }, `${name}: Chrome’s side panel offers Touch ID again`);
    const status = await app.invoke('status');
    assert.equal(status.unlocked, false, name);
    assert.equal(status.touchId, 'ready', `${name}: Touch ID stays on`);
    assert.equal(status.touchIdNotice, null, name);
    // The password unlock finds the same problem and keeps Touch ID on too.
    const unlocked = await app.invoke('unlock', PASSWORD);
    assert.equal(unlocked.unlocked, true, name);
    assert.equal(unlocked.touchId, 'ready', name);
    assert.equal(unlocked.touchIdNotice, null, name);
    assert.deepEqual((await app.slots()).touchId, slot, `${name}: the slot stays`);
    await fsp.access(app.sealedPath);
    if (name === 'the Keychain refuses') assert.deepEqual(await fsp.readFile(app.sealedPath), sealed, 'the key is kept');
    await app.invoke('lock');
    await recover(app, sealed);
    assert.equal((await app.invoke('unlockWithTouchId')).unlocked, true, `${name}: Touch ID works next time`);
    assert.equal(app.prompts.length, 3, name);
  }
});

test('a damaged sealed key found by a password unlock turns Touch ID off and says so, and the unlock still works', async t => {
  const first = await withTouchId(t);
  await first.app.invoke('lock');
  await fsp.writeFile(first.app.sealedPath, `sealed:${Buffer.from('not a key').toString('hex')}`);
  const app = await desktop(t, { userData: first.app.userData });
  const unlocked = await app.invoke('unlock', PASSWORD);
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.touchId, 'off');
  assert.match(unlocked.touchIdNotice, /^Touch ID was turned off because its key file on this Mac is damaged\.$/);
  await assert.rejects(fsp.access(app.sealedPath), { code: 'ENOENT' });
  assert.deepEqual(Object.keys(await app.slots()).sort(), ['device', 'password', 'recovery']);
  // Turning it on again clears the notice.
  const on = await app.invoke('setTouchIdUnlock', { enabled: true, password: PASSWORD });
  assert.equal(on.touchIdNotice, null);
  assert.equal(on.touchId, 'ready');
});

test('a sealed key left without a Touch ID slot turns Touch ID off at the next password unlock', async t => {
  const { app } = await withTouchId(t);
  const sealed = await fsp.readFile(app.sealedPath);
  await app.invoke('setTouchIdUnlock', { enabled: false });
  await fsp.writeFile(app.sealedPath, sealed);
  await app.invoke('lock');
  const unlocked = await app.invoke('unlock', PASSWORD);
  assert.equal(unlocked.touchId, 'off');
  assert.match(unlocked.touchIdNotice, /because your saved information has no Touch ID key/);
  await assert.rejects(fsp.access(app.sealedPath), { code: 'ENOENT' });
});

test('a password reset with the recovery key or this computer keeps Touch ID: the slot and key stay, and it unlocks', async t => {
  for (const method of ['recovery', 'device']) {
    const { app, recoveryKey } = await withTouchId(t);
    const sealed = await fsp.readFile(app.sealedPath);
    const touchIdSlot = (await app.slots()).touchId;
    await app.invoke('lock');
    const reset = await app.invoke('resetPassword', method === 'device' ? { method, password: 'synthetic new password' } : { recoveryKey, password: 'synthetic new password' });
    assert.equal(reset.unlocked, true, method);
    assert.equal(reset.touchId, 'ready', method);
    assert.deepEqual(await fsp.readFile(app.sealedPath), sealed, `${method}: the sealed key is unchanged`);
    assert.deepEqual((await app.slots()).touchId, touchIdSlot, `${method}: the Touch ID slot is unchanged`);
    await app.invoke('lock');
    assert.equal((await app.invoke('unlockWithTouchId')).unlocked, true, method);
    await app.invoke('lock');
    assert.equal((await app.invoke('unlock', 'synthetic new password')).unlocked, true, `${method}: the new password works`);
  }
});

test('a failed reset leaves Touch ID as it was', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  await assert.rejects(app.invoke('resetPassword', { recoveryKey: '0000-0000-0000-0000-0000-0000-0000-0000', password: 'synthetic new password' }), /didn’t work/);
  await fsp.access(app.sealedPath);
  assert.equal((await app.invoke('unlockWithTouchId')).unlocked, true);
});

test('starting over erases the Touch ID key with the saved information', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  const erased = await app.invoke('startOver', { confirmation: 'start over' });
  assert.equal(erased.touchId, 'off');
  await assert.rejects(fsp.access(app.sealedPath), { code: 'ENOENT' });
  const created = await app.invoke('createVault', { password: 'synthetic new password', allowDeviceReset: false });
  assert.equal(created.status.touchId, 'off');
});

test('restoring a backup removes the Touch ID key: the backup opens with its own password first', async t => {
  const backup = path.join(await folder(t), 'synthetic.secondhand');
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [backup] }), showSaveDialog: async () => ({ canceled: false, filePath: backup }),
    showMessageBox: async () => ({ response: 1 }) };
  const { app } = await withTouchId(t, { dialog });
  await app.invoke('exportBackup');
  await app.invoke('lock');
  assert.deepEqual(plain(await app.invoke('importBackup')), { cancelled: false });
  await assert.rejects(fsp.access(app.sealedPath), { code: 'ENOENT' });
  assert.equal((await app.invoke('status')).touchId, 'off');
  await assert.rejects(app.invoke('unlockWithTouchId'), /Touch ID is off/);
  // The restored file still carries the slot it was saved with; the password unlock removes it.
  const unlocked = await app.invoke('unlock', PASSWORD);
  assert.equal(unlocked.touchIdNotice, null);
  assert.deepEqual(Object.keys(await app.slots()).sort(), ['device', 'password', 'recovery']);
});

// A backup exported while Touch ID was on carries the same Touch ID slot, so only the order of the restore
// keeps Touch ID from opening it (#140).
async function withBackup(t) {
  const backup = path.join(await folder(t), 'synthetic.secondhand');
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [backup] }), showSaveDialog: async () => ({ canceled: false, filePath: backup }),
    showMessageBox: async () => ({ response: 1 }) };
  const { app } = await withTouchId(t, { dialog });
  await app.invoke('saveProfile', { firstName: 'Backed up' });
  await app.invoke('exportBackup');
  await app.invoke('saveProfile', { firstName: 'Current' });
  await app.invoke('lock');
  return { app, backup, vaultPath: path.join(app.userData, 'vault.secondhand') };
}
// Runs `during` once, after the restore has replaced the file and before it finishes.
const duringRestore = (app, during) => app.removing(async file => {
  if (!file.endsWith('setup-progress.json')) return;
  app.removing(async () => {});
  await during();
});

test('a backup restored while the Touch ID prompt is up isn’t opened by it: Touch ID is off, and the backup opens with its password', async t => {
  const { app, backup, vaultPath } = await withBackup(t);
  let approve;
  app.answer(() => new Promise(resolve => { approve = resolve; }));
  const asking = app.request('unlockWithTouchId');
  await until(() => Boolean(approve), 'the prompt to be up');
  let answered;
  duringRestore(app, async () => { approve(); answered = plain(await asking); });
  assert.deepEqual(plain(await app.invoke('importBackup')), { cancelled: false });
  assert.deepEqual(answered, { unlocked: false, reason: 'off' });
  const status = await app.invoke('status');
  assert.equal(status.unlocked, false);
  assert.equal(status.touchId, 'off');
  assert.deepEqual(await fsp.readFile(vaultPath), await fsp.readFile(backup), 'the backup is restored as it was');
  await app.invoke('unlock', PASSWORD);
  assert.equal((await app.invoke('getData')).profile.firstName, 'Backed up');
});

test('Touch ID asked for while a backup is being restored finds it off', async t => {
  const { app } = await withBackup(t);
  let attempt;
  duringRestore(app, async () => { attempt = await app.invoke('unlockWithTouchId').then(() => null, error => error); });
  await app.invoke('importBackup');
  assert.match(attempt?.message ?? 'it unlocked', /^Touch ID is off\. Enter your password\.$/);
  assert.deepEqual(app.prompts, [], 'no prompt');
  assert.equal((await app.invoke('status')).unlocked, false);
});

test('a restore moves the access revision on, so a Touch ID answer from before it can’t unlock', async t => {
  const { app } = await withBackup(t);
  const before = plain(await app.request('status')).accessRevision;
  await app.invoke('importBackup');
  assert.ok(plain(await app.request('status')).accessRevision > before);
});

test('a restore that can’t remove Touch ID’s key is refused and leaves the saved information as it was', async t => {
  const { app, vaultPath } = await withBackup(t);
  const vaultBytes = await fsp.readFile(vaultPath);
  await fsp.rm(app.sealedPath);
  await fsp.mkdir(app.sealedPath);
  await fsp.writeFile(path.join(app.sealedPath, 'synthetic'), 'in the way');
  await assert.rejects(app.invoke('importBackup'), /^Error: Touch ID’s key on this Mac couldn’t be removed \(.+\), so the backup wasn’t restored\. Please try again\.$/);
  assert.deepEqual(await fsp.readFile(vaultPath), vaultBytes);
  assert.equal((await fsp.readdir(app.userData)).some(name => name.includes('before-import')), false, 'no copy was made');
});

test('a new password removes a Touch ID key left from earlier information', async t => {
  const userData = await folder(t);
  await fsp.writeFile(path.join(userData, 'touch-unlock.bin'), 'left from earlier information');
  const app = await desktop(t, { userData });
  await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  await assert.rejects(fsp.access(app.sealedPath), { code: 'ENOENT' });
});

test('without Touch ID, on another system, or without the Keychain, Touch ID stays off and can’t be turned on', async t => {
  const noSensor = await desktop(t, { canPrompt: false });
  const created = await noSensor.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  assert.equal(created.status.touchIdSupported, false);
  assert.equal(created.status.touchId, 'off');
  await assert.rejects(noSensor.invoke('setTouchIdUnlock', { enabled: true, password: PASSWORD }), /Touch ID isn’t available on this Mac/);
  await fsp.writeFile(noSensor.sealedPath, 'sealed while a sensor was available');
  assert.equal((await noSensor.invoke('status')).touchId, 'off');
  assert.deepEqual(plain(await noSensor.request('status')).touchId, 'off');

  for (const platform of ['win32', 'linux']) {
    const other = await desktop(t, { platform });
    const status = await other.invoke('status');
    assert.equal(status.touchIdSupported, false, platform);
    assert.equal(status.touchId, 'off', platform);
  }

  const noKeychain = await desktop(t, { encryptionAvailable: false });
  await noKeychain.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  await assert.rejects(noKeychain.invoke('setTouchIdUnlock', { enabled: true, password: PASSWORD }), /This Mac’s Keychain isn’t available, so Touch ID can’t be turned on/);
  await assert.rejects(fsp.access(noKeychain.sealedPath), { code: 'ENOENT' });
  assert.deepEqual(Object.keys(await noKeychain.slots()).sort(), ['password', 'recovery']);
});

test('from Chrome: status says only ready or off, and unlockWithTouchId unlocks and tells the window', async t => {
  const app = await desktop(t);
  await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  assert.equal(plain(await app.request('status')).touchId, 'off');
  await app.invoke('setTouchIdUnlock', { enabled: true, password: PASSWORD });
  const status = plain(await app.request('status'));
  assert.equal(status.touchId, 'ready');
  assert.deepEqual(Object.keys(status).sort(), ['accessRevision', 'allSites', 'applicationCount', 'extension', 'laya', 'touchId', 'unlocked']);

  assert.deepEqual(plain(await app.request('unlockWithTouchId')), { unlocked: true }, 'already unlocked');
  assert.deepEqual(app.prompts, [], 'no prompt while unlocked');
  const { lockRevision } = await app.invoke('lock');
  const sent = app.sent.length;
  assert.deepEqual(plain(await app.request('unlockWithTouchId')), { unlocked: true });
  assert.deepEqual(app.prompts, ['unlock SecondHand']);
  assert.equal((await app.invoke('status')).unlocked, true);
  assert.deepEqual(app.sent.slice(sent), [['secondhand:unlocked', { lockRevision }]]);
  assert.equal(plain(await app.request('status')).unlocked, true);
});

// Turning Touch ID on adds the slot first, then saves the sealed key; a key that can't be saved takes its slot away again.
test('a turn-on whose key can’t be saved removes the slot it added, and says so if that fails too', async t => {
  const userData = await folder(t);
  await fsp.writeFile(path.join(userData, 'a file'), 'synthetic');
  // The key file's folder is a file, so the key can't be saved.
  const filePath = path.join(userData, 'a file', 'touch-unlock.bin');
  const slots = [];
  let removing = null;
  const vault = { unlocked: true, checkPassword: async () => {},
    setTouchIdKey: async key => { slots.push(key ? 'add' : 'remove'); if (!key && removing) throw removing; } };
  const platform = { supported: () => true, sealingAvailable: () => true, prompt: async () => {}, seal: text => Buffer.from(text), unseal: bytes => bytes.toString() };
  const touchId = createTouchIdUnlock({ vault, platform, filePath, revision: () => 1 });
  await assert.rejects(touchId.turnOn(PASSWORD), error => /^Touch ID couldn’t be turned on \(.+\)\. Your password still works\.$/.test(error.publicMessage));
  assert.deepEqual(slots, ['add', 'remove']);
  removing = new Error('synthetic disk failure');
  await assert.rejects(touchId.turnOn(PASSWORD), error =>
    /^Touch ID couldn’t be turned on \(.+\), and its slot couldn’t be removed \(synthetic disk failure\)\. Turn Touch ID off and try again\.$/.test(error.publicMessage));
  assert.deepEqual(slots, ['add', 'remove', 'add', 'remove']);
  platform.seal = () => { throw new Error('synthetic Keychain failure'); };
  await assert.rejects(touchId.turnOn(PASSWORD), error => error.publicMessage === 'Touch ID couldn’t be turned on (synthetic Keychain failure). Your password still works.');
  assert.equal(slots.length, 4, 'a key that can’t be sealed adds no slot');
  await assert.rejects(fsp.access(filePath), { code: 'ENOTDIR' }, 'no key file can be there: its folder is a file');
});

test('the Touch ID test hook works only in an unpackaged build in test mode, and never asks macOS or the Keychain', () => {
  const refuse = () => assert.fail('the real Touch ID or Keychain was used');
  const electron = { systemPreferences: { canPromptTouchID: refuse, promptTouchID: refuse }, safeStorage: { isEncryptionAvailable: refuse, encryptString: refuse, decryptString: refuse } };
  const testEnv = { SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_TOUCH_ID: 'approve' };
  assert.throws(() => touchIdPlatform({ ...electron, platform: 'darwin', packaged: true, env: testEnv }), /A packaged SecondHand refuses SECONDHAND_TEST_TOUCH_ID/);
  assert.throws(() => touchIdPlatform({ ...electron, platform: 'darwin', packaged: false, env: { SECONDHAND_TEST_TOUCH_ID: 'approve' } }), /needs SECONDHAND_TEST_MODE=1/);
  assert.throws(() => touchIdPlatform({ ...electron, platform: 'darwin', packaged: false, env: { ...testEnv, SECONDHAND_TEST_TOUCH_ID: 'yes' } }), /SECONDHAND_TEST_TOUCH_ID must be "approve"/);
  const stand = touchIdPlatform({ ...electron, platform: 'linux', packaged: false, env: testEnv });
  assert.equal(stand.supported(), true);
  assert.equal(stand.sealingAvailable(), true);
  assert.equal(stand.unseal(stand.seal('synthetic')), 'synthetic');
  return stand.prompt('unlock SecondHand');
});

test('the real Touch ID and Keychain are used without the test hook', async () => {
  const calls = [];
  const electron = {
    systemPreferences: { canPromptTouchID: () => { calls.push('can'); return true; }, promptTouchID: async reason => { calls.push(`prompt:${reason}`); } },
    safeStorage: { isEncryptionAvailable: () => { calls.push('available'); return true; }, encryptString: text => { calls.push('seal'); return Buffer.from(text); }, decryptString: bytes => { calls.push('unseal'); return bytes.toString(); } }
  };
  const mac = touchIdPlatform({ ...electron, platform: 'darwin', packaged: true, env: {} });
  assert.equal(mac.supported(), true);
  await mac.prompt('unlock SecondHand');
  assert.equal(mac.sealingAvailable(), true);
  assert.equal(mac.unseal(mac.seal('synthetic')), 'synthetic');
  assert.deepEqual(calls, ['can', 'prompt:unlock SecondHand', 'available', 'seal', 'unseal']);
  assert.equal(touchIdPlatform({ ...electron, platform: 'win32', packaged: true, env: {} }).supported(), false);
  assert.equal(calls.length, 5, 'Windows never asks about Touch ID');
});

test('a packaged app given the Touch ID test hook refuses to start', async t => {
  await assert.rejects(desktop(t, { isPackaged: true, env: { SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_TOUCH_ID: 'approve' } }), /A packaged SecondHand refuses SECONDHAND_TEST_TOUCH_ID/);
});
