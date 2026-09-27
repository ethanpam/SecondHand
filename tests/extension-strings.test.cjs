'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const strings = require('../extension/strings.js');

const source = file => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
const { en, es } = strings.catalogs;
const placeholders = value => (typeof value === 'string' ? [value] : [value.one, value.other])
  .flatMap(text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1])).sort();
const unique = values => [...new Set(values)];

// A small reader for this repository's plain scripts: comments are dropped, and an expression
// runs to the first comma, semicolon, or closing bracket at its own depth.
function withoutComments(code) {
  let out = '', quote = null;
  for (let index = 0; index < code.length; index++) {
    const char = code[index], next = code[index + 1];
    if (quote) { out += char; if (char === '\\') { out += next; index++; } else if (char === quote) quote = null; continue; }
    if (char === '/' && next === '/') { while (index < code.length && code[index] !== '\n') index++; out += '\n'; continue; }
    if (char === '/' && next === '*') { index = code.indexOf('*/', index + 2) + 1; continue; }
    if (char === '/' && /[=(,:!&|?{};[]\s*$/.test(out)) { quote = '/'; out += char; continue; }
    if (char === '\'' || char === '"' || char === '`') quote = char;
    out += char;
  }
  return out;
}
function expressionAt(code, from) {
  let depth = 0, index = from, quote = null;
  for (; index < code.length; index++) {
    const char = code[index];
    if (quote) { if (char === '\\') index++; else if (char === quote) quote = null; continue; }
    if (char === '\'' || char === '"' || char === '`') { quote = char; continue; }
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) { if (depth === 0) break; depth--; }
    else if ((char === ',' || char === ';') && depth === 0) break;
  }
  return code.slice(from, index);
}
function literals(expression) {
  const pattern = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  return [...expression.matchAll(pattern)].map(match => ({ text: (match[1] ?? match[2] ?? match[3]).replace(/\\(.)/g, '$1'), template: match[3] !== undefined }));
}
// Every text the Iowa adapter (or a content script) hands the worker as a label, instruction, or reason.
function adapterTexts(raw) {
  const code = withoutComments(raw);
  const texts = new Set();
  for (const match of code.matchAll(/\b(?:label|todo|reason):\s*|\.(?:label|todo|reason)\s*=(?!=)\s*/g)) {
    for (const item of literals(expressionAt(code, match.index + match[0].length))) texts.add(item.template ? `template:${item.text}` : item.text);
  }
  for (const match of code.matchAll(/\b(?:radio|fail)\(\s*/g)) texts.add(literals(expressionAt(code, match.index + match[0].length))[0]?.text);
  const known = code.match(/const known = \[([\s\S]*?)\]\.find/);
  if (known) for (const row of known[1].matchAll(/\[([^\]]*)\]/g)) texts.add(literals(row[1])[3].text);
  return [...texts].filter(text => text && /^[A-Z]|^template:/.test(text));
}
// Literals that reach the screen through show(...), .textContent =, .title =, or an aria-label.
function shownLiterals(raw) {
  const code = withoutComments(raw);
  const found = [];
  for (const match of code.matchAll(/\bshow\(\s*|\.(?:textContent|title)\s*=(?!=)\s*|setAttribute\(\s*'aria-label'\s*,\s*/g)) {
    const expression = expressionAt(code, match.index + match[0].length);
    for (const item of literals(expression)) found.push({ at: match[0].trim(), expression, text: item.template ? item.text.replace(/\$\{[^}]*\}/g, '') : item.text });
  }
  return found;
}
const isKey = text => Object.hasOwn(en, text);
const english = found => found.filter(item => /[A-Za-z]/.test(item.text) && !isKey(item.text));

test('every English string has a Spanish entry with the same placeholders and plural forms', () => {
  assert.ok(Object.keys(en).length > 150);
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.equal(typeof es[key], typeof en[key], key);
    if (typeof en[key] === 'object') {
      assert.deepEqual(Object.keys(en[key]).sort(), ['one', 'other'], key);
      assert.deepEqual(Object.keys(es[key]).sort(), ['one', 'other'], key);
    }
    assert.deepEqual(placeholders(es[key]), placeholders(en[key]), key);
    assert.ok((typeof es[key] === 'string' ? es[key] : es[key].other).trim(), key);
  }
});

test('each English sentence has one key, so fixed English text maps back to exactly one entry', () => {
  const values = Object.values(en).filter(value => typeof value === 'string');
  assert.deepEqual(values.filter((value, index) => values.indexOf(value) !== index), []);
});

test('text fills parameters, nests messages, picks plural forms, and refuses a missing key or parameter', () => {
  assert.equal(strings.text('en', 'worker.stoppedAfterSteps', { steps: 15 }), 'Stopped after 15 steps. Check this page, then click Autofill to keep going.');
  assert.equal(strings.text('en', 'result.thenTodo', { summary: { key: 'result.filled', params: { count: 3 } }, todo: { key: 'worker.checkThenContinue' } }),
    'Filled 3. Check your answers, then click Continue.');
  assert.equal(strings.text('es', 'widget.needYou', { count: 1 }), 'Falta 1');
  assert.equal(strings.text('es', 'widget.needYou', { count: 2 }), 'Faltan 2');
  assert.equal(strings.text('en', 'widget.needYou', { count: 2 }), '2 need you');
  assert.throws(() => strings.text('es', 'no.such.key'), /no\.such\.key/);
  assert.throws(() => strings.text('en', 'worker.stoppedAfterSteps', {}), /steps/);
  assert.throws(() => strings.text('fr', 'widget.autofill'), /fr/);
  assert.throws(() => strings.text('en', 'widget.needYou', {}), /count/);
});

test('the language is the saved choice, otherwise the browser language, and a choice is saved in extension storage', () => {
  const storage = () => { const items = new Map(); return { getItem: key => items.has(key) ? items.get(key) : null, setItem: (key, value) => items.set(key, String(value)), items }; };
  const spanish = { localStorage: storage(), navigator: { language: 'es-MX' } };
  assert.equal(strings.language(spanish), 'es');
  assert.equal(strings.language({ localStorage: storage(), navigator: { language: 'en-US' } }), 'en');
  assert.equal(strings.language({ localStorage: storage(), navigator: { language: 'fr-FR' } }), 'en', 'languages without a catalog use English');
  strings.setLanguage('en', spanish);
  assert.equal(strings.STORAGE_KEY, 'secondhand.language');
  assert.equal(spanish.localStorage.items.get('secondhand.language'), 'en');
  assert.equal(strings.language(spanish), 'en', 'the saved choice wins over the browser');
  assert.throws(() => strings.setLanguage('fr', spanish), /fr/);
  spanish.localStorage.setItem('secondhand.language', 'klingon');
  assert.throws(() => strings.language(spanish), /klingon/, 'a setting SecondHand never writes is an error, not a silent default');
});

test('fixed English from the Iowa adapter maps to its key; anything else is passed through as a detail', () => {
  assert.deepEqual(strings.describeEnglish('Solve the CAPTCHA, then click Continue.'), { key: 'iowa.solveCaptcha', params: {} });
  assert.deepEqual(strings.describeEnglish('First name: review existing dependent answers'),
    { key: 'iowa.reviewDependent', params: { label: { key: 'iowa.firstName', params: {} } } });
  assert.deepEqual(strings.describeEnglish('Receiving end does not exist.'), { key: 'detail', params: { detail: 'Receiving end does not exist.' } });
  assert.equal(strings.text('en', 'detail', { detail: 'Receiving end does not exist.' }), 'Receiving end does not exist.');
});

test('every label, instruction, and reason the Iowa adapter and content script can show is in the catalog', () => {
  const texts = [...adapterTexts(source('iowa-adapter.js')), ...adapterTexts(source('content.js'))];
  assert.ok(texts.length > 70, `found ${texts.length}`);
  const missing = texts.filter(text => text.startsWith('template:')
    ? text !== 'template:${definition.label}: review existing dependent answers'
    : strings.describeEnglish(text).key === 'detail');
  assert.deepEqual(missing, []);
  assert.equal(en['iowa.reviewDependent'], '{label}: review existing dependent answers');
});

test('the worker says nothing in English of its own: every message it builds comes from a catalog key', () => {
  const code = withoutComments(source('background.js'));
  // Chrome's own error wording, compared but never shown, and the worker's start-up failure.
  const allowed = ['Could not establish connection. Receiving end does not exist.', 'Receiving end does not exist.', 'SecondHand could not load generic-adapter.js. Reinstall the extension.',
    'SecondHand could not load strings.js. Reinstall the extension.'];
  const prose = unique(literals(code).map(item => item.text).filter(text => /^[A-Z][a-z’']+\s/.test(text) && !allowed.includes(text)));
  assert.deepEqual(prose, []);
  const keys = [...code.matchAll(/\b(?:say|fault|english)\(\s*'([^']+)'/g)].map(match => match[1]);
  assert.ok(keys.length > 40, `found ${keys.length}`);
  assert.deepEqual(keys.filter(key => !isKey(key)), []);
});

test('the side panel and widget pass only catalog keys to the screen', () => {
  const code = source('panel.js');
  const found = shownLiterals(code);
  assert.ok(found.length > 20, `found ${found.length}`);
  assert.deepEqual(english(found), []);
  const keys = [...withoutComments(code).matchAll(/\b(?:t|key:)\(?\s*'([^']+)'/g)].map(match => match[1]);
  assert.ok(keys.length > 40, `found ${keys.length}`);
  assert.deepEqual(keys.filter(key => !isKey(key)), []);
});

test('the completeness check itself catches English passed to the screen', () => {
  const found = english(shownLiterals(`
    show('That field isn’t on screen right now.');
    $('status').textContent = ready ? 'Ready' : \`\${count} need you\`;
    button.title = 'Open details';
    row.setAttribute('aria-label', \`\${label}: Done\`);
    show({ key: 'panel.filling' }); mark.textContent = '✓'; // show('commented out')`));
  assert.deepEqual(found.map(item => item.text), ['That field isn’t on screen right now.', 'Ready', ' need you', 'Open details', ': Done']);
});

test('panel.html has no text of its own: every visible word, title, and label comes from the catalog', () => {
  const { document } = new JSDOM(source('panel.html')).window;
  const walker = document.createTreeWalker(document.documentElement, 4);
  const stray = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || node.parentElement.closest('[aria-hidden="true"]')) continue;
    stray.push(node.textContent.trim());
  }
  assert.deepEqual(stray, []);
  for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) assert.equal(document.querySelectorAll(`[${attribute}]`).length, 0, attribute);
  const used = [...document.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-aria-label]')]
    .flatMap(element => [element.dataset.i18n, element.dataset.i18nTitle, element.dataset.i18nAriaLabel].filter(Boolean));
  assert.ok(used.length > 15);
  assert.deepEqual(used.filter(key => !isKey(key)), []);
  assert.ok(document.querySelector('title[data-i18n]'));
});
