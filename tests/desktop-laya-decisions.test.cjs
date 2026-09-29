'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const decisions = require('../desktop/laya-decisions.cjs');
const { QUESTIONS, CHOICE } = require('../shared/laya-prompts.cjs');
const { MODEL_FORMATS } = require('../desktop/laya-model.cjs');

const { pick, score, scoreChoices, budget, BARS, MIN_LEAD, BUDGET_MS, CHOICE_BATCH } = decisions;
const { answer: ANSWER_THRESHOLD, match: MATCH_THRESHOLD } = BARS['noul-v1'];

test('the confidence bars live in one place, one pair per model format: to answer from the profile, and a stricter one to match a text box', () => {
  assert.deepEqual(Object.keys(BARS), [...MODEL_FORMATS]);
  assert.deepEqual(BARS['noul-v1'], { answer: 0.9, match: 0.95 });
  // Chosen on round 3's int8 scores of the test forms not held out (docs/laya-model.md).
  assert.deepEqual(BARS['choice-v1'], { answer: 0.9, match: 0.98 });
  for (const bars of Object.values(BARS)) assert.ok(bars.answer >= 0.9 && bars.match >= bars.answer && bars.match < 1);
  assert.ok(MIN_LEAD > 0 && MIN_LEAD < 1);
  assert.equal(BUDGET_MS, 3000);
  assert.equal(CHOICE_BATCH, require('../desktop/laya.cjs').BATCH_SIZE, 'one choice request is one batch through the model');
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
  const formats = [];
  const laya = { decideBatch: async (items, options) => { calls.push(items); formats.push(options); return items.map((_, index) => ({ answers: { correct: { type: 'noul', noul: index / 10, confidence: Math.max(index / 10, 1 - index / 10) } } })); } };
  assert.deepEqual(await score(laya, [{ question: 'Q', candidate: 'A' }, { question: 'Q', candidate: 'B' }]), [0, 0.1]);
  assert.deepEqual(calls, [[{ state: { question: 'Q', candidate: 'A' }, questions: QUESTIONS }, { state: { question: 'Q', candidate: 'B' }, questions: QUESTIONS }]]);
  assert.deepEqual(formats, [{ format: 'noul-v1' }], 'the prompts are noul-v1’s, so only a noul-v1 model may answer them');
  for (const reply of [[], [{ answers: { correct: { type: 'noul', noul: 1.2, confidence: 1.2 } } }], [{ answers: { correct: { type: 'noul', noul: 'high' } } }],
    [{ answers: { correct: { type: 'choice', choice: 'yes', probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.5 } } }], [{ answers: {} }], [null], 'no']) {
    const broken = { decideBatch: async () => reply };
    await assert.rejects(score(broken, [{ question: 'Q', candidate: 'A' }]), /Laya/, JSON.stringify(reply));
  }
  const notReady = Object.assign(new Error('Laya is off.'), { code: 'LAYA_NOT_READY' });
  await assert.rejects(score({ decideBatch: async () => { throw notReady; } }, [{ question: 'Q', candidate: 'A' }]), error => error === notReady);
});

test('choice-v1 scores come from one batch, one pass per question, as each question’s probabilities in the order of its choices', async () => {
  const calls = [];
  const items = [{ state: CHOICE.answerState('F', 'Any children?'), question: CHOICE.answerQuestion(['Yes', 'No']) },
    { state: CHOICE.matchState('Email'), question: CHOICE.matchQuestion(['email']) }];
  const laya = { decideBatch: async (batch, options) => {
    calls.push({ batch, options });
    // Probabilities come back keyed by choice, in whatever order: the scores follow the question's own order.
    return batch.map(({ questions }) => ({ answers: { choice: { type: 'choice', choice: questions.choice.criteria[0],
      probabilities: Object.fromEntries(questions.choice.criteria.map((label, index) => [label, (index + 1) / 10]).reverse()), confidence: 0.2 } } }));
  } };
  assert.deepEqual(await scoreChoices(laya, items), [[0.1, 0.2, 0.3], [0.1, 0.2]]);
  assert.deepEqual(calls, [{ batch: items.map(({ state, question }) => ({ state, questions: { choice: question } })), options: { format: 'choice-v1' } }]);
  const reply = probabilities => ({ decideBatch: async () => [{ answers: { choice: { type: 'choice', choice: 'Yes', probabilities, confidence: 0.5 } } }] });
  for (const broken of [reply({ Yes: 0.9, No: 0.1 }), reply({ Yes: 0.9, No: 0.05, [CHOICE.answerQuestion([])['criteria'][0]]: 1.2 }), reply({ Yes: 'high', No: 0, [items[0].question.criteria[2]]: 0 }),
    { decideBatch: async () => [{ answers: { correct: { type: 'noul', noul: 0.5 } } }] }, { decideBatch: async () => [{ answers: { choice: { type: 'choice' } } }] },
    { decideBatch: async () => [] }, { decideBatch: async () => 'no' }]) {
    await assert.rejects(scoreChoices(broken, items.slice(0, 1)), /Laya/);
  }
});

test('the bars follow the format of the model Laya runs, and a format without bars fails loudly', async () => {
  assert.deepEqual(await decisions.barsFor({ format: async () => 'choice-v1' }), { format: 'choice-v1', bars: BARS['choice-v1'] });
  assert.deepEqual(await decisions.barsFor({ format: async () => 'noul-v1' }), { format: 'noul-v1', bars: BARS['noul-v1'] });
  await assert.rejects(decisions.barsFor({ format: async () => 'noul-v9' }), /noul-v9/);
  const notReady = Object.assign(new Error('Laya is off.'), { code: 'LAYA_NOT_READY' });
  await assert.rejects(decisions.barsFor({ format: async () => { throw notReady; } }), error => error === notReady);
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
