'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const engine = require('../extension/generic-adapter.js');
const { layoutElements } = require('./helpers/harness.cjs');
function page(t, html) {
  const dom = new JSDOM(`<!doctype html><body>${html}`, { url: 'https://forms.example.test/application', pretendToBeVisual: true });
  t.after(() => dom.window.close()); layoutElements(dom.window); return dom.window.document;
}
function shadow(doc, html, host = doc.body.appendChild(doc.createElement('div')), mode = 'open') { const root = host.attachShadow({ mode }); root.innerHTML = html; return root; }
const fill = (doc, plan, values) => engine.fillFields(doc, plan.token, plan.matched.map(({ id, key }) => ({ id, key })), values);
function custom(doc, value, label) {
  const plan = engine.plan(doc), field = plan.unmatched.find(item => !label || item.label === label);
  assert.ok(field, `unmatched ${label || ''}`);
  return { plan, field, result: engine.fillFields(doc, plan.token, [{ id: field.id, custom: true }], { [field.id]: value }) };
}
const optionMarkup = '<div role="option" data-value="" aria-selected="true">Choose</div><div role="option" data-value="North" aria-selected="false">North</div><div role="option" data-value="South" aria-selected="false">South</div>';
function wireList(list, async = false) {
  for (const option of list.querySelectorAll('[role="option"]')) option.addEventListener('click', () => {
    const update = () => { for (const item of list.querySelectorAll('[role="option"]')) item.setAttribute('aria-selected', String(item === option)); };
    if (async) list.ownerDocument.defaultView.setTimeout(update, 2); else update();
  });
}

test('open shadow roots discover native fields and scope duplicate label ids and groups to each root', t => {
  const doc = page(t, '<span id="label">Signature</span>');
  const first = shadow(doc, '<span id="label">First name</span><input aria-labelledby="label"><fieldset><legend>Veteran status</legend><label><input type="radio" name="answer" value="yes">Yes</label><label><input type="radio" name="answer" value="no">No</label></fieldset>');
  const second = shadow(doc, '<span id="label">Last name</span><input aria-labelledby="label"><fieldset><legend>Veteran status</legend><label><input type="radio" name="answer" value="yes">Yes</label><label><input type="radio" name="answer" value="no">No</label></fieldset>');
  const plan = engine.plan(doc);
  assert.deepEqual(plan.matched.map(item => item.key), ['firstName', 'householdVeteran', 'lastName', 'householdVeteran']);
  assert.equal(fill(doc, plan, { firstName: 'Avery', lastName: 'Example', householdVeteran: 'no' }).filled.length, 4);
  assert.equal(first.querySelector('input').value, 'Avery'); assert.equal(second.querySelector('input').value, 'Example');
  assert.equal(first.querySelectorAll(':checked').length, 1); assert.equal(second.querySelectorAll(':checked').length, 1);
  assert.ok(first.querySelector('#secondhand-filled-style')); assert.ok(second.querySelector('#secondhand-filled-style'));
});

test('closed roots, hidden hosts, wrong-root references and ambiguous ids do not supply applicant fields', t => {
  const doc = page(t, '<span id="external">First name</span>');
  shadow(doc, '<label for="f">First name</label><input id="f">', undefined, 'closed');
  const hidden = doc.body.appendChild(doc.createElement('div')); hidden.hidden = true; shadow(doc, '<input autocomplete="given-name">', hidden);
  shadow(doc, '<input aria-labelledby="external">');
  shadow(doc, '<span id="duplicate">First name</span><span id="duplicate">Last name</span><input aria-labelledby="duplicate">');
  assert.deepEqual(engine.plan(doc).matched, []);
});

