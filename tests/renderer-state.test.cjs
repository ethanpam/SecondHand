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
    lock(lockRevision) {
      status = { ...status, unlocked: false, lockRevision };
      onLocked(lockRevision === undefined ? undefined : { lockRevision });
    }
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
  assert.equal(view.get('profile-save-state').hidden, false);
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
  assert.equal(view.get('profile-save-state').hidden, true, 'Nothing is shown once everything is saved');
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
  assert.equal(view.get('addressLine1').value, fictionalProfile.addressLine1);
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

test('a delayed lock notification cannot clear a passphrase entered after the manual lock response', async t => {
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
  completion.resolve({ exists: true, unlocked: false, lockRevision: 1, extensionId: '', bridgeRunning: true });
  await tick();
  assert.equal(view.get('auth-view').hidden, false);
  view.edit('passphrase', 'incorrect-synthetic-passphrase');
  view.lock(1);
  assert.equal(view.get('passphrase').value, 'incorrect-synthetic-passphrase');
  view.submit('auth-form');
  await tick();
  assert.deepEqual(attemptedPassphrases, ['incorrect-synthetic-passphrase']);
  assert.equal(view.get('auth-error').hidden, false);
  assert.equal(view.get('workspace').hidden, true);
});

test('a fresh lock revision cancels a pending unlock and preserves subsequent input from its late completion', async t => {
  const completion = deferred();
  let dataRequests = 0;
  const view = await renderer(t, {
    unlock: () => completion.promise,
    getData: async () => { dataRequests++; return { profile: { firstName: 'Private synthetic name' }, applications: [] }; }
  });
  view.lock(1);
  view.edit('passphrase', 'synthetic-current-attempt');
  view.submit('auth-form');
  assert.equal(view.get('auth-submit').disabled, true);
  view.lock(2);
  view.edit('passphrase', 'synthetic-next-attempt');
  completion.resolve({ exists: true, unlocked: true, lockRevision: 1 });
  await tick();
  assert.equal(dataRequests, 1, 'A stale unlock must not request profile data');
  assert.equal(view.get('workspace').hidden, true);
  assert.equal(view.get('firstName').value, '');
  assert.equal(view.get('passphrase').value, 'synthetic-next-attempt');
  assert.equal(view.get('auth-error').hidden, true);
});

test('a fresh lock revision cancels a pending unlock data load', async t => {
  const completion = deferred();
  let dataRequests = 0;
  const view = await renderer(t, {
    unlock: async () => ({ exists: true, unlocked: true, lockRevision: 1 }),
    getData: async () => ++dataRequests === 1 ? { profile: {}, applications: [] } : completion.promise
  });
  view.lock(1);
  view.edit('passphrase', 'synthetic-current-attempt');
  view.submit('auth-form');
  await tick();
  assert.equal(dataRequests, 2);
  view.lock(2);
  completion.resolve({ profile: { firstName: 'Late private synthetic name' }, applications: [] });
  await tick();
  assert.equal(view.get('workspace').hidden, true);
  assert.equal(view.get('firstName').value, '');
  assert.equal(view.get('passphrase').value, '');
});

