'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const fixture = require('./fixtures/iowa-tell-us-more.cjs');
const oldFixture = require('./fixtures/iowa-self-details.cjs');

const PAGE_KEY = 'iowa-tell-us-more';
const FILLS = ['birthDate', 'hasSsn', 'usCitizen', 'hasDisability', 'hasMedicare'];
const saved = { birthDate: '1985-04-12', hasSsn: 'yes', householdAllCitizens: 'yes', householdDisability: 'no', householdMedicare: 'no' };
const values = () => adapter.pageValues(PAGE_KEY, saved);

// Every element, including ones a test adds or clones, has an on-screen box unless its style hides it.
function page(html = fixture.html, url = fixture.URL) {
  const doc = new JSDOM(`<!doctype html><main>${html}</main>`, { url, pretendToBeVisual: true }).window.document;
  const { Element } = doc.defaultView;
  Element.prototype.getBoundingClientRect = () => ({ left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 });
  Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  return doc;
}
const byId = (doc, id) => doc.getElementById(id);
const dob = doc => byId(doc, fixture.DOB_ID);
// option 1 is Yes (Male), option 2 is No (Female)
const radio = (doc, key, option) => byId(doc, fixture.radioId(fixture.ANSWERS[key], option));
const checkedRadios = doc => Array.from(doc.querySelectorAll('input[type="radio"]')).filter(element => element.checked).map(element => element.id);
const fieldKeys = doc => adapter.scan(doc, fixture.URL).fields.map(field => field.key);
const fillAll = (doc, bindings = adapter.scan(doc, fixture.URL).bindings) => adapter.fill(doc, fixture.URL, bindings, values());
const settled = [fixture.radioId(6, 1), fixture.radioId(18, 1), fixture.radioId(26, 2), fixture.radioId(29, 2)];
function reveal(doc, ids) {
  for (const id of ids) { const question = byId(doc, id); question.classList.remove('hidden'); question.style.display = ''; }
}

test('Tell Us More at dynamicQuestionsStart offers the date of birth and four yes/no answers, and never Save and Continue', () => {
  const doc = page(), scan = adapter.scan(doc, fixture.URL), probe = adapter.probePage(doc, fixture.URL);
  assert.equal(scan.recognizedPage, true);
  assert.deepEqual(scan.fields, [
    { key: 'birthDate', label: 'Date of birth' }, { key: 'hasSsn', label: 'Do you have a Social Security number?' },
    { key: 'usCitizen', label: 'Are you a U.S. citizen or national?' }, { key: 'hasDisability', label: 'Are you disabled?' },
    { key: 'hasMedicare', label: 'Do you have Medicare?' }]);
  assert.equal(probe.kind, 'fillable'); assert.equal(probe.pageKey, PAGE_KEY); assert.equal(probe.heading, 'Tell Us More');
  assert.equal(probe.canAdvance, false);
  assert.deepEqual(probe.fields, scan.fields);
  assert.deepEqual(probe.checklist.map(item => [item.key, item.status]), [
    ['gender', 'manual'], ['birthDate', 'missing'], ['hasSsn', 'missing'], ['usCitizen', 'missing'], ['maritalStatus', 'manual'],
    ['militaryOrVeteran', 'manual'], ['hasDisability', 'missing'], ['blind', 'manual'], ['healthLimits', 'manual'], ['hasMedicare', 'missing'],
    ['startDetailsReview', 'manual']]);
  assert.deepEqual(probe.checklist.filter(item => item.fillable).map(item => item.key), FILLS);
  assert.equal(probe.requiredRemaining, 5); assert.equal(probe.manualRemaining, 6);
  assert.equal(probe.todo, 'Answer the remaining questions, then click Save and Continue in Iowa’s form yourself.');
  assert.doesNotMatch(JSON.stringify(probe), /Avery|Example|answerSets|question0/);
  assert.equal(adapter.captureNavigation(doc, fixture.URL), null);
  let clicked = 0; byId(doc, 'dqButtonId309').addEventListener('click', () => clicked++);
  fillAll(doc);
  assert.equal(adapter.advance(doc, fixture.URL, {}).advanced, false); assert.equal(adapter.continuePage(doc, fixture.URL).continued, false);
  assert.equal(clicked, 0);
});

