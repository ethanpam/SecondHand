'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createLaya, processRunner, sessionPlan, forkWorker, LAYA_NOT_READY, LAYA_TIMEOUT } = require('../desktop/laya.cjs');
const { MODEL_FILES } = require('../desktop/laya-model.cjs');
const { loadTokenizer } = require('../desktop/laya-tokenizer.cjs');
const { encodeDecision, toQuestion, readCalibration, probabilities } = require('../desktop/laya-prompt.cjs');

const small = path.join(__dirname, 'fixtures/laya/small-tokenizer');
// A weightless graph with the export's five inputs and logits output (runtime_fixtures.py tiny):
// logits = marker position / 100 + token count / 1000 + qtype / 10, or -1e4 for padding.
const tinyGraph = path.join(__dirname, 'fixtures/laya/tiny-graph.onnx');
const NO_MODEL = { version: 1, model: null };
const revision = 'd'.repeat(40);
const CONFIG = { max_len: 512, head_max_len: 192, temperature: [1.6, 1.25, 1.5465], temperature_by_options: { 'noul:2': 1.5465, 'choice:3-5': 1.76 } };
const DECISION = { type: 'noul', instructions: 'Given the facts about the household, is the candidate the correct answer to the form question?' };
const MATCH = { type: 'choice', instructions: 'Which saved answer does this form question ask for?', criteria: ['first name', 'last name', 'email address', 'none of these'] };
const tick = () => new Promise(resolve => setImmediate(resolve));
// Waits up to 200 turns of the event loop for `condition`; setTimeout may be mocked.
const settles = async (condition, what) => {
  for (let turn = 0; !condition(); turn++) {
    if (turn > 200) throw new Error(`Never saw ${what}`);
    await tick();
  }
};

function temporary(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Model files for the stub runner: the small tokenizer, a config, and placeholder graph bytes.
function modelFiles() {
  return {
    'model.onnx': Buffer.from('synthetic graph'),
    'model.onnx.data': crypto.randomBytes(4096),
    'tokenizer/tokenizer.json': fs.readFileSync(path.join(small, 'tokenizer.json')),
    'tokenizer/tokenizer_config.json': fs.readFileSync(path.join(small, 'tokenizer_config.json')),
    'rl_agent_config.json': Buffer.from(JSON.stringify(CONFIG))
  };
}

function modelDirectory(t) {
  const directory = temporary(t, 'secondhand-laya-dir-');
  for (const [name, bytes] of Object.entries(modelFiles())) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), bytes);
  }
  return directory;
}

// Stub runner (tests only): each row's scores come from its own inputs, so answers can be
// checked against the row they belong to after batching and reordering.
function stubRunner(overrides = {}) {
  const runner = { loads: [], runs: [], releases: 0, pending: null,
    async load(file) {
      runner.loads.push(file);
      if (overrides.load) await overrides.load(file);
      return {
        sessions: overrides.sessions ?? 1,
        async run(batch) {
          runner.runs.push(batch);
          if (overrides.run) await overrides.run(batch);
          return { data: Float32Array.from({ length: batch.rows * batch.count }, (_, index) => scoreFor(batch, Math.floor(index / batch.count), index % batch.count)), dims: [batch.rows, batch.count] };
        },
        async release() { runner.releases++; }
      };
    } };
  return runner;
}
function scoreFor(batch, row, option) {
  let length = 0;
  for (let index = 0; index < batch.length; index++) length += Number(batch.attentionMask[row * batch.length + index]);
  return option * (length % 7) / 3 - (batch.markerMask[row * batch.count + option] ? 0 : 1e4);
}

async function expectedAnswer(state, definition) {
  const tokenizer = await loadTokenizer(small);
  const question = toQuestion(definition);
  const { ids, markers, qtype } = encodeDecision(tokenizer, state, question, { maxLen: 512, headMaxLen: 192 });
  const count = markers.length;
  const scores = Array.from({ length: count }, (_, option) => option * (ids.length % 7) / 3);
  return probabilities(scores, count, qtype, readCalibration(CONFIG));
}

async function localServer(t, files) {
  const instance = http.createServer((request, response) => {
    const bytes = files[decodeURIComponent(request.url.slice(1))];
    if (!bytes) response.writeHead(404).end(); else response.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const closed = new Promise(resolve => instance.on('close', resolve));
  const close = () => { instance.closeAllConnections(); instance.close(); return closed; };
  t.after(() => instance.listening && close());
  const base = `http://127.0.0.1:${instance.address().port}`;
  return { close, manifest: { version: 1, model: { revision, format: 'noul-v1', files: MODEL_FILES.map(name => ({ path: name, url: `${base}/${name}`, size: files[name].length,
    sha256: crypto.createHash('sha256').update(files[name]).digest('hex') })) } } };
}

const facts = 'The applicant is 41 years old. The household has 3 people: 2 adults and 1 child under 18.';
const rowState = candidate => ({ facts, question: 'How many people live in your household?', candidate });

test('with the toggle off nothing is read, downloaded, or loaded, and decisions are refused as not ready', async t => {
  const userDataDir = path.join(os.tmpdir(), `secondhand-laya-never-created-${process.pid}`);
  const runner = stubRunner();
  const files = modelFiles();
  const { manifest } = await localServer(t, files);
  const laya = createLaya({ userDataDir, manifest, runner });
  assert.deepEqual(await laya.status(), { state: 'off', enabled: false, sizeBytes: Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) });
  const refused = await laya.decide(rowState('3'), { correct: DECISION }).catch(error => error);
  assert.equal(refused.code, LAYA_NOT_READY);
  assert.match(refused.message, /turned off/);
  assert.equal((await laya.decideBatch([{ state: rowState('3'), questions: { correct: DECISION } }]).catch(error => error)).code, LAYA_NOT_READY);
  assert.throws(() => laya.startDownload(), /Turn on/);
  assert.equal(runner.loads.length, 0);
  assert.equal(fs.existsSync(userDataDir), false, 'nothing was written');
});

test('an empty manifest reports that no model is available yet, whatever the toggle says', async t => {
  const runner = stubRunner();
  const laya = createLaya({ userDataDir: temporary(t, 'secondhand-laya-'), manifest: { version: 1, model: null }, runner, enabled: true });
  assert.deepEqual(await laya.status(), { state: 'unavailable', enabled: true, message: 'No Laya model is available to download yet.' });
  assert.equal((await laya.decide(rowState('3'), { correct: DECISION }).catch(error => error)).code, LAYA_NOT_READY);
  assert.throws(() => laya.startDownload(), /No Laya model is available/);
  assert.equal(runner.loads.length, 0);
});

test('a computer the runtime has no build for reports Laya as unavailable', async t => {
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner: { ...stubRunner(), supported: false }, enabled: true });
  const status = await laya.status();
  assert.equal(status.state, 'unavailable');
  assert.match(status.message, /can’t run on this computer/);
  assert.equal((await laya.decide(rowState('3'), { correct: DECISION }).catch(error => error)).code, LAYA_NOT_READY);
});

