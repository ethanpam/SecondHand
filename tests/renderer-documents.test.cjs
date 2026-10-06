'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { loadRenderer } = require('./helpers/harness.cjs');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const documentResult = () => ({ cancelled: false, document: {
  name: 'fictional-tax-return.pdf', pageCount: 2,
  pages: [
    { pageNumber: 1, text: 'FICTIONAL TAX DOCUMENT\nAvery Example\n<script>not code</script>', confidence: 92, words: [] },
    { pageNumber: 2, text: '', confidence: 0, words: [] }
  ],
  analysis: { type: '1040-sr', title: 'Form 1040-SR', taxYear: 2025,
    fields: [
      { id: 'firstName', label: 'Applicant first name', value: 'Avery', page: 1, confidence: 94, profileKey: 'firstName' },
      { id: 'lastName', label: 'Applicant last name', value: 'Example', page: 1, confidence: 91, profileKey: 'lastName' },
      { id: 'city', label: 'City', value: 'Ames', page: 1, confidence: 76, profileKey: 'city' },
      { id: 'annualWages', label: 'Annual wages', value: '$48,000', page: 1, confidence: 89, profileKey: 'monthlyEarnedIncome' },
      { id: 'spouseFirstName', label: 'Spouse first name', value: 'Fictional spouse', page: 1, confidence: 70 },
      { id: 'inferredBirthDate', label: 'Unverified date', value: '1985-04-12', page: 1, confidence: 99, profileKey: 'birthDate' }
    ], warnings: ['A tax return describes a past year, not current income.'] }
} });

