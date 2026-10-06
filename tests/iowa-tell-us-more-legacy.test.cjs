'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const fixture = require('./fixtures/iowa-tell-us-more-legacy-live.cjs');
const partial = require('./fixtures/iowa-self-details.cjs');
const START = require('./fixtures/iowa-tell-us-more.cjs');
function page(html = fixture.html, url = fixture.URL) {
  const doc = new JSDOM(html, { url, pretendToBeVisual: true }).window.document;
  const { Element } = doc.defaultView;
  Element.prototype.getBoundingClientRect = () => ({ left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 });
  Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Element.prototype.scrollIntoView = () => {};
  if (html === fixture.html) fixture.attachHandlers(doc);
  return doc;
}
const saved = { sex: 'Male', birthDate: '1985-04-12', hasSsn: 'no', usCitizen: 'yes', bornInUs: 'yes', maritalStatus: 'Never Married',
  militaryOrVeteran: 'no', eatsMealsWithHousehold: 'yes', disabled: 'no', blind: 'no' };
const scan = doc => adapter.scan(doc, fixture.URL);
const probe = doc => adapter.probePage(doc, fixture.URL);
const radio = (doc, key, option) => doc.getElementById(fixture.radioId(fixture.ANSWERS[key], option));
function fill(doc, profile = saved) {
  const values = adapter.pageValues('iowa-tell-us-more', profile), filled = [];
  for (let i = 0; i < 4; i++) filled.push(...adapter.fill(doc, fixture.URL, scan(doc).bindings, values).filled);
  return filled;
}
function next(doc) { return adapter.advance(doc, fixture.URL, adapter.captureNavigation(doc, fixture.URL)); }

test('freshly observed full legacy baseline fills exact nine questions plus born follow-up and continues once', () => {
  const doc = page();
  assert.equal(probe(doc).pageKey, 'iowa-tell-us-more');
  assert.deepEqual(scan(doc).fields.map(f => f.key), ['gender', 'birthDate', 'hasSsn', 'usCitizen', 'maritalStatus', 'militaryOrVeteran', 'eatsMealsWithHousehold', 'hasDisability', 'blind']);
  assert.deepEqual(fill(doc), ['gender', 'birthDate', 'hasSsn', 'usCitizen', 'maritalStatus', 'militaryOrVeteran', 'eatsMealsWithHousehold', 'hasDisability', 'blind', 'bornInUs']);
  assert.equal(doc.getElementById(fixture.DOB_ID).value, '04/12/1985');
  assert.equal(radio(doc, 'bornInUs', 1).checked, true);
  assert.equal(probe(doc).canAdvance, true);
  assert.equal(next(doc).advanced, true); assert.equal(doc.__tellQa.nextClicks, 1);
  assert.doesNotMatch(JSON.stringify(probe(doc)), /1985|Avery|Example|Never Married|answerSets/);
});

test('captured legacy Female -> pregnancy No fills only the explicit saved answer and can continue', () => {
  const doc = page();
  assert.ok(fill(doc, { ...saved, sex: 'Female', pregnant: 'no' }).includes('pregnant'));
  assert.equal(radio(doc, 'pregnant', 2).checked, true);
  assert.equal(probe(doc).canAdvance, true);
  assert.equal(doc.getElementById(fixture.DUE_ID).value, '');
  assert.equal(next(doc).advanced, true);
});

test('captured pregnancy Yes requires both explicit due date and expected count before Continue', () => {
  const doc = page();
  fill(doc, { ...saved, sex: 'Female', pregnant: 'yes' });
  assert.equal(probe(doc).canAdvance, false);
  assert.deepEqual(scan(doc).fields.map(f => f.key), ['pregnancyDueDate', 'pregnancyExpectedBabies']);
  assert.deepEqual(adapter.fill(doc, fixture.URL, scan(doc).bindings, { pregnancyDueDate: '2027-02-14', pregnancyExpectedBabies: '2' }).filled,
    ['pregnancyDueDate', 'pregnancyExpectedBabies']);
  assert.equal(doc.getElementById(fixture.DUE_ID).value, '02/14/2027');
  assert.equal(doc.getElementById(fixture.EXPECTED_BABIES_ID).value, '2');
  assert.equal(probe(doc).canAdvance, true); assert.equal(next(doc).advanced, true);
});

