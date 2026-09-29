'use strict';
// How the desktop app turns Laya's scores into an answer, for matching text boxes (#39) and
// answering choice questions (#42). Every confidence bar lives here.
const { QUESTIONS } = require('../shared/laya-prompts.cjs');
const { BATCH_SIZE } = require('./laya.cjs');

// The bars per model format (desktop/laya-model.cjs MODEL_FORMATS): one to answer choice and
// yes/no questions from the saved profile, and one to match a text box to a saved field. Each is
// set from its model's evaluation (#41, #65; docs/laya-model.md) so accepted answers are 95% or
// more correct. choice-v1's come from round 3's int8 scores of the test forms not held out: the
// answer bar stays 0.9 (0.970 there; 0.8 only just reaches 0.95), and the match bar is the lowest
// that reaches 0.95 (0.975 gives 0.909).
const BARS = Object.freeze({
  'noul-v1': Object.freeze({ answer: 0.9, match: 0.95 }),
  'choice-v1': Object.freeze({ answer: 0.9, match: 0.98 })
});
// The best candidate must beat the runner-up by at least this much; two likely answers mean
// the model isn't sure which, and the question goes to the applicant.
const MIN_LEAD = 0.5;
// Laya's time budget per Autofill click. The extension sends what its click has left with each
// request; questions left when it runs out go to "need you".
const BUDGET_MS = 3000;
// choice-v1 questions per request: one batch through the model, so a timeout or the budget
// running out keeps every batch decided before it.
const CHOICE_BATCH = BATCH_SIZE;

// noul-v1: the probability Laya gives each candidate of one decision, from one batch.
async function score(laya, states) {
  const results = await laya.decideBatch(states.map(state => ({ state, questions: QUESTIONS })), { format: 'noul-v1' });
  if (!Array.isArray(results) || results.length !== states.length) throw new Error('Laya returned the wrong number of answers.');
  // Each answer is desktop/laya.cjs's { type: 'noul', noul, confidence }; noul is the probability.
  return results.map(result => {
    const answer = result?.answers?.correct;
    const probability = answer?.noul;
    if (answer?.type !== 'noul' || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Laya returned an unreadable score.');
    return probability;
  });
}

const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

// choice-v1: for each { state, question } (a CHOICE question), the probability of each of its
// choices in their order, from one batch: one pass per question.
async function scoreChoices(laya, items) {
  const results = await laya.decideBatch(items.map(({ state, question }) => ({ state, questions: { choice: question } })), { format: 'choice-v1' });
  if (!Array.isArray(results) || results.length !== items.length) throw new Error('Laya returned the wrong number of answers.');
  // Each answer is desktop/laya.cjs's { type: 'choice', choice, probabilities: { [choice]: p }, confidence }.
  return results.map((result, index) => {
    const answer = result?.answers?.choice;
    const labels = items[index].question.criteria;
    const values = labels.map(label => answer?.probabilities?.[label]);
    if (answer?.type !== 'choice' || !answer.probabilities || Object.keys(answer.probabilities).length !== labels.length || !values.every(probability)) throw new Error('Laya returned an unreadable score.');
    return values;
  });
}

// The index of the candidate to use, or -1 when the question goes to the applicant.
// The last score is always the abstain candidate's ("the facts don't say").
function pick(scores, threshold) {
  const abstain = scores.at(-1);
  const candidates = scores.slice(0, -1);
  if (!candidates.length) return -1;
  const ranked = candidates.map((probability, index) => ({ probability, index })).sort((a, b) => b.probability - a.probability);
  const [best, runnerUp = { probability: 0 }] = ranked;
  return best.probability >= threshold && best.probability > abstain && best.probability - runnerUp.probability >= MIN_LEAD ? best.index : -1;
}

// True until the click's time budget is spent: what the click has left, never more than BUDGET_MS.
function budget(budgetMs, now = Date.now) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1) throw new TypeError('A Laya request needs its time budget in whole milliseconds.');
  const end = now() + Math.min(budgetMs, BUDGET_MS);
  return () => now() < end;
}
const timedOut = error => error?.code === 'LAYA_TIMEOUT';

// The confidence bars for the model Laya runs now; a format this app has no bars for fails loudly.
async function barsFor(laya) {
  const format = await laya.format();
  if (!Object.hasOwn(BARS, format)) throw new Error(`Laya’s model format (${format}) has no confidence bars in this app.`);
  return { format, bars: BARS[format] };
}

module.exports = { BARS, MIN_LEAD, BUDGET_MS, CHOICE_BATCH, score, scoreChoices, pick, budget, timedOut, barsFor };
