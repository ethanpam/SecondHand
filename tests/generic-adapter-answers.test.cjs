'use strict';
// #42: the engine picks an option Laya chose from the saved profile. It fills the option with
// exactly that text, as a guess, and never overwrites, unchecks, or answers an unsafe question.
const test = require('node:test');
const assert = require('node:assert/strict');
const generic = require('../extension/generic-adapter.js');
const forms = require('./fixtures/pantry-forms.cjs');
const { laidOut } = require('./helpers/harness.cjs');

const page = html => laidOut(html, 'https://pantry.example.org/intake');
const open = (result, label) => result.unmatched.find(field => field.label === label);
const answer = (doc, result, label, option) => generic.fillFields(doc, result.token, [{ id: open(result, label).id, option, guessed: true }], {});
const sixty = '<fieldset><legend>Is anyone in your household 60 or older?</legend><label><input type="radio" name="sixty" value="y">Yes</label><label><input type="radio" name="sixty" value="n">No</label></fieldset>';
const size = '<label for="size">How many people live with you, counting yourself?</label><select id="size"><option value="">Choose one</option><option value="a">Just me</option><option value="b">2 to 4 people</option><option value="c">5 or more</option></select>';
const needs = '<fieldset><legend>Which of these describe your household?</legend><label><input type="checkbox" name="needs" value="s">Has someone 65 or older</label><label><input type="checkbox" name="needs" value="c">Has children under 18</label></fieldset>';

test('the chosen option of a radio group, dropdown, or checkbox group is filled as a guess, with no saved value sent', () => {
  const doc = page(sixty + size + needs);
  const result = generic.plan(doc);
  assert.deepEqual(result.unmatched.map(({ label, type, options }) => ({ label, type, options })), [
    { label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'How many people live with you, counting yourself?', type: 'select', options: ['Just me', '2 to 4 people', '5 or more'] },
    { label: 'Which of these describe your household?', type: 'checkbox', options: ['Has someone 65 or older', 'Has children under 18'] }]);
  const [radio, select, boxes] = result.unmatched.map(field => field.id);
  const filled = generic.fillFields(doc, result.token, [{ id: radio, option: 'No', guessed: true }, { id: select, option: 'Just me', guessed: true },
    { id: boxes, option: 'Has children under 18', guessed: true }], {});
  assert.deepEqual(filled.filled, [radio, select, boxes]);
  assert.equal(doc.querySelector('input[name="sixty"][value="n"]').checked, true);
  assert.equal(doc.querySelector('input[name="sixty"][value="y"]').checked, false);
  assert.equal(doc.getElementById('size').value, 'a');
  assert.deepEqual([...doc.querySelectorAll('input[name="needs"]')].map(box => box.checked), [false, true], 'only the chosen box is checked');
  assert.equal(doc.querySelector('input[name="sixty"][value="n"]').getAttribute('data-secondhand-filled'), 'guess');
  assert.equal(doc.getElementById('size').getAttribute('data-secondhand-filled'), 'guess');
  assert.equal(doc.querySelector('input[name="needs"][value="c"]').getAttribute('data-secondhand-filled'), 'guess');
});

test('an option is matched by its exact text only; missing or repeated text fills nothing', () => {
  for (const option of ['no', 'NO', ' No', 'Nope', '']) {
    const doc = page(sixty);
    const result = generic.plan(doc);
    assert.deepEqual(answer(doc, result, 'Is anyone in your household 60 or older?', option).filled, [], JSON.stringify(option));
    assert.equal(doc.querySelector('input:checked'), null);
  }
  const doc = page('<fieldset><legend>Pick one</legend><label><input type="radio" name="p" value="1">Yes</label><label><input type="radio" name="p" value="2">Yes</label></fieldset>');
  const result = generic.plan(doc);
  assert.deepEqual(answer(doc, result, 'Pick one', 'Yes').filled, []);
  assert.equal(doc.querySelector('input:checked'), null);
});

