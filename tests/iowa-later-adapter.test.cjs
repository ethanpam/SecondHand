'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-later-adapter.js');
const fixtures = require('./fixtures/iowa-later-pages.cjs');
const keys = { emergency: 'iowa-emergency-screening', background: 'iowa-background-information', jobs: 'iowa-job-screening', income: 'iowa-income-screening', expenses: 'iowa-expenses-screening', property: 'iowa-property-screening' };
const profiles = {
  emergency: { emergencyIncomeUnder150: 'yes', emergencyCashUnder100: 'no', emergencyMigrantSeasonal: 'no', emergencyHousingExceedsExpectedIncome: 'yes' },
  background: { iowaResident: 'yes', migrantSeasonalFarmworker: 'no', preferredLanguage: 'English', naturalizedCitizen: 'no', birthState: 'IA' },
  jobs: { householdInSchool: 'no', householdOnStrike: 'no', householdWorking: 'yes', householdJobEnded30Days: 'no' },
  income: { incomeSocialSecurityRetirement: 'yes', incomeSupportInvestmentsUnemployment: 'no', incomeGiftsWorkersCompSsi: 'no', incomeEducationGrantsLoans: 'no', incomeInKindSupport: 'no', incomeExpectedUnchanged: 'yes', incomeFriendsRelatives: 'no', incomeOther: 'no' },
  expenses: { paysDependentCare: 'no', paysHousing: 'yes', lowRentHousing: 'no', paysChildSupport: 'no', paysUtilities: 'yes', receivedEnergyAssistanceCurrentAddress: 'no', paysUncoveredAgedDisabledMedical: 'no', paysMedicare: 'no' },
  property: { hasLiquidAssets: 'yes', ownsOrBuyingProperty: 'no', hasConservatorshipOrTrust: 'no', transferredProperty90Days: 'no', hasPersonalProperty: 'no', ownsOrRegisteredVehicle: 'no', sharesResourcesOutsideHousehold: 'no' }
};
function page(kind) {
  const doc = new JSDOM(fixtures.makeHtml(kind), { url: fixtures.url(kind), pretendToBeVisual: true }).window.document;
  const E = doc.defaultView.Element;
  E.prototype.getBoundingClientRect = () => ({ left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 });
  E.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  E.prototype.scrollIntoView = () => {};
  return doc;
}
function fill(doc, kind, profile = profiles[kind], bindings = adapter.scan(doc, fixtures.url(kind)).bindings) {
  return adapter.fill(doc, fixtures.url(kind), bindings, adapter.pageValues(keys[kind], profile));
}
const probe = (doc, kind) => adapter.probePage(doc, fixtures.url(kind));
const next = doc => Array.from(doc.querySelectorAll('button')).find(button => button.textContent === 'Save and Continue');
function reveal(doc, id) { const q = doc.getElementById(id); q.className = 'questionAnswer'; return q; }

for (const kind of Object.keys(keys)) test(`${kind}: exact observed blank page offers only its scalar fields, fills and continues once`, () => {
  const doc = page(kind), url = fixtures.url(kind), scan = adapter.scan(doc, url);
  assert.equal(scan.recognizedPage, true);
  assert.equal(probe(doc, kind).canAdvance, false);
  const result = fill(doc, kind);
  assert.deepEqual(result.filled.sort(), Object.keys(profiles[kind]).sort());
  assert.equal(probe(doc, kind).canAdvance, true);
  if (kind === 'background') assert.equal(doc.getElementById('answerSets0.answers187.answerValue').value, 'Iowa');
  assert.doesNotMatch(JSON.stringify(probe(doc, kind)), /Synthetic Example|qa-token|qa-person|answerSets|question0/);
  let clicks = 0; next(doc).addEventListener('click', () => clicks++);
  const token = adapter.captureNavigation(doc, url);
  assert.deepEqual(token, {});
  assert.equal(adapter.advance(doc, url, token).advanced, true);
  assert.equal(adapter.advance(doc, url, token).advanced, false);
  assert.equal(clicks, 1);
  const before = [...doc.querySelectorAll('input,select')].map(element => [element.value, element.checked]);
  assert.deepEqual(fill(doc, kind).filled, []);
  assert.deepEqual([...doc.querySelectorAll('input,select')].map(element => [element.value, element.checked]), before);
});

