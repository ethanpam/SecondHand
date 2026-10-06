'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const generic = require('../extension/generic-adapter.js');
const catalog = require('../shared/snap-information.js');
const { layoutElements } = require('./helpers/harness.cjs');
const URL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/ssaVerificationRender';
const self = '<ul><li class="current"><a title="Start Application | Active">Start Application</a></li><li class="next"><a title="People | Unvisited">People</a></li></ul><p>Please give us additional information about yourself. If you cannot answer a question you can skip it.</p>';
const choice = (label, name = 'question', options = ['Yes', 'No']) => `<fieldset><legend>${label}</legend>${options.map((option, index) => `<label><input type="radio" name="${name}" value="${index}">${option}</label>`).join('')}</fieldset>`;
function page(body, url = URL) {
  return layoutElements(new JSDOM(`<!doctype html><body>${body}</body>`, { url, pretendToBeVisual: true }).window);
}
const cases = [
 ['Are you an Iowa resident?', 'applicantIowaResident'], ['Were you born in the United States?', 'bornInUs'],
 ['Are you a naturalized U.S. citizen?', 'naturalizedCitizen'], ['Do you need an interpreter?', 'needsInterpreter'],
 ['Do you purchase and prepare meals with this household?', 'eatsWithHousehold'], ['Are you pregnant?', 'pregnant'],
 ['Are you a migrant or seasonal farmworker?', 'migrantSeasonalFarmworker'],
 ['Does anyone in your household attend school or college?', 'householdInSchool'], ['Is anyone in your household on strike?', 'householdOnStrike'],
 ['Does anyone in your household work, expect to work, or is self-employed?', 'householdWorking'],
 ['Has anyone in your household ended a job in the last 30 days?', 'householdJobEnded30Days'],
 ['Does your household receive money from friends or relatives?', 'incomeFriendsRelatives'],
 ['Does your household receive educational grants or loans?', 'incomeEducationGrantsLoans'],
 ['Does your household pay dependent-care expenses?', 'paysDependentCare'], ['Does your household pay housing expenses?', 'paysHousing'],
 ['Does your household live in low-rent or subsidized housing?', 'lowRentHousing'], ['Does your household pay child support?', 'paysChildSupport'],
 ['Does your household pay utilities?', 'paysUtilities'], ['Has your household received energy assistance in the past year?', 'receivedEnergyAssistance'],
 ['Does your household pay medical expenses?', 'paysMedical'], ['Does your household pay Medicare expenses?', 'paysMedicare'],
 ['Does your household own real property?', 'hasRealProperty'], ['Does your household have a trust?', 'hasTrust'],
 ['Has your household sold or transferred property in the last 90 days?', 'transferredProperty90Days'],
 ['Does your household have other personal property?', 'hasPersonalProperty'], ['Does your household own a vehicle?', 'hasVehicle'],
 ['Does your household share resources with someone outside the household?', 'sharesResourcesOutsideHousehold'],
 ['Has anyone in your household aged out of foster care?', 'agedOutFosterCare'], ['Is anyone in your household homeless?', 'householdHomeless'],
 ['Does anyone in your household have an Iowa EBT card?', 'hasIowaEbt'], ['Does anyone in your household receive benefits from another state?', 'benefitsAnotherState']
];

test('exact independent Iowa questions use explicit saved scalar answers, not records or model guesses', () => {
  const doc = page(self + '<form>' + cases.map(([label], index) => choice(label, `q${index}`)).join('') + '</form>');
  const plan = generic.plan(doc);
  assert.deepEqual(plan.matched.map(item => item.key), cases.map(([, key]) => key));
  assert.deepEqual(new Set(generic.IOWA_KEYS), new Set(cases.map(([, key]) => key)));
  const fields = generic.requestKeys(plan.matched.map(item => item.key));
  assert.ok(fields.includes('iowaResident') && !fields.includes('applicantIowaResident') && !fields.includes('state'));
  assert.ok(fields.every(key => catalog.scalarFields.some(field => field.key === key)));
  const values = generic.deriveValues(Object.fromEntries(fields.map((key, index) => [key, index % 2 ? 'no' : 'yes'])));
  assert.equal(generic.fillFields(doc, plan.token, plan.matched, values).filled.length, cases.length);
  assert.equal(doc.querySelectorAll('input:checked').length, cases.length);
  assert.equal(doc.querySelectorAll('[data-secondhand-filled="guess"]').length, 0);
  for (const [, key] of cases) assert.ok(!generic.GENERIC_KEYS.includes(key) && !generic.SAVE_KEYS.includes(key));
  doc.defaultView.close();
});

