'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { watch, despiteSleep, sleepTolerant } = require('../scripts/host-sleep.cjs');

// A clock the test moves by hand: a jump with no heartbeat in between is the computer asleep.
function clock() {
  let now = 0;
  return { now: () => now, pass: ms => { now += ms; } };
}

test('a heartbeat that comes late counts as a sleep; on-time heartbeats do not', () => {
  const time = clock();
  const sleep = watch({ now: time.now, lateMs: 1500 });
  const mark = sleep.mark();
  for (let i = 0; i < 20; i++) { time.pass(250); sleep.beat(); }
  assert.equal(sleep.slept(mark), false);
  time.pass(60000); sleep.beat();
  assert.equal(sleep.slept(mark), true);
  assert.equal(sleep.slept(sleep.mark()), false);
});

test('a sleep whose late heartbeat has not run yet still counts', () => {
  const time = clock();
  const sleep = watch({ now: time.now, lateMs: 1500 });
  const mark = sleep.mark();
  time.pass(30000);
  assert.equal(sleep.slept(mark), true);
  // Counted once: the next wait starts after it.
  assert.equal(sleep.slept(sleep.mark()), false);
});

test('a wait that failed across a sleep runs again; any other failure is thrown at once', async () => {
  const time = clock();
  const sleep = watch({ now: time.now, lateMs: 1500 });
  const logs = [];
  let tries = 0;
  const result = await despiteSleep(async () => {
    tries++;
    if (tries === 1) { time.pass(90000); throw new Error('Timeout 15000ms exceeded while waiting on the predicate'); }
    return 'ready';
  }, sleep, line => logs.push(line));
  assert.equal(result, 'ready');
  assert.equal(tries, 2);
  assert.match(logs[0], /The computer slept during a wait; waiting again: Timeout 15000ms exceeded/);

  tries = 0;
  await assert.rejects(despiteSleep(async () => { tries++; time.pass(250); sleep.beat(); throw new Error('Expected: 1\nReceived: 0'); }, sleep, line => logs.push(line)), /Expected: 1/);
  assert.equal(tries, 1);
  assert.equal(logs.length, 1);
});

test('each matcher, after .not too, is asked again of a fresh assertion after a sleep', async () => {
  const time = clock();
  const sleep = watch({ now: time.now, lateMs: 1500 });
  const made = [];
  let failNext = true;
  const matchers = (kind, value, negated = false) => ({
    get not() { return matchers(kind, value, !negated); },
    async toBe(expected) {
      made.at(-1).asked.push({ negated, expected });
      if (failNext) { failNext = false; time.pass(45000); throw new Error('Timeout 5000ms exceeded'); }
      if ((value === expected) === negated) throw new Error(`Expected ${negated ? 'not ' : ''}${expected}`);
    }
  });
  const base = value => { made.push({ kind: 'expect', value, asked: [] }); return matchers('expect', value); };
  base.poll = (fn, options) => { made.push({ kind: 'poll', value: fn(), options, asked: [] }); return matchers('poll', fn()); };
  const expect = sleepTolerant(base, sleep, () => {});

  await expect(1).toBe(1);
  assert.deepEqual(made.map(entry => entry.kind), ['expect', 'expect'], 'a fresh assertion for the second try');
  await expect.poll(() => 2, { timeout: 20000 }).not.toBe(3);
  assert.deepEqual(made.at(-1), { kind: 'poll', value: 2, options: { timeout: 20000 }, asked: [{ negated: true, expected: 3 }] });
  await assert.rejects(expect(4).not.toBe(4), /Expected not 4/);
  assert.equal(made.length, 4, 'a failure with no sleep is not tried again');
  assert.equal(expect(5).then, undefined, 'an assertion is not a promise');
});