test('the saved profile maps only to answers it settles, and the Social Security number itself is never asked for', () => {
  assert.deepEqual(adapter.profileRequest(PAGE_KEY), ['birthDate', 'hasSsn', 'householdAllCitizens', 'householdDisability', 'householdMedicare']);
  assert.deepEqual(adapter.pageValues(PAGE_KEY, { ...saved, ssn: '999-99-9999', householdVeteran: 'no', firstName: 'Avery' }),
    { birthDate: '1985-04-12', hasSsn: 'yes', usCitizen: 'yes', hasDisability: 'no', hasMedicare: 'no' });
  // A household "no" to citizenship, a "yes" to disability or Medicare, or no saved SSN leaves the question for the applicant.
  assert.deepEqual(adapter.pageValues(PAGE_KEY, { hasSsn: '', householdAllCitizens: 'no', householdDisability: 'yes', householdMedicare: 'yes' }), {});
  assert.deepEqual(adapter.pageValues(PAGE_KEY, {}), {});
  assert.deepEqual(adapter.pageValues(PAGE_KEY, null), {});
});

test('Autofill types the date of birth and clicks each settled answer like a person, leaving every other question alone', () => {
  const doc = page(), events = [];
  for (const element of doc.querySelectorAll('input[type="radio"]')) {
    for (const type of ['click', 'change']) element.addEventListener(type, () => events.push(`${type}:${element.id}`));
  }
  let typed = 0; dob(doc).addEventListener('change', () => typed++);
  assert.deepEqual(fillAll(doc), { filled: FILLS, skipped: [] });
  assert.equal(dob(doc).value, '04/12/1985'); assert.equal(typed, 1);
  assert.deepEqual(checkedRadios(doc), settled);
  assert.deepEqual(events, settled.flatMap(id => [`click:${id}`, `change:${id}`]));
  assert.equal(byId(doc, fixture.MARITAL_ID).value, '');
  // The hidden and disabled date-of-birth alternatives and the Social Security number box stay empty.
  for (const id of ['answerSets0.answers3.answerValue', 'answerSets0.answers4.answerValue', fixture.SSN_BOX_ID]) assert.equal(byId(doc, id).value, '', id);
  assert.deepEqual(adapter.scan(doc, fixture.URL).fields, []);
  const probe = adapter.probePage(doc, fixture.URL);
  assert.deepEqual(probe.checklist.filter(item => item.status === 'complete').map(item => item.key), FILLS);
  assert.equal(probe.requiredRemaining, 0); assert.equal(probe.canAdvance, false);
});

test('an answer the saved profile does not settle is never clicked, even when handed straight to fill', () => {
  const doc = page();
  const result = adapter.fill(doc, fixture.URL, adapter.scan(doc, fixture.URL).bindings, { hasSsn: 'no', usCitizen: 'no', hasDisability: 'yes', hasMedicare: 'yes', ssn: '999-99-9999' });
  assert.deepEqual(result.filled, []);
  assert.deepEqual(checkedRadios(doc), []);
  assert.equal(byId(doc, fixture.SSN_BOX_ID).value, '');
});

