'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { PORTAL_URL } = require('../shared/schema.cjs');

const extensionId = 'a'.repeat(32);
const context = { extensionId };
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function desktop() {
  let bridge;
  let invoke;
  let window;
  let answer = async () => ({ response: 1 });
  const prompts = [];
  const notifications = [];
  const powerEvents = new Map();
  class Vault {
    constructor() { this.unlocked = true; this.data = { profile: { firstName: 'Synthetic', lastName: '' }, applications: [] }; }
    async exists() { return true; }
    async lock() { this.unlocked = false; }
    async unlock() { this.unlocked = true; }
    getData() { return this.data; }
    async update(change) { change(this.data); }
  }
  class BrowserWindow {
    constructor() {
      window = this;
      this.webContents = { mainFrame: { url: pathToFileURL(path.join(root, 'renderer/index.html')).href },
        setWindowOpenHandler() {}, on() {}, send(...args) { notifications.push(args); } };
    }
    show() {} focus() {} setMenuBarVisibility() {} once() {} on() {} loadFile() {}
    isDestroyed() { return false; }
  }
  const app = { isPackaged: false, setName() {}, setPath() {}, getPath: () => '/synthetic-local-data',
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on() {} };
  const electron = { app, BrowserWindow, ipcMain: { handle(_name, handler) { invoke = handler; } },
    dialog: { async showMessageBox(_parent, options) { prompts.push(options); return answer(); }, showErrorBox() { assert.fail('Desktop setup failed'); } },
    shell: {}, clipboard: {}, powerMonitor: { on(name, handler) { powerEvents.set(name, handler); } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } };
  const overrides = {
    electron,
    'node:fs/promises': { mkdir: async () => {}, stat: async () => ({ size: 10 }), readFile: async () => JSON.stringify({ extensionId }) },
    './vault.cjs': { Vault, atomicWrite: async () => {}, MAX_VAULT_BYTES: 1000 },
    './bridge.cjs': { ...require('../desktop/bridge.cjs'), startBridge: async (_directory, _getId, handler) => { bridge = handler; return { close: async () => {} }; } },
    './extension-setup.cjs': { getExtensionSetup: async () => ({ prepared: true }) },
    './registration.cjs': { registerHost: async () => ({}) },
    './test-storage-path.cjs': { testStoragePath: () => null }
  };
  vm.runInNewContext(source, {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name.startsWith('.') ? path.join(root, 'desktop', name) : name),
    __dirname: path.join(root, 'desktop'), process: { platform: process.platform, env: {}, argv: ['synthetic-electron'] },
    setTimeout: () => 1, clearTimeout() {}, Buffer
  });
  await tick();
  assert.equal(typeof bridge, 'function');
  return {
    prompts, notifications,
    answer: callback => { answer = callback; },
    request: request => bridge({ id: 'synthetic', url: PORTAL_URL, ...request }, context),
    invoke: (method, argument) => invoke({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, method, ...(argument === undefined ? [] : [argument])),
    async sleep() { powerEvents.get('suspend')(); await tick(); }
  };
}

test('renderer lock status and notifications identify each completed lock monotonically', async () => {
  const app = await desktop();
  assert.equal((await app.invoke('status')).lockRevision, 0);
  const first = await app.invoke('lock');
  assert.equal(first.lockRevision, 1);
  assert.equal(first.unlocked, false);
  assert.equal(app.notifications[0][0], 'secondhand:locked');
  assert.deepEqual(JSON.parse(JSON.stringify(app.notifications[0][1])), { lockRevision: 1 });
  assert.equal((await app.invoke('unlock', 'synthetic-passphrase')).lockRevision, 1);
  await app.sleep();
  assert.equal((await app.invoke('status')).lockRevision, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(app.notifications[1][1])), { lockRevision: 2 });
});

