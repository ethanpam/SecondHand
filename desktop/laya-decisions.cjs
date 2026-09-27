'use strict';
// How the desktop app turns Laya's scores into an answer, for matching text boxes (#39) and
// answering choice questions (#42). Every confidence bar lives here.
const { QUESTIONS } = require('../shared/laya-prompts.cjs');

// Answering choice and yes/no questions from the saved profile, calibrated on the #41
// evaluation so accepted answers are 95% or more correct.
const ANSWER_THRESHOLD = 0.9;
// Matching a text box to a saved field. Stricter: the #41 reports show match precision on
// held-out forms still below 0.95 even at a 0.95 bar.
const MATCH_THRESHOLD = 0.95;
// The best candidate must beat the runner-up by at least this much; two likely answers mean
// the model isn't sure which, and the question goes to the applicant.
const MIN_LEAD = 0.5;
// Each request's time budget. Questions left when it runs out go to "need you".
const BUDGET_MS = 3000;

// The probability Laya gives each candidate of one decision, from one batch.
async function score(laya, states) {
  const results = await laya.decideBatch(states.map(state => ({ state, questions: QUESTIONS })));
  if (!Array.isArray(results) || results.length !== states.length) throw new Error('Laya returned the wrong number of answers.');
  return results.map(result => {
    const probability = result?.answers?.correct?.noul;
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Laya returned an unreadable score.');
    return probability;
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

// True until the request's time budget is spent.
function budget(now = Date.now, ms = BUDGET_MS) {
  const end = now() + ms;
  return () => now() < end;
}
const timedOut = error => error?.code === 'LAYA_TIMEOUT';

module.exports = { ANSWER_THRESHOLD, MATCH_THRESHOLD, MIN_LEAD, BUDGET_MS, score, pick, budget, timedOut };
