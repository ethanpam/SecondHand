'use strict';

// Runs the Laya ONNX session in a process of its own (an Electron utility process in the app,
// a Node child process in tests). A native failure cannot take down the desktop app, and
// ending this process when Laya goes idle returns all of the model's memory to the system.
const ort = require('onnxruntime-node');

const port = process.parentPort;
const send = message => port ? port.postMessage(message) : process.send(message);
let session = null;

async function handle(message) {
  try {
    if (message.type === 'load') {
      session = await ort.InferenceSession.create(message.file, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
      send({ type: 'loaded' });
    } else if (message.type === 'run') {
      if (!session) throw new Error('The model is not loaded.');
      const { rows, length, count } = message.batch;
      const { logits } = await session.run({
        input_ids: new ort.Tensor('int64', message.batch.inputIds, [rows, length]),
        attention_mask: new ort.Tensor('int64', message.batch.attentionMask, [rows, length]),
        marker_pos: new ort.Tensor('int64', message.batch.markerPos, [rows, count]),
        marker_mask: new ort.Tensor('bool', message.batch.markerMask, [rows, count]),
        qtype: new ort.Tensor('int64', message.batch.qtype, [rows])
      });
      send({ type: 'result', id: message.id, data: logits.data, dims: logits.dims });
    } else throw new Error(`Unknown request ${JSON.stringify(message.type)}.`);
  } catch (error) {
    send({ type: 'error', id: message.id, message: error.message });
  }
}

if (port) port.on('message', event => handle(event.data));
else process.on('message', handle);