test('decide answers noul and choice questions with calibrated probabilities in the Python agent shape', async t => {
  const runner = stubRunner();
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner, enabled: true });
  assert.equal((await laya.status()).state, 'ready');
  assert.equal(runner.loads.length, 0, 'the model loads lazily, on the first decision');
  const result = await laya.decide(rowState('3'), { correct: DECISION, match: MATCH });
  assert.deepEqual(Object.keys(result), ['answers']);
  const noul = await expectedAnswer(rowState('3'), DECISION);
  assert.equal(result.answers.correct.type, 'noul');
  // Scores come back as float32, like the real graph's, hence the tolerance.
  assert.ok(Math.abs(result.answers.correct.noul - noul[1]) < 1e-6);
  assert.equal(result.answers.correct.confidence, Math.max(result.answers.correct.noul, 1 - result.answers.correct.noul));
  const choice = await expectedAnswer(rowState('3'), MATCH);
  assert.deepEqual(Object.keys(result.answers.match.probabilities), MATCH.criteria);
  MATCH.criteria.forEach((label, index) => assert.ok(Math.abs(result.answers.match.probabilities[label] - choice[index]) < 1e-6));
  assert.equal(result.answers.match.choice, MATCH.criteria[choice.indexOf(Math.max(...choice))]);
  assert.equal(runner.loads.length, 1);
  assert.equal(runner.runs.length, 1, 'both questions ran in one batch');
});

test('decideBatch returns answers in order, running decisions sorted by length in batches of at most 8', async t => {
  const runner = stubRunner();
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner, enabled: true });
  const items = Array.from({ length: 21 }, (_, index) => ({ state: rowState(`${'candidate '.repeat(index % 5)}${index}`), questions: { correct: DECISION } }));
  items[4].questions = { correct: DECISION, match: MATCH };
  const results = await laya.decideBatch(items);
  assert.equal(results.length, 21);
  for (const [index, item] of items.entries()) {
    const expected = await expectedAnswer(item.state, DECISION);
    assert.ok(Math.abs(results[index].answers.correct.noul - expected[1]) < 1e-6, `item ${index}`);
  }
  assert.equal(results[4].answers.match.type, 'choice');
  assert.deepEqual(runner.runs.map(batch => batch.rows), [8, 8, 6]);
  const lengths = runner.runs.map(batch => batch.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b), 'shorter decisions run first, so batches carry little padding');
  assert.equal(runner.loads.length, 1);
  assert.deepEqual(await laya.decideBatch([]), []);
});

test('a model folder must name its prompt format, and a decision can require the format its prompts are written in', async t => {
  const modelDir = modelDirectory(t);
  assert.throws(() => createLaya({ modelDir, manifest: NO_MODEL, runner: stubRunner(), enabled: true }), /format/);
  assert.throws(() => createLaya({ modelDir, modelFormat: 'noul-v9', manifest: NO_MODEL, runner: stubRunner(), enabled: true }), /noul-v9/);
  const laya = createLaya({ modelDir, modelFormat: 'choice-v2', manifest: NO_MODEL, runner: stubRunner(), enabled: true });
  assert.equal(await laya.format(), 'choice-v2');
  assert.equal((await laya.decideBatch([{ state: rowState('3'), questions: { match: MATCH } }], { format: 'choice-v2' }))[0].answers.match.type, 'choice');
  const refused = await laya.decideBatch([{ state: rowState('3'), questions: { correct: DECISION } }], { format: 'noul-v1' }).catch(error => error);
  assert.equal(refused.code, LAYA_NOT_READY);
  assert.match(refused.message, /changed/);
  await assert.rejects(laya.decideBatch([{ state: rowState('3'), questions: { match: MATCH } }], { format: 'choice' }), /format/);
  const off = createLaya({ modelDir, modelFormat: 'choice-v2', manifest: NO_MODEL, runner: stubRunner(), enabled: false });
  assert.equal((await off.format().catch(error => error)).code, LAYA_NOT_READY);
});

test('bad requests are refused with the reason, not answered', async t => {
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner: stubRunner(), enabled: true });
  await assert.rejects(laya.decide(rowState('3'), {}), /at least one question/);
  await assert.rejects(laya.decide(rowState('3'), { score: { type: 'score', instructions: 'How much?', criteria: ['a', 'b'] } }), /choice or noul/);
  await assert.rejects(laya.decide({ amount: 2.5 }, { correct: DECISION }), /whole numbers/);
  await assert.rejects(laya.decideBatch('not a list'), /array/);
});

