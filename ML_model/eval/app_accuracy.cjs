'use strict';
// How often the desktop app fills a question wrong with a real Laya export (#143). Each final-holdout form is
// asked as one Autofill click asks it, through the desktop's own request code: desktop/field-answers.cjs for
// its choice questions, one fictional household at a time, and desktop/field-suggestions.cjs for its text
// boxes. Every fill is checked against the answer key (dataset/build.cjs): a wrong fill is an answer the key
// doesn't give, including any fill where the key says the facts don't say. The clock is held still, so every
// question is decided however long the model takes; tests/laya-parity.test.cjs checks speed.
//
//   node ML_model/eval/app_accuracy.cjs --model <export folder> --format <format> [--per-question 24] [--out <report.json>]
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

// The share of a task's decisions the app may fill wrong on the final holdout, per model format: just over
// what each model filled wrong there at the app's bars (docs/laya-model.md; ML_model/eval/reports
// round2-onnx-int8-final-app.json and round4-onnx-int8-final.json): noul-v1 15 of 1,232 answers (1.2%) and 9
// of 222 boxes (4.1%), choice-v2 30 of 1,232 (2.4%) and 1 of 222 (0.5%).
const WRONG_FILL_BUDGETS = Object.freeze({
  'noul-v1': Object.freeze({ answering: 0.02, matching: 0.05 }),
  'choice-v2': Object.freeze({ answering: 0.03, matching: 0.01 })
});
// The final holdout as the reports scored it: build.cjs's households (2,000 from seed 7), up to 24 per
// choice question, taken across its right answers.
const FINAL = Object.freeze({ today: '2026-09-26', count: 2000, seed: 7, perQuestion: 24 });

const asAsked = ({ id, label, type, options }) => ({ id, label, type, options });

// { answering, matching }: each task's decisions, fills, right fills and wrong fills ({ form, question, filled, key }).
async function appAccuracy({ laya, bank, households, today, perQuestion = Infinity }) {
  const still = () => 0;
  const answerer = createFieldAnswers({ laya, today, now: still });
  const matcher = createFieldSuggestions({ laya, now: still });
  const answering = { decisions: 0, filled: 0, right: 0, wrong: [] };
  const forms = new Map(bank.flatMap(file => file.questions.map(question => [question, formKey(file)])));
  for (const { question, index, answer } of choiceDecisions(bank, households, { today, perQuestion })) {
    answering.decisions++;
    const { answers } = await answerer.answer({ questions: [asAsked(question)], profile: households[index], budgetMs: BUDGET_MS });
    if (!Object.hasOwn(answers, question.id)) continue;
    answering.filled++;
    if (answers[question.id] === answer && answer !== ABSTAIN) answering.right++;
    else answering.wrong.push({ form: forms.get(question), question: question.label, filled: answers[question.id], key: answer === ABSTAIN ? null : answer });
  }
  const matching = { decisions: 0, filled: 0, right: 0, wrong: [] };
  for (const file of bank) {
    const boxes = file.questions.filter(question => TEXT_TYPES.includes(question.type));
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
  return { answering, matching };
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
  if (!modelDir || !Object.hasOwn(WRONG_FILL_BUDGETS, format)) throw new Error(`Usage: node ML_model/eval/app_accuracy.cjs --model <export folder> --format <${Object.keys(WRONG_FILL_BUDGETS).join(' | ')}> [--per-question 24] [--out <report.json>]`);
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