test('other-person scope above a shadow host blocks rules and explicit custom assignments', t => {
  const doc = page(t, '<fieldset><legend>Emergency contact</legend><div id="host"></div></fieldset>');
  const root = shadow(doc, '<label for="n">First name</label><input id="n"><label for="p">Favorite color</label><input id="p">', doc.getElementById('host'));
  const plan = engine.plan(doc); assert.deepEqual(plan.matched, []);
  for (const field of plan.unmatched) assert.equal(engine.canCustom(field), false);
  const result = engine.fillFields(doc, plan.token, plan.unmatched.map(({ id }) => ({ id, custom: true })), Object.fromEntries(plan.unmatched.map(({ id }) => [id, 'Blue'])));
  assert.deepEqual(result.filled, []); assert.equal(root.querySelector('input').value, '');
});

test('editable text boxes accept saved text, emit composed events, and never insert HTML', t => {
  const doc = page(t, ''); const root = shadow(doc, '<label for="name">Full name</label><div id="name" role="textbox" contenteditable="true"></div><div role="textbox" aria-label="Favorite quotation" contenteditable="plaintext-only"></div>');
  let events = 0; doc.addEventListener('input', () => events++);
  const plan = engine.plan(doc); assert.equal(plan.matched[0].key, 'fullName');
  assert.equal(fill(doc, plan, { fullName: 'Avery Example' }).filled.length, 1);
  const result = custom(doc, '<b>Be kind</b>').result; assert.equal(result.filled.length, 1);
  assert.equal(root.querySelector('[contenteditable="plaintext-only"]').textContent, '<b>Be kind</b>'); assert.equal(root.querySelector('b'), null); assert.equal(events, 2);
  assert.equal(engine.plan(doc).matched.length + engine.plan(doc).unmatched.length, 0);
});

test('readonly, nested interactive and already answered editable boxes are never overwritten', t => {
  const doc = page(t, '<div contenteditable="false" aria-label="Full name"></div><div contenteditable="true" aria-readonly="true" aria-label="Full name"></div><div contenteditable="true" aria-label="Full name"><input></div><div contenteditable="true" aria-label="Full name">Existing</div>');
  assert.equal(engine.plan(doc).matched.length, 0);
  assert.ok(engine.navigationFields(doc).some(field => !field.supported));
});

test('listboxes fill only a uniquely matching saved value and wait for the page to confirm selection', async t => {
  const doc = page(t, `<div role="listbox" aria-label="Favorite branch">${optionMarkup}</div>`); const list = doc.querySelector('[role="listbox"]'); wireList(list, true);
  const { plan, result } = custom(doc, 'South'); assert.equal(result.pending.length, 1);
  const settled = await engine.settle(doc, plan.token, result); assert.equal(settled.filled.length, 1); assert.equal(list.querySelector('[aria-selected="true"]').textContent, 'South');
  assert.equal(engine.navigationFields(doc)[0].answered, true);
});

test('a root-scoped combobox opens its exact popup and selects a saved option without typing or arbitrary keys', t => {
  const doc = page(t, '<div role="listbox" id="choices"><div role="option">Wrong root</div></div>');
  const root = shadow(doc, `<button type="button" role="combobox" aria-label="Favorite branch" aria-expanded="false" aria-controls="choices"></button><div role="listbox" id="choices" hidden>${optionMarkup}</div>`);
  const combo = root.querySelector('[role="combobox"]'), list = root.getElementById('choices'); wireList(list);
  combo.addEventListener('click', () => { list.hidden = false; combo.setAttribute('aria-expanded', 'true'); });
  assert.equal(engine.plan(doc).unmatched.filter(field => field.label === 'Favorite branch').length, 1);
  assert.equal(custom(doc, 'North', 'Favorite branch').result.filled.length, 1);
  assert.equal(list.querySelector('[aria-selected="true"]').textContent, 'North');
  const field = engine.navigationFields(doc).find(field => field.elements.includes(combo)); assert.ok(field.elements.includes(list)); assert.equal(field.answered, true);
});

