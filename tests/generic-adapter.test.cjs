'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const generic = require('../extension/generic-adapter.js');
const forms = require('./fixtures/pantry-forms.cjs');

// jsdom has no layout: give every node a visible box.
function page(html, url = 'https://pantry.example.org/intake') {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url, pretendToBeVisual: true });
  const { document } = dom.window;
  const box = { left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 };
  for (const node of document.querySelectorAll('*')) { node.getBoundingClientRect = () => box; node.getClientRects = () => [box]; }
  return document;
}
const byElement = (doc, result) => Object.fromEntries(result.matched.map(item => [generic.elementFor(item.id)?.id || generic.elementFor(item.id)?.name || item.id, item.key]));
const profile = {
  firstName: 'Avery', middleName: 'Jordan', lastName: 'Example', birthDate: '1985-04-12', email: 'avery.example@example.invalid',
  mobilePhone: '2025550148', homePhone: '2025550147', addressLine1: '123 Test Way', addressLine2: 'Unit 4', city: 'Demo City', state: 'IA', zip: '50309',
  householdSize: '3', householdAdults: '2', householdChildren: '1', householdSeniors: '0', householdVeteran: 'no', householdDisability: 'yes',
  monthlyEarnedIncome: '900', monthlyOtherIncome: '100', monthlyRent: '800', monthlyUtilities: '150'
};

test('a plain pantry intake form maps every common question to the saved profile', () => {
  const doc = page(forms.plainPantry);
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), {
    fname: 'firstName', lname: 'lastName', dob: 'birthDate', addr: 'addressLine1', city: 'city', st: 'state', zip: 'zip',
    phone: 'phone', email: 'email', hh: 'householdSize', adults: 'householdAdults', kids: 'householdChildren', seniors: 'householdSeniors',
    vet: 'householdVeteran', income: 'totalMonthlyIncome'
  });
  assert.ok(result.matched.every(item => item.confidence === 'high'));
  assert.deepEqual(result.unmatched.map(field => field.label), ['Anything else we should know?']);
  assert.equal(typeof result.token, 'string');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Create a password|Card number/, 'password and card fields are never scanned');
});

test('Google Forms and Jotform layouts map through aria-labelledby, autocomplete, sub-labels, and questions', () => {
  const google = page(forms.googleStyle);
  const googleResult = generic.plan(google);
  assert.deepEqual(googleResult.matched.map(item => item.key), ['fullName', 'email', 'zip', 'householdSize']);
  assert.equal(googleResult.unmatched.length, 0);
  const jot = page(forms.jotformStyle);
  const jotResult = generic.plan(jot);
  assert.deepEqual(byElement(jot, jotResult), { first_3: 'firstName', last_3: 'lastName', input_4: 'state', input_5: 'monthlyRent' });
  assert.deepEqual(jotResult.unmatched.map(field => field.label), ['Tell us about your situation']);
});

test('numbered and run-together questions match once the number is dropped and words are split', () => {
  const doc = page(forms.numberedGoogle);
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { email: 'email', phone: 'phone', zip: 'zip', dob: 'birthDate', city: 'city' });
  assert.deepEqual(result.unmatched.map(field => field.label), ['6. U.S. citizen?']);
});

