'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const fixture = require('./fixtures/iowa-tell-us-more.cjs');
const keys = ['ssn', 'ssnCardFirstName', 'ssnCardMiddleName', 'ssnCardLastName'];
const ids = [fixture.SSN_BOX_ID, 'answerSets0.answers12.answerValue', 'answerSets0.answers15.answerValue', 'answerSets0.answers16.answerValue'];
const saved = { ssn: '123456789', ssnCardFirstName: 'Alex', ssnCardMiddleName: 'Taylor', ssnCardLastName: 'Sample' };
function page() {
  const doc = new JSDOM(fixture.html, { url: fixture.URL, pretendToBeVisual: true }).window.document;
  doc.defaultView.Element.prototype.getBoundingClientRect = () => ({ left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 });
  doc.defaultView.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  // Keep the recorded alternate controls in the capture; styles preserve their real hidden status.
  return doc;
}
function reveal(doc) {
  doc.getElementById(fixture.radioId(6, 1)).checked = true;
  doc.getElementById(fixture.radioId(11, 2)).checked = true;
  for (const id of fixture.SSN_REVEALS) { const node = doc.getElementById(id); node.classList.remove('hidden'); node.style.display = ''; }
}
const scan = doc => adapter.scan(doc, fixture.URL).bindings.filter(binding => keys.includes(binding.key));
const fill = (doc, bindings = scan(doc), values = saved) => adapter.fill(doc, fixture.URL, bindings, values);
const mirror = doc => doc.querySelector('[name="answerSets[0].answers[8].answerValue"]');

test('recorded visible card-name and SSN controls use only explicit separate saved values', () => {
  const doc = page(); reveal(doc);
  const bindings = scan(doc);
  assert.deepEqual(bindings.map(binding => binding.key), keys);
  let submitted = 0; doc.getElementById('dqButtonId309').addEventListener('click', () => submitted++);
  const events = []; doc.getElementById(ids[0]).addEventListener('input', () => events.push('input'));
  doc.getElementById(ids[0]).addEventListener('change', () => events.push('change'));
  assert.deepEqual(fill(doc, bindings), { filled: keys, skipped: [] });
  assert.deepEqual(ids.map(id => doc.getElementById(id).value), ['123-45-6789', 'Alex', 'Taylor', 'Sample']);
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(mirror(doc).value, '', 'never writes hidden submitted mirror');
  const probe = adapter.probePage(doc, fixture.URL);
  assert.equal(probe.checklist.find(row => row.key === 'ssn').status, 'manual');
  assert.equal(probe.canAdvance, false); assert.equal(submitted, 0);
  assert.doesNotMatch(JSON.stringify(probe), /123-45|Alex|Taylor|Sample/);
  for (const index of [9, 13, 14, 17]) assert.equal(doc.getElementById(`answerSets0.answers${index}.answerValue`).value, '');
  doc.defaultView.close();
});

test('hidden fields require a new scan and explicit parent answers; ordinary names never stand in for card names', () => {
  const doc = page(), before = scan(doc); assert.deepEqual(before, []);
  reveal(doc); assert.deepEqual(fill(doc, before), { filled: [], skipped: [] });
  const values = adapter.pageValues('iowa-tell-us-more', { firstName: 'Regular', middleName: 'Other', lastName: 'Applicant' });
  assert.deepEqual(fill(doc, undefined, values), { filled: [], skipped: keys });
  doc.getElementById(fixture.radioId(11, 2)).checked = false;
  assert.deepEqual(scan(doc).map(binding => binding.key), ['ssn']);
  doc.getElementById(fixture.radioId(6, 1)).checked = false;
  assert.deepEqual(scan(doc), []); doc.defaultView.close();
});

test('answers on either visible SSN or hidden mirror are preserved; no field overwrites later user input', () => {
  const doc = page(); reveal(doc); const bindings = scan(doc);
  mirror(doc).value = '321-54-9876';
  for (let index = 1; index < ids.length; index++) doc.getElementById(ids[index]).value = 'Existing';
  assert.deepEqual(fill(doc, bindings), { filled: [], skipped: keys });
  assert.equal(doc.getElementById(ids[0]).value, ''); assert.equal(mirror(doc).value, '321-54-9876');
  assert.deepEqual(scan(doc), []); doc.defaultView.close();
});

test('changed applicant identity, parents, label, mirror structure and duplicate templates invalidate sensitive bindings', () => {
  const mutations = [
    doc => { doc.querySelector('.peTaxInfoName h3').textContent = 'Different person'; },
    doc => { doc.querySelector('[title="People | Unvisited"]').title = 'People | Active'; },
    doc => { doc.getElementById(fixture.radioId(6, 2)).checked = true; },
    doc => { for (const id of fixture.SSN_REVEALS) doc.getElementById(id).style.display = 'none'; }
  ];
  for (const mutate of mutations) {
    const doc = page(); reveal(doc); const bindings = scan(doc); mutate(doc);
    assert.deepEqual(fill(doc, bindings), { filled: [], skipped: keys });
    assert.ok(ids.every(id => doc.getElementById(id).value === '')); doc.defaultView.close();
  }
  const doc = page(); reveal(doc); const bindings = scan(doc);
  doc.querySelector('[for="answerSets0.answers12.answerValue"]').textContent = 'Employer first name';
  doc.getElementById(ids[2]).after(doc.getElementById(ids[2]).cloneNode(true));
  mirror(doc).parentElement.style.display = '';
  doc.getElementById('question04072').classList.add('disabledQuestion');
  assert.deepEqual(fill(doc, bindings), { filled: [], skipped: keys }); doc.defaultView.close();
});

test('invalid numbers and overlong card names are never put into captured controls', () => {
  const doc = page(); reveal(doc);
  for (const value of ['000-12-3456', '666-12-3456', '999-12-3456', '123-00-3456', '123-12-0000', '12345678', '123 45 6789', 'maybe']) {
    assert.equal(adapter.formatValue('ssn', value, doc.getElementById(ids[0])), null);
  }
  assert.deepEqual(fill(doc, undefined, { ssn: '000123456', ssnCardFirstName: 'a'.repeat(101), ssnCardMiddleName: '', ssnCardLastName: 'x\nother' }), { filled: [], skipped: keys });
  doc.defaultView.close();
});

test('parent choices cannot hide or clear an existing SSN or card-name answer', () => {
  const doc = page();
  mirror(doc).value = '123-45-6789';
  const initial = adapter.scan(doc, fixture.URL);
  assert.equal(initial.fields.some(field => field.key === 'hasSsn'), false);
  reveal(doc);
  doc.getElementById(fixture.radioId(11, 2)).checked = false;
  doc.getElementById(ids[1]).value = 'Already typed';
  assert.equal(adapter.scan(doc, fixture.URL).fields.some(field => field.key === 'ssnCardName'), false);
  assert.equal(mirror(doc).value, '123-45-6789'); assert.equal(doc.getElementById(ids[1]).value, 'Already typed');
  doc.defaultView.close();
});