test('a question answered since the plan is never overwritten, and a box is never unchecked', () => {
  const doc = page(sixty + needs);
  const result = generic.plan(doc);
  doc.querySelector('input[name="sixty"][value="y"]').checked = true;
  doc.querySelector('input[name="needs"][value="s"]').checked = true;
  assert.deepEqual(answer(doc, result, 'Is anyone in your household 60 or older?', 'No').filled, []);
  assert.deepEqual(answer(doc, result, 'Which of these describe your household?', 'Has children under 18').filled, []);
  assert.equal(doc.querySelector('input[name="sixty"][value="y"]').checked, true);
  assert.deepEqual([...doc.querySelectorAll('input[name="needs"]')].map(box => box.checked), [true, false]);
  assert.equal(doc.querySelector('[data-secondhand-filled]'), null);
});

test('consent, agreement, and SSN questions are never answered, even when an answer arrives for them', () => {
  const doc = page('<fieldset><legend>Do you consent to share your information with partner agencies?</legend><label><input type="radio" name="c" value="y">Yes</label><label><input type="radio" name="c" value="n">No</label></fieldset>' +
    '<fieldset><legend>Pantry rules</legend><label><input type="radio" name="r" value="y">I agree</label><label><input type="radio" name="r" value="n">I do not agree</label></fieldset>');
  const result = generic.plan(doc);
  assert.equal(generic.unsafeQuestion(result.unmatched[0]), true);
  assert.equal(generic.unsafeQuestion(result.unmatched[1]), true);
  const filled = generic.fillFields(doc, result.token, result.unmatched.map(field => ({ id: field.id, option: field.options[0], guessed: true })), {});
  assert.deepEqual(filled.filled, []);
  assert.equal(doc.querySelector('input:checked'), null);
});

test('text boxes, a lone checkbox, div checkboxes, and listboxes never take an option; an assignment with both a key and an option is refused', () => {
  const doc = page('<label for="note">Anything else?</label><input id="note"><label><input type="checkbox" id="alone"> Deliver to my door</label>' + sixty);
  const result = generic.plan(doc);
  const filled = generic.fillFields(doc, result.token, [{ id: open(result, 'Anything else?').id, option: 'Yes', guessed: true },
    { id: open(result, 'Deliver to my door').id, option: 'Deliver to my door', guessed: true },
    { id: open(result, 'Is anyone in your household 60 or older?').id, key: 'anyoneSenior', option: 'No', guessed: true }], { anyoneSenior: 'no' });
  assert.deepEqual(filled.filled, []);
  assert.equal(doc.getElementById('note').value, '');
  assert.equal(doc.querySelector('input:checked'), null);
  const google = page(forms.googleChoices);
  const plan = generic.plan(google);
  const skipped = generic.fillFields(google, plan.token, [{ id: open(plan, 'Which items do you need?').id, option: 'Produce', guessed: true },
    { id: open(plan, 'County').id, option: 'Polk', guessed: true }], {});
  assert.deepEqual(skipped.filled, []);
  assert.equal(google.querySelector('[aria-checked="true"][aria-label="Produce"]'), null);
});

