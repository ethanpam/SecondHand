'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const strings = require('../extension/strings.js');
const adapter = require('../extension/iowa-adapter.js');
const personal = require('./fixtures/iowa-personal-information.cjs');
const selfDetails = require('./fixtures/iowa-self-details.cjs');
const tellUsMore = require('./fixtures/iowa-tell-us-more.cjs');
const syntheticProfile = require('./fixtures/applicant-profile.json');
const { layoutElements } = require('./helpers/harness.cjs');

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
  // The question names on the date-of-birth Tell Us More page, labels reached through Object.entries.
  if (/\bselfQuestions\b/.test(code)) {
    const start = /const selfQuestions = Object\.freeze\(\{/.exec(code);
    if (!start) throw new Error('selfQuestions is no longer an Object.freeze({ ... }) literal, so its labels cannot be read.');
    const body = expressionAt(code, start.index + start[0].length - 1).slice(1, -1);
    for (const entry of body.matchAll(/(?:^|,)\s*\w+:\s*/g)) texts.add(literals(expressionAt(body, entry.index + entry[0].length))[0]?.text);
  }
  // New exact-page adapters define question labels as the fourth yn() argument
  // and job labels in a fixed LABELS object. These are application copy too.
  for (const match of /const LABELS =/.test(code) ? [] : code.matchAll(/\byn\(\s*/g)) {
    let at = match.index + match[0].length;
    for (let index = 0; index < 4; index++) {
      const argument = expressionAt(code, at);
      if (index === 3) for (const item of literals(argument)) texts.add(item.text);
      at += argument.length + 1;
    }
  }
  const recordLabels = code.match(/const LABELS = (\{[^;]+\});/);
  if (recordLabels) for (const item of literals(recordLabels[1])) texts.add(item.text);
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
    'Filled 3 answers. Check your answers, then click Continue.');
  assert.equal(strings.text('es', 'widget.needYou', { count: 1 }), 'Falta 1');
  assert.equal(strings.text('es', 'widget.needYou', { count: 2 }), 'Faltan 2');
  assert.equal(strings.text('en', 'widget.needYou', { count: 2 }), '2 questions left');
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
  assert.deepEqual(strings.describeEnglish('Type the characters shown in Iowa’s security check, then click Continue.'), { key: 'iowa.solveCaptcha', params: {} });
  assert.deepEqual(strings.describeEnglish('First name: review existing dependent answers'),
    { key: 'iowa.reviewDependent', params: { label: { key: 'iowa.firstName', params: {} } } });
  assert.deepEqual(strings.describeEnglish('Receiving end does not exist.'), { key: 'detail', params: { detail: 'Receiving end does not exist.' } });
  assert.equal(strings.text('en', 'detail', { detail: 'Receiving end does not exist.' }), 'Receiving end does not exist.');
});

test('every label, instruction, and reason the Iowa adapter and content script can show is in the catalog', () => {
  const texts = ['iowa-adapter.js', 'iowa-later-adapter.js', 'iowa-record-adapter.js', 'content.js'].flatMap(file => adapterTexts(source(file)));
  assert.ok(texts.length > 70, `found ${texts.length}`);
  const missing = texts.filter(text => text.startsWith('template:')
    ? text !== 'template:${definition.label}: review existing dependent answers'
    : strings.describeEnglish(text).key === 'detail');
  assert.deepEqual(missing, []);
  assert.equal(en['iowa.reviewDependent'], '{label}: review existing dependent answers');
});

function assertLocalizedPage(page, scan) {
  assert.ok(page);
  const publicText = [page.heading, page.todo, page.reason, ...page.checklist.map(row => row.label), ...scan.fields.map(row => row.label)].filter(Boolean);
  for (const value of publicText) {
    const message = strings.describeEnglish(value);
    assert.notEqual(message.key, 'detail', `${page.pageKey}: ${value}`);
    for (const code of strings.LANGUAGES) {
      const translated = strings.text(code, message.key, message.params);
      assert.ok(translated.trim(), `${code}: ${message.key}`);
      // These short words are spelled the same in the two languages.
      const sharedWord = (code === 'es' && message.key === 'iowa.utility.gas') || (code === 'fr' && message.key === 'iowa.asset.type');
      if (code !== 'en' && !sharedWord) assert.notEqual(translated, value, `${code}: ${message.key} must be translated`);
    }
  }
}

