'use strict';
// The saved fields the desktop app offers each text box of a noul-v1 dataset, so decisions.py --as-app-asks
// scores a box only on the rows the app asks the model (desktop/field-suggestions.cjs, shared/laya-prompts.cjs
// offeredFields). Prints { decision: [candidate, ...] } as JSON: the abstain row is always asked, so it isn't listed,
// and a box offered nothing (a date box) has an empty list.
//
//   node ML_model/eval/app_offers.cjs <dataset folder> [--final]
const fs = require('node:fs');
const path = require('node:path');
const { offeredFields, matchState } = require('../../shared/laya-prompts.cjs');
const { loadQuestionBank, loadSyntheticBank, loadFinalBank } = require('../question-bank.cjs');
const { formKey } = require('../dataset/build.cjs');

function appOffers(rows, bank) {
  const questions = new Map(bank.flatMap(form => form.questions.map(question => [`${formKey(form)}#${question.id}`, question])));
  const offers = {};
  for (const row of rows) {
    if (row.task !== 'match' || Object.hasOwn(offers, row.decision)) continue;
    const question = questions.get(row.decision);
    if (!question) throw new Error(`${row.decision} isn’t in the question bank.`);
    if (question.label !== row.state.question) throw new Error(`${row.decision}: the dataset’s label ${JSON.stringify(row.state.question)} isn’t the bank’s ${JSON.stringify(question.label)}.`);
    offers[row.decision] = offeredFields(question).map(key => matchState(question.label, key).candidate);
  }
  return offers;
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