test('a request that takes longer than the timeout is rejected with LAYA_TIMEOUT', async t => {
  let release;
  const runner = stubRunner({ run: () => new Promise(resolve => { release = resolve; }) });
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner, enabled: true, timeoutMs: 50 });
  // The clock only moves once the first batch is running, so a slow machine can't time out the request before it starts.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = laya.decideBatch(Array.from({ length: 20 }, () => ({ state: rowState('3'), questions: { correct: DECISION } }))).catch(caught => caught);
  while (runner.runs.length === 0) await tick();
  t.mock.timers.tick(50);
  const error = await pending;
  assert.equal(error.code, LAYA_TIMEOUT);
  assert.match(error.message, /took too long/);
  release();
  await tick();
  assert.equal(runner.runs.length, 1, 'the rest of a timed-out request is not run');
  t.mock.timers.reset();
  const later = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner: stubRunner(), enabled: true, timeoutMs: 5000 });
  assert.equal((await later.decide(rowState('3'), { correct: DECISION })).answers.correct.type, 'noul');
});

test('a model with two sessions runs two batches at once, oldest first, and starts the next as one finishes', async t => {
  const running = [];
  const runner = stubRunner({ sessions: 2, run: batch => new Promise(resolve => running.push({ batch, resolve })) });
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: NO_MODEL, runner, enabled: true });
  const items = count => Array.from({ length: count }, (_, index) => ({ state: rowState(`${index}`), questions: { correct: DECISION } }));
  const first = laya.decideBatch(items(20));
  const second = laya.decideBatch(items(3));
  await settles(() => running.length >= 2, 'two batches running');
  await tick();
  assert.deepEqual(running.map(({ batch }) => batch.rows), [8, 8], 'two of the first request’s three batches start together');
  running[1].resolve();
  await settles(() => running.length >= 3, 'a third batch');
  assert.equal(running[2].batch.rows, 4, 'the first request’s last batch goes before the second request');
  running[0].resolve();
  await settles(() => running.length >= 4, 'a fourth batch');
  assert.equal(running[3].batch.rows, 3);
  running[2].resolve();
  running[3].resolve();
  assert.equal((await first).length, 20);
  assert.equal((await second).length, 3);
  assert.equal(runner.runs.length, 4);
});

test('a Mac with 8 or more performance cores and 16 GB runs two sessions, splitting those cores; other computers run one', () => {
  const GB = 2 ** 30;
  assert.deepEqual(sessionPlan({ performanceCores: 10, memory: 36 * GB }), { sessions: 2, threads: 5 });
  assert.deepEqual(sessionPlan({ performanceCores: 12, memory: 16 * GB }), { sessions: 2, threads: 6 });
  assert.deepEqual(sessionPlan({ performanceCores: 10, memory: 8 * GB }), { sessions: 1, threads: 10 }, 'not enough memory for a second copy of the weights');
  assert.deepEqual(sessionPlan({ performanceCores: 4, memory: 16 * GB }), { sessions: 1, threads: 4 });
  assert.deepEqual(sessionPlan({ performanceCores: null, memory: 64 * GB }), { sessions: 1 }, 'elsewhere, onnxruntime picks its threads');
  const plan = sessionPlan();
  assert.ok(plan.sessions === 1 || plan.sessions === 2);
  if (process.platform === 'darwin' && process.arch === 'arm64') assert.ok(Number.isInteger(plan.threads) && plan.threads > 0, 'this Mac’s performance cores are read');
});

test('a request can end sooner than the runtime’s timeout; its batches that haven’t started are dropped', async t => {
  const running = [];
  const runner = stubRunner({ run: batch => new Promise(resolve => running.push({ batch, resolve })) });
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: NO_MODEL, runner, enabled: true, timeoutMs: 3000 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const items = Array.from({ length: 20 }, () => ({ state: rowState('3'), questions: { correct: DECISION } }));
  const pending = laya.decideBatch(items, { timeoutMs: 40 }).catch(caught => caught);
  await settles(() => running.length > 0, 'the first batch');
  t.mock.timers.tick(40);
  const error = await pending;
  assert.equal(error.code, LAYA_TIMEOUT);
  assert.match(error.message, /over 40 ms/);
  running[0].resolve();
  await tick();
  await tick();
  assert.equal(runner.runs.length, 1, 'the rest of the request is not run');
  t.mock.timers.reset();
  for (const timeoutMs of [0, -5, 1.5, '40']) await assert.rejects(laya.decideBatch(items, { timeoutMs }), /timeout/, String(timeoutMs));
  const capped = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: NO_MODEL, runner: stubRunner(), enabled: true, timeoutMs: 3000 });
  assert.equal((await capped.decideBatch(items.slice(0, 1), { timeoutMs: 60000 })).length, 1, 'a longer timeout than the runtime’s is held to the runtime’s');
});

test('the model is released after 5 idle minutes and loads again on the next decision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runner = stubRunner();
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner, enabled: true });
  await laya.decide(rowState('3'), { correct: DECISION });
  t.mock.timers.tick(4 * 60 * 1000);
  await tick();
  assert.equal(runner.releases, 0);
  await laya.decide(rowState('4'), { correct: DECISION });
  t.mock.timers.tick(4 * 60 * 1000);
  await tick();
  assert.equal(runner.releases, 0, 'a decision restarts the idle clock');
  t.mock.timers.tick(60 * 1000);
  await tick();
  assert.equal(runner.releases, 1, 'released after 5 minutes without a decision');
  await laya.decide(rowState('5'), { correct: DECISION });
  assert.equal(runner.loads.length, 2);
});

