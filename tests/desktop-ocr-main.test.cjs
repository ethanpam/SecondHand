'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const ID = 'b1be3de2-8bcc-4f07-94a6-f534f0b34047';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function desktop() {
  let invoke, window, picker = 0, readerOptions, unlocked = true;
  const canceled = [], reads = [], appEvents = new Map(), powerEvents = new Map();
  class Vault {
    async exists() { return true; } async inspect() { return {}; }
    get unlocked() { return unlocked; } async lock() { unlocked = false; }
  }
  class BrowserWindow {
    constructor() { window = this; this.webContents = { mainFrame: { url: pathToFileURL(path.join(root, 'renderer/index.html')).href },
      setWindowOpenHandler() {}, on() {}, send() {} }; }
    isDestroyed() { return false; } show() {} focus() {} setMenuBarVisibility() {} once() {} on() {} loadFile() {}
  }
  const laya = { status: async () => ({ state: 'off' }), setEnabled: async () => {}, startUpdates() {}, close: async () => {} };
  const app = { isPackaged: false, setName() {}, setPath() {}, getPath: () => '/synthetic-ocr-only', requestSingleInstanceLock: () => true,
    whenReady: async () => {}, on: (name, callback) => appEvents.set(name, callback), quit() {} };
  const overrides = {
    electron: { app, BrowserWindow, ipcMain: { handle(_name, callback) { invoke = callback; } }, dialog: {
      showOpenDialog: async () => { picker++; return { canceled: true, filePaths: [] }; }, showErrorBox: () => assert.fail('Startup failed') },
      shell: {}, clipboard: {}, powerMonitor: { on: (name, callback) => powerEvents.set(name, callback) },
      session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } },
    'node:fs/promises': { mkdir: async () => {}, stat: async () => ({ size: 2 }), readFile: async () => '{}' },
    './vault.cjs': { Vault }, './laya.cjs': { createLaya: () => laya },
    './field-suggestions.cjs': { createFieldSuggestions: () => ({}) }, './field-answers.cjs': { createFieldAnswers: () => ({}) },
    './extension-setup.cjs': { getExtensionSetup: async () => ({}) }, './test-storage-path.cjs': { testStoragePath: () => null },
    './bridge.cjs': { ...require('../desktop/bridge.cjs'), startBridge: async () => ({ close: async () => {} }) },
    './ocr-service.cjs': { createDocumentReader: options => {
      readerOptions = options;
      return { read: async id => { reads.push(id); await options.chooseFile(); return { cancelled: true }; }, cancel: id => { canceled.push(id); return true; } };
    } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8'), {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name.startsWith('.') ? path.join(root, 'desktop', name) : name),
    __dirname: path.join(root, 'desktop'), process: { platform: 'darwin', env: {}, argv: [] }, setTimeout: () => 1, clearTimeout() {}, Buffer
  });
  await tick();
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { invoke: (method, ...args) => invoke(event(), method, ...args), raw: (fake, method, ...args) => invoke(fake, method, ...args),
    event, canceled, reads, get picker() { return picker; }, get unlocked() { return readerOptions.isUnlocked(); },
    async lock() { powerEvents.get('lock-screen')(); await tick(); }, quit() { appEvents.get('before-quit')({ preventDefault() {} }); } };
}

test('document IPC uses the exact desktop frame, a native picker, and rejects a locked vault', async () => {
  const app = await desktop();
  const event = app.event();
  await assert.rejects(app.raw({ ...event, senderFrame: { url: 'https://example.invalid' } }, 'readDocument', ID), /Request denied/);
  await assert.rejects(app.raw({ ...event, sender: {} }, 'readDocument', ID), /Request denied/);
  await assert.rejects(app.invoke('readDocument', ID, '/arbitrary/file.pdf'), /Request denied/);
  assert.equal(app.picker, 0);
  assert.equal((await app.invoke('readDocument', ID)).cancelled, true);
  assert.equal(app.picker, 1); assert.deepEqual(app.reads, [ID]);
  await app.lock();
  assert.equal(app.unlocked, false);
  await assert.rejects(app.invoke('readDocument', ID), /Unlock/);
  assert.equal(app.picker, 1);
});

test('vault lock/quit cancel the document reader and client cancellation requires a correlation ID', async () => {
  const app = await desktop();
  await assert.rejects(app.invoke('cancelDocumentRead'), /document request is invalid/);
  await assert.rejects(app.invoke('cancelDocumentRead', '/private/file'), /document request is invalid/);
  assert.equal(await app.invoke('cancelDocumentRead', ID), true);
  await app.lock(); app.quit();
  assert.deepEqual(app.canceled, [ID, undefined, undefined]);
});
