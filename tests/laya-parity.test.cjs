'use strict';

// The real int8 ONNX models through the desktop runtime, against Python reference outputs made by
// ML_model/eval/runtime_fixtures.py from the same exports. One set of outputs per model format the
// app runs, each checked against its own export, named by its own variable:
//   SECONDHAND_LAYA_NOUL_MODEL_DIR    noul-v1, the shipped model (round 2)
//   SECONDHAND_LAYA_CHOICE_MODEL_DIR  choice-v2 (round 4)
// e.g. SECONDHAND_LAYA_NOUL_MODEL_DIR=~/Projects/LayaStudio/workspace/exports/<name> node --test tests/laya-parity.test.cjs
// A set whose variable isn't set is skipped, and says so.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createLaya, processRunner, forkWorker } = require('../desktop/laya.cjs');
const { MODEL_FORMATS } = require('../desktop/laya-model.cjs');
const { loadTokenizer } = require('../desktop/laya-tokenizer.cjs');
const { toQuestion, encodeDecision } = require('../desktop/laya-prompt.cjs');

const SETS = [
  { format: 'noul-v1', fixture: 'parity-noul.json', env: 'SECONDHAND_LAYA_NOUL_MODEL_DIR' },
  { format: 'choice-v2', fixture: 'parity-choice.json', env: 'SECONDHAND_LAYA_CHOICE_MODEL_DIR' }
];
const NO_MODEL = { version: 1, model: null };
const TOLERANCE = 1e-3;
// Probabilities in option order: a choice answer is keyed by label, and JavaScript lists number-like keys first.
const values = (answer, definition) => answer.type === 'noul' ? [1 - answer.noul, answer.noul] : definition.criteria.map(label => answer.probabilities[label]);
const only = decision => Object.values(decision.questions)[0];
const maxGap = (rows, key) => Math.max(...rows.map(({ js, decision }) => Math.max(...js.map((value, index) => Math.abs(value - decision[key][index])))));
const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)];
const megabytes = bytes => `${Math.round(bytes / 1e6)} MB`;
const load = fixture => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/laya', fixture), 'utf8'));

test('every model format the app runs has its own reference outputs, made from a model of that format', () => {
  assert.deepEqual(SETS.map(set => set.format), [...MODEL_FORMATS]);
  for (const { format, fixture } of SETS) assert.equal(load(fixture).format, format, fixture);
  assert.equal(new Set(SETS.map(set => set.env)).size, SETS.length, 'each export has its own variable');
});

