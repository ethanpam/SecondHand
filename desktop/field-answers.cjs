'use strict';
// #42: answers choice and yes/no questions from the saved profile, with Laya on this computer.
// The facts sheet is built and read here only; the caller gets back option text alone.
const { buildFacts, factsText, SENSITIVE_SOURCES } = require('../shared/facts.cjs');
const { ABSTAIN, answerState, unsafeQuestion } = require('../shared/laya-prompts.cjs');
const { ANSWER_THRESHOLD, score, pick, budget, timedOut } = require('./laya-decisions.cjs');

function createFieldAnswers({ laya, now = Date.now, today } = {}) {
  if (typeof laya?.decideBatch !== 'function') throw new TypeError('Field answers need a Laya runtime.');
  async function decide(facts, question) {
    const best = pick(await score(laya, [...question.options, ABSTAIN].map(candidate => answerState(facts, question.label, candidate))), ANSWER_THRESHOLD);
    return best >= 0 ? question.options[best] : null;
  }
  // Questions in page order: { id, label, type, options }. Returns { [id]: optionText }.
  // `confirmSensitive({ fields, count })` is asked once, and only when an answer needed a
  // sensitive fact; it names the saved fields behind those facts. When it declines, only
  // those answers are dropped.
  async function answer({ questions, profile, confirmSensitive }) {
    const facts = buildFacts(profile, { today });
    const everyday = factsText(facts.filter(fact => !fact.sensitive));
    const everything = factsText(facts);
    const open = questions.filter(question => !unsafeQuestion(question));
    const more = budget(now);
    const answers = {}, sensitive = {};
    try {
      // First pass: facts that need no permission to use.
      if (everyday) for (const question of open) {
        if (!more()) break;
        const option = await decide(everyday, question);
        if (option !== null) answers[question.id] = option;
      }
      // Second pass: the questions still open, with every fact. Their answers needed a sensitive one.
      if (everything !== everyday) for (const question of open.filter(item => !Object.hasOwn(answers, item.id))) {
        if (!more()) break;
        const option = await decide(everything, question);
        if (option !== null) sensitive[question.id] = option;
      }
    } catch (error) {
      if (!timedOut(error)) throw error;
    }
    const count = Object.keys(sensitive).length;
    if (count) {
      const fields = [...new Set(facts.filter(fact => fact.sensitive).flatMap(fact => fact.sources.filter(source => SENSITIVE_SOURCES.includes(source))))];
      if (await confirmSensitive({ fields, count })) Object.assign(answers, sensitive);
    }
    return answers;
  }
  return Object.freeze({ answer });
}

module.exports = { createFieldAnswers };
