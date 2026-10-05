'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const fixture = require('./fixtures/iowa-tell-us-more.cjs');
const oldFixture = require('./fixtures/iowa-self-details.cjs');

const PAGE_KEY = 'iowa-tell-us-more';
// The questions on screen before any answer, in page order. Each fills from a saved answer.
const FILLS = ['gender', 'birthDate', 'hasSsn', 'usCitizen', 'maritalStatus', 'militaryOrVeteran', 'hasDisability', 'blind', 'healthLimits', 'hasMedicare'];
const RADIOS = FILLS.filter(key => !['birthDate', 'maritalStatus'].includes(key));
// Every answer saved in My information.
const saved = { sex: 'Female', birthDate: '1985-04-12', hasSsn: 'yes', ssnCardNameMatches: 'yes', usCitizen: 'yes', maritalStatus: 'Never Married',
  militaryOrVeteran: 'no', disabled: 'no', blind: 'no', healthLimitation: 'no', medicare: 'no' };
const values = (profile = saved) => adapter.pageValues(PAGE_KEY, profile);

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
const marital = doc => byId(doc, fixture.MARITAL_ID);
// option 1 is Yes (Male), option 2 is No (Female)
const radio = (doc, key, option) => byId(doc, fixture.radioId(fixture.ANSWERS[key], option));
// The option each saved answer picks.
const picked = { gender: 2, hasSsn: 1, ssnCardName: 1, usCitizen: 1, militaryOrVeteran: 2, hasDisability: 2, blind: 2, healthLimits: 2, hasMedicare: 2 };
const settled = (keys = RADIOS) => keys.map(key => fixture.radioId(fixture.ANSWERS[key], picked[key]));
const checkedRadios = doc => Array.from(doc.querySelectorAll('input[type="radio"]')).filter(element => element.checked).map(element => element.id);
const fieldKeys = doc => adapter.scan(doc, fixture.URL).fields.map(field => field.key);
const fillAll = (doc, bindings = adapter.scan(doc, fixture.URL).bindings, answers = values()) => adapter.fill(doc, fixture.URL, bindings, answers);
function reveal(doc, ids) {
  for (const id of ids) { const question = byId(doc, id); question.classList.remove('hidden'); question.style.display = ''; }
}
// The Social Security number box and the boxes for the name on the card.
const SSN_BOXES = [fixture.SSN_BOX_ID, 'answerSets0.answers12.answerValue', 'answerSets0.answers15.answerValue', 'answerSets0.answers16.answerValue'];

test('Tell Us More at dynamicQuestionsStart offers every question, and never Save and Continue', () => {
  const doc = page(), scan = adapter.scan(doc, fixture.URL), probe = adapter.probePage(doc, fixture.URL);
  assert.equal(scan.recognizedPage, true);
  assert.deepEqual(scan.fields, [
    { key: 'gender', label: 'Are you male or female?' }, { key: 'birthDate', label: 'Date of birth' },
    { key: 'hasSsn', label: 'Do you have a Social Security number?' }, { key: 'usCitizen', label: 'Are you a U.S. citizen or national?' },
    { key: 'maritalStatus', label: 'Marital status' }, { key: 'militaryOrVeteran', label: 'Are you in the military, a veteran, or a spouse of a veteran?' },
    { key: 'hasDisability', label: 'Are you disabled?' }, { key: 'blind', label: 'Are you blind?' },
    { key: 'healthLimits', label: 'Do you have a health condition that limits daily activities, or live in a medical facility or nursing home?' },
    { key: 'hasMedicare', label: 'Do you have Medicare?' }]);
  assert.equal(probe.kind, 'fillable'); assert.equal(probe.pageKey, PAGE_KEY); assert.equal(probe.heading, 'Tell Us More');
  assert.equal(probe.canAdvance, false);
  assert.deepEqual(probe.fields, scan.fields);
  assert.deepEqual(probe.checklist.map(item => [item.key, item.status]), [...FILLS.map(key => [key, 'missing']), ['startDetailsReview', 'manual']]);
  assert.deepEqual(probe.checklist.filter(item => item.fillable).map(item => item.key), FILLS);
  assert.equal(probe.requiredRemaining, 10); assert.equal(probe.manualRemaining, 1);
  assert.equal(probe.todo, 'Answer the remaining questions, then click Save and Continue in Iowa’s form yourself.');
  assert.equal(probe.reason, 'SecondHand can fill the answers you saved in My information on this page. Answer the other questions yourself, then click Save and Continue in Iowa’s form.');
  assert.doesNotMatch(JSON.stringify(probe), /Avery|Example|answerSets|question0/);
  assert.equal(adapter.captureNavigation(doc, fixture.URL), null);
  let clicked = 0; byId(doc, 'dqButtonId309').addEventListener('click', () => clicked++);
  fillAll(doc);
  assert.equal(adapter.advance(doc, fixture.URL, {}).advanced, false); assert.equal(adapter.continuePage(doc, fixture.URL).continued, false);
  assert.equal(clicked, 0);
});