for (const { format, fixture, env } of SETS) {
  const parity = load(fixture);
  const modelDir = process.env[env];
  const skip = modelDir ? false : `${env} is not set, so the ${format} real-model parity checks are skipped.`;

  test(`${format}: the export is the one the reference outputs were made from`, { skip }, () => {
    for (const [name, expected] of Object.entries(parity.export.files)) {
      const bytes = fs.readFileSync(path.join(modelDir, name));
      assert.equal(bytes.length, expected.size, name);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected.sha256, `${name} differs from the export the fixture was made from`);
    }
  });

  test(`${format}: token ids and prompts match Python exactly on the real tokenizer`, { skip }, async () => {
    const tokenizer = await loadTokenizer(path.join(modelDir, 'tokenizer'));
    for (const { text, ids } of parity.strings) assert.deepEqual(tokenizer.encode(text), ids, JSON.stringify(text));
    for (const decision of parity.decisions) {
      const [definition] = Object.values(decision.questions);
      const { ids, markers } = encodeDecision(tokenizer, decision.state, toQuestion(definition), { maxLen: 512, headMaxLen: 192 });
      assert.equal(ids.length, decision.length);
      assert.equal(crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex'), decision.idsSha256);
      assert.deepEqual(markers, decision.markers);
    }
  });

  test(`${format}: probabilities match Python onnxruntime on the same int8 model within 1e-3, one by one and batched`, { skip, timeout: 10 * 60 * 1000 }, async t => {
    const laya = createLaya({ modelDir, modelFormat: format, manifest: NO_MODEL, enabled: true, timeoutMs: 5 * 60 * 1000 });
    t.after(() => laya.close());
    const single = [];
    for (const decision of parity.decisions) {
      const { answers } = await laya.decide(decision.state, decision.questions);
      single.push({ js: values(Object.values(answers)[0], only(decision)), decision });
    }
    const batched = (await laya.decideBatch(parity.decisions.map(({ state, questions }) => ({ state, questions }))))
      .map(({ answers }, index) => ({ js: values(Object.values(answers)[0], only(parity.decisions[index])), decision: parity.decisions[index] }));
    const gaps = { single: maxGap(single, 'onnx'), batched: maxGap(batched, 'onnxBatched'), mlx: maxGap(single, 'mlxBfloat16'), mlxBatched: maxGap(batched, 'mlxBfloat16') };
    t.diagnostic(`${parity.decisions.length} decisions. JS vs Python ONNX int8: ${gaps.single.toExponential(2)} one by one, ${gaps.batched.toExponential(2)} batched. JS vs MLX bfloat16: ${gaps.mlx.toExponential(2)} one by one, ${gaps.mlxBatched.toExponential(2)} batched.`);
    assert.ok(gaps.single < TOLERANCE, `one-by-one gap ${gaps.single}`);
    assert.ok(gaps.batched < TOLERANCE, `batched gap ${gaps.batched}`);
    for (const { js, decision } of single) assert.equal(js.indexOf(Math.max(...js)), decision.onnx.indexOf(Math.max(...decision.onnx)));
  });

  test(`${format}: 20 decisions: latency, memory, and the model process ended after the idle timeout`, { skip, timeout: 10 * 60 * 1000 }, async t => {
    const children = [];
    const runner = processRunner({ fork: script => {
      const child = forkWorker(script);
      children.push({ child, exited: new Promise(resolve => child.once('exit', resolve)) });
      return child;
    } });
    const laya = createLaya({ modelDir, modelFormat: format, manifest: NO_MODEL, runner, enabled: true, timeoutMs: 5 * 60 * 1000, idleMs: 2000 });
    t.after(() => laya.close());
    // Resident memory of a process, in bytes (ps reports kilobytes).
    const rss = pid => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024;
    const desktopBefore = process.memoryUsage().rss;
    const rows = parity.decisions.slice(0, 20);
    const started = performance.now();
    await laya.decide(rows[0].state, rows[0].questions);
    const firstMs = performance.now() - started;
    const { pid } = children[0].child;
    const loaded = rss(pid);
    const times = [];
    for (const row of rows) {
      const start = performance.now();
      await laya.decide(row.state, row.questions);
      times.push(performance.now() - start);
    }
    const batchStart = performance.now();
    await laya.decideBatch(rows.map(({ state, questions }) => ({ state, questions })));
    const batchMs = performance.now() - batchStart;
    const busy = rss(pid);
    const desktopAfter = process.memoryUsage().rss;
    times.sort((a, b) => a - b);
    t.diagnostic(`First decision (process start, model load, inference): ${Math.round(firstMs)} ms. One decision at a time: p50 ${Math.round(percentile(times, 0.5))} ms, p95 ${Math.round(percentile(times, 0.95))} ms (mean ${Math.round(rows.reduce((sum, row) => sum + row.length, 0) / rows.length)} tokens). decideBatch of the same 20: ${Math.round(batchMs)} ms.`);
    t.diagnostic(`Model process RSS: ${megabytes(loaded)} loaded, ${megabytes(busy)} after the decisions. Desktop process RSS: ${megabytes(desktopBefore)} before, ${megabytes(desktopAfter)} after.`);
    await children[0].exited;
    t.diagnostic('The model process ended after the idle timeout, returning all of its memory.');
    const again = await laya.decide(rows[0].state, rows[0].questions);
    assert.equal(Object.values(again.answers)[0].type, only(rows[0]).type);
    assert.equal(children.length, 2, 'the next decision started a new model process');
  });
}
