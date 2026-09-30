'use strict';
// The final holdout (#65): real forms in ML_model/questions-final/, collected after round 3 and scored
// once, after the confidence bars are frozen. Training never reads them. These tests use a synthetic
// fixture folder; the last one checks the real folder once it exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadQuestionBank, loadSyntheticBank, loadFinalBank, finalLeaks, validateQuestionFile, FINAL_DIR } = require('../ML_model/question-bank.cjs');
const { writeDataset, writeFinalDataset, splitFor } = require('../ML_model/dataset/build.cjs');

const FIXTURE = path.join(__dirname, 'fixtures/questions-final');
const TODAY = '2026-09-26';
const family = { birthDate: '1985-04-12', householdSize: '3', householdAdults: '2', householdChildren: '1', householdSeniors: '0', state: 'IA', county: 'Polk', householdVeteran: 'no' };
const temporary = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-final-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const write = (dir, name, file) => fs.writeFileSync(path.join(dir, name), JSON.stringify(file));
const form = (source, questions) => ({ source: { url: 'https://pantry.example.org/a', title: 'A', kind: 'web', retrieved: '2026-09-29', ...source }, questions });
const yesNo = { id: 'q1', label: 'Anyone 65 or older at home?', type: 'radio', options: ['Yes', 'No'], rule: { name: 'anySenior65' } };
// The real training data: training forms and synthetic rewordings.
const trainingBank = () => [...loadQuestionBank().filter(file => !file.source.holdout && splitFor(file.source.url) === 'train'), ...loadSyntheticBank()];

test('final forms live in their own folder: they must say final, be real forms, and never be marked holdout', t => {
  const final = loadFinalBank(FIXTURE);
  assert.equal(final.length, 1);
  assert.ok(final.every(file => file.source.final === true && file.source.kind !== 'synthetic'));
  assert.equal(FINAL_DIR, path.join(__dirname, '../ML_model/questions-final'));
  assert.throws(() => validateQuestionFile(form({ final: 'yes' }, [yesNo])), /final/);
  assert.throws(() => validateQuestionFile(form({ final: true, holdout: true }, [yesNo])), /final/);
  assert.throws(() => validateQuestionFile({ source: { title: 'R', kind: 'synthetic', retrieved: '2026-09-29', final: true }, questions: [yesNo] }), /final/);
  const dir = temporary(t);
  write(dir, 'final.json', form({ final: true }, [yesNo]));
  assert.throws(() => loadQuestionBank(dir), /questions-final/, 'a final form in questions/ is refused');
  const other = temporary(t);
  write(other, 'plain.json', form({}, [yesNo]));
  assert.throws(() => loadFinalBank(other), /final: true/, 'a form in questions-final/ must say final');
  assert.throws(() => loadFinalBank(path.join(dir, 'missing')), /ENOENT/, 'a missing folder is an error, not an empty holdout');
});

test('the training dataset refuses final forms; the final dataset is test rows only, as the app asks them', t => {
  const final = loadFinalBank(FIXTURE);
  assert.throws(() => writeDataset(temporary(t), final, [family], { today: TODAY, format: 'choice-v2' }), /final/);
  const out = temporary(t);
  const summary = writeFinalDataset(out, final, [family, {}], { today: TODAY, format: 'choice-v2' });
  const rows = fs.readFileSync(path.join(out, 'rows.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.length && rows.every(row => row.split === 'test'));
  assert.ok(rows.every(row => row.decision.startsWith('https://final-pantry.example.org/intake#')));
  assert.equal(rows.some(row => row.decision.includes('~')), false, 'no training-only groups of fields');
  assert.deepEqual(new Set(rows.map(row => row.task)), new Set(['answer', 'match']));
  assert.equal(summary.format, 'choice-v2');
  assert.equal(summary.bySplit.test, rows.length);
  assert.ok(writeFinalDataset(temporary(t), final, [family], { today: TODAY, format: 'noul-v1' }).rows > 0, 'the shipped format can be scored too');
  assert.throws(() => writeFinalDataset(temporary(t), [form({}, [yesNo])], [family], { today: TODAY, format: 'choice-v2' }), /final/);
});

test('a final form’s labels and distinctive options must not appear in training forms or synthetic rewordings', () => {
  const final = loadFinalBank(FIXTURE);
  assert.deepEqual(finalLeaks(final, trainingBank()), [], 'the fixture shares nothing with the real training data');
  const synthetic = { file: 'x.json', source: { title: 'R', kind: 'synthetic', retrieved: '2026-09-29' }, questions: [
    { id: 's1', label: 'Your given name!', type: 'text', options: [], rule: { name: 'field', key: 'firstName' } }] };
  assert.deepEqual(finalLeaks(final, [synthetic]), ['x.json s1: label "Your given name!" is on final form example-final-pantry.json (q3)']);
  const real = (url, question) => ({ file: 'real.json', source: { url, title: 'R', kind: 'web', retrieved: '2026-09-26' }, questions: [question] });
  const option = real('https://other.example.org/form', { id: 'r1', label: 'Sharing', type: 'checkbox', options: ['I allow sharing my answers with partner agencies'], rule: { name: 'never' } });
  assert.deepEqual(finalLeaks(final, [option]), ['real.json r1: option "I allow sharing my answers with partner agencies" is on final form example-final-pantry.json (q5)']);
  const longLabel = real('https://other.example.org/form', { id: 'r2', label: 'Does anyone in your home have a paying job right now?', type: 'radio', options: ['Yes', 'No'], rule: { name: 'none' } });
  assert.equal(finalLeaks(final, [longLabel]).length, 1, 'a real form sharing a whole distinctive question');
  const sameForm = real('https://final-pantry.example.org/intake', { id: 'r3', label: 'Email', type: 'email', options: [], rule: { name: 'field', key: 'email' } });
  assert.deepEqual(finalLeaks(final, [sameForm]), ['real.json: the form https://final-pantry.example.org/intake is a final form']);
  const generic = real('https://other.example.org/form', { id: 'r4', label: 'Daytime number', type: 'tel', options: [], rule: { name: 'field', key: 'phone' } });
  assert.deepEqual(finalLeaks(final, [generic]), [], 'real forms share short labels like "Daytime number" independently');
});

test('the real final forms, once collected, share nothing with the training data', { skip: fs.existsSync(FINAL_DIR) ? false : 'ML_model/questions-final/ has not been collected yet.' }, () => {
  assert.deepEqual(finalLeaks(loadFinalBank(), trainingBank()), []);
});
