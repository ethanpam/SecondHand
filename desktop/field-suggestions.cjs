'use strict';
// #39: which saved field a text box on a form asks for, decided by Laya on this computer.
// The model reads the question's label and a description of each saved field, never a saved value.
const { MATCH_CANDIDATES, matchState, unsafeQuestion } = require('../shared/laya-prompts.cjs');
const { MATCH_THRESHOLD, score, pick, budget, timedOut } = require('./laya-decisions.cjs');

function createFieldSuggestions({ laya, now = Date.now } = {}) {
  if (typeof laya?.decideBatch !== 'function') throw new TypeError('Field suggestions need a Laya runtime.');
  // Fields in page order: { id, label, type, options }, and the milliseconds the click has left.
  // Returns { [id]: savedFieldKey } for the fields the model matched with confidence before the
  // deadline; the rest go to the applicant.
  async function suggest(fields, { budgetMs } = {}) {
    const more = budget(budgetMs, now);
    const suggestions = {};
    for (const field of fields) {
      if (unsafeQuestion(field)) continue;
      if (!more()) break;
      let scores;
      try { scores = await score(laya, [...MATCH_CANDIDATES.map(key => matchState(field.label, key)), matchState(field.label, null)]); }
      catch (error) {
        if (timedOut(error)) break;
        throw error;
      }
      // A decision that came after the deadline is dropped.
      if (!more()) break;
      const best = pick(scores, MATCH_THRESHOLD);
      if (best >= 0) suggestions[field.id] = MATCH_CANDIDATES[best];
    }
    return suggestions;
  }
  return Object.freeze({ suggest });
}

module.exports = { createFieldSuggestions };
