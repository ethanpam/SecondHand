'use strict';
// Harnesses the test files share: the Electron main process and jsdom pages with layout. Desktop modules
// and jsdom load only when a harness needs them.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');

// Values created inside a vm context or a jsdom window have that realm's prototypes; this copies them
// into this one as plain data.
const plain = value => JSON.parse(JSON.stringify(value));
// One turn of the event loop: promises settled before it have run their callbacks.
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
// Waits for `condition`, a turn of the event loop at a time (so a test may mock setTimeout), up to 5 seconds:
// reading the disk can take hundreds of turns on a busy machine.
async function until(condition, what) {
  const end = performance.now() + 5000;
  while (!(await condition())) {
    if (performance.now() > end) assert.fail(`Timed out waiting for ${what}`);
    await tick();
  }
}

// A repository file, by its path from the repository root.
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// jsdom has no layout engine. `layout` gives every element now in the document the same visible,
// in-viewport box; a test that needs one off screen or hidden overrides it on that element.
const BOX = { left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 };
function layout(document) {
  for (const node of document.querySelectorAll('*')) { node.getBoundingClientRect = () => BOX; node.getClientRects = () => [BOX]; }
  return document;
}
// The same box for every element of the window, now and later; an element's getClientRects follows its own
// getBoundingClientRect.
function layoutElements(window) {
  window.Element.prototype.getBoundingClientRect = () => ({ ...BOX });
  window.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  return window.document;
}
// A jsdom document of `markup` at `url`, laid out by `layout`. Markup without a doctype goes inside <body>.
function laidOut(markup, url) {
  const { JSDOM } = require('jsdom');
  return layout(new JSDOM(/^<!doctype/i.test(markup) ? markup : `<!doctype html><body>${markup}</body>`, { url, pretendToBeVisual: true }).window.document);
}

// desktop/main.cjs, run as Electron runs it, with Electron simulated. A test file says what differs:
//   userData        the folder app.getPath gives
//   packaged        app.isPackaged
//   platform, env   what main.cjs sees as process.platform and process.env
//   electron        replaces parts of the simulated Electron module (safeStorage, shell, clipboard, ...);
//                   `dialog` adds to its dialog, whose showErrorBox fails the test
//   modules         replaces modules main.cjs requires, by the name it requires them with
//   globals         more of the main process's globals, such as Date
// The main process's timers are kept, never run, until a test runs one. It resolves once main.cjs has
// finished starting: its window is open and it listens for the screen locking.
async function startMain({ userData, packaged = false, platform = process.platform, env = {}, electron = {}, dialog = {}, modules = {}, globals = {} } = {}) {
  assert.ok(userData, 'Give the main process its data folder');
  let window, invoke, bridge, shows = 0;
  const sent = [];
  const appEvents = new Map();
  const powerEvents = new Map();
  // Every timer main.cjs sets, in order: { id, callback, ms, cleared }.
  const timers = [];
  class BrowserWindow {
    constructor() {
      window = this;
      this.webContents = { mainFrame: { url: pathToFileURL(path.join(root, 'renderer/index.html')).href },
        setWindowOpenHandler() {}, on() {}, send(...args) { sent.push(plain(args)); } };
    }
    show() { shows++; } focus() {} setMenuBarVisibility() {} once() {} on() {} loadFile() {}
    isDestroyed() { return false; }
  }
  const app = { isPackaged: packaged, setName() {}, setPath() {}, getPath: () => userData, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), on: (name, handler) => { appEvents.set(name, handler); }, quit() {} };
  const simulated = { app, BrowserWindow, ipcMain: { handle(_name, handler) { invoke = handler; } },
    dialog: { showErrorBox(title, message) { assert.fail(`The desktop showed an error: ${title}. ${message}`); }, ...dialog },
    shell: {}, clipboard: {}, powerMonitor: { on: (name, handler) => { powerEvents.set(name, handler); } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } },
    // A Mac without Touch ID; tests/desktop-touch-id-main.test.cjs covers Touch ID.
    systemPreferences: { canPromptTouchID: () => false },
    ...electron };
  runMain({
    electron: simulated,
    // No test reaches the real Chrome: the native host registration and the bridge's socket are stand-ins.
    './bridge.cjs': { ...require('../../desktop/bridge.cjs'), startBridge: async (_directory, _getId, handler) => { bridge = handler; return { close: async () => {} }; } },
    './extension-setup.cjs': { getExtensionSetup: async () => ({ prepared: true }) },
    './registration.cjs': { registerHost: async () => ({}) },
    './test-storage-path.cjs': { testStoragePath: () => null },
    ...modules
  }, {
    process: { platform, env, argv: ['synthetic-electron'] },
    setTimeout: (callback, ms) => { timers.push({ id: timers.length + 1, callback, ms, cleared: false }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    ...globals
  });
  await until(() => powerEvents.has('lock-screen'), 'the desktop to finish starting');
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return {
    sent, timers, appEvents, powerEvents,
    get window() { return window; },
    get shows() { return shows; },
    event,
    // A request from the desktop's own window, and one from a sender a test makes up.
    invoke: (method, ...args) => invoke(event(), method, ...args),
    raw: (sender, method, ...args) => invoke(sender, method, ...args),
    // A request from the extension, through the bridge.
    bridge: (request, context) => bridge(request, context),
    quit: () => appEvents.get('before-quit')({ preventDefault() {} })
  };
}

// Electron's safeStorage with the operating system's protected storage simulated, so no Keychain item is
// touched: text is sealed as hex. `unsealing` runs before each decryption.
function safeStorage({ available = true, unsealing = () => {} } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('hex')}`),
    decryptString: bytes => {
      unsealing();
      const text = bytes.toString();
      if (!text.startsWith('sealed:')) throw new Error('Not sealed by this computer.');
      return Buffer.from(text.slice(7), 'hex').toString();
    }
  };
}

// Runs desktop/main.cjs in its own vm context. `modules` replaces modules it requires, by name; the rest
// are the real ones. `globals` are the context's globals besides require, __dirname and Buffer.
function runMain(modules, globals) {
  return vm.runInNewContext(read('desktop/main.cjs'), {
    require: name => Object.hasOwn(modules, name) ? modules[name] : require(name.startsWith('.') ? path.join(root, 'desktop', name) : name),
    __dirname: path.join(root, 'desktop'), Buffer, ...globals
  });
}

module.exports = { root, plain, tick, deferred, until, read, BOX, layout, layoutElements, laidOut, startMain, runMain, safeStorage };
