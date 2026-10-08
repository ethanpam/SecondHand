'use strict';
// How often the desktop app fills a question wrong with a real Laya export (#143). Each final-holdout form is
// asked as one Autofill click asks it, through the desktop's own request code: desktop/field-answers.cjs for
// its choice questions, one fictional household at a time, and desktop/field-suggestions.cjs for its text
// boxes. Every fill is checked against the answer key (dataset/build.cjs): a wrong fill is an answer the key
// doesn't give, including any fill where the key says the facts don't say. The click's clock is held still and its
// time limit left off each request, so every question is decided however long the model takes on a busy
// computer; tests/laya-speed.cjs checks speed. Laya's best guesses (#185) are asked for too, though Autofill
// doesn't ask for them, and checked against the same key apart from its sure answers: a report, never a budget (#189).
//
//   node ML_model/eval/app_accuracy.cjs --model <export folder> --format <format> [--per-question 8] [--out <report.json>]
// tests/laya-parity.test.cjs runs it with SECONDHAND_LAYA_ACCURACY=1 and checks WRONG_FILL_BUDGETS.
const fs = require('node:fs');
const { createLaya } = require('../../desktop/laya.cjs');
const { createFieldAnswers } = require('../../desktop/field-answers.cjs');
const { createFieldSuggestions } = require('../../desktop/field-suggestions.cjs');
const { BUDGET_MS } = require('../../desktop/laya-decisions.cjs');
const { TEXT_TYPES } = require('../../shared/laya-prompts.cjs');
const { choiceDecisions, formKey, ABSTAIN } = require('../dataset/build.cjs');
const { loadFinalBank } = require('../question-bank.cjs');
const { generateHouseholds } = require('../profiles/generate.cjs');

// The share of a task's decisions the app may fill wrong on the final holdout, per model format: a little over
// what this job measured on 2026-10-06 (ML_model/eval/reports/*-final-app-fills.json): round 2's noul-v1 export
// filled 17 of 1,232 answers wrong (1.38%) and 5 of 222 boxes (2.25%); round 4's choice-v2 export 31 of 1,232
// (2.52%) and 1 of 222 (0.45%). The decisions are the same each run: one more wrong fill in a task passes, two fail.
const WRONG_FILL_BUDGETS = Object.freeze({
  'noul-v1': Object.freeze({ answering: 0.015, matching: 0.03 }),
  'choice-v2': Object.freeze({ answering: 0.026, matching: 0.01 })
});
// The final holdout as its reports scored it (docs/laya-model.md: build.cjs --final --today 2026-09-26
// --households 400 --seed 11 --per-question 8): 400 fictional households, up to 8 per choice question, taken
// across its right answers.
const FINAL = Object.freeze({ today: '2026-09-26', count: 400, seed: 11, perQuestion: 8 });

const asAsked = ({ id, label, type, options }) => ({ id, label, type, options });

