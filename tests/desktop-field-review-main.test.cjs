'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Exercise the real IPC authorization and lifecycle while the model review is deferred.
async function desktop() {
  let invoke, window, unlocked = true;
  const calls = [], writes = [], events = new Map();
  class Vault {
    async exists() { return true; } async inspect() { return {}; }
    get unlocked() { return unlocked; }
    async lock() { unlocked = false; } async unlock() { unlocked = true; }
    async update(callback) { const data = { profile: {} }; callback(data); writes.push(data); }
  }
  class BrowserWindow {
    constructor() { window = this; this.webContents = { mainFrame: { url: pathToFileURL(path.join(root, 'renderer/index.html')).href },
      setWindowOpenHandler() {}, on() {}, send() {} }; }
    isDestroyed() { return false; } show() {} focus() {} setMenuBarVisibility() {} once() {} on() {} loadFile() {}
  }
  const laya = { status: async () => ({ state: 'off' }), setEnabled: async () => {}, startUpdates() {}, close: async () => {} };
  const app = { isPackaged: false, setName() {}, setPath() {}, getPath: () => '/synthetic-field-review', requestSingleInstanceLock: () => true,
    whenReady: async () => {}, on: (name, callback) => events.set(name, callback), quit() {} };
  const overrides = {
    electron: { app, BrowserWindow, ipcMain: { handle(_name, callback) { invoke = callback; } },
      dialog: { showErrorBox: () => assert.fail('Startup failed') }, shell: {}, clipboard: {}, powerMonitor: { on() {} },
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } },
    'node:fs/promises': { mkdir: async () => {}, stat: async () => ({ size: 2 }), readFile: async () => '{}' },
    './vault.cjs': { Vault }, './laya.cjs': { createLaya: () => laya },
    './touch-id.cjs': { touchIdPlatform: () => ({}), createTouchIdUnlock: () => ({
      state: async () => 'off', supported: () => false, passwordUnlocked: async () => {} }) },
    './field-suggestions.cjs': { createFieldSuggestions: () => ({}) }, './field-answers.cjs': { createFieldAnswers: () => ({}) },
    './field-review.cjs': { createFieldReview: options => {
      assert.equal(options.laya, laya);
      return { review: (request, context) => { const done = deferred(); calls.push({ request, context, done }); return done.promise; } };
    } },
    './extension-setup.cjs': { getExtensionSetup: async () => ({}) }, './test-storage-path.cjs': { testStoragePath: () => null },
    './bridge.cjs': { ...require('../desktop/bridge.cjs'), startBridge: async () => ({ close: async () => {} }) },
    './ocr-service.cjs': { createDocumentReader: () => ({ cancel() {} }) }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8'), {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name.startsWith('.') ? path.join(root, 'desktop', name) : name),
    __dirname: path.join(root, 'desktop'), process: { platform: 'darwin', env: {}, argv: [] }, setTimeout: () => 1, clearTimeout() {}, Buffer
  });
  await tick();
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { calls, writes, event, invoke: (method, ...args) => invoke(event(), method, ...args),
    raw: (fake, method, ...args) => invoke(fake, method, ...args), quit: () => events.get('before-quit')({ preventDefault() {} }) };
}

test('field review requires the unlocked desktop frame and cannot save data', async () => {
  const app = await desktop(), event = app.event();
  const request = { profile: { firstName: 'Synthetic' }, useLaya: false };
  for (const fake of [{ ...event, sender: {} }, { ...event, senderFrame: { url: event.senderFrame.url } },
    { ...event, senderFrame: { url: 'https://example.invalid/' } }]) {
    await assert.rejects(app.raw(fake, 'reviewFields', request), /Request denied/);
  }
  await assert.rejects(app.invoke('reviewFields', request, 'unexpected argument'), /Request denied/);
  assert.equal(app.calls.length, 0);
  const pending = app.invoke('reviewFields', request);
  assert.deepEqual(app.calls[0].request, request);
  assert.equal(app.calls[0].context.isCurrent(), true);
  const result = { profile: [], document: [], laya: { state: 'off' } };
  app.calls[0].done.resolve(result);
  assert.equal(await pending, result);
  assert.deepEqual(app.writes, []);
  await app.invoke('lock');
  await assert.rejects(app.invoke('reviewFields', request), /Unlock/);
  assert.equal(app.calls.length, 1);
});

test('lock, lock then unlock, edits, cancellation, superseding review and quit discard late results', async t => {
  for (const action of ['lock', 'lock-unlock', 'save', 'cancel', 'supersede', 'quit']) await t.test(action, async () => {
    const app = await desktop();
    const pending = app.invoke('reviewFields', { profile: {}, useLaya: true });
    const rejected = assert.rejects(pending, /information changed during review/);
    if (action === 'lock' || action === 'lock-unlock') await app.invoke('lock');
    if (action === 'lock-unlock') await app.invoke('unlock', 'synthetic-test-only');
    if (action === 'save') await app.invoke('saveProfile', { firstName: 'Changed' });
    if (action === 'cancel') await app.invoke('cancelFieldReview');
    if (action === 'quit') app.quit();
    let second;
    if (action === 'supersede') second = app.invoke('reviewFields', { profile: {}, useLaya: false });
    assert.equal(app.calls[0].context.isCurrent(), false);
    app.calls[0].done.resolve({ profile: [{ key: 'firstName', messages: ['stale'] }] });
    await rejected;
    if (second) { app.calls[1].done.resolve({ profile: [], document: [] }); await second; }
    if (action !== 'save') assert.deepEqual(app.writes, []);
  });
});