test('saved standard values can match ARIA dropdowns and switches while Laya option assignments remain restricted', t => {
  const doc = page(t, '<div role="listbox" aria-label="County"><div role="option" data-value="Polk" aria-selected="false">Polk</div><div role="option" data-value="Story" aria-selected="false">Story</div></div><div role="switch" aria-label="Veteran status" aria-checked="false"></div>');
  wireList(doc.querySelector('[role="listbox"]'));
  const toggle = doc.querySelector('[role="switch"]'); toggle.addEventListener('click', () => toggle.setAttribute('aria-checked', 'true'));
  const plan = engine.plan(doc); assert.deepEqual(plan.matched.map(item => item.key), ['county', 'householdVeteran']);
  assert.equal(fill(doc, plan, { county: 'Polk', householdVeteran: 'yes' }).filled.length, 2);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
});

test('an explicit saved No completes a false ARIA toggle without clicking or treating an untouched toggle as No', t => {
  const doc = page(t, '<div role="checkbox" aria-label="Deliver to my door" aria-checked="false" aria-required="true"></div>');
  let clicks = 0; doc.querySelector('[role="checkbox"]').onclick = () => clicks++;
  assert.equal(engine.navigationFields(doc)[0].answered, false);
  assert.equal(custom(doc, 'No').result.filled.length, 1); assert.equal(clicks, 0); assert.equal(engine.navigationFields(doc)[0].answered, true);
});

test('custom checkbox groups choose one explicit matching option and preserve existing choices', t => {
  const doc = page(t, '<fieldset><legend>Preferred items</legend><div role="checkbox" aria-label="Produce" aria-checked="false"></div><div role="checkbox" aria-label="Dairy" aria-checked="false"></div></fieldset>');
  for (const box of doc.querySelectorAll('[role="checkbox"]')) box.onclick = () => box.setAttribute('aria-checked', 'true');
  assert.equal(custom(doc, 'Dairy').result.filled.length, 1);
  assert.equal(engine.plan(doc).unmatched.length, 0, 'partially answered group is preserved rather than extended');
});

for (const [name, mutation] of Object.entries({
  'changed label': doc => { doc.querySelector('label').textContent = 'Favorite animal'; },
  'changed type': doc => { doc.querySelector('input').type = 'password'; },
  'new answer': doc => { doc.querySelector('input').value = 'Already typed'; },
  'changed form owner': doc => { const form = doc.body.appendChild(doc.createElement('form')); form.append(doc.querySelector('input')); },
  'hidden field': doc => { doc.querySelector('input').hidden = true; },
  'changed person': doc => { doc.querySelector('legend').textContent = 'Spouse'; }
})) test(`custom preview refuses ${name}`, t => {
  const doc = page(t, '<form><fieldset><legend>Your preferences</legend><label for="color">Favorite color</label><input id="color"></fieldset></form>');
  const plan = engine.plan(doc), field = plan.unmatched[0]; mutation(doc);
  const result = engine.fillFields(doc, plan.token, [{ id: field.id, custom: true }], { [field.id]: 'Blue' }); assert.deepEqual(result.filled, []);
});

test('a custom assignment cannot override standard, sensitive, consent, login or another-person mapping', t => {
  for (const label of ['First name', 'Social Security number', 'I agree to these terms', 'Spouse favorite color', 'Password', 'Verification code']) {
    const doc = page(t, `<label for="field">${label}</label><input id="field">`), plan = engine.plan(doc), field = [...plan.matched, ...plan.unmatched][0];
    if (!field) continue;
    assert.deepEqual(engine.fillFields(doc, plan.token, [{ id: field.id, custom: true }], { [field.id]: 'Never insert' }).filled, [], label);
  }
  const doc = page(t, '<form><label for="a">Account email preference</label><input id="a"><input type="password"></form>');
  assert.deepEqual(custom(doc, 'No').result.filled, []);
});

