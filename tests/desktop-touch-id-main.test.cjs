'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const realLaya = require('../desktop/laya.cjs');
const { touchIdPlatform } = require('../desktop/touch-id.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const PASSWORD = 'synthetic touch password';
const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 3, 12);
const NEEDED = /Enter your password: it’s needed after SecondHand restarts or every 14 days\./;
// Values created inside the vm context have foreign prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

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
  let invoke;
  let bridge;
  let window;
  const prompts = [];
  const sent = [];
  const timers = [];
  let answer = async () => {};
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('hex')}`),
    decryptString: bytes => {
      const text = bytes.toString();
      if (!text.startsWith('sealed:')) throw new Error('Not sealed by this computer.');
      return Buffer.from(text.slice(7), 'hex').toString();
    }
  };
  const systemPreferences = {
    canPromptTouchID: () => { if (platform !== 'darwin') assert.fail('Touch ID is asked about on macOS only'); return canPrompt; },
    promptTouchID: reason => { prompts.push(reason); return answer(); }
  };
  class BrowserWindow {
    constructor() {
      window = this;
      this.webContents = { mainFrame: { url: pathToFileURL(path.join(root, 'renderer/index.html')).href },
        setWindowOpenHandler() {}, on() {}, send(...args) { sent.push(plain(args)); } };
    }
    show() {} focus() {} setMenuBarVisibility() {} once() {} on() {} loadFile() {}
    isDestroyed() { return false; }
  }
  const app = { isPackaged, setName() {}, setPath() {}, getPath: () => userData,
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on() {} };
  const electron = { app, BrowserWindow, safeStorage, systemPreferences, ipcMain: { handle(_name, handler) { invoke = handler; } },
    dialog: { showErrorBox() { assert.fail('Desktop setup failed'); }, ...dialog },
    shell: {}, clipboard: {}, powerMonitor: { on() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } };
  const overrides = {
    electron,
    './bridge.cjs': { ...require('../desktop/bridge.cjs'), startBridge: async (_directory, _getId, handler) => { bridge = handler; return { close: async () => {} }; } },
    './extension-setup.cjs': { getExtensionSetup: async () => ({ prepared: true }) },
    './registration.cjs': { registerHost: async () => ({}) },
    './test-storage-path.cjs': { testStoragePath: () => null },
    './laya.cjs': { ...realLaya, createLaya: options => ({ ...realLaya.createLaya(options), startUpdates() {}, update() {} }) }
  };
  class SyntheticDate extends Date { static now() { return clock.now; } }
  vm.runInNewContext(source, {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name.startsWith('.') ? path.join(root, 'desktop', name) : name),
    __dirname: path.join(root, 'desktop'), process: { platform, env, argv: ['synthetic-electron'] },
    setTimeout: (_callback, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {}, Buffer, Date: SyntheticDate
  });
  for (let attempt = 0; !(window && bridge) && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(window && bridge, 'The desktop window and bridge were not started');
  const sealedPath = path.join(userData, 'touch-unlock.bin');
  return {
    userData, sealedPath, prompts, sent, timers, clock,
    answer: callback => { answer = callback; },
    invoke: (method, argument) => invoke({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, method, ...(argument === undefined ? [] : [argument])),
    request: type => bridge({ id: 'synthetic', type }, { extensionId: 'a'.repeat(32) }),
    sealed: async () => JSON.parse(safeStorage.decryptString(await fsp.readFile(sealedPath))),
    slots: async () => JSON.parse(await fsp.readFile(path.join(userData, 'vault.secondhand'), 'utf8')).slots
  };
}

async function withTouchId(t, options) {
  const app = await desktop(t, options);
  const created = await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: true });
  await app.invoke('setTouchIdUnlock', { enabled: true, password: PASSWORD });
  return { app, recoveryKey: created.recoveryKey };
}

test('turning Touch ID on asks for the password, adds a Touch ID slot, and seals only a random key and when the password was used', async t => {
  const app = await desktop(t);
  const created = await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: true });
  assert.equal(created.status.touchIdSupported, true);
  assert.equal(created.status.touchId, 'off', 'off by default');
  const before = await app.slots();

  for (const request of [undefined, {}, { enabled: 'yes' }]) await assert.rejects(app.invoke('setTouchIdUnlock', request), /Invalid setting/);
  await assert.rejects(app.invoke('setTouchIdUnlock', { enabled: true, password: 'a wrong but long password' }), /That password isn’t right/);
  await assert.rejects(app.invoke('setTouchIdUnlock', { enabled: true }), /at least 12/);
  await assert.rejects(fsp.access(app.sealedPath), 'nothing is sealed without the password');
  assert.deepEqual(Object.keys(await app.slots()).sort(), ['device', 'password', 'recovery']);
  assert.deepEqual(app.prompts, [], 'turning it on shows no Touch ID prompt');

  const on = await app.invoke('setTouchIdUnlock', { enabled: true, password: PASSWORD });
  assert.equal(on.touchId, 'ready');
  const sealed = await app.sealed();
  assert.deepEqual(Object.keys(sealed).sort(), ['key', 'passwordAt', 'version']);
  assert.equal(sealed.version, 1);
  assert.equal(sealed.passwordAt, START);
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

test('a restart needs the password before Touch ID; a password unlock renews when it was used', async t => {
  const first = await withTouchId(t);
  await first.app.invoke('lock');
  const clock = { now: START + DAY };
  const app = await desktop(t, { userData: first.app.userData, clock });
  const status = await app.invoke('status');
  assert.equal(status.touchId, 'password');
  assert.equal(status.unlocked, false);
  await assert.rejects(app.invoke('unlockWithTouchId'), NEEDED);
  assert.deepEqual(plain(await app.request('unlockWithTouchId')), { unlocked: false, reason: 'password' });
  assert.deepEqual(app.prompts, [], 'no prompt when the password is needed');
  assert.equal((await app.invoke('status')).unlocked, false);

  const unlocked = await app.invoke('unlock', PASSWORD);
  assert.equal(unlocked.touchId, 'ready');
  assert.equal((await app.sealed()).passwordAt, START + DAY, 'the password unlock renewed when it was used');
  await app.invoke('lock');
  assert.equal((await app.invoke('unlockWithTouchId')).unlocked, true);
});

test('after 14 days since the password was used, Touch ID refuses until the password is used again', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  app.clock.now = START + 14 * DAY;
  assert.equal((await app.invoke('status')).touchId, 'ready', 'exactly 14 days still works');
  app.clock.now = START + 14 * DAY + 1;
  assert.equal((await app.invoke('status')).touchId, 'password');
  await assert.rejects(app.invoke('unlockWithTouchId'), NEEDED);
  assert.deepEqual(plain(await app.request('unlockWithTouchId')), { unlocked: false, reason: 'password' });
  assert.deepEqual(app.prompts, []);

  // A Touch ID unlock doesn't renew the 14 days; only the password does.
  app.clock.now = START + 15 * DAY;
  await app.invoke('unlock', PASSWORD);
  await app.invoke('lock');
  app.clock.now = START + 28 * DAY;
  assert.equal((await app.invoke('unlockWithTouchId')).unlocked, true);
  await app.invoke('lock');
  app.clock.now = START + 29 * DAY + 1;
  assert.equal((await app.invoke('status')).touchId, 'password');

  // A clock set back before the password was last used also asks for the password.
  await app.invoke('unlock', PASSWORD);
  await app.invoke('lock');
  app.clock.now = START + 29 * DAY;
  assert.equal((await app.invoke('status')).touchId, 'password');
  await assert.rejects(app.invoke('unlockWithTouchId'), NEEDED);
});

test('the time sealed with the key is checked too: a sealed key older than 14 days needs the password', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  const sealed = await app.sealed();
  await fsp.writeFile(app.sealedPath, `sealed:${Buffer.from(JSON.stringify({ ...sealed, passwordAt: START - 14 * DAY - 1 })).toString('hex')}`);
  await assert.rejects(app.invoke('unlockWithTouchId'), NEEDED);
  assert.equal((await app.invoke('status')).unlocked, false);
  assert.equal(app.prompts.length, 1);
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

test('two Touch ID requests at once share one prompt', async t => {
  const { app } = await withTouchId(t);
  await app.invoke('lock');
  const [fromApp, fromChrome] = await Promise.all([app.invoke('unlockWithTouchId'), app.request('unlockWithTouchId')]);
  assert.equal(fromApp.unlocked, true);
  assert.deepEqual(plain(fromChrome), { unlocked: true });
  assert.deepEqual(app.prompts, ['unlock SecondHand']);
});

test('turning Touch ID off removes its slot and the sealed key; the other slots stay', async t => {
  const { app } = await withTouchId(t);
  const slots = await app.slots();
  const off = await app.invoke('setTouchIdUnlock', { enabled: false });
  assert.equal(off.touchId, 'off');
  await assert.rejects(fsp.access(app.sealedPath));
  const after = await app.slots();
  assert.deepEqual(Object.keys(after).sort(), ['device', 'password', 'recovery']);
  for (const name of ['password', 'recovery', 'device']) assert.deepEqual(after[name], slots[name]);
  await app.invoke('lock');
  await assert.rejects(app.invoke('unlockWithTouchId'), /Touch ID is off/);
  assert.deepEqual(plain(await app.request('unlockWithTouchId')), { unlocked: false, reason: 'off' });
  assert.deepEqual(app.prompts, []);
  await assert.rejects(app.invoke('setTouchIdUnlock', { enabled: false }), /Unlock SecondHand first/);
});

test('an unreadable sealed key turns Touch ID off with the reason, asks for the password, and the password removes the slot', async t => {
  const cases = [
    ['not sealed by this Mac', () => Buffer.from('tampered'), /because this Mac’s Keychain couldn’t open its key/],
    ['damaged inside', () => Buffer.from(`sealed:${Buffer.from('{"version":1').toString('hex')}`), /because its key file on this Mac is damaged/],
    ['the wrong shape', () => Buffer.from(`sealed:${Buffer.from(JSON.stringify({ version: 2, passwordAt: START, key: crypto.randomBytes(32).toString('base64') })).toString('hex')}`), /because its key file on this Mac is damaged/],
    ['a key for other information', () => Buffer.from(`sealed:${Buffer.from(JSON.stringify({ version: 1, passwordAt: START, key: crypto.randomBytes(32).toString('base64') })).toString('hex')}`), /because its key doesn’t open your saved information/]
  ];
  for (const [name, bytes, reason] of cases) {
    const { app } = await withTouchId(t);
    await app.invoke('lock');
    await fsp.writeFile(app.sealedPath, bytes());
    const error = await app.invoke('unlockWithTouchId').then(() => assert.fail(`${name}: unlocked`), failure => failure);
    assert.match(error.message, /^Touch ID was turned off because .+\. Enter your password\.$/, name);
    assert.match(error.message, reason, name);
    await assert.rejects(fsp.access(app.sealedPath), `${name}: the sealed key is removed`);
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

test('a damaged sealed key found by a password unlock turns Touch ID off and says so, and the unlock still works', async t => {
  const first = await withTouchId(t);
  await first.app.invoke('lock');
  await fsp.writeFile(first.app.sealedPath, 'tampered');
  const app = await desktop(t, { userData: first.app.userData });
  const unlocked = await app.invoke('unlock', PASSWORD);
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.touchId, 'off');
  assert.match(unlocked.touchIdNotice, /^Touch ID was turned off because this Mac’s Keychain couldn’t open its key\.$/);
  await assert.rejects(fsp.access(app.sealedPath));
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
  await assert.rejects(fsp.access(app.sealedPath));
});

test('a password reset with the recovery key or this computer removes the Touch ID slot and key', async t => {
  for (const method of ['recovery', 'device']) {
    const { app, recoveryKey } = await withTouchId(t);
    await app.invoke('lock');
    const reset = await app.invoke('resetPassword', method === 'device' ? { method, password: 'synthetic new password' } : { recoveryKey, password: 'synthetic new password' });
    assert.equal(reset.unlocked, true, method);
    assert.equal(reset.touchId, 'off', method);
    await assert.rejects(fsp.access(app.sealedPath), method);
    assert.deepEqual(Object.keys(await app.slots()).sort(), ['device', 'password', 'recovery'], method);
    await app.invoke('lock');
    await assert.rejects(app.invoke('unlockWithTouchId'), /Touch ID is off/, method);
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
  await assert.rejects(fsp.access(app.sealedPath));
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
  await assert.rejects(fsp.access(app.sealedPath));
  assert.equal((await app.invoke('status')).touchId, 'off');
  await assert.rejects(app.invoke('unlockWithTouchId'), /Touch ID is off/);
  // The restored file still carries the slot it was saved with; the password unlock removes it.
  const unlocked = await app.invoke('unlock', PASSWORD);
  assert.equal(unlocked.touchIdNotice, null);
  assert.deepEqual(Object.keys(await app.slots()).sort(), ['device', 'password', 'recovery']);
});

test('a new password removes a Touch ID key left from earlier information', async t => {
  const userData = await folder(t);
  await fsp.writeFile(path.join(userData, 'touch-unlock.bin'), 'left from earlier information');
  const app = await desktop(t, { userData });
  await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  await assert.rejects(fsp.access(app.sealedPath));
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
  await assert.rejects(fsp.access(noKeychain.sealedPath));
  assert.deepEqual(Object.keys(await noKeychain.slots()).sort(), ['password', 'recovery']);
});

test('from Chrome: status says only ready, password or off, and unlockWithTouchId unlocks and tells the window', async t => {
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
