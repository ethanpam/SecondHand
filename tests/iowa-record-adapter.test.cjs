'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-record-adapter.js');
const fixture = require('./fixtures/iowa-job-history.cjs');
const URL = fixture.URL;
const values = Object.freeze({ person: 'Avery Example', workOrTraining: 'Work', startDate: '2026-02-03', selfEmployed: 'no', employer: 'Fictional Employer',
  jobTitle: 'Synthetic Clerk', monthlyHours: '120', amount: '850.50', frequency: 'Every Other Week', tipsOrCommissions: '0', incomeExpectedSame: 'yes',
  changedJobs30Days: 'no', stoppedWorking30Days: 'no', fewerHours30Days: 'no' });
function page(options) {
  const doc = new JSDOM(fixture.makeHtml(options), { url: URL, pretendToBeVisual: true }).window.document;
  const E = doc.defaultView.Element;
  E.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30 });
  E.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  E.prototype.scrollIntoView = () => {};
  fixture.attachHandlers(doc); return doc;
}
const input = (doc, index, suffix = '') => doc.getElementById(`answerSets0.answers${index}.answerValue${suffix}`);
const probe = doc => adapter.probePage(doc, URL);
const snapshot = doc => [...doc.querySelectorAll('input,select')].map(el => [el.id, el.value, el.checked, el.disabled]);
function pass(doc, record = values) { return adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, record); }
function complete(doc, record = values) { const results = []; for (let i = 0; i < 4; i++) results.push(pass(doc, record)); return results; }
function selectOwner(doc, value = '0') { const select = doc.getElementById('answerSets0.personSelection'); select.value = value; select.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); }

test('captured job form binds an explicit owner, fills newly revealed controls in fresh passes and continues once', () => {
  const doc = page(), initial = adapter.scan(doc, URL);
  assert.equal(initial.recognizedPage, true); assert.deepEqual(initial.fields.map(f => f.key), ['person']);
  assert.deepEqual(adapter.recordContext(doc, URL, initial.bindings), {});
  const results = complete(doc);
  assert.ok(results.every(result => !result.unsafe));
  assert.equal(doc.getElementById('answerSets0.personSelection').value, '0');
  assert.equal(input(doc, 2).value, '02/03/2026'); assert.equal(input(doc, 4).value, values.employer);
  assert.equal(input(doc, 6).value, '120'); assert.equal(input(doc, 8).value, '850.50'); assert.equal(input(doc, 11).value, 'Every Other Week');
  assert.equal(probe(doc).canAdvance, true, JSON.stringify(probe(doc)));
  for (const key of ['changedJobs30Days', 'stoppedWorking30Days', 'fewerHours30Days']) assert.equal(probe(doc).checklist.find(row => row.key === key).status, 'complete');
  const publicState = JSON.stringify(probe(doc));
  assert.doesNotMatch(publicState, /Avery|Fictional Employer|Synthetic Clerk|850\.50|answerSets/);
  const token = adapter.captureNavigation(doc, URL); assert.deepEqual(token, {});
  assert.equal(adapter.advance(doc, URL, token).advanced, true); assert.equal(adapter.advance(doc, URL, token).advanced, false);
  assert.equal(doc.__jobQa.nextClicks, 1);
  const before = snapshot(doc); complete(doc); assert.deepEqual(snapshot(doc), before);
});

test('an explicit owner matches whitespace and case only, never the first option, a partial name, or a duplicate', () => {
  const doc = page(); complete(doc, { ...values, person: '  jordan   SAMPLE ' });
  assert.equal(doc.getElementById('answerSets0.personSelection').value, '1'); assert.equal(probe(doc).canAdvance, true);
  for (const person of ['', 'Avery', 'A. Example', 'Unknown Person']) {
    const candidate = page(), before = snapshot(candidate); assert.equal(pass(candidate, { ...values, person }).unsafe, true); assert.deepEqual(snapshot(candidate), before);
  }
  const duplicate = page({ people: ['Avery Example', ' avery  example '] });
  assert.equal(pass(duplicate).unsafe, true); assert.equal(doc.__jobQa.nextClicks, 0);
});

