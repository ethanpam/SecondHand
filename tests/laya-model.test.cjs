'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { validateManifest, ModelStore, MODEL_FILES } = require('../desktop/laya-model.cjs');

const revision = 'a'.repeat(40);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const wait = (condition, what) => new Promise((resolve, reject) => {
  const started = Date.now();
  const check = () => {
    if (condition()) resolve();
    else if (Date.now() - started > 5000) reject(new Error(`Timed out waiting for ${what}`));
    else setTimeout(check, 5);
  };
  check();
});

// Synthetic model files: random bytes for the graph and weights, small text for the rest.
function fixtureFiles() {
  return Object.fromEntries(MODEL_FILES.map(name => [name, name === 'model.onnx.data' ? crypto.randomBytes(256 * 1024) : Buffer.from(`synthetic ${name}\n`)]));
}

// A local server for the fixture files. `serve` can be replaced per test to misbehave.
async function server(t, files) {
  const requests = [];
  const state = { serve: null };
  const instance = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1));
    requests.push({ name, range: request.headers.range });
    if (state.serve && state.serve(name, request, response) !== false) return;
    const bytes = files[name];
    if (!bytes) { response.writeHead(404).end(); return; }
    const range = /^bytes=(\d+)-$/.exec(request.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      response.writeHead(206, { 'Content-Length': bytes.length - start, 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` }).end(bytes.subarray(start));
    } else response.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  const base = `http://127.0.0.1:${instance.address().port}`;
  const model = { revision, files: MODEL_FILES.map(name => ({ path: name, url: `${base}/${name}`, size: files[name].length, sha256: sha256(files[name]) })) };
  return { requests, state, base, model };
}

function userData(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-laya-model-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('an empty manifest means no model is available; a model entry is checked strictly', () => {
  assert.equal(validateManifest({ version: 1, model: null }).model, null);
  const model = { revision, files: MODEL_FILES.map(name => ({ path: name, url: `https://huggingface.co/example/laya/resolve/${revision}/${name}`, size: 10, sha256: 'b'.repeat(64) })) };
  assert.equal(validateManifest({ version: 1, model }).model.sizeBytes, 10 * MODEL_FILES.length);
  const broken = [
    [{ version: 2, model: null }, /version/],
    [{ version: 1 }, /model/],
    [{ version: 1, model: { ...model, revision: 'main' } }, /revision/],
    [{ version: 1, model: { ...model, files: model.files.slice(1) } }, /model\.onnx/],
    [{ version: 1, model: { ...model, files: [...model.files, { ...model.files[0], path: '../escape' }] } }, /path/],
    [{ version: 1, model: { ...model, files: [...model.files, model.files[0]] } }, /once/],
    [{ version: 1, model: { ...model, files: [{ ...model.files[0], url: 'http://example.org/model.onnx' }, ...model.files.slice(1)] } }, /https/],
    [{ version: 1, model: { ...model, files: [{ ...model.files[0], url: 'https://user:secret@example.org/model.onnx' }, ...model.files.slice(1)] } }, /credentials/],
    [{ version: 1, model: { ...model, files: [{ ...model.files[0], sha256: 'xyz' }, ...model.files.slice(1)] } }, /SHA-256/],
    [{ version: 1, model: { ...model, files: [{ ...model.files[0], size: 1.5 }, ...model.files.slice(1)] } }, /size/]
  ];
  for (const [manifest, message] of broken) assert.throws(() => validateManifest(manifest), message, JSON.stringify(manifest).slice(0, 120));
  // Loopback http never leaves the computer; the pinned SHA-256 still decides what is accepted.
  const local = { ...model, files: [{ ...model.files[0], url: 'http://127.0.0.1:9/model.onnx' }, ...model.files.slice(1)] };
  assert.equal(validateManifest({ version: 1, model: local }).model.files[0].url, 'http://127.0.0.1:9/model.onnx');
});

test('a download is verified, stored under models/laya/<revision>/, reports progress, and replaces older revisions', async t => {
  const files = fixtureFiles();
  const { model } = await server(t, files);
  const directory = userData(t);
  const old = path.join(directory, 'models/laya', 'c'.repeat(40));
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'model.onnx'), 'older revision');
  const store = new ModelStore({ userDataDir: directory, model: validateManifest({ version: 1, model }).model });
  assert.deepEqual(await store.state(), { state: 'not-downloaded', progress: 0 });
  await store.startDownload();
  assert.deepEqual(await store.state(), { state: 'ready' });
  assert.equal(store.directory, path.join(directory, 'models/laya', revision));
  for (const name of MODEL_FILES) assert.deepEqual(fs.readFileSync(path.join(store.directory, name)), files[name]);
  assert.equal(fs.readdirSync(store.directory).some(name => name.endsWith('.partial')), false);
  assert.equal(fs.existsSync(old), false, 'the older revision is removed after a good download');
  assert.equal(await store.verify(), store.directory);
});

test('a tampered download is rejected with a clear message and deleted', async t => {
  const files = fixtureFiles();
  const { model, state } = await server(t, files);
  state.serve = (name, _request, response) => {
    if (name !== 'model.onnx.data') return false;
    const bytes = Buffer.from(files[name]);
    bytes[100] ^= 0xff;
    response.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
  };
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  await store.startDownload();
  const status = await store.state();
  assert.equal(status.state, 'error');
  assert.match(status.message, /didn’t match its expected checksum, so SecondHand deleted it/);
  assert.equal(fs.existsSync(path.join(store.directory, 'model.onnx.data')), false);
  assert.equal(fs.existsSync(path.join(store.directory, 'model.onnx.data.partial')), false);
});

test('a partial download (the connection ends early) is rejected with a clear message and deleted', async t => {
  const files = fixtureFiles();
  const { model, state } = await server(t, files);
  state.serve = (name, _request, response) => {
    if (name !== 'model.onnx.data') return false;
    response.writeHead(200, { 'Content-Length': files[name].length });
    response.write(files[name].subarray(0, 1000), () => response.destroy());
  };
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  await store.startDownload();
  const status = await store.state();
  assert.equal(status.state, 'error');
  assert.match(status.message, /incomplete, so SecondHand deleted it/);
  assert.equal(fs.existsSync(path.join(store.directory, 'model.onnx.data.partial')), false);
});

test('a download larger than its pinned size is stopped and deleted', async t => {
  const files = fixtureFiles();
  const { model, state } = await server(t, files);
  state.serve = (name, _request, response) => {
    if (name !== 'tokenizer/tokenizer.json') return false;
    response.writeHead(200);
    response.end(Buffer.concat([files[name], Buffer.from('extra bytes')]));
  };
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  await store.startDownload();
  const status = await store.state();
  assert.equal(status.state, 'error');
  assert.match(status.message, /larger than expected, so SecondHand deleted it/);
  assert.equal(fs.existsSync(path.join(store.directory, 'tokenizer/tokenizer.json.partial')), false);
});

test('a server error is reported with its status, and redirects are followed', async t => {
  const files = fixtureFiles();
  const { model, state, base } = await server(t, files);
  state.serve = (name, _request, response) => {
    if (name === 'model.onnx') { response.writeHead(302, { Location: `${base}/moved/model.onnx` }).end(); return; }
    if (name === 'moved/model.onnx') { response.writeHead(200).end(files['model.onnx']); return; }
    if (name === 'rl_agent_config.json') { response.writeHead(503).end(); return; }
    return false;
  };
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  await store.startDownload();
  const status = await store.state();
  assert.equal(status.state, 'error');
  assert.match(status.message, /couldn’t be downloaded \(the server answered 503\)/);
  assert.deepEqual(fs.readFileSync(path.join(store.directory, 'model.onnx')), files['model.onnx'], 'the redirected file was saved');
});

test('cancel keeps the partial file, and the next download resumes from it with a Range request', async t => {
  const files = fixtureFiles();
  const { model, state, requests } = await server(t, files);
  const half = files['model.onnx.data'].length / 2;
  state.serve = (name, request, response) => {
    if (name !== 'model.onnx.data' || request.headers.range) return false;
    response.writeHead(200, { 'Content-Length': files[name].length });
    response.write(files[name].subarray(0, half)); // then stall until cancelled
  };
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  const download = store.startDownload();
  await wait(() => fs.existsSync(path.join(store.directory, 'model.onnx.data.partial')) &&
    fs.statSync(path.join(store.directory, 'model.onnx.data.partial')).size === half, 'the first half');
  const during = await store.state();
  assert.equal(during.state, 'downloading');
  assert.ok(during.progress > 0 && during.progress < 1);
  await store.cancel();
  await download;
  const paused = await store.state();
  assert.equal(paused.state, 'not-downloaded');
  assert.ok(Math.abs(paused.progress - during.progress) < 0.01);
  assert.equal(fs.statSync(path.join(store.directory, 'model.onnx.data.partial')).size, half);

  await store.startDownload();
  assert.deepEqual(await store.state(), { state: 'ready' });
  assert.equal(requests.filter(item => item.name === 'model.onnx.data').at(-1).range, `bytes=${half}-`);
  assert.equal(requests.filter(item => item.name === 'model.onnx').length, 1, 'finished files are not downloaded again');
  assert.deepEqual(fs.readFileSync(path.join(store.directory, 'model.onnx.data')), files['model.onnx.data']);
});

test('a server that ignores the Range request restarts the file from the beginning', async t => {
  const files = fixtureFiles();
  const { model, state } = await server(t, files);
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  fs.mkdirSync(store.directory, { recursive: true });
  fs.writeFileSync(path.join(store.directory, 'model.onnx.data.partial'), files['model.onnx.data'].subarray(0, 5000));
  state.serve = (name, _request, response) => {
    if (name !== 'model.onnx.data') return false;
    response.writeHead(200, { 'Content-Length': files[name].length }).end(files[name]);
  };
  await store.startDownload();
  assert.deepEqual(await store.state(), { state: 'ready' });
  assert.deepEqual(fs.readFileSync(path.join(store.directory, 'model.onnx.data')), files['model.onnx.data']);
});

test('files changed after the download fail verification before use and are deleted', async t => {
  const files = fixtureFiles();
  const { model } = await server(t, files);
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  await store.startDownload();
  const weights = path.join(store.directory, 'model.onnx.data');
  const bytes = fs.readFileSync(weights);
  bytes[0] ^= 1;
  fs.writeFileSync(weights, bytes);
  assert.deepEqual(await store.state(), { state: 'ready' }, 'status stays a cheap size check');
  await assert.rejects(store.verify(), /changed or damaged, so SecondHand deleted them/);
  assert.equal(fs.existsSync(store.directory), false);
  const status = await store.state();
  assert.equal(status.state, 'error');
  assert.match(status.message, /changed or damaged/);
  await store.startDownload();
  assert.deepEqual(await store.state(), { state: 'ready' }, 'downloading again clears the error');
});

test('remove deletes the downloaded model and any partial download', async t => {
  const files = fixtureFiles();
  const { model } = await server(t, files);
  const directory = userData(t);
  const store = new ModelStore({ userDataDir: directory, model: validateManifest({ version: 1, model }).model });
  await store.startDownload();
  fs.writeFileSync(path.join(store.directory, 'model.onnx.data.partial'), 'left over');
  await store.remove();
  assert.equal(fs.existsSync(path.join(directory, 'models/laya')), false);
  assert.deepEqual(await store.state(), { state: 'not-downloaded', progress: 0 });
  assert.ok(fs.existsSync(directory), 'the rest of userData stays');
});

test('only one download runs at a time', async t => {
  const files = fixtureFiles();
  const { model } = await server(t, files);
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  const first = store.startDownload();
  assert.equal(store.startDownload(), first);
  await first;
  assert.deepEqual(await store.state(), { state: 'ready' });
});

test('a saved part the server can no longer resume (416) is deleted, and the next download starts that file again', async t => {
  const files = fixtureFiles();
  const { model, state } = await server(t, files);
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  fs.mkdirSync(store.directory, { recursive: true });
  fs.writeFileSync(path.join(store.directory, 'model.onnx.data.partial'), files['model.onnx.data'].subarray(0, 5000));
  state.serve = (name, request, response) => {
    if (name !== 'model.onnx.data' || !request.headers.range) return false;
    response.writeHead(416).end();
  };
  await store.startDownload();
  const status = await store.state();
  assert.equal(status.state, 'error');
  assert.match(status.message, /incomplete, so SecondHand deleted it/);
  assert.equal(fs.existsSync(path.join(store.directory, 'model.onnx.data.partial')), false);
  await store.startDownload();
  assert.deepEqual(await store.state(), { state: 'ready' });
});

test('the shipped manifest pins the published model: its commit, Hugging Face URLs, and the sizes and SHA-256s in the model card', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../desktop/laya-model.json'), 'utf8'));
  const { model } = validateManifest(manifest);
  assert.ok(model, 'a model is published');
  for (const file of model.files) {
    assert.equal(file.url, `https://huggingface.co/JacobTDang/secondhand-laya/resolve/${model.revision}/${file.path}`, file.path);
  }
  const card = fs.readFileSync(path.join(__dirname, '../docs/laya-model.md'), 'utf8');
  const rows = new Map([...card.matchAll(/\| \`([^\`]+)\` \| ([\d,]+) \| \`([0-9a-f]{64})\` \|/g)].map(m => [m[1], { size: Number(m[2].replace(/,/g, '')), sha256: m[3] }]));
  for (const file of model.files) assert.deepEqual({ size: file.size, sha256: file.sha256 }, rows.get(file.path), file.path);
  assert.match(card, new RegExp(model.revision), 'the model card names the published commit');
});