test('custom text values respect length, number/date/email validity and do not change the stored answer object', t => {
  for (const [type, value, extra] of [['text', '12345', 'maxlength="4"'], ['number', 'five', ''], ['number', '12', 'max="10"'], ['email', 'not-an-email', ''], ['date', '2025-02-30', ''], ['text', 'x'.repeat(1001), '']]) {
    const doc = page(t, `<label for="value">Preferred detail</label><input id="value" type="${type}" ${extra}>`);
    assert.deepEqual(custom(doc, value).result.filled, [], `${type}: ${value.slice(0, 20)}`); assert.equal(doc.querySelector('input').value, '');
  }
  const doc = page(t, '<label for="value">Favorite color</label><input id="value">'), plan = engine.plan(doc), field = plan.unmatched[0], values = Object.freeze({ [field.id]: 'Blue' });
  assert.equal(engine.fillFields(doc, plan.token, [{ id: field.id, custom: true }], values).filled.length, 1); assert.equal(values[field.id], 'Blue');
});

test('duplicate, replaced, changed, disabled or preselected ARIA options never receive a saved answer', t => {
  for (const variant of ['duplicate', 'replace', 'changed', 'disabled', 'preselected', 'missing-state']) {
    const doc = page(t, `<div role="listbox" aria-label="Favorite branch">${optionMarkup}</div>`), list = doc.querySelector('[role="listbox"]'), plan = engine.plan(doc), field = plan.unmatched[0];
    const north = list.querySelector('[data-value="North"]');
    if (variant === 'duplicate') list.append(north.cloneNode(true));
    if (variant === 'replace') north.replaceWith(north.cloneNode(true));
    if (variant === 'changed') north.setAttribute('data-value', 'Elsewhere');
    if (variant === 'disabled') north.setAttribute('aria-disabled', 'true');
    if (variant === 'preselected') north.setAttribute('aria-selected', 'true');
    if (variant === 'missing-state') north.removeAttribute('aria-selected');
    wireList(list);
    assert.deepEqual(engine.fillFields(doc, plan.token, [{ id: field.id, custom: true }], { [field.id]: 'North' }).filled, [], variant);
  }
});

test('navigation metadata contains no values and identifies unsupported widgets and protected questions', t => {
  const doc = page(t, '<label for="a">First name</label><input id="a" value="PRIVATE"><div role="slider" aria-label="Score"></div><label for="s">Signature</label><input id="s">');
  const fields = engine.navigationFields(doc);
  assert.ok(fields.some(field => field.answered && field.supported && field.safe));
  assert.ok(fields.some(field => !field.supported)); assert.ok(fields.some(field => field.supported && !field.safe));
  assert.ok(fields.every(field => Object.keys(field).sort().join() === 'answered,elements,required,safe,supported'));
});

test('multiline saved answers are permitted only in textarea or multiline contenteditable', t => {
  const value = 'First line\nSecond line\twith a tab';
  for (const markup of ['<textarea aria-label="Biography"></textarea>', '<div contenteditable="true" role="textbox" aria-label="Biography"></div>']) {
    const doc = page(t, markup); assert.equal(custom(doc, value).result.filled.length, 1);
  }
  for (const markup of ['<input aria-label="Biography">', '<div contenteditable="true" role="textbox" aria-multiline="false" aria-label="Biography"></div>']) {
    const doc = page(t, markup); assert.deepEqual(custom(doc, value).result.filled, []);
  }
  const doc = page(t, '<textarea aria-label="Biography"></textarea>'); assert.deepEqual(custom(doc, 'Invisible\u202Etext').result.filled, []);
});

