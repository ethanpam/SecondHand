'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const realLaya = require('../desktop/laya.cjs');
const { plain, startMain, safeStorage, addRetiredDeviceSlot } = require('./helpers/harness.cjs');

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
const PASSWORD = 'synthetic first password';
const KEY = /^[0-9A-Z]{4}(?:-[0-9A-Z]{4}){7}$/;
const PASSWORD_UNLOCK_ERROR = 'That password didn’t open SecondHand. Check it and try again. If you’re sure it’s right, you can use your recovery key or restore a backup.';

// "Let this computer reset my password" was removed: anyone signed in to the computer account could set
// a new password without the recovery key. Only the recovery key resets a password now.
test('a new password gets a recovery key, and nothing else resets it', async t => {
  const app = await desktop(t);
  const created = await app.invoke('createVault', { password: PASSWORD, allowDeviceReset: true });
  assert.match(created.recoveryKey, KEY);
  assert.deepEqual(Object.keys(created).sort(), ['recoveryKey', 'status']);
  for (const name of ['deviceReset', 'deviceResetSupported']) assert.equal(name in created.status, false, name);
  await assert.rejects(fsp.access(app.secretPath), { code: 'ENOENT' }, 'no reset secret is sealed');
  await assert.rejects(app.invoke('setDeviceReset', true), /Request denied/);
  await app.invoke('lock');
  const before = await fsp.readFile(app.vaultPath);
  await assert.rejects(app.invoke('resetPassword', { method: 'device', password: 'synthetic second password' }), /Enter the recovery key/);
  assert.deepEqual(await fsp.readFile(app.vaultPath), before);
  assert.equal((await app.invoke('resetPassword', { recoveryKey: created.recoveryKey, password: 'synthetic second password' })).unlocked, true);
});

// Information saved while reset on this computer was on: its sealed secret and its slot.
async function savedWithDeviceReset(t) {
  const first = await desktop(t);
  const { recoveryKey } = await first.invoke('createVault', { password: PASSWORD });
  await first.invoke('saveProfile', { firstName: 'Saved Before' });
  await first.invoke('lock');
  const secret = addRetiredDeviceSlot(first.vaultPath, PASSWORD);
  await fsp.writeFile(first.secretPath, safeStorage().encryptString(secret.toString('base64')));
  return { userData: first.userData, recoveryKey };
}
const slotNames = async app => Object.keys(JSON.parse(await fsp.readFile(app.vaultPath, 'utf8')).slots).sort();

test('information saved with reset on this computer turned on can’t be reset without the recovery key after the update', async t => {
  const { userData } = await savedWithDeviceReset(t);
  const app = await desktop(t, { userData });
  await assert.rejects(fsp.access(app.secretPath), { code: 'ENOENT' }, 'the sealed secret is deleted when SecondHand starts');
  const before = await fsp.readFile(app.vaultPath);
  await assert.rejects(app.invoke('resetPassword', { method: 'device', password: 'synthetic attacker password' }), /Enter the recovery key/);
  assert.deepEqual(await fsp.readFile(app.vaultPath), before, 'nothing changed');
  assert.equal((await app.invoke('status')).unlocked, false);
  await assert.rejects(app.invoke('unlock', 'synthetic attacker password'), new Error(PASSWORD_UNLOCK_ERROR));
});

test('the first unlock after the update removes the old reset slot and says so once, until dismissed or a new key is made', async t => {
  const { userData } = await savedWithDeviceReset(t);
  const app = await desktop(t, { userData });
  assert.equal((await app.invoke('status')).deviceResetEnded, false, 'nothing to say while locked');
  const unlocked = await app.invoke('unlock', PASSWORD);
  assert.equal(unlocked.deviceResetEnded, true);
  assert.deepEqual(await slotNames(app), ['password', 'recovery']);
  assert.equal((await app.invoke('getData')).profile.firstName, 'Saved Before');
  assert.equal((await app.invoke('dismissDeviceResetNotice')).deviceResetEnded, false);
  await app.invoke('lock');
  assert.equal((await app.invoke('unlock', PASSWORD)).deviceResetEnded, false, 'once only');

  const replaced = await desktop(t, { userData: (await savedWithDeviceReset(t)).userData });
  assert.equal((await replaced.invoke('unlock', PASSWORD)).deviceResetEnded, true);
  await replaced.invoke('replaceRecoveryKey');
  assert.equal((await replaced.invoke('status')).deviceResetEnded, false, 'a new recovery key answers it');

  const locked = await desktop(t, { userData: (await savedWithDeviceReset(t)).userData });
  assert.equal((await locked.invoke('unlock', PASSWORD)).deviceResetEnded, true);
  assert.equal((await locked.invoke('lock')).deviceResetEnded, false, 'locking ends it');
  assert.equal((await locked.invoke('unlock', PASSWORD)).deviceResetEnded, false);
});

test('a reset with the recovery key removes the old reset slot without the notice: the key is in hand', async t => {
  const { userData, recoveryKey } = await savedWithDeviceReset(t);
  const app = await desktop(t, { userData });
  const reset = await app.invoke('resetPassword', { recoveryKey, password: 'synthetic second password' });
  assert.equal(reset.unlocked, true);
  assert.equal(reset.deviceResetEnded, false);
  assert.deepEqual(await slotNames(app), ['password', 'recovery']);
});