test('answers already on the page are never overwritten', () => {
  const answers = [
    ['hasSsn', doc => { radio(doc, 'hasSsn', 2).checked = true; }],
    ['usCitizen', doc => { radio(doc, 'usCitizen', 2).checked = true; }],
    ['hasDisability', doc => { radio(doc, 'hasDisability', 1).checked = true; }],
    ['hasMedicare', doc => { radio(doc, 'hasMedicare', 1).checked = true; }],
    ['birthDate', doc => { dob(doc).value = '01/01/1970'; }]
  ];
  for (const [key, answer] of answers) {
    const doc = page(); answer(doc);
    assert.deepEqual(fieldKeys(doc), FILLS.filter(item => item !== key), key);
    const stale = page(), bindings = adapter.scan(stale, fixture.URL).bindings; answer(stale);
    const before = key === 'birthDate' ? '01/01/1970' : checkedRadios(stale)[0];
    const result = fillAll(stale, bindings);
    assert.ok(result.skipped.includes(key) && !result.filled.includes(key), key);
    if (key === 'birthDate') assert.equal(dob(stale).value, before);
    else { assert.ok(byId(stale, before).checked, key); assert.equal(checkedRadios(stale).length, 4, key); }
  }
});

test('questions Iowa reveals after an answer stay for the applicant and the page stays verified', () => {
  const doc = page();
  // Iowa's script shows the Social Security number box and the name-on-card questions after Yes,
  // and "Were you born in the U.S.?" after a Yes to citizenship.
  radio(doc, 'hasSsn', 1).addEventListener('click', () => reveal(doc, ['question03', 'question04068', 'question04070', 'question04071', 'question04072']));
  radio(doc, 'usCitizen', 1).addEventListener('click', () => reveal(doc, ['question06181']));
  assert.deepEqual(fillAll(doc), { filled: FILLS, skipped: [] });
  assert.equal(byId(doc, fixture.SSN_BOX_ID).value, '');
  for (const id of ['answerSets0.answers12.answerValue', 'answerSets0.answers13.answerValue', 'answerSets0.answers14.answerValue']) assert.equal(byId(doc, id).value, '', id);
  assert.deepEqual(checkedRadios(doc), settled);
  assert.deepEqual(adapter.scan(doc, fixture.URL).fields, []);
  assert.equal(adapter.probePage(doc, fixture.URL).pageKey, PAGE_KEY);
});

test('follow-up questions Iowa shows, even from a disabled template, leave the page and its answers verified', () => {
  const doc = page();
  // Answering Female can show pregnancy and breastfeeding follow-ups, some from disabled templates.
  for (const id of ['question08008', 'question08107', 'question03261']) { byId(doc, id).classList.remove('hidden'); byId(doc, id).style.display = 'block'; }
  assert.deepEqual(fieldKeys(doc), FILLS);
  assert.deepEqual(fillAll(doc), { filled: FILLS, skipped: [] });
});

test('a click that changes whose page this is stops every later answer', () => {
  const doc = page();
  radio(doc, 'hasSsn', 1).addEventListener('click', () => { doc.querySelector('[title="People | Unvisited"]').title = 'People | Active'; });
  assert.deepEqual(fillAll(doc), { filled: ['birthDate', 'hasSsn'], skipped: ['usCitizen', 'hasDisability', 'hasMedicare'] });
  assert.deepEqual(checkedRadios(doc), [fixture.radioId(6, 1)]);
});

