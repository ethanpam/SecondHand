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

// Overlaps reviewed and accepted: synthetic labels that repeat a final label, each written before the final
// forms existed (commits c705790, e4b1ddf and 0dc7b75 on 2026-09-26/27, and 4b895e5 at 19:18 on 2026-09-29;
// the final forms came in a7d3eb1 at 19:51), in wording forms share: none is a copy.
const ACCEPTED = [
  { at: 'applicant-vs-household.json a22', label: 'Are you a U.S. citizen?', why: 'a common yes/no wording, written in a separate worktree before the final forms were collected' },
  { at: 'look-alikes.json s45', label: 'Are you a U.S. citizen?', why: 'a common yes/no wording, written three days before the final forms' },
  { at: 'counts-and-ages.json s2', label: 'Household size', why: 'a generic two-word label' },
  { at: 'text-boxes.json s86', label: 'Household size', why: 'a generic two-word label' },
  { at: 'hard-negatives.json h18', label: 'If yes, please explain', why: 'a generic follow-up label' },
  { at: 'income-and-place.json s74', label: 'Which county do you reside in?', why: 'a common wording of the county question' },
  { at: 'look-alikes.json s125', label: 'Marital status', why: 'a generic two-word label' },
  { at: 'round2-synthetic.json q106', label: 'Your Name', why: 'a generic two-word label' },
  { at: 'text-boxes.json s7', label: 'Middle name', why: 'a generic two-word label' }
];

test('a leak is a final form’s site, a synthetic question repeating a final label, or a training form repeating a distinctive final question', () => {
  const final = loadFinalBank(FIXTURE);
  assert.deepEqual(finalLeaks(final, trainingBank()), [], 'the fixture shares nothing with the real training data');
  const synthetic = questions => ({ file: 'x.json', source: { title: 'R', kind: 'synthetic', retrieved: '2026-09-29' }, questions });
  const real = (url, question) => ({ file: 'real.json', source: { url, title: 'R', kind: 'web', retrieved: '2026-09-26' }, questions: [question] });
  const copied = { id: 'r1', label: 'Does anyone in your home have a paying job right now?', type: 'radio', options: ['Yes', 'No'], rule: { name: 'none' } };
  // Planted copies of a final question.
  assert.deepEqual(finalLeaks(final, [synthetic([{ ...copied, id: 's1' }])]), ['x.json s1: label "Does anyone in your home have a paying job right now?" is on final form example-final-pantry.json (q1)']);
  assert.deepEqual(finalLeaks(final, [synthetic([{ id: 's2', label: 'Daytime number!', type: 'tel', options: [], rule: { name: 'field', key: 'phone' } }])]),
    ['x.json s2: label "Daytime number!" is on final form example-final-pantry.json (q4)'], 'a synthetic question may not repeat even a short final label');
  assert.deepEqual(finalLeaks(final, [real('https://other.example.org/form', copied)]),
    ['real.json r1: the question "Does anyone in your home have a paying job right now?" and its options are on final form example-final-pantry.json (q1)']);
  // The final form's own site.
  assert.deepEqual(finalLeaks(final, [real('https://final-pantry.example.org/intake', { ...copied, label: 'Email' })]), ['real.json: https://final-pantry.example.org/intake is a final form']);
  assert.deepEqual(finalLeaks(final, [real('https://final-pantry.example.org/older-form', { ...copied, label: 'Email' })]), ['real.json: final-pantry.example.org is a final form’s site']);
  // Common phrasing real forms share: options, short labels, the same label with other options, and form platforms.
  const common = { id: 'r2', label: 'Sharing', type: 'checkbox', options: ['I allow sharing my answers with partner agencies', 'Prefer not to answer'], rule: { name: 'never' } };
  assert.deepEqual(finalLeaks(final, [real('https://other.example.org/form', common)]), [], 'an option alone');
  assert.deepEqual(finalLeaks(final, [real('https://other.example.org/form', { id: 'r3', label: 'Daytime number', type: 'tel', options: [], rule: { name: 'field', key: 'phone' } })]), [], 'a short label');
  assert.deepEqual(finalLeaks(final, [real('https://other.example.org/form', { ...copied, options: ['Yes', 'No', 'Some of us'] })]), [], 'a long label with other options');
  const platform = form => ({ ...form, source: { ...form.source, url: 'https://docs.google.com/forms/d/e/elsewhere/viewform' } });
  const onPlatform = loadFinalBank(FIXTURE).map(platform);
  assert.deepEqual(finalLeaks(onPlatform, [real('https://docs.google.com/forms/d/e/another/viewform', { ...copied, label: 'Email' })]), [], 'forms on the same platform are different organizations');
  // Accepted overlaps are listed, and only real overlaps can be accepted.
  assert.deepEqual(finalLeaks(final, [synthetic([{ ...copied, id: 's1' }])], ['x.json s1']), []);
  assert.throws(() => finalLeaks(final, [synthetic([{ ...copied, id: 's1', label: 'Something else' }])], ['x.json s1']), /x.json s1.*no longer overlaps/);
});

test('the real final forms, once collected, share nothing with the training data but the reviewed overlaps', { skip: fs.existsSync(FINAL_DIR) ? false : 'ML_model/questions-final/ has not been collected yet.' }, () => {
  const final = loadFinalBank();
  assert.deepEqual(finalLeaks(final, trainingBank(), ACCEPTED.map(item => item.at)), []);
  const labels = new Set(final.flatMap(file => file.questions.map(question => question.label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())));
  for (const item of ACCEPTED) assert.ok(labels.has(item.label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()), item.at);
});
