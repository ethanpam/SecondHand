'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const strings = require('../extension/strings.js');
const adapter = require('../extension/iowa-adapter.js');

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
  assert.throws(() => strings.text('de', 'widget.autofill'), /de/);
  assert.throws(() => strings.text('en', 'widget.needYou', {}), /count/);
});

test('the language is the saved choice, otherwise the browser language, and a choice is saved in extension storage', () => {
  const storage = () => { const items = new Map(); return { getItem: key => items.has(key) ? items.get(key) : null, setItem: (key, value) => items.set(key, String(value)), items }; };
  const spanish = { localStorage: storage(), navigator: { language: 'es-MX' } };
  assert.equal(strings.language(spanish), 'es');
  assert.equal(strings.language({ localStorage: storage(), navigator: { language: 'en-US' } }), 'en');
  assert.equal(strings.language({ localStorage: storage(), navigator: { language: 'de-DE' } }), 'en', 'languages without a catalog use English');
  strings.setLanguage('en', spanish);
  assert.equal(strings.STORAGE_KEY, 'secondhand.language');
  assert.equal(spanish.localStorage.items.get('secondhand.language'), 'en');
  assert.equal(strings.language(spanish), 'en', 'the saved choice wins over the browser');
  assert.throws(() => strings.setLanguage('de', spanish), /de/);
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

// An Iowa portal page as the adapter sees it, with every element on screen.
function portalPage(path, html) {
  const doc = new JSDOM(`<!doctype html><main>${html}</main>`, { url: `${adapter.PORTAL}${path}`, pretendToBeVisual: true }).window.document;
  doc.defaultView.Element.prototype.getClientRects = () => [{ left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 }];
  return doc;
}
const probe = (path, html) => adapter.probePage(portalPage(path, html), `${adapter.PORTAL}${path}`);
const keyed = page => ({ pageKey: page.pageKey, todo: page.todo && strings.describeEnglish(page.todo).key, reason: strings.describeEnglish(page.reason).key });

test('on the Iowa questions pages SecondHand does not fill, it says so plainly and tells the applicant to answer and go on', () => {
  // Job Information, Expenses, and every summary share this address with Tell Us More.
  for (const heading of ['Job Information', 'Housing Expenses', 'Expenses Summary', 'Tell Us More']) {
    assert.deepEqual(keyed(probe('/applyForBenefits/dynamicQuestions', `<h1>${heading}</h1>`)),
      { pageKey: 'iowa-self-details-unverified', todo: 'iowa.selfUnverifiedTodo', reason: 'iowa.selfUnverifiedReason' }, heading);
  }
  assert.equal(en['iowa.selfUnverifiedReason'], 'SecondHand doesn’t fill this page. Answer any questions yourself, then go to the next page in Iowa’s form.');
  assert.equal(en['iowa.selfUnverifiedTodo'], 'Answer any questions on this page yourself, then go to the next page in Iowa’s form.');
});

test('on an Iowa page it does not know, SecondHand says so without promising it fills nothing there', () => {
  assert.deepEqual(keyed(probe('/applyForBenefits/personRelationshipRender', '<h1>Household Relationships</h1>')),
    { pageKey: 'iowa-manual', todo: undefined, reason: 'iowa.manualStep' });
  // No instruction here, so the general engine may still fill: the reason must leave room for that.
  assert.equal(en['iowa.manualStep'], 'SecondHand doesn’t know this Iowa page. Check it and fill in anything missing yourself, then continue in Iowa’s form.');
  assert.doesNotMatch(en['iowa.manualStep'], /doesn’t fill|fills nothing|won’t fill/);
});

test('on an applicant page that does not look as expected, SecondHand says plainly that it fills nothing', () => {
  assert.deepEqual(keyed(probe('/applyForBenefits/enterPersonalInfo', '<h1>Enter Personal Information</h1>')),
    { pageKey: 'iowa-personal-unverified', todo: 'iowa.personalUnverifiedTodo', reason: 'iowa.personalUnverifiedReason' });
  assert.equal(en['iowa.personalUnverifiedReason'], 'This page doesn’t look like the applicant page SecondHand knows, so it fills nothing here.');
  assert.equal(en['iowa.personalUnverifiedTodo'], 'Fill in this page yourself, then click Save and Continue in Iowa’s form.');
});

test('no Iowa English says "verified", "controls", "context", or "facts"', () => {
  // Wording on pages SecondHand does fill, left for its own issue. Fixing one means taking it off this list.
  const later = ['iowa.addressManualReason', 'iowa.canSaveContinue', 'iowa.manualReview', 'iowa.selfDetailsReason', 'iowa.startDetailsReason'];
  const jargon = /verified|controls|context|facts/i;
  const found = Object.entries(en).filter(([key, value]) => key.startsWith('iowa.') && jargon.test(typeof value === 'string' ? value : `${value.one} ${value.other}`))
    .map(([key]) => key);
  assert.deepEqual(found.filter(key => !later.includes(key)), []);
  assert.deepEqual(later.filter(key => !found.includes(key)), [], 'a key that no longer has the words comes off the list');
  for (const key of ['iowa.manualStep', 'iowa.selfUnverifiedTodo', 'iowa.selfUnverifiedReason', 'iowa.personalUnverifiedTodo', 'iowa.personalUnverifiedReason']) {
    assert.doesNotMatch(en[key], jargon, key);
  }
});

test('the worker says nothing in English of its own: every message it builds comes from a catalog key', () => {
  const code = withoutComments(source('background.js'));
  // Chrome's and the native hosts' own error wording, compared but never shown, and the worker's start-up failure.
  const allowed = ['Could not establish connection. Receiving end does not exist.', 'Receiving end does not exist.', 'SecondHand could not load generic-adapter.js. Reinstall the extension.',
    'SecondHand could not load strings.js. Reinstall the extension.', 'Open SecondHand, connect this extension, and unlock SecondHand.',
    'Open SecondHand, connect this extension, and unlock your local vault.'];
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
  for (const attribute of ['title', 'aria-label', 'placeholder']) assert.equal(document.querySelectorAll(`[${attribute}]`).length, 0, attribute);
  // Decorative images (the logo) carry an empty alt, which is no text; any other alt would be untranslated English.
  assert.deepEqual([...document.querySelectorAll('img')].map(image => image.getAttribute('alt')).filter(alt => alt !== ''), [], 'alt');
  const used = [...document.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-aria-label]')]
    .flatMap(element => [element.dataset.i18n, element.dataset.i18nTitle, element.dataset.i18nAriaLabel].filter(Boolean));
  assert.ok(used.length > 15);
  assert.deepEqual(used.filter(key => !isKey(key)), []);
  assert.ok(document.querySelector('title[data-i18n]'));
});

test('SecondHand speaks Spanish, Vietnamese, Chinese, French, and Arabic, each with every English message', () => {
  assert.deepEqual([...strings.LANGUAGES], ['en', 'es', 'vi', 'zh', 'fr', 'ar']);
  for (const code of strings.LANGUAGES) {
    const catalog = strings.catalogs[code];
    assert.ok(catalog, code);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort(), `${code} has exactly the English keys`);
    for (const [key, value] of Object.entries(en)) {
      assert.equal(typeof catalog[key], typeof value, `${code} ${key}`);
      assert.deepEqual(placeholders(catalog[key]), placeholders(value), `${code} ${key} keeps its placeholders`);
      if (typeof value === 'object') assert.deepEqual(Object.keys(catalog[key]).sort(), ['one', 'other'], `${code} ${key}`);
      if (code !== 'en' && typeof value === 'string' && key.startsWith('widget.') && !/^\{/.test(value)) {
        assert.ok(catalog[key].trim(), `${code} ${key} is not empty`);
      }
    }
  }
});

test('no catalog text uses an em dash', () => {
  const found = [];
  for (const code of strings.LANGUAGES) {
    for (const [key, value] of Object.entries(strings.catalogs[code])) {
      if ((typeof value === 'string' ? [value] : [value.one, value.other]).some(text => text.includes('—'))) found.push(`${code} ${key}`);
    }
  }
  assert.deepEqual(found, []);
});

test('every language is named in its own words in every catalog and offered in the picker', () => {
  const natives = { en: 'English', es: 'Español', vi: 'Tiếng Việt', zh: '中文（简体）', fr: 'Français', ar: 'العربية' };
  for (const code of strings.LANGUAGES) for (const [name, native] of Object.entries(natives)) assert.equal(strings.catalogs[code][`language.${name}`], native, `${code} language.${name}`);
  const html = source('panel.html');
  for (const code of strings.LANGUAGES) assert.match(html, new RegExp(`<option value="${code}" data-i18n="language\\.${code}"></option>`));
});

test('Arabic reads right to left; the others left to right', () => {
  assert.equal(strings.direction('ar'), 'rtl');
  for (const code of ['en', 'es', 'vi', 'zh', 'fr']) assert.equal(strings.direction(code), 'ltr');
  assert.throws(() => strings.direction('xx'), /no text in xx/);
  assert.match(source('panel.js'), /documentElement\.dir = strings\.direction\(language\)/);
  assert.doesNotMatch(source('panel.css'), /text-align:left|margin-left:auto/, 'the panel lays out by reading direction, not by left and right');
});

test('regional browser languages pick their catalog; Traditional Chinese stays English until it has its own', () => {
  const scope = browser => ({ localStorage: { getItem: () => null }, navigator: { language: browser } });
  for (const [browser, expected] of [['vi-VN', 'vi'], ['zh-CN', 'zh'], ['zh-Hans-CN', 'zh'], ['zh', 'zh'], ['fr-CA', 'fr'], ['ar-EG', 'ar'], ['es-MX', 'es'],
    ['zh-TW', 'en'], ['zh-HK', 'en'], ['zh-Hant', 'en'], ['de-DE', 'en']]) {
    assert.equal(strings.language(scope(browser)), expected, browser);
  }
});