test('no savings, birth-state, language-help or household answers are inferred from other fields', () => {
  assert.deepEqual(adapter.pageValues(keys.emergency, { emergencyHousingExceedsIncome: 'yes', monthlyIncome: '0', cashOnHand: '0' }), {});
  assert.deepEqual(adapter.pageValues(keys.background, { state: 'IA', needsInterpreter: 'yes', usCitizen: 'yes', householdMigrantSeasonal: 'no' }), {});
  assert.deepEqual(adapter.pageValues(keys.jobs, { jobs: [{ person: 'Synthetic Example' }], taxStatements: [{ annualIncome: '10000' }] }), {});
  assert.deepEqual(adapter.pageValues(keys.expenses, { receivedEnergyAssistance: 'yes', paysMedical: 'yes', housingExpenses: [{ amount: '800' }] }), {});
  for (const value of ['yes', 'no']) assert.deepEqual(adapter.pageValues(keys.property, { hasRealProperty: value, hasTrust: value, hasVehicle: value }), {});
  for (const kind of Object.keys(keys)) {
    const doc = page(kind); assert.deepEqual(fill(doc, kind, {}).filled, []); assert.equal(probe(doc, kind).canAdvance, false);
  }
});

test('outside shared-route headings return null; a known heading with a broken form stays explicitly manual', () => {
  const doc = page('emergency');
  doc.querySelector('form').setAttribute('action', 'changed');
  assert.equal(probe(doc, 'emergency').kind, 'manual');
  assert.equal(adapter.scan(doc, fixtures.url('emergency')).recognizedPage, false);
  doc.querySelector('h2').textContent = 'Tell Us More';
  assert.equal(probe(doc, 'emergency'), null);
  const unrelated = new JSDOM('<h2>Tell Us More</h2>', { url: fixtures.url('emergency') }).window.document;
  assert.equal(adapter.probePage(unrelated, unrelated.location.href), null);
  assert.equal(adapter.probePage(doc, fixtures.url('emergency') + '?other=true'), null);
  assert.equal(adapter.probePage(doc, 'https://example.org/applyForBenefits/dynamicQuestionsStart'), null);
});

test('non-English language needs its actual observed help question and explicit saved answer', () => {
  const doc = page('background');
  const language = doc.getElementById('answerSets0.answers8.answerValue');
  language.addEventListener('change', () => reveal(doc, 'question0566'));
  const result = fill(doc, 'background', { ...profiles.background, preferredLanguage: 'Spanish', wantsFreeLanguageHelp: 'yes' });
  assert.equal(result.filled.includes('wantsFreeLanguageHelp'), false, 'newly revealed fields require a fresh scan');
  assert.equal(probe(doc, 'background').canAdvance, false);
  assert.deepEqual(fill(doc, 'background', { wantsFreeLanguageHelp: 'yes' }).filled, ['wantsFreeLanguageHelp']);
  assert.equal(probe(doc, 'background').canAdvance, true);
  language.value = 'English';
  assert.equal(probe(doc, 'background').canAdvance, false, 'stale visible language-help branch is not assumed relevant');
});

test('race supports only explicit exact single/semicolon-separated choices, never overwrites or infers ethnicity', () => {
  assert.equal(adapter.pageValues(keys.background, { race: 'White;Black or African American' }).race, 'White;Black or African American');
  assert.deepEqual(adapter.pageValues(keys.background, { race: 'white' }), {});
  assert.deepEqual(adapter.pageValues(keys.background, { race: 'White,Asian' }), {});
  assert.deepEqual(adapter.pageValues(keys.background, { race: 'White;White' }), {});
  const doc = page('background');
  assert.ok(fill(doc, 'background', { ...profiles.background, race: 'White;Black or African American' }).filled.includes('race'));
  assert.equal(probe(doc, 'background').canAdvance, true);
  assert.deepEqual(fill(doc, 'background', { race: 'Unknown' }).filled, []);
  assert.equal(doc.getElementById('answerSets0.answers189.answerValues7').checked, false);
});