test('a different selected owner or conflicting existing job is preserved without partial filling', () => {
  const owner = page(); selectOwner(owner, '1'); const before = snapshot(owner);
  assert.equal(pass(owner).unsafe, true); assert.deepEqual(snapshot(owner), before);
  const doc = page(); selectOwner(doc); input(doc, 0, '1').click(); input(doc, 3, '2').click(); input(doc, 4).value = 'Existing Employer';
  const job = snapshot(doc); assert.equal(pass(doc).unsafe, true); assert.deepEqual(snapshot(doc), job); assert.equal(probe(doc).canAdvance, false);
});

test('unchecked change boxes remain unanswered unless the selected record explicitly says No', () => {
  const missing = { ...values }; delete missing.changedJobs30Days; delete missing.stoppedWorking30Days; delete missing.fewerHours30Days;
  const doc = page(); complete(doc, missing);
  assert.equal(probe(doc).canAdvance, false); assert.equal(adapter.captureNavigation(doc, URL), null);
  for (const row of probe(doc).checklist.filter(row => /30Days$/.test(row.key))) assert.equal(row.status, 'missing');
  pass(doc, values); assert.equal(probe(doc).canAdvance, true);
  doc.getElementById('answerSets0.answers17.answerValues1').click();
  assert.equal(probe(doc).canAdvance, false, 'a later manual change invalidates the earlier No proof');
});

test('positive recent changes use only explicit Yes, and conflicting existing checks are not cleared', () => {
  const doc = page(); complete(doc, { ...values, changedJobs30Days: 'yes' });
  assert.equal(doc.getElementById('answerSets0.answers17.answerValues1').checked, true); assert.equal(probe(doc).canAdvance, true);
  const before = snapshot(doc); assert.equal(pass(doc, values).unsafe, true); assert.deepEqual(snapshot(doc), before);
});

test('self-employment uses only explicit monthly net income and current Monthly frequency, never gross pay', () => {
  const record = { ...values, selfEmployed: 'yes', selfEmploymentMonthlyNet: '600.25', hasBusinessExpenses: 'no', frequency: 'Monthly', amount: '9999' };
  const doc = page(); complete(doc, record);
  assert.equal(input(doc, 8).value, '600.25'); assert.equal(input(doc, 11).value, 'Monthly'); assert.equal(probe(doc).canAdvance, true, JSON.stringify(probe(doc)));
  for (const override of [{ selfEmploymentMonthlyNet: '' }, { frequency: 'Weekly' }, { hasBusinessExpenses: '' }]) {
    const incomplete = page(); complete(incomplete, { ...record, ...override }); assert.equal(probe(incomplete).canAdvance, false);
    if (override.selfEmploymentMonthlyNet === '' || override.frequency) assert.equal(input(incomplete, 8).value, '');
  }
});

test('unobserved Training and missing explicit monthly hours never inherit work or weekly hours', () => {
  const training = page(); complete(training, { ...values, workOrTraining: 'Training' });
  assert.equal(probe(training).canAdvance, false); assert.equal(input(training, 8).value, '');
  const doc = page(); complete(doc, { ...values, monthlyHours: '', hoursPerWeek: '30' });
  assert.equal(input(doc, 6).value, ''); assert.equal(probe(doc).canAdvance, false);
});

for (const [name, mutate] of [
  ['owner selection', doc => selectOwner(doc, '1')],
  ['existing amount', doc => { input(doc, 8).value = '123'; }],
  ['hidden payload', doc => { doc.querySelector('input[type="hidden"]').value = 'changed'; }],
  ['new visible input', doc => { const el = doc.createElement('input'); doc.querySelector('form').append(el); }],
  ['replaced form', doc => { const form = doc.querySelector('form'); form.replaceWith(form.cloneNode(true)); }]
]) test(`a ${name} change while desktop approval is pending rejects the entire stale binding`, () => {
  const doc = page(); selectOwner(doc); input(doc, 0, '1').click(); input(doc, 3, '2').click();
  const scanned = adapter.scan(doc, URL); mutate(doc); const before = snapshot(doc);
  assert.equal(adapter.recordContext(doc, URL, scanned.bindings), null);
  assert.equal(adapter.fill(doc, URL, scanned.bindings, values).unsafe, true); assert.deepEqual(snapshot(doc), before);
});