test('missing pregnancy, due date, or baby count is never guessed from other fields', () => {
  const doc = page(); fill(doc, { ...saved, sex: 'Female', householdPregnant: 'no' });
  assert.equal(probe(doc).canAdvance, false); assert.equal(radio(doc, 'pregnant', 1).checked, false); assert.equal(radio(doc, 'pregnant', 2).checked, false);
  fill(doc, { ...saved, sex: 'Female', pregnant: 'yes', pregnancyDueDate: '2027-02-30', pregnancyExpectedBabies: '0' });
  assert.equal(doc.getElementById(fixture.DUE_ID).value, ''); assert.equal(doc.getElementById(fixture.EXPECTED_BABIES_ID).value, '');
  assert.equal(probe(doc).canAdvance, false);
  for (const count of ['0', '-1', '1.5', '21', '200', 'many']) assert.equal(adapter.formatValue('pregnancyExpectedBabies', count, doc.getElementById(fixture.EXPECTED_BABIES_ID)), null);
});

test('pregnancy followups require fresh parent context and preserve existing values', () => {
  const doc = page(); fill(doc, { ...saved, sex: 'Female', pregnant: 'yes' });
  const bindings = scan(doc).bindings;
  radio(doc, 'pregnant', 2).click();
  assert.deepEqual(adapter.fill(doc, fixture.URL, bindings, { pregnancyDueDate: '2027-02-14', pregnancyExpectedBabies: '2' }).filled, []);
  radio(doc, 'pregnant', 1).click();
  doc.getElementById(fixture.EXPECTED_BABIES_ID).value = '1';
  fill(doc, { ...saved, sex: 'Female', pregnant: 'yes', pregnancyDueDate: '2027-02-14', pregnancyExpectedBabies: '2' });
  assert.equal(doc.getElementById(fixture.EXPECTED_BABIES_ID).value, '1');
  const snapshot = adapter.captureNavigation(doc, fixture.URL); assert.ok(snapshot);
  doc.getElementById(fixture.EXPECTED_BABIES_ID).value = '3';
  assert.equal(adapter.advance(doc, fixture.URL, snapshot).advanced, false);
});

test('legacy card mismatch uses applicant card names and requires synchronized SSN before continuing', () => {
  const doc = page(); fill(doc, { ...saved, hasSsn: 'yes', ssn: '123456789', ssnCardNameMatches: 'no', ssnCardFirstName: 'Alex', ssnCardLastName: 'Sample' });
  assert.equal(doc.getElementById('answerSets0.answers12.answerValue').value, 'Alex');
  assert.equal(doc.getElementById('answerSets0.answers16.answerValue').value, 'Sample');
  assert.equal(doc.getElementById('answerSets0.answers15.answerValue').value, '');
  assert.equal(probe(doc).canAdvance, false);
  doc.getElementById(fixture.SSN_BOX_ID).parentElement.querySelector('[name="ssndiv"] input').value = '123456789';
  assert.equal(probe(doc).canAdvance, true);
});

for (const [name, mutate] of Object.entries({
  'unknown visible question': d => { const q = d.getElementById('question07981'); q.className = 'questionAnswer'; q.style.display = ''; },
  'wrong active phase': d => d.querySelector('[title="People | Unvisited"]').setAttribute('title', 'People | Active'),
  'mixed Start gender template': d => { const q = d.getElementById('question02418'); q.className = 'questionAnswer'; q.style.display = ''; },
  'wrong legacy citizen handler': d => radio(d, 'usCitizen', 1).setAttribute('onclick', "hideShowQuestions('question0', this, '::6181|Yes:6181:|No::6181')"),
  'visible error': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<div class="error">Synthetic validation error</div>')
})) test(`legacy Continue refuses ${name}`, () => {
  const doc = page(); fill(doc); mutate(doc); assert.equal(probe(doc).canAdvance, false); assert.equal(next(doc).advanced, false); assert.equal(doc.__tellQa.nextClicks, 0);
});

test('partial historical DOB fixture stays manual and wrong route cannot repurpose full question templates', () => {
  const doc = page(partial.html, partial.URL);
  assert.equal(adapter.probePage(doc, partial.URL).pageKey, 'iowa-self-details');
  assert.equal(adapter.probePage(doc, partial.URL).canAdvance, false);
  const wrong = page(fixture.html, START.URL);
  assert.equal(adapter.probePage(wrong, START.URL).canAdvance, false);
  assert.deepEqual(adapter.scan(wrong, START.URL).fields, []);
});