test('each question maps to the applicant’s own saved answer, and the Social Security number itself is never asked for', () => {
  assert.deepEqual(adapter.profileRequest(PAGE_KEY), ['sex', 'birthDate', 'hasSsn', 'ssnCardNameMatches', 'usCitizen', 'householdAllCitizens', 'maritalStatus',
    'militaryOrVeteran', 'disabled', 'householdDisability', 'blind', 'healthLimitation', 'medicare', 'householdMedicare']);
  assert.deepEqual(values({ ...saved, ssn: '999-99-9999', hasSsnAnswer: 'yes', householdVeteran: 'no', firstName: 'Avery' }),
    { gender: 'Female', birthDate: '1985-04-12', hasSsn: 'yes', ssnCardName: 'yes', usCitizen: 'yes', maritalStatus: 'Never Married',
      militaryOrVeteran: 'no', hasDisability: 'no', blind: 'no', healthLimits: 'no', hasMedicare: 'no' });
  // Every one of Iowa's options is an answer.
  assert.deepEqual(values({ sex: 'Male', hasSsn: 'no', ssnCardNameMatches: 'no', usCitizen: 'no', maritalStatus: 'Married (includes common-law)',
    militaryOrVeteran: 'yes', disabled: 'yes', blind: 'yes', healthLimitation: 'yes', medicare: 'yes' }),
  { gender: 'Male', hasSsn: 'no', ssnCardName: 'no', usCitizen: 'no', maritalStatus: 'Married (includes common-law)',
    militaryOrVeteran: 'yes', hasDisability: 'yes', blind: 'yes', healthLimits: 'yes', hasMedicare: 'yes' });
  // Anything else is not an answer.
  assert.deepEqual(values({ sex: 'female', maritalStatus: 'Married', hasSsn: 'Y', usCitizen: 'true', blind: 'No', militaryOrVeteran: '' }), {});
  assert.deepEqual(values({}), {});
  assert.deepEqual(adapter.pageValues(PAGE_KEY, null), {});
});

test('a household answer settles a question only when the applicant saved none and it says exactly that', () => {
  const household = { householdAllCitizens: 'yes', householdDisability: 'no', householdMedicare: 'no' };
  assert.deepEqual(values(household), { usCitizen: 'yes', hasDisability: 'no', hasMedicare: 'no' });
  // The applicant's own answer comes first.
  assert.deepEqual(values({ ...household, usCitizen: 'no', disabled: 'yes', medicare: 'yes' }), { usCitizen: 'no', hasDisability: 'yes', hasMedicare: 'yes' });
  // A household "no" to citizenship, a "yes" to disability or Medicare, or a "no" to veterans (which says
  // nothing about "spouse of a veteran") leaves the question for the applicant.
  assert.deepEqual(values({ householdAllCitizens: 'no', householdDisability: 'yes', householdMedicare: 'yes', householdVeteran: 'no' }), {});
});

