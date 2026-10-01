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

// A local stand-in for the model repo (tests only): the model's files, and latest.json once
// `server.latest` is set (404 until then).
async function modelServer(t) {
  const files = modelFiles();
  const requests = [];
  const state = { latest: null };
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const bytes = request.url === '/latest.json' ? state.latest && Buffer.from(JSON.stringify(state.latest)) : files[decodeURIComponent(request.url.slice(1))];
    if (!bytes) response.writeHead(404).end(); else response.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { requests, state, updateUrl: `${base}/latest.json`, manifest: { version: 1, model: { revision: 'e'.repeat(40), format: 'noul-v1', files: MODEL_FILES.map(name => ({ path: name, url: `${base}/${name}`,
    size: files[name].length, sha256: crypto.createHash('sha256').update(files[name]).digest('hex') })) } } };
}

const until = async (condition, what) => {
  for (let attempt = 0; !(await condition()); attempt++) {
    if (attempt > 400) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

// The real main process with Electron simulated. Laya is the real runtime with a stub model
// runner (tests only). Its manifest and update URL are the test's local ones; only a test that
// keeps Laya off may use the shipped manifest (`shipped: true`), which points at Hugging Face.
async function desktop(t, { settings = { extensionId }, manifest, updateUrl = null, shipped = false, env = {}, unlocked = true, packaged = false } = {}) {
  assert.ok(manifest || shipped, 'Give the desktop a local manifest, or keep Laya off with the shipped one');
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
      const laya = realLaya.createLaya({ ...options, ...(manifest ? { manifest } : {}), updateUrl, runner, checkEveryMs: 60 * 60 * 1000 });
      created.push({ options, laya });
      t.after(() => laya.close());
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
const ready = async app => { await until(async () => (await app.invoke('layaStatus')).state === 'ready', 'Laya to be ready'); };
const off = { extensionId, layaEnabled: false };

test('a new install has Laya on: at startup, before any unlock, it checks for the newest model and downloads it in the background', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest, updateUrl: server.updateUrl, unlocked: false });
  assert.equal(app.created.length, 1, 'one Laya runtime for the app');
  assert.equal(app.created[0].options.userDataDir, app.userData);
  assert.equal(app.created[0].options.modelDir, undefined);
  assert.equal(app.created[0].options.updateUrl, 'https://huggingface.co/JacobTDang/secondhand-laya/resolve/main/latest.json');
  const started = await app.invoke('layaStatus');
  assert.equal(started.state, 'downloading');
  assert.equal(started.enabled, true);
  await ready(app);
  assert.equal(server.requests[0], '/latest.json', 'it checks for a newer model first');
  assert.deepEqual(server.requests.slice(1).sort(), MODEL_FILES.map(name => `/${name}`).sort());
  const status = await app.invoke('layaStatus');
  assert.deepEqual(plain(status.update), { state: 'error', message: 'Update check failed: the server answered 404.' }, 'no latest.json: the shipped model, and a note');
  assert.deepEqual(fs.readdirSync(path.join(app.userData, 'models/laya')).sort(), ['e'.repeat(40), 'installed.json']);
  assert.equal(app.runner.loads, 0, 'the download does not load the model');
  assert.deepEqual(app.writes, [], 'no choice was made, so none is saved');
});

test('an applicant who turned Laya off stays off: startup checks, downloads, and loads nothing', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest, updateUrl: server.updateUrl, settings: off });
  const status = await app.invoke('status');
  assert.equal(status.laya.state, 'off');
  assert.equal(status.laya.enabled, false);
  assert.deepEqual(plain(await app.invoke('layaStatus')), plain(status.laya));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(app.runner.loads, 0);
  assert.deepEqual(server.requests, []);
  assert.equal(fs.existsSync(path.join(app.userData, 'models')), false);
});

test('the shipped manifest pins the published model, and the update URL is its Hugging Face repo’s latest.json', async t => {
  const app = await desktop(t, { shipped: true, settings: off });
  const status = await app.invoke('status');
  const manifest = require('../desktop/laya-model.json');
  assert.deepEqual(plain(status.laya), { state: 'off', enabled: false, sizeBytes: manifest.model.files.reduce((sum, file) => sum + file.size, 0) });
  assert.equal(app.created[0].options.manifest, manifest);
  assert.equal(app.created[0].options.updateUrl, 'https://huggingface.co/JacobTDang/secondhand-laya/resolve/main/latest.json');
  assert.equal(app.writes.length, 0);
  assert.equal(fs.existsSync(path.join(app.userData, 'models')), false);
});

