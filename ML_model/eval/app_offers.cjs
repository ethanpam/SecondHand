'use strict';
// What the desktop app asks of each decision in a noul-v1 dataset, from its own code, so decisions.py --as-app-asks
// scores only that: the saved fields it offers each text box (desktop/field-suggestions.cjs, offeredFields) and
// whether it asks each choice question at all (desktop/field-answers.cjs, factsCover). Prints
// { match: { decision: [candidate, ...] }, answer: { decision: true | false } } as JSON. The abstain row is always
// asked, so it isn't listed, and a box offered nothing (a date box) has an empty list.
//
//   node ML_model/eval/app_offers.cjs <dataset folder> [--final]
const fs = require('node:fs');
const path = require('node:path');
const { offeredFields, factsCover, matchState } = require('../../shared/laya-prompts.cjs');
const { loadQuestionBank, loadSyntheticBank, loadFinalBank } = require('../question-bank.cjs');
const { formKey } = require('../dataset/build.cjs');

function appOffers(rows, bank) {
  const questions = new Map(bank.flatMap(form => form.questions.map(question => [`${formKey(form)}#${question.id}`, question])));
  const find = (key, label, decision) => {
    const question = questions.get(key);
    if (!question) throw new Error(`${decision} isn’t in the question bank.`);
    if (question.label !== label) throw new Error(`${decision}: the dataset’s label ${JSON.stringify(label)} isn’t the bank’s ${JSON.stringify(question.label)}.`);
    return question;
  };
  const match = {}, answer = {};
  for (const row of rows) {
    if (row.task === 'match' && !Object.hasOwn(match, row.decision)) {
      const question = find(row.decision, row.state.question, row.decision);
      match[row.decision] = offeredFields(question).map(key => matchState(question.label, key).candidate);
    } else if (row.task === 'answer' && !Object.hasOwn(answer, row.decision)) {
      // An answering decision is one question for one household: <form>#<question>#<household>.
      answer[row.decision] = factsCover(find(row.decision.slice(0, row.decision.lastIndexOf('#')), row.state.question, row.decision));
    }
  }
  return { match, answer };
}

function main() {
  const [directory] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  if (!directory) throw new Error('Usage: node ML_model/eval/app_offers.cjs <dataset folder> [--final]');
  const bank = process.argv.includes('--final') ? loadFinalBank() : [...loadQuestionBank(), ...loadSyntheticBank()];
  const rows = fs.readFileSync(path.join(directory, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  process.stdout.write(`${JSON.stringify(appOffers(rows, bank))}\n`);
}

if (require.main === module) main();

module.exports = { appOffers };
