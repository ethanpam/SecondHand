'use strict';
// #42: answers choice and yes/no questions from the saved profile, with Laya on this computer.
// The facts sheet is built and read here only; the caller gets back option text alone, and asks
// the applicant before any of it reaches a website.
const { buildFacts, factsText, SENSITIVE_SOURCES } = require('../shared/facts.cjs');
const { ABSTAIN, CHOICE, answerState, factsCover, unsafeQuestion, sensitiveQuestion } = require('../shared/laya-prompts.cjs');
const { CHOICE_BATCH, score, scoreChoices, pick, bestGuess, budget, timedOut, inOrder, byCost, barsFor } = require('./laya-decisions.cjs');

// #185: the questions Laya may guess at, where it has no sure answer: single-choice ones (a radio group or a dropdown,
// yes/no included), never a checkbox group, and never one about a sensitive detail.
const GUESS_TYPES = Object.freeze(['radio', 'select']);
const guessable = question => GUESS_TYPES.includes(question.type) && !sensitiveQuestion(question);

function createFieldAnswers({ laya, now = Date.now, today } = {}) {
  if (typeof laya?.decideBatch !== 'function' || typeof laya?.format !== 'function') throw new TypeError('Field answers need a Laya runtime.');
  // One pass over `questions` with one facts sheet, in the prompts of the model's format. It calls
  // found(question, scores) for each question decided before the deadline, the abstain candidate's score
  // last; a decision that came after it is dropped, and nothing more is asked.
  const passes = {
    // noul-v1: one request per question, scoring each option and "the facts don't say" on its own.
    // Every question of the pass is asked at once, each request ending when the click's time does. A question
    // on no topic the facts cover isn't asked (factsCover).
    'noul-v1': async (facts, questions, more, found) => {
      questions = questions.filter(factsCover);
      const timeoutMs = more.left();
      if (!questions.length || !more() || timeoutMs < 1) return;
      const requests = questions.map(question => score(laya, [...question.options, ABSTAIN].map(candidate => answerState(facts, question.label, candidate)), { timeoutMs }));
      await inOrder(requests, more, (index, scores) => found(questions[index], scores));
    },
    // choice-v2 (#65): every option of a question in one pass, CHOICE_BATCH questions per request.
    'choice-v2': async (facts, questions, more, found) => {
      for (let start = 0; start < questions.length; start += CHOICE_BATCH) {
        if (!more()) return;
        const chunk = questions.slice(start, start + CHOICE_BATCH);
        const scores = await scoreChoices(laya, chunk.map(question => ({ state: CHOICE.answerState(facts, question.label), question: CHOICE.answerQuestion(question.options) })));
        if (!more()) return;
        chunk.forEach((question, index) => found(question, scores[index]));
      }
    }
  };
  // The groups of questions decided one after another, each through both passes, so a long checklist
  // can't keep the short questions from their answers (#90).
  const groups = {
    // noul-v1: a question costs a pass per option, plus abstaining: cheapest first (byCost).
    'noul-v1': questions => byCost(questions, question => question.options.length + 1),
    // choice-v2: every question is one pass, so one group, in page order.
    'choice-v2': questions => [questions]
  };
  // Questions in page order: { id, label, type, options }, the milliseconds the click has left, the
  // day ages are worked out on (the caller's, or this answerer's), and whether Laya may guess (#185).
  // Returns { answers: { [id]: optionText }, guesses: { [id]: optionText }, sensitive: [id], sensitiveFields: [field] }:
  // `answers` are the sure ones; `sensitive` lists those that needed a sensitive fact, and `sensitiveFields` the saved
  // fields behind the sensitive facts the model was given. With `guess`, `guesses` are Laya's best guesses on the
  // guessable questions it has no sure answer for, from the everyday facts alone: its top option where that beats
  // "the facts don't say" (bestGuess). They come from the passes asked for the answers, never another.
  async function answer({ questions, profile, budgetMs, today: day = today, guess = false }) {
    const more = budget(budgetMs, now);
    const { format, bars } = await barsFor(laya);
    const pass = passes[format];
    if (!pass) throw new Error(`Field answers can’t ask a Laya model in the ${format} format.`);
    const facts = buildFacts(profile, { today: day });
    const everyday = factsText(facts.filter(fact => !fact.sensitive));
    const everything = factsText(facts);
    // An option that reads like the abstain candidate can't be told apart from it, so that question is the applicant's.
    const open = questions.filter(question => !unsafeQuestion(question) && !question.options.includes(ABSTAIN));
    const fromEveryday = new Map(), fromEverything = new Map(), guessed = new Map();
    const sure = (question, scores) => { const best = pick(scores, bars.answer); return best >= 0 ? question.options[best] : null; };
    try {
      for (const group of groups[format](open)) {
        // First pass: facts that are not sensitive. A question it leaves open may get a guess from them.
        if (everyday) await pass(everyday, group, more, (question, scores) => {
          const option = sure(question, scores);
          if (option !== null) fromEveryday.set(question.id, option);
          else if (guess && guessable(question)) { const best = bestGuess(scores); if (best >= 0) guessed.set(question.id, question.options[best]); }
        });
        // Second pass: the questions still open, with every fact. Their answers needed a sensitive one.
        if (everything !== everyday) {
          await pass(everything, group.filter(item => !fromEveryday.has(item.id)), more, (question, scores) => {
            const option = sure(question, scores);
            if (option !== null) fromEverything.set(question.id, option);
          });
        }
      }
    } catch (error) {
      if (!timedOut(error)) throw error;
    }
    // In page order, the answers from everyday facts first.
    const answers = {}, guesses = {}, sensitive = [];
    for (const question of open) if (fromEveryday.has(question.id)) answers[question.id] = fromEveryday.get(question.id);
    for (const question of open) if (fromEverything.has(question.id)) { answers[question.id] = fromEverything.get(question.id); sensitive.push(question.id); }
    // A guess only where no pass was sure, in page order.
    for (const question of open) if (guessed.has(question.id) && !Object.hasOwn(answers, question.id)) guesses[question.id] = guessed.get(question.id);
    const sensitiveFields = sensitive.length ? [...new Set(facts.filter(fact => fact.sensitive).flatMap(fact => fact.sources.filter(source => SENSITIVE_SOURCES.includes(source))))] : [];
    return { answers, guesses, sensitive, sensitiveFields };
  }
  return Object.freeze({ answer });
}

module.exports = { createFieldAnswers };
