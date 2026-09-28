'use strict';
// #42: answers choice and yes/no questions from the saved profile, with Laya on this computer.
// The facts sheet is built and read here only; the caller gets back option text alone, and asks
// the applicant before any of it reaches a website.
const { buildFacts, factsText, SENSITIVE_SOURCES } = require('../shared/facts.cjs');
const { ABSTAIN, answerState, unsafeQuestion } = require('../shared/laya-prompts.cjs');
const { ANSWER_THRESHOLD, score, pick, budget, timedOut } = require('./laya-decisions.cjs');

function createFieldAnswers({ laya, now = Date.now, today } = {}) {
  if (typeof laya?.decideBatch !== 'function') throw new TypeError('Field answers need a Laya runtime.');
  // The option to fill, or null for "need you". A decision that came after the deadline is dropped.
  async function decide(facts, question, more) {
    const scores = await score(laya, [...question.options, ABSTAIN].map(candidate => answerState(facts, question.label, candidate)));
    if (!more()) return undefined;
    const best = pick(scores, ANSWER_THRESHOLD);
    return best >= 0 ? question.options[best] : null;
  }
  // Questions in page order: { id, label, type, options }, and the milliseconds the click has left.
  // Returns { answers: { [id]: optionText }, sensitive: [id], sensitiveFields: [field] }: `sensitive`
  // lists the answers that needed a sensitive fact, and `sensitiveFields` the saved fields behind
  // the sensitive facts the model was given.
  async function answer({ questions, profile, budgetMs }) {
    const more = budget(budgetMs, now);
    const facts = buildFacts(profile, { today });
    const everyday = factsText(facts.filter(fact => !fact.sensitive));
    const everything = factsText(facts);
    const open = questions.filter(question => !unsafeQuestion(question));
    const answers = {}, sensitive = [];
    try {
      // First pass: facts that are not sensitive.
      if (everyday) for (const question of open) {
        const option = more() ? await decide(everyday, question, more) : undefined;
        if (option === undefined) break;
        if (option !== null) answers[question.id] = option;
      }
      // Second pass: the questions still open, with every fact. Their answers needed a sensitive one.
      if (everything !== everyday) for (const question of open.filter(item => !Object.hasOwn(answers, item.id))) {
        const option = more() ? await decide(everything, question, more) : undefined;
        if (option === undefined) break;
        if (option !== null) { answers[question.id] = option; sensitive.push(question.id); }
      }
    } catch (error) {
      if (!timedOut(error)) throw error;
    }
    const sensitiveFields = sensitive.length ? [...new Set(facts.filter(fact => fact.sensitive).flatMap(fact => fact.sources.filter(source => SENSITIVE_SOURCES.includes(source))))] : [];
    return { answers, sensitive, sensitiveFields };
  }
  return Object.freeze({ answer });
}

module.exports = { createFieldAnswers };
