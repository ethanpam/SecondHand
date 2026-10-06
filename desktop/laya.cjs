'use strict';

// Laya, the local decision model, inside the desktop app (#38). It answers typed `noul` and
// `choice` questions with calibrated probabilities, on this computer, from a model it downloads
// and keeps up to date while it is on. This is the runtime only: confidence bars, key limits and
// sensitive-data rules belong to its callers (#39, #42).
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { validateManifest, readInstalled, fetchManifest, ModelStore, MODEL_FILES, MODEL_FORMATS } = require('./laya-model.cjs');
const { loadTokenizer } = require('./laya-tokenizer.cjs');
const { toQuestion, encodeDecision, collate, readCalibration, probabilities, answerFor } = require('./laya-prompt.cjs');

const LAYA_NOT_READY = 'LAYA_NOT_READY';
const LAYA_TIMEOUT = 'LAYA_TIMEOUT';
// Decisions run shortest first in batches of this size. The int8 graph quantizes activations
// per batch, so ML_model/eval/runtime_fixtures.py uses the same size for its reference outputs.
const BATCH_SIZE = 8;
const UNAVAILABLE = 'No Laya model is available to download yet.';
const INCOMPATIBLE = 'A newer Laya model is available, but it needs a newer version of SecondHand.';
const REPLACED = 'The update list names a Laya model SecondHand already replaced with a newer one, so SecondHand keeps the one it has.';
const DAY_MS = 24 * 60 * 60 * 1000;
const TURNED_OFF_WHILE_LOADING = 'Laya was turned off while the model was loading.';
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

// A Mac with Apple silicon's performance cores; null elsewhere. Its efficiency cores slow onnxruntime
// down when they share its work.
function applePerformanceCores() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return null;
  const cores = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8' }).trim());
  if (!Number.isInteger(cores) || cores < 1) throw new Error('This Mac didn’t say how many performance cores it has.');
  return cores;
}

// How many onnxruntime sessions the model process runs, and the threads each one uses. One session
// keeps a many-core CPU poorly busy: its int8 matrix products run only 1.7 times faster on 10 threads
// than on 1 (#65). So a Mac with 8 or more performance cores and 16 GB or more of memory runs two
// sessions, each on half of those cores; each holds its own copy of the weights (about 0.4 GB). A
// smaller Mac runs one on its performance cores. Elsewhere (not yet measured), one session runs with
// onnxruntime's own thread count.
function sessionPlan({ performanceCores = applePerformanceCores(), memory = os.totalmem() } = {}) {
  if (performanceCores === null) return { sessions: 1 };
  if (performanceCores >= 8 && memory >= 16 * 2 ** 30) return { sessions: 2, threads: Math.floor(performanceCores / 2) };
  return { sessions: 1, threads: performanceCores };
}