test('"first and last name" and guardian names are full names; asides in parentheses are dropped unless they change who is asked', () => {
  const labels = ['2. Guardian first and last name', 'Full Name (First and Last Name) *', 'Parent/Guardian First and Last Name', 'First & last name',
    'Phone (optional)', 'Last name (spouse)', 'Name (of your pet)', 'Phone (work)', 'Guardian phone'];
  const doc = page(labels.map((label, index) => `<label for="f${index}">${label}</label><input id="f${index}">`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { f0: 'fullName', f1: 'fullName', f2: 'fullName', f3: 'fullName', f4: 'phone' });
  assert.deepEqual(result.unmatched.map(field => field.label), ['Last name (spouse)', 'Name (of your pet)', 'Phone (work)', 'Guardian phone']);
});

test('a generic date or time sub-label is read together with its question, and birth dates go only to birth questions', () => {
  const doc = page(forms.googleDates);
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { dob: 'birthDate' });
  assert.deepEqual(result.unmatched.map(field => field.label),
    ['5.Date ordered: Date', 'Pickup time: Hour', 'Pickup time: Minute', 'Birthday: Month', 'Birthday: Day', 'Birthday: Year']);
  for (const label of ['5.Date ordered: Date', 'Birthday: Month', 'Month of birth', 'Child’s date of birth', 'Date'])
    assert.equal(generic.canSuggest('birthDate', { label }), false, label);
  for (const label of ['Your birthday', 'Date of birth (MM/DD/YYYY)']) assert.equal(generic.canSuggest('birthDate', { label }), true, label);
  assert.equal(generic.canSuggest('email', { label: 'Date' }), true);
  assert.equal(generic.canSuggest('password', { label: 'Password' }), false);
  // A guessed birth date is never placed in a question that is not about birth.
  const ordered = result.unmatched.find(field => field.label.startsWith('5.'));
  const month = result.unmatched.find(field => field.label === 'Birthday: Month');
  const dob = result.matched.find(item => item.key === 'birthDate');
  const filled = generic.fillFields(doc, result.token, [{ id: ordered.id, key: 'birthDate', guessed: true }, { id: month.id, key: 'birthDate', guessed: false },
    { id: dob.id, key: 'birthDate', guessed: false }], generic.deriveValues(profile));
  assert.deepEqual(filled.filled, [dob.id]);
  assert.equal(doc.getElementById('ordered').value, '');
  assert.equal(doc.getElementById('month').value, '');
  assert.equal(doc.getElementById('dob').value, '1985-04-12');
});

// Google registers a choice when its div[role=radio] is clicked; this stands in for its script.
function googleClicks(doc) {
  const clicks = [];
  for (const option of doc.querySelectorAll('[role="radiogroup"] [role="radio"]')) {
    option.addEventListener('click', () => {
      clicks.push(option.getAttribute('data-value'));
      for (const other of option.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')) other.setAttribute('aria-checked', String(other === option));
    });
  }
  return clicks;
}

test('Google Forms choice questions are planned, counted as need-you, and filled by clicking the matching option', () => {
  const doc = page(forms.googleChoices);
  const clicks = googleClicks(doc);
  const result = generic.plan(doc);
  assert.deepEqual(result.matched.map(item => item.key), ['householdSize', 'householdVeteran']);
  assert.deepEqual(result.unmatched.map(({ label, type, options, required }) => ({ label, type, options, required })), [
    { label: 'Which pantry location?', type: 'radio', options: ['North', 'South'], required: true },
    { label: 'Which items do you need?', type: 'checkbox', options: ['Produce', 'Dairy'], required: true },
    { label: 'County', type: 'listbox', options: ['Polk', 'Story'], required: true }
  ], 'an answered question is not planned; the rest wait for the applicant');
  const filled = generic.fillFields(doc, result.token, [...result.matched.map(({ id, key }) => ({ id, key, guessed: false })),
    ...result.unmatched.map(({ id }) => ({ id, key: 'county', guessed: true }))], generic.deriveValues({ ...profile, county: 'Polk' }));
  assert.deepEqual(filled.filled, result.matched.map(item => item.id));
  assert.deepEqual(clicks, ['Three', 'No'], 'only the matching options are clicked; the answered question is never touched');
  const checkedIn = heading => [...doc.getElementById(heading).parentElement.querySelectorAll('[aria-checked="true"]')].map(option => option.getAttribute('data-value'));
  assert.deepEqual(checkedIn('c1'), ['Three']);
  assert.deepEqual(checkedIn('c4'), ['Yes']);
  assert.equal(doc.querySelector('[role="listbox"] [aria-selected="true"]').getAttribute('data-value'), '');
});

test('number words and "or more" choices pick the right count; a click Google ignores is not reported as filled', () => {
  const pick = size => {
    const doc = page(forms.googleChoices);
    googleClicks(doc);
    const result = generic.plan(doc);
    const size_ = result.matched.find(item => item.key === 'householdSize');
    generic.fillFields(doc, result.token, [{ id: size_.id, key: 'householdSize', guessed: false }], { householdSize: size });
    return [...doc.querySelectorAll('#c1 ~ [role="radiogroup"] [aria-checked="true"]')].map(option => option.getAttribute('data-value'));
  };
  assert.deepEqual(pick('1'), ['One (Myself)']);
  assert.deepEqual(pick('5'), ['Five or more']);
  assert.deepEqual(pick('8'), ['Five or more']);
  assert.deepEqual(pick('0'), [], 'no option means zero people');
  const doc = page(forms.googleChoices);
  const result = generic.plan(doc);
  const filled = generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })), generic.deriveValues(profile));
  assert.deepEqual(filled.filled, [], 'without Google registering the click, nothing counts as filled');
});