test('new fields are never matched on general websites or guessed through Laya, even with supplied values/options', () => {
  for (const url of ['https://pantry.example.org', 'https://hhsservices.iowa.gov.evil.invalid/apspssp/ssp.portal', 'https://hhsservices.iowa.gov/other', 'http://hhsservices.iowa.gov/apspssp/ssp.portal']) {
    const doc = page(self + '<form>' + cases.map(([label], index) => choice(label, `q${index}`)).join('') + '</form>', url);
    const plan = generic.plan(doc); assert.deepEqual(plan.matched, []);
    for (const field of plan.unmatched) {
      assert.equal(generic.layaQuestion(field), ''); assert.equal(generic.canSuggest('householdSize', field), false);
    }
    const assignments = plan.unmatched.map((field, index) => ({ id: field.id, key: cases[index][1] }));
    assert.deepEqual(generic.fillFields(doc, plan.token, assignments, Object.fromEntries(cases.map(([, key]) => [key, 'yes']))).filled, []);
    assert.deepEqual(generic.fillFields(doc, plan.token, plan.unmatched.map(field => ({ id: field.id, option: 'Yes' })), {}).filled, []);
    doc.defaultView.close();
  }
});

test('applicant scope, complete Yes/No options, hidden state, and duplicate questions must be unambiguous', () => {
  const examples = [
    '<form>' + choice(cases[0][0]) + '</form>',
    self.replace('People | Unvisited', 'People | Active') + '<form>' + choice(cases[0][0]) + '</form>',
    self + '<h2>Employer information</h2><form>' + choice(cases[0][0]) + '</form>',
    self + '<form><section aria-label="Spouse details">' + choice(cases[0][0]) + '</section></form>',
    self + '<form><fieldset disabled>' + choice(cases[0][0]) + '</fieldset></form>',
    self + '<form><select name="answerSets[0].personSelection"><option value="">Person</option></select>' + choice(cases[0][0]) + '</form>',
    self + '<form>' + choice(cases[0][0], 'q', ['Yes', 'No, but I might move']) + '</form>',
    self + '<form>' + choice(cases[0][0], 'q', ['Yes', 'Yes', 'No']) + '</form>',
    self + '<form>' + choice(cases[0][0], 'q1') + choice(cases[0][0], 'q2') + '</form>',
    self + '<form hidden>' + choice(cases[0][0]) + '</form>'
  ];
  for (const html of examples) { const doc = page(html); assert.equal(generic.plan(doc).matched.filter(item => generic.IOWA_KEYS.includes(item.key)).length, 0, html); doc.defaultView.close(); }
});

test('unanswered, invalid, already selected, stale or newly revealed answers are never guessed or overwritten', () => {
  for (const mutation of [
    doc => { doc.querySelector('legend').textContent = 'Does your employer pay utilities?'; },
    doc => { doc.querySelector('form').hidden = true; },
    doc => { doc.querySelector('input').checked = true; },
    doc => { doc.querySelector('form').action = 'other-person'; },
    doc => { doc.querySelector('input').name = 'different'; },
    doc => { doc.querySelector('input').nextSibling.textContent = 'No'; },
    doc => { doc.body.insertAdjacentHTML('afterbegin', '<h2>Another person</h2>'); }
  ]) {
    const doc = page('<form>' + choice('Does your household pay utilities?') + '</form>');
    const plan = generic.plan(doc); assert.equal(plan.matched.length, 1); mutation(doc);
    assert.deepEqual(generic.fillFields(doc, plan.token, plan.matched, { paysUtilities: 'yes' }).filled, []); doc.defaultView.close();
  }
  const doc = page('<form>' + choice('Does your household pay utilities?') + '</form>');
  const plan = generic.plan(doc);
  for (const value of [undefined, '', 'true', 'Yes', 'maybe', '0']) assert.deepEqual(generic.fillFields(doc, plan.token, plan.matched, { paysUtilities: value }).filled, []);
  assert.equal(doc.querySelector('input:checked'), null);
  doc.querySelector('form').insertAdjacentHTML('beforeend', choice('Does your household own a vehicle?', 'vehicle'));
  assert.equal(plan.matched.length, 1); assert.equal(generic.plan(doc).matched.length, 2); doc.defaultView.close();
});

test('ambiguous income, per-person details, legal findings and compound questions remain unmapped', () => {
  const labels = ['How much?', 'How often?', 'Who pays?', 'Is your spouse pregnant?', 'Has anyone fled prosecution or violated parole?',
    'Does your household receive Social Security, alimony, or gifts?', 'Does your household pay utilities and child support?',
    'Does your household own a vehicle worth more than $5000?', 'Does your household have income below $150?',
    'Do you certify your household pays utilities?', 'Does your household pay utilities (excluding heating)?'];
  for (const label of labels) {
    const doc = page(self + '<form>' + choice(label) + '</form>');
    assert.deepEqual(generic.plan(doc).matched, [], label); doc.defaultView.close();
  }
});