test('all six later scalar pages localize their headings, conditional questions, and paused or ready instructions', () => {
  const later = require('../extension/iowa-later-adapter.js');
  const fixtures = require('./fixtures/iowa-later-pages.cjs');
  for (const kind of ['emergency', 'background', 'jobs', 'income', 'expenses', 'property']) {
    const url = fixtures.url(kind), doc = onScreen(fixtures.makeHtml(kind), url);
    try {
      const initial = later.probePage(doc, url);
      assert.equal(initial.kind, 'fillable', kind);
      assertLocalizedPage(initial, later.scan(doc, url));
      if (kind === 'background') {
        doc.getElementById('answerSets0.answers8.answerValue').value = 'Spanish';
        doc.getElementById('question0566').className = 'questionAnswer';
        assertLocalizedPage(later.probePage(doc, url), later.scan(doc, url));
        doc.getElementById('answerSets0.answers8.answerValue').value = 'English';
        doc.getElementById('question0566').className = 'disabledQuestion hidden questionAnswer';
      }
      const scan = later.scan(doc, url);
      const profile = Object.fromEntries(scan.fields.map(item => [item.key, 'no']));
      if (kind === 'background') Object.assign(profile, { preferredLanguage: 'English', birthState: 'IA', race: '' });
      later.fill(doc, url, scan.bindings, later.pageValues(initial.pageKey, profile));
      const ready = later.probePage(doc, url);
      assert.equal(ready.canAdvance, true, kind);
      assertLocalizedPage(ready, later.scan(doc, url));
      const token = later.captureNavigation(doc, url);
      const advanced = later.advance(doc, url, token);
      assert.equal(advanced.advanced, true, kind);
      assert.notEqual(strings.describeEnglish(advanced.reason).key, 'detail');
      assert.notEqual(strings.describeEnglish(later.advance(doc, url, token).reason).key, 'detail');
      doc.querySelector('form').setAttribute('action', 'changed');
      assertLocalizedPage(later.probePage(doc, url), later.scan(doc, url));
    } finally { doc.defaultView.close(); }
  }
});

test('all five record pages localize owner, money, utility, and asset labels without using saved values as copy', () => {
  const records = require('../extension/iowa-record-adapter.js');
  const job = require('./fixtures/iowa-job-history.cjs');
  const financial = require('./fixtures/iowa-financial-records.cjs');
  const cases = {
    job: { person: 'Avery Example', workOrTraining: 'Work', startDate: '2026-02-03', selfEmployed: 'no', employer: 'Fictional Employer', jobTitle: 'Synthetic Clerk', monthlyHours: '120', amount: '850.50', frequency: 'Every Other Week', tipsOrCommissions: '0', incomeExpectedSame: 'yes', changedJobs30Days: 'no', stoppedWorking30Days: 'no', fewerHours30Days: 'no' },
    retirement: { person: 'Jordan Sample', type: 'Private Pension', amount: '345.67', frequency: 'Monthly' },
    rent: { person: 'Avery Example', type: 'Rent', amount: '560', frequency: 'Monthly' },
    utilities: { person: 'Jordan Sample', gas: 'yes', electricity: 'yes', waterSewage: 'no', telephone: 'yes', petFees: 'no', garageRent: 'no', landlordExtra: 'no', garbage: 'no', heatingCooling: 'yes' },
    assets: { person: 'Avery Example', type: 'Cash/Uncashed Check', currentValue: '90', amountOwed: '0', accountOrPolicy: '', institution: '', acquiredDate: '2026-01-03' }
  };
  for (const [kind, values] of Object.entries(cases)) {
    const fixture = kind === 'job' ? job : financial;
    const doc = onScreen(kind === 'job' ? fixture.makeHtml() : fixture.makeHtml(kind), fixture.URL);
    fixture.attachHandlers(doc);
    try {
      for (let pass = 0; pass < 5; pass++) {
        const scan = records.scan(doc, fixture.URL), page = records.probePage(doc, fixture.URL);
        assertLocalizedPage(page, scan);
        assert.doesNotMatch(JSON.stringify({ page, fields: scan.fields }), /Avery|Jordan|345\.67|850\.50|Fictional Employer/);
        assert.notEqual(records.fill(doc, fixture.URL, scan.bindings, values).unsafe, true);
      }
      assert.equal(records.probePage(doc, fixture.URL).canAdvance, true, kind);
    } finally { doc.defaultView.close(); }
  }
});

