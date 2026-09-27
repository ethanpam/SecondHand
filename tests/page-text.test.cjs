'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const reader = require('../extension/page-text.js');
const adapter = require('../extension/iowa-adapter.js');
const preApplicant = require('./fixtures/iowa-pre-applicant.cjs');
const pantry = require('./fixtures/pantry-forms.cjs');

// jsdom lays nothing out, so every element gets a box; a test shrinks one to show it collapsed.
function page(html, url = 'https://pantry.example.org/sign-up') {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body>${html}</body></html>`, { url, pretendToBeVisual: true });
  const { document } = dom.window;
  const box = { left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 };
  for (const node of document.querySelectorAll('*')) { node.getBoundingClientRect = () => box; node.getClientRects = () => [box]; }
  return document;
}
const iowaScreen = name => page(preApplicant.screens[name].html, `${adapter.PORTAL}${preApplicant.screens[name].path}`);
const INSTRUCTIONS = ['Food pantry sign-up', 'Before you visit',
  'Bring a photo ID for the adult picking up food. On your first visit, also bring a utility bill or lease that shows your address.',
  'Anyone who lives in Polk or Story County can visit once a month. Emergency boxes have no income limit.',
  'Pickup is on Tuesdays and Fridays from 3 to 6 p.m.', 'Bring your own bags if you can.', 'If you can’t come, a neighbor can pick up for you with a signed note.'];
const QUESTIONS = ['Full name *', 'ZIP code', 'How many people live in your household?', 'Preferred pickup day', 'County', 'Anything we should know?'];

test('Iowa’s Important Information and Instructions screens read as their own words, without Iowa’s buttons or controls', () => {
  assert.equal(reader.read(iowaScreen('importantInfo')), 'Important Information when applying and what to expect.\nWhat you need to do.');
  assert.equal(reader.read(iowaScreen('instructions')), ['Instructions', 'You\'ll see some questions with a star next to them.', 'Check this box next to the item you want to select.',
    'Check this button next to the item you want to select.', 'OK. Let\'s start the application.'].join('\n'));
});

test('a pantry form with long instructions reads as its instructions and question labels, one block per line', () => {
  assert.equal(reader.read(page(pantry.pantryInstructions)), [...INSTRUCTIONS, ...QUESTIONS].join('\n'));
});

test('typed and chosen answers, choices, SecondHand’s widget, scripts, styles, and site navigation are never page text', () => {
  const doc = page(pantry.pantryInstructions);
  doc.getElementById('p-name').value = 'Synthetic Private Name';
  doc.getElementById('p-zip').setAttribute('value', '50309');
  doc.getElementById('p-notes').value = 'Synthetic private note';
  doc.getElementById('p-notes').textContent = 'Synthetic default note';
  doc.getElementById('p-county').value = 'Story';
  doc.querySelector('input[value="fri"]').checked = true;
  // SecondHand's widget host, as a content script adds it, and a Google Forms style choice list.
  doc.querySelector('main').insertAdjacentHTML('beforeend', '<div data-secondhand-assistant="">SecondHand widget words</div>' +
    '<div role="radiogroup"><label><div role="radio" aria-checked="true"></div><span>Synthetic chosen option</span></label></div>' +
    '<div role="listbox"><div role="option" aria-selected="true">Synthetic listbox answer</div></div><div contenteditable="true">Synthetic typed words</div>');
  for (const node of doc.querySelectorAll('*')) { const box = { left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 }; node.getBoundingClientRect = () => box; node.getClientRects = () => [box]; }
  const text = reader.read(doc);
  assert.equal(text, [...INSTRUCTIONS, ...QUESTIONS].join('\n'));
  for (const left of ['Synthetic', '50309', 'Choose one', 'Sign up', 'SecondHand widget', 'pantryReady', 'color: green', 'Home', 'Donate', 'Privacy', 'Riverbend', 'hidden text', 'Hidden promotion']) {
    assert.equal(text.includes(left), false, left);
  }
  assert.deepEqual(text.split('\n').filter(line => ['Tuesday', 'Friday', 'Polk', 'Story'].includes(line)), [], 'the choices are part of their questions');
});

test('hidden, collapsed, and screen-reader-hidden text is left out; without a main region the whole body is read', () => {
  const doc = page('<h1>Pickup rules</h1><p aria-hidden="true">Decorative duplicate</p><p style="visibility:hidden">Invisible rule</p>' +
    '<div style="opacity:0"><p>Faded rule</p></div><details><summary>More</summary><p id="folded">Folded rule</p></details><p id="collapsed">Collapsed rule</p><p>Bring a bag.</p>' +
    '<footer>Site footer</footer><article><footer>Article footer note</footer></article>');
  const flat = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  doc.getElementById('collapsed').getBoundingClientRect = () => flat;
  doc.getElementById('collapsed').getClientRects = () => [];
  doc.getElementById('folded').getClientRects = () => [];
  assert.equal(reader.read(doc), 'Pickup rules\nMore\nBring a bag.\nArticle footer note', 'a footer inside an article is part of it; the site footer is not');
});

test('a long page is cut to the most one page sends: whole paragraphs, then the sentences of the next that fit', () => {
  const paragraph = index => `Rule ${index}. ${'Bring the listed documents to the pantry desk. '.repeat(12).trim()}`;
  const doc = page(`<main>${Array.from({ length: 60 }, (_, index) => `<p>${paragraph(index)}</p>`).join('')}</main>`);
  const text = reader.read(doc);
  assert.ok(text.length <= reader.MAX_CHARS && text.length > reader.MAX_CHARS - 60, `${text.length}`);
  const lines = text.split('\n');
  assert.ok(lines.slice(0, -1).every((line, index) => line === paragraph(index)), 'whole paragraphs, in order');
  assert.ok(paragraph(lines.length - 1).startsWith(lines.at(-1)) && lines.at(-1).endsWith('.'), 'the last one ends at a sentence');
  assert.equal(reader.cap(['Short line.', 'First sentence here. Second sentence runs long.'], 35), 'Short line.\nFirst sentence here.');
  assert.equal(reader.cap(['Averyveryverylongwordwithnobreaks'], 10), 'Averyveryv');
  assert.equal(reader.cap([], 10), '');
});