test('warming loads the model ahead of a request, so a first decision after idle isn’t spent loading it', async t => {
  // Loading the real model takes seconds (process start, checksum, load): longer than a request's timeout.
  const slowLoad = () => stubRunner({ load: () => new Promise(resolve => setTimeout(resolve, 120)) });
  const cold = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner: slowLoad(), enabled: true, timeoutMs: 60 });
  assert.equal((await cold.decide(rowState('3'), { correct: DECISION }).catch(error => error)).code, LAYA_TIMEOUT, 'without warming, the load eats the request’s time');
  const runner = slowLoad();
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner, enabled: true, timeoutMs: 60 });
  await Promise.all([laya.warm(), laya.warm()]);
  assert.equal(runner.loads.length, 1, 'warms share one load');
  assert.equal((await laya.decide(rowState('3'), { correct: DECISION })).answers.correct.type, 'noul');
  await laya.warm();
  assert.equal(runner.loads.length, 1, 'a warm model is not loaded again');
  const off = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner: stubRunner(), enabled: false });
  assert.equal((await off.warm().catch(error => error)).code, LAYA_NOT_READY, 'warming is refused like a decision when Laya is off');
  const broken = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner: stubRunner({ load: async () => { throw new Error('synthetic load failure'); } }), enabled: true });
  assert.equal((await broken.warm().catch(error => error)).code, LAYA_NOT_READY);
  assert.equal((await broken.status()).state, 'error');
});

test('a warmed model is released after 5 idle minutes too', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runner = stubRunner();
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner, enabled: true });
  await laya.warm();
  t.mock.timers.tick(5 * 60 * 1000 - 1);
  await tick();
  assert.equal(runner.releases, 0);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(runner.releases, 1);
});

test('concurrent first decisions share one model load', async t => {
  const runner = stubRunner();
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner, enabled: true });
  await Promise.all([laya.decide(rowState('1'), { correct: DECISION }), laya.decide(rowState('2'), { correct: DECISION }), laya.decideBatch([{ state: rowState('3'), questions: { correct: DECISION } }])]);
  assert.equal(runner.loads.length, 1);
});

test('a model that fails to load is reported as an error and decisions are refused as not ready', async t => {
  const runner = stubRunner({ load: async () => { throw new Error('synthetic load failure'); } });
  const laya = createLaya({ modelDir: modelDirectory(t), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner, enabled: true });
  const error = await laya.decide(rowState('3'), { correct: DECISION }).catch(caught => caught);
  assert.equal(error.code, LAYA_NOT_READY);
  assert.match(error.message, /couldn’t be loaded \(synthetic load failure\)/);
  assert.deepEqual(await laya.status(), { state: 'error', enabled: true, sizeBytes: Object.values(modelFiles()).reduce((sum, bytes) => sum + bytes.length, 0),
    message: 'The Laya model couldn’t be loaded (synthetic load failure).' });
  const missing = createLaya({ modelDir: path.join(os.tmpdir(), 'secondhand-no-such-laya-dir'), modelFormat: 'noul-v1', manifest: { version: 1, model: null }, runner: stubRunner(), enabled: true });
  assert.match((await missing.status()).message, /model folder is missing model\.onnx/);
});

test('download, then decisions work with the network off; tampered files are refused before use', async t => {
  const files = modelFiles();
  const server = await localServer(t, files);
  const runner = stubRunner();
  const userDataDir = temporary(t, 'secondhand-laya-');
  const laya = createLaya({ userDataDir, manifest: server.manifest, runner });
  assert.equal((await laya.status()).state, 'off');
  await laya.setEnabled(true);
  assert.deepEqual(await laya.status(), { state: 'not-downloaded', enabled: true, progress: 0, sizeBytes: Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) });
  assert.equal((await laya.decide(rowState('3'), { correct: DECISION }).catch(error => error)).code, LAYA_NOT_READY);
  await laya.startDownload();
  assert.equal((await laya.status()).state, 'ready');

  await server.close();
  const blocked = () => { throw new Error('The network is off in this test.'); };
  for (const [module, name] of [[http, 'get'], [http, 'request'], [https, 'get'], [https, 'request']]) t.mock.method(module, name, blocked);
  const result = await laya.decide(rowState('3'), { correct: DECISION });
  assert.equal(result.answers.correct.type, 'noul');
  assert.equal(runner.loads[0], path.join(userDataDir, 'models/laya', revision, 'model.onnx'));

  await laya.close();
  const weights = path.join(userDataDir, 'models/laya', revision, 'model.onnx.data');
  const bytes = fs.readFileSync(weights);
  bytes[7] ^= 1;
  fs.writeFileSync(weights, bytes);
  const refused = await laya.decide(rowState('3'), { correct: DECISION }).catch(error => error);
  assert.equal(refused.code, LAYA_NOT_READY);
  assert.match(refused.message, /changed or damaged, so SecondHand deleted them/);
  assert.equal(fs.existsSync(path.join(userDataDir, 'models/laya', revision)), false);
  assert.equal((await laya.status()).state, 'error');
});

test('turning the toggle off stops a download, keeps what arrived, and releases the model', async t => {
  const files = modelFiles();
  files['model.onnx.data'] = crypto.randomBytes(512 * 1024);
  let stall;
  const instance = http.createServer((request, response) => {
    const name = decodeURIComponent(request.url.slice(1));
    const bytes = files[name];
    if (name === 'model.onnx.data' && !stall) { response.writeHead(200, { 'Content-Length': bytes.length }); response.write(bytes.subarray(0, 1000)); stall = response; return; }
    const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range || '')?.[1] || 0);
    response.writeHead(start ? 206 : 200, start ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}).end(bytes.subarray(start));
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const base = `http://127.0.0.1:${instance.address().port}`;
  const manifest = { version: 1, model: { revision, format: 'noul-v1', files: MODEL_FILES.map(name => ({ path: name, url: `${base}/${name}`, size: files[name].length, sha256: crypto.createHash('sha256').update(files[name]).digest('hex') })) } };
  const runner = stubRunner();
  const userDataDir = temporary(t, 'secondhand-laya-');
  const laya = createLaya({ userDataDir, manifest, runner, enabled: true });
  const download = laya.startDownload();
  while (!stall) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await laya.status()).state, 'downloading');
  await laya.setEnabled(false);
  await download;
  assert.equal((await laya.status()).state, 'off');
  await laya.setEnabled(true);
  const paused = await laya.status();
  assert.equal(paused.state, 'not-downloaded');
  assert.ok(paused.progress > 0, 'the partial download is kept for resuming');
  await laya.startDownload();
  await laya.decide(rowState('3'), { correct: DECISION });
  assert.equal(runner.loads.length, 1);
  await laya.setEnabled(false);
  assert.equal(runner.releases, 1);
  await laya.setEnabled(true);
  await laya.remove();
  assert.equal((await laya.status()).state, 'off', 'removing the model turns Laya off, so it isn’t downloaded again');
  assert.equal(fs.existsSync(path.join(userDataDir, 'models/laya')), false);
  await laya.setEnabled(true);
  assert.equal((await laya.status()).state, 'not-downloaded');
});

