'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createOcrEngine, ORIGIN } = require('../desktop/ocr-engine.cjs');
const CHANNEL = 'secondhand:ocr-worker';
const syntheticDocument = Buffer.from('%PDF-1.7\nsynthetic');

async function assets(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-damaged-ocr-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifest = { version: 1, assets: {} };
  for (const name of ['language/eng.traineddata.gz', 'pdf/pdf.mjs', 'tesseract/tesseract.min.js']) {
    const bytes = Buffer.from(`synthetic bundled asset: ${name}`);
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), bytes);
    manifest.assets[name] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return directory;
}

// Exercise the real engine/protocol handler and filesystem, with only Electron
// surfaces faked so queued IPC and file-read completion can be ordered exactly.
function runtime(directory) {
  const ipcMain = new EventEmitter();
  let handler, window, ready, clears = 0, unhandled = 0;
  const loaded = new Promise(resolve => { ready = resolve; });
  const isolated = {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {},
    webRequest: { onBeforeRequest() {} },
    protocol: { handle: async (_scheme, callback) => { handler = callback; }, unhandle: () => { unhandled++; } },
    clearCache: async () => { clears++; }, clearStorageData: async () => { clears++; }
  };
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); window = this; this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { mainFrame: { url: `${ORIGIN}/index.html` }, setWindowOpenHandler() {}, send() {} });
    }
    loadURL() { ready(); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const engine = createOcrEngine({ BrowserWindow, session: { fromPartition: () => isolated }, ipcMain, assetsDirectory: directory });
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { engine, loaded, ipcMain, event, get window() { return window; }, get clears() { return clears; }, get unhandled() { return unhandled; },
    fetch: relative => handler({ method: 'GET', url: `${ORIGIN}/assets/${relative}` }),
    emit: (type, payload) => ipcMain.emit(CHANNEL, event(), type, payload) };
}

test('malformed manifest roots, asset collections, and metadata report ASSETS before opening a window', async t => {
  const directory = await assets(t);
  const invalidShapes = [
    ...[null, [], 'not an object', 1, true].map(value => ['manifest root', value]),
    ...[null, [], 'not an object', 1, true].map(value => ['asset collection', { version: 1, assets: value }]),
    ...[null, [], 'not an object', 1, true, { bytes: 1, sha256: ['a'.repeat(64)] }]
      .map(value => ['asset metadata', { version: 1, assets: { 'pdf/pdf.mjs': value } }])
  ];
  for (const [shape, manifest] of invalidShapes) {
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    const host = runtime(directory);
    await assert.rejects(host.engine.read(syntheticDocument), {
      code: 'ASSETS', publicMessage: 'The local document reader is unavailable. Reinstall SecondHand and try again.'
    }, `${shape}: ${JSON.stringify(manifest)}`);
    assert.equal(host.window, undefined);
    assert.equal(host.ipcMain.listenerCount(CHANNEL), 0);
  }
});

for (const damage of ['missing', 'wrong hash']) {
  test(`a ${damage} bundled asset reports ASSETS before worker errors and discards late IPC`, async t => {
    const directory = await assets(t);
    const file = path.join(directory, 'language/eng.traineddata.gz');
    if (damage === 'missing') await fs.rm(file);
    else {
      const bytes = await fs.readFile(file); bytes[0] ^= 1;
      await fs.writeFile(file, bytes); // Same size, so this tests the hash check.
    }
    const host = runtime(directory), progress = [];
    const reading = host.engine.read(syntheticDocument, { onProgress: value => progress.push(value) });
    const rejected = assert.rejects(reading, error => {
      assert.equal(error.code, 'ASSETS');
      assert.equal(error.publicMessage, 'The local document reader is unavailable. Reinstall SecondHand and try again.');
      assert.doesNotMatch(error.publicMessage, /prepare|traineddata|synthetic|\/private|ENOENT/);
      return true;
    });
    await host.loaded;
    host.emit('ready');
    const queued = host.ipcMain.listeners(CHANNEL)[0], event = host.event();
    assert.equal((await host.fetch('language/eng.traineddata.gz')).status, 404);
    await rejected;
    // A callback queued before listener removal must also be harmless.
    queued(event, 'error', 'READ_FAILED');
    queued(event, 'progress', { phase: 'recognizing', page: 1, total: 1 });
    queued(event, 'complete', { pageCount: 1, pages: [{ text: 'late synthetic text' }] });
    assert.equal(host.window.isDestroyed(), true);
    assert.equal(host.ipcMain.listenerCount(CHANNEL), 0);
    assert.deepEqual(progress, []);
    assert.equal(host.clears, 2); assert.equal(host.unhandled, 1);
  });
}

test('cancellation stays final when a pending bundled-asset read fails afterward', async t => {
  const directory = await assets(t);
  await fs.rm(path.join(directory, 'pdf/pdf.mjs'));
  const host = runtime(directory);
  const reading = host.engine.read(syntheticDocument);
  const rejected = assert.rejects(reading, { code: 'CANCELLED' });
  await host.loaded;
  const pendingFetch = host.fetch('pdf/pdf.mjs');
  host.engine.cancel(); // Runs before the asynchronous missing-file read settles.
  await rejected;
  assert.equal((await pendingFetch).status, 404);
  assert.equal(host.window.isDestroyed(), true);
  assert.equal(host.ipcMain.listenerCount(CHANNEL), 0);
  assert.equal(host.unhandled, 1);
});