test('a missing record gives a translated action to save an explicit owner and restart Autofill', () => {
  assert.equal(strings.english('worker.recordMissing'), 'Add an explicitly owned matching record in SecondHand, then click Autofill again.');
  assert.deepEqual(strings.describeEnglish(strings.english('worker.recordMissing')), { key: 'worker.recordMissing', params: {} });
  for (const code of strings.LANGUAGES) {
    const value = strings.text(code, 'worker.recordMissing');
    assert.match(value, /SecondHand/);
    if (code !== 'en') assert.notEqual(value, strings.english('worker.recordMissing'));
  }
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

// A fixture page with every element given an on-screen box, as the adapter sees it in Chrome.
function onScreen(html, url) {
  return layoutElements(new JSDOM(`<!doctype html><main>${html}</main>`, { url, pretendToBeVisual: true }).window);
}
const saveButton = doc => doc.querySelector('#dqButtonId309').textContent.trim();

test('on Tell Us More, SecondHand explains that incomplete questions pause automatic Continue', () => {
  const self = onScreen(selfDetails.html, selfDetails.URL), start = onScreen(tellUsMore.html, tellUsMore.URL);
  assert.deepEqual(keyed(adapter.probePage(self, selfDetails.URL)), { pageKey: 'iowa-self-details', todo: 'iowa.selfDetailsTodo', reason: 'iowa.selfDetailsReason' });
  assert.deepEqual(keyed(adapter.probePage(start, tellUsMore.URL)), { pageKey: 'iowa-tell-us-more', todo: 'iowa.missingAnswers', reason: 'iowa.startDetailsReason' });
  // Both incomplete fixtures pause; the button named in the instructions is Iowa’s actual button.
  assert.equal(adapter.probePage(self, selfDetails.URL).canAdvance, false);
  assert.equal(adapter.probePage(start, tellUsMore.URL).canAdvance, false);
  assert.equal(saveButton(self), 'Save and Continue');
  assert.equal(saveButton(start), 'Save and Continue');
  assert.equal(en['iowa.selfDetailsReason'], 'SecondHand can fill your saved date of birth on this page. Answer the other questions yourself, then click Save and Continue in Iowa’s form.');
  assert.equal(en['iowa.startDetailsReason'], 'SecondHand continues only when the supported questions are complete and this page has no errors or unsupported questions.');
});

test('on the date-of-birth Tell Us More page, every question left to the applicant is named in the catalog', () => {
  const page = adapter.probePage(onScreen(selfDetails.html, selfDetails.URL), selfDetails.URL);
  assert.equal(page.pageKey, 'iowa-self-details');
  assert.equal(page.checklist.filter(item => item.key.startsWith('self-question')).length, 8);
  assert.deepEqual(page.checklist.filter(item => strings.describeEnglish(item.label).key === 'detail').map(item => item.label), []);
});

test('on Select Address when SecondHand selects nothing, it says so without claiming an address', () => {
  const page = probe('/applyForBenefits/addressValidation', '<h2>Select Address</h2>');
  assert.deepEqual(keyed(page), { pageKey: 'iowa-select-address', todo: 'iowa.addressManualTodo', reason: 'iowa.addressManualReason' });
  assert.equal(page.kind, 'manual'); assert.equal(page.canAdvance, false);
  // Any page that doesn't match what SecondHand expects lands here, not only one without suggestions.
  assert.equal(en['iowa.addressManualReason'], 'Check this address step in Iowa’s form yourself. This page doesn’t look the way SecondHand expects, so SecondHand leaves the address to you.');
  assert.doesNotMatch(en['iowa.addressManualReason'], /SecondHand (selects|selected|chooses|chose|picks|picked|fills|filled)\b/);
});

test('on Enter Personal Information, SecondHand says plainly what needs the applicant and that it saves and continues', () => {
  const url = `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo`;
  const doc = onScreen(personal.html, url);
  personal.attachConditionalHandlers(doc);
  for (let pass = 0; pass < 3; pass++) adapter.fill(doc, url, adapter.scan(doc, url).bindings, syntheticProfile);
  const ready = adapter.probePage(doc, url);
  assert.equal(ready.canAdvance, true);
  assert.equal(strings.describeEnglish(ready.todo).key, 'iowa.canSaveContinue');
  assert.equal(en['iowa.canSaveContinue'], 'SecondHand can save this page and continue. Review every answer before final submission.');
  // One row covers a question SecondHand doesn't know, a question it expects that is gone, and an Iowa error message.
  const row = page => page.checklist.filter(item => item.key === 'manualReview').map(item => strings.describeEnglish(item.label).key);
  const unknown = onScreen(personal.html, url);
  unknown.querySelector('form').append(Object.assign(unknown.createElement('input'), { id: 'synthetic' }));
  const missing = onScreen(personal.html, url);
  missing.querySelector('#lastName').remove();
  const error = onScreen(personal.html, url);
  error.querySelector('form').append(Object.assign(error.createElement('div'), { className: 'error', textContent: 'Synthetic error' }));
  for (const page of [unknown, missing, error]) assert.deepEqual(row(adapter.probePage(page, url)), ['iowa.manualReview']);
  assert.equal(en['iowa.manualReview'], 'Check the questions and any Iowa error messages on this page, because something here isn’t what SecondHand expects');
});

test('Iowa’s security check is named in plain words: no catalog says "CAPTCHA"', () => {
  for (const code of strings.LANGUAGES) {
    const found = Object.entries(strings.catalogs[code]).filter(([, value]) => /captcha/i.test(typeof value === 'string' ? value : `${value.one} ${value.other}`)).map(([key]) => key);
    assert.deepEqual(found, [], code);
  }
  assert.equal(en['iowa.solveCaptcha'], 'Type the characters shown in Iowa’s security check, then click Continue.');
});

test('on Enter Personal Information, when SecondHand will not save and continue, it does not say it will', () => {
  const url = `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo`;
  const filled = () => {
    const doc = onScreen(personal.html, url);
    personal.attachConditionalHandlers(doc);
    for (let pass = 0; pass < 3; pass++) adapter.fill(doc, url, adapter.scan(doc, url).bindings, syntheticProfile);
    assert.equal(adapter.probePage(doc, url).canAdvance, true, 'the filled page is ready before the change');
    return doc;
  };
  const waiting = (doc, why) => {
    const page = adapter.probePage(doc, url);
    assert.equal(page.canAdvance, false, why);
    assert.equal(strings.describeEnglish(page.todo).key, 'iowa.reviewSaveContinue', why);
  };
  // Iowa turns Save and Continue off, either way it can.
  const disabled = filled();
  disabled.querySelector('.saveAndContinueButton').setAttribute('disabled', '');
  waiting(disabled, 'disabled');
  const ariaDisabled = filled();
  ariaDisabled.querySelector('.saveAndContinueButton').setAttribute('aria-disabled', 'true');
  waiting(ariaDisabled, 'aria-disabled');
  // A field found twice: outside the form, a second element carries the id of a question this page hides
  // (Medicaid isn't chosen, so its medical bills follow-up is not shown). Nothing is missing, yet SecondHand won't continue.
  const twice = filled();
  assert.equal(twice.querySelector('#faDiv').style.display, 'none');
  twice.querySelector('main').append(Object.assign(twice.createElement('input'), { type: 'radio', id: 'helpPayMedBill1' }));
  assert.ok(adapter.scan(twice, url).ambiguous.length > 0);
  const page = adapter.probePage(twice, url);
  assert.equal(page.requiredRemaining, 0);
  assert.equal(page.manualRemaining, 0);
  waiting(twice, 'a field found twice');
  assert.equal(en['iowa.reviewSaveContinue'], 'Review your answers, then click Save and Continue in Iowa’s form.');
});

test('no Iowa English says "verified", "controls", "context", or "facts"', () => {
  const jargon = /verified|controls|context|facts/i;
  // The side panel's line about Autofill on Iowa and the Autofill button's tooltip there too (#167).
  const iowaLines = ['panel.iowaPolicy', 'widget.autofillIowaTitle'];
  const found = Object.entries(en).filter(([key, value]) => (key.startsWith('iowa.') || iowaLines.includes(key)) && jargon.test(typeof value === 'string' ? value : `${value.one} ${value.other}`))
    .map(([key]) => key);
  assert.deepEqual(found, []);
});

test('in every language, the lines on the Iowa pages SecondHand fills no longer say the page was verified', () => {
  // French "Vérifiez" means "check" and stays.
  const verified = { es: /verific/i, vi: /xác minh/i, zh: /核实/, fr: /vérifié/i, ar: /التحقق/ };
  for (const [code, pattern] of Object.entries(verified)) {
    for (const key of ['iowa.manualReview', 'iowa.addressManualReason', 'iowa.selfDetailsReason', 'iowa.startDetailsReason', 'iowa.canSaveContinue',
      'panel.iowaPolicy', 'widget.autofillIowaTitle']) {
      assert.doesNotMatch(strings.catalogs[code][key], pattern, `${code} ${key}`);
    }
  }
});

test('#189: in every language, the summary’s count of suggested answers never uses the word for Laya’s best guesses', () => {
  // Each language's word for a guess, as its "N guessed by Laya, check them" line says it.
  const guessWords = { en: /guess/i, es: /adivin|suposici/i, vi: /đoán/i, zh: /推测/, fr: /devin|suppos/i, ar: /خم/ };
  assert.deepEqual(Object.keys(guessWords), [...strings.LANGUAGES]);
  for (const [code, pattern] of Object.entries(guessWords)) {
    const catalog = strings.catalogs[code];
    for (const key of ['widget.layaGuessed', 'result.layaGuessed']) for (const text of [catalog[key].one, catalog[key].other]) assert.match(text, pattern, `${code} ${key} says guess`);
    assert.match(catalog['guesses.title'], pattern, `${code} guesses.title says guess`);
    // The fills an AI suggested (or a rule left to check), outlined in dashed amber, and the line that says Laya suggested them.
    // The counts say "1 answer" or "2 answers", so a count can be one form or two; neither says guess.
    for (const key of ['widget.filledSuggested', 'result.siteFilledSuggested', 'result.siteFilledSuggestedNeedYou', 'result.suggestedByLaya']) {
      for (const text of typeof catalog[key] === 'string' ? [catalog[key]] : [catalog[key].one, catalog[key].other]) assert.doesNotMatch(text, pattern, `${code} ${key}`);
    }
  }
  for (const key of ['widget.filledGuessed', 'result.siteFilledGuessed', 'result.siteFilledGuessedNeedYou']) assert.equal(Object.hasOwn(en, key), false, `${key} is gone`);
});

test('the side panel’s English line about Autofill on Iowa says what it fills, where it continues, and what Laya and you check (#167)', () => {
  const policy = en['panel.iowaPolicy'];
  for (const words of ['first suggested home address', 'Laya', 'Social Security number', 'to check', 'Continue']) assert.ok(policy.includes(words), words);
  assert.doesNotMatch(policy, /verified|Tell Us More/);
  // Laya's best guesses never run on Iowa (#188), and Iowa never holds sensitive details back (#187).
  assert.doesNotMatch(policy, /guess|Fill sensitive details/);
  assert.ok(policy.split(/\s+/).length <= 90, `${policy.split(/\s+/).length} words`);
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
    show({ key: 'panel.stopping' }); mark.textContent = '✓'; // show('commented out')`));
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

test('French keeps « and » on the same line as the words they quote, with a no-break space and no quote mark lost (#196)', () => {
  const found = [];
  let opening = 0, closing = 0;
  for (const [key, value] of Object.entries(strings.catalogs.fr)) {
    for (const text of typeof value === 'string' ? [value] : [value.one, value.other]) {
      opening += (text.match(/«/g) || []).length;
      closing += (text.match(/»/g) || []).length;
      if (/«(?! )|(?<! )»/.test(text)) found.push(key);
    }
  }
  assert.deepEqual(unique(found), [], 'every « is followed and every » preceded by U+00A0');
  assert.equal(opening, 73, 'French has 73 «');
  assert.equal(closing, 73, 'French has 73 »');
});

test('Remember for next time, its refusals, and the custom answers summary speak all six languages (#186)', () => {
  const keys = ['remember.title', 'remember.hint', 'remember.check', 'remember.checkLabel', 'remember.changes', 'remember.button', 'remember.saving', 'remember.saved',
    'worker.rememberEmpty', 'worker.rememberUnreadable', 'worker.rememberRepeated', 'worker.rememberCancelled', 'result.fromCustom', 'widget.fromCustom'];
  for (const code of strings.LANGUAGES) for (const key of keys) {
    assert.ok(Object.hasOwn(strings.catalogs[code], key), `${code} ${key}`);
    if (code !== 'en') assert.notDeepEqual(strings.catalogs[code][key], en[key], `${code} ${key} is translated`);
  }
  assert.equal(strings.english('result.fromCustom', { summary: { key: 'result.siteFilled', params: { count: 2 } }, count: 1 }),
    'Filled 2 answers. Check them before you submit. 1 from your custom answers.');
  assert.equal(strings.english('remember.check'), 'Remember for next time');
});

test('every language is named in its own words in every catalog and offered in the picker', () => {
  const natives = { en: 'English', es: 'Español', vi: 'Tiếng Việt', zh: '中文（简体）', fr: 'Français', ar: 'العربية' };
  for (const code of strings.LANGUAGES) for (const [name, native] of Object.entries(natives)) assert.equal(strings.catalogs[code][`language.${name}`], native, `${code} language.${name}`);
  const html = source('panel.html');
  // Each one marked as its language, for a screen reader's voice.
  for (const code of strings.LANGUAGES) assert.match(html, new RegExp(`<option value="${code}" lang="${code}" data-i18n="language\\.${code}"></option>`));
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

test('Add your household and its hints speak all six languages, and name the app’s own sections and rows in its words (#180)', () => {
  const keys = ['household.title', 'household.hintList', 'household.hintYou', 'household.hintPerson', 'household.add', 'household.open', 'household.opened', 'widget.household'];
  for (const code of strings.LANGUAGES) for (const key of keys) {
    assert.ok(Object.hasOwn(strings.catalogs[code], key), `${code} ${key}`);
    if (code !== 'en') assert.notDeepEqual(strings.catalogs[code][key], en[key], `${code} ${key} is translated`);
  }
  assert.equal(strings.english('household.add'), 'Add your household');
  // The app stays in English: every language names its row as My information does.
  for (const code of strings.LANGUAGES) assert.match(strings.text(code, 'household.hintPerson', { number: 3 }), /Person 3/, code);
});
