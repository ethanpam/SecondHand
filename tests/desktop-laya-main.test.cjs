'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const realLaya = require('../desktop/laya.cjs');
const { MODEL_FILES } = require('../desktop/laya-model.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const extensionId = 'a'.repeat(32);
const plain = value => JSON.parse(JSON.stringify(value));
const small = path.join(__dirname, 'fixtures/laya/small-tokenizer');
const DECISION = { type: 'noul', instructions: 'Is the candidate the correct answer?' };

function modelFiles() {
  return {
    'model.onnx': Buffer.from('synthetic graph'), 'model.onnx.data': crypto.randomBytes(2048),
    'tokenizer/tokenizer.json': fs.readFileSync(path.join(small, 'tokenizer.json')),
    'tokenizer/tokenizer_config.json': fs.readFileSync(path.join(small, 'tokenizer_config.json')),
    'rl_agent_config.json': Buffer.from(JSON.stringify({ max_len: 512, head_max_len: 192, temperature: [1, 1, 1.5] }))
  };
}

async function modelServer(t) {
  const files = modelFiles();
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const bytes = files[decodeURIComponent(request.url.slice(1))];
    if (!bytes) response.writeHead(404).end(); else response.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { requests, manifest: { version: 1, model: { revision: 'e'.repeat(40), files: MODEL_FILES.map(name => ({ path: name, url: `${base}/${name}`,
    size: files[name].length, sha256: crypto.createHash('sha256').update(files[name]).digest('hex') })) } } };
}

// The real main process with Electron simulated. Laya is the real runtime with a stub model
// runner (tests only), and the manifest is swapped for a local test one when given.
async function desktop(t, { settings = { extensionId }, manifest, env = {}, unlocked = true, packaged = false } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-laya-main-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  let invoke;
  let window;
  let quit;
  const writes = [];
  const runner = { loads: 0, releases: 0, async load() { runner.loads++; return {
    async run(batch) { return { data: new Float32Array(batch.rows * batch.count), dims: [batch.rows, batch.count] }; },
    async release() { runner.releases++; } }; } };
  const created = [];
  class Vault {
    constructor() { this.unlocked = unlocked; this.data = { profile: {}, applications: [] }; }
    async exists() { return true; }
    async inspect() { return { recoveryKey: true }; }
    async lock() { this.unlocked = false; }
    getData() { return this.data; }
  }
  class BrowserWindow {
    constructor() {
      window = this;
      this.webContents = { mainFrame: { url: pathToFileURL(path.join(root, 'renderer/index.html')).href }, setWindowOpenHandler() {}, on() {}, send() {} };
    }
    show() {} focus() {} setMenuBarVisibility() {} once() {} on() {} loadFile() {}
    isDestroyed() { return false; }
  }
  const app = { isPackaged: packaged, setName() {}, setPath() {}, getPath: () => userData, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), on(name, handler) { if (name === 'before-quit') quit = handler; }, quit() {} };
  const electron = { app, BrowserWindow, ipcMain: { handle(_name, handler) { invoke = handler; } },
    dialog: { showErrorBox() { assert.fail('Desktop setup failed'); } }, shell: {}, clipboard: {}, powerMonitor: { on() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } };
  const overrides = {
    electron,
    './vault.cjs': { ...require('../desktop/vault.cjs'), Vault, atomicWrite: async (file, bytes) => { writes.push({ file, json: JSON.parse(bytes.toString()) }); } },
    './bridge.cjs': { ...require('../desktop/bridge.cjs'), startBridge: async () => ({ close: async () => {} }) },
    './extension-setup.cjs': { getExtensionSetup: async () => ({ prepared: true }) },
    './registration.cjs': { registerHost: async () => ({}) },
    './test-storage-path.cjs': { testStoragePath: () => null },
    './laya.cjs': { ...realLaya, createLaya: options => {
      const laya = realLaya.createLaya({ ...options, ...(manifest ? { manifest } : {}), runner });
      created.push({ options, laya });
      return laya;
    } }
  };
  vm.runInNewContext(source, {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name.startsWith('.') ? path.join(root, 'desktop', name) : name),
    __dirname: path.join(root, 'desktop'), process: { platform: process.platform, env, argv: ['synthetic-electron'] },
    setTimeout: () => 1, clearTimeout() {}, Buffer
  });
  for (let attempt = 0; !invoke && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(invoke, 'The desktop did not finish starting');
  return {
    userData, writes, runner, created,
    invoke: (method, argument) => invoke({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, method, ...(argument === undefined ? [] : [argument])),
    quit: () => quit({ preventDefault() {} })
  };
}

test('with the toggle off, startup reads, downloads, and loads nothing for Laya', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest });
  assert.equal(app.created.length, 1, 'one Laya runtime for the app');
  assert.equal(app.created[0].options.userDataDir, app.userData);
  assert.equal(app.created[0].options.modelDir, undefined);
  const status = await app.invoke('status');
  assert.equal(status.laya.state, 'off');
  assert.equal(status.laya.enabled, false);
  assert.deepEqual(plain(await app.invoke('layaStatus')), plain(status.laya));
  assert.equal(app.runner.loads, 0);
  assert.deepEqual(server.requests, []);
  assert.equal(fs.existsSync(path.join(app.userData, 'models')), false);
});

