'use strict';

// Laya, the local decision model, inside the desktop app (#38). It answers typed `noul` and
// `choice` questions with calibrated probabilities, on this computer, from a model the person
// chose to download. This is the runtime only: confidence bars, key limits and sensitive-data
// rules belong to its callers (#39, #42).
const fs = require('node:fs/promises');
const path = require('node:path');
const { validateManifest, ModelStore, MODEL_FILES } = require('./laya-model.cjs');
const { loadTokenizer } = require('./laya-tokenizer.cjs');
const { toQuestion, encodeDecision, collate, readCalibration, probabilities, answerFor } = require('./laya-prompt.cjs');

const LAYA_NOT_READY = 'LAYA_NOT_READY';
const LAYA_TIMEOUT = 'LAYA_TIMEOUT';
// Decisions run shortest first in batches of this size. The int8 graph quantizes activations
// per batch, so ML_model/eval/runtime_fixtures.py uses the same size for its reference outputs.
const BATCH_SIZE = 8;
const UNAVAILABLE = 'No Laya model is available to download yet.';
const UNSUPPORTED = 'Laya can’t run on this computer. It needs Windows, Linux, or a Mac with Apple silicon.';
// Platforms onnxruntime-node ships a native build for.
const SUPPORTED_PLATFORMS = new Set(['darwin-arm64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']);

const failure = (code, message) => Object.assign(new Error(message), { code, publicMessage: message });
const notReady = message => failure(LAYA_NOT_READY, message);

const WORKER = path.join(__dirname, 'laya-worker.cjs');

// The model process: an Electron utility process in the app, a Node child process elsewhere.
function forkWorker(script) {
  if (process.versions.electron && process.type === 'browser') return require('electron').utilityProcess.fork(script, [], { serviceName: 'SecondHand Laya' });
  const child = require('node:child_process').fork(script, [], { serialization: 'advanced' });
  return { get pid() { return child.pid; }, postMessage: message => child.send(message),
    on: (event, listener) => child.on(event, listener), once: (event, listener) => child.once(event, listener), kill: () => child.kill() };
}

// The production runner: onnxruntime-node on the CPU, in its own process (laya-worker.cjs).
// Ending that process is what returns the model's memory; the desktop process never loads it.
function processRunner({ fork = forkWorker } = {}) {
  return {
    supported: SUPPORTED_PLATFORMS.has(`${process.platform}-${process.arch}`),
    async load(file) {
      const child = fork(WORKER);
      const waiting = new Map();
      let stopped = null;
      let nextId = 0;
      const stop = error => {
        stopped = error;
        for (const waiter of waiting.values()) waiter.reject(error);
        waiting.clear();
      };
      child.on('message', message => {
        const key = message.id ?? 'load';
        const waiter = waiting.get(key);
        if (!waiter) return;
        waiting.delete(key);
        if (message.type === 'error') waiter.reject(new Error(message.message)); else waiter.resolve(message);
      });
      child.on('exit', (code, signal) => stop(new Error(`the model process stopped (${signal || `exit code ${code}`})`)));
      child.on('error', error => stop(error instanceof Error ? error : new Error(`the model process failed (${error})`)));
      const request = message => new Promise((resolve, reject) => {
        if (stopped) { reject(stopped); return; }
        waiting.set(message.id ?? 'load', { resolve, reject });
        child.postMessage(message);
      });
      const end = () => stopped ? Promise.resolve() : new Promise(resolve => { child.once('exit', resolve); child.kill(); });
      try { await request({ type: 'load', file }); } catch (error) { await end(); throw error; }
      return {
        async run(batch) {
          const { data, dims } = await request({ type: 'run', id: ++nextId, batch });
          return { data, dims };
        },
        release: end
      };
    }
  };
}

async function missingFiles(directory) {
  const missing = [];
  for (const name of MODEL_FILES) {
    try { if (!(await fs.stat(path.join(directory, name))).isFile()) missing.push(name); }
    catch (error) { if (error.code === 'ENOENT') missing.push(name); else throw error; }
  }
  return missing;
}

async function folderSize(directory) {
  let total = 0;
  for (const name of MODEL_FILES) total += (await fs.stat(path.join(directory, name))).size;
  return total;
}