test('invalid or legacy lock revisions fail closed instead of being treated as duplicates', async t => {
  const view = await renderer(t);
  view.lock(1);
  for (const revision of [undefined, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    view.edit('passphrase', 'synthetic-input-to-clear');
    view.lock(revision);
    assert.equal(view.get('passphrase').value, '');
    assert.equal(view.get('workspace').hidden, true);
  }
});

test('a successful unlock ignores its earlier lock notification but a fresh lock still clears it', async t => {
  const view = await renderer(t, {
    unlock: async () => ({ exists: true, unlocked: true, lockRevision: 2 })
  });
  view.lock(1);
  view.edit('passphrase', 'synthetic-current-attempt');
  view.submit('auth-form');
  await tick();
  assert.equal(view.get('workspace').hidden, false);
  assert.equal(view.get('firstName').value, 'Initial');
  view.lock(2);
  assert.equal(view.get('workspace').hidden, false);
  view.lock(3);
  assert.equal(view.get('workspace').hidden, true);
  assert.equal(view.get('firstName').value, '');
});

test('restoring a backup while locked refreshes create-vault UI despite an unchanged lock revision', async t => {
  let restored = false;
  const view = await renderer(t, {
    status: async () => ({ exists: restored, unlocked: false, lockRevision: 0 }),
    importBackup: async () => { restored = true; return { cancelled: false }; }
  });
  assert.equal(view.get('confirm-passphrase').required, true);
  assert.match(view.get('auth-submit').textContent, /Create password/);
  view.get('auth-import').click();
  await tick();
  assert.equal(view.get('confirm-passphrase').required, false);
  assert.equal(view.get('confirm-passphrase-field').hidden, true);
  assert.match(view.get('auth-submit').textContent, /Unlock/);
  assert.equal(view.get('workspace').hidden, true);
});

test('opening Applications or Overview refreshes progress recorded while another view was active', async t => {
  for (const destination of ['applications', 'overview']) await t.test(destination, async t => {
    const view = await renderer(t);
    view.window.document.querySelector('.nav-item[data-view="extension"]').click();
    view.database.applications = [{ id: 'synthetic-native-progress', status: 'in_progress', nextAction: 'Synthetic newly recorded progress' }];
    view.database.profile.firstName = 'Changed only in stored profile';
    view.window.dispatchEvent(new view.window.Event('focus'));
    await tick();
    assert.equal(view.get('application-count').textContent, '0');
    view.window.document.querySelector(`.nav-item[data-view="${destination}"]`).click();
    await tick();
    assert.equal(view.get(`view-${destination}`).hidden, false);
    assert.equal(view.get('application-count').textContent, '1');
    assert.match(view.get('application-list').textContent, /Synthetic newly recorded progress/);
    assert.match(view.get('overview-applications').textContent, /Synthetic newly recorded progress/);
    assert.equal(view.get('firstName').value, 'Initial', 'Refreshing progress must not replace profile inputs');
  });
});

test('declining to leave unsaved profile edits does not refresh the tracker', async t => {
  let reads = 0;
  const view = await renderer(t, { getData: async () => { reads++; return { profile: {}, applications: [] }; } });
  view.window.document.querySelector('.nav-item[data-view="profile"]').click();
  view.edit('firstName', 'Unsaved fictional name');
  view.window.confirm = () => false;
  view.window.document.querySelector('.nav-item[data-view="applications"]').click();
  await tick();
  assert.equal(reads, 1);
  assert.equal(view.get('view-profile').hidden, false);
  assert.equal(view.get('firstName').value, 'Unsaved fictional name');
});

test('late tracker navigation responses cannot repopulate a locked screen or show stale errors', async t => {
  for (const outcome of ['success', 'failure']) await t.test(outcome, async t => {
    const completion = deferred();
    let reads = 0;
    const view = await renderer(t, { getData: () => ++reads === 1 ? Promise.resolve({ profile: {}, applications: [] }) : completion.promise });
    view.window.document.querySelector('.nav-item[data-view="applications"]').click();
    assert.equal(reads, 2);
    view.lock(1);
    view.edit('passphrase', 'new synthetic unlock input');
    if (outcome === 'success') completion.resolve({ profile: {}, applications: [{ status: 'in_progress', nextAction: 'Late private progress' }] });
    else completion.reject(new Error('Old refresh failure'));
    await tick();
    assert.equal(view.get('workspace').hidden, true);
    assert.equal(view.get('application-count').textContent, '0');
    assert.equal(view.get('application-list').textContent, '');
    assert.equal(view.get('overview-applications').textContent, '');
    assert.equal(view.get('toast').hidden, true);
    assert.equal(view.get('passphrase').value, 'new synthetic unlock input');
  });
});

test('an older tracker refresh cannot replace progress from a newer navigation', async t => {
  const completions = [];
  let reads = 0;
  const view = await renderer(t, { getData: () => {
    if (++reads === 1) return Promise.resolve({ profile: {}, applications: [] });
    const completion = deferred(); completions.push(completion); return completion.promise;
  } });
  view.window.document.querySelector('.nav-item[data-view="applications"]').click();
  view.window.document.querySelector('.nav-item[data-view="overview"]').click();
  assert.equal(completions.length, 2);
  completions[1].resolve({ profile: {}, applications: [{ status: 'in_progress', nextAction: 'Newest synthetic progress' }] });
  await tick();
  completions[0].resolve({ profile: {}, applications: [] });
  await tick();
  assert.equal(view.get('application-count').textContent, '1');
  assert.match(view.get('overview-applications').textContent, /Newest synthetic progress/);
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

test('slow buttons show a ring loader only while their work is in progress', async t => {
  const unlocking = deferred();
  const saving = deferred();
  let status = { exists: true, unlocked: false, recoveryKey: true, extensionId: '', bridgeRunning: true };
  const view = await renderer(t, {
    status: async () => status,
    unlock: async () => { await unlocking.promise; status = { ...status, unlocked: true }; return status; },
    saveProfile: () => saving.promise
  });
  const button = view.get('auth-submit');
  assert.equal(button.querySelector('.loader'), null);
  view.edit('passphrase', 'synthetic long password');
  view.submit('auth-form');
  await tick();
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.querySelectorAll('.loader').length, 1);
  assert.equal(button.querySelector('.loader').getAttribute('aria-hidden'), 'true');
  unlocking.resolve();
  await tick(); await tick();
  assert.equal(view.get('workspace').hidden, false);
  assert.equal(button.querySelector('.loader'), null);
  assert.equal(button.hasAttribute('aria-busy'), false);

  // Quick actions without data-loader keep their plain busy state.
  view.submit('profile-form');
  await tick();
  assert.equal(view.get('save-profile').getAttribute('aria-busy'), 'true');
  assert.equal(view.get('save-profile').querySelector('.loader'), null);
  saving.resolve({});
  await tick();
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
  const view = await renderer(t, { setAutofillTrust: async () => { throw new Error('Unlock SecondHand first.'); } });
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

test('the Household section saves money on hand, medical costs, and the citizenship, pregnancy, and Medicare answers', async t => {
  const view = await renderer(t);
  view.window.document.querySelector('.nav-item[data-view="profile"]').click();
  await tick();
  const household = view.get('householdSize').closest('.form-card');
  for (const id of ['assetsOnHand', 'monthlyMedicalExpenses', 'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare']) {
    assert.ok(household.contains(view.get(id)), `${id} is in the Household section`);
    assert.ok(view.window.document.querySelector(`label[for="${id}"]`)?.textContent.trim(), `${id} has a label`);
  }
  for (const id of ['assetsOnHand', 'monthlyMedicalExpenses']) {
    assert.equal(view.get(id).type, 'number');
    assert.equal(view.get(id).min, '0');
    assert.ok(view.get(id).closest('.currency-input'), `${id} is a dollar amount`);
  }
  view.edit('assetsOnHand', '250.75');
  view.edit('monthlyMedicalExpenses', '0');
  for (const [id, value] of [['householdAllCitizens', 'no'], ['householdLegalStatus', 'yes'], ['householdPregnant', 'no'], ['householdMedicare', 'yes']]) {
    view.get(id).value = value;
    view.get(id).dispatchEvent(new view.window.Event('change', { bubbles: true }));
  }
  view.submit('profile-form');
  await tick(); await tick();
  const { profile } = view.database;
  assert.deepEqual([profile.assetsOnHand, profile.monthlyMedicalExpenses, profile.householdAllCitizens, profile.householdLegalStatus, profile.householdPregnant, profile.householdMedicare],
    ['250.75', '0', 'no', 'yes', 'no', 'yes']);
});

test('trusted sites are listed with a Remove button that calls the desktop', async t => {
  const removed = [];
  let status = { exists: true, unlocked: true, extensionId: '', bridgeRunning: true, trustedSites: ['https://pantry.example.org', 'https://wic.example.gov'] };
  const view = await renderer(t, {
    status: async () => status,
    removeTrustedSite: async origin => { removed.push(origin); status = { ...status, trustedSites: status.trustedSites.filter(site => site !== origin) }; return status; }
  });
  const rows = () => Array.from(view.get('trusted-sites').querySelectorAll('li'), row => row.textContent);
  assert.deepEqual(rows().map(text => text.replace('Remove', '').trim()), ['https://pantry.example.org', 'https://wic.example.gov']);
  view.get('trusted-sites').querySelector('button').click();
  await tick(); await tick();
  assert.deepEqual(removed, ['https://pantry.example.org']);
  assert.deepEqual(rows().map(text => text.replace('Remove', '').trim()), ['https://wic.example.gov']);
  status = { ...status, trustedSites: [] };
  view.get('trusted-sites').querySelector('button').click();
  await tick(); await tick();
  assert.equal(view.get('trusted-sites-empty').hidden, false);
});

test('creating a password shows the recovery key once and requires acknowledgement before continuing', async t => {
  const created = [];
  const recoveryKey = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789';
  const view = await renderer(t, {
    status: async () => ({ exists: false, unlocked: false, recoveryKey: false, deviceResetSupported: true, extensionId: '', bridgeRunning: true }),
    createVault: async request => {
      created.push({ ...request });
      return { status: { exists: true, unlocked: true, recoveryKey: true, extensionId: '', bridgeRunning: true }, recoveryKey };
    }
  });
  assert.equal(view.get('forgot-password').hidden, true);
  assert.equal(view.get('device-reset-field').hidden, false);
  assert.equal(view.get('allow-device-reset').checked, true);
  view.edit('passphrase', 'synthetic long password');
  view.edit('confirm-passphrase', 'synthetic long password');
  view.submit('auth-form');
  await tick(); await tick();
  assert.deepEqual(created, [{ password: 'synthetic long password', allowDeviceReset: true }]);
  assert.equal(view.get('workspace').hidden, false);
  assert.equal(view.get('recovery-dialog').open, true);
  assert.equal(view.get('recovery-key-value').textContent, recoveryKey);
  assert.equal(view.get('recovery-reminder').hidden, true);

  const cancel = new view.window.Event('cancel', { cancelable: true });
  view.get('recovery-dialog').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(view.get('recovery-done').disabled, true);
  view.get('recovery-saved').checked = true;
  view.get('recovery-saved').dispatchEvent(new view.window.Event('change'));
  assert.equal(view.get('recovery-done').disabled, false);
  view.get('recovery-done').click();
  assert.equal(view.get('recovery-dialog').open, false);
});

test('locking during initial profile loading cannot redisplay the newly created recovery key', async t => {
  const completion = deferred();
  let dataRequests = 0;
  const view = await renderer(t, {
    status: async () => ({ exists: false, unlocked: false, lockRevision: 0 }),
    createVault: async () => ({
      status: { exists: true, unlocked: true, recoveryKey: true, lockRevision: 0 },
      recoveryKey: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789', deviceResetFailed: true
    }),
    getData: () => { dataRequests++; return completion.promise; }
  });
  view.edit('passphrase', 'synthetic long password');
  view.edit('confirm-passphrase', 'synthetic long password');
  view.submit('auth-form');
  await tick();
  assert.equal(dataRequests, 1);
  view.lock(1);
  completion.resolve({ profile: { firstName: 'Late private name' }, applications: [] });
  await tick();
  assert.equal(view.get('workspace').hidden, true);
  assert.equal(view.get('firstName').value, '');
  assert.equal(view.get('recovery-dialog').open, false);
  assert.equal(view.get('recovery-key-value').textContent, '');
  assert.equal(view.get('recovery-feedback').textContent, '');
});

test('late password reset responses after lock or cancel cannot reload data, show errors, or clear newer input', async t => {
  for (const interruption of ['lock', 'cancel']) for (const result of ['success', 'failure']) {
    await t.test(`${interruption} before ${result}`, async t => {
      const completion = deferred();
      let dataRequests = 0;
      const view = await renderer(t, {
        status: async () => ({ exists: true, unlocked: false, recoveryKey: true, lockRevision: 0 }),
        resetPassword: () => completion.promise,
        getData: async () => { dataRequests++; return { profile: { firstName: 'Stale private name' }, applications: [] }; }
      });
      view.get('forgot-password').click();
      view.edit('recovery-key-input', 'synthetic recovery key');
      view.edit('reset-password', 'synthetic reset password');
      view.edit('reset-confirm', 'synthetic reset password');
      view.submit('reset-form');
      assert.equal(view.get('reset-submit').disabled, true);
      if (interruption === 'lock') view.lock(1); else view.get('reset-cancel').click();
      assert.equal(view.get('auth-form').hidden, false);
      assert.equal(view.get('reset-form').hidden, true);
      view.get('forgot-password').click();
      view.edit('reset-password', 'newer synthetic input');
      view.edit('reset-confirm', 'newer synthetic input');
      if (result === 'success') completion.resolve({ exists: true, unlocked: true, recoveryKey: true, lockRevision: 0 });
      else completion.reject(new Error('Old synthetic reset failure'));
      await tick();
      assert.equal(dataRequests, 0);
      assert.equal(view.get('workspace').hidden, true);
      assert.equal(view.get('firstName').value, '');
      assert.equal(view.get('reset-error').hidden, true);
      assert.equal(view.get('toast').hidden, true);
      assert.equal(view.get('reset-password').value, 'newer synthetic input');
      assert.equal(view.get('reset-confirm').value, 'newer synthetic input');
    });
  }
});

test('locking during a reset profile load keeps data and success feedback hidden', async t => {
  const completion = deferred();
  let dataRequests = 0;
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: false, recoveryKey: true, lockRevision: 0 }),
    resetPassword: async () => ({ exists: true, unlocked: true, recoveryKey: true, lockRevision: 0 }),
    getData: () => { dataRequests++; return completion.promise; }
  });
  view.get('forgot-password').click();
  view.edit('recovery-key-input', 'synthetic recovery key');
  view.edit('reset-password', 'synthetic reset password');
  view.edit('reset-confirm', 'synthetic reset password');
  view.submit('reset-form');
  await tick();
  assert.equal(dataRequests, 1);
  view.lock(1);
  view.get('forgot-password').click();
  view.edit('reset-password', 'newer synthetic input');
  completion.resolve({ profile: { firstName: 'Late private name' }, applications: [] });
  await tick();
  assert.equal(view.get('workspace').hidden, true);
  assert.equal(view.get('firstName').value, '');
  assert.equal(view.get('toast').hidden, true);
  assert.equal(view.get('reset-error').hidden, true);
  assert.equal(view.get('reset-password').value, 'newer synthetic input');
});

