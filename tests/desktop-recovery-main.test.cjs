'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const realLaya = require('../desktop/laya.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');

// Runs the real main process and vault against a temporary folder. Only the
// operating system's protected storage is simulated, so no Keychain is touched.
async function desktop(t, { encryptionAvailable = true, shell = {}, env = {}, isPackaged = false } = {}) {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'secondhand-recovery-main-'));
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));
  let invoke;
  let window;
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('hex')}`),
    decryptString: bytes => {
      const text = bytes.toString();
      if (!text.startsWith('sealed:')) throw new Error('Not sealed by this computer.');
      return Buffer.from(text.slice(7), 'hex').toString();
    }
  };
  class BrowserWindow {
    constructor() {
      window = this;
      this.webContents = { mainFrame: { url: pathToFileURL(path.join(root, 'renderer/index.html')).href },
        setWindowOpenHandler() {}, on() {}, send() {} };
    }
    show() {} focus() {} setMenuBarVisibility() {} once() {} on() {} loadFile() {}
    isDestroyed() { return false; }
  }
  const app = { isPackaged, setName() {}, setPath() {}, getPath: () => userData,
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on() {} };
  const electron = { app, BrowserWindow, safeStorage, ipcMain: { handle(_name, handler) { invoke = handler; } },
    dialog: { showErrorBox() { assert.fail('Desktop setup failed'); } },
    shell, clipboard: {}, powerMonitor: { on() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } };
  const overrides = {
    electron,
    './bridge.cjs': { ...require('../desktop/bridge.cjs'), startBridge: async () => ({ close: async () => {} }) },
    './extension-setup.cjs': { getExtensionSetup: async () => ({ prepared: false }) },
    './registration.cjs': { registerHost: async () => ({}) },
    './test-storage-path.cjs': { testStoragePath: () => null },
    // The real Laya runtime, minus its background download and update checks (tests/desktop-laya-main.test.cjs covers those).
    './laya.cjs': { ...realLaya, createLaya: options => ({ ...realLaya.createLaya(options), startUpdates() {}, update() {} }) }
  };
  vm.runInNewContext(source, {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name.startsWith('.') ? path.join(root, 'desktop', name) : name),
    __dirname: path.join(root, 'desktop'), process: { platform: 'darwin', env, argv: ['synthetic-electron'] },
    setTimeout: () => 1, clearTimeout() {}, Buffer
  });
  for (let attempt = 0; !window && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(window, 'The desktop window was not created');
  return {
    secretPath: path.join(userData, 'device-reset.bin'),
    invoke: (method, argument) => invoke({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, method, ...(argument === undefined ? [] : [argument]))
  };
}

test('a password created with reset on this computer can be reset there, and turning it off removes the secret', async t => {
  const app = await desktop(t);
  const created = await app.invoke('createVault', { password: 'synthetic first password', allowDeviceReset: true });
  assert.equal(created.status.deviceReset, true);
  assert.equal(created.status.deviceResetSupported, true);
  assert.equal(created.deviceResetFailed, false);
  assert.match((await fsp.readFile(app.secretPath)).toString(), /^sealed:/);
  const sealed = await fsp.readFile(app.secretPath);

  await assert.rejects(app.invoke('createVault', { password: 'another synthetic password', allowDeviceReset: true }), /already has a password/);
  assert.deepEqual(await fsp.readFile(app.secretPath), sealed, 'A failed create must not replace the existing secret');

  await app.invoke('lock');
  const reset = await app.invoke('resetPassword', { method: 'device', password: 'synthetic second password' });
  assert.equal(reset.unlocked, true);
  await app.invoke('lock');
  await assert.rejects(app.invoke('unlock', 'synthetic first password'), /Unable to unlock/);
  await app.invoke('unlock', 'synthetic second password');

  const off = await app.invoke('setDeviceReset', false);
  assert.equal(off.deviceReset, false);
  await assert.rejects(fsp.access(app.secretPath));
  await app.invoke('lock');
  await assert.rejects(app.invoke('resetPassword', { method: 'device', password: 'synthetic third password' }), /isn’t set up/);

  await app.invoke('unlock', 'synthetic second password');
  assert.equal((await app.invoke('setDeviceReset', true)).deviceReset, true);
  await app.invoke('lock');
  await fsp.writeFile(app.secretPath, 'tampered');
  await assert.rejects(app.invoke('resetPassword', { method: 'device', password: 'synthetic third password' }), /Use your recovery key/);
});

test('without protected storage, a new password still gets a recovery key and reports that device reset failed', async t => {
  const app = await desktop(t, { encryptionAvailable: false });
  const created = await app.invoke('createVault', { password: 'synthetic first password', allowDeviceReset: true });
  assert.equal(created.deviceResetFailed, true);
  assert.equal(created.status.deviceReset, false);
  assert.equal(created.status.recoveryKey, true);
  assert.match(created.recoveryKey, /^[0-9A-Z]{4}(?:-[0-9A-Z]{4}){7}$/);
  await assert.rejects(fsp.access(app.secretPath));
  await assert.rejects(app.invoke('setDeviceReset', true), /couldn’t save a reset option/);
});

test('the Chrome setup guide opens the published page, or a local website only during development', async t => {
  const published = 'https://secondhand-download.khoidoan00.chatgpt.site/chrome-extension';
  const opened = [];
  const shell = { openExternal: async url => { opened.push(url); } };
  for (const options of [{}, { env: { SECONDHAND_WEBSITE_URL: 'http://localhost:3002' } }, { env: { SECONDHAND_WEBSITE_URL: 'javascript:alert(1)' } },
    { env: { SECONDHAND_WEBSITE_URL: 'file:///etc/passwd' } }, { isPackaged: true, env: { SECONDHAND_WEBSITE_URL: 'http://localhost:3002' } }]) {
    const app = await desktop(t, { shell, ...options });
    assert.equal(await app.invoke('openExtensionGuide'), true);
  }
  assert.deepEqual(opened, [published, 'http://localhost:3002/chrome-extension', published, published, published]);
});

test('starting over erases the locked information and reset secret, keeps settings, and allows a new password', async t => {
  const app = await desktop(t);
  const userData = path.dirname(app.secretPath);
  await app.invoke('createVault', { password: 'synthetic first password', allowDeviceReset: true });
  const settings = path.join(userData, 'settings.json');
  await fsp.writeFile(settings, JSON.stringify({ extensionId: '', autofillWithoutAsking: false, trustedSites: [] }));
  await fsp.writeFile(path.join(userData, 'vault.secondhand.before-import-1-abcd1234'), 'encrypted copy');

  await assert.rejects(app.invoke('startOver', { confirmation: 'start over' }), /Lock SecondHand before starting over/);
  await app.invoke('lock');
  for (const request of [undefined, {}, { confirmation: 'erase' }, { confirmation: 'start' }, { confirmation: ['start over'] }]) {
    await assert.rejects(app.invoke('startOver', request), /Type “start over” to confirm/);
  }
  assert.equal((await app.invoke('status')).exists, true, 'Nothing is erased without the phrase');

  const erased = await app.invoke('startOver', { confirmation: '  Start Over ' });
  assert.equal(erased.exists, false);
  assert.equal(erased.unlocked, false);
  assert.equal(erased.deviceReset, false);
  await assert.rejects(fsp.access(path.join(userData, 'vault.secondhand')));
  await assert.rejects(fsp.access(path.join(userData, 'vault.secondhand.before-import-1-abcd1234')));
  await assert.rejects(fsp.access(app.secretPath));
  await fsp.access(settings);

  const created = await app.invoke('createVault', { password: 'synthetic new password', allowDeviceReset: false });
  assert.equal(created.status.unlocked, true);
  assert.deepEqual((await app.invoke('getData')).profile, {});
  await app.invoke('lock');
  await assert.rejects(app.invoke('unlock', 'synthetic first password'), /Unable to unlock/);
});
