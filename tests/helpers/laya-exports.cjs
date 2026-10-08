'use strict';
// The real Laya exports the model checks run, one per model format the app runs, each named by its own variable,
// with the Python reference outputs made from it by ML_model/eval/runtime_fixtures.py. tests/laya-parity.test.cjs
// checks the desktop runtime against those outputs; tests/laya-speed.cjs times it on the same decisions.
const fs = require('node:fs');
const path = require('node:path');

const SETS = [
  { format: 'noul-v1', fixture: 'parity-noul.json', env: 'SECONDHAND_LAYA_NOUL_MODEL_DIR' },
  { format: 'choice-v2', fixture: 'parity-choice.json', env: 'SECONDHAND_LAYA_CHOICE_MODEL_DIR' }
];
const NO_MODEL = { version: 1, model: null };
const load = fixture => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/laya', fixture), 'utf8'));
// A reference decision asks one question.
const only = decision => Object.values(decision.questions)[0];

module.exports = { SETS, NO_MODEL, load, only };