// { answering, guessing, matching }: each task's decisions, fills, right fills and wrong fills ({ form, question, filled, key }).
// `guessing` is the best guesses on the answering task's decisions: no decisions of its own, and its wrongRate is
// the share of the guesses that were wrong (null when there were none).
async function appAccuracy({ laya, bank, households, today, perQuestion = Infinity }) {
  const still = () => 0;
  const unhurried = { ...laya, decideBatch: (items, { timeoutMs, ...options } = {}) => laya.decideBatch(items, options) };
  const answerer = createFieldAnswers({ laya: unhurried, today, now: still });
  const matcher = createFieldSuggestions({ laya: unhurried, now: still });
  const answering = { decisions: 0, filled: 0, right: 0, wrong: [] };
  const guesses = { filled: 0, right: 0, wrong: [] };
  const forms = new Map(bank.flatMap(file => file.questions.map(question => [question, formKey(file)])));
  // A fill is right when it is the key's option; where the key says the facts don't say, every fill is wrong.
  const check = (task, question, filled, answer) => {
    task.filled++;
    if (filled === answer && answer !== ABSTAIN) task.right++;
    else task.wrong.push({ form: forms.get(question), question: question.label, filled, key: answer === ABSTAIN ? null : answer });
  };
  for (const { question, index, answer } of choiceDecisions(bank, households, { today, perQuestion })) {
    answering.decisions++;
    const { answers, guesses: guessed } = await answerer.answer({ questions: [asAsked(question)], profile: households[index], budgetMs: BUDGET_MS, guess: true });
    if (Object.hasOwn(answers, question.id)) check(answering, question, answers[question.id], answer);
    else if (Object.hasOwn(guessed, question.id)) check(guesses, question, guessed[question.id], answer);
  }
  const guessing = { filled: guesses.filled, right: guesses.right, wrongRate: guesses.filled ? guesses.wrong.length / guesses.filled : null, wrong: guesses.wrong };
  const matching = { decisions: 0, filled: 0, right: 0, wrong: [] };
  for (const file of bank) {
    // A date box is never asked (date of birth is never offered), so, as in the reports, it isn't a decision.
    const boxes = file.questions.filter(question => TEXT_TYPES.includes(question.type) && question.type !== 'date');
    matching.decisions += boxes.length;
    const suggestions = await matcher.suggest(boxes.map(asAsked), { budgetMs: BUDGET_MS });
    for (const box of boxes) {
      if (!Object.hasOwn(suggestions, box.id)) continue;
      matching.filled++;
      const key = box.rule.name === 'field' ? box.rule.key : null;
      if (suggestions[box.id] === key) matching.right++;
      else matching.wrong.push({ form: formKey(file), question: box.label, filled: suggestions[box.id], key });
    }
  }
  return { answering, guessing, matching };
}

// The tasks whose wrong fills are over their share of the task's decisions, one line each. A task with no
// decisions fails too: it checked nothing.
function overBudget(result, budget) {
  const failures = [];
  for (const task of ['answering', 'matching']) {
    const { decisions, wrong } = result[task];
    if (!decisions) failures.push(`${task}: no decisions were asked`);
    else if (wrong.length / decisions > budget[task]) {
      failures.push(`${task}: ${wrong.length} wrong fills in ${decisions} decisions (${(wrong.length / decisions * 100).toFixed(2)}%) is over its budget of ${budget[task] * 100}%`);
    }
  }
  return failures;
}

// The final holdout's forms and households, as appAccuracy takes them.
function finalHoldout({ perQuestion = FINAL.perQuestion } = {}) {
  return { bank: loadFinalBank(), households: generateHouseholds({ count: FINAL.count, seed: FINAL.seed, today: FINAL.today }), today: FINAL.today, perQuestion };
}

async function main() {
  const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
  const modelDir = arg('model'), format = arg('format');
  if (!modelDir || !Object.hasOwn(WRONG_FILL_BUDGETS, format)) throw new Error(`Usage: node ML_model/eval/app_accuracy.cjs --model <export folder> --format <${Object.keys(WRONG_FILL_BUDGETS).join(' | ')}> [--per-question 8] [--out <report.json>]`);
  const laya = createLaya({ modelDir, modelFormat: format, manifest: { version: 1, model: null }, enabled: true, timeoutMs: 5 * 60 * 1000 });
  try {
    const result = await appAccuracy({ laya, ...finalHoldout({ perQuestion: Number(arg('per-question', String(FINAL.perQuestion))) }) });
    const report = { model: modelDir, format, ...FINAL, perQuestion: Number(arg('per-question', String(FINAL.perQuestion))), budget: WRONG_FILL_BUDGETS[format], overBudget: overBudget(result, WRONG_FILL_BUDGETS[format]), ...result };
    const text = JSON.stringify(report, null, 2);
    console.log(text);
    if (arg('out')) fs.writeFileSync(arg('out'), `${text}\n`);
    if (report.overBudget.length) process.exitCode = 1;
  } finally {
    await laya.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { appAccuracy, overBudget, finalHoldout, WRONG_FILL_BUDGETS, FINAL };