test('desktop requires one scoped guided consent and retains manual per-request consent', async () => {
  const app = await desktop();
  const grant = await app.request({ type: 'startAssistedSession', fields: ['firstName'] });
  assert.equal(app.prompts.length, 1);
  assert.deepEqual(await app.request({ type: 'checkAssistedSession', assistanceToken: grant.assistanceToken }), { active: true });
  assert.match(app.prompts[0].detail, /Next or Save and Continue/);
  assert.match(app.prompts[0].detail, /does not authorize consent, signatures, or submitting/);
  assert.equal((await app.request({ type: 'getFields', fields: ['firstName'], assistanceToken: grant.assistanceToken })).values.firstName, 'Synthetic');
  assert.equal(app.prompts.length, 1);
  await assert.rejects(app.request({ type: 'getFields', fields: ['lastName'], assistanceToken: grant.assistanceToken }), /not approved/);
  await assert.rejects(app.request({ type: 'getFields', fields: ['firstName'], assistanceToken: '0'.repeat(64) }), /ended/);
  assert.equal(app.prompts.length, 1, 'Invalid session must not fall back to a dialog');
  await app.request({ type: 'getFields', fields: ['firstName', 'lastName'] });
  assert.equal(app.prompts.length, 2);
});

test('desktop declines consent without granting and rejects stale approval after lock and unlock', async () => {
  const app = await desktop();
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request({ type: 'startAssistedSession', fields: ['firstName'] }), /cancelled/);
  let resolve;
  app.answer(() => new Promise(done => { resolve = done; }));
  const pending = app.request({ type: 'startAssistedSession', fields: ['firstName'] });
  await app.invoke('lock');
  await app.invoke('unlock', 'synthetic-passphrase');
  resolve({ response: 1 });
  await assert.rejects(pending, /changed/);
});

test('profile saves, manual lock, and system sleep revoke desktop guided grants', async () => {
  for (const action of ['saveProfile', 'lock', 'sleep']) {
    const app = await desktop();
    const grant = await app.request({ type: 'startAssistedSession', fields: ['firstName'] });
    if (action === 'saveProfile') await app.invoke(action, { firstName: 'Changed synthetic name' });
    else if (action === 'sleep') { await app.sleep(); await app.invoke('unlock', 'synthetic-passphrase'); }
    else { await app.invoke('lock'); await app.invoke('unlock', 'synthetic-passphrase'); }
    await assert.rejects(app.request({ type: 'getFields', fields: ['firstName'], assistanceToken: grant.assistanceToken }), /ended/);
    await assert.rejects(app.request({ type: 'checkAssistedSession', assistanceToken: grant.assistanceToken }), /ended/);
    assert.deepEqual(await app.request({ type: 'endAssistedSession', assistanceToken: grant.assistanceToken }), { ended: true });
  }
});

test('desktop session checks reject a locked vault without granting navigation or returning profile data', async () => {
  const app = await desktop();
  const grant = await app.request({ type: 'startAssistedSession', fields: ['firstName'] });
  await app.invoke('lock');
  await assert.rejects(app.request({ type: 'checkAssistedSession', assistanceToken: grant.assistanceToken }), /Unlock/);
  assert.deepEqual(await app.request({ type: 'endAssistedSession', assistanceToken: grant.assistanceToken }), { ended: true });
});

test('desktop releases explicit No choices but omits unknown answers from approved field scopes', async () => {
  const app = await desktop();
  await app.invoke('saveProfile', { programSnap: 'yes', programFip: 'no', hasHomeAddress: 'no', mailingSameAsHome: 'no', mailingAddressLine1: 'PO Box 123' });
  const fields = ['programSnap', 'programFip', 'programMedicaid', 'hasHomeAddress', 'mailingSameAsHome', 'mailingAddressLine1'];
  const grant = await app.request({ type: 'startAssistedSession', fields });
  const { values } = await app.request({ type: 'getFields', fields, assistanceToken: grant.assistanceToken });
  assert.equal(values.programSnap, 'yes');
  assert.equal(values.programFip, 'no');
  assert.equal(values.hasHomeAddress, 'no');
  assert.equal(values.mailingSameAsHome, 'no');
  assert.equal(values.mailingAddressLine1, 'PO Box 123');
  assert.equal(Object.hasOwn(values, 'programMedicaid'), false);
});
