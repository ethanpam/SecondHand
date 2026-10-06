'use strict';
// Failing-first tests for GitHub issues #24, #25, #26, #27, #29 (live-form QA findings).
const test = require('node:test');
const assert = require('node:assert/strict');
const generic = require('../extension/generic-adapter.js');
const { laidOut } = require('./helpers/harness.cjs');

// Every node has a visible box. Opacity still comes from styles.
const page = html => laidOut(html, 'https://pantry.example.org/intake');
const keysOf = result => result.matched.map(item => item.key);
const fillAll = (doc, result, profile) => generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })), generic.deriveValues(profile));

test('#24 Jotform custom radios (native input hidden with opacity:0, visible label) are planned and filled', () => {
  const doc = page(`<li class="form-line"><label class="form-label" id="label_9">Is anyone in your household a veteran?</label>
    <div class="form-single-column" role="radiogroup" aria-labelledby="label_9">
      <span class="form-radio-item"><input type="radio" class="form-radio" id="input_9_0" name="q9_veteran" value="Yes" style="opacity:0"><label for="input_9_0">Yes</label></span>
      <span class="form-radio-item"><input type="radio" class="form-radio" id="input_9_1" name="q9_veteran" value="No" style="opacity:0"><label for="input_9_1">No</label></span>
    </div></li>`);
  const result = generic.plan(doc);
  assert.deepEqual(keysOf(result), ['householdVeteran']);
  const filled = fillAll(doc, result, { householdVeteran: 'no' });
  assert.equal(doc.getElementById('input_9_1').checked, true);
  assert.equal(doc.getElementById('input_9_0').checked, false);
  assert.equal(filled.filled.length, 1);
});

test('#24 an opacity:0 radio whose labels are also hidden stays out of the plan', () => {
  const doc = page(`<fieldset style="opacity:0"><legend>Is anyone in your household a veteran?</legend>
    <label><input type="radio" name="vet" value="y" style="opacity:0"> Yes</label><label><input type="radio" name="vet" value="n" style="opacity:0"> No</label></fieldset>`);
  const result = generic.plan(doc);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.unmatched, []);
});

test('#25 a phone question using input type=number is planned and filled with digits only', () => {
  const doc = page('<label for="p">Phone Number*</label><input id="p" name="q4_phone" type="number">');
  const result = generic.plan(doc);
  assert.deepEqual(keysOf(result), ['phone']);
  fillAll(doc, result, { mobilePhone: '2025550148' });
  assert.equal(doc.getElementById('p').value, '2025550148');
});

test('#26 household size questions with trailing wording and parentheticals are matched', () => {
  const doc = page('<label for="h">How many people in your household might you share this food with (including yourself)?</label><input id="h" type="number">');
  const result = generic.plan(doc);
  assert.deepEqual(keysOf(result), ['householdSize']);
  fillAll(doc, result, { householdSize: '3' });
  assert.equal(doc.getElementById('h').value, '3');
});

test('#27 a value the site rejects after blur is cleared and reported, not counted as filled', () => {
  const doc = page('<ul><li class="form-line" id="line"><label for="e">Email Address*</label><input id="e" type="email"></li>' +
    '<li class="form-line"><label for="z">ZIP Code</label><input id="z"></li></ul>');
  const email = doc.getElementById('e');
  email.addEventListener('blur', () => { if (/@example\.invalid$/.test(email.value)) doc.getElementById('line').classList.add('form-line-error'); });
  const result = generic.plan(doc);
  const emailId = result.matched.find(item => item.key === 'email').id;
  const filled = fillAll(doc, result, { email: 'avery.example@example.invalid', zip: '50309' });
  assert.deepEqual(filled.rejected, [emailId]);
  assert.equal(filled.filled.includes(emailId), false);
  assert.equal(email.value, '', 'a rejected value is removed so it is never submitted');
  assert.equal(doc.getElementById('z').value, '50309');
});

test('#27 aria-invalid set by the page after blur also counts as rejected', () => {
  const doc = page('<label for="e">Email</label><input id="e" type="email">');
  const email = doc.getElementById('e');
  email.addEventListener('blur', () => email.setAttribute('aria-invalid', 'true'));
  const result = generic.plan(doc);
  const filled = fillAll(doc, result, { email: 'avery.example@example.invalid' });
  assert.equal(filled.rejected.length, 1);
  assert.equal(email.value, '');
});

test('#29 age-range choices are answered from the saved birth date', () => {
  const doc = page(`<fieldset><legend>What is your age range?</legend>
    <label><input type="radio" name="age" value="a"> 18-29 yrs</label><label><input type="radio" name="age" value="b"> 30-64 yrs</label><label><input type="radio" name="age" value="c"> 65+ yrs</label></fieldset>`);
  const result = generic.plan(doc);
  assert.deepEqual(keysOf(result), ['ageRange']);
  assert.deepEqual(generic.requestKeys(['ageRange']), ['birthDate']);
  fillAll(doc, result, { birthDate: '1985-04-12' });
  assert.equal(doc.querySelector('input[value="b"]').checked, true);
  const unknown = page(`<fieldset><legend>What is your age range?</legend><label><input type="radio" name="age" value="a"> 18-29</label><label><input type="radio" name="age" value="b"> 30-64</label></fieldset>`);
  const planned = generic.plan(unknown);
  assert.equal(fillAll(unknown, planned, {}).filled.length, 0, 'no birth date, nothing chosen');
});

