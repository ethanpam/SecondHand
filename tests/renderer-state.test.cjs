'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { PROFILE_FIELDS, PROFILE_CHOICES, YES_NO_FIELDS } = require('../shared/schema.cjs');
const fictionalProfile = require('./fixtures/applicant-profile.json');

const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function renderer(t, overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://secondhand.invalid/' });
  t.after(() => dom.window.close());
  const window = dom.window;
  let onLocked;
  let status = { exists: true, unlocked: true, extensionId: '', bridgeRunning: true };
  const database = { profile: { firstName: 'Initial', lastName: 'Test' }, applications: [] };
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.secondHand = {
    status: async () => status,
    getData: async () => structuredClone(database),
    onLocked: callback => { onLocked = callback; return () => {}; },
    unlock: async () => { status = { ...status, unlocked: true }; return status; },
    saveProfile: async profile => { database.profile = structuredClone(profile); return structuredClone(profile); },
    ...overrides
  };
  window.eval(script);
  await tick();
  const get = id => window.document.getElementById(id);
  return {
    window, get, database,
    edit(id, value) {
      get(id).value = value;
      get(id).dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    submit(id) { get(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
    lock() { status = { ...status, unlocked: false }; onLocked(); }
  };
}

test('profile edits made during a pending save remain visible and unsaved until a second save', async t => {
  const saves = [];
  const view = await renderer(t, {
    saveProfile: profile => {
      const completion = deferred();
      saves.push({ profile: structuredClone(profile), completion });
      return completion.promise;
    }
  });
  view.window.document.querySelector('.nav-item[data-view="profile"]').click();
  view.edit('firstName', 'First edit');
  view.submit('profile-form');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].profile.firstName, 'First edit');
  assert.equal(view.get('save-profile').disabled, true);

  view.edit('firstName', 'Newer unsaved edit');
  saves[0].completion.resolve(saves[0].profile);
  await tick();
  assert.equal(view.get('firstName').value, 'Newer unsaved edit');
  assert.equal(view.get('profile-save-state').textContent, 'Unsaved changes');
  assert.equal(view.get('profile-nav-dot').hidden, false);
  assert.match(view.get('toast').textContent, /newer edits still need to be saved/);

  let askedToDiscard = false;
  view.window.confirm = () => { askedToDiscard = true; return false; };
  view.window.document.querySelector('.nav-item[data-view="overview"]').click();
  assert.equal(askedToDiscard, true);
  assert.equal(view.get('view-profile').hidden, false);
  assert.equal(view.get('firstName').value, 'Newer unsaved edit');

  view.submit('profile-form');
  assert.equal(saves.length, 2);
  assert.equal(saves[1].profile.firstName, 'Newer unsaved edit');
  saves[1].completion.resolve(saves[1].profile);
  await tick();
  assert.equal(view.get('profile-save-state').textContent, 'Saved locally');
  assert.equal(view.get('profile-nav-dot').hidden, true);
  assert.equal(view.get('firstName').value, 'Newer unsaved edit');
});

test('profile saves every schema field and keeps home, mobile, and reference phones distinct', async t => {
  const saved = [];
  const view = await renderer(t, {
    saveProfile: async profile => { saved.push(structuredClone(profile)); return structuredClone(profile); }
  });
  view.edit('phone', '515-555-0100');
  view.edit('homePhone', '515-555-0101');
  view.edit('mobilePhone', '515-555-0102');
  view.submit('profile-form');
  await tick();
  assert.deepEqual(Object.keys(saved[0]).sort(), [...PROFILE_FIELDS].sort());
  assert.equal(saved[0].phone, '515-555-0100');
  assert.equal(saved[0].homePhone, '515-555-0101');
  assert.equal(saved[0].mobilePhone, '515-555-0102');
  assert.equal(view.get('homePhone').value, '515-555-0101');
  assert.equal(view.get('mobilePhone').value, '515-555-0102');

  view.edit('homePhone', '');
  view.edit('mobilePhone', '');
  view.submit('profile-form');
  await tick();
  assert.equal(saved[1].phone, '515-555-0100');
  assert.equal(saved[1].homePhone, '');
  assert.equal(saved[1].mobilePhone, '');
  view.lock();
  for (const id of ['phone', 'homePhone', 'mobilePhone']) assert.equal(view.get(id).value, '');
});

test('new profile choices default to unknown, save explicit no, and clear with all applicant fields on lock', async t => {
  const saved = [];
  const view = await renderer(t, { saveProfile: async profile => { saved.push(structuredClone(profile)); return structuredClone(profile); } });
  for (const field of Object.keys(PROFILE_CHOICES)) {
    assert.equal(view.get(field).value, '', field);
    assert.deepEqual(Array.from(view.get(field).options, option => option.value), PROFILE_CHOICES[field]);
  }
  for (const [field, value] of Object.entries(fictionalProfile)) view.edit(field, value);
  view.submit('profile-form');await tick();
  assert.deepEqual(saved[0], fictionalProfile);
  assert.equal(view.get('programFip').value, 'no');
  assert.equal(view.get('mailingSameAsHome').value, 'no');
  assert.equal(view.get('mailingAddressLine1').value, 'PO Box 123');
  assert.equal(view.get('addressLine1').value, '123 Test Way');
  view.lock();
  for (const field of PROFILE_FIELDS) assert.equal(view.get(field).value, '', field);
});

test('legacy profile loading leaves all new choice fields unknown and does not populate mailing fields', async t => {
  const view = await renderer(t);
  assert.equal(view.get('firstName').value, 'Initial');
  for (const field of [...YES_NO_FIELDS, 'suffix', 'maidenName', 'bestContactTime', 'mailingAddressLine1', 'mailingAddressLine2', 'mailingCity', 'mailingState', 'mailingZip']) {
    assert.equal(view.get(field).value, '', field);
  }
});

test('a pending profile save cannot repopulate fields after a vault lock', async t => {
  const completion = deferred();
  let submitted;
  const view = await renderer(t, {
    saveProfile: profile => { submitted = structuredClone(profile); return completion.promise; }
  });
  view.edit('firstName', 'Private test name');
  view.edit('ssn', '999-88-7777');
  view.submit('profile-form');
  view.lock();
  completion.resolve(submitted);
  await tick();

  assert.equal(view.get('firstName').value, '');
  assert.equal(view.get('ssn').value, '');
  assert.equal(view.get('workspace').hidden, true);
  assert.equal(view.get('auth-view').hidden, false);
  assert.equal(view.get('toast').hidden, true);
  assert.equal(view.get('application-list').children.length, 0);
  assert.equal(view.get('save-profile').disabled, false);
});

test('a delayed manual lock response cannot clear a passphrase entered after the lock notification', async t => {
  const completion = deferred();
  const attemptedPassphrases = [];
  const view = await renderer(t, {
    lock: () => completion.promise,
    unlock: async passphrase => {
      attemptedPassphrases.push(passphrase);
      throw new Error('Unable to unlock the local vault.');
    }
  });
  view.get('lock-button').click();
  view.lock();
  assert.equal(view.get('auth-view').hidden, false);
  view.edit('passphrase', 'incorrect-synthetic-passphrase');
  completion.resolve({ exists: true, unlocked: false, extensionId: '', bridgeRunning: true });
  await tick();
  assert.equal(view.get('passphrase').value, 'incorrect-synthetic-passphrase');

  view.submit('auth-form');
  await tick();
  assert.deepEqual(attemptedPassphrases, ['incorrect-synthetic-passphrase']);
  assert.equal(view.get('auth-error').hidden, false);
  assert.match(view.get('auth-error').textContent, /Unable to unlock/);
  assert.equal(view.get('workspace').hidden, true);
});

test('application editor freezes during save and restores editing after an error', async t => {
  const saves = [];
  const view = await renderer(t, {
    saveApplication: application => {
      const completion = deferred();
      saves.push({ application: structuredClone(application), completion });
      return completion.promise;
    }
  });
  view.get('new-application').click();
  view.edit('application-next-action', 'Bring requested documents');
  view.submit('application-form');
  assert.equal(saves.length, 1);
  for (const id of ['application-status', 'application-confirmation', 'application-next-action', 'application-due-date', 'application-notes', 'close-application', 'cancel-application', 'delete-application', 'save-application']) {
    assert.equal(view.get(id).disabled, true, `${id} remains editable during save`);
  }
  const cancel = new view.window.Event('cancel', { cancelable: true });
  view.get('application-dialog').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(view.get('application-dialog').open, true);
  view.get('cancel-application').click();
  assert.equal(view.get('application-dialog').open, true);

  saves[0].completion.reject(new Error('Save failed for this test'));
  await tick();
  assert.equal(view.get('application-dialog').open, true);
  assert.equal(view.get('application-next-action').disabled, false);
  assert.equal(view.get('save-application').disabled, false);
  assert.equal(view.get('cancel-application').disabled, false);
  assert.equal(view.get('application-next-action').value, 'Bring requested documents');
  assert.equal(view.get('application-error').hidden, false);

  view.submit('application-form');
  assert.equal(saves.length, 2);
  const saved = { ...saves[1].application, id: 'application-test-id', createdAt: '2026-09-26T12:00:00.000Z', updatedAt: '2026-09-26T12:00:00.000Z' };
  view.database.applications = [saved];
  saves[1].completion.resolve(saved);
  await tick();
  assert.equal(view.get('application-dialog').open, false);
  assert.equal(view.get('application-next-action').value, '');
  assert.equal(view.get('application-next-action').disabled, false);
  assert.equal(view.get('application-count').textContent, '1');
});

test('locking during an application save clears the editor and ignores the late result', async t => {
  const completion = deferred();
  let submitted;
  const view = await renderer(t, {
    saveApplication: application => { submitted = structuredClone(application); return completion.promise; }
  });
  view.get('new-application').click();
  view.edit('application-notes', 'Private synthetic application notes');
  view.submit('application-form');
  assert.equal(view.get('application-notes').disabled, true);
  view.lock();
  assert.equal(view.get('application-dialog').open, false);
  assert.equal(view.get('application-notes').value, '');
  assert.equal(view.get('application-notes').disabled, false);
  completion.resolve(submitted);
  await tick();
  assert.equal(view.get('application-notes').value, '');
  assert.equal(view.get('application-list').children.length, 0);
  assert.equal(view.get('overview-applications').children.length, 0);
  assert.equal(view.get('workspace').hidden, true);
  assert.equal(view.get('toast').hidden, true);
  assert.equal(view.get('application-error').hidden, true);
});

test('a profile load completed after a lock cannot show an unlocked workspace', async t => {
  const completion = deferred();
  const view = await renderer(t, { getData: () => completion.promise });
  view.lock();
  completion.resolve({ profile: { firstName: 'Stale private profile' }, applications: [] });
  await tick();
  assert.equal(view.get('firstName').value, '');
  assert.equal(view.get('workspace').hidden, true);
  assert.equal(view.get('auth-view').hidden, false);
});

test('extension preparation shows manual Chrome steps and uses fixed path-copy API without an ID paste', async t => {
  let prepared = 0;
  let copied = 0;
  const view = await renderer(t, {
    prepareExtension: async () => {
      prepared++;
      return { prepared: true, directory: '/synthetic-only/SecondHand/chrome-extension', extensionId: 'jogldddafjfbmfjnjlbjloakjbecnjpl', folderOpened: true };
    },
    copyExtensionFolderPath: async () => { copied++; return true; }
  });
  assert.equal(view.get('extension-prepared').hidden, true);
  view.get('prepare-extension').click();
  await tick();
  assert.equal(prepared, 1);
  assert.equal(view.get('extension-id').value, 'jogldddafjfbmfjnjlbjloakjbecnjpl');
  assert.equal(view.get('extension-prepared').hidden, false);
  assert.equal(view.get('extension-folder-path').textContent, '/synthetic-only/SecondHand/chrome-extension');
  assert.equal(view.get('extension-status').textContent, 'Ready to load in Chrome');
  assert.match(view.get('view-extension').textContent, /does not install the extension automatically/);
  view.get('copy-extension-path').click();
  await tick();
  assert.equal(copied, 1);
  assert.match(view.get('toast').textContent, /Folder path copied/);
});

test('an outdated bundled extension is labelled for refresh rather than a custom connection', async t => {
  const extensionId = 'jogldddafjfbmfjnjlbjloakjbecnjpl';
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId, platform: 'darwin', extensionSetup: { prepared: false, extensionId } })
  });
  assert.equal(view.get('extension-status').textContent, 'Setup needs refresh');
  assert.match(view.get('prepare-extension').textContent, /Refresh extension files/);
  assert.equal(view.get('extension-prepared').hidden, true);
});

