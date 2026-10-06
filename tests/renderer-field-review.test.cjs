'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { PROFILE_FIELDS, FIELD_LABELS } = require('../shared/schema.cjs');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const script = ['../shared/snap-information.js', '../renderer/snap-information.js', '../renderer/app.js'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fixture = () => ({ cancelled: false, document: {
  name: 'fictional-review.pdf', pageCount: 1,
  pages: [{ pageNumber: 1, text: 'RAW SYNTHETIC TEXT MUST NOT ENTER FIELD REVIEW', confidence: 86, words: [] }],
  analysis: { title: 'Synthetic tax return', taxYear: '2024', fields: [
    { id: 'primary-name', label: 'First name', value: 'Avery', profileKey: 'firstName', confidence: 86, page: 1, sourceLabel: 'Your first name and middle initial', sourceRole: 'applicant' },
    { id: 'taxLine1a', label: 'Annual wages', value: '50000', confidence: 91, page: 1, sourceRole: 'document' },
    { id: 'spouseFirstName', label: 'Spouse first name', value: 'Example Spouse', confidence: 80, page: 1, sourceLabel: "Spouse's first name", sourceRole: 'spouse' }
  ], warnings: [] }
} });
const response = request => ({
  profile: PROFILE_FIELDS.map(key => ({ key, label: FIELD_LABELS[key], status: request.profile[key] ? 'format-passed' : 'empty', messages: [] })),
  document: (request.documentFields || []).map((field, index) => ({ id: field.id || `document-${index}`, key: field.profileKey || `document.${index}`, label: field.label, status: 'check-source', messages: ['Compare this detail with the original.'] })),
  laya: { state: 'not-requested', message: 'Rules only. Laya was not requested.' }
});

