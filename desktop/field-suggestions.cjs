'use strict';
// #39: which saved field a text box on a form asks for, decided by Laya on this computer.
// The model reads the question's label and a description of each saved field, never a saved value.
const { CHOICE, matchState, matchableBox, offeredFields, unsafeQuestion } = require('../shared/laya-prompts.cjs');
const { CHOICE_BATCH, score, scoreChoices, pick, budget, timedOut, inOrder, barsFor } = require('./laya-decisions.cjs');

function createFieldSuggestions({ laya, now = Date.now } = {}) {
  if (typeof laya?.decideBatch !== 'function' || typeof laya?.format !== 'function') throw new TypeError('Field suggestions need a Laya runtime.');
  // How each model format matches `fields`: found(field, savedFieldKey or null) for each field
  // decided before the deadline; a decision that came after it is dropped, and nothing more is asked.
  const passes = {
    // noul-v1: one request per field, scoring each saved field its label names (offeredFields) and
    // abstaining on its own. A box with none on offer (a date) isn't asked. Every box is asked at
    // once, each request ending when the click's time does.
    'noul-v1': async (fields, bar, more, found) => {
      const asked = fields.map(field => ({ field, keys: offeredFields(field) })).filter(({ keys }) => keys.length);
      const timeoutMs = more.left();
      if (!asked.length || !more() || timeoutMs < 1) return;
      const requests = asked.map(({ field, keys }) => score(laya, [...keys.map(key => matchState(field.label, key)), matchState(field.label, null)], { timeoutMs }));
      await inOrder(requests, more, (index, scores) => {
        const { field, keys } = asked[index];
        const best = pick(scores, bar);
        found(field, best >= 0 ? keys[best] : null);
      });
    },
    // choice-v2 (#65): every field offered for the box's type in one pass, with the box's label and
    // type, CHOICE_BATCH boxes per request. A box whose type has none on offer (a date: date of
    // birth never is) isn't asked.
    'choice-v2': async (fields, bar, more, found) => {
      const offered = field => {
        const keys = CHOICE.MATCH_SETS[field.type];
        if (!keys) throw new TypeError(`A ${field.type} field isn’t a text box Laya matches.`);
        return keys;
      };
      const asked = fields.filter(field => offered(field).length);
      for (let start = 0; start < asked.length; start += CHOICE_BATCH) {
        if (!more()) return;
        const chunk = asked.slice(start, start + CHOICE_BATCH);
        const scores = await scoreChoices(laya, chunk.map(field => ({ state: CHOICE.matchState(field.label, field.type), question: CHOICE.matchQuestion(offered(field)) })));
        if (!more()) return;
        chunk.forEach((field, index) => {
          const best = pick(scores[index], bar);
          found(field, best >= 0 ? offered(field)[best] : null);
        });
      }
    }
  };
  // Fields in page order: { id, label, type, options }, and the milliseconds the click has left.
  // Returns { [id]: savedFieldKey } for the fields the model matched with confidence before the
  // deadline; the rest go to the applicant.
  async function suggest(fields, { budgetMs } = {}) {
    const more = budget(budgetMs, now);
    const { format, bars } = await barsFor(laya);
    const pass = passes[format];
    if (!pass) throw new Error(`Field suggestions can’t ask a Laya model in the ${format} format.`);
    const suggestions = {};
    try {
      await pass(fields.filter(field => !unsafeQuestion(field) && matchableBox(field)), bars.match, more, (field, key) => { if (key !== null) suggestions[field.id] = key; });
    } catch (error) {
      if (!timedOut(error)) throw error;
    }
    return suggestions;
  }
  return Object.freeze({ suggest });
}

module.exports = { createFieldSuggestions };