// The production runner: onnxruntime-node on the CPU, in its own process (laya-worker.cjs), with
// `sessions` sessions there of `threads` threads each (unset: onnxruntime's default). Without
// `sessions`, sessionPlan() picks both for this computer.
// Ending that process is what returns the model's memory; the desktop process never loads it.
function processRunner({ fork = forkWorker, ...options } = {}) {
  const { sessions, threads } = options.sessions === undefined && options.threads === undefined ? sessionPlan() : { sessions: options.sessions ?? 1, threads: options.threads };
  if (!Number.isInteger(sessions) || sessions < 1) throw new TypeError('The Laya model process needs a whole number of sessions, 1 or more.');
  if (threads !== undefined && (!Number.isInteger(threads) || threads < 1)) throw new TypeError('Laya sessions need a whole number of threads, 1 or more.');
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
      try { await request({ type: 'load', file, sessions, threads }); } catch (error) { await end(); throw error; }
      return {
        sessions,
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

// userDataDir: where models/laya/<revision>/ lives. manifest: desktop/laya-model.json, the model
// used until another is installed. updateUrl: the model repo's latest.json, naming the newest model.
// modelDir: an exported model folder to use instead of a download (SECONDHAND_LAYA_MODEL_DIR), and
// modelFormat its prompt format (SECONDHAND_LAYA_MODEL_FORMAT).
function createLaya({ userDataDir, manifest, modelDir, modelFormat, updateUrl = null, runner = processRunner(), enabled = false, timeoutMs = 3000, idleMs = 5 * 60 * 1000, checkEveryMs = DAY_MS }) {
  const { model: shipped } = validateManifest(manifest);
  if (shipped && !MODEL_FORMATS.includes(shipped.format)) throw new Error(`The shipped Laya model’s format (${shipped.format}) isn’t one this app can run.`);
  if (modelDir !== undefined && !MODEL_FORMATS.includes(modelFormat)) {
    throw new Error(`A Laya model folder needs its prompt format, one of ${MODEL_FORMATS.join(', ')}, not ${modelFormat}.`);
  }
  const storeFor = model => new ModelStore({ userDataDir, model });
  // The model in use: the installed one (models/laya/installed.json) once read, else the shipped one.
  let store = !modelDir && shipped ? storeFor(shipped) : null;
  let installedRead = null;
  // The revisions updates replaced, kept in installed.json: latest.json naming one is refused.
  let replaced = new Set();
  // An update: downloading beside the model in use (candidate), then verified and waiting for
  // running decisions to finish (pending).
  let candidate = null;
  let pending = null;
  // What the last update check or update said, and why a saved installed.json can't be used, for
  // status(): { state: 'error' | 'incompatible', message }.
  let note = null;
  let recordNote = null;
  // The update run and its abort controller, whether it is still before any download, and the model download.
  let updating = null;
  let running = null;
  let preparing = false;
  let downloading = null;
  let updateTimer = null;
  let closed = false;
  let on = enabled === true;
  let loaded = null;
  let loading = null;
  let loadFailure = null;
  let generation = 0;
  let active = 0;
  let idleTimer = null;
  // Batches waiting for a session, oldest first, and how many are running.
  const waiting = [];
  let runningBatches = 0;

  const unavailableReason = () => runner.supported === false ? UNSUPPORTED : !modelDir && !store ? UNAVAILABLE : null;
  // Deletes everything under models/laya but the model in use and an update on its way.
  const prune = () => store.removeOthers([pending?.model.revision, candidate?.model.revision].filter(Boolean));

  // Reads which model is installed, once. A record this app can't use leaves the shipped model in
  // place, and status() says why; a file that can't be read at all fails status() itself.
  function init() {
    if (!store) return Promise.resolve();
    const before = store;
    installedRead ??= readInstalled(userDataDir).then(record => {
      if (!record || store !== before) return;
      replaced = new Set(record.replaced);
      const { model } = record;
      if (MODEL_FORMATS.includes(model.format)) store = storeFor(model);
      else recordNote = { state: 'incompatible', message: 'The installed Laya model needs a newer version of SecondHand, so SecondHand uses one it can run.' };
    }, error => {
      if (error.code) { installedRead = null; throw error; }
      recordNote = { state: 'error', message: `SecondHand couldn’t read which Laya model is installed (${error.message}), so it uses the one it shipped with.` };
    });
    return installedRead;
  }

  async function updateStatus() {
    const next = candidate;
    if (next?.active) return { state: 'downloading', progress: (await next.state()).progress, sizeBytes: next.sizeBytes };
    return note ?? recordNote;
  }

  async function status() {
    const unavailable = unavailableReason();
    if (unavailable) return { state: 'unavailable', enabled: on, message: unavailable };
    if (!on) return store ? { state: 'off', enabled: on, sizeBytes: store.sizeBytes } : { state: 'off', enabled: on };
    if (store) {
      await init();
      let state = await store.state();
      // A download lasts until its model is recorded as installed. With nothing installed, an update
      // run that hasn't started it yet is about to, so that counts too.
      if (downloading || (preparing && state.state !== 'ready')) state = { state: 'downloading', progress: state.state === 'ready' ? 1 : state.progress ?? 0 };
      const result = loadFailure && state.state === 'ready' ? { state: 'error', enabled: on, sizeBytes: store.sizeBytes, message: loadFailure } :
        { ...state, enabled: on, sizeBytes: store.sizeBytes };
      const update = await updateStatus();
      return update ? { ...result, update } : result;
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

  // Reads the model's tokenizer and config, then starts its process. Laya turned off (or the model
  // released) during a load stops it before the process starts, or releases the model it loaded.
  async function load() {
    const loadGeneration = generation;
    const stopped = () => loadGeneration !== generation || !on;
    const failed = error => {
      loadFailure = `The Laya model couldn’t be loaded (${error.message}).`;
      return notReady(loadFailure);
    };
    let directory = modelDir;
    let format = modelFormat;
    if (store) {
      await init();
      const current = store;
      format = current.model.format;
      if ((await current.state()).state !== 'ready') throw notReady('The Laya model isn’t downloaded yet.');
      try { directory = await current.verify(); } catch (error) { throw notReady(error.publicMessage || error.message); }
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
      result = { tokenizer, limits, format, calibration: readCalibration(config) };
    } catch (error) { throw failed(error); }
    if (stopped()) throw notReady(TURNED_OFF_WHILE_LOADING);
    try { result.model = await runner.load(path.join(directory, 'model.onnx')); } catch (error) { throw failed(error); }
    if (stopped()) {
      await result.model.release();
      throw notReady(TURNED_OFF_WHILE_LOADING);
    }
    loadFailure = null;
    return result;
  }

  function refuseIfOff() {
    const unavailable = unavailableReason();
    if (unavailable) throw notReady(unavailable);
    if (!on) throw notReady('Laya is turned off. Turn on “Find more fields with Laya” in SecondHand.');
  }

  async function ready() {
    refuseIfOff();
    if (loaded) return loaded;
    if (!loading) loading = load().then(result => { loaded = result; return result; }).finally(() => { loading = null; });
    return loading;
  }

  // Batches go through the model in the order they were asked, one per session at a time, so memory
  // stays bounded. A batch whose request has ended is dropped (null) instead of run. A failed run
  // still lets the next one start; its error reaches its own caller through the returned promise.
  function runQueued(model, batch, request) {
    return new Promise((resolve, reject) => {
      waiting.push({ model, batch, request, resolve, reject });
      startWaiting();
    });
  }
  function startWaiting() {
    while (waiting.length && runningBatches < (waiting[0].model.sessions ?? 1)) {
      const next = waiting.shift();
      if (next.request.expired) { next.resolve(null); continue; }
      runningBatches++;
      next.model.run(next.batch).then(next.resolve, next.reject).finally(() => { runningBatches--; startWaiting(); });
    }
  }

  // The prompt format of the model decisions run on: the loaded model's, else the one that loads next.
  async function format() {
    refuseIfOff();
    if (loaded) return loaded.format;
    if (!store) return modelFormat;
    await init();
    return store.model.format;
  }

  async function decideAll(items, request, wanted) {
    const checked = checkItems(items);
    if (!checked.length) return [];
    const session = await ready();
    // Prompts written for one format mean nothing to a model of another, such as after an update.
    if (wanted && session.format !== wanted) throw notReady('The Laya model changed while this form was being checked. Click Autofill again.');
    const decisions = [];
    checked.forEach((item, index) => {
      for (const { id, question } of item.questions) {
        decisions.push({ index, id, question, ...encodeDecision(session.tokenizer, item.state, question, session.limits) });
      }
    });
    const order = decisions.map((_, index) => index).sort((a, b) => decisions[a].ids.length - decisions[b].ids.length);
    const chunks = [];
    for (let start = 0; start < order.length; start += BATCH_SIZE) chunks.push(order.slice(start, start + BATCH_SIZE).map(index => decisions[index]));
    if (request.expired) return null;
    // Every batch is queued at once; the model's sessions take them in order.
    const ran = await Promise.all(chunks.map(async chunk => {
      const batch = collate(chunk, session.tokenizer.padId);
      let output;
      try { output = await runQueued(session.model, batch, request); } catch (error) {
        // The model is dropped so the next request starts from a fresh load.
        if (loaded === session) await release();
        throw notReady(`The Laya model stopped (${error.message}). It will load again on the next request.`);
      }
      if (output === null) return false;
      const { data, dims } = output;
      if (dims[0] !== batch.rows || dims[1] !== batch.count || !data.every(Number.isFinite)) {
        throw new RangeError('Laya returned scores of the wrong shape or non-finite scores.');
      }
      chunk.forEach((decision, row) => {
        const values = probabilities(data.subarray(row * batch.count, (row + 1) * batch.count), decision.markers.length, decision.qtype, session.calibration);
        decision.answer = answerFor(decision.question, values);
      });
      return true;
    }));
    if (!ran.every(Boolean)) return null;
    const results = checked.map(() => ({ answers: {} }));
    for (const decision of decisions) results[decision.index].answers[decision.id] = decision.answer;
    return results;
  }

  // When the last request ends, a verified update is switched to, or the idle clock starts: the
  // model is released after idleMs.
  function settle() {
    if (--active > 0) return;
    if (pending) switchWhenIdle().catch(error => { note = { state: 'error', message: `Update failed: ${error.message}` }; });
    else if (loaded) {
      idleTimer = setTimeout(() => { if (active === 0) release(); }, idleMs);
      idleTimer.unref?.();
    }
  }

  // Switches to a verified update once no decision is running; a running one finishes on the old
  // model. The old model is released before its files are deleted (Windows can't delete open files).
  async function switchWhenIdle() {
    if (!pending || active > 0) return;
    store = pending;
    pending = null;
    loadFailure = null;
    await release();
    await prune();
  }

  // The model download: once every file arrived and matched, it is recorded as the installed model
  // and the rest of models/laya is deleted. Failures show in status(); it never rejects.
  function download() {
    downloading ??= (async () => {
      const target = store;
      if (!on || closed) return;
      await target.startDownload();
      if (target !== store || (await target.state()).state !== 'ready') return;
      // The shipped model, used when the installed one needs a newer app, may be one an update replaced.
      const kept = new Set(replaced);
      kept.delete(target.model.revision);
      await target.install([...kept]);
      replaced = kept;
      recordNote = null;
      await prune();
    })().catch(error => {
      note = { state: 'error', message: error.publicMessage || `The Laya model couldn’t be installed (${error.code || error.message}).` };
    }).finally(() => { downloading = null; });
    return downloading;
  }

  // Reads latest.json: { model }, the model null when there's no update URL, when latest.json names
  // none, or when its model is in a format this app can't run or is one an update replaced (the note
  // says so). Null when the check failed; the note says why.
  async function checkLatest(signal) {
    if (!updateUrl) return { model: null };
    try {
      const { model } = await fetchManifest(updateUrl, signal);
      note = !model ? null : !MODEL_FORMATS.includes(model.format) ? { state: 'incompatible', message: INCOMPATIBLE } :
        replaced.has(model.revision) ? { state: 'error', message: REPLACED } : null;
      return { model: note ? null : model };
    } catch (error) {
      if (!signal.aborted) note = { state: 'error', message: error.publicMessage || `Update check failed: ${error.message}` };
      return null;
    }
  }

  // A newer model downloads beside the one in use, which keeps answering. Once every file is
  // verified it is recorded as installed, and Laya switches to it when no decision is running.
  // A failed download keeps what verified and says why; the next check tries again.
  async function downloadUpdate(model) {
    if (candidate?.model.revision !== model.revision) {
      await candidate?.cancel();
      candidate = storeFor(model);
    }
    const next = candidate;
    if (!on || closed) return;
    await next.startDownload();
    if (next !== candidate || !on || closed) return;
    const { state, message } = await next.state();
    if (state === 'error') note = { state: 'error', message: `Update download failed: ${message}` };
    if (state !== 'ready') return;
    try { await next.verify(); } catch (error) {
      note = { state: 'error', message: `Update download failed: ${error.publicMessage || error.message}` };
      return;
    }
    if (next !== candidate || !on || closed) return;
    // The installed model, in use or waiting to be switched to, is replaced and never installed again.
    const after = new Set(replaced).add((pending ?? store).model.revision);
    await next.install([...after]);
    replaced = after;
    recordNote = null;
    candidate = null;
    pending = next;
    await switchWhenIdle();
  }

  // Turning Laya off, closing, or pausing the download aborts `signal`.
  async function runUpdate(signal) {
    preparing = true;
    try {
      await init();
      const checked = await checkLatest(signal);
      const latest = checked?.model ?? null;
      if (signal.aborted) return;
      if ((await store.state()).state !== 'ready') {
        // Nothing is installed: download the newest model this app can run, else the shipped one.
        await candidate?.cancel();
        candidate = null;
        if (signal.aborted) return;
        if (latest && latest.revision !== store.model.revision && !store.active) store = storeFor(latest);
        preparing = false;
        await download();
        return;
      }
      preparing = false;
      if (latest && latest.revision !== (pending ?? store).model.revision) { await downloadUpdate(latest); return; }
      // A failed check deletes nothing: an update download left from before a restart may be the
      // newest model, and the next check that works resumes or deletes it.
      if (!checked) return;
      // Up to date, or latest.json names nothing to install: whatever is left over is deleted,
      // except an update download latest.json didn't rule out.
      if (latest) {
        await candidate?.cancel();
        candidate = null;
      }
      if (!pending) await prune();
    } finally {
      preparing = false;
    }
  }

  // Brings the model up to date, one run at a time, and only while Laya is on: reads latest.json;
  // downloads a model when none is installed (the newest this app can run, else the shipped one);
  // otherwise downloads a newer model beside the installed one and switches to it. Newer means
  // another revision than the installed one, and not one an update replaced. It never rejects:
  // failures show in status(), and the installed model keeps working.
  function update() {
    if (unavailableReason() || !store || !on || closed) return Promise.resolve();
    if (!updating) {
      const controller = new AbortController();
      running = controller;
      updating = runUpdate(controller.signal).catch(error => { note = { state: 'error', message: `Update failed: ${error.publicMessage || error.message}` }; })
        .finally(() => { updating = null; if (running === controller) running = null; });
    }
    return updating;
  }

  async function turnOff() {
    on = false;
    loadFailure = null;
    running?.abort();
    await store?.cancel();
    await candidate?.cancel();
    await release();
  }

  // A first request after idle waits for process start, checksum, and load: seconds, more than a
  // request's timeout. Warming does that ahead of the request. It refuses like a decision.
  async function warm() {
    active++;
    clearTimeout(idleTimer);
    try { await ready(); } finally { settle(); }
  }

  // `format`, when given, is the prompt format the items are written in; a model of another is refused.
  // `timeoutMs`, when given, ends this request sooner than the runtime's own timeout, such as when an
  // Autofill click has less time left.
  async function decideBatch(items, { format: wanted, timeoutMs: within } = {}) {
    if (wanted !== undefined && !MODEL_FORMATS.includes(wanted)) throw new TypeError(`Laya decisions can only be written in a format this app runs (${MODEL_FORMATS.join(', ')}).`);
    if (within !== undefined && (!Number.isInteger(within) || within < 1)) throw new TypeError('A Laya request’s timeout must be whole milliseconds, 1 or more.');
    const limit = Math.min(within ?? timeoutMs, timeoutMs);
    const request = { expired: false };
    active++;
    clearTimeout(idleTimer);
    const work = decideAll(items, request, wanted).finally(settle);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { request.expired = true; reject(failure(LAYA_TIMEOUT, `Laya took too long (over ${limit} ms).`)); }, limit);
      timer.unref?.();
    });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
  }

  return {
    status,
    format,
    decide: async (state, questions, options) => (await decideBatch([{ state, questions }], options))[0],
    decideBatch,
    warm,
    // Off stops a check or download (keeping what arrived) and releases the model.
    async setEnabled(value) {
      if (value === true) { on = true; loadFailure = null; } else await turnOff();
    },
    // Starts or resumes the download; the promise settles when it stops (see status()).
    startDownload() {
      const unavailable = unavailableReason();
      if (unavailable) throw new Error(unavailable);
      if (!store) throw new Error('Laya is using the model folder set by SECONDHAND_LAYA_MODEL_DIR, so there is nothing to download.');
      if (!on) throw new Error('Turn on Laya before downloading its model.');
      loadFailure = null;
      return init().then(download, error => { note = { state: 'error', message: `The Laya model couldn’t be downloaded (${error.code || error.message}).` }; });
    },
    // Pauses the model download, or an update run about to start it. An update download beside an
    // installed model goes on.
    async cancelDownload() {
      running?.abort();
      await store?.cancel();
      await downloading;
    },
    update,
    // Checks now and then every checkEveryMs (24 hours) until close(); a check does nothing while Laya is off.
    startUpdates() {
      if (!updateTimer && !closed) {
        updateTimer = setInterval(update, checkEveryMs);
        updateTimer.unref?.();
      }
      return update();
    },
    // Turns Laya off and deletes every downloaded model, so nothing is downloaded again until it is
    // turned on. Nothing else in userData is touched.
    async remove() {
      await turnOff();
      await updating;
      await downloading;
      candidate = null;
      pending = null;
      note = null;
      recordNote = null;
      replaced = new Set();
      if (!store) return;
      const removing = store;
      store = storeFor(shipped);
      installedRead = Promise.resolve();
      await removing.remove();
    },
    async close() {
      closed = true;
      clearInterval(updateTimer);
      running?.abort();
      await store?.cancel();
      await candidate?.cancel();
      await release();
    }
  };
}

module.exports = { createLaya, processRunner, sessionPlan, forkWorker, LAYA_NOT_READY, LAYA_TIMEOUT, BATCH_SIZE };
