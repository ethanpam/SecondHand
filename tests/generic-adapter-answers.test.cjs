'use strict';
// #42: the engine picks an option Laya chose from the saved profile. It fills the option with
// exactly that text, as a guess, and never overwrites, unchecks, or answers an unsafe question.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const generic = require('../extension/generic-adapter.js');
const forms = require('./fixtures/pantry-forms.cjs');

// jsdom has no layout: give every node a visible box.
function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'https://pantry.example.org/intake', pretendToBeVisual: true });
  const { document } = dom.window;
  const box = { left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 };
  for (const node of document.querySelectorAll('*')) { node.getBoundingClientRect = () => box; node.getClientRects = () => [box]; }
  return document;
}
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
