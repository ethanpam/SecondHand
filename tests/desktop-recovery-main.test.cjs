'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const realLaya = require('../desktop/laya.cjs');
const { plain, startMain, safeStorage } = require('./helpers/harness.cjs');

// Runs the real main process and vault against a temporary folder. Only the
// operating system's protected storage is simulated, so no Keychain is touched.
// Dialogs answer with `dialog`'s functions, each call recorded; the clipboard and timers are simulated.
// Given `userData`, it starts again on that folder, as a restart does.
async function desktop(t, { encryptionAvailable = true, shell = {}, env = {}, isPackaged = false, dialog = {}, userData } = {}) {
  if (!userData) {
    userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'secondhand-recovery-main-'));
    t.after(() => fsp.rm(userData, { recursive: true, force: true }));
  }
  const dialogs = [];
  // The files main.cjs reads.
  const reads = [];
  const clipboard = { text: '', writeText(text) { this.text = text; }, readText() { return this.text; }, clear() { this.text = ''; } };
  const asked = name => async (_window, options) => {
    dialogs.push({ name, options: JSON.parse(JSON.stringify(options)) });
    if (!dialog[name]) assert.fail(`Unexpected ${name}`);
    return dialog[name](options);
  };
  const main = await startMain({ userData, platform: 'darwin', env, packaged: isPackaged,
    dialog: { showOpenDialog: asked('showOpenDialog'), showSaveDialog: asked('showSaveDialog'), showMessageBox: asked('showMessageBox') },
    electron: { safeStorage: safeStorage({ available: encryptionAvailable }), shell, clipboard },
    modules: {
      'node:fs/promises': { ...fsp, readFile: (file, ...rest) => { reads.push(String(file)); return fsp.readFile(file, ...rest); } },
      './extension-setup.cjs': { getExtensionSetup: async () => ({ prepared: false }) },
      // The real Laya runtime, minus its background download and update checks (tests/desktop-laya-main.test.cjs covers those).
      './laya.cjs': { ...realLaya, createLaya: options => ({ ...realLaya.createLaya(options), startUpdates() {}, update() {} }) }
    } });
  return {
    userData, dialogs, timers: main.timers, clipboard, reads,
    vaultPath: path.join(userData, 'vault.secondhand'),
    secretPath: path.join(userData, 'device-reset.bin'),
    invoke: main.invoke,
    // A request from the extension with this ID.
    request: request => main.bridge({ id: 'synthetic', ...request }, { extensionId: EXTENSION })
  };
}
const EXTENSION = 'a'.repeat(32);

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
  await assert.rejects(fsp.access(app.secretPath), { code: 'ENOENT' });
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
  await assert.rejects(fsp.access(app.secretPath), { code: 'ENOENT' });
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
  await assert.rejects(fsp.access(path.join(userData, 'vault.secondhand')), { code: 'ENOENT' });
  await assert.rejects(fsp.access(path.join(userData, 'vault.secondhand.before-import-1-abcd1234')), { code: 'ENOENT' });
  await assert.rejects(fsp.access(app.secretPath), { code: 'ENOENT' });
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
  await assert.rejects(fsp.access(path.join(app.userData, 'setup-progress.json')), { code: 'ENOENT' });
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
  await assert.rejects(fsp.access(target), { code: 'ENOENT' });
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
  await assert.rejects(fsp.access(target), { code: 'ENOENT' });
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

// settings.json (#139): 50 trusted sites with the longest host name DNS allows (253 characters), with every
// other setting on, are saved and read back after a restart.
const longestHost = n => `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${`site${String(n).padStart(2, '0')}`.padEnd(61, 'x')}`;
const trusting = { showMessageBox: async () => ({ response: 1 }) };

test('50 trusted sites with the longest host names, and every other setting, survive a restart', async t => {
  const app = await desktop(t, { dialog: trusting });
  await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  await app.invoke('connectExtension', EXTENSION);
  await app.invoke('setAutofillTrust', true);
  await app.invoke('setLayaEnabled', false);
  assert.equal(longestHost(0).length, 253);
  const sites = Array.from({ length: 50 }, (_, n) => `https://${longestHost(n)}`);
  for (const site of sites) assert.deepEqual(plain(await app.request({ type: 'trustSite', url: `${site}/apply` })), { trusted: true, origin: site });
  assert.deepEqual(plain(await app.request({ type: 'trustAllSites' })), { allSites: true });
  assert.ok((await fsp.stat(path.join(app.userData, 'settings.json'))).size > 13000, 'the largest settings.json SecondHand can write');

  const restarted = await desktop(t, { userData: app.userData });
  const status = await restarted.invoke('status');
  assert.equal(status.settingsNotice, null);
  assert.deepEqual(plain(status.trustedSites), sites);
  assert.equal(status.extensionId, EXTENSION);
  assert.equal(status.autofillWithoutAsking, true);
  assert.equal(status.allSites, true);
  assert.equal(status.laya.state, 'off');
});

test('a site whose host name is longer than DNS allows can’t be trusted', async t => {
  const app = await desktop(t, { dialog: trusting });
  await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: false });
  await app.invoke('connectExtension', EXTENSION);
  const tooLong = `https://${longestHost(0)}x/apply`;
  await assert.rejects(app.request({ type: 'trustSite', url: tooLong }), error => error.publicMessage === 'This site’s address is too long for SecondHand to trust.');
  assert.deepEqual(app.dialogs, [], 'nothing is asked');
  assert.deepEqual(plain((await app.invoke('status')).trustedSites), []);
});
