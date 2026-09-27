'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFieldSuggestions } = require('../desktop/field-suggestions.cjs');
const { ABSTAIN, QUESTIONS, MATCH_CANDIDATES, NEVER_SUGGESTED, matchState } = require('../shared/laya-prompts.cjs');

// A stand-in for the Laya runtime (#38) with its exact interface. `scores(question, candidate)`
// plays the model; every batch it is asked is recorded.
function stubLaya(scores = () => 0.01) {
  const batches = [];
  return {
    batches,
    status: () => ({ state: 'ready' }),
    decide: async () => { throw new Error('field suggestions score in batches'); },
    decideBatch: async items => {
      batches.push(items);
      return items.map(({ state }) => ({ answers: { correct: { noul: scores(state.question, state.candidate) } } }));
    }
  };
}
const saved = key => `Saved answer: ${{ email: 'email address', phone: 'phone number', householdSize: 'number of people in the household', zip: 'ZIP or postal code' }[key]}`;
const field = (id, label, type = 'text') => ({ id, label, type, options: [] });
// The time the extension's click has left for Laya, as the bridge carries it.
const BUDGET = { budgetMs: 3000 };

test('a text box the model matches above the bar gets that saved field; it sees the label and field descriptions only', async () => {
  const laya = stubLaya((question, candidate) => question === 'Where can we reach you by email?' && candidate === saved('email') ? 0.99 : 0.01);
  const suggestions = await createFieldSuggestions({ laya }).suggest([field('f0:sh-1-2', 'Where can we reach you by email?', 'email')], BUDGET);
  assert.deepEqual(suggestions, { 'f0:sh-1-2': 'email' });
  assert.equal(laya.batches.length, 1);
  assert.deepEqual(laya.batches[0], [...MATCH_CANDIDATES.map(key => matchState('Where can we reach you by email?', key)), matchState('Where can we reach you by email?', null)]
    .map(state => ({ state, questions: QUESTIONS })), 'every candidate plus abstain, in training order');
  assert.equal(laya.batches[0].at(-1).state.candidate, ABSTAIN);
});

test('the bar is 0.95: a lower score, an abstain that wins, or two likely fields leave the box to the applicant', async () => {
  const cases = [
    [() => 0.94, 'below the bar'],
    [(_, candidate) => candidate === ABSTAIN ? 0.99 : candidate === saved('phone') ? 0.97 : 0.01, 'abstain wins'],
    [(_, candidate) => [saved('zip'), saved('householdSize')].includes(candidate) ? 0.98 : 0.01, 'two likely fields']
  ];
  for (const [scores, why] of cases) {
    const suggestions = await createFieldSuggestions({ laya: stubLaya(scores) }).suggest([field('sh-1-0', 'Number')], BUDGET);
    assert.deepEqual(suggestions, {}, why);
  }
  const ok = await createFieldSuggestions({ laya: stubLaya((_, candidate) => candidate === saved('phone') ? 0.96 : 0.02) }).suggest([field('sh-1-0', 'Best number to reach you', 'tel')], BUDGET);
  assert.deepEqual(ok, { 'sh-1-0': 'phone' });
});

test('sensitive saved fields are never candidates, and consent, signature, and SSN questions never reach the model', async () => {
  const laya = stubLaya(() => 0.99);
  await createFieldSuggestions({ laya }).suggest([field('sh-1-0', 'Anything else?')], BUDGET);
  const offered = laya.batches.flat().map(item => item.state.candidate);
  for (const key of NEVER_SUGGESTED) assert.equal(offered.some(candidate => /Social Security|date of birth|income|on hand|medical/i.test(candidate)), false, key);
  const unsafe = stubLaya(() => 0.99);
  const suggestions = await createFieldSuggestions({ laya: unsafe }).suggest([field('a', 'Social Security Number'), field('b', 'Signature'), field('c', 'I certify this is true'), field('d', 'Type your initials to agree')], BUDGET);
  assert.deepEqual(suggestions, {});
  assert.deepEqual(unsafe.batches, [], 'nothing unsafe is scored');
});

test('Laya not ready fails the whole request with its code; a timeout or the three-second budget leaves the rest to the applicant', async () => {
  const notReady = Object.assign(new Error('Laya is off.'), { code: 'LAYA_NOT_READY' });
  const off = { status: () => ({ state: 'off' }), decide: async () => { throw notReady; }, decideBatch: async () => { throw notReady; } };
  await assert.rejects(createFieldSuggestions({ laya: off }).suggest([field('a', 'Email')], BUDGET), error => error.code === 'LAYA_NOT_READY');

  let calls = 0;
  const slow = stubLaya((question, candidate) => candidate === saved('email') ? 0.99 : 0.01);
  const decideBatch = slow.decideBatch;
  slow.decideBatch = async items => { if (++calls === 2) throw Object.assign(new Error('Laya took too long.'), { code: 'LAYA_TIMEOUT' }); return decideBatch(items); };
  assert.deepEqual(await createFieldSuggestions({ laya: slow }).suggest([field('a', 'Email'), field('b', 'Email again'), field('c', 'Third email')], BUDGET), { a: 'email' });
  assert.equal(calls, 2, 'nothing more is asked after a timeout');

  // A decision that finishes after the deadline is dropped, and nothing more is asked.
  const timed = (step, budgetMs) => {
    let clock = 0;
    const laya = stubLaya((question, candidate) => candidate === saved('email') ? 0.99 : 0.01);
    const answer = laya.decideBatch;
    laya.decideBatch = async items => { clock += step; return answer(items); };
    return { laya, run: () => createFieldSuggestions({ laya, now: () => clock }).suggest([field('a', 'Email'), field('b', 'Email'), field('c', 'Email')], { budgetMs }) };
  };
  const full = timed(1600, 3000);
  assert.deepEqual(await full.run(), { a: 'email' }, 'the second field’s decision came at 3.2 seconds');
  assert.equal(full.laya.batches.length, 2);
  const short = timed(400, 1000);
  assert.deepEqual(await short.run(), { a: 'email', b: 'email' }, 'the click had only one second left');
  assert.equal(short.laya.batches.length, 3);
  const capped = timed(1400, 9000);
  assert.deepEqual(await capped.run(), { a: 'email', b: 'email' }, 'never more than three seconds');
  for (const budgetMs of [0, -1, 1.5, '3000', undefined]) {
    await assert.rejects(createFieldSuggestions({ laya: stubLaya() }).suggest([field('a', 'Email')], { budgetMs }), /budget/, String(budgetMs));
  }

  const broken = stubLaya();
  broken.decideBatch = async () => { throw new Error('model crashed'); };
  await assert.rejects(createFieldSuggestions({ laya: broken }).suggest([field('a', 'Email')], BUDGET), /model crashed/, 'other failures are loud');
  assert.throws(() => createFieldSuggestions({}), /Laya/);
});