test('another URL, phase, person, form or template keeps the whole page manual', () => {
  const mutations = [
    doc => { doc.querySelector('[title="People | Unvisited"]').title = 'People | Active'; },
    doc => { doc.querySelector('[title="Start Application | Active"]').title = 'Start Application | Visited'; },
    doc => { doc.querySelector('li.current').className = 'visited'; },
    doc => { doc.querySelector('p.instructions').firstChild.data = 'Please give us additional information about this household member.'; },
    doc => { doc.querySelector('.htmlHeaderPageTitle').textContent = 'Tell Us About Another Person'; },
    doc => { doc.querySelector('h2').after(doc.querySelector('h2').cloneNode(true)); },
    doc => { doc.querySelector('form#answerSet').setAttribute('action', 'otherPerson'); },
    doc => { doc.querySelector('form#answerSet').method = 'get'; },
    doc => { doc.querySelector('form#answerSet').setAttribute('onsubmit', 'saveOtherPerson()'); },
    doc => { doc.querySelector('form#answerSet').setAttribute('target', '_blank'); },
    doc => { doc.querySelector('form#answerSet').after(Object.assign(doc.createElement('form'), { id: 'answerSet' })); },
    doc => { doc.querySelector('.peTaxInfoName').classList.remove('peTaxInfoName'); },
    doc => { doc.querySelector('.peTaxInfoName').after(doc.querySelector('.peTaxInfoName').cloneNode(true)); },
    doc => { doc.querySelector('.panel-group').prepend(doc.querySelector('.peTaxInfoName')); },
    doc => { doc.querySelector('.peTaxInfoName h3').textContent = ''; },
    doc => { doc.querySelector('.peTaxInfoName h3').remove(); },
    doc => { doc.querySelector('.panel-group').after(doc.createElement('div')); doc.querySelector('.panel-group + div').className = 'panel-group'; },
    doc => { doc.querySelector('.panel-group').append(Object.assign(doc.createElement('div'), { className: 'questionGroup interviewQuestion' })); },
    // Another template's date of birth on screen means another person or phase.
    doc => { byId(doc, 'question02419').style.display = 'block'; },
    doc => { const outside = doc.createElement('input'); outside.setAttribute('form', 'answerSet'); doc.body.append(outside); }
  ];
  for (const mutate of mutations) {
    const doc = page(); mutate(doc);
    assert.deepEqual(adapter.scan(doc, fixture.URL).fields, [], mutate.toString());
    assert.notEqual(adapter.probePage(doc, fixture.URL).pageKey, PAGE_KEY, mutate.toString());
  }
  // A change after the preview stops a fill already on its way.
  for (const mutate of mutations.slice(0, 3)) {
    const stale = page(), bindings = adapter.scan(stale, fixture.URL).bindings; mutate(stale);
    assert.deepEqual(fillAll(stale, bindings).filled, [], mutate.toString());
    assert.deepEqual(checkedRadios(stale), [], mutate.toString());
  }
  for (const url of [`${fixture.URL}?person=1`, `${fixture.URL}/`, fixture.URL.replace('dynamicQuestionsStart', 'dynamicQuestions'), fixture.URL.replace('hhsservices.iowa.gov', 'example.com'), fixture.URL.replace('https:', 'http:')]) {
    const doc = page(fixture.html, url);
    assert.deepEqual(adapter.scan(doc, url).fields, [], url);
    assert.notEqual(adapter.probePage(doc, url).pageKey, PAGE_KEY, url);
  }
  // The older Tell Us More layout is not this page either.
  assert.deepEqual(adapter.scan(page(oldFixture.html, fixture.URL), fixture.URL).fields, []);
});

test('a visible pop-up or protected heading stops the page', () => {
  const dialog = page(); dialog.querySelector('#customModalBox').classList.remove('modal');
  assert.deepEqual(adapter.scan(dialog, fixture.URL).fields, []); assert.equal(adapter.probePage(dialog, fixture.URL).kind, 'blocked');
  const signature = page(); signature.querySelector('.peTaxInfoName h3').textContent = 'E-Signature';
  assert.deepEqual(adapter.scan(signature, fixture.URL).fields, []); assert.notEqual(adapter.probePage(signature, fixture.URL).pageKey, PAGE_KEY);
});