test('Autofill types the date of birth, picks the marital status and clicks each saved answer like a person, never the Social Security number', () => {
  const doc = page(), events = [];
  for (const element of doc.querySelectorAll('input[type="radio"]')) {
    for (const type of ['click', 'change']) element.addEventListener(type, () => events.push(`${type}:${element.id}`));
  }
  for (const type of ['input', 'change']) marital(doc).addEventListener(type, () => events.push(`${type}:${marital(doc).id}`));
  let typed = 0; dob(doc).addEventListener('change', () => typed++);
  assert.deepEqual(fillAll(doc), { filled: FILLS, skipped: [] });
  assert.equal(dob(doc).value, '04/12/1985'); assert.equal(typed, 1);
  assert.equal(marital(doc).value, 'Never Married');
  assert.deepEqual(checkedRadios(doc), settled());
  assert.deepEqual(events, FILLS.filter(key => key !== 'birthDate').flatMap(key => key === 'maritalStatus' ? [`input:${fixture.MARITAL_ID}`, `change:${fixture.MARITAL_ID}`]
    : [`click:${settled([key])[0]}`, `change:${settled([key])[0]}`]));
  // The hidden and disabled date-of-birth alternatives and the Social Security number box stay empty.
  for (const id of ['answerSets0.answers3.answerValue', 'answerSets0.answers4.answerValue', fixture.SSN_BOX_ID]) assert.equal(byId(doc, id).value, '', id);
  assert.deepEqual(adapter.scan(doc, fixture.URL).fields, []);
  const probe = adapter.probePage(doc, fixture.URL);
  assert.deepEqual(probe.checklist.filter(item => item.status === 'complete').map(item => item.key), FILLS);
  assert.equal(probe.requiredRemaining, 0); assert.equal(probe.canAdvance, false);
  assert.doesNotMatch(JSON.stringify(probe), /Female|Never Married|1985/);
});

test('with nothing saved, nothing is filled and every question stays open for the applicant', () => {
  const doc = page();
  assert.deepEqual(fillAll(doc, undefined, values({})), { filled: [], skipped: FILLS });
  assert.deepEqual(checkedRadios(doc), []);
  assert.equal(dob(doc).value, ''); assert.equal(marital(doc).value, '');
  assert.deepEqual(fieldKeys(doc), FILLS);
  assert.deepEqual(adapter.probePage(doc, fixture.URL).checklist.filter(item => item.status === 'missing').map(item => item.key), FILLS);
});

test('an answer that is not one of the question’s own options is never picked, even when handed straight to fill', () => {
  const doc = page();
  const result = fillAll(doc, undefined, { gender: 'female', birthDate: 'April 12', hasSsn: 'maybe', usCitizen: 'true', maritalStatus: 'Married',
    militaryOrVeteran: 'Yes', hasDisability: 'NO', blind: '', healthLimits: 'on', hasMedicare: 1, ssn: '999-99-9999' });
  assert.deepEqual(result, { filled: [], skipped: FILLS });
  assert.deepEqual(checkedRadios(doc), []);
  assert.equal(marital(doc).value, ''); assert.equal(dob(doc).value, '');
  assert.equal(byId(doc, fixture.SSN_BOX_ID).value, '');
});

test('answers already on the page are never overwritten', () => {
  const answers = [
    ['gender', doc => { radio(doc, 'gender', 1).checked = true; }],
    ['birthDate', doc => { dob(doc).value = '01/01/1970'; }],
    ['hasSsn', doc => { radio(doc, 'hasSsn', 2).checked = true; }],
    ['usCitizen', doc => { radio(doc, 'usCitizen', 2).checked = true; }],
    ['maritalStatus', doc => { marital(doc).value = 'Widowed'; }],
    ['militaryOrVeteran', doc => { radio(doc, 'militaryOrVeteran', 1).checked = true; }],
    ['hasDisability', doc => { radio(doc, 'hasDisability', 1).checked = true; }],
    ['blind', doc => { radio(doc, 'blind', 1).checked = true; }],
    ['healthLimits', doc => { radio(doc, 'healthLimits', 1).checked = true; }],
    ['hasMedicare', doc => { radio(doc, 'hasMedicare', 1).checked = true; }]
  ];
  for (const [key, answer] of answers) {
    const doc = page(); answer(doc);
    assert.deepEqual(fieldKeys(doc), FILLS.filter(item => item !== key), key);
    const stale = page(), bindings = adapter.scan(stale, fixture.URL).bindings; answer(stale);
    const before = checkedRadios(stale)[0];
    const result = fillAll(stale, bindings);
    assert.ok(result.skipped.includes(key) && !result.filled.includes(key), key);
    if (key === 'birthDate') assert.equal(dob(stale).value, '01/01/1970');
    else if (key === 'maritalStatus') assert.equal(marital(stale).value, 'Widowed');
    else assert.ok(byId(stale, before).checked, key);
    assert.equal(checkedRadios(stale).length, RADIOS.length, key);
  }
});