test('the shipped manifest pins the published model, and with Laya off nothing is downloaded', async t => {
  const app = await desktop(t);
  const status = await app.invoke('status');
  const manifest = require('../desktop/laya-model.json');
  assert.deepEqual(plain(status.laya), { state: 'off', enabled: false, sizeBytes: manifest.model.files.reduce((sum, file) => sum + file.size, 0) });
  assert.equal(app.writes.length, 0);
  assert.equal(fs.existsSync(path.join(app.userData, 'models')), false);
});

test('turning Laya on is saved, starts the download in one click, and turning it off is saved too', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest });
  const started = await app.invoke('setLayaEnabled', true);
  assert.ok(['downloading', 'ready'].includes(started.state), started.state);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: false, trustedSites: [], layaEnabled: true });
  for (let attempt = 0; (await app.invoke('layaStatus')).state !== 'ready' && attempt < 400; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await app.invoke('layaStatus')).state, 'ready');
  assert.equal(app.runner.loads, 0, 'the download does not load the model');
  const laya = app.created[0].laya;
  await laya.decide({ question: 'Name?', candidate: 'First name' }, { correct: DECISION });
  assert.equal(app.runner.loads, 1, 'desktop modules call laya.decide / decideBatch on the one instance');
  assert.equal((await app.invoke('setLayaEnabled', false)).state, 'off');
  assert.equal(app.runner.releases, 1);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: false, trustedSites: [], layaEnabled: false });
  await assert.rejects(app.invoke('setLayaEnabled', 'yes'), /Invalid setting/);
});

test('a saved toggle is restored at startup without loading or downloading anything', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest, settings: { extensionId, layaEnabled: true } });
  const status = await app.invoke('layaStatus');
  assert.deepEqual(plain(status), { state: 'not-downloaded', enabled: true, progress: 0, sizeBytes: status.sizeBytes });
  assert.deepEqual(server.requests, []);
  assert.equal(app.runner.loads, 0);
});

test('download, cancel, and remove are desktop actions that need SecondHand unlocked', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest, settings: { extensionId, layaEnabled: true } });
  await app.invoke('downloadLaya');
  for (let attempt = 0; (await app.invoke('layaStatus')).state !== 'ready' && attempt < 400; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await app.invoke('cancelLayaDownload')).state, 'ready');
  assert.equal((await app.invoke('removeLaya')).state, 'not-downloaded');
  assert.equal(fs.existsSync(path.join(app.userData, 'models/laya')), false);
  const locked = await desktop(t, { manifest: server.manifest, unlocked: false });
  for (const method of ['setLayaEnabled', 'downloadLaya', 'cancelLayaDownload', 'removeLaya']) {
    await assert.rejects(locked.invoke(method, method === 'setLayaEnabled' ? true : undefined), /Unlock SecondHand first/, method);
  }
});

test('SECONDHAND_LAYA_MODEL_DIR points Laya at a local model folder instead of a download', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-laya-folder-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(modelFiles())) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), bytes);
  }
  const app = await desktop(t, { env: { SECONDHAND_LAYA_MODEL_DIR: folder }, settings: { extensionId, layaEnabled: true } });
  assert.equal(app.created[0].options.modelDir, folder);
  assert.equal((await app.invoke('layaStatus')).state, 'ready');
  await assert.rejects(app.invoke('downloadLaya'), /SECONDHAND_LAYA_MODEL_DIR/);
});

test('a packaged app ignores SECONDHAND_LAYA_MODEL_DIR: shipped builds only load a verified download', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-laya-folder-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const app = await desktop(t, { env: { SECONDHAND_LAYA_MODEL_DIR: folder }, packaged: true, settings: { extensionId, layaEnabled: true } });
  assert.equal(app.created[0].options.modelDir, undefined);
});

test('quitting stops a download and releases the model', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest, settings: { extensionId, layaEnabled: true } });
  await app.invoke('downloadLaya');
  for (let attempt = 0; (await app.invoke('layaStatus')).state !== 'ready' && attempt < 400; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  await app.created[0].laya.decide({ question: 'Name?', candidate: 'First name' }, { correct: DECISION });
  app.quit();
  for (let attempt = 0; app.runner.releases === 0 && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(app.runner.releases, 1);
});
