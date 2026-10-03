'use strict';

// Runs the Laya ONNX sessions in a process of its own (an Electron utility process in the app,
// a Node child process in tests). A native failure cannot take down the desktop app, and
// ending this process when Laya goes idle returns all of the model's memory to the system.
// Each session runs on a thread of its own here, so batches can run on several at once (#65);
// this thread only hands batches to sessions that are free, oldest first.
const { Worker, isMainThread, parentPort: threadPort, workerData } = require('node:worker_threads');

if (!isMainThread) {
  // One session. Its arena and memory patterns are off, so its working memory follows the batch
  // it is running rather than the largest it has run.
  const ort = require('onnxruntime-node');
  const { file, threads } = workerData;
  const options = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
  if (threads !== undefined) options.intraOpNumThreads = threads;
  ort.InferenceSession.create(file, options).then(session => {
    threadPort.on('message', async ({ id, batch }) => {
      try {
        const { rows, length, count } = batch;
        const { logits } = await session.run({
          input_ids: new ort.Tensor('int64', batch.inputIds, [rows, length]),
          attention_mask: new ort.Tensor('int64', batch.attentionMask, [rows, length]),
          marker_pos: new ort.Tensor('int64', batch.markerPos, [rows, count]),
          marker_mask: new ort.Tensor('bool', batch.markerMask, [rows, count]),
          qtype: new ort.Tensor('int64', batch.qtype, [rows])
        });
        threadPort.postMessage({ type: 'result', id, data: logits.data, dims: logits.dims });
      } catch (error) {
        threadPort.postMessage({ type: 'error', id, message: error.message });
      }
    });
    threadPort.postMessage({ type: 'loaded' });
  }, error => threadPort.postMessage({ type: 'error', message: error.message }));
} else {
  const port = process.parentPort;
  const send = message => port ? port.postMessage(message) : process.send(message);
  let sessions = null;
  const free = [];
  const waiting = [];

  const start = () => {
    while (free.length && waiting.length) {
      const session = free.shift();
      const message = waiting.shift();
      session.busy = message.id;
      session.thread.postMessage({ id: message.id, batch: message.batch });
    }
  };

  // Starts `count` sessions; resolves once every one has loaded, rejects with the first failure.
  const load = (file, count, threads) => new Promise((resolve, reject) => {
    let loaded = 0;
    sessions = Array.from({ length: count }, () => ({ thread: new Worker(__filename, { workerData: { file, threads } }), busy: null }));
    for (const session of sessions) {
      session.thread.on('message', message => {
        if (message.type === 'loaded') {
          free.push(session);
          if (++loaded === count) resolve();
          return;
        }
        if (message.id === undefined) { reject(new Error(message.message)); return; }
        session.busy = null;
        free.push(session);
        send(message);
        start();
      });
      // A session that dies leaves the model incomplete: the process ends, and the desktop loads it again.
      session.thread.on('error', error => {
        reject(error);
        if (session.busy !== null) send({ type: 'error', id: session.busy, message: error.message });
        process.exit(1);
      });
    }
  });

  async function handle(message) {
    try {
      if (message.type === 'load') {
        if (sessions) throw new Error('The model is already loaded.');
        await load(message.file, message.sessions ?? 1, message.threads);
        send({ type: 'loaded' });
      } else if (message.type === 'run') {
        if (!sessions) throw new Error('The model is not loaded.');
        waiting.push(message);
        start();
      } else throw new Error(`Unknown request ${JSON.stringify(message.type)}.`);
    } catch (error) {
      send({ type: 'error', id: message.id, message: error.message });
    }
  }

  if (port) port.on('message', event => handle(event.data));
  else process.on('message', handle);
}