test('explicit custom native select/radio/checkbox answers match uniquely and respect disabled choices', t => {
  for (const markup of [
    '<select aria-label="Favorite branch"><option value=""></option><option value="north">North</option><option value="south">South</option></select>',
    '<fieldset><legend>Favorite branch</legend><label><input type="radio" name="branch" value="north">North</label><label><input type="radio" name="branch" value="south">South</label></fieldset>',
    '<fieldset><legend>Favorite branch</legend><label><input type="checkbox" name="branch" value="north">North</label><label><input type="checkbox" name="branch" value="south">South</label></fieldset>'
  ]) { const doc = page(t, markup); assert.equal(custom(doc, 'South').result.filled.length, 1); }
  const disabled = page(t, '<select aria-label="Favorite branch"><option value=""></option><option value="north" disabled>North</option></select>'); assert.deepEqual(custom(disabled, 'North').result.filled, []);
  for (const value of ['Yes', 'No']) {
    const doc = page(t, '<label><input type="checkbox">Deliver to my door</label>');
    const result = custom(doc, value); assert.deepEqual(result.field.options, ['Yes', 'No']); assert.equal(result.result.filled.length, 1); assert.equal(doc.querySelector('input').checked, value === 'Yes'); assert.equal(engine.navigationFields(doc)[0].answered, true);
  }
});

test('opening a combobox cannot replace its question or options before selecting a saved answer', t => {
  for (const variant of ['label', 'options', 'no-open']) {
    const doc = page(t, `<button role="combobox" aria-label="Favorite branch" aria-expanded="false" aria-controls="choices"></button><div id="choices" role="listbox" hidden>${optionMarkup}</div>`);
    const combo = doc.querySelector('[role="combobox"]'), list = doc.getElementById('choices'); let selected = 0;
    combo.onclick = () => {
      if (variant === 'no-open') return;
      list.hidden = false; combo.setAttribute('aria-expanded', 'true');
      if (variant === 'label') combo.setAttribute('aria-label', 'Emergency contact branch');
      if (variant === 'options') list.innerHTML = optionMarkup;
    };
    list.onclick = () => selected++;
    assert.deepEqual(custom(doc, 'North').result.filled, [], variant); assert.equal(selected, 0);
  }
});

test('a confirmed asynchronous custom option does not finalize under a replaced preview', async t => {
  const doc = page(t, `<div role="listbox" aria-label="Favorite branch">${optionMarkup}</div>`); const list = doc.querySelector('[role="listbox"]'); wireList(list, true);
  const { plan, result } = custom(doc, 'North'); const settled = engine.settle(doc, plan.token, result, { timeoutMs: 20 }); engine.plan(doc);
  assert.deepEqual((await settled).filled, []);
});

test('preselected native multiselect answers are preserved even when its first selected value is blank', t => {
  const doc = page(t, '<select multiple aria-label="Favorite branch"><option value="" selected>Choose</option><option value="north" selected>North</option><option value="south">South</option></select>');
  assert.deepEqual(engine.plan(doc).unmatched, []);
});

test('banking, payment and recovery-secret custom questions remain protected despite a direct assignment', t => {
  for (const label of ['Bank account number', 'Routing number', 'Billing details', 'Recovery phrase', 'API key', 'Cardholder']) {
    const doc = page(t, `<label for="detail">${label}</label><input id="detail">`), plan = engine.plan(doc), field = plan.unmatched[0];
    assert.equal(engine.canCustom(field), false, label);
    assert.deepEqual(engine.fillFields(doc, plan.token, [{ id: field.id, custom: true }], { [field.id]: 'Never place' }).filled, [], label);
  }
  const doc = page(t, '<div role="textbox" contenteditable="true" id="cardholder" aria-label="Full name"></div>'), plan = engine.plan(doc);
  assert.deepEqual(fill(doc, plan, { fullName: 'Never place' }).filled, []);
});

test('wrapping labels never expose filled editable text in subsequent question metadata', t => {
  const doc = page(t, '<label for="bio">Biography<div id="bio" role="textbox" contenteditable="true"></div></label>');
  const secret = 'Synthetic saved detail must stay private';
  assert.equal(custom(doc, secret).result.filled.length, 1);
  const questions = engine.questions(doc); assert.equal(questions[0].label, 'Biography');
  assert.equal(JSON.stringify(questions).includes(secret), false); assert.equal(JSON.stringify(engine.plan(doc)).includes(secret), false);
});