test('a Google Forms choice the page confirms a moment later is settled, then counted as a guess', async () => {
  const doc = page(forms.googleChoices);
  for (const option of doc.querySelectorAll('[role="radiogroup"] [role="radio"]')) {
    option.addEventListener('click', () => doc.defaultView.setTimeout(() => {
      for (const other of option.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')) other.setAttribute('aria-checked', String(other === option));
    }, 5));
  }
  const result = generic.plan(doc);
  const location = open(result, 'Which pantry location?');
  const filled = generic.fillFields(doc, result.token, [{ id: location.id, option: 'South', guessed: true }], {});
  assert.deepEqual(filled.pending, [location.id]);
  const settled = await generic.settle(doc, result.token, filled);
  assert.deepEqual(settled.filled, [location.id]);
  const south = doc.querySelector('[role="radio"][data-value="South"]');
  assert.equal(south.getAttribute('aria-checked'), 'true');
  assert.equal(south.getAttribute('data-secondhand-filled'), 'guess');
});

// #185: Laya's best guess, on a single-choice question it isn't sure of, has its own mark: a dotted outline, apart
// from a sure answer's dashed one.
test('Laya’s best guess on a radio group or dropdown is filled with its own mark and outline, apart from a sure answer’s', () => {
  const doc = page(sixty + size);
  const result = generic.plan(doc);
  const [radio, select] = result.unmatched.map(field => field.id);
  const filled = generic.fillFields(doc, result.token, [{ id: radio, option: 'No', guessed: true, layaGuess: true }, { id: select, option: 'Just me', guessed: true }], {});
  assert.deepEqual(filled.filled, [radio, select]);
  assert.deepEqual([...doc.querySelectorAll('input[name="sixty"]')].map(input => input.getAttribute('data-secondhand-filled')), ['laya-guess', 'laya-guess']);
  assert.equal(doc.getElementById('size').getAttribute('data-secondhand-filled'), 'guess', 'a sure answer keeps its mark');
  const style = doc.getElementById('secondhand-filled-style').textContent;
  assert.match(style, /\[data-secondhand-filled="laya-guess"\]\{outline:3px dotted #[0-9a-f]{6}!important;outline-offset:2px!important\}/);
  assert.match(style, /\[data-secondhand-filled="guess"\]\{outline:2px dashed #d99a2b!important/, 'the sure answer’s outline is unchanged');
});

test('a best guess is never put in a checkbox group or a question on Iowa’s portal', () => {
  const doc = page(needs);
  const result = generic.plan(doc);
  const filled = generic.fillFields(doc, result.token, [{ id: result.unmatched[0].id, option: 'Has children under 18', guessed: true, layaGuess: true }], {});
  assert.deepEqual(filled.filled, []);
  assert.equal(doc.querySelector('input:checked'), null);
  const iowa = laidOut(sixty + size, 'https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/financialInfo');
  const plan = generic.plan(iowa);
  const refused = generic.fillFields(iowa, plan.token, plan.unmatched.map(field => ({ id: field.id, option: field.options[1], guessed: true, layaGuess: true })), {});
  assert.deepEqual(refused.filled, []);
  assert.equal(iowa.querySelector('input:checked'), null);
  assert.equal(iowa.getElementById('size').value, '');
  const sure = generic.fillFields(iowa, plan.token, [{ id: plan.unmatched[0].id, option: 'No', guessed: true }], {});
  assert.deepEqual(sure.filled, [plan.unmatched[0].id], 'Laya’s sure answers still fill there');
});

test('a Google Forms choice Laya guessed is settled with its own mark, and every best guess can still be found once the page is planned again', async () => {
  const doc = page(forms.googleChoices + sixty);
  for (const option of doc.querySelectorAll('[role="radiogroup"] [role="radio"]')) {
    option.addEventListener('click', () => doc.defaultView.setTimeout(() => {
      for (const other of option.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')) other.setAttribute('aria-checked', String(other === option));
    }, 5));
  }
  const result = generic.plan(doc);
  const location = open(result, 'Which pantry location?');
  const radio = open(result, 'Is anyone in your household 60 or older?');
  const filled = generic.fillFields(doc, result.token, [{ id: location.id, option: 'South', guessed: true, layaGuess: true }, { id: radio.id, option: 'No', guessed: true, layaGuess: true }], {});
  const settled = await generic.settle(doc, result.token, filled);
  assert.deepEqual(settled.filled, [radio.id, location.id]);
  assert.equal(doc.querySelector('[role="radio"][data-value="South"]').getAttribute('data-secondhand-filled'), 'laya-guess');
  // The fill plans the page again; answered questions leave the plan, but the side panel's list still finds them.
  const again = generic.plan(doc);
  assert.equal(again.unmatched.some(field => field.id === radio.id || field.label === radio.label), false);
  assert.equal(generic.focusField(doc, radio.id), true);
  assert.ok(doc.querySelector('[data-secondhand-attention]'));
  assert.equal(generic.focusField(doc, location.id), true);
  assert.equal(generic.focusField(doc, 'sh-999-0'), false);
  const other = page(sixty);
  assert.equal(generic.focusField(other, radio.id), false, 'only in the page it was filled on');
});
