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
// Values created inside the vm context have foreign prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');

// Runs the real main process and vault against a temporary folder. Only the
// operating system's protected storage is simulated, so no Keychain is touched.
// Dialogs answer with `dialog`'s functions, each call recorded; the clipboard and timers are simulated.
async function desktop(t, { encryptionAvailable = true, shell = {}, env = {}, isPackaged = false, dialog = {} } = {}) {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'secondhand-recovery-main-'));
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));
  let invoke;
  let window;
  const dialogs = [];
  const timers = [];
  // The files main.cjs reads.
  const reads = [];
  const clipboard = { text: '', writeText(text) { this.text = text; }, readText() { return this.text; }, clear() { this.text = ''; } };
  const asked = name => async (_window, options) => {
    dialogs.push({ name, options: JSON.parse(JSON.stringify(options)) });
    if (!dialog[name]) assert.fail(`Unexpected ${name}`);
    return dialog[name](options);
  };
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
    dialog: { showErrorBox() { assert.fail('Desktop setup failed'); }, showOpenDialog: asked('showOpenDialog'), showSaveDialog: asked('showSaveDialog'), showMessageBox: asked('showMessageBox') },
    shell, clipboard, powerMonitor: { on() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } };
  // A Mac without Touch ID; tests/desktop-touch-id-main.test.cjs covers Touch ID.
  electron.systemPreferences = { canPromptTouchID: () => false };
  const overrides = {
    electron,
    'node:fs/promises': { ...fsp, readFile: (file, ...rest) => { reads.push(String(file)); return fsp.readFile(file, ...rest); } },
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
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {}, Buffer
  });
  for (let attempt = 0; !window && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(window, 'The desktop window was not created');
  return {
    userData, dialogs, timers, clipboard, reads,
    vaultPath: path.join(userData, 'vault.secondhand'),
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

// Backups (#140). Every refused restore leaves the saved information as it was: the same encrypted bytes,
// no copy of them, and the guided setup's progress.
const PASSWORD = 'synthetic first password';
const snapshot = async app => ({ vault: await fsp.readFile(app.vaultPath), files: (await fsp.readdir(app.userData)).sort() });

test('every refused or cancelled restore leaves the saved information as it was', async t => {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'secondhand-recovery-backups-'));
  t.after(() => fsp.rm(folder, { recursive: true, force: true }));
  const files = {
    backup: path.join(folder, 'synthetic.secondhand'), folder: path.join(folder, 'a folder.secondhand'),
    large: path.join(folder, 'too large.secondhand'), malformed: path.join(folder, 'malformed.secondhand'), other: path.join(folder, 'other format.secondhand')
  };
  let chosen = null;
  let replace = 0;
  const app = await desktop(t, { dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: files.backup }),
    showOpenDialog: async () => chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] },
    showMessageBox: async () => ({ response: replace })
  } });
  await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  await app.invoke('saveProfile', { firstName: 'Backed up' });
  assert.deepEqual(plain(await app.invoke('exportBackup')), { cancelled: false });
  await app.invoke('saveProfile', { firstName: 'Current' });
  await app.invoke('startSetup');
  await fsp.mkdir(files.folder);
  await fsp.writeFile(files.large, '');
  await fsp.truncate(files.large, 8 * 1024 * 1024 + 1);
  await fsp.writeFile(files.malformed, 'not a backup');
  await fsp.writeFile(files.other, JSON.stringify({ version: 3, cipher: 'aes-256-gcm' }));
  const before = await snapshot(app);

  chosen = files.backup;
  await assert.rejects(app.invoke('importBackup'), /^Error: Lock SecondHand before restoring a backup\.$/);
  assert.deepEqual(app.dialogs.filter(({ name }) => name === 'showOpenDialog'), [], 'no file is asked for while unlocked');
  await app.invoke('lock');
  for (const [name, file, outcome] of [['the file chooser cancelled', null, { cancelled: true }], ['a folder', files.folder], ['too large', files.large],
    ['malformed', files.malformed], ['another format', files.other], ['“Replace saved information?” declined', files.backup, { cancelled: true }]]) {
    chosen = file;
    const prompts = app.dialogs.length;
    if (outcome) assert.deepEqual(plain(await app.invoke('importBackup')), outcome, name);
    else await assert.rejects(app.invoke('importBackup'), /^Error: This is not a supported encrypted backup\.$/, name);
    assert.deepEqual(await snapshot(app), before, `${name}: nothing changed`);
    if (file === files.large || file === files.folder) assert.equal(app.reads.includes(file), false, `${name}: never read`);
    if (name.startsWith('“Replace')) {
      const { options } = app.dialogs.at(-1);
      assert.equal(options.title, 'Replace saved information?');
      assert.deepEqual(options.buttons, ['Cancel', 'Replace']);
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
    } else assert.equal(app.dialogs.slice(prompts).some(({ name: kind }) => kind === 'showMessageBox'), false, `${name}: nothing to confirm`);
  }

  // Replace restores the backup, keeps an encrypted copy of what it replaced, and ends the guided setup.
  replace = 1;
  assert.deepEqual(plain(await app.invoke('importBackup')), { cancelled: false });
  assert.deepEqual(await fsp.readFile(app.vaultPath), await fsp.readFile(files.backup));
  const copies = (await fsp.readdir(app.userData)).filter(name => name.startsWith('vault.secondhand.before-import-'));
  assert.equal(copies.length, 1);
  assert.deepEqual(await fsp.readFile(path.join(app.userData, copies[0])), before.vault);
  await assert.rejects(fsp.access(path.join(app.userData, 'setup-progress.json')));
  await app.invoke('unlock', PASSWORD);
  assert.equal((await app.invoke('getData')).profile.firstName, 'Backed up');
});

