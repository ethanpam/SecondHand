'use strict';
// scripts/smoke-checks.cjs: what the OCR and Laya smokes check about the results they get. Each check fails
// when the smoke would otherwise pass with nothing checked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkOcrResult, checkSameReading, checkLayaRequests } = require('../scripts/smoke-checks.cjs');

const word = { text: 'Synthetic', bbox: { x0: 1, y0: 1, x1: 9, y1: 9 } };
const ocrPage = (extra = {}) => ({ text: 'SYNTHETIC DOCUMENT', words: [word], alternative: { words: [word] }, ...extra });

test('an OCR result passes only with every page it counted, each with text and positioned words from both passes', () => {
  checkOcrResult({ pageCount: 1, pages: [ocrPage()] }, { pages: 1 });
  checkOcrResult({ pageCount: 2, pages: [ocrPage(), ocrPage()] });
  assert.throws(() => checkOcrResult({ pageCount: 0, pages: [] }), { message: 'OCR returned no pages.' });
  assert.throws(() => checkOcrResult({ pageCount: 2, pages: [ocrPage()] }), { message: 'OCR counted 2 pages but returned 1.' });
  assert.throws(() => checkOcrResult({ pageCount: 2, pages: [ocrPage(), ocrPage()] }, { pages: 1 }), { message: 'OCR read 2 pages; the document has 1.' });
  assert.throws(() => checkOcrResult({ pageCount: 1, pages: [ocrPage({ text: '' })] }), { message: 'OCR must return text and positioned words (page 1).' });
  assert.throws(() => checkOcrResult({ pageCount: 1, pages: [ocrPage({ words: [] })] }), { message: 'OCR must return text and positioned words (page 1).' });
  assert.throws(() => checkOcrResult({ pageCount: 1, pages: [ocrPage({ alternative: { words: [] } })] }), { message: 'Both segmentation passes must return positioned words (page 1).' });
});

// One document's reading: its pages and what the parser suggests from them.
const reading = (page = {}, fields = [{ id: 'applicantFirstName', value: 'SYNTHETIC' }]) => ({ pageCount: 1,
  pages: [{ pageNumber: 1, width: 10, height: 10, confidence: 90, ...ocrPage(), ...page }], analysis: { type: '1040-sr', fields, warnings: [] } });

test('two readings of one document, at display scales 1 and 2, pass only with the same pages, words and suggestions (#260)', () => {
  checkSameReading(reading(), reading());
  const twoPages = { ...reading(), pageCount: 2, pages: [...reading().pages, { ...reading().pages[0], pageNumber: 2 }] };
  assert.throws(() => checkSameReading(reading(), twoPages), { message: 'The readings have 1 and 2 pages.' });
  assert.throws(() => checkSameReading(reading(), reading({ words: [word, word] })), { message: 'Page 1 reads differently: 1 and 2 words, 1 and 1 in the sparse-text pass.' });
  const moved = { ...word, bbox: { ...word.bbox, x1: 8 } };
  assert.throws(() => checkSameReading(reading(), reading({ alternative: { words: [moved] } })), { message: 'Page 1 reads differently: 1 and 1 words, 1 and 1 in the sparse-text pass.' });
  assert.throws(() => checkSameReading(reading(), reading({ text: 'SYNTHETIC DOCUMENT 2' })), { message: 'Page 1 reads differently: 1 and 1 words, 1 and 1 in the sparse-text pass.' });
  const ssn = { id: 'applicantSsn', value: '000-00-0000' };
  assert.throws(() => checkSameReading(reading({}, [reading().analysis.fields[0], ssn]), reading()), { message: 'The suggestions differ: applicantSsn.' });
  assert.throws(() => checkSameReading(reading(), reading({}, [{ id: 'applicantFirstName', value: 'SYNTHETlC' }])), { message: 'The suggestions differ: applicantFirstName.' });
  const warned = reading(); warned.analysis.warnings.push('Some tax amounts could not be read consistently and were left out.');
  assert.throws(() => checkSameReading(reading(), warned), { message: 'The suggestions match; the document type, tax year or warnings differ.' });
});

const suggest = { type: 'suggestFields', url: 'https://pantry.example.org/a', budgetMs: 2900, fields: [{ id: 'f0:sh-1-1', label: 'Where can we reach you?', type: 'email', options: [] }] };
const answer = { type: 'answerFields', url: 'https://pantry.example.org/b', budgetMs: 2800, questions: [{ id: 'f0:sh-2-1', label: 'Is anyone 60 or older?', type: 'radio', options: ['Yes', 'No'] }] };

test('every Laya request of the whole run carries labels only and its time left, and the run asked both kinds', () => {
  const calls = [{ type: 'status' }, suggest, { type: 'getFields', fields: ['email'] }, answer];
  assert.deepEqual(checkLayaRequests(calls, ['Avery', 'avery@example.invalid']), { suggestFields: 1, answerFields: 1 });
  assert.throws(() => checkLayaRequests([{ type: 'status' }, answer], []), { message: 'The run made no suggestFields request, so none was checked.' });
  assert.throws(() => checkLayaRequests([suggest], []), { message: 'The run made no answerFields request, so none was checked.' });
  assert.throws(() => checkLayaRequests([suggest, answer, { ...answer, questions: [{ ...answer.questions[0], label: 'Avery, is anyone 60 or older?' }] }], ['Avery']),
    { message: 'answerFields carried a saved value (request 3).' });
  assert.throws(() => checkLayaRequests([suggest, { ...answer, values: {} }], []), { message: 'answerFields carried more than its questions (request 2): budgetMs, questions, type, url, values.' });
  assert.throws(() => checkLayaRequests([{ ...suggest, budgetMs: 3001 }, answer], []), { message: 'suggestFields must carry the time its click has left, 1 to 3000 ms (request 1).' });
});