// A local stand-in for the model repo (tests only): each published revision's files at
// /<revision>/<path>, and /latest.json naming the model `hub.latest` is set to (404 while null).
// `hub.serve` can take over a request, to stall or corrupt it.
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
async function modelHub(t) {
  const routes = new Map();
  const hub = { requests: [], latest: null, serve: null };
  const instance = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1));
    hub.requests.push(name);
    if (hub.serve && hub.serve(name, request, response) !== false) return;
    const bytes = name === 'latest.json' ? hub.latest && Buffer.from(JSON.stringify(hub.latest)) : routes.get(name);
    if (!bytes) { response.writeHead(404).end(); return; }
    const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range || '')?.[1] || 0);
    response.writeHead(start ? 206 : 200, start ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}).end(bytes.subarray(start));
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const base = `http://127.0.0.1:${instance.address().port}`;
  hub.updateUrl = `${base}/latest.json`;
  hub.publish = (name, files = modelFiles(), format = 'noul-v1') => {
    for (const [file, bytes] of Object.entries(files)) routes.set(`${name}/${file}`, bytes);
    return { version: 1, model: { revision: name, format, files: MODEL_FILES.map(file => ({ path: file, url: `${base}/${name}/${file}`, size: files[file].length,
      sha256: crypto.createHash('sha256').update(files[file]).digest('hex') })) } };
  };
  hub.fileRequests = name => hub.requests.filter(request => request.startsWith(`${name}/`));
  hub.checks = () => hub.requests.filter(request => request === 'latest.json').length;
  return hub;
}
const until = async (condition, what) => {
  for (let attempt = 0; !(await condition()); attempt++) {
    if (attempt > 1000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const installedRevision = userDataDir => JSON.parse(fs.readFileSync(path.join(userDataDir, 'models/laya/installed.json'), 'utf8')).model.revision;
const stored = userDataDir => fs.readdirSync(path.join(userDataDir, 'models/laya')).sort();
const modelPath = (userDataDir, name) => path.join(userDataDir, 'models/laya', name, 'model.onnx');
const sizeOf = manifest => manifest.model.files.reduce((sum, file) => sum + file.size, 0);

test('with nothing installed, Laya downloads the newest model latest.json names and records it as installed', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  hub.latest = hub.publish(NEW);
  const userDataDir = temporary(t, 'secondhand-laya-');
  const runner = stubRunner();
  const laya = createLaya({ userDataDir, manifest: shipped, updateUrl: hub.updateUrl, runner, enabled: true });
  const update = laya.update();
  assert.equal((await laya.status()).state, 'downloading', 'the check that starts the download counts as the download');
  await update;
  assert.deepEqual(await laya.status(), { state: 'ready', enabled: true, sizeBytes: sizeOf(hub.latest) });
  assert.deepEqual(hub.fileRequests(OLD), [], 'the shipped model isn’t downloaded when a newer one can be');
  assert.deepEqual(stored(userDataDir), [NEW, 'installed.json']);
  assert.equal(installedRevision(userDataDir), NEW);

  // After a restart the installed model is used as it is: nothing is downloaded, even with no update URL.
  const requests = hub.requests.length;
  const restarted = createLaya({ userDataDir, manifest: shipped, runner, enabled: true });
  await restarted.update();
  assert.equal((await restarted.status()).state, 'ready');
  await restarted.decide(rowState('3'), { correct: DECISION });
  assert.equal(runner.loads.at(-1), modelPath(userDataDir, NEW));
  assert.equal(hub.requests.length, requests);
});

test('when latest.json can’t be read and nothing is installed, the shipped model downloads and the failed check shows beside it', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  const userDataDir = temporary(t, 'secondhand-laya-');
  const laya = createLaya({ userDataDir, manifest: shipped, updateUrl: hub.updateUrl, runner: stubRunner(), enabled: true });
  await laya.update();
  assert.deepEqual(await laya.status(), { state: 'ready', enabled: true, sizeBytes: sizeOf(shipped),
    update: { state: 'error', message: 'Update check failed: the server answered 404.' } });
  assert.equal(installedRevision(userDataDir), OLD);
  hub.latest = shipped;
  await laya.update();
  assert.deepEqual(await laya.status(), { state: 'ready', enabled: true, sizeBytes: sizeOf(shipped) }, 'a check that works clears the note');
  assert.equal(hub.fileRequests(OLD).length, MODEL_FILES.length, 'the installed model isn’t downloaded again');
});

test('a newer model downloads beside the installed one, which keeps answering; once every file is verified Laya switches to it and deletes the old one', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  hub.latest = shipped;
  const userDataDir = temporary(t, 'secondhand-laya-');
  const runner = stubRunner();
  const laya = createLaya({ userDataDir, manifest: shipped, updateUrl: hub.updateUrl, runner, enabled: true });
  await laya.update();
  await laya.decide(rowState('3'), { correct: DECISION });
  assert.equal(runner.loads.at(-1), modelPath(userDataDir, OLD));

  const newer = modelFiles();
  hub.latest = hub.publish(NEW, newer);
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  hub.serve = (name, _request, response) => {
    if (name !== `${NEW}/model.onnx.data`) return false;
    gate.then(() => response.writeHead(200).end(newer['model.onnx.data']));
  };
  const update = laya.update();
  await until(() => hub.requests.includes(`${NEW}/model.onnx.data`), 'the new weights');
  const during = await laya.status();
  assert.equal(during.state, 'ready');
  assert.equal(during.update.state, 'downloading');
  assert.equal(during.update.sizeBytes, sizeOf(hub.latest));
  assert.ok(during.update.progress > 0 && during.update.progress < 1, String(during.update.progress));
  await laya.decide(rowState('4'), { correct: DECISION });
  assert.equal(runner.loads.length, 1, 'decisions keep using the installed model');

  open();
  await update;
  assert.deepEqual(await laya.status(), { state: 'ready', enabled: true, sizeBytes: sizeOf(hub.latest) });
  assert.equal(runner.releases, 1, 'the old model was released');
  assert.deepEqual(stored(userDataDir), [NEW, 'installed.json'], 'the old revision was deleted');
  assert.equal(installedRevision(userDataDir), NEW);
  await laya.decide(rowState('5'), { correct: DECISION });
  assert.equal(runner.loads.at(-1), modelPath(userDataDir, NEW), 'the next decision loads the new model');
});