test('forgot password resets with a recovery key, and older saved information explains why it cannot', async t => {
  const resets = [];
  let status = { exists: true, unlocked: false, recoveryKey: true, lockRevision: 0, extensionId: '', bridgeRunning: true };
  const view = await renderer(t, {
    status: async () => status,
    resetPassword: async request => {
      resets.push({ ...request });
      if (request.recoveryKey !== 'good key') throw new Error('That recovery key didn’t work. Check it and try again.');
      status = { ...status, unlocked: true };
      return status;
    }
  });
  assert.equal(view.get('forgot-password').hidden, false);
  view.get('forgot-password').click();
  assert.equal(view.get('auth-form').hidden, true);
  assert.equal(view.get('reset-form').hidden, false);
  assert.equal(view.get('reset-fields').hidden, false);
  assert.equal(view.get('auth-title').textContent, 'Reset your password');

  view.edit('recovery-key-input', 'bad key');
  view.edit('reset-password', 'new synthetic password');
  view.edit('reset-confirm', 'different synthetic password');
  view.submit('reset-form');
  await tick();
  assert.match(view.get('reset-error').textContent, /don’t match/);
  assert.equal(resets.length, 0);

  view.edit('reset-confirm', 'new synthetic password');
  view.submit('reset-form');
  await tick();
  assert.match(view.get('reset-error').textContent, /didn’t work/);
  assert.equal(view.get('reset-password').value, '');

  view.edit('recovery-key-input', 'good key');
  view.edit('reset-password', 'new synthetic password');
  view.edit('reset-confirm', 'new synthetic password');
  view.submit('reset-form');
  await tick(); await tick();
  assert.deepEqual(resets.at(-1), { recoveryKey: 'good key', password: 'new synthetic password' });
  assert.equal(view.get('workspace').hidden, false);
  assert.equal(view.get('recovery-key-input').value, '');

  view.lock();
  assert.equal(view.get('reset-form').hidden, true);
  assert.equal(view.get('auth-form').hidden, false);

  const older = await renderer(t, { status: async () => ({ exists: true, unlocked: false, recoveryKey: false, lockRevision: 0, extensionId: '', bridgeRunning: true }) });
  older.get('forgot-password').click();
  assert.equal(older.get('reset-fields').hidden, true);
  assert.equal(older.get('reset-submit').hidden, true);
  assert.equal(older.get('reset-unavailable').hidden, false);
  older.get('reset-cancel').click();
  assert.equal(older.get('auth-form').hidden, false);
  assert.equal(older.get('auth-title').textContent, 'Welcome back');
});