async function renderer(t, { available = true } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://secondhand.invalid/' });
  t.after(() => dom.window.close());
  const window = dom.window;
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const requests = [], saves = [], reads = [], cancels = [];
  let locked, profileChanged;
  let status = { exists: true, unlocked: true, lockRevision: 0, extensionId: '', bridgeRunning: true };
  let profile = { firstName: 'Existing', lastName: 'Person', birthDate: '1985-04-12', email: 'draft@example.invalid', householdMembers: [] };
  window.secondHand = {
    status: async () => status, getData: async () => ({ profile: structuredClone(profile), applications: [] }), setupProgress: async () => null,
    onLocked: callback => { locked = callback; return () => {}; }, onUnlocked: () => () => {},
    onProfileChanged: callback => { profileChanged = callback; return () => {}; },
    unlock: async () => { status = { ...status, unlocked: true }; return status; },
    saveProfile: async value => { saves.push(structuredClone(value)); profile = structuredClone(value); return structuredClone(value); },
    readDocument: () => { const read = deferred(); reads.push(read); return read.promise; },
    cancelDocumentRead: async () => true, onDocumentProgress: () => () => {},
    ...(available ? { reviewFields: request => { const completion = deferred(); requests.push({ request: structuredClone(request), ...completion }); return completion.promise; },
      cancelFieldReview: async () => { cancels.push(true); return true; } } : {})
  };
  window.eval(script); await tick();
  const get = id => window.document.getElementById(id);
  const navigate = view => window.document.querySelector(`.nav-item[data-view="${view}"]`).click();
  return { window, get, navigate, requests, saves, reads, cancels,
    edit(control, value) { const input = typeof control === 'string' ? get(control) : control; input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); },
    async read(value = fixture()) { navigate('documents'); get('read-document').click(); reads.at(-1).resolve(value); await tick(); },
    async finish(index = requests.length - 1, value = response(requests[index].request)) { requests[index].resolve(value); await tick(); },
    async lock() { status = { ...status, unlocked: false, lockRevision: status.lockRevision + 1 }; locked({ lockRevision: status.lockRevision }); await tick(); },
    async unlock() { get('passphrase').value = 'synthetic-password'; get('auth-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); },
    changed(fields) { profileChanged({ fields }); },
    submit() { get('profile-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
  };
}

test('profile checking sends the complete draft and household, renders accessible adjacent advice, and never changes or saves answers', async t => {
  const view = await renderer(t); view.navigate('profile');
  view.edit('email', 'unfinished@');
  view.get('add-household-member').click();
  const member = view.get('household-members').querySelector('[data-self="false"]');
  view.edit(member.querySelector('[data-member-field="firstName"]'), 'Casey');
  view.get('check-profile-fields').click();
  const request = view.requests[0].request;
  assert.equal(request.useLaya, false);
  assert.deepEqual(Object.keys(request.profile).sort(), [...PROFILE_FIELDS].sort());
  assert.equal(request.profile.email, 'unfinished@');
  assert.equal(request.profile.householdMembers[1].firstName, 'Casey');
  assert.equal(view.get('save-profile').disabled, false);
  const result = response(request);
  result.profile.find(field => field.key === 'email').status = 'needs-review';
  result.profile.find(field => field.key === 'email').messages = ['<img src=x onerror=alert(1)> Check the address.'];
  Object.assign(result.profile.find(field => field.key === 'householdMembers'), { status: 'check-source', messages: ['Check who shares food.'] });
  result.profile.push({ key: 'householdMembers.1.firstName', label: 'Person 2 first name', status: 'format-passed', messages: [] });
  await view.finish(0, result);
  assert.equal(view.window.document.querySelectorAll('.field-review-result[data-review-scope="profile"]').length, PROFILE_FIELDS.length + 1);
  assert.match(view.get('profile-review-summary').textContent, /1 need review · 1 need a source check/);
  const note = view.get(view.get('email').getAttribute('aria-describedby'));
  assert.ok(note.closest('.field').contains(view.get('email')));
  assert.match(note.textContent, /<img src=x/);
  assert.equal(note.querySelector('img'), null);
  assert.ok(member.querySelector('[data-member-field="firstName"]').hasAttribute('aria-describedby'));
  const radio = view.get('profile-form').elements.namedItem('usCitizen')[0];
  assert.ok(radio.hasAttribute('aria-describedby'), 'Radio answers also have adjacent accessible status.');
  assert.equal(view.get('email').value, 'unfinished@');
  assert.equal(view.get('firstName').value, 'Existing');
  assert.deepEqual(view.saves, []);
  view.edit('email', 'new@example.invalid');
  assert.equal(view.get('email').hasAttribute('aria-describedby'), false);
  assert.equal(view.window.document.querySelectorAll('.field-review-result').length, 0);
});

test('profile checks are rules only; document Laya is explicit and unavailable suggestions preserve rule advice', async t => {
  const view = await renderer(t); view.navigate('profile');
  assert.equal(view.get('profile-review-laya'), null, 'There is no unsupported profile-model opt-in.');
  view.get('check-profile-fields').click();
  assert.equal(view.requests[0].request.useLaya, false);
  await view.finish();
  assert.equal(view.get('save-profile').disabled, false);
  view.submit(); await tick();
  assert.equal(view.saves.length, 1);
  await view.read(); await view.finish();
  assert.equal(view.get('document-review-laya').checked, false);
  view.get('document-review-laya').click(); view.get('check-document-fields').click();
  assert.equal(view.requests[2].request.useLaya, true);
  const result = response(view.requests[2].request);
  result.laya = { state: 'unavailable', message: 'Experimental Laya review is unavailable. Local rules are shown.' };
  await view.finish(2, result);
  assert.match(view.get('document-review-laya-status').textContent, /unavailable/);
  assert.ok(view.get('document-fields').querySelector('.field-review-result'));
  assert.equal(view.saves.length, 1, 'Checking a document does not save again.');
});

test('OCR automatically checks rules with original provenance; manual recheck uses edited values and never selects or corrects them', async t => {
  const view = await renderer(t); await view.read();
  assert.equal(view.requests.length, 1);
  const automatic = view.requests[0].request;
  assert.equal(automatic.useLaya, false);
  assert.deepEqual(automatic.documentFields, fixture().document.analysis.fields);
  assert.equal(JSON.stringify(automatic).includes('RAW SYNTHETIC TEXT'), false);
  assert.match(view.get('document-fields').textContent, /Document label: Your first name and middle initial/);
  await view.finish();
  assert.equal(view.get('document-fields').querySelectorAll('.field-review-result').length, 3);
  assert.equal(view.get('document-fields').querySelectorAll('input[type="checkbox"]:checked').length, 0);
  const row = view.get('document-fields').querySelector('.document-field');
  const input = row.querySelector('input[type="text"]');
  view.edit(input, 'Reviewed Avery');
  assert.equal(view.get('document-fields').querySelectorAll('.field-review-result').length, 0);
  view.get('document-review-laya').click(); view.get('check-document-fields').click();
  assert.equal(view.requests[1].request.useLaya, true);
  assert.deepEqual(view.requests[1].request.documentFields[0], { ...automatic.documentFields[0], value: 'Reviewed Avery' });
  const result = response(view.requests[1].request);
  result.document[0].status = 'needs-review';
  result.document[0].messages = ['Check this name yourself.'];
  result.laya = { state: 'timed-out', message: 'Laya timed out. Local rules are shown.' };
  await view.finish(1, result);
  assert.equal(input.value, 'Reviewed Avery');
  assert.deepEqual(view.saves, []);
  row.querySelector('input[type="checkbox"]').click();
  view.get('document-confirm-applicant').click();
  assert.equal(view.get('apply-document-fields').disabled, false, 'Advice must not block the existing reviewed Apply action.');
  view.get('apply-document-fields').click();
  assert.equal(view.get('firstName').value, 'Reviewed Avery');
  assert.deepEqual(view.saves, []);
  assert.equal(view.get('document-review-laya').checked, false);
});

test('late profile results cannot survive edits or override a newer pending review', async t => {
  const view = await renderer(t); view.navigate('profile'); view.get('check-profile-fields').click();
  view.edit('firstName', 'New draft');
  assert.equal(view.cancels.length, 1);
  view.get('check-profile-fields').click();
  await view.finish(0);
  assert.equal(view.window.document.querySelectorAll('.field-review-result').length, 0);
  assert.equal(view.get('check-profile-fields').disabled, true);
  await view.finish(1);
  assert.equal(view.get('check-profile-fields').disabled, false);
  assert.equal(view.get('firstName').value, 'New draft');
  assert.ok(view.window.document.querySelector('.field-review-result'));
  view.get('add-household-member').click();
  assert.equal(view.window.document.querySelectorAll('.field-review-result').length, 0);
});

test('document selection keeps pending and completed advice while still requiring applicant confirmation', async t => {
  const view = await renderer(t); await view.read();
  const checkbox = view.get('document-fields').querySelector('input[type="checkbox"]');
  checkbox.click();
  assert.equal(view.cancels.length, 0, 'Selection is not an input to field review, so pending checks stay valid.');
  const result = response(view.requests[0].request);
  result.document[0].status = 'needs-review';
  result.document[0].messages = ['Compare the name before selecting this detail.'];
  await view.finish(0, result);
  const summary = view.get('document-review-summary').textContent;
  const advice = view.get('document-fields').querySelector('.field-review-result').textContent;
  assert.match(advice, /Needs review.*Compare the name/);
  assert.equal(view.get('apply-document-fields').disabled, true);
  view.get('document-confirm-applicant').click();
  assert.equal(view.get('apply-document-fields').disabled, false);
  checkbox.click(); checkbox.click();
  assert.equal(view.get('document-confirm-applicant').checked, false, 'Changing the selection still requires a fresh applicant confirmation.');
  assert.equal(view.get('apply-document-fields').disabled, true);
  assert.equal(view.get('document-review-summary').textContent, summary);
  assert.equal(view.get('document-fields').querySelector('.field-review-result').textContent, advice);
  assert.equal(view.get('document-fields').querySelectorAll('.field-review-result').length, 3);
  assert.equal(view.requests.length, 1);
  assert.equal(view.cancels.length, 0);
  assert.deepEqual(view.saves, []);
});

test('navigation and lock/unlock invalidate pending review, clear opt-in, and suppress late errors', async t => {
  const view = await renderer(t); view.navigate('profile');
  view.get('check-profile-fields').click();
  view.navigate('documents');
  assert.equal(view.get('profile-review-laya'), null);
  await view.finish(0);
  assert.equal(view.get('profile-review-summary').textContent, '');
  view.navigate('profile'); view.get('check-profile-fields').click();
  await view.lock(); await view.unlock(); view.navigate('profile');
  view.requests[1].reject(Error('PRIVATE MODEL ERROR MUST NOT APPEAR')); await tick();
  assert.equal(view.get('profile-review-summary').textContent, '');
  assert.equal(view.get('profile-review-laya'), null);
  assert.equal(view.window.document.querySelectorAll('.field-review-result').length, 0);
  assert.ok(view.cancels.length >= 2);
});

test('document edits, replacement and discard cancel pending advice and ignore old results', async t => {
  const view = await renderer(t); await view.read();
  const input = view.get('document-fields').querySelector('input[type="text"]');
  view.edit(input, 'Changed before review'); await view.finish(0);
  assert.equal(view.get('document-review-summary').textContent, '');
  view.get('document-review-laya').click(); view.get('check-document-fields').click();
  const next = fixture(); next.document.name = 'new-document.pdf'; next.document.analysis.fields[0].value = 'Newer';
  await view.read(next);
  assert.equal(view.get('document-review-laya').checked, false);
  assert.equal(view.requests[2].request.useLaya, false);
  await view.finish(1);
  assert.equal(view.get('document-fields').querySelectorAll('.field-review-result').length, 0);
  await view.finish(2);
  assert.equal(view.get('document-fields').querySelector('input[type="text"]').value, 'Newer');
  view.get('check-document-fields').click(); view.get('discard-document').click();
  view.requests[3].reject(Error('Late discarded review')); await tick();
  assert.equal(view.get('document-review-summary').textContent, '');
  assert.equal(view.get('document-fields').textContent, '');
  assert.ok(view.cancels.length >= 3);
});

test('rules-only errors are generic and never reveal model output, source text, or paths', async t => {
  const view = await renderer(t); view.navigate('profile'); view.get('check-profile-fields').click();
  view.requests[0].reject(Error('/private/document.pdf PRIVATE RAW TEXT')); await tick();
  assert.match(view.get('profile-review-summary').textContent, /could not be completed/);
  assert.doesNotMatch(view.window.document.body.textContent, /PRIVATE RAW TEXT|\/private\/document/);
  assert.equal(view.get('check-profile-fields').disabled, false);
  assert.equal(view.get('save-profile').disabled, false);
});

test('an app without the optional review API retains document review and profile saving', async t => {
  const view = await renderer(t, { available: false }); view.navigate('profile');
  assert.equal(view.get('check-profile-fields').disabled, true);
  assert.equal(view.get('save-profile').disabled, false);
  await view.read();
  assert.equal(view.get('document-review').hidden, false);
  assert.equal(view.get('check-document-fields').disabled, true);
  assert.equal(view.requests.length, 0);
});
