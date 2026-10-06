'use strict';
// How the desktop app turns Laya's scores into an answer, for matching text boxes (#39) and
// answering choice questions (#42). Every confidence bar lives here.
const { QUESTIONS } = require('../shared/laya-prompts.cjs');
const { BATCH_SIZE } = require('./laya.cjs');

// The bars per model format (desktop/laya-model.cjs MODEL_FORMATS): one to answer choice and
// yes/no questions from the saved profile, and one to match a text box to a saved field. Each is
// set from its model's evaluation (#41, #65; docs/laya-model.md) so accepted answers are 95% or
// more correct. choice-v2's come from round 4's int8 scores of every test form, the old holdout forms
// included: the answer bar is the lowest that reaches 0.95 there (0.959). No match bar reaches 0.95
// there, so the match bar is the one with the best precision (0.941, matching 23% of the boxes).
const BARS = Object.freeze({
  'noul-v1': Object.freeze({ answer: 0.9, match: 0.95 }),
  'choice-v2': Object.freeze({ answer: 0.9, match: 0.999 })
});
// The best candidate must beat the runner-up by at least this much; two likely answers mean
// the model isn't sure which, and the question goes to the applicant.
const MIN_LEAD = 0.5;
// Laya's time budget per Autofill click. The extension sends what its click has left with each
// request; questions left when it runs out go to "need you".
const BUDGET_MS = 3000;
// choice-v2 questions per request: one batch through the model, so a timeout or the budget
// running out keeps every batch decided before it.
const CHOICE_BATCH = BATCH_SIZE;

// noul-v1: the probability Laya gives each candidate of one decision, from one batch. `timeoutMs`,
// when given, is the time the click has left: the request ends then.
async function score(laya, states, { timeoutMs } = {}) {
  const results = await laya.decideBatch(states.map(state => ({ state, questions: QUESTIONS })), { format: 'noul-v1', ...(timeoutMs === undefined ? {} : { timeoutMs }) });
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

// choice-v2: for each { state, question } (a CHOICE question), the probability of each of its
// choices in their order, from one batch: one pass per question.
async function scoreChoices(laya, items) {
  const results = await laya.decideBatch(items.map(({ state, question }) => ({ state, questions: { choice: question } })), { format: 'choice-v2' });
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

// #185: Laya's best guess on a question it has no sure answer for: the index of its top-scoring candidate when that
// one alone scores highest and beats the abstain candidate (the last score), with no bar and no lead; otherwise -1.
function bestGuess(scores) {
  const candidates = scores.slice(0, -1);
  if (!candidates.length) return -1;
  const top = Math.max(...candidates);
  const index = candidates.indexOf(top);
  return top > scores.at(-1) && candidates.lastIndexOf(top) === index ? index : -1;
}

// True until the click's time budget is spent: what the click has left, never more than BUDGET_MS.
// Its left() is the whole milliseconds still left.
function budget(budgetMs, now = Date.now) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1) throw new TypeError('A Laya request needs its time budget in whole milliseconds.');
  const end = now() + Math.min(budgetMs, BUDGET_MS);
  return Object.assign(() => now() < end, { left: () => Math.max(0, Math.floor(end - now())) });
}
const timedOut = error => error?.code === 'LAYA_TIMEOUT';

// noul-v1 asks every question of a pass at once, so each of the model's sessions has work, and Laya
// runs them in the order asked. use(index, answer) gets each answer in that order while more() says
// the click has time; one after the deadline is dropped. A request that fails ends the pass. Once
// every request has ended, a failure is thrown, one other than running out of time first.
async function inOrder(requests, more, use) {
  const ended = requests.map(request => request.then(value => ({ value }), error => ({ error, failed: true })));
  for (const [index, outcome] of ended.entries()) {
    const { value, failed } = await outcome;
    if (failed || !more()) break;
    use(index, value);
  }
  const errors = (await Promise.all(ended)).filter(outcome => outcome.failed).map(outcome => outcome.error);
  if (errors.length) throw errors.find(error => !timedOut(error)) ?? errors[0];
}

// noul-v1 (#90): the order a click asks its questions in, cheapest first. Each candidate is one pass
// through the model and Laya runs BATCH_SIZE of them to a batch, so a question costs its batches.
// `items` in groups of equal batches, fewest first; each group by candidates, then in page order.
function byCost(items, candidates) {
  const groups = new Map();
  const sorted = items.map((item, index) => ({ item, index, count: candidates(item) })).sort((a, b) => a.count - b.count || a.index - b.index);
  for (const { item, count } of sorted) {
    const batches = Math.ceil(count / BATCH_SIZE);
    if (!groups.has(batches)) groups.set(batches, []);
    groups.get(batches).push(item);
  }
  return [...groups.values()];
}

// The confidence bars for the model Laya runs now; a format this app has no bars for fails loudly.
async function barsFor(laya) {
  const format = await laya.format();
  if (!Object.hasOwn(BARS, format)) throw new Error(`Laya’s model format (${format}) has no confidence bars in this app.`);
  return { format, bars: BARS[format] };
}

module.exports = { BARS, MIN_LEAD, BUDGET_MS, CHOICE_BATCH, score, scoreChoices, pick, bestGuess, budget, timedOut, inOrder, byCost, barsFor };