test('the Social Security card question Iowa shows after Yes fills from the saved answer on the next pass; the number and name boxes never do', () => {
  for (const [answer, option] of [['yes', 1], ['no', 2]]) {
    const doc = page();
    // Iowa's script shows the Social Security number box, the card name question and the name-on-card
    // boxes after Yes, and "Were you born in the U.S.?" after a Yes to citizenship.
    radio(doc, 'hasSsn', 1).addEventListener('click', () => reveal(doc, fixture.SSN_REVEALS));
    radio(doc, 'usCitizen', 1).addEventListener('click', () => reveal(doc, ['question06181']));
    const answers = values({ ...saved, ssnCardNameMatches: answer });
    assert.deepEqual(fillAll(doc, undefined, answers), { filled: FILLS, skipped: [] });
    // The next pass finds the question Iowa just showed, and nothing else.
    assert.deepEqual(adapter.scan(doc, fixture.URL).fields, [{ key: 'ssnCardName', label: 'Is your first and last name the same as on your Social Security card?' }]);
    const probe = adapter.probePage(doc, fixture.URL);
    assert.deepEqual(probe.checklist.slice(2, 5).map(item => [item.key, item.status]), [['hasSsn', 'complete'], ['ssnCardName', 'missing'], ['usCitizen', 'complete']]);
    assert.equal(probe.pageKey, PAGE_KEY);
    assert.deepEqual(fillAll(doc, undefined, answers), { filled: ['ssnCardName'], skipped: [] });
    assert.ok(radio(doc, 'ssnCardName', option).checked, answer);
    for (const id of SSN_BOXES) assert.equal(byId(doc, id).value, '', id);
    assert.equal(byId(doc, 'answerSets0.answers21.answerValue1').checked || byId(doc, 'answerSets0.answers21.answerValue2').checked, false);
    assert.deepEqual(adapter.scan(doc, fixture.URL).fields, []);
    assert.equal(adapter.probePage(doc, fixture.URL).checklist.find(item => item.key === 'ssnCardName').status, 'complete');
  }
  // Not saved: the question stays open for the applicant.
  const doc = page();
  radio(doc, 'hasSsn', 1).addEventListener('click', () => reveal(doc, fixture.SSN_REVEALS));
  const unsaved = values({ ...saved, ssnCardNameMatches: '' });
  assert.deepEqual(fillAll(doc, undefined, unsaved).filled, FILLS);
  assert.deepEqual(fillAll(doc, undefined, unsaved), { filled: [], skipped: ['ssnCardName'] });
  assert.equal(radio(doc, 'ssnCardName', 1).checked || radio(doc, 'ssnCardName', 2).checked, false);
  assert.deepEqual(fieldKeys(doc), ['ssnCardName']);
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
  assert.deepEqual(fillAll(doc), { filled: ['gender', 'birthDate', 'hasSsn'], skipped: FILLS.slice(3) });
  assert.deepEqual(checkedRadios(doc), settled(['gender', 'hasSsn']));
  assert.equal(marital(doc).value, '');
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
  // A change after the preview stops a fill already on its way: another person's block gets none of the applicant's answers.
  for (const mutate of mutations.slice(0, 3)) {
    const stale = page(), bindings = adapter.scan(stale, fixture.URL).bindings; mutate(stale);
    assert.deepEqual(fillAll(stale, bindings).filled, [], mutate.toString());
    assert.deepEqual(checkedRadios(stale), [], mutate.toString());
    assert.equal(marital(stale).value, '', mutate.toString()); assert.equal(dob(stale).value, '', mutate.toString());
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
    ['gender', doc => { radio(doc, 'gender', 2).setAttribute('value', 'F'); }],
    ['gender', doc => { byId(doc, 'question02418').querySelector('legend span').firstChild.data = 'Is your child male or female?'; }],
    ['usCitizen', doc => { byId(doc, 'question06179').style.display = 'block'; }],
    ['usCitizen', doc => { radio(doc, 'usCitizen', 1).setAttribute('onclick', "hideShowQuestions('question0', this, '::6181|No:6181:|Yes::6181')"); }],
    ['maritalStatus', doc => { marital(doc).options[4].textContent = 'Single'; }],
    ['maritalStatus', doc => { marital(doc).append(Object.assign(doc.createElement('option'), { value: 'Other', textContent: 'Other' })); }],
    ['maritalStatus', doc => { marital(doc).setAttribute('onchange', 'saveStatus()'); }],
    ['maritalStatus', doc => { byId(doc, 'question04').querySelector('label').firstChild.data = 'Spouse’s Marital Status '; }],
    ['militaryOrVeteran', doc => { radio(doc, 'militaryOrVeteran', 1).setAttribute('value', 'true'); }],
    ['hasDisability', doc => { radio(doc, 'hasDisability', 2).labels[0].textContent = 'Yes'; }],
    ['blind', doc => { byId(doc, 'question0565').querySelector('legend span').firstChild.data = 'Is anyone in your household blind?'; }],
    ['healthLimits', doc => { radio(doc, 'healthLimits', 2).labels[0].textContent = 'Yes'; }],
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
  for (const key of ['hasSsn', 'birthDate', 'maritalStatus']) {
    const doc = page(); mutations.find(([item]) => item === key)[1](doc);
    assert.deepEqual(fillAll(doc).filled, FILLS.filter(item => item !== key), key);
    if (key === 'birthDate') assert.equal(dob(doc).value, '');
    if (key === 'maritalStatus') assert.equal(marital(doc).value, '');
    assert.deepEqual(checkedRadios(doc), settled(RADIOS.filter(item => item !== key)), key);
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
    assert.equal(dob(doc).value, ''); assert.equal(marital(doc).value, ''); assert.deepEqual(checkedRadios(doc), []);
  }
  const replaced = page(), bindings = adapter.scan(replaced, fixture.URL).bindings;
  radio(replaced, 'usCitizen', 1).replaceWith(radio(replaced, 'usCitizen', 1).cloneNode(true));
  dob(replaced).replaceWith(dob(replaced).cloneNode(true));
  marital(replaced).replaceWith(marital(replaced).cloneNode(true));
  assert.deepEqual(fillAll(replaced, bindings), { filled: FILLS.filter(key => !['birthDate', 'usCitizen', 'maritalStatus'].includes(key)), skipped: ['birthDate', 'usCitizen', 'maritalStatus'] });
});

test('scrolling rechecks the page before each answer', () => {
  const doc = page(), target = radio(doc, 'hasMedicare', 2), bindings = adapter.scan(doc, fixture.URL).bindings;
  const original = target.getBoundingClientRect;
  target.getBoundingClientRect = () => ({ left: 20, top: 2000, right: 220, bottom: 2030, width: 200, height: 30 });
  target.scrollIntoView = () => { target.getBoundingClientRect = original; doc.querySelector('.peTaxInfoName h3').textContent = 'Different QA Applicant'; };
  assert.deepEqual(fillAll(doc, bindings), { filled: FILLS.filter(key => key !== 'hasMedicare'), skipped: ['hasMedicare'] });
  assert.equal(target.checked, false);
});

test('checklist rows jump to their question, and answered questions show as done without their answers', () => {
  const doc = page();
  reveal(doc, fixture.SSN_REVEALS);
  const targets = { gender: radio(doc, 'gender', 1), birthDate: dob(doc), hasSsn: radio(doc, 'hasSsn', 1), ssnCardName: radio(doc, 'ssnCardName', 1),
    usCitizen: radio(doc, 'usCitizen', 1), maritalStatus: marital(doc), militaryOrVeteran: radio(doc, 'militaryOrVeteran', 1), hasDisability: radio(doc, 'hasDisability', 1),
    blind: radio(doc, 'blind', 1), healthLimits: radio(doc, 'healthLimits', 1), hasMedicare: radio(doc, 'hasMedicare', 1) };
  for (const [key, element] of Object.entries(targets)) {
    assert.equal(adapter.focusField(doc, fixture.URL, key), true, key); assert.equal(doc.activeElement, element, key);
  }
  for (const key of ['startDetailsReview', 'ssn', 'firstName', 'question03']) assert.equal(adapter.focusField(doc, fixture.URL, key), false, key);
  assert.equal(adapter.focusField(doc, `${fixture.URL}?person=1`, 'birthDate'), false);
  radio(doc, 'gender', 2).checked = true;
  marital(doc).value = 'Never Married';
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
