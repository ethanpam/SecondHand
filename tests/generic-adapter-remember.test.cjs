'use strict';
// #186: Remember for next time. After an Autofill, the side panel offers to keep the applicant's answer to a question the rules
// left open as a custom answer. The engine says which questions may be offered and which start unchecked because their answer
// changes over time, and reads one open question's answer only after the applicant's click.
const test = require('node:test');
const assert = require('node:assert/strict');
const generic = require('../extension/generic-adapter.js');
const { laidOut } = require('./helpers/harness.cjs');

const page = html => laidOut(html, 'https://pantry.example.org/intake');
const HEARD = { label: 'How did you hear about us?', type: 'radio', options: ['Friend', 'Church', 'Flyer'] };
const radio = (name, legend, options) => `<fieldset><legend>${legend}</legend>${options.map((option, index) => `<label><input type="radio" name="${name}" value="v${index}">${option}</label>`).join('')}</fieldset>`;
const box = (id, label, type = 'text') => `<label for="${id}">${label}</label><input id="${id}" type="${type}">`;
const open = (plan, label) => plan.unmatched.find(field => field.label === label);

test('Remember for next time is offered only for a question a custom answer may fill: never signatures, passwords, codes, uploads, payment details, or checkbox groups', () => {
  for (const field of [HEARD, { ...HEARD, type: 'select' }, ...['text', 'textarea', 'number', 'date', 'email', 'tel'].map(type => ({ label: 'EMPLID', type, options: [] }))]) {
    assert.equal(generic.canRemember(field), true, JSON.stringify(field));
  }
  for (const field of [{ label: 'Which apply to you?', type: 'checkbox', options: ['Veteran', 'Student'] }, { label: 'I am a veteran', type: 'checkbox', options: ['Yes', 'No'] },
    { label: 'Signature', type: 'text', options: [] }, { label: 'Type your initials', type: 'text', options: [] }, { label: 'Password', type: 'text', options: [] },
    { label: 'Enter the code we texted you', type: 'text', options: [] }, { label: 'Card number', type: 'tel', options: [] }, { label: 'Routing number', type: 'number', options: [] },
    { label: 'Spouse name', type: 'text', options: [] }, { label: 'Search', type: 'text', options: [] }, { label: 'Upload your ID', type: 'file', options: [] },
    { label: 'Q'.repeat(121), type: 'text', options: [] }, { ...HEARD, options: ['Friend', 'C'.repeat(121)] }, { label: 'Do you agree to the terms?', type: 'radio', options: ['Yes', 'No'] }]) {
    assert.equal(generic.canRemember(field), false, JSON.stringify(field).slice(0, 80));
  }
  // Uploads and passwords are never even planned.
  const plan = generic.plan(page(box('id-file', 'Upload your ID', 'file') + box('secret', 'Account password', 'password') + box('emplid', 'EMPLID')));
  assert.deepEqual(plan.unmatched.map(field => field.label), ['EMPLID']);
});

test('an answer that changes over time starts unchecked: dates, times, pickup and appointment days, and this week, this month or this visit', () => {
  const changes = [{ label: 'Date of your last visit', type: 'date', options: [] }, { label: 'Anything to tell us?', type: 'date', options: [] },
    { label: 'Preferred pickup day', type: 'select', options: ['Monday', 'Friday'] }, { label: 'Appointment time', type: 'text', options: [] },
    { label: 'Is this your first visit this month?', type: 'radio', options: ['Yes', 'No'] }, { label: 'How many times have you come this week?', type: 'number', options: [] },
    { label: 'Choose a slot', type: 'radio', options: ['9:00 AM', '1:30 PM'] }, { label: 'When can you come?', type: 'text', options: [] },
    { label: 'Fecha de hoy', type: 'text', options: [] }, { label: 'Is this visit for this week only?', type: 'radio', options: ['Yes', 'No'] }];
  for (const field of changes) assert.equal(generic.timeBound(field), true, field.label);
  for (const field of [HEARD, { label: 'EMPLID', type: 'text', options: [] }, { label: 'I am a veteran', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Preferred language', type: 'select', options: ['English', 'Spanish'] }, { label: 'May we text you?', type: 'radio', options: ['Yes', 'No'] }]) {
    assert.equal(generic.timeBound(field), false, field.label);
  }
});

test('after the click, one open question’s answer is read as the page shows it: a box’s words, or the chosen option’s own text', () => {
  const doc = page(box('emplid', 'EMPLID') + radio('heard', HEARD.label, HEARD.options) +
    '<label for="lang">Preferred language</label><select id="lang"><option value="">Choose one</option><option value="en">English</option><option value="es">Spanish</option></select>' +
    '<label for="notes">Anything else?</label><textarea id="notes"></textarea>' + box('first', 'First name') + box('sign', 'Signature'));
  const plan = generic.plan(doc);
  const ids = Object.fromEntries(['EMPLID', HEARD.label, 'Preferred language', 'Anything else?'].map(label => [label, open(plan, label).id]));
  const read = id => generic.readOpen(doc, plan.token, id);
  for (const id of Object.values(ids)) assert.deepEqual(read(id), { empty: true });
  doc.getElementById('emplid').value = '  SYN-4471 ';
  doc.querySelector('input[name="heard"][value="v1"]').checked = true;
  doc.getElementById('lang').value = 'es';
  doc.getElementById('notes').value = 'First line\nSecond line';
  assert.deepEqual(read(ids.EMPLID), { value: 'SYN-4471' });
  assert.deepEqual(read(ids[HEARD.label]), { value: 'Church' });
  assert.deepEqual(read(ids['Preferred language']), { value: 'Spanish' });
  assert.deepEqual(read(ids['Anything else?']), { value: 'First line\nSecond line' });
  // Never a question the rules matched, one no custom answer may fill, one from another plan, or an unknown one.
  assert.equal(read(plan.matched.find(field => field.key === 'firstName').id), null);
  assert.equal(read(open(plan, 'Signature')?.id ?? 'sh-0-0'), null);
  assert.equal(generic.readOpen(doc, 'plan-other', ids.EMPLID), null);
  assert.equal(read('sh-9-9'), null);
  doc.getElementById('emplid').value = 'x'.repeat(1001);
  assert.deepEqual(read(ids.EMPLID), { unreadable: true }, 'longer than a custom answer can be');
});

test('a question the page asks in more than one box is never read: which answer to keep can’t be told', () => {
  const doc = page(box('emplid', 'EMPLID') + box('emplid-2', 'Emplid:'));
  const plan = generic.plan(doc);
  doc.getElementById('emplid').value = 'SYN-4471';
  assert.deepEqual(generic.readOpen(doc, plan.token, plan.unmatched[0].id), { repeated: true });
});
