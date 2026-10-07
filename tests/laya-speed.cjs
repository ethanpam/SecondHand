'use strict';

// How fast the real int8 ONNX models decide through the desktop runtime, on the parity fixtures' decisions, with
// the exports tests/laya-parity.test.cjs checks (tests/helpers/laya-exports.cjs names them and their variables).
// A format whose variable isn't set is skipped, and says so.
// Not a .test.cjs file, so npm test leaves it out: npm test runs its files at once, and their work on the same
// cores slowed a batch of 20 that takes 1,771 ms alone to 2,547 ms, over its budget. It runs alone instead:
//   npm run test:laya, before the pantry smoke (right after it, a first decision took 1,103 ms); or
//   node --test tests/laya-speed.cjs
// The budgets are what a person waits for after a click, so they are clock time. CPU time would not do: the model
// runs on several threads, and on one thread noul-v1's batch of 20 took three times as long (5.4 s) for a third of
// the CPU time.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createLaya, processRunner, forkWorker } = require('../desktop/laya.cjs');
const { MODEL_FORMATS } = require('../desktop/laya-model.cjs');
const { BUDGET_MS } = require('../desktop/laya-decisions.cjs');
const { SETS, NO_MODEL, load, only } = require('./helpers/laya-exports.cjs');

// How fast each model must decide: a little over the slowest of four runs on 2026-10-06, on an Apple M4 Max
// (14 cores) with the 1-minute load at 6 to 33. noul-v1 took 659–731 ms for the first decision (process start,
// checksum, load), 132–137 ms one decision at a time at p95, and 1,753–2,064 ms for a batch of 20; choice-v2
// 623–916 ms, 146–158 ms and 2,073–2,653 ms. A click gives Laya BUDGET_MS (3 s) for a whole page, so a batch of
// 20 never gets more than that.
const LATENCY = Object.freeze({
  'noul-v1': Object.freeze({ firstMs: 1000, p95Ms: 200, batchOf20Ms: 2500 }),
  'choice-v2': Object.freeze({ firstMs: 1200, p95Ms: 200, batchOf20Ms: BUDGET_MS })
});
const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)];
const megabytes = bytes => `${Math.round(bytes / 1e6)} MB`;

test('every model format the app runs has its own latency budget', () => {
  assert.deepEqual(Object.keys(LATENCY), [...MODEL_FORMATS]);
  assert.deepEqual(SETS.map(set => set.format), [...MODEL_FORMATS], 'and its own export to time');
});

for (const { format, fixture, env } of SETS) {
  const parity = load(fixture);
  const modelDir = process.env[env];
  const skip = modelDir ? false : `${env} is not set, so the ${format} speed checks are skipped.`;

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
    const budget = LATENCY[format];
    assert.ok(firstMs <= budget.firstMs, `the first decision took ${Math.round(firstMs)} ms; its budget is ${budget.firstMs} ms`);
    assert.ok(percentile(times, 0.95) <= budget.p95Ms, `one decision took ${Math.round(percentile(times, 0.95))} ms at p95; its budget is ${budget.p95Ms} ms`);
    assert.ok(batchMs <= budget.batchOf20Ms, `decideBatch of 20 took ${Math.round(batchMs)} ms; its budget is ${budget.batchOf20Ms} ms`);
    await children[0].exited;
    t.diagnostic('The model process ended after the idle timeout, returning all of its memory.');
    const again = await laya.decide(rows[0].state, rows[0].questions);
    assert.equal(Object.values(again.answers)[0].type, only(rows[0]).type);
    assert.equal(children.length, 2, 'the next decision started a new model process');
  });
}
