'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { LIMITS, fault, documentKind, progress, validatePages } = require('./ocr-limits.cjs');
const ORIGIN = 'https://secondhand-ocr.invalid';
const CHANNEL = 'secondhand:ocr-worker';
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src blob: data:; font-src 'self' blob:; style-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.bcmap': 'application/octet-stream', '.gz': 'application/octet-stream', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.icc': 'application/octet-stream' };

async function assetMap(directory) {
  let manifest;
  try {
    if ((await fs.stat(path.join(directory, 'manifest.json'))).size > 256000) throw fault('ASSETS');
    manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  } catch { throw fault('ASSETS'); }
  if (manifest.version !== 1 || !manifest.assets || typeof manifest.assets !== 'object') throw fault('ASSETS');
  const files = new Map([
    ['/index.html', { file: path.join(__dirname, 'ocr.html') }],
    ['/runtime.mjs', { file: path.join(__dirname, 'ocr-runtime.mjs') }]
  ]);
  for (const [relative, metadata] of Object.entries(manifest.assets)) {
    if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') ||
        !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > 40 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw fault('ASSETS');
    files.set(`/assets/${relative}`, { file: path.join(directory, relative), ...metadata });
  }
  if (!files.has('/assets/language/eng.traineddata.gz') || !files.has('/assets/pdf/pdf.mjs') || !files.has('/assets/tesseract/tesseract.min.js')) throw fault('ASSETS');
  return files;
}
function assetPath(rawUrl, files) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash) return null;
    return files.get(url.pathname) || null;
  } catch { return null; }
}

// The renderer has no Node APIs and is destroyed after a single operation. Its
// HTTPS origin is virtual: this session handles every asset locally and rejects
// all other traffic. It cannot fetch the selected file or arbitrary local paths.
function createOcrEngine({ BrowserWindow, session, ipcMain, assetsDirectory }) {
  let window = null;
  let finish = null;
  let cancelled = false;
  let used = false;
  function cancel() { cancelled = true; if (finish) finish(fault('CANCELLED')); else if (window && !window.isDestroyed()) window.destroy(); }
  async function read(bytes, { signal, onProgress = () => {} } = {}) {
    if (used) throw fault('BUSY');
    used = true;
    const format = documentKind(bytes);
    const files = await assetMap(assetsDirectory);
    if (cancelled || signal?.aborted) throw fault('CANCELLED');
    const partition = `secondhand-ocr-${crypto.randomUUID()}`;
    const isolated = session.fromPartition(partition, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', event => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const localWorker = details.url.startsWith(`blob:${ORIGIN}/`);
      callback({ cancel: !localWorker && !assetPath(details.url, files) });
    });
    await isolated.protocol.handle('https', async request => {
      const asset = request.method === 'GET' && assetPath(request.url, files);
      if (!asset) return new Response(null, { status: 403 });
      try {
        const content = await fs.readFile(asset.file);
        if (asset.bytes !== undefined && (content.length !== asset.bytes || crypto.createHash('sha256').update(content).digest('hex') !== asset.sha256)) throw fault('ASSETS');
        return new Response(content, { headers: { 'Content-Type': MIME[path.extname(asset.file)] || 'application/octet-stream',
          'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      } catch { return new Response(null, { status: 404 }); }
    });
    if (cancelled || signal?.aborted) { isolated.protocol.unhandle('https'); throw fault('CANCELLED'); }
    window = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: {
      preload: path.join(__dirname, 'ocr-preload.cjs'), session: isolated, nodeIntegration: false,
      nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true,
      spellcheck: false, backgroundThrottling: false, devTools: false
    } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    return new Promise((resolve, reject) => {
      let settled = false;
      let started = false;
      const aborted = () => cancel();
      const timer = setTimeout(() => finish(fault('TIMEOUT')), LIMITS.timeoutMs);
      const receive = (event, type, payload) => {
        if (settled || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== `${ORIGIN}/index.html`) return;
        if (type === 'ready' && !started) {
          started = true;
          // Electron serializes these bytes; the renderer gets no filesystem path.
          window.webContents.send(CHANNEL, { bytes: new Uint8Array(bytes), format, limits: LIMITS });
        } else if (type === 'progress' && started) {
          const clean = progress(payload);
          if (clean) onProgress(clean);
        } else if (type === 'complete' && started) {
          try { finish(null, validatePages(payload)); } catch (error) { finish(error); }
        } else if (type === 'error') finish(fault(payload));
      };
      finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        ipcMain.removeListener(CHANNEL, receive);
        if (window && !window.isDestroyed()) window.destroy();
        window = null;
        isolated.protocol.unhandle('https');
        // The nonpersistent partition has no document storage; clear any browser
        // implementation caches after the renderer and its workers are gone.
        Promise.allSettled([isolated.clearCache(), isolated.clearStorageData()]).catch(() => {});
        finish = null;
        if (error) reject(error); else resolve(result);
      };
      ipcMain.on(CHANNEL, receive);
      signal?.addEventListener('abort', aborted, { once: true });
      window.webContents.once('render-process-gone', () => finish?.(fault('READ_FAILED')));
      window.once('closed', () => finish?.(fault('CANCELLED')));
      window.loadURL(`${ORIGIN}/index.html`).catch(() => finish?.(fault('ASSETS')));
      if (signal?.aborted || cancelled) cancel();
    });
  }
  return { read, cancel };
}
module.exports = { createOcrEngine, assetMap, assetPath, ORIGIN };
