'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const decisions = require('../desktop/laya-decisions.cjs');
const { QUESTIONS } = require('../shared/laya-prompts.cjs');

const { pick, score, budget, ANSWER_THRESHOLD, MATCH_THRESHOLD, MIN_LEAD, BUDGET_MS } = decisions;

test('the confidence bars live in one place: 0.9 to answer from the profile, a stricter 0.95 to match a text box', () => {
  assert.equal(ANSWER_THRESHOLD, 0.9);
  assert.equal(MATCH_THRESHOLD, 0.95);
  assert.ok(MIN_LEAD > 0 && MIN_LEAD < 1);
  assert.equal(BUDGET_MS, 3000);
});

test('the best candidate is used only when it clears the bar, beats "the facts don’t say", and clearly beats the runner-up', () => {
  // The last score is always the abstain candidate's.
  assert.equal(pick([0.02, 0.97, 0.01], ANSWER_THRESHOLD), 1);
  assert.equal(pick([0.9, 0.05, 0.02], ANSWER_THRESHOLD), 0, 'exactly the bar is enough');
  assert.equal(pick([0.89, 0.01, 0.01], ANSWER_THRESHOLD), -1, 'below the bar');
  assert.equal(pick([0.93, 0.01, 0.01], MATCH_THRESHOLD), -1, 'matching is stricter');
  assert.equal(pick([0.96, 0.01, 0.01], MATCH_THRESHOLD), 0);
  assert.equal(pick([0.95, 0.02, 0.99], ANSWER_THRESHOLD), -1, 'abstain scores higher');
  assert.equal(pick([0.95, 0.02, 0.95], ANSWER_THRESHOLD), -1, 'a tie with abstain is not a win');
  assert.equal(pick([0.97, 0.93, 0.01], ANSWER_THRESHOLD), -1, 'a close runner-up means the model isn’t sure which');
  assert.equal(pick([0.97, 0.97, 0.01], ANSWER_THRESHOLD), -1, 'a tie is never broken by page order');
  assert.equal(pick([0.97, 0.97 - MIN_LEAD, 0.01], ANSWER_THRESHOLD), 0, 'a lead of exactly the margin is clear');
  assert.equal(pick([0.99, 0.01], ANSWER_THRESHOLD), 0, 'a lone candidate (a single checkbox) has no runner-up');
  assert.equal(pick([0.99], ANSWER_THRESHOLD), -1, 'abstain alone is never an answer');
});

test('scores come from one batch per decision with the trained question, and anything unreadable fails loudly', async () => {
  const calls = [];
  const laya = { decideBatch: async items => { calls.push(items); return items.map((_, index) => ({ answers: { correct: { type: 'noul', noul: index / 10, confidence: Math.max(index / 10, 1 - index / 10) } } })); } };
  assert.deepEqual(await score(laya, [{ question: 'Q', candidate: 'A' }, { question: 'Q', candidate: 'B' }]), [0, 0.1]);
  assert.deepEqual(calls, [[{ state: { question: 'Q', candidate: 'A' }, questions: QUESTIONS }, { state: { question: 'Q', candidate: 'B' }, questions: QUESTIONS }]]);
  for (const reply of [[], [{ answers: { correct: { type: 'noul', noul: 1.2, confidence: 1.2 } } }], [{ answers: { correct: { type: 'noul', noul: 'high' } } }],
    [{ answers: { correct: { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.5 } } }], [{ answers: {} }], [null], 'no']) {
    const broken = { decideBatch: async () => reply };
    await assert.rejects(score(broken, [{ question: 'Q', candidate: 'A' }]), /Laya/, JSON.stringify(reply));
  }
  const notReady = Object.assign(new Error('Laya is off.'), { code: 'LAYA_NOT_READY' });
  await assert.rejects(score({ decideBatch: async () => { throw notReady; } }, [{ question: 'Q', candidate: 'A' }]), error => error === notReady);
});

test('a request’s time budget is what the click has left, never more than three seconds', () => {
  let clock = 1000;
  const more = budget(BUDGET_MS, () => clock);
  assert.equal(more(), true);
  clock += BUDGET_MS - 1;
  assert.equal(more(), true);
  clock += 1;
  assert.equal(more(), false);
  clock = 0;
  const left = budget(1200, () => clock);
  clock = 1199;
  assert.equal(left(), true);
  clock = 1200;
  assert.equal(left(), false);
  clock = 0;
  const capped = budget(60000, () => clock);
  clock = BUDGET_MS;
  assert.equal(capped(), false);
  for (const budgetMs of [0, -5, 2.5, '1000', undefined, NaN]) assert.throws(() => budget(budgetMs, () => 0), /budget/, String(budgetMs));
});