for (const [kind, answers] of [['background', { naturalizedCitizen: 'yes' }], ['background', { race: 'Asian' }], ['background', { preferredLanguage: 'Spanish' }], ['jobs', { householdOnStrike: 'yes' }]]) {
  test(`${kind}: an unobserved follow-up pauses even if it has not appeared`, () => {
    const doc = page(kind); fill(doc, kind, { ...profiles[kind], ...answers });
    assert.equal(probe(doc, kind).canAdvance, false);
    assert.equal(adapter.captureNavigation(doc, fixtures.url(kind)), null);
  });
}

for (const [label, mutate] of Object.entries({
  'missing answer': d => { d.getElementById('answerSets0.answers0.answerValue1').checked = false; },
  'unknown question': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<div class="questionAnswer"><label>Unknown<input value="already answered"></label></div>'),
  'custom editable': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<div contenteditable="plaintext-only"></div>'),
  'unknown action': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<button type="button">Add another answer</button>'),
  'visible error': d => d.querySelector('form').insertAdjacentHTML('beforeend', '<div id="serverError">Synthetic error</div>'),
  'visible dialog': d => { d.querySelector('.modal').style.display = 'block'; },
  'wrong phase': d => d.querySelector('a').setAttribute('title', 'People | Active'),
  'wrong target': d => d.querySelector('form').setAttribute('target', '_blank'),
  'wrong action': d => d.querySelector('form').setAttribute('action', 'eSignature'),
  'wrong handler': d => next(d).setAttribute('onclick', 'submitApplication()'),
  'duplicate next': d => d.querySelector('form').append(next(d).cloneNode(true)),
  'aria invalid': d => d.getElementById('answerSets0.answers1.answerValue1').setAttribute('aria-invalid', 'true'),
  'question wording changed': d => { d.querySelector('legend').textContent = 'Changed question'; },
  'unknown option': d => { d.getElementById('answerSets0.answers0.answerValue1').value = 'Maybe'; },
  'external owned input': d => d.body.insertAdjacentHTML('beforeend', '<input form="answerSet" name="outside" value="synthetic">')
})) test(`automatic Next refuses ${label}`, () => {
  const doc = page('emergency'); fill(doc, 'emergency'); mutate(doc);
  assert.equal(probe(doc, 'emergency').canAdvance, false);
  assert.equal(adapter.captureNavigation(doc, fixtures.url('emergency')), null);
});

for (const [label, mutate] of Object.entries({
  answer: d => { d.getElementById('answerSets0.answers1.answerValue1').checked = true; },
  person: d => { d.querySelector('form h3').textContent = 'Another synthetic person'; },
  hidden: d => { d.querySelector('[name="answerSets[0].personSelection"]').value = 'other'; },
  addedHidden: d => d.querySelector('form').insertAdjacentHTML('beforeend', '<input type="hidden" name="other" value="test">'),
  next: d => next(d).setAttribute('onclick', 'different()'),
  labels: d => { d.querySelector('label').textContent = 'Other option'; }
})) test(`private one-use Next snapshot rejects changed ${label}`, () => {
  const doc = page('emergency'); fill(doc, 'emergency');
  const token = adapter.captureNavigation(doc, fixtures.url('emergency')); assert.ok(token);
  let count = 0; next(doc).addEventListener('click', () => count++); mutate(doc);
  assert.equal(adapter.advance(doc, fixtures.url('emergency'), token).advanced, false);
  assert.equal(count, 0);
});

test('stale fill preview cannot release answers after hidden recipient changes or preserve a replaced person', () => {
  const doc = page('emergency'), bindings = adapter.scan(doc, fixtures.url('emergency')).bindings;
  doc.querySelector('[name="answerSets[0].personSelection"]').value = 'different';
  assert.deepEqual(fill(doc, 'emergency', profiles.emergency, bindings).filled, []);
  const fresh = page('emergency');
  fresh.getElementById('answerSets0.answers0.answerValue1').addEventListener('click', () => { fresh.querySelector('[name="answerSets[0].personSelection"]').value = 'different'; });
  assert.deepEqual(fill(fresh, 'emergency').filled, ['emergencyIncomeUnder150']);
});