test('a decision running when an update is ready finishes on the old model; the switch waits for it', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  hub.latest = shipped;
  const userDataDir = temporary(t, 'secondhand-laya-');
  let hold = null;
  const runner = stubRunner({ run: () => hold && hold.promise });
  const laya = createLaya({ userDataDir, manifest: shipped, updateUrl: hub.updateUrl, runner, enabled: true, timeoutMs: 60000 });
  await laya.update();
  hold = {};
  hold.promise = new Promise(resolve => { hold.release = resolve; });
  const decision = laya.decide(rowState('3'), { correct: DECISION });
  await until(() => runner.runs.length === 1, 'the decision to start');

  hub.latest = hub.publish(NEW);
  await laya.update();
  assert.equal(installedRevision(userDataDir), NEW, 'the verified update is recorded as installed');
  assert.deepEqual(stored(userDataDir), [OLD, NEW, 'installed.json'].sort(), 'the old model stays while it answers');
  assert.equal(runner.releases, 0);

  const { release } = hold;
  hold = null;
  release();
  assert.equal((await decision).answers.correct.type, 'noul', 'the running decision finishes');
  assert.equal(runner.loads.length, 1);
  await until(() => !fs.existsSync(path.join(userDataDir, 'models/laya', OLD)), 'the old revision to be deleted');
  assert.equal(runner.releases, 1);
  await laya.decide(rowState('4'), { correct: DECISION });
  assert.equal(runner.loads.at(-1), modelPath(userDataDir, NEW));
});

test('a model in a format this app can’t run is ignored with a note, and the installed or shipped model is used', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  hub.latest = hub.publish(NEW, modelFiles(), 'noul-v9');
  const userDataDir = temporary(t, 'secondhand-laya-');
  const runner = stubRunner();
  const laya = createLaya({ userDataDir, manifest: shipped, updateUrl: hub.updateUrl, runner, enabled: true });
  await laya.update();
  const status = await laya.status();
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.update, { state: 'incompatible', message: 'A newer Laya model is available, but it needs a newer version of SecondHand.' });
  assert.equal(installedRevision(userDataDir), OLD, 'with nothing installed, the shipped model was downloaded');
  await laya.update();
  assert.deepEqual(hub.fileRequests(NEW), [], 'nothing of the newer model is downloaded');
  await laya.decide(rowState('3'), { correct: DECISION });
  assert.equal(runner.loads.at(-1), modelPath(userDataDir, OLD));
});

test('the model in use says its format; after an update to another format, a request written for the old one is refused as not ready', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  hub.latest = shipped;
  const userDataDir = temporary(t, 'secondhand-laya-');
  const laya = createLaya({ userDataDir, manifest: shipped, updateUrl: hub.updateUrl, runner: stubRunner(), enabled: true });
  await laya.update();
  assert.equal(await laya.format(), 'noul-v1');
  assert.equal((await laya.decideBatch([{ state: rowState('3'), questions: { correct: DECISION } }], { format: 'noul-v1' }))[0].answers.correct.type, 'noul');
  hub.latest = hub.publish(NEW, modelFiles(), 'choice-v2');
  await laya.update();
  assert.equal(installedRevision(userDataDir), NEW);
  assert.equal(await laya.format(), 'choice-v2');
  const refused = await laya.decideBatch([{ state: rowState('3'), questions: { correct: DECISION } }], { format: 'noul-v1' }).catch(error => error);
  assert.equal(refused.code, LAYA_NOT_READY);
  assert.equal((await laya.decideBatch([{ state: rowState('3'), questions: { match: MATCH } }], { format: 'choice-v2' }))[0].answers.match.type, 'choice');
  const restarted = createLaya({ userDataDir, manifest: shipped, runner: stubRunner(), enabled: true });
  assert.equal(await restarted.format(), 'choice-v2', 'after a restart, the installed model’s format');
});

test('a tampered update is deleted, the installed model keeps working, and the next check tries again', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  hub.latest = shipped;
  const userDataDir = temporary(t, 'secondhand-laya-');
  const runner = stubRunner();
  const laya = createLaya({ userDataDir, manifest: shipped, updateUrl: hub.updateUrl, runner, enabled: true });
  await laya.update();
  const newer = modelFiles();
  hub.latest = hub.publish(NEW, newer);
  hub.serve = (name, _request, response) => {
    if (name !== `${NEW}/model.onnx.data`) return false;
    const bytes = Buffer.from(newer['model.onnx.data']);
    bytes[10] ^= 0xff;
    response.writeHead(200).end(bytes);
  };
  await laya.update();
  const status = await laya.status();
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.update, { state: 'error', message: 'Update download failed: The downloaded Laya model didn’t match its expected checksum, so SecondHand deleted it. Try again.' });
  assert.equal(fs.existsSync(path.join(userDataDir, 'models/laya', NEW, 'model.onnx.data')), false);
  assert.equal(fs.existsSync(path.join(userDataDir, 'models/laya', NEW, 'model.onnx.data.partial')), false);
  assert.equal(installedRevision(userDataDir), OLD);
  await laya.decide(rowState('3'), { correct: DECISION });
  assert.equal(runner.loads.at(-1), modelPath(userDataDir, OLD));

  hub.serve = null;
  await laya.update();
  assert.deepEqual(await laya.status(), { state: 'ready', enabled: true, sizeBytes: sizeOf(hub.latest) });
  assert.equal(installedRevision(userDataDir), NEW);
});

