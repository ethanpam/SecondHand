'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const fixture = require('./fixtures/iowa-tell-us-more.cjs');
const URL = fixture.URL;
function page() {
  const doc = new JSDOM(fixture.html, { url: URL, pretendToBeVisual: true }).window.document;
  const { Element } = doc.defaultView;
  Element.prototype.getBoundingClientRect = () => ({ left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 });
  Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Element.prototype.scrollIntoView = () => {};
  for (const [key, answer] of Object.entries({ gender: 1, hasSsn: 2, usCitizen: 2, militaryOrVeteran: 2, hasDisability: 2, blind: 2, healthLimits: 2, hasMedicare: 2 })) {
    doc.getElementById(fixture.radioId(fixture.ANSWERS[key], answer)).checked = true;
  }
  doc.getElementById(fixture.DOB_ID).value = '04/12/1985';
  doc.getElementById(fixture.MARITAL_ID).value = 'Never Married';
  return doc;
}
function reveal(doc, id) { const q = doc.getElementById(id); q.className = 'questionAnswer'; q.style.display = ''; return q; }
function radio(doc, index, option) { return doc.getElementById(fixture.radioId(index, option)); }
function synchronized(doc) {
  radio(doc, 6, 1).checked = true;
  reveal(doc, 'question03'); reveal(doc, 'question04068');
  radio(doc, 11, 1).checked = true;
  const input = doc.getElementById(fixture.SSN_BOX_ID);
  input.value = '123-45-6789'; input.parentElement.querySelector('[name="ssndiv"] input').value = '123456789';
  return input;
}
const probe = doc => adapter.probePage(doc, URL);
function assertPaused(doc) { assert.equal(probe(doc).canAdvance, false); assert.equal(adapter.captureNavigation(doc, URL), null); }

test('complete captured Male/no-SSN page can Continue once; all metadata omit answer values', () => {
  const doc = page();
  assert.equal(probe(doc).canAdvance, true);
  assert.equal(probe(doc).manualRemaining, 0);
  assert.doesNotMatch(JSON.stringify(probe(doc)), /1985|Avery|Never Married|123-45/);
  let count = 0; doc.getElementById('dqButtonId309').addEventListener('click', () => count++);
  const token = adapter.captureNavigation(doc, URL);
  assert.deepEqual(token, {});
  assert.equal(adapter.advance(doc, URL, token).advanced, true);
  assert.equal(adapter.advance(doc, URL, token).advanced, false);
  assert.equal(count, 1);
});

test('citizenship Yes reveals exact bornInUs; absent, stale parent, or unfilled branch pauses', () => {
  const doc = page(); radio(doc, 18, 1).checked = true; assertPaused(doc);
  reveal(doc, 'question06181');
  assert.deepEqual(adapter.scan(doc, URL).fields.map(f => f.key), ['bornInUs']);
  assertPaused(doc);
  const bindings = adapter.scan(doc, URL).bindings;
  radio(doc, 18, 2).checked = true;
  assert.deepEqual(adapter.fill(doc, URL, bindings, { bornInUs: 'yes' }).filled, []);
  radio(doc, 18, 1).checked = true;
  assert.deepEqual(adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, { bornInUs: 'yes' }).filled, ['bornInUs']);
  assert.equal(probe(doc).canAdvance, true);
  assert.equal(adapter.scan(doc, URL).fields.length, 0, 'existing answer is preserved');
});

test('exact eating question uses its distinct stored answer only when actually enabled and visible', () => {
  const doc = page();
  assert.equal(adapter.scan(doc, URL).fields.some(f => f.key === 'eatsMealsWithHousehold'), false);
  reveal(doc, 'question02422');
  assertPaused(doc);
  assert.deepEqual(adapter.pageValues('iowa-tell-us-more', { eatsWithHousehold: 'yes' }), {});
  assert.deepEqual(adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, { eatsMealsWithHousehold: 'no' }).filled, ['eatsMealsWithHousehold']);
  assert.equal(probe(doc).canAdvance, true);
  assert.equal(radio(doc, 25, 2).checked, true);
});