test('age-band household questions map only when the band is exactly what the profile counts', () => {
  const questions = {
    kids017: '# of people in your household 0 - 17 yrs old', kidsUnder18: 'Number of children under 18', kidsAges: 'Number of household members ages 0 to 17',
    adults1864: 'Number of adults (18-64)', adultsPeople: 'How many people in your household are 18 to 64 years old', seniors65: 'Number of seniors (65+)',
    seniorsOlder: 'How many people 65 or older live in your household', seniorsAdults: 'Number of adults 65 and older',
    band1859: '# of people in your household 18 - 59 yrs old', band60: '# of people in your household 60 + yrs', seniors60: 'Number of seniors (60+)',
    kids05: '# of Children 0-5 years old', kids618: '# of Children 6-18 years old', adults18: 'Adults 18+', kidsUnder5: 'Number of children (under 5)'
  };
  const doc = page(Object.entries(questions).map(([id, label]) => `<label for="${id}">${label}</label><input id="${id}" type="number">`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { kids017: 'householdChildren', kidsUnder18: 'householdChildren', kidsAges: 'householdChildren',
    adults1864: 'householdAdults', adultsPeople: 'householdAdults', seniors65: 'householdSeniors', seniorsOlder: 'householdSeniors', seniorsAdults: 'householdSeniors' });
  assert.deepEqual(result.unmatched.map(field => field.label), [questions.band1859, questions.band60, questions.seniors60, questions.kids05, questions.kids618,
    questions.adults18, questions.kidsUnder5]);
});

test('only confident matches are planned; vague labels stay unmatched for the applicant', () => {
  const doc = page('<label for="a">Name of your pet</label><input id="a"><label for="b">Emergency contact phone</label><input id="b" type="tel"><label for="c">Income last year from your side business</label><input id="c">');
  const result = generic.plan(doc);
  assert.deepEqual(result.matched, []);
  assert.equal(result.unmatched.length, 3);
});

test('requested profile fields and derived answers cover composite questions', () => {
  assert.deepEqual(generic.requestKeys(['fullName', 'phone', 'totalMonthlyIncome', 'zip', 'zip']).sort(),
    ['firstName', 'homePhone', 'lastName', 'mobilePhone', 'monthlyEarnedIncome', 'monthlyOtherIncome', 'phone', 'zip'].sort());
  const values = generic.deriveValues(profile);
  assert.equal(values.fullName, 'Avery Example');
  assert.equal(values.phone, '2025550148', 'mobile first, then home, then reference phone');
  assert.equal(values.totalMonthlyIncome, '1000');
  assert.equal(values.annualIncome, '12000');
  assert.equal(generic.deriveValues({ monthlyEarnedIncome: '900' }).totalMonthlyIncome, undefined, 'a partial income is never presented as the total');
  for (const key of generic.GENERIC_KEYS) assert.equal(typeof key, 'string');
  assert.ok(generic.GENERIC_KEYS.includes('householdVeteran'));
});

test('filling writes each supported control type, fires events, and outlines what it filled', () => {
  const doc = page(forms.plainPantry);
  const events = [];
  doc.addEventListener('input', event => events.push(`input:${event.target.id || event.target.name}`), true);
  doc.addEventListener('change', event => events.push(`change:${event.target.id || event.target.name}`), true);
  const result = generic.plan(doc);
  const assignments = result.matched.map(({ id, key }) => ({ id, key, guessed: key === 'householdSeniors' }));
  const filled = generic.fillFields(doc, result.token, assignments, generic.deriveValues(profile));
  assert.equal(filled.ok, true);
  assert.equal(filled.filled.length, result.matched.length);
  const value = id => doc.getElementById(id).value;
  assert.equal(value('fname'), 'Avery'); assert.equal(value('dob'), '1985-04-12'); assert.equal(value('st'), 'IA');
  assert.equal(value('phone'), '(202) 555-0148'); assert.equal(value('hh'), '3'); assert.equal(value('seniors'), '0');
  assert.equal(value('income'), '1000');
  assert.equal(doc.querySelector('input[name="vet"][value="n"]').checked, true);
  assert.equal(doc.querySelector('input[name="vet"][value="y"]').checked, false);
  assert.ok(events.includes('input:fname') && events.includes('change:fname'));
  assert.equal(doc.getElementById('fname').getAttribute('data-secondhand-filled'), 'rule');
  assert.equal(doc.getElementById('seniors').getAttribute('data-secondhand-filled'), 'guess');
  assert.equal(value('pw'), ''); assert.equal(value('card'), ''); assert.equal(value('notes'), '');
});

test('text dates, state names, and pre-filled answers are handled without overwriting', () => {
  const doc = page('<label for="d">Birthday</label><input id="d"><label for="s">State</label><select id="s"><option value=""></option><option value="Iowa">Iowa</option><option value="Minnesota">Minnesota</option></select><label for="c">City</label><input id="c" value="Already typed">');
  const result = generic.plan(doc);
  assert.deepEqual(result.matched.map(item => item.key), ['birthDate', 'state'], 'a field that already has an answer is not planned');
  const filled = generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })), generic.deriveValues(profile));
  assert.equal(doc.getElementById('d').value, '04/12/1985');
  assert.equal(doc.getElementById('s').value, 'Iowa');
  assert.equal(doc.getElementById('c').value, 'Already typed');
  assert.equal(filled.filled.length, 2);
});