test('the Chrome setup guide opens the published page, or a local website only during development', async t => {
  const published = 'https://secondhand.ethanpam.workers.dev/chrome-extension';
  const opened = [];
  const shell = { openExternal: async url => { opened.push(url); } };
  for (const options of [{}, { env: { SECONDHAND_WEBSITE_URL: 'http://localhost:3002' } }, { env: { SECONDHAND_WEBSITE_URL: 'javascript:alert(1)' } },
    { env: { SECONDHAND_WEBSITE_URL: 'file:///etc/passwd' } }, { isPackaged: true, env: { SECONDHAND_WEBSITE_URL: 'http://localhost:3002' } }]) {
    const app = await desktop(t, { shell, ...options });
    assert.equal(await app.invoke('openExtensionGuide'), true);
  }
  assert.deepEqual(opened, [published, 'http://localhost:3002/chrome-extension', published, published, published]);
});

test('starting over erases the locked information, keeps settings, and allows a new password', async t => {
  const app = await desktop(t);
  const userData = app.userData;
  await app.invoke('createVault', { password: 'synthetic first password' });
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
  await assert.rejects(fsp.access(path.join(userData, 'vault.secondhand')), { code: 'ENOENT' });
  await assert.rejects(fsp.access(path.join(userData, 'vault.secondhand.before-import-1-abcd1234')), { code: 'ENOENT' });
  await fsp.access(settings);

  const created = await app.invoke('createVault', { password: 'synthetic new password' });
  assert.equal(created.status.unlocked, true);
  assert.deepEqual((await app.invoke('getData')).profile, {});
  await app.invoke('lock');
  await assert.rejects(app.invoke('unlock', 'synthetic first password'), new Error(PASSWORD_UNLOCK_ERROR));
});

test('an unparseable vault keeps the generic unlock message', async t => {
  const app = await desktop(t);
  await fsp.writeFile(app.vaultPath, 'not a vault');
  await assert.rejects(app.invoke('unlock', 'synthetic first password'), new Error('Could not unlock SecondHand.'));
});

// Backups (#140). Every refused restore leaves the saved information as it was: the same encrypted bytes,
// no copy of them, and the guided setup's progress.
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
  await app.invoke('createVault', { password: PASSWORD });
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
  await app.invoke('createVault', { password: PASSWORD });
  assert.deepEqual(plain(await app.invoke('exportBackup')), { cancelled: true });
  await assert.rejects(fsp.access(target), { code: 'ENOENT' });
  cancel = false;
  await app.invoke('lock');
  assert.deepEqual(plain(await app.invoke('exportBackup')), { cancelled: false }, 'a locked app can save its locked copy');
  assert.deepEqual(await fsp.readFile(target), await fsp.readFile(app.vaultPath));
  if (process.platform !== 'win32') assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
});

// The recovery key (#140).
test('Copy puts the recovery key on the clipboard and clears it a minute later, unless something else was copied', async t => {
  const app = await desktop(t);
  const created = await app.invoke('createVault', { password: PASSWORD });
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
  const { recoveryKey } = await app.invoke('createVault', { password: PASSWORD });
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
  const { recoveryKey: first } = await app.invoke('createVault', { password: PASSWORD });
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

// settings.json (#139): 50 trusted sites with the longest host name DNS allows (253 characters), each with Always
// allow on this site (#175), and every other setting on, are saved and read back after a restart.
const longestHost = n => `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${`site${String(n).padStart(2, '0')}`.padEnd(61, 'x')}`;
// Trust this site, Trust all websites and Allow once are the second button; Always allow on this site is the third.
const trusting = { showMessageBox: async options => ({ response: options.title === 'Share sensitive details?' ? 2 : 1 }) };

test('50 trusted sites with the longest host names, Always allow on each, and every other setting, survive a restart', async t => {
  const app = await desktop(t, { dialog: trusting });
  await app.invoke('createVault', { password: PASSWORD });
  await app.invoke('connectExtension', EXTENSION);
  await app.invoke('setLayaEnabled', false);
  assert.equal(longestHost(0).length, 253);
  const sites = Array.from({ length: 50 }, (_, n) => `https://${longestHost(n)}`);
  for (const site of sites) assert.deepEqual(plain(await app.request({ type: 'trustSite', url: `${site}/apply` })), { trusted: true, origin: site });
  // Fill sensitive details (#176) asks for the SSN Autofill held back on each site.
  for (const site of sites) await app.request({ type: 'getFields', url: `${site}/apply`, fields: ['ssn'], sensitive: true });
  await app.invoke('setAutofillTrust', true);
  assert.deepEqual(plain(await app.request({ type: 'trustAllSites' })), { allSites: true });
  assert.ok((await fsp.stat(path.join(app.userData, 'settings.json'))).size > 26000, 'the largest settings.json SecondHand can write');

  const restarted = await desktop(t, { userData: app.userData });
  const status = await restarted.invoke('status');
  assert.equal(status.settingsNotice, null);
  assert.deepEqual(plain(status.trustedSites), sites);
  assert.deepEqual(plain(status.alwaysAllowedSites), sites);
  assert.equal(status.extensionId, EXTENSION);
  assert.equal(status.autofillWithoutAsking, true);
  assert.equal(status.allSites, true);
  assert.equal(status.laya.state, 'off');
});

test('a site whose host name is longer than DNS allows can’t be trusted', async t => {
  const app = await desktop(t, { dialog: trusting });
  await app.invoke('createVault', { password: PASSWORD });
  await app.invoke('connectExtension', EXTENSION);
  const tooLong = `https://${longestHost(0)}x/apply`;
  await assert.rejects(app.request({ type: 'trustSite', url: tooLong }), error => error.publicMessage === 'This site’s address is too long for SecondHand to trust.');
  assert.deepEqual(app.dialogs, [], 'nothing is asked');
  assert.deepEqual(plain((await app.invoke('status')).trustedSites), []);
});