test('nothing is checked or downloaded while Laya is off, and turning it off stops an update download, keeping what arrived', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  hub.latest = shipped;
  const userDataDir = temporary(t, 'secondhand-laya-');
  const laya = createLaya({ userDataDir, manifest: shipped, updateUrl: hub.updateUrl, runner: stubRunner() });
  await laya.update();
  await laya.startUpdates();
  assert.deepEqual(hub.requests, []);
  assert.equal(fs.existsSync(path.join(userDataDir, 'models')), false);
  t.after(() => laya.close());

  await laya.setEnabled(true);
  await laya.update();
  hub.latest = hub.publish(NEW);
  hub.serve = name => name === `${NEW}/model.onnx.data` ? undefined : false; // never answers
  const update = laya.update();
  await until(() => hub.requests.includes(`${NEW}/model.onnx.data`), 'the new weights');
  await laya.setEnabled(false);
  await update;
  assert.equal((await laya.status()).state, 'off');
  assert.ok(fs.existsSync(path.join(userDataDir, 'models/laya', NEW, 'model.onnx')), 'files that arrived are kept');
  assert.equal(installedRevision(userDataDir), OLD);

  hub.serve = null;
  await laya.setEnabled(true);
  await laya.update();
  assert.equal(installedRevision(userDataDir), NEW);
  assert.equal(hub.fileRequests(NEW).filter(name => name === `${NEW}/model.onnx`).length, 1, 'the update resumed');
});

test('pausing the first download stops it and says so at once, even while the check that starts it runs', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  hub.latest = shipped;
  let checked = false;
  hub.serve = name => { if (name !== 'latest.json' || checked) return false; checked = true; }; // the first check never answers
  const laya = createLaya({ userDataDir: temporary(t, 'secondhand-laya-'), manifest: shipped, updateUrl: hub.updateUrl, runner: stubRunner(), enabled: true });
  const update = laya.update();
  await until(() => checked, 'the check');
  assert.equal((await laya.status()).state, 'downloading');
  await laya.cancelDownload();
  assert.deepEqual(await laya.status(), { state: 'not-downloaded', enabled: true, progress: 0, sizeBytes: sizeOf(shipped) });
  await update;
  assert.deepEqual(hub.fileRequests(OLD), [], 'the paused check started no download');

  hub.serve = name => name === `${OLD}/model.onnx.data` ? undefined : false; // never answers
  const resumed = laya.update();
  await until(() => hub.requests.includes(`${OLD}/model.onnx.data`), 'the weights');
  await laya.cancelDownload();
  const paused = await laya.status();
  assert.equal(paused.state, 'not-downloaded');
  assert.ok(paused.progress > 0, 'what arrived is kept');
  await resumed;
});

test('startUpdates checks at once and then every 24 hours until Laya closes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  hub.latest = shipped;
  const laya = createLaya({ userDataDir: temporary(t, 'secondhand-laya-'), manifest: shipped, updateUrl: hub.updateUrl, runner: stubRunner(), enabled: true });
  await laya.startUpdates();
  await laya.startUpdates();
  assert.equal(hub.checks(), 2, 'each call checks, but only one clock runs');
  t.mock.timers.tick(24 * 60 * 60 * 1000 - 1);
  await laya.update();
  assert.equal(hub.checks(), 3);
  t.mock.timers.tick(1);
  await laya.update(); // joins the check the clock started
  assert.equal(hub.checks(), 4, 'the 24-hour check ran');
  await laya.close();
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await laya.update();
  assert.equal(hub.checks(), 4, 'nothing is checked after close');
});

test('an installed.json SecondHand can’t use leaves the shipped model in place, and says why', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  const userDataDir = temporary(t, 'secondhand-laya-');
  fs.mkdirSync(path.join(userDataDir, 'models/laya'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'models/laya/installed.json'), '{ damaged');
  const laya = createLaya({ userDataDir, manifest: shipped, runner: stubRunner(), enabled: true });
  assert.deepEqual(await laya.status(), { state: 'not-downloaded', enabled: true, progress: 0, sizeBytes: sizeOf(shipped),
    update: { state: 'error', message: 'SecondHand couldn’t read which Laya model is installed (installed.json isn’t valid JSON), so it uses the one it shipped with.' } });
  await laya.update();
  assert.deepEqual(await laya.status(), { state: 'ready', enabled: true, sizeBytes: sizeOf(shipped) }, 'installing the model replaces the record and clears the note');
  assert.equal(installedRevision(userDataDir), OLD);

  const newer = hub.publish(NEW, modelFiles(), 'noul-v9');
  fs.writeFileSync(path.join(userDataDir, 'models/laya/installed.json'), JSON.stringify(newer));
  const downgraded = createLaya({ userDataDir, manifest: shipped, runner: stubRunner(), enabled: true });
  const status = await downgraded.status();
  assert.equal(status.state, 'ready', 'the shipped model’s files are still there');
  assert.deepEqual(status.update, { state: 'incompatible', message: 'The installed Laya model needs a newer version of SecondHand, so SecondHand uses one it can run.' });
});