test('#26 household questions about a subgroup are never answered with the whole household size', () => {
  for (const label of ['How many people in your household are over 65?', 'How many people in your household are children under 18?',
    'How many people in your household are veterans?', 'How many people in your household work?']) {
    const doc = page(`<label for="q">${label}</label><input id="q" type="number">`);
    assert.equal(keysOf(generic.plan(doc)).includes('householdSize'), false, label);
  }
});

test('#24 Jotform choice labels marked aria-hidden still show the choice (live SFU pantry markup)', () => {
  const item = (n, value) => `<span class="form-radio-item"><span class="dragger-item"></span><input type="radio" class="form-radio validate[required]" id="input_34_${n}" name="q34_whatIs" aria-labelledby="label_input_34_${n}" value="${value}" style="opacity:0"><label aria-hidden="true" id="label_input_34_${n}" for="input_34_${n}">${value}</label></span>`;
  const doc = page(`<li class="form-line jf-required" data-type="control_radio" id="id_34"><span class="form-label form-label-top" id="label_34"> What is your age range?<span class="form-required" aria-hidden="true">*</span> </span>
    <div id="cid_34" class="form-input-wide jf-required"><div class="form-single-column" role="radiogroup" aria-required="true" aria-labelledby="label_34">
    ${['0-5 yrs', '6-12 yrs', '13-19 yrs', '20-29 yrs', '30-64 yrs', '65+ yrs', 'Unknown'].map((value, n) => item(n, value)).join('')}</div></div></li>`);
  const result = generic.plan(doc);
  assert.deepEqual(keysOf(result), ['ageRange']);
  fillAll(doc, result, { birthDate: '1985-04-12' });
  assert.equal(doc.getElementById('input_34_4').checked, true, '30-64 yrs');
});

test('#24 an aria-hidden group of choices stays out of the plan', () => {
  const doc = page(`<fieldset aria-hidden="true"><legend>Is anyone in your household a veteran?</legend>
    <label><input type="radio" name="vet" value="y"> Yes</label><label><input type="radio" name="vet" value="n"> No</label></fieldset>`);
  assert.deepEqual(generic.plan(doc).matched, []);
});

// Google Forms marks a div radio checked a few milliseconds after the click, in its own task.
function googleCount(doc, { selects = true } = {}) {
  const group = doc.querySelector('[role=radiogroup]');
  for (const option of group.querySelectorAll('[role=radio]')) {
    option.addEventListener('click', () => { if (selects) setTimeout(() => {
      group.querySelectorAll('[role=radio]').forEach(other => other.setAttribute('aria-checked', String(other === option)));
    }, 5); });
  }
}
const googleHousehold = `<div role="listitem"><div role="heading" id="q">Number of Family / Household Members</div>
  <div role="radiogroup" aria-labelledby="q">${['One (Myself)', 'Two', 'Three', 'Four', 'Five or more'].map(label =>
    `<div role="radio" aria-checked="false" aria-label="${label}" data-value="${label}" tabindex="0"><span>${label}</span></div>`).join('')}</div></div>`;

test('a Google Forms choice that the page checks a moment after the click is settled and counted', async () => {
  const doc = page(googleHousehold);
  googleCount(doc);
  const result = generic.plan(doc);
  assert.deepEqual(keysOf(result), ['householdSize']);
  const id = result.matched[0].id;
  const filled = fillAll(doc, result, { householdSize: '3' });
  assert.deepEqual(filled.filled, [], 'not counted before the page confirms it');
  assert.deepEqual(filled.pending, [id]);
  const settled = await generic.settle(doc, result.token, filled);
  assert.deepEqual(settled.filled, [id]);
  assert.deepEqual(settled.pending, []);
  assert.equal(doc.querySelector('[aria-label="Three"]').getAttribute('aria-checked'), 'true');
  assert.equal(doc.querySelector('[aria-label="Three"]').getAttribute('data-secondhand-filled'), 'rule');
});

test('a Google Forms choice the page never checks is reported as skipped after settling, not filled', async () => {
  const doc = page(googleHousehold);
  googleCount(doc, { selects: false });
  const result = generic.plan(doc);
  const id = result.matched[0].id;
  const settled = await generic.settle(doc, result.token, fillAll(doc, result, { householdSize: '3' }), { timeoutMs: 60 });
  assert.deepEqual(settled.filled, []);
  assert.deepEqual(settled.skipped, [id]);
  assert.equal(doc.querySelector('[data-secondhand-filled]'), null);
});

test('settling a fill with nothing pending returns it unchanged', async () => {
  const doc = page('<label for="z">ZIP Code</label><input id="z">');
  const result = generic.plan(doc);
  const filled = fillAll(doc, result, { zip: '50309' });
  assert.deepEqual(filled.pending, []);
  assert.deepEqual(await generic.settle(doc, result.token, filled), filled);
});