test('a stale plan, an unknown key, or a field changed since planning is never filled', () => {
  const doc = page(forms.plainPantry);
  const first = generic.plan(doc);
  const second = generic.plan(doc);
  const assignments = first.matched.map(({ id, key }) => ({ id, key, guessed: false }));
  assert.equal(generic.fillFields(doc, first.token, assignments, generic.deriveValues(profile)).ok, false, 'only the latest plan can fill');
  const fname = second.matched.find(item => item.key === 'firstName');
  doc.getElementById('fname').value = 'Typed by the applicant';
  const result = generic.fillFields(doc, second.token, [{ id: fname.id, key: 'firstName', guessed: false }, { id: fname.id, key: 'password', guessed: true }], generic.deriveValues(profile));
  assert.deepEqual(result.filled, []);
  assert.equal(doc.getElementById('fname').value, 'Typed by the applicant');
});

// Records scrolls and focus changes; jsdom has no scrolling of its own.
function watchAttention(doc) {
  const seen = { scrolled: [], focus: [] };
  doc.defaultView.HTMLElement.prototype.scrollIntoView = function () { seen.scrolled.push(this); };
  for (const type of ['focus', 'blur']) doc.addEventListener(type, event => seen.focus.push(`${type}:${event.target.id}`), true);
  return seen;
}
const highlighted = doc => [...doc.querySelectorAll('[data-secondhand-attention]')];