test('Chrome extension view toggles autofill trust through the desktop API', async t => {
  const calls = [];
  const view = await renderer(t, { setAutofillTrust: async enabled => { calls.push(enabled); return { exists: true, unlocked: true, extensionId: '', bridgeRunning: true, autofillWithoutAsking: enabled }; } });
  assert.equal(view.get('autofill-trust').checked, false);
  view.get('autofill-trust').checked = true;
  view.get('autofill-trust').dispatchEvent(new view.window.Event('change'));
  await tick(); await tick();
  assert.deepEqual(calls, [true]);
  assert.equal(view.get('autofill-trust').checked, true);
  assert.equal(view.get('autofill-trust').disabled, false);
  assert.doesNotMatch(view.get('view-extension').textContent, /guided/i);
});

test('a failed trust change restores the checkbox and shows the error', async t => {
  const view = await renderer(t, { setAutofillTrust: async () => { throw new Error('Unlock your local vault first.'); } });
  view.get('autofill-trust').checked = true;
  view.get('autofill-trust').dispatchEvent(new view.window.Event('change'));
  await tick(); await tick();
  assert.equal(view.get('autofill-trust').checked, false);
  assert.match(view.get('autofill-trust-error').textContent, /Unlock/);
});

test('the profile form saves household counts and household flags', async t => {
  const view = await renderer(t);
  view.window.document.querySelector('.nav-item[data-view="profile"]').click();
  await tick();
  view.edit('householdAdults', '2');
  view.edit('householdChildren', '3');
  view.edit('householdSeniors', '0');
  view.get('householdVeteran').value = 'no';
  view.get('householdVeteran').dispatchEvent(new view.window.Event('change', { bubbles: true }));
  view.get('householdDisability').value = 'yes';
  view.get('householdDisability').dispatchEvent(new view.window.Event('change', { bubbles: true }));
  view.submit('profile-form');
  await tick(); await tick();
  assert.equal(view.database.profile.householdAdults, '2');
  assert.equal(view.database.profile.householdChildren, '3');
  assert.equal(view.database.profile.householdSeniors, '0');
  assert.equal(view.database.profile.householdVeteran, 'no');
  assert.equal(view.database.profile.householdDisability, 'yes');
});
