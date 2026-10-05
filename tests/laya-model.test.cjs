'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { validateManifest, ModelStore, MODEL_FILES, MODEL_FORMATS, readInstalled, fetchManifest } = require('../desktop/laya-model.cjs');

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
  const model = { revision, format: 'noul-v1', files: MODEL_FILES.map(name => ({ path: name, url: `${base}/${name}`, size: files[name].length, sha256: sha256(files[name]) })) };
  return { requests, state, base, model };
}

function userData(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-laya-model-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('an empty manifest means no model is available; a model entry is checked strictly', () => {
  assert.equal(validateManifest({ version: 1, model: null }).model, null);
  const model = { revision, format: 'noul-v1', files: MODEL_FILES.map(name => ({ path: name, url: `https://huggingface.co/example/laya/resolve/${revision}/${name}`, size: 10, sha256: 'b'.repeat(64) })) };
  assert.equal(validateManifest({ version: 1, model }).model.sizeBytes, 10 * MODEL_FILES.length);
  assert.equal(validateManifest({ version: 1, model }).model.format, 'noul-v1');
  // A format the app doesn't know is still a valid manifest; whether to install it is the runtime's choice.
  assert.equal(validateManifest({ version: 1, model: { ...model, format: 'noul-v2' } }).model.format, 'noul-v2');
  const { format: _format, ...unformatted } = model;
  const broken = [
    [{ version: 2, model: null }, /version/],
    [{ version: 1 }, /model/],
    [{ version: 1, model: { ...model, revision: 'main' } }, /revision/],
    [{ version: 1, model: unformatted }, /format/],
    [{ version: 1, model: { ...model, format: 'Noul V1' } }, /format/],
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

test('a download is verified, stored under models/laya/<revision>/, and reports progress; other revisions stay until removed', async t => {
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
  assert.equal(await store.verify(), store.directory);
  assert.ok(fs.existsSync(old), 'a download leaves the model in use alone');
  assert.equal(await readInstalled(directory), null, 'nothing is recorded as installed yet');

  await store.install();
  assert.deepEqual(await readInstalled(directory), validateManifest({ version: 1, model }).model);
  const kept = path.join(directory, 'models/laya', 'e'.repeat(40));
  fs.mkdirSync(kept);
  await store.removeOthers(['e'.repeat(40)]);
  assert.equal(fs.existsSync(old), false, 'the older revision is removed');
  assert.ok(fs.existsSync(kept), 'a revision it is told to keep stays');
  assert.deepEqual(fs.readdirSync(path.join(directory, 'models/laya')).sort(), [revision, 'e'.repeat(40), 'installed.json'].sort());
});

test('installed.json names the installed model; a missing one means none, and a damaged one is refused with the reason', async t => {
  const directory = userData(t);
  assert.equal(await readInstalled(directory), null);
  fs.mkdirSync(path.join(directory, 'models/laya'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'models/laya/installed.json'), '{ not json');
  await assert.rejects(readInstalled(directory), /JSON/);
  fs.writeFileSync(path.join(directory, 'models/laya/installed.json'), JSON.stringify({ version: 1, model: { revision } }));
  await assert.rejects(readInstalled(directory), /manifest is invalid/);
});

test('the app runs the single-candidate noul-v1 prompts and the one-pass choice-v2 prompts', () => {
  assert.deepEqual([...MODEL_FORMATS], ['noul-v1', 'choice-v2']);
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

test('a download that fails before its partial file has opened deletes that file only once it is closed', async t => {
  const files = fixtureFiles();
  const { model, state } = await server(t, files);
  const name = 'tokenizer/tokenizer.json';
  state.serve = (requested, _request, response) => {
    if (requested !== name) return false;
    response.writeHead(200).end(Buffer.concat([files[name], Buffer.from('extra bytes')]));
  };
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  const partial = path.join(store.directory, `${name}.partial`);
  // A slow disk: the partial file's open waits until the test finishes it.
  const open = fs.open;
  let finishOpen = null;
  t.mock.method(fs, 'open', (file, flags, mode, callback) => {
    if (file !== partial) return open(file, flags, mode, callback);
    finishOpen = () => new Promise(resolve => open(file, flags, mode, (...results) => { callback(...results); resolve(); }));
  });
  const rm = fsp.rm;
  const removals = [];
  t.mock.method(fsp, 'rm', (file, options) => {
    const removal = rm(file, options);
    if (file === partial) removals.push(removal);
    return removal;
  });
  // The oversized answer fails the download; its response closes after the failure is handled.
  const get = http.get;
  let failed;
  const dropped = new Promise(resolve => { failed = resolve; });
  t.mock.method(http, 'get', (...args) => get(...args).on('response', response => { if (response.req.path === `/${name}`) response.once('close', failed); }));
  const download = store.startDownload();
  await dropped;
  assert.ok(finishOpen, 'the partial file is still opening');
  await Promise.all(removals);
  await finishOpen();
  await download;
  assert.match((await store.state()).message, /larger than expected, so SecondHand deleted it/);
  assert.equal(fs.existsSync(partial), false, 'the file that opened late was deleted after it closed');
});

test('a pause waits for the write in progress, so the resumed download starts where the partial file ends', async t => {
  const files = fixtureFiles();
  const { model, state } = await server(t, files);
  const name = 'model.onnx.data';
  // A small first part, so the download waits for more data while that part is written.
  const first = 1000;
  state.serve = (requested, request, response) => {
    if (requested !== name || request.headers.range) return false;
    response.writeHead(200, { 'Content-Length': files[name].length });
    response.write(files[name].subarray(0, first)); // then stall until paused
  };
  const store = new ModelStore({ userDataDir: userData(t), model: validateManifest({ version: 1, model }).model });
  const partial = path.join(store.directory, `${name}.partial`);
  // A slow disk: the first write to the partial file waits until the test finishes it.
  const open = fs.open;
  let partialFd = null;
  t.mock.method(fs, 'open', (file, flags, mode, callback) => open(file, flags, mode, (error, fd) => {
    if (file === partial) partialFd = fd;
    callback(error, fd);
  }));
  let finishWrite = null;
  let writing;
  const held = new Promise(resolve => { writing = resolve; });
  for (const method of ['write', 'writev']) {
    const original = fs[method];
    t.mock.method(fs, method, (fd, ...args) => {
      if (fd !== partialFd || finishWrite) return original(fd, ...args);
      finishWrite = () => original(fd, ...args);
      writing();
    });
  }
  // The paused response closes, and one more turn of the event loop lets the pause be handled.
  const get = http.get;
  let dropped;
  const droppedResponse = new Promise(resolve => { dropped = resolve; });
  t.mock.method(http, 'get', (...args) => get(...args).on('response', response => {
    if (response.req.path === `/${name}` && !response.req.getHeader('range')) response.once('close', dropped);
  }));
  const download = store.startDownload();
  await held;
  let paused = false;
  const pausing = store.cancel().then(() => { paused = true; });
  await droppedResponse;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(paused, false, 'the pause waits for the write in progress');
  finishWrite();
  await pausing;
  await download;
  assert.equal(fs.statSync(partial).size, first, 'the written part is kept');
  await store.startDownload();
  assert.deepEqual(await store.state(), { state: 'ready' });
  assert.deepEqual(fs.readFileSync(path.join(store.directory, name)), files[name]);
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
  assert.ok(MODEL_FORMATS.includes(model.format), 'the app can run the model it ships with');
  for (const file of model.files) {
    assert.equal(file.url, `https://huggingface.co/JacobTDang/secondhand-laya/resolve/${model.revision}/${file.path}`, file.path);
  }
  const card = fs.readFileSync(path.join(__dirname, '../docs/laya-model.md'), 'utf8');
  // The card lists every model's files; the published one's must be among them.
  const rows = [...card.matchAll(/\| \`([^\`]+)\` \| ([\d,]+) \| \`([0-9a-f]{64})\` \|/g)].map(m => ({ path: m[1], size: Number(m[2].replace(/,/g, '')), sha256: m[3] }));
  for (const file of model.files) assert.ok(rows.some(row => row.path === file.path && row.size === file.size && row.sha256 === file.sha256), `${file.path} ${file.size} ${file.sha256}`);
  assert.match(card, new RegExp(model.revision), 'the model card names the published commit');
});

test('an update list (latest.json) is read over https or loopback http and checked like the shipped manifest', async t => {
  const files = fixtureFiles();
  const { model, state, base } = await server(t, files);
  state.serve = (name, _request, response) => {
    if (name === 'latest.json') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: 1, model })); return; }
    if (name === 'moved') { response.writeHead(302, { Location: `${base}/latest.json` }).end(); return; }
    if (name === 'empty.json') { response.writeHead(200).end(JSON.stringify({ version: 1, model: null })); return; }
    return false;
  };
  const signal = new AbortController().signal;
  assert.deepEqual(await fetchManifest(`${base}/latest.json`, signal), validateManifest({ version: 1, model }));
  assert.deepEqual(await fetchManifest(`${base}/moved`, signal), validateManifest({ version: 1, model }), 'redirects are followed');
  assert.deepEqual(await fetchManifest(`${base}/empty.json`, signal), { model: null });
  await assert.rejects(fetchManifest('http://example.org/latest.json', signal), /Update check failed: .*https/);
});

test('a failed update check says why: the server’s answer, bad JSON, an invalid list, a list too large, or no connection', async t => {
  const files = fixtureFiles();
  const { model, state, base } = await server(t, files);
  state.serve = (name, _request, response) => {
    if (name === 'garbled.json') { response.writeHead(200).end('{ "version": 1, '); return; }
    if (name === 'invalid.json') { response.writeHead(200).end(JSON.stringify({ version: 1, model: { ...model, revision: 'main' } })); return; }
    if (name === 'huge.json') { response.writeHead(200).end(Buffer.alloc(2 * 1024 * 1024, 32)); return; }
    if (name === 'elsewhere') { response.writeHead(302, { Location: 'http://example.org/latest.json' }).end(); return; }
    return false;
  };
  const signal = new AbortController().signal;
  await assert.rejects(fetchManifest(`${base}/latest.json`, signal), { message: 'Update check failed: the server answered 404.' });
  await assert.rejects(fetchManifest(`${base}/garbled.json`, signal), /^Error: Update check failed: the update list isn’t valid JSON\.$/);
  await assert.rejects(fetchManifest(`${base}/invalid.json`, signal), /^Error: Update check failed: The Laya model manifest is invalid: the revision/);
  await assert.rejects(fetchManifest(`${base}/huge.json`, signal), /^Error: Update check failed: the update list is larger than/);
  await assert.rejects(fetchManifest(`${base}/elsewhere`, signal), /^Error: Update check failed: it was redirected somewhere SecondHand doesn’t trust\.$/);
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(fetchManifest(`http://127.0.0.1:${port}/latest.json`, signal), { message: 'Update check failed: couldn’t reach the server (ECONNREFUSED).' });
  for (const error of await Promise.all([`${base}/latest.json`].map(url => fetchManifest(url, signal).catch(caught => caught)))) {
    assert.equal(error.publicMessage, error.message, 'the message is meant for the person');
  }
});