test('remove turns Laya off and deletes every revision; turned on again, it downloads the newest model', async t => {
  const hub = await modelHub(t);
  const shipped = hub.publish(OLD);
  hub.latest = shipped;
  const userDataDir = temporary(t, 'secondhand-laya-');
  const laya = createLaya({ userDataDir, manifest: shipped, updateUrl: hub.updateUrl, runner: stubRunner(), enabled: true });
  await laya.update();
  hub.latest = hub.publish(NEW);
  hub.serve = name => name === `${NEW}/model.onnx.data` ? undefined : false; // never answers
  const update = laya.update();
  await until(() => hub.requests.includes(`${NEW}/model.onnx.data`), 'the new weights');
  await laya.remove();
  await update;
  assert.deepEqual(await laya.status(), { state: 'off', enabled: false, sizeBytes: sizeOf(shipped) });
  assert.equal(fs.existsSync(path.join(userDataDir, 'models/laya')), false);
  hub.serve = null;
  await laya.setEnabled(true);
  await laya.update();
  assert.equal(installedRevision(userDataDir), NEW);
  assert.deepEqual(stored(userDataDir), [NEW, 'installed.json']);
});

function tinyModelDirectory(t, graph = fs.readFileSync(tinyGraph)) {
  const directory = modelDirectory(t);
  fs.writeFileSync(path.join(directory, 'model.onnx'), graph);
  return directory;
}

// The real process runner, keeping each model process and a promise for its exit.
function trackedRunner() {
  const children = [];
  const fork = script => {
    const child = forkWorker(script);
    children.push({ child, exited: new Promise(resolve => child.once('exit', resolve)) });
    return child;
  };
  return { children, runner: processRunner({ fork }) };
}

test('the ONNX runner runs the graph in its own process, and releasing the model ends that process', async t => {
  const { children, runner } = trackedRunner();
  const laya = createLaya({ modelDir: tinyModelDirectory(t), modelFormat: 'noul-v1', manifest: NO_MODEL, runner, enabled: true, timeoutMs: 60000 });
  t.after(() => laya.close());
  const state = rowState('3');
  const { answers } = await laya.decide(state, { correct: DECISION, match: MATCH });
  const encoded = encodeDecision(await loadTokenizer(small), state, toQuestion(DECISION), { maxLen: 512, headMaxLen: 192 });
  const expected = probabilities(encoded.markers.map(marker => marker / 100 + encoded.ids.length / 1000 + 0.2), 2, 2, readCalibration(CONFIG));
  assert.ok(Math.abs(answers.correct.noul - expected[1]) < 1e-6);
  assert.deepEqual(Object.keys(answers.match.probabilities), MATCH.criteria);
  assert.equal(children.length, 1);
  assert.ok(children[0].child.pid > 0 && children[0].child.pid !== process.pid, 'the model runs outside the desktop process');
  await laya.setEnabled(false);
  await children[0].exited;
  await laya.setEnabled(true);
  await laya.decide(state, { correct: DECISION });
  assert.equal(children.length, 2, 'the next decision starts a new model process');
});

test('the ONNX runner can run several sessions in its one process, giving each decision the same scores', async t => {
  const children = [];
  const fork = script => { const child = forkWorker(script); children.push(child); return child; };
  const laya = createLaya({ modelDir: tinyModelDirectory(t), modelFormat: 'noul-v1', manifest: NO_MODEL, runner: processRunner({ fork, sessions: 2, threads: 1 }), enabled: true, timeoutMs: 60000 });
  t.after(() => laya.close());
  const tokenizer = await loadTokenizer(small);
  const items = Array.from({ length: 20 }, (_, index) => ({ state: rowState(`${'candidate '.repeat(index % 4)}${index}`), questions: { correct: DECISION } }));
  const results = await Promise.all([laya.decideBatch(items.slice(0, 12)), laya.decideBatch(items.slice(12))]);
  results.flat().forEach(({ answers }, index) => {
    const encoded = encodeDecision(tokenizer, items[index].state, toQuestion(DECISION), { maxLen: 512, headMaxLen: 192 });
    const expected = probabilities(encoded.markers.map(marker => marker / 100 + encoded.ids.length / 1000 + 0.2), 2, 2, readCalibration(CONFIG));
    assert.ok(Math.abs(answers.correct.noul - expected[1]) < 1e-6, `item ${index}`);
  });
  assert.equal(children.length, 1, 'both sessions live in the one model process');
  assert.throws(() => processRunner({ sessions: 0 }), /sessions/);
  assert.throws(() => processRunner({ threads: 1.5 }), /threads/);
});

test('if the model process dies, that request is refused as not ready and the next one starts a new process', async t => {
  const { children, runner } = trackedRunner();
  const laya = createLaya({ modelDir: tinyModelDirectory(t), modelFormat: 'noul-v1', manifest: NO_MODEL, runner, enabled: true, timeoutMs: 60000 });
  t.after(() => laya.close());
  await laya.decide(rowState('3'), { correct: DECISION });
  process.kill(children[0].child.pid, 'SIGKILL');
  await children[0].exited;
  const error = await laya.decide(rowState('3'), { correct: DECISION }).catch(caught => caught);
  assert.equal(error.code, LAYA_NOT_READY);
  assert.match(error.message, /stopped/);
  assert.equal((await laya.decide(rowState('3'), { correct: DECISION })).answers.correct.type, 'noul');
  assert.equal(children.length, 2);
});

test('a graph onnxruntime cannot load is reported, and its process is ended', async t => {
  const { children, runner } = trackedRunner();
  const laya = createLaya({ modelDir: tinyModelDirectory(t, Buffer.from('not an onnx graph')), modelFormat: 'noul-v1', manifest: NO_MODEL, runner, enabled: true, timeoutMs: 60000 });
  const error = await laya.decide(rowState('3'), { correct: DECISION }).catch(caught => caught);
  assert.equal(error.code, LAYA_NOT_READY);
  assert.match(error.message, /couldn’t be loaded/);
  assert.equal(children.length, 1);
  await children[0].exited;
  assert.equal((await laya.status()).state, 'error');
});