function checkItems(items) {
  if (!Array.isArray(items)) throw new TypeError('Laya decisions must be an array of { state, questions }.');
  return items.map(item => {
    const questions = item?.questions;
    if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) {
      throw new TypeError('Each Laya decision needs at least one question.');
    }
    return { state: item.state, questions: Object.entries(questions).map(([id, definition]) => ({ id, question: toQuestion(definition) })) };
  });
}

// userDataDir: where models/laya/<revision>/ lives. manifest: desktop/laya-model.json.
// modelDir: an exported model folder to use instead of a download (SECONDHAND_LAYA_MODEL_DIR).
function createLaya({ userDataDir, manifest, modelDir, runner = processRunner(), enabled = false, timeoutMs = 3000, idleMs = 5 * 60 * 1000 }) {
  const { model } = validateManifest(manifest);
  const store = !modelDir && model ? new ModelStore({ userDataDir, model }) : null;
  let on = enabled === true;
  let loaded = null;
  let loading = null;
  let loadFailure = null;
  let generation = 0;
  let active = 0;
  let idleTimer = null;
  let queue = Promise.resolve();

  const unavailableReason = () => runner.supported === false ? UNSUPPORTED : !modelDir && !store ? UNAVAILABLE : null;

  async function status() {
    const unavailable = unavailableReason();
    if (unavailable) return { state: 'unavailable', enabled: on, message: unavailable };
    if (!on) return store ? { state: 'off', enabled: on, sizeBytes: store.sizeBytes } : { state: 'off', enabled: on };
    if (store) {
      const state = await store.state();
      return loadFailure && state.state === 'ready' ? { state: 'error', enabled: on, sizeBytes: store.sizeBytes, message: loadFailure } :
        { ...state, enabled: on, sizeBytes: store.sizeBytes };
    }
    const missing = await missingFiles(modelDir);
    if (missing.length) return { state: 'error', enabled: on, message: `The Laya model folder is missing ${missing.join(', ')}.` };
    const sizeBytes = await folderSize(modelDir);
    return loadFailure ? { state: 'error', enabled: on, sizeBytes, message: loadFailure } : { state: 'ready', enabled: on, sizeBytes };
  }

  async function release() {
    clearTimeout(idleTimer);
    const current = loaded;
    loaded = null;
    generation++;
    if (current) await current.model.release();
  }

  async function load() {
    const loadGeneration = generation;
    let directory = modelDir;
    if (store) {
      if ((await store.state()).state !== 'ready') throw notReady('The Laya model isn’t downloaded yet.');
      try { directory = await store.verify(); } catch (error) { throw notReady(error.publicMessage || error.message); }
    } else {
      const missing = await missingFiles(modelDir);
      if (missing.length) throw notReady(`The Laya model folder is missing ${missing.join(', ')}.`);
    }
    let result;
    try {
      const [config, tokenizer] = await Promise.all([
        fs.readFile(path.join(directory, 'rl_agent_config.json'), 'utf8').then(JSON.parse),
        loadTokenizer(path.join(directory, 'tokenizer'))
      ]);
      const limits = { maxLen: config.max_len ?? 512, headMaxLen: config.head_max_len ?? 192 };
      if (!Number.isInteger(limits.maxLen) || !Number.isInteger(limits.headMaxLen) || !(limits.headMaxLen > 4 && limits.headMaxLen < limits.maxLen)) {
        throw new Error('its token limits are invalid');
      }
      result = { tokenizer, limits, calibration: readCalibration(config), model: await runner.load(path.join(directory, 'model.onnx')) };
    } catch (error) {
      loadFailure = `The Laya model couldn’t be loaded (${error.message}).`;
      throw notReady(loadFailure);
    }
    if (loadGeneration !== generation || !on) {
      await result.model.release();
      throw notReady('Laya was turned off while the model was loading.');
    }
    loadFailure = null;
    return result;
  }

  async function ready() {
    const unavailable = unavailableReason();
    if (unavailable) throw notReady(unavailable);
    if (!on) throw notReady('Laya is turned off. Turn on “Find more fields with Laya” in SecondHand.');
    if (loaded) return loaded;
    if (!loading) loading = load().then(result => { loaded = result; return result; }).finally(() => { loading = null; });
    return loading;
  }

  // One batch at a time through the model, so memory stays bounded. A failed run still lets
  // the next one start; its error reaches its own caller through the returned promise.
  function runQueued(model, batch) {
    const run = queue.then(() => model.run(batch));
    queue = run.then(() => {}, () => {});
    return run;
  }

  async function decideAll(items, request) {
    const checked = checkItems(items);
    if (!checked.length) return [];
    const session = await ready();
    const decisions = [];
    checked.forEach((item, index) => {
      for (const { id, question } of item.questions) {
        decisions.push({ index, id, question, ...encodeDecision(session.tokenizer, item.state, question, session.limits) });
      }
    });
    const order = decisions.map((_, index) => index).sort((a, b) => decisions[a].ids.length - decisions[b].ids.length);
    for (let start = 0; start < order.length; start += BATCH_SIZE) {
      if (request.expired) return null;
      const chunk = order.slice(start, start + BATCH_SIZE).map(index => decisions[index]);
      const batch = collate(chunk, session.tokenizer.padId);
      let output;
      try { output = await runQueued(session.model, batch); } catch (error) {
        // The model is dropped so the next request starts from a fresh load.
        if (loaded === session) await release();
        throw notReady(`The Laya model stopped (${error.message}). It will load again on the next request.`);
      }
      const { data, dims } = output;
      if (dims[0] !== batch.rows || dims[1] !== batch.count || !data.every(Number.isFinite)) {
        throw new RangeError('Laya returned scores of the wrong shape or non-finite scores.');
      }
      chunk.forEach((decision, row) => {
        const values = probabilities(data.subarray(row * batch.count, (row + 1) * batch.count), decision.markers.length, decision.qtype, session.calibration);
        decision.answer = answerFor(decision.question, values);
      });
    }
    const results = checked.map(() => ({ answers: {} }));
    for (const decision of decisions) results[decision.index].answers[decision.id] = decision.answer;
    return results;
  }

  // When the last request ends, the idle clock starts: the model is released after idleMs.
  function settle() {
    if (--active === 0 && loaded) {
      idleTimer = setTimeout(() => { if (active === 0) release(); }, idleMs);
      idleTimer.unref?.();
    }
  }

  // A first request after idle waits for process start, checksum, and load: seconds, more than a
  // request's timeout. Warming does that ahead of the request. It refuses like a decision.
  async function warm() {
    active++;
    clearTimeout(idleTimer);
    try { await ready(); } finally { settle(); }
  }

  async function decideBatch(items) {
    const request = { expired: false };
    active++;
    clearTimeout(idleTimer);
    const work = decideAll(items, request).finally(settle);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { request.expired = true; reject(failure(LAYA_TIMEOUT, `Laya took too long (over ${timeoutMs} ms).`)); }, timeoutMs);
      timer.unref?.();
    });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
  }

  return {
    status,
    decide: async (state, questions) => (await decideBatch([{ state, questions }]))[0],
    decideBatch,
    warm,
    // Off stops a download (keeping what arrived) and releases the model.
    async setEnabled(value) {
      on = value === true;
      loadFailure = null;
      if (!on) { await store?.cancel(); await release(); }
    },
    // Starts or resumes the download; the promise settles when it stops (see status()).
    startDownload() {
      const unavailable = unavailableReason();
      if (unavailable) throw new Error(unavailable);
      if (!store) throw new Error('Laya is using the model folder set by SECONDHAND_LAYA_MODEL_DIR, so there is nothing to download.');
      if (!on) throw new Error('Turn on Laya before downloading its model.');
      loadFailure = null;
      return store.startDownload();
    },
    cancelDownload: async () => { await store?.cancel(); },
    async remove() {
      await release();
      loadFailure = null;
      await store?.remove();
    },
    async close() {
      await store?.cancel();
      await release();
    }
  };
}

module.exports = { createLaya, processRunner, forkWorker, LAYA_NOT_READY, LAYA_TIMEOUT, BATCH_SIZE };