test('showing a need-you field scrolls to its question and highlights it without moving keyboard focus', () => {
  const doc = page(forms.plainPantry);
  const seen = watchAttention(doc);
  const result = generic.plan(doc);
  assert.equal(generic.focusField(doc, result.unmatched[0].id), true);
  assert.deepEqual(highlighted(doc), [doc.getElementById('notes')]);
  assert.deepEqual(seen.scrolled, [doc.getElementById('notes')]);
  assert.equal(doc.activeElement, doc.body, 'keyboard focus stays where it was');
  assert.deepEqual(seen.focus, []);
  assert.match(doc.getElementById('secondhand-filled-style').textContent, /\[data-secondhand-attention\]/);
  doc.getElementById('notes').dispatchEvent(new doc.defaultView.FocusEvent('focusin', { bubbles: true }));
  assert.deepEqual(highlighted(doc), [], 'the highlight goes away once the applicant is in the question');
  assert.equal(generic.focusField(doc, 'input[type=password]'), false);
});

test('on Google Forms the whole question card is shown, one at a time, and no required check is triggered', () => {
  const doc = page(forms.googleChoices);
  const seen = watchAttention(doc);
  const result = generic.plan(doc);
  const card = heading => doc.getElementById(heading).closest('[role="listitem"]');
  const [location, items] = result.unmatched;
  assert.equal(generic.focusField(doc, location.id), true);
  assert.deepEqual(highlighted(doc), [card('c3')]);
  assert.equal(generic.focusField(doc, items.id), true);
  assert.deepEqual(highlighted(doc), [card('c5')], 'the previous question is no longer highlighted');
  assert.deepEqual(seen.scrolled, [card('c3'), card('c5')]);
  assert.deepEqual(seen.focus, [], 'nothing is focused or blurred, so Google never flags a skipped question');
  const dates = page(forms.googleDates);
  watchAttention(dates);
  const hour = generic.plan(dates).unmatched.find(field => field.label === 'Pickup time: Hour');
  assert.equal(generic.focusField(dates, hour.id), true);
  assert.deepEqual(highlighted(dates), [dates.getElementById('hour')], 'a question with several boxes highlights only the one asked about');
});

test('counts fill number dropdowns and "or more" choices; a yes/no checkbox is only ever checked for yes', () => {
  const doc = page(`<label for="size">Household size</label><select id="size"><option value="">Pick</option><option>1</option><option>2</option><option>3</option><option value="4">4+</option></select>
    <fieldset><legend>How many children?</legend><label><input type="radio" name="kids" value="0">0</label><label><input type="radio" name="kids" value="1">1</label><label><input type="radio" name="kids" value="2">2 or more</label></fieldset>
    <label><input type="checkbox" id="vet" name="vet"> Veteran</label><label><input type="checkbox" id="dis" name="dis"> Disability</label>`);
  const result = generic.plan(doc);
  assert.deepEqual(result.matched.map(item => item.key), ['householdSize', 'householdChildren', 'householdVeteran', 'householdDisability']);
  const filled = generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })),
    generic.deriveValues({ householdSize: '6', householdChildren: '3', householdVeteran: 'no', householdDisability: 'yes' }));
  assert.equal(doc.getElementById('size').value, '4', '6 people picks the 4+ choice');
  assert.equal(doc.querySelector('input[name="kids"][value="2"]').checked, true, '3 children picks "2 or more"');
  assert.equal(doc.getElementById('vet').checked, false, 'No is never expressed by checking a box');
  assert.equal(doc.getElementById('dis').checked, true);
  assert.equal(filled.filled.length, 3);
});

test('the AI mapper can only suggest keys the rules engine knows how to fill', () => {
  const ai = require('../extension/ai-mapper.js');
  assert.deepEqual([...ai.ALLOWED_KEYS].sort(), [...generic.GENERIC_KEYS].sort());
});