async function renderer(t) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://secondhand.invalid/' });
  t.after(() => dom.window.close());
  const window = dom.window;
  window.scrollTo = () => {};
  window.confirm = () => { throw new Error('An OCR review must not silently ask to discard the profile draft.'); };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const reads = [], cancels = [], saves = [], subscriptions = [];
  const profile = { firstName: 'Existing', lastName: 'Person', city: '', monthlyEarnedIncome: '1200', birthDate: '' };
  let onLocked;
  let status = { exists: true, unlocked: true, lockRevision: 0, extensionId: '', bridgeRunning: true };
  window.secondHand = {
    status: async () => status, getData: async () => ({ profile: structuredClone(profile), applications: [] }),
    onLocked: callback => { onLocked = callback; return () => {}; },
    onProfileChanged: () => () => {},
    setupProgress: async () => null,
    onUnlocked: () => () => {},
    unlock: async () => { status = { ...status, unlocked: true }; return status; },
    readDocument: requestId => { const completion = deferred(); reads.push({ requestId, completion }); return completion.promise; },
    cancelDocumentRead: async requestId => { cancels.push(requestId); return true; },
    onDocumentProgress: callback => { const record = { callback, active: true }; subscriptions.push(record); return () => { record.active = false; }; },
    saveProfile: async value => { saves.push(structuredClone(value)); Object.assign(profile, value); return structuredClone(value); }
  };
  loadRenderer(window);
  await tick();
  const get = id => window.document.getElementById(id);
  const navigate = view => window.document.querySelector(`.nav-item[data-view="${view}"]`).click();
  const field = key => get('document-fields').querySelector(`input[type="checkbox"][data-profile-key="${key}"]`);
  return { window, get, reads, cancels, saves, subscriptions, navigate, field,
    edit(id, value) { get(id).value = value; get(id).dispatchEvent(new window.Event('input', { bubbles: true })); },
    async read(result = documentResult()) { navigate('documents'); get('read-document').click(); reads.at(-1).completion.resolve(result); await tick(); },
    lock() { status = { ...status, unlocked: false, lockRevision: status.lockRevision + 1 }; onLocked({ lockRevision: status.lockRevision }); },
    async unlock() { get('passphrase').value = 'synthetic-password'; get('auth-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); },
    approve() { get('document-confirm-applicant').click(); get('apply-document-fields').click(); }
  };
}

test('historical reference needs its own review and saves separately from current income or job answers', async t => {
  const view = await renderer(t);
  const result = documentResult();
  result.document.analysis.statement = { documentType: 'w2', taxYear: '2025', sourceName: 'Synthetic Employer', sourceRole: 'employer',
    recipientName: 'Avery Example', annualIncome: '68450.00', annualIncomeLabel: 'Box 1 — wages', annualWithholding: '0.00', annualWithholdingLabel: 'Box 2 — federal withholding', ssn: '111-22-3333' };
  await view.read(result);
  assert.equal(view.get('document-statement').hidden, false);
  assert.equal(view.get('add-document-statement').disabled, true);
  assert.equal(view.get('document-statement-summary').textContent.includes('111-22-3333'), false);
  view.get('document-confirm-applicant').click();
  assert.equal(view.get('add-document-statement').disabled, true, 'identity approval does not approve a tax record');
  view.get('document-confirm-statement').click();
  view.get('add-document-statement').click();
  assert.equal(view.saves.length, 0);
  assert.equal(view.get('monthlyEarnedIncome').value, '1200');
  assert.equal(view.get('householdWorking').value, '');
  const row = view.window.document.querySelector('[data-record-list="taxStatements"]>fieldset');
  assert.ok(row);
  assert.equal(row.querySelector('[data-record-field="annualIncome"]').value, '68450.00');
  assert.equal(row.querySelector('[data-record-field="annualWithholding"]').value, '0.00');
  assert.equal(view.get('snap-information').open, true);
  view.get('profile-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(view.saves[0].taxStatements.length, 1);
  assert.equal(view.saves[0].taxStatements[0].sourceName, 'Synthetic Employer');
  assert.equal(Object.hasOwn(view.saves[0].taxStatements[0], 'ssn'), false);
  assert.deepEqual(view.saves[0].jobs, []);
  view.lock();
  assert.equal(view.get('document-statement-summary').textContent, '');
  assert.equal(view.get('document-confirm-statement').checked, false);
  assert.equal(view.window.document.querySelector('[data-record-list="taxStatements"]').children.length, 0);
});

test('locking or discarding a read clears historical reference approval and prevents adding it', async t => {
  const view = await renderer(t);
  const result = documentResult(); result.document.analysis.statement = { documentType: 'ssa-1099', sourceName: 'SOCIAL SECURITY', sourceRole: 'issuer' };
  await view.read(result);
  view.get('document-confirm-statement').click();
  view.lock();
  view.get('add-document-statement').click();
  assert.equal(view.get('add-document-statement').disabled, true);
  assert.equal(view.saves.length, 0);
  assert.equal(view.get('document-statement-summary').textContent, '');
});

test('reading shows type/year, page confidence, warnings and raw text without saving or changing profile', async t => {
  const view = await renderer(t);
  await view.read();
  assert.equal(view.get('document-review').hidden, false);
  assert.match(view.get('document-type').textContent, /1040-SR.*2025/);
  assert.match(view.get('document-pages').textContent, /92% recognition confidence/);
  assert.match(view.get('document-warning-list').textContent, /Page 2: no readable text/);
  assert.match(view.get('document-pages').textContent, /<script>not code<\/script>/);
  assert.equal(view.get('document-pages').querySelector('script'), null);
  assert.equal(view.get('document-fields').querySelectorAll('input[type="checkbox"]').length, 3);
  assert.equal(view.get('document-fields').querySelectorAll('input:checked').length, 0);
  assert.match(view.field('firstName').closest('.document-field').textContent, /Current profile draftExisting/);
  assert.equal(view.get('firstName').value, 'Existing');
  assert.equal(view.get('monthlyEarnedIncome').value, '1200');
  assert.equal(view.get('apply-document-fields').disabled, true);
  assert.deepEqual(view.saves, []);
  assert.match(view.reads[0].requestId, /^[a-f0-9-]{36}$/i);
});

test('explicit selected applicant details merge into unsaved draft; encrypted Save remains a separate action', async t => {
  const view = await renderer(t);
  view.navigate('profile');
  view.edit('firstName', 'Unsaved first name');
  view.edit('email', 'draft@example.invalid');
  await view.read();
  assert.equal(view.get('document-draft-note').hidden, false);
  assert.match(view.field('firstName').closest('.document-field').textContent, /Unsaved first name/);
  view.field('city').click();
  assert.equal(view.get('apply-document-fields').disabled, true, 'Applicant confirmation is required.');
  view.approve();
  assert.equal(view.get('view-profile').hidden, false);
  assert.equal(view.get('city').value, 'Ames');
  assert.equal(view.get('firstName').value, 'Unsaved first name');
  assert.equal(view.get('lastName').value, 'Person');
  assert.equal(view.get('email').value, 'draft@example.invalid');
  assert.equal(view.get('monthlyEarnedIncome').value, '1200');
  assert.equal(view.get('birthDate').value, '');
  assert.equal(view.get('profile-save-state').textContent, 'Unsaved changes');
  assert.equal(view.get('document-pages').textContent, '');
  assert.equal(view.get('document-fields').childElementCount, 0);
  assert.deepEqual(view.saves, []);
  view.get('profile-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(view.saves.length, 1);
  assert.equal(view.saves[0].city, 'Ames');
  assert.equal(view.saves[0].firstName, 'Unsaved first name');
});

test('applying reviewed OCR names immediately updates the household applicant row without saving or replacing other draft edits', async t => {
  const view = await renderer(t);
  view.navigate('profile');
  view.edit('birthDate', '1985-04-12');
  view.edit('email', 'household-draft@example.invalid');
  view.edit('monthlyEarnedIncome', '1450');
  view.get('add-household-member').click();
  const self = view.get('household-members').querySelector('[data-self="true"]');
  const other = view.get('household-members').querySelector('[data-self="false"]');
  const control = (row, field) => row.querySelector(`[data-member-field="${field}"]`);
  const details = row => Object.fromEntries([...row.querySelectorAll('[data-member-field]')]
    .map(input => [input.dataset.memberField, input.value]));
  for (const [field, value] of Object.entries({ firstName: 'Casey', lastName: 'Fictional', birthDate: '2014-08-20', relationship: 'child', student: 'yes' })) {
    const input = control(other, field);
    view.edit(input.id, value);
    input.dispatchEvent(new view.window.Event('change', { bubbles: true }));
  }
  view.edit(control(other, 'grade').id, '7th');
  const otherBefore = { id: other.dataset.memberId, ...details(other) };
  const countKeys = ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'];
  const countsBefore = Object.fromEntries(countKeys.map(key => [key, view.get(key).value]));
  assert.equal(control(self, 'firstName').value, 'Existing');
  assert.equal(control(self, 'lastName').value, 'Person');

  await view.read();
  view.field('firstName').click();
  view.field('lastName').click();
  view.approve();

  assert.equal(view.get('firstName').value, 'Avery');
  assert.equal(view.get('lastName').value, 'Example');
  assert.equal(control(self, 'firstName').value, 'Avery', 'The read-only applicant row must reflect the reviewed name before Save.');
  assert.equal(control(self, 'lastName').value, 'Example');
  assert.equal(control(self, 'firstName').readOnly, true);
  assert.equal(control(self, 'lastName').readOnly, true);
  assert.equal(control(self, 'birthDate').value, '1985-04-12');
  assert.deepEqual({ id: other.dataset.memberId, ...details(other) }, otherBefore);
  assert.deepEqual(Object.fromEntries(countKeys.map(key => [key, view.get(key).value])), countsBefore);
  assert.equal(view.get('email').value, 'household-draft@example.invalid');
  assert.equal(view.get('monthlyEarnedIncome').value, '1450');
  assert.equal(view.get('profile-save-state').textContent, 'Unsaved changes');
  assert.deepEqual(view.saves, [], 'Applying OCR details must not save the household or profile.');

  view.get('profile-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(view.saves.length, 1);
  const saved = view.saves[0];
  assert.equal(saved.firstName, 'Avery');
  assert.equal(saved.lastName, 'Example');
  assert.equal(saved.householdMembers[0].firstName, 'Avery');
  assert.equal(saved.householdMembers[0].lastName, 'Example');
  assert.equal(saved.householdMembers[0].birthDate, '1985-04-12');
  assert.deepEqual(saved.householdMembers[1], otherBefore);
  assert.equal(saved.email, 'household-draft@example.invalid');
  assert.equal(saved.monthlyEarnedIncome, '1450');
});

test('existing value is replaced only after explicit selection, correction and applicant confirmation', async t => {
  const view = await renderer(t); await view.read();
  view.field('firstName').click();
  view.get('document-confirm-applicant').click();
  const corrected = view.field('firstName').closest('.document-field').querySelector('input[type="text"]');
  corrected.value = 'Corrected Avery'; corrected.dispatchEvent(new view.window.Event('input', { bubbles: true }));
  assert.equal(view.get('document-confirm-applicant').checked, false);
  assert.equal(view.get('apply-document-fields').disabled, true);
  view.approve();
  assert.equal(view.get('firstName').value, 'Corrected Avery');
  assert.equal(view.get('lastName').value, 'Person');
  assert.deepEqual(view.saves, []);
});

test('draft changes made after review prevent applying a stale replacement', async t => {
  const view = await renderer(t); await view.read();
  view.field('firstName').click();
  view.edit('firstName', 'Newer draft');
  view.approve();
  assert.equal(view.get('firstName').value, 'Newer draft');
  assert.equal(view.get('view-documents').hidden, false);
  assert.equal(view.field('firstName').checked, false);
  assert.match(view.get('document-status').textContent, /draft changed/);
  assert.deepEqual(view.saves, []);
});

test('cancel clears progress and ignores its late result or failure', async t => {
  const view = await renderer(t); view.navigate('documents'); view.get('read-document').click();
  const old = view.reads[0], subscriber = view.subscriptions[0];
  subscriber.callback({ requestId: old.requestId, phase: 'recognizing', page: 2, total: 3 });
  assert.match(view.get('document-progress-label').textContent, /Reading page 2 of 3/);
  view.get('cancel-document').click(); await tick();
  assert.deepEqual(view.cancels, [old.requestId]);
  assert.equal(subscriber.active, false);
  old.completion.resolve(documentResult()); await tick();
  subscriber.callback({ requestId: old.requestId, phase: 'recognizing', page: 3, total: 3 });
  assert.equal(view.get('document-review').hidden, true);
  assert.equal(view.get('document-pages').textContent, '');
  assert.equal(view.get('document-progress-label').textContent, '');
  assert.equal(view.get('document-error').hidden, true);
  assert.deepEqual(view.saves, []);
});

test('replacement read ignores queued old progress and stale result, retaining only the new document', async t => {
  const view = await renderer(t); view.navigate('documents'); view.get('read-document').click();
  const first = view.reads[0]; view.get('cancel-document').click();
  view.get('read-document').click(); const second = view.reads[1];
  assert.notEqual(first.requestId, second.requestId);
  view.subscriptions[1].callback({ requestId: first.requestId, phase: 'recognizing', page: 99, total: 99 });
  assert.equal(view.get('document-progress-label').textContent, 'Opening your document…');
  const newer = documentResult(); newer.document.name = 'newer-document.pdf';
  second.completion.resolve(newer); await tick();
  first.completion.resolve(documentResult()); await tick();
  assert.equal(view.get('document-name').textContent, 'newer-document.pdf');
  assert.equal(view.get('document-progress-card').hidden, true);
  view.get('read-document').click();
  assert.equal(view.get('document-name').textContent, '');
  assert.equal(view.get('document-pages').textContent, '');
  view.reads[2].completion.resolve({ cancelled: true }); await tick();
  assert.equal(view.get('document-review').hidden, true);
});

test('lock clears review fields/text and prevents old OCR work reappearing after unlock', async t => {
  const view = await renderer(t); await view.read();
  view.field('firstName').click(); view.lock();
  assert.equal(view.get('document-pages').textContent, '');
  assert.equal(view.get('document-fields').childElementCount, 0);
  assert.equal(view.get('document-name').textContent, '');
  await view.unlock();
  view.navigate('documents'); view.get('read-document').click();
  const pending = view.reads.at(-1); view.lock(); await tick();
  assert.ok(view.cancels.includes(pending.requestId));
  await view.unlock();
  pending.completion.resolve(documentResult()); await tick();
  assert.equal(view.get('document-review').hidden, true);
  assert.equal(view.get('document-pages').textContent, '');
  assert.equal(view.get('firstName').value, 'Existing');
  assert.deepEqual(view.saves, []);
});

test('leaving Documents cancels reading; discard and navigation remove finished OCR text', async t => {
  const view = await renderer(t); view.navigate('documents'); view.get('read-document').click();
  view.navigate('overview'); await tick();
  assert.equal(view.cancels.length, 1);
  view.reads[0].completion.reject(new Error('Late cancelled OCR failure')); await tick();
  assert.equal(view.get('document-error').hidden, true);
  await view.read(); view.get('discard-document').click();
  assert.equal(view.get('document-pages').textContent, '');
  assert.equal(view.get('firstName').value, 'Existing');
  await view.read(); view.navigate('profile');
  assert.equal(view.get('document-name').textContent, '');
  assert.equal(view.get('document-pages').textContent, '');
});

test('empty/unrecognized results remain review-only and reader errors recover without a save', async t => {
  const view = await renderer(t);
  const result = documentResult(); result.document.analysis = { type: 'unknown', title: 'Unknown document', taxYear: null, fields: [], warnings: [] };
  await view.read(result);
  assert.equal(view.get('document-no-fields').hidden, false);
  assert.equal(view.get('apply-document-fields').disabled, true);
  view.get('read-document').click();
  view.reads.at(-1).completion.reject(new Error('This PDF is password-protected.')); await tick();
  assert.match(view.get('document-error').textContent, /password-protected/);
  assert.equal(view.get('read-document').disabled, false);
  assert.equal(view.get('document-pages').textContent, '');
  assert.deepEqual(view.saves, []);
});