test('scroll-time page changes and overlays prevent the final click', () => {
  const doc = page('emergency'); fill(doc, 'emergency');
  const token = adapter.captureNavigation(doc, fixtures.url('emergency'));
  doc.elementFromPoint = () => doc.body;
  let count = 0; next(doc).addEventListener('click', () => count++);
  assert.equal(adapter.advance(doc, fixtures.url('emergency'), token).advanced, false);
  assert.equal(count, 0);
});

test('a checkbox handler changing another option prevents a later checkbox click', () => {
  const doc = page('background');
  const first = doc.getElementById('answerSets0.answers189.answerValues3'), second = doc.getElementById('answerSets0.answers189.answerValues6');
  first.addEventListener('click', () => second.setAttribute('onclick', 'changedHandler()'));
  let secondClicks = 0; second.addEventListener('click', () => secondClicks++);
  const result = fill(doc, 'background', { race: 'Black or African American;White' });
  assert.equal(result.filled.includes('race'), false);
  assert.equal(secondClicks, 0);
  assert.equal(second.checked, false);
});

test('Emergency intro and H3 are identified without invented wrapper classes; duplicate or misplaced intro refuses', () => {
  const doc = page('emergency'), p = doc.querySelector('div.fullrow > p');
  p.parentElement.className = 'another-static-wrapper';
  p.outerHTML = `<section><span>${fixtures.metadata.emergency.intro}</span></section>`;
  assert.equal(adapter.scan(doc, fixtures.url('emergency')).recognizedPage, true);
  doc.querySelector('#stepper-div-id').append(doc.querySelector('section').cloneNode(true));
  // The after-form duplicate is not accepted as the before-form introduction.
  assert.equal(adapter.scan(doc, fixtures.url('emergency')).recognizedPage, true);
  doc.querySelector('form').before(doc.querySelector('section').cloneNode(true));
  assert.equal(adapter.scan(doc, fixtures.url('emergency')).recognizedPage, false);
});

test('shared dynamicQuestions route selects the visible semantic page, not a hidden template or prior heading', () => {
  const doc = page('income');
  doc.body.insertAdjacentHTML('afterbegin', '<div style="visibility:hidden"><h2>Job Information</h2><h2>Help Me Understand</h2></div>');
  assert.equal(probe(doc, 'income').pageKey, keys.income);
  assert.equal(adapter.scan(doc, fixtures.url('income')).fields.some(field => field.key === 'householdWorking'), false);
  doc.querySelector('.htmlHeaderPageTitle h2').textContent = 'Job Information';
  assert.equal(probe(doc, 'income').canAdvance, false);
});

test('income list questions require exact prefix and ordered individual list items', () => {
  for (const mutate of [
    d => { d.querySelector('#question06542 li').textContent = 'Changed income type'; },
    d => { const list = d.querySelector('#question06542 ul'); list.append(list.firstElementChild); },
    d => { d.querySelector('#question01007080 li').remove(); }
  ]) {
    const doc = page('income'); mutate(doc);
    assert.ok(adapter.scan(doc, fixtures.url('income')).fields.length < 8);
    fill(doc, 'income'); assert.equal(probe(doc, 'income').canAdvance, false);
  }
});

test('Property transfer binds exact leading-space raw options without weakening other yes/no controls', () => {
  for (const [answer, index, raw] of [['yes', 1, ' Yes'], ['no', 2, ' No']]) {
    const doc = page('property');
    assert.deepEqual(fill(doc, 'property', { transferredProperty90Days: answer }).filled, ['transferredProperty90Days']);
    const input = doc.getElementById(`answerSets0.answers5.answerValue${index}`);
    assert.equal(input.checked, true); assert.equal(input.value, raw);
  }
  for (const mutate of [
    d => { d.getElementById('answerSets0.answers5.answerValue1').value = 'Yes'; },
    d => { d.getElementById('answerSets0.answers0.answerValue1').value = ' Yes'; }
  ]) {
    const doc = page('property'); mutate(doc); fill(doc, 'property');
    assert.equal(probe(doc, 'property').canAdvance, false);
  }
});