test('explicit personal Iowa residency never changes the existing household-state guess', () => {
  const values = generic.deriveValues({ iowaResident: 'no', state: 'IA' });
  assert.equal(values.applicantIowaResident, 'no'); assert.equal(values.iowaResident, 'yes');
  assert.equal(generic.deriveValues({ state: 'IA' }).applicantIowaResident, undefined);
  assert.deepEqual(generic.requestKeys(['iowaResident']), ['state']);
});

test('shared dynamicQuestions household screens expose only independent household rules, never generic personal data or model choices', () => {
  const url = URL.replace('ssaVerificationRender', 'dynamicQuestions');
  const doc = page(self + '<h2>Expenses Information</h2><form id="answerSet" action="simple" method="post">' + choice('Does your household pay utilities?') +
    choice('Are you pregnant?', 'personal') + '<label>First name<input name="firstName"></label><label>How much<input name="amount"></label>' + choice('Which situation applies?', 'unknown') + '</form>', url);
  const plan = generic.plan(doc);
  assert.deepEqual(plan.matched.map(item => item.key), ['paysUtilities']);
  const guesses = plan.unmatched.map(item => item.type === 'radio' ? { id: item.id, option: 'Yes' } : { id: item.id, key: 'firstName' });
  assert.deepEqual(generic.fillFields(doc, plan.token, guesses, { firstName: 'Synthetic' }).filled, []);
  assert.deepEqual(generic.fillFields(doc, plan.token, plan.matched, { paysUtilities: 'no' }).filled, [plan.matched[0].id]);
  assert.equal(doc.querySelector('input[name="firstName"]').value, ''); doc.defaultView.close();
});

test('strict screening pages protect incomplete layouts from generic fallback and preserve distinct steps', () => {
  const adapter = require('../extension/iowa-adapter.js');
  const url = URL.replace('ssaVerificationRender', 'dynamicQuestions');
  const stepKeys = new Set();
  for (const [heading, pageKey] of [['Job Information', 'iowa-job-screening'], ['Income Information', 'iowa-income-screening'],
    ['Expenses Information', 'iowa-expenses-screening'], ['Property Information', 'iowa-property-screening']]) {
    const doc = page(`<h2>${heading}</h2><form id="answerSet" action="simple" method="post">${choice('Does your household pay utilities?')}</form>`, url);
    const probe = adapter.probePage(doc, url);
    assert.equal(probe.pageKey, `${pageKey}-unverified`); stepKeys.add(probe.pageKey);
    assert.equal(probe.kind, 'manual'); assert.equal(probe.canAdvance, false); assert.ok(probe.todo, 'a manual instruction prevents generic/model fallback');
    assert.equal(adapter.captureNavigation(doc, url), null); doc.defaultView.close();
  }
  assert.equal(stepKeys.size, 4, 'same route has separate known semantic screening steps');
  for (const variant of [url + '?person=1', url + '/', url + '#other-person']) {
    const doc = page('<h2>Expenses Information</h2><form id="answerSet" action="simple" method="post">' + choice('Does your household pay utilities?') + '</form>', variant);
    const probe = adapter.probePage(doc, variant); assert.notEqual(probe.pageKey, 'iowa-household-screening-rules'); assert.ok(probe.todo); doc.defaultView.close();
  }
  const invalid = [
    doc => { doc.querySelector('h2').textContent = 'Tell Us More'; },
    doc => { doc.querySelector('h2').textContent = 'Housing Expenses'; },
    doc => { doc.querySelector('h2').after(doc.querySelector('h2').cloneNode(true)); },
    doc => { doc.querySelector('form').action = 'otherPerson'; },
    doc => { doc.querySelector('form').insertAdjacentHTML('afterbegin', '<select id="answerSets0.personSelection"><option value="">Select person</option></select>'); },
    doc => { doc.querySelector('form').insertAdjacentHTML('afterbegin', '<label><input type="checkbox">I certify these answers are true</label>'); },
    doc => { doc.querySelector('form').insertAdjacentHTML('afterbegin', '<h3>Employer information</h3>'); }
  ];
  for (const mutate of invalid) {
    const doc = page(`<h2>Expenses Information</h2><form id="answerSet" action="simple" method="post">${choice('Does your household pay utilities?')}</form>`, url); mutate(doc);
    const probe = adapter.probePage(doc, url); assert.notEqual(probe.pageKey, 'iowa-household-screening-rules'); assert.ok(probe.todo); assert.equal(probe.canAdvance, false); doc.defaultView.close();
  }
});
