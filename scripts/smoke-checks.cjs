'use strict';
// What the OCR and Laya smokes check about the results they get, kept apart so tests/smoke-checks.test.cjs can
// show each check fails when it should. Each throws with the reason.
const { isDeepStrictEqual } = require('node:util');

// OCR's result for a document: every page it counted, each with text and positioned words from both
// segmentation passes. `pages`, when given, is how many pages the document has.
function checkOcrResult(result, { pages } = {}) {
  if (!result.pageCount || !result.pages?.length) throw new Error('OCR returned no pages.');
  if (result.pages.length !== result.pageCount) throw new Error(`OCR counted ${result.pageCount} pages but returned ${result.pages.length}.`);
  if (pages !== undefined && result.pageCount !== pages) throw new Error(`OCR read ${result.pageCount} pages; the document has ${pages}.`);
  result.pages.forEach((page, index) => {
    if (!page.text?.length || !page.words?.length) throw new Error(`OCR must return text and positioned words (page ${index + 1}).`);
    if (!page.alternative?.words?.length) throw new Error(`Both segmentation passes must return positioned words (page ${index + 1}).`);
  });
}

// Two readings of one document, as a scale-1 display and a Retina one give them (#260): the same pages, with the
// same words in the same places from both passes, and the same suggestions.
function checkSameReading(first, second) {
  if (first.pageCount !== second.pageCount) throw new Error(`The readings have ${first.pageCount} and ${second.pageCount} pages.`);
  first.pages.forEach((page, index) => {
    const other = second.pages[index];
    if (!isDeepStrictEqual(page, other)) throw new Error(`Page ${index + 1} reads differently: ${page.words.length} and ${other.words.length} words, ` +
      `${page.alternative.words.length} and ${other.alternative.words.length} in the sparse-text pass.`);
  });
  const fields = analysis => new Map(analysis.fields.map(field => [field.id, field]));
  const a = fields(first.analysis), b = fields(second.analysis);
  const differ = [...new Set([...a.keys(), ...b.keys()])].filter(id => !isDeepStrictEqual(a.get(id), b.get(id)));
  if (differ.length) throw new Error(`The suggestions differ: ${differ.join(', ')}.`);
  if (!isDeepStrictEqual(first.analysis, second.analysis)) throw new Error('The suggestions match; the document type, tax year or warnings differ.');
}

const LAYA_KEYS = { suggestFields: ['budgetMs', 'fields', 'type', 'url'], answerFields: ['budgetMs', 'questions', 'type', 'url'] };
// Every Laya request the desktop stand-in got over a whole run: only labels, types and options, and the time
// its click has left, never a saved value. A run without both kinds of request checked nothing, and fails.
// Returns how many of each it checked.
function checkLayaRequests(calls, savedValues) {
  const requests = calls.filter(call => Object.hasOwn(LAYA_KEYS, call.type));
  requests.forEach((call, index) => {
    const keys = Object.keys(call).sort();
    if (keys.join() !== LAYA_KEYS[call.type].join()) throw new Error(`${call.type} carried more than its ${call.type === 'suggestFields' ? 'fields' : 'questions'} (request ${index + 1}): ${keys.join(', ')}.`);
    if (!Number.isInteger(call.budgetMs) || call.budgetMs < 1 || call.budgetMs > 3000) throw new Error(`${call.type} must carry the time its click has left, 1 to 3000 ms (request ${index + 1}).`);
    for (const value of savedValues) if (JSON.stringify(call).includes(value)) throw new Error(`${call.type} carried a saved value (request ${index + 1}).`);
  });
  const counts = Object.fromEntries(Object.keys(LAYA_KEYS).map(type => [type, requests.filter(call => call.type === type).length]));
  for (const [type, count] of Object.entries(counts)) if (!count) throw new Error(`The run made no ${type} request, so none was checked.`);
  return counts;
}

module.exports = { checkOcrResult, checkSameReading, checkLayaRequests };
