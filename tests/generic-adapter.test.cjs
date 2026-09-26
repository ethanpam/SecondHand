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
  assert.deepEqual(googleResult.matched.map(item => item.key), ['fullName', 'email', 'zip']);
  assert.equal(googleResult.unmatched.length, 0, 'div-based radio groups are not native controls and are left alone');
  const jot = page(forms.jotformStyle);
  const jotResult = generic.plan(jot);
  assert.deepEqual(byElement(jot, jotResult), { first_3: 'firstName', last_3: 'lastName', input_4: 'state', input_5: 'monthlyRent' });
  assert.deepEqual(jotResult.unmatched.map(field => field.label), ['Tell us about your situation']);
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

test('focus finds a planned field by its id and nothing else', () => {
  const doc = page(forms.plainPantry);
  const result = generic.plan(doc);
  assert.equal(generic.focusField(doc, result.unmatched[0].id), true);
  assert.equal(doc.activeElement.id, 'notes');
  assert.equal(generic.focusField(doc, 'input[type=password]'), false);
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