test('a question that differs from the recorded page is left for the applicant while the others still fill', () => {
  const ssn = doc => radio(doc, 'hasSsn', 1);
  const mutations = [
    ['hasSsn', doc => { byId(doc, 'question02420').querySelector('legend span').firstChild.data = 'Does your spouse have a Social Security Number?'; }],
    ['hasSsn', doc => { ssn(doc).id = 'answerSets0.answers6.answerValue3'; }],
    ['hasSsn', doc => { ssn(doc).name = 'answerSets[1].answers[6].answerValue'; }],
    ['hasSsn', doc => { ssn(doc).setAttribute('value', 'Y'); }],
    ['hasSsn', doc => { ssn(doc).labels[0].textContent = 'Yes, for my child'; }],
    ['hasSsn', doc => { ssn(doc).setAttribute('onclick', 'saveSsn()'); }],
    ['hasSsn', doc => { ssn(doc).removeAttribute('onchange'); }],
    ['hasSsn', doc => { ssn(doc).setAttribute('onblur', 'saveSsn()'); }],
    ['hasSsn', doc => { ssn(doc).type = 'checkbox'; }],
    ['hasSsn', doc => { ssn(doc).disabled = true; }],
    ['hasSsn', doc => { ssn(doc).parentElement.append(Object.assign(ssn(doc).cloneNode(true), { id: 'third' })); }],
    ['hasSsn', doc => { byId(doc, 'question02420').classList.add('hidden'); }],
    ['hasSsn', doc => { byId(doc, 'question02420').classList.add('disabledQuestion'); }],
    // Another template's copy of the question on screen makes it ambiguous.
    ['hasSsn', doc => { byId(doc, 'question02421').style.display = 'block'; }],
    ['usCitizen', doc => { byId(doc, 'question06179').style.display = 'block'; }],
    ['usCitizen', doc => { radio(doc, 'usCitizen', 1).setAttribute('onclick', "hideShowQuestions('question0', this, '::6181|No:6181:|Yes::6181')"); }],
    ['hasDisability', doc => { radio(doc, 'hasDisability', 2).labels[0].textContent = 'Yes'; }],
    ['hasMedicare', doc => { byId(doc, 'question01000414').querySelector('legend span').firstChild.data = 'Does anyone else have Medicare?'; }],
    ['birthDate', doc => { dob(doc).title = 'dd/mm/yyyy'; }],
    ['birthDate', doc => { dob(doc).type = 'date'; }],
    ['birthDate', doc => { dob(doc).maxLength = 8; }],
    ['birthDate', doc => { dob(doc).setAttribute('onchange', 'save()'); }],
    ['birthDate', doc => { dob(doc).setAttribute('pattern', '.*'); }],
    ['birthDate', doc => { dob(doc).required = true; }],
    ['birthDate', doc => { dob(doc).classList.remove('date-format-class'); }],
    ['birthDate', doc => { dob(doc).name = 'answerSets[0].answers[3].answerValue'; }],
    ['birthDate', doc => { dob(doc).readOnly = true; }],
    ['birthDate', doc => { dob(doc).after(dob(doc).cloneNode(true)); }]
  ];
  for (const [key, mutate] of mutations) {
    const doc = page(); mutate(doc);
    assert.deepEqual(fieldKeys(doc), FILLS.filter(item => item !== key), mutate.toString());
    assert.equal(adapter.probePage(doc, fixture.URL).checklist.find(item => item.key === key)?.status ?? 'manual', 'manual', mutate.toString());
  }
  for (const [key, mutate] of [mutations[0], mutations.find(([key]) => key === 'birthDate')]) {
    const doc = page(); mutate(doc);
    assert.deepEqual(fillAll(doc).filled, FILLS.filter(item => item !== key), mutate.toString());
    if (key === 'birthDate') assert.equal(dob(doc).value, '');
    else assert.deepEqual(checkedRadios(doc), settled.slice(1));
  }
});

