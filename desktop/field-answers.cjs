'use strict';
// #42: answers choice and yes/no questions from the saved profile, with Laya on this computer.
// The facts sheet is built and read here only; the caller gets back option text alone, and asks
// the applicant before any of it reaches a website.
const { buildFacts, factsText, SENSITIVE_SOURCES } = require('../shared/facts.cjs');
const { ABSTAIN, CHOICE, answerState, unsafeQuestion } = require('../shared/laya-prompts.cjs');
const { CHOICE_BATCH, score, scoreChoices, pick, budget, timedOut, barsFor } = require('./laya-decisions.cjs');

function createFieldAnswers({ laya, now = Date.now, today } = {}) {
  if (typeof laya?.decideBatch !== 'function' || typeof laya?.format !== 'function') throw new TypeError('Field answers need a Laya runtime.');
  const optionFor = (question, scores, bar) => { const best = pick(scores, bar); return best >= 0 ? question.options[best] : null; };
  // One pass over `questions` with one facts sheet, in the prompts of the model's format. It calls
  // found(question, optionText or null) for each question decided before the deadline; a decision
  // that came after it is dropped, and nothing more is asked.
  const passes = {
    // noul-v1: one request per question, scoring each option and "the facts don't say" on its own.
    'noul-v1': async (facts, questions, bar, more, found) => {
      for (const question of questions) {
        if (!more()) return;
        const scores = await score(laya, [...question.options, ABSTAIN].map(candidate => answerState(facts, question.label, candidate)));
        if (!more()) return;
        found(question, optionFor(question, scores, bar));
      }
    },
    // choice-v2 (#65): every option of a question in one pass, CHOICE_BATCH questions per request.
    'choice-v2': async (facts, questions, bar, more, found) => {
      for (let start = 0; start < questions.length; start += CHOICE_BATCH) {
        if (!more()) return;
        const chunk = questions.slice(start, start + CHOICE_BATCH);
        const scores = await scoreChoices(laya, chunk.map(question => ({ state: CHOICE.answerState(facts, question.label), question: CHOICE.answerQuestion(question.options) })));
        if (!more()) return;
        chunk.forEach((question, index) => found(question, optionFor(question, scores[index], bar)));
      }
    }
  };
  // Questions in page order: { id, label, type, options }, and the milliseconds the click has left.
  // Returns { answers: { [id]: optionText }, sensitive: [id], sensitiveFields: [field] }: `sensitive`
  // lists the answers that needed a sensitive fact, and `sensitiveFields` the saved fields behind
  // the sensitive facts the model was given.
  async function answer({ questions, profile, budgetMs }) {
    const more = budget(budgetMs, now);
    const { format, bars } = await barsFor(laya);
    const pass = passes[format];
    if (!pass) throw new Error(`Field answers can’t ask a Laya model in the ${format} format.`);
    const facts = buildFacts(profile, { today });
    const everyday = factsText(facts.filter(fact => !fact.sensitive));
    const everything = factsText(facts);
    // An option that reads like the abstain candidate can't be told apart from it, so that question is the applicant's.
    const open = questions.filter(question => !unsafeQuestion(question) && !question.options.includes(ABSTAIN));
    const answers = {}, sensitive = [];
    try {
      // First pass: facts that are not sensitive.
      if (everyday) await pass(everyday, open, bars.answer, more, (question, option) => { if (option !== null) answers[question.id] = option; });
      // Second pass: the questions still open, with every fact. Their answers needed a sensitive one.
      if (everything !== everyday) {
        await pass(everything, open.filter(item => !Object.hasOwn(answers, item.id)), bars.answer, more, (question, option) => {
          if (option !== null) { answers[question.id] = option; sensitive.push(question.id); }
        });
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