test('export: refused before a password exists, nothing written when cancelled, otherwise the encrypted file as it is', async t => {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'secondhand-recovery-export-'));
  t.after(() => fsp.rm(folder, { recursive: true, force: true }));
  const target = path.join(folder, 'synthetic.secondhand');
  let cancel = true;
  const app = await desktop(t, { dialog: { showSaveDialog: async () => ({ canceled: cancel, filePath: target }) } });
  await assert.rejects(app.invoke('exportBackup'), /^Error: Create a password before saving a backup\.$/);
  assert.deepEqual(app.dialogs, [], 'no file is asked for');
  await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  assert.deepEqual(plain(await app.invoke('exportBackup')), { cancelled: true });
  await assert.rejects(fsp.access(target));
  cancel = false;
  await app.invoke('lock');
  assert.deepEqual(plain(await app.invoke('exportBackup')), { cancelled: false }, 'a locked app can save its locked copy');
  assert.deepEqual(await fsp.readFile(target), await fsp.readFile(app.vaultPath));
  if (process.platform !== 'win32') assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
});

// The recovery key (#140).
const KEY = /^[0-9A-Z]{4}(?:-[0-9A-Z]{4}){7}$/;
test('Copy puts the recovery key on the clipboard and clears it a minute later, unless something else was copied', async t => {
  const app = await desktop(t);
  const created = await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  const typed = created.recoveryKey.toLowerCase().replace(/-/g, ' ');
  await assert.rejects(app.invoke('copyRecoveryKey', 'not a recovery key'), /Enter the recovery key exactly as it was shown/);
  assert.equal(app.clipboard.text, '');
  const minute = () => app.timers.filter(timer => timer.ms === 60 * 1000);
  assert.equal(minute().length, 0);

  assert.equal(await app.invoke('copyRecoveryKey', typed), true);
  assert.equal(app.clipboard.text, created.recoveryKey, 'copied as it was shown');
  assert.equal(minute().length, 1);
  minute()[0].callback();
  assert.equal(app.clipboard.text, '', 'cleared after a minute');

  await app.invoke('copyRecoveryKey', created.recoveryKey);
  app.clipboard.writeText('something the person copied since');
  minute()[1].callback();
  assert.equal(app.clipboard.text, 'something the person copied since', 'something else on the clipboard stays');
});

test('Save writes the recovery key and how to use it to the file the person picks, readable only by them; Cancel writes nothing', async t => {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'secondhand-recovery-key-'));
  t.after(() => fsp.rm(folder, { recursive: true, force: true }));
  const target = path.join(folder, 'key.txt');
  let cancel = true;
  const app = await desktop(t, { dialog: { showSaveDialog: async () => ({ canceled: cancel, filePath: target }) } });
  const { recoveryKey } = await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  await assert.rejects(app.invoke('saveRecoveryKey', 'not a recovery key'), /Enter the recovery key exactly as it was shown/);
  assert.deepEqual(app.dialogs, [], 'a key that isn’t one is never offered for saving');
  assert.deepEqual(plain(await app.invoke('saveRecoveryKey', recoveryKey)), { cancelled: true });
  await assert.rejects(fsp.access(target));
  assert.equal(app.dialogs[0].options.defaultPath, 'SecondHand recovery key.txt');
  cancel = false;
  assert.deepEqual(plain(await app.invoke('saveRecoveryKey', recoveryKey.toLowerCase())), { cancelled: false });
  assert.equal(await fsp.readFile(target, 'utf8'), `SecondHand recovery key\n\n${recoveryKey}\n\nIf you forget your password, choose "Forgot password?" on the SecondHand unlock screen and enter this key.\nAnyone with this key and your SecondHand files can open your information. Keep it somewhere safe, away from this computer.\n`);
  if (process.platform !== 'win32') assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
});

test('a new recovery key needs SecondHand unlocked, stops the old key working, and a failed one keeps the old key', async t => {
  const app = await desktop(t);
  const { recoveryKey: first } = await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  await app.invoke('lock');
  await assert.rejects(app.invoke('replaceRecoveryKey'), /Unlock SecondHand first/);
  await app.invoke('unlock', PASSWORD);

  // The encrypted file can't be written: a folder is in its place.
  const bytes = await fsp.readFile(app.vaultPath);
  await fsp.rm(app.vaultPath);
  await fsp.mkdir(app.vaultPath);
  await fsp.writeFile(path.join(app.vaultPath, 'in the way'), 'synthetic');
  await assert.rejects(app.invoke('replaceRecoveryKey'), /^Error: Could not create a recovery key\. Please try again\.$/);
  await fsp.rm(app.vaultPath, { recursive: true });
  await fsp.writeFile(app.vaultPath, bytes);
  await app.invoke('lock');
  assert.equal((await app.invoke('resetPassword', { recoveryKey: first, password: PASSWORD })).unlocked, true, 'the old key still works');

  const { recoveryKey: second } = await app.invoke('replaceRecoveryKey');
  assert.match(second, KEY);
  assert.notEqual(second, first);
  assert.equal((await app.invoke('status')).recoveryKey, true);
  await app.invoke('lock');
  await assert.rejects(app.invoke('resetPassword', { recoveryKey: first, password: 'synthetic second password' }), /That recovery key didn’t work/);
  assert.equal((await app.invoke('resetPassword', { recoveryKey: second, password: 'synthetic second password' })).unlocked, true);
});