test('SSN requires valid same submitted mirror and every visible card-name answer', () => {
  const doc = page(), input = synchronized(doc);
  assert.equal(probe(doc).canAdvance, true);
  const mirror = input.parentElement.querySelector('[name="ssndiv"] input');
  for (const value of ['', '***-**-6789', '123-45-6780', '000-00-0000']) { mirror.value = value; assertPaused(doc); }
  mirror.value = '123456789'; mirror.disabled = true; assertPaused(doc); mirror.disabled = false;
  radio(doc, 11, 2).checked = true;
  for (const [id, value] of [['question04070', 'Alex'], ['question04071', ''], ['question04072', 'Sample']]) reveal(doc, id).querySelector('input[type=text]').value = value;
  assert.equal(probe(doc).canAdvance, true); // exact captured optional card middle name may remain blank
  doc.getElementById('answerSets0.answers15.answerValue').value = 'Taylor';
  assert.equal(probe(doc).canAdvance, true);
});

for (const [name, mutate] of Object.entries({
  'blank radio': d => { radio(d, 27, 2).checked = false; },
  'invalid date': d => { d.getElementById(fixture.DOB_ID).value = 'tomorrow'; },
  'impossible date': d => { d.getElementById(fixture.DOB_ID).value = '02/30/1985'; },
  'future date': d => { d.getElementById(fixture.DOB_ID).value = '01/01/2999'; },
  'unknown visible answered question': d => { const q = reveal(d, 'question07981'); q.innerHTML = '<label>Unknown question<input value="yes"></label>'; },
  'unsupported custom control': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<div role="combobox" tabindex="0"></div>'),
  'bare contenteditable': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<div contenteditable></div>'),
  'plaintext editable': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<div contenteditable="plaintext-only"></div>'),
  'native invalid': d => d.getElementById(fixture.DOB_ID).setCustomValidity('Synthetic error'),
  'aria invalid': d => d.getElementById(fixture.DOB_ID).setAttribute('aria-invalid', 'true'),
  'visible custom error': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<div id="serverError">Synthetic error</div>'),
  'visible modal': d => { const m = d.getElementById('customModalBox'); m.style.display = 'block'; },
  'unsupported pregnancy branch': d => { radio(d, 1, 2).checked = true; },
  'missing question': d => d.getElementById('question0565').remove(),
  'changed Next handler': d => d.getElementById('dqButtonId309').setAttribute('onclick', 'submitApplication()'),
  'duplicate Next': d => d.querySelector('form').append(d.getElementById('dqButtonId309').cloneNode(true)),
  'wrong person phase': d => d.querySelector('a[title="People | Unvisited"]').setAttribute('title', 'People | Active'),
  'visible certification': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<fieldset><legend>I certify these answers</legend></fieldset>')
})) test(`Continue pauses for ${name}`, () => { const doc = page(); mutate(doc); assertPaused(doc); });

for (const [name, mutate] of Object.entries({
  answer: d => { radio(d, 27, 1).checked = true; },
  person: d => { d.querySelector('.peTaxInfoName h3').textContent = 'Different synthetic person'; },
  intro: d => { d.querySelector('div.fullrow.floatLeft > p').append(' Changed instructions'); },
  options: d => { d.getElementById(fixture.MARITAL_ID).options[1].textContent = 'Changed'; },
  'hidden recipient': d => { d.querySelector('[name="answerSets[0].personSelection"]').value = 'other-recipient'; },
  'new hidden field': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<input type="hidden" name="otherPerson" value="synthetic">'),
  mirror: d => { synchronized(d).parentElement.querySelector('[name="ssndiv"] input').value = '123456780'; }
})) test(`pending Next snapshot rejects changed ${name}`, () => {
  const doc = page(); if (name === 'mirror') synchronized(doc);
  const token = adapter.captureNavigation(doc, URL); assert.ok(token);
  let clicked = 0; doc.getElementById('dqButtonId309').addEventListener('click', () => clicked++);
  mutate(doc); assert.equal(adapter.advance(doc, URL, token).advanced, false); assert.equal(clicked, 0);
});