test('turning Laya on is saved and checks for the newest model and downloads it in one click; turning it off is saved too', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest, updateUrl: server.updateUrl, settings: off });
  server.state.latest = server.manifest;
  const started = await app.invoke('setLayaEnabled', true);
  assert.ok(['downloading', 'ready'].includes(started.state), started.state);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: false, trustedSites: [], layaEnabled: true });
  await ready(app);
  assert.equal(server.requests[0], '/latest.json');
  assert.equal((await app.invoke('layaStatus')).update, undefined, 'the check found nothing newer');
  assert.equal(app.runner.loads, 0, 'the download does not load the model');
  const laya = app.created[0].laya;
  await laya.decide({ question: 'Name?', candidate: 'First name' }, { correct: DECISION });
  assert.equal(app.runner.loads, 1, 'desktop modules call laya.decide / decideBatch on the one instance');
  assert.equal((await app.invoke('setLayaEnabled', false)).state, 'off');
  assert.equal(app.runner.releases, 1);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: false, trustedSites: [], layaEnabled: false });
  await assert.rejects(app.invoke('setLayaEnabled', 'yes'), /Invalid setting/);
});

test('a choice that was never made stays unsaved when other settings are saved, and a saved one is kept', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest, updateUrl: server.updateUrl });
  await app.invoke('setAutofillTrust', true);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: true, trustedSites: [] });
  const chosen = await desktop(t, { manifest: server.manifest, updateUrl: server.updateUrl, settings: off });
  await chosen.invoke('setAutofillTrust', true);
  assert.deepEqual(chosen.writes.at(-1).json, { extensionId, autofillWithoutAsking: true, trustedSites: [], layaEnabled: false });
});

test('download, cancel, and remove are desktop actions that need SecondHand unlocked; remove also turns Laya off', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest, updateUrl: server.updateUrl });
  await ready(app);
  assert.ok(['downloading', 'ready'].includes((await app.invoke('downloadLaya')).state));
  await ready(app);
  assert.equal((await app.invoke('cancelLayaDownload')).state, 'ready');
  const removed = await app.invoke('removeLaya');
  assert.equal(removed.state, 'off');
  assert.equal(removed.enabled, false);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: false, trustedSites: [], layaEnabled: false }, 'so it isn’t downloaded again at the next start');
  assert.equal(fs.existsSync(path.join(app.userData, 'models/laya')), false);
  const locked = await desktop(t, { manifest: server.manifest, updateUrl: server.updateUrl, unlocked: false, settings: off });
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
  const app = await desktop(t, { shipped: true, env: { SECONDHAND_LAYA_MODEL_DIR: folder, SECONDHAND_LAYA_MODEL_FORMAT: 'choice-v2' } });
  assert.equal(app.created[0].options.modelDir, folder);
  assert.equal(app.created[0].options.modelFormat, 'choice-v2', 'SECONDHAND_LAYA_MODEL_FORMAT names its prompt format');
  assert.equal((await app.invoke('layaStatus')).state, 'ready');
  assert.equal(await app.created[0].laya.format(), 'choice-v2');
  await assert.rejects(app.invoke('downloadLaya'), /SECONDHAND_LAYA_MODEL_DIR/);
  assert.equal(fs.existsSync(path.join(app.userData, 'models')), false, 'nothing is downloaded');
  await assert.rejects(desktop(t, { shipped: true, env: { SECONDHAND_LAYA_MODEL_DIR: folder } }), /prompt format/, 'a folder without its format stops the app with the reason');
});

test('SECONDHAND_LAYA_UPDATE_URL points a development build at another latest.json', async t => {
  const app = await desktop(t, { shipped: true, settings: off, env: { SECONDHAND_LAYA_UPDATE_URL: 'http://127.0.0.1:9/latest.json' } });
  assert.equal(app.created[0].options.updateUrl, 'http://127.0.0.1:9/latest.json');
});

test('a packaged app ignores SECONDHAND_LAYA_MODEL_DIR and SECONDHAND_LAYA_UPDATE_URL: shipped builds only use verified downloads from the model repo', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-laya-folder-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest, updateUrl: server.updateUrl, packaged: true,
    env: { SECONDHAND_LAYA_MODEL_DIR: folder, SECONDHAND_LAYA_MODEL_FORMAT: 'noul-v1', SECONDHAND_LAYA_UPDATE_URL: 'http://127.0.0.1:9/latest.json' } });
  assert.equal(app.created[0].options.modelDir, undefined);
  assert.equal(app.created[0].options.modelFormat, undefined);
  assert.equal(app.created[0].options.updateUrl, 'https://huggingface.co/JacobTDang/secondhand-laya/resolve/main/latest.json');
  await ready(app);
});

test('quitting stops a download and releases the model', async t => {
  const server = await modelServer(t);
  const app = await desktop(t, { manifest: server.manifest, updateUrl: server.updateUrl });
  await ready(app);
  await app.created[0].laya.decide({ question: 'Name?', candidate: 'First name' }, { correct: DECISION });
  app.quit();
  for (let attempt = 0; app.runner.releases === 0 && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(app.runner.releases, 1);
});