for (const [name, mutate] of [
  ['unknown control', doc => { const el = doc.createElement('input'); doc.querySelector('form').append(el); }],
  ['unknown question', doc => { const el = doc.createElement('div'); el.className = 'questionAnswer'; el.textContent = 'Uncaptured follow-up'; doc.querySelector('form').append(el); }],
  ['error', doc => { const el = doc.createElement('div'); el.setAttribute('role', 'alert'); el.textContent = 'Correct an answer'; doc.body.append(el); }],
  ['modal', doc => { const el = doc.createElement('div'); el.setAttribute('role', 'dialog'); doc.body.append(el); }],
  ['consent', doc => { const el = doc.createElement('h3'); el.textContent = 'Consent'; doc.body.append(el); }],
  ['changed Next', doc => doc.querySelector(fixture.NEXT_SELECTOR).setAttribute('onclick', 'submitApplication()')]
]) test(`completed records stop before ${name}, including a previously captured navigation token`, () => {
  const doc = page(); complete(doc); const token = adapter.captureNavigation(doc, URL); assert.ok(token);
  mutate(doc); assert.equal(probe(doc).canAdvance, false); assert.equal(adapter.advance(doc, URL, token).advanced, false); assert.equal(doc.__jobQa.nextClicks, 0);
});

test('wrong route, phase, form action, or owner handler cannot become a supported job form', () => {
  assert.equal(adapter.probePage(page(), URL + '?different=1'), null);
  for (const mutate of [doc => doc.querySelector('li.current a').title = 'Job and School | Visited', doc => doc.querySelector('form').action = 'other',
    doc => doc.getElementById('answerSets0.personSelection').setAttribute('onchange', 'chooseFirstPerson()')]) {
    const doc = page(); mutate(doc); assert.equal(adapter.scan(doc, URL).recognizedPage, false); assert.equal(probe(doc).canAdvance, false); assert.equal(pass(doc).unsafe, true);
  }
});

test('an existing checked change answer receives proof only from a matching explicit saved Yes', () => {
  const doc = page(); selectOwner(doc); input(doc, 0, '1').click(); input(doc, 3, '2').click();
  const changed = doc.getElementById('answerSets0.answers17.answerValues1'); changed.click();
  complete(doc, { ...values, changedJobs30Days: 'yes' });
  assert.equal(changed.checked, true);
  assert.equal(probe(doc).checklist.find(row => row.key === 'changedJobs30Days').status, 'complete');
  assert.equal(probe(doc).canAdvance, true);
  const unanswered = page(); selectOwner(unanswered); input(unanswered, 0, '1').click(); input(unanswered, 3, '2').click();
  unanswered.getElementById('answerSets0.answers17.answerValues1').click();
  complete(unanswered, { ...values, changedJobs30Days: '' });
  assert.equal(probe(unanswered).canAdvance, false, 'a checked box does not create a saved record answer');
});

test('an optional unknown answer edited during approval invalidates the whole record snapshot', () => {
  const doc = page(); selectOwner(doc); input(doc, 0, '1').click(); input(doc, 3, '2').click();
  const extra = doc.createElement('textarea'); extra.name = 'synthetic_optional_question'; extra.required = false; doc.querySelector('form').append(extra);
  const scanned = adapter.scan(doc, URL); assert.ok(scanned.bindings.length);
  extra.value = 'Fictional user edit after scan'; const before = snapshot(doc);
  assert.equal(adapter.recordContext(doc, URL, scanned.bindings), null);
  assert.equal(adapter.fill(doc, URL, scanned.bindings, values).unsafe, true);
  assert.equal(extra.value, 'Fictional user edit after scan'); assert.deepEqual(snapshot(doc), before); assert.equal(doc.__jobQa.nextClicks, 0);
});