test('the private page fingerprint rejects a switched applicant, introduction, control or phase after the preview', () => {
  const everything = [
    doc => { doc.querySelector('.peTaxInfoName h3').textContent = 'Another Fictional Person'; },
    doc => { const heading = doc.querySelector('.peTaxInfoName h3'); heading.replaceWith(heading.cloneNode(true)); },
    doc => { doc.querySelector('p.instructions').append(' Changed explanation.'); },
    doc => { doc.querySelector('[title="People | Unvisited"]').title = 'People | Active'; }
  ];
  for (const mutate of everything) {
    const doc = page(), bindings = adapter.scan(doc, fixture.URL).bindings; mutate(doc);
    assert.deepEqual(fillAll(doc, bindings).filled, [], mutate.toString());
    assert.equal(dob(doc).value, ''); assert.deepEqual(checkedRadios(doc), []);
  }
  const replaced = page(), bindings = adapter.scan(replaced, fixture.URL).bindings;
  radio(replaced, 'usCitizen', 1).replaceWith(radio(replaced, 'usCitizen', 1).cloneNode(true));
  dob(replaced).replaceWith(dob(replaced).cloneNode(true));
  assert.deepEqual(fillAll(replaced, bindings), { filled: ['hasSsn', 'hasDisability', 'hasMedicare'], skipped: ['birthDate', 'usCitizen'] });
});

test('scrolling rechecks the page before each answer', () => {
  const doc = page(), target = radio(doc, 'hasMedicare', 2), bindings = adapter.scan(doc, fixture.URL).bindings;
  const original = target.getBoundingClientRect;
  target.getBoundingClientRect = () => ({ left: 20, top: 2000, right: 220, bottom: 2030, width: 200, height: 30 });
  target.scrollIntoView = () => { target.getBoundingClientRect = original; doc.querySelector('.peTaxInfoName h3').textContent = 'Different QA Applicant'; };
  assert.deepEqual(fillAll(doc, bindings), { filled: ['birthDate', 'hasSsn', 'usCitizen', 'hasDisability'], skipped: ['hasMedicare'] });
  assert.equal(target.checked, false);
});

test('checklist rows jump to their question, and answered questions show as done without their answers', () => {
  const doc = page();
  const targets = { gender: radio(doc, 'gender', 1), birthDate: dob(doc), hasSsn: radio(doc, 'hasSsn', 1), usCitizen: radio(doc, 'usCitizen', 1),
    maritalStatus: byId(doc, fixture.MARITAL_ID), militaryOrVeteran: radio(doc, 'militaryOrVeteran', 1), hasDisability: radio(doc, 'hasDisability', 1),
    blind: radio(doc, 'blind', 1), healthLimits: radio(doc, 'healthLimits', 1), hasMedicare: radio(doc, 'hasMedicare', 1) };
  for (const [key, element] of Object.entries(targets)) {
    assert.equal(adapter.focusField(doc, fixture.URL, key), true, key); assert.equal(doc.activeElement, element, key);
  }
  for (const key of ['startDetailsReview', 'ssn', 'firstName', 'question03']) assert.equal(adapter.focusField(doc, fixture.URL, key), false, key);
  assert.equal(adapter.focusField(doc, `${fixture.URL}?person=1`, 'birthDate'), false);
  radio(doc, 'gender', 2).checked = true;
  byId(doc, fixture.MARITAL_ID).value = 'Never Married';
  radio(doc, 'blind', 2).checked = true;
  const probe = adapter.probePage(doc, fixture.URL);
  assert.deepEqual(probe.checklist.filter(item => item.status === 'complete').map(item => item.key), ['gender', 'maritalStatus', 'blind']);
  assert.doesNotMatch(JSON.stringify(probe), /Female|Never Married/);
});

test('the older Tell Us More page keeps its own date-of-birth-only behavior', () => {
  const doc = page(oldFixture.html, oldFixture.URL);
  assert.deepEqual(adapter.scan(doc, oldFixture.URL).fields, [{ key: 'birthDate', label: 'Date of birth' }]);
  assert.equal(adapter.probePage(doc, oldFixture.URL).pageKey, 'iowa-self-details');
  assert.deepEqual(adapter.profileRequest('iowa-self-details'), ['birthDate']);
  assert.deepEqual(adapter.pageValues('iowa-self-details', saved), { birthDate: '1985-04-12' });
  assert.deepEqual(adapter.fill(doc, oldFixture.URL, adapter.scan(doc, oldFixture.URL).bindings, values()), { filled: ['birthDate'], skipped: [] });
});