test('reset on this computer skips the recovery key, and either method can be chosen when both exist', async t => {
  const resets = [];
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: false, recoveryKey: true, deviceReset: true, deviceResetSupported: true, extensionId: '', bridgeRunning: true }),
    resetPassword: async request => { resets.push({ ...request }); throw new Error('This computer can’t reset this password. Use your recovery key instead.'); }
  });
  view.get('forgot-password').click();
  assert.equal(view.get('reset-method').hidden, false);
  assert.equal(view.get('reset-method-device').checked, true);
  assert.equal(view.get('recovery-key-field').hidden, true);
  assert.equal(view.get('recovery-key-input').required, false);
  view.edit('reset-password', 'new synthetic password');
  view.edit('reset-confirm', 'new synthetic password');
  view.submit('reset-form');
  await tick();
  assert.deepEqual(resets, [{ method: 'device', password: 'new synthetic password' }]);
  assert.match(view.get('reset-error').textContent, /Use your recovery key/);

  view.get('reset-method-recovery').checked = true;
  view.get('reset-method-recovery').dispatchEvent(new view.window.Event('change'));
  assert.equal(view.get('recovery-key-field').hidden, false);
  assert.equal(view.get('recovery-key-input').required, true);
  view.edit('recovery-key-input', 'typed key');
  view.edit('reset-password', 'new synthetic password');
  view.edit('reset-confirm', 'new synthetic password');
  view.submit('reset-form');
  await tick();
  assert.deepEqual(resets.at(-1), { recoveryKey: 'typed key', password: 'new synthetic password' });
});

test('a lock notification arriving after the lock response cannot clear an unlock attempt already under way', async t => {
  const view = await renderer(t, {
    lock: async () => ({ exists: true, unlocked: false, lockRevision: 1, recoveryKey: true, extensionId: '', bridgeRunning: true }),
    unlock: async () => { throw new Error('Unable to unlock. Check your password or restore an intact backup.'); }
  });
  // The lock response shows the unlock screen before the separate notification arrives.
  view.get('lock-button').click();
  await tick();
  assert.equal(view.get('auth-view').hidden, false);
  view.edit('passphrase', 'incorrect-synthetic-password');
  view.submit('auth-form');
  await tick();
  assert.equal(view.get('auth-error').hidden, false);

  // The late notice carries the same lock revision as the response already shown.
  view.lock(1);
  assert.equal(view.get('auth-error').hidden, false, 'A late lock notice must not hide the unlock error');
  assert.match(view.get('auth-error').textContent, /Unable to unlock/);
  assert.equal(view.get('workspace').hidden, true);
});
