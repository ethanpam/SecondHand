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

async function renderer(t, { initialSetup = null, ...overrides } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://secondhand.invalid/' });
  t.after(() => dom.window.close());
  const window = dom.window;
  let onLocked;
  let onProfileChanged;
  let status = { exists: true, unlocked: true, extensionId: '', bridgeRunning: true };
  const database = { profile: { firstName: 'Initial', lastName: 'Test' }, applications: [] };
  // The guided setup's progress as the desktop keeps it: null when none is under way.
  const setup = { progress: initialSetup, calls: [] };
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
    setupProgress: async () => structuredClone(setup.progress),
    startSetup: async () => { setup.calls.push('start'); setup.progress = { step: 0, steps: 6 }; return structuredClone(setup.progress); },
    saveSetupProgress: async step => {
      setup.calls.push(step);
      setup.progress = step >= 6 ? null : { step: Math.max(step, setup.progress.step), steps: 6 };
      return structuredClone(setup.progress);
    },
    onProfileChanged: callback => { onProfileChanged = callback; return () => {}; },
    ...overrides
  };
  window.eval(script);
  await tick();
  const get = id => window.document.getElementById(id);
  // A profile field's control: its input or select, or its group of radio buttons.
  const control = name => get('profile-form').elements.namedItem(name);
  const radios = name => control(name) instanceof window.RadioNodeList ? Array.from(control(name)) : null;
  return {
    window, get, database, control, radios, setup,
    // Save to My information in Chrome changed these saved fields.
    profileChanged: fields => onProfileChanged({ fields }),
    value: name => control(name).value,
    choices: name => radios(name)?.map(radio => radio.value) ?? Array.from(control(name).options, option => option.value),
    edit(id, value) {
      get(id).value = value;
      get(id).dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    // Answers a profile field the way a person does: types, picks an option, or clicks a radio button.
    answer(name, value) {
      const group = radios(name);
      if (!group) return this.edit(name, value);
      const radio = group.find(item => item.value === value);
      assert.ok(radio, `${name} has no ${JSON.stringify(value)} option`);
      radio.click();
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
    assert.equal(view.value(field), '', field);
    assert.deepEqual([...view.choices(field)].sort(), [...PROFILE_CHOICES[field]].sort(), field);
  }
  for (const [field, value] of Object.entries(fictionalProfile)) if (field !== 'householdMembers') view.answer(field, value);
  view.submit('profile-form');await tick();
  assert.deepEqual(saved[0], { ...fictionalProfile, householdMembers: [] });
  assert.equal(view.get('programFip').value, 'no');
  assert.equal(view.get('mailingSameAsHome').value, 'no');
  assert.equal(view.get('mailingAddressLine1').value, 'PO Box 123');
  assert.equal(view.get('addressLine1').value, fictionalProfile.addressLine1);
  view.lock();
  for (const field of PROFILE_FIELDS.filter(field => field !== 'householdMembers')) assert.equal(view.value(field), '', field);
});

test('legacy profile loading leaves all new choice fields unknown and does not populate mailing fields', async t => {
  const view = await renderer(t);
  assert.equal(view.get('firstName').value, 'Initial');
  for (const field of [...YES_NO_FIELDS, 'suffix', 'sex', 'maritalStatus', 'maidenName', 'bestContactTime', 'mailingAddressLine1', 'mailingAddressLine2', 'mailingCity', 'mailingState', 'mailingZip']) {
    assert.equal(view.value(field), '', field);
  }
});

// Iowa's Tell Us More questions about the applicant, in Iowa's own words.
const IOWA_QUESTIONS = Object.freeze({
  sex: 'Are you male or female?',
  maritalStatus: 'Marital Status',
  hasSsnAnswer: 'Do you have a Social Security Number?',
  ssnCardNameMatches: 'Is the first and last name you provided the same name that appears on your Social Security card?',
  usCitizen: 'Are you a U.S. Citizen or National?',
  militaryOrVeteran: 'Are you in the military, a veteran, or a spouse of a veteran?',
  disabled: 'Are you Disabled?',
  blind: 'Are you Blind?',
  healthLimitation: 'Do you have a physical, mental, or emotional health condition that causes limitations in activities (like bathing, dressing, daily chores, etc) or live in a medical facility or nursing home?',
  medicare: 'Do you have Medicare?'
});
const text = element => element.textContent.replace(/\s+/g, ' ').trim();

test('About you asks Iowa’s questions in Iowa’s words: radio buttons and a marital status list, each starting at Not answered', async t => {
  const view = await renderer(t);
  view.window.document.querySelector('.nav-item[data-view="profile"]').click();
  const aboutYou = view.get('firstName').closest('.form-card');
  assert.equal(text(aboutYou.querySelector('h2')), 'About you');
  const group = view.get('about-you-questions');
  assert.ok(aboutYou.contains(group));
  assert.equal(text(group.querySelector('h3')), 'Iowa’s questions about you');
  for (const [field, wording] of Object.entries(IOWA_QUESTIONS)) {
    const radios = view.radios(field);
    if (field === 'maritalStatus') {
      assert.equal(radios, null);
      const select = view.control(field);
      assert.ok(group.contains(select));
      assert.equal(text(view.window.document.querySelector(`label[for="${select.id}"]`)), wording);
      assert.deepEqual(Array.from(select.options, option => [option.value, option.textContent]),
        [['', 'Not answered'], ...PROFILE_CHOICES.maritalStatus.slice(1).map(choice => [choice, choice])]);
      continue;
    }
    assert.ok(radios.every(radio => group.contains(radio) && radio.type === 'radio'), field);
    const fieldset = radios[0].closest('fieldset');
    assert.ok(radios.every(radio => fieldset.contains(radio)), field);
    assert.equal(text(fieldset.querySelector('legend')), wording);
    const options = field === 'sex' ? [['Male', 'Male'], ['Female', 'Female'], ['', 'Not answered']] : [['yes', 'Yes'], ['no', 'No'], ['', 'Not answered']];
    assert.deepEqual(radios.map(radio => [radio.value, text(radio.labels[0])]), options, field);
    assert.equal(radios.find(radio => radio.checked)?.value, '', `${field} starts at Not answered`);
  }
  assert.equal(view.get('about-you-questions').querySelectorAll('input[type="radio"]').length, 27);
});

test('Iowa’s questions save, show again after a reload, and clear back to Not answered', async t => {
  const saved = [];
  const answers = { sex: 'Male', maritalStatus: 'Legally Separated', hasSsnAnswer: 'yes', ssnCardNameMatches: 'no', usCitizen: 'yes',
    militaryOrVeteran: 'yes', disabled: 'no', blind: 'no', healthLimitation: 'yes', medicare: 'no' };
  const view = await renderer(t, { saveProfile: async profile => { saved.push(structuredClone(profile)); return structuredClone(profile); } });
  view.window.document.querySelector('.nav-item[data-view="profile"]').click();
  for (const [field, value] of Object.entries(answers)) view.answer(field, value);
  assert.equal(view.get('profile-save-state').textContent, 'Unsaved changes');
  view.submit('profile-form'); await tick();
  assert.deepEqual(Object.fromEntries(Object.keys(answers).map(field => [field, saved[0][field]])), answers);
  assert.equal(saved[0].firstName, 'Initial');
  assert.equal(view.get('profile-save-state').hidden, true);

  const reloaded = await renderer(t, { getData: async () => ({ profile: structuredClone(saved[0]), applications: [] }) });
  for (const [field, value] of Object.entries(answers)) {
    assert.equal(reloaded.value(field), value, field);
    if (reloaded.radios(field)) assert.deepEqual(reloaded.radios(field).filter(radio => radio.checked).map(radio => radio.value), [value], field);
  }

  for (const field of Object.keys(answers)) view.answer(field, '');
  view.submit('profile-form'); await tick();
  for (const field of Object.keys(answers)) assert.equal(saved[1][field], '', field);
  for (const field of Object.keys(answers)) assert.equal(view.value(field), '', field);
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

test('Privacy & backups names everything autofill fills or clicks today and keeps the live-submission caveat', async t => {
  const view = await renderer(t);
  view.window.document.querySelector('.nav-item[data-view="privacy"]').click();
  const card = text(view.window.document.querySelector('#view-privacy .autofill-card'));
  for (const phrase of ['first applicant page', 'Household Application Information', 'Tell Us More', 'date of birth', 'Iowa’s questions about you',
    'first suggested home address', 'Information-only screens', 'Laya', 'guesses', 'Other sites you trust', 'Chrome’s built-in AI', 'on this computer',
    'never guesses on Iowa’s form', 'Iowa pages SecondHand doesn’t know', 'A complete live submission has not been validated.']) assert.ok(card.includes(phrase), phrase);
  // Chrome's AI is named with where it runs, that its answers are marked, and that it stays off Iowa's form.
  const chrome = card.split(/(?<=\.)\s+/).find(sentence => sentence.includes('Chrome’s built-in AI'));
  assert.match(chrome, /only/);
  assert.match(chrome, /on this computer/);
  assert.match(chrome, /marked to check/);
  assert.doesNotMatch(card, /—|passphrase|vault|the rules/i);
  // The one value SecondHand picks for the applicant gets its own paragraph, ending on the instruction to check it.
  const address = Array.from(view.window.document.querySelectorAll('#view-privacy .autofill-card p'), text).filter(paragraph => paragraph.includes('first suggested home address'));
  assert.equal(address.length, 1);
  assert.match(address[0], /^On the verified home-address page, .*\. Check that this address is yours before you submit\.$/);
});

test('the document review card opens with the file name as its heading, with no line above it', async t => {
  const view = await renderer(t);
  const summary = view.window.document.querySelector('#document-review .document-summary > div');
  assert.equal(summary.firstElementChild, view.get('document-name'));
  assert.equal(summary.firstElementChild.tagName, 'H2');
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

test('the Chrome extension view says whether all websites is on and turns it off through the desktop; sites trusted one by one stay', async t => {
  const calls = [];
  let status = { exists: true, unlocked: true, extensionId: '', bridgeRunning: true, trustedSites: ['https://pantry.example.org'], allSites: true };
  const view = await renderer(t, {
    status: async () => status,
    turnOffAllSites: async () => { calls.push('off'); status = { ...status, allSites: false }; return status; }
  });
  assert.equal(view.get('all-sites-status').textContent, 'All websites: on. SecondHand can fill forms on any website after you click Autofill there. Sensitive details still ask on each site.');
  assert.equal(view.get('all-sites-off').hidden, false);
  assert.equal(view.get('all-sites-off').textContent, 'Turn off');
  view.get('all-sites-off').click();
  await tick(); await tick();
  assert.deepEqual(calls, ['off']);
  assert.equal(view.get('all-sites-status').textContent, 'All websites: off. To turn it on, open SecondHand’s side panel in Chrome and choose Use SecondHand on all websites.');
  assert.equal(view.get('all-sites-off').hidden, true);
  assert.match(view.get('toast').textContent, /no longer fill forms on every website/);
  assert.deepEqual(Array.from(view.get('trusted-sites').querySelectorAll('code'), code => code.textContent), ['https://pantry.example.org']);

  const failing = await renderer(t, { status: async () => ({ ...status, allSites: true }), turnOffAllSites: async () => { throw new Error('Unlock SecondHand first.'); } });
  failing.get('all-sites-off').click();
  await tick(); await tick();
  assert.match(failing.get('autofill-trust-error').textContent, /Unlock SecondHand first\./);
  assert.equal(failing.get('all-sites-off').hidden, false);
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

const LAYA_BYTES = 428699034;
const layaView = view => ({
  checked: view.get('laya-toggle').checked, disabled: view.get('laya-toggle').disabled, text: view.get('laya-status').textContent,
  progress: view.get('laya-progress').hidden ? null : Number(view.get('laya-progress').value),
  buttons: ['laya-download', 'laya-cancel', 'laya-remove'].filter(id => !view.get(id).hidden).map(id => view.get(id).textContent.trim())
});

test('the Laya toggle shows the model size, and turning it on downloads with visible progress until ready', async t => {
  const calls = [];
  let polled = 0;
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId: '', bridgeRunning: true, laya: { state: 'off', enabled: false, sizeBytes: LAYA_BYTES } }),
    setLayaEnabled: async enabled => { calls.push(enabled); return { state: 'downloading', enabled, progress: 0.25, sizeBytes: LAYA_BYTES }; },
    layaStatus: async () => ++polled === 1 ? { state: 'downloading', enabled: true, progress: 0.5, sizeBytes: LAYA_BYTES } : { state: 'ready', enabled: true, sizeBytes: LAYA_BYTES }
  });
  assert.match(view.get('view-extension').textContent, /Find more fields with Laya \(runs on this computer\)/);
  assert.deepEqual(layaView(view), { checked: false, disabled: false, text: 'Off. The model is a 429 MB download that runs on this computer.', progress: null, buttons: [] });
  view.get('laya-toggle').checked = true;
  view.get('laya-toggle').dispatchEvent(new view.window.Event('change'));
  await tick(); await tick();
  assert.deepEqual(calls, [true]);
  assert.deepEqual(layaView(view), { checked: true, disabled: false, text: 'Downloading 25% of 429 MB…', progress: 25, buttons: ['Pause download'] });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(layaView(view).text, 'Downloading 50% of 429 MB…');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.deepEqual(layaView(view), { checked: true, disabled: false, text: 'Ready. The model (429 MB) is on this computer.', progress: null, buttons: ['Remove model'] });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(polled, 2, 'polling stops once the download is finished');
});

test('with no Laya model published yet, the toggle is disabled and says so', async t => {
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId: '', bridgeRunning: true, laya: { state: 'unavailable', enabled: false, message: 'No Laya model is available to download yet.' } })
  });
  assert.deepEqual(layaView(view), { checked: false, disabled: true, text: 'No Laya model is available to download yet.', progress: null, buttons: [] });
});

test('Laya download controls: pause, resume, and remove, which asks first and turns Laya off', async t => {
  const calls = [];
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId: '', bridgeRunning: true, laya: { state: 'downloading', enabled: true, progress: 0.4, sizeBytes: LAYA_BYTES } }),
    layaStatus: async () => ({ state: 'downloading', enabled: true, progress: 0.4, sizeBytes: LAYA_BYTES }),
    cancelLayaDownload: async () => { calls.push('cancel'); return { state: 'not-downloaded', enabled: true, progress: 0.4, sizeBytes: LAYA_BYTES }; },
    downloadLaya: async () => { calls.push('download'); return { state: 'ready', enabled: true, sizeBytes: LAYA_BYTES }; },
    removeLaya: async () => { calls.push('remove'); return { state: 'off', enabled: false, sizeBytes: LAYA_BYTES }; }
  });
  view.get('laya-cancel').click();
  await tick(); await tick();
  assert.deepEqual(layaView(view), { checked: true, disabled: false, text: 'Download paused at 40% of 429 MB.', progress: 40, buttons: ['Resume download'] });
  view.get('laya-download').click();
  await tick(); await tick();
  assert.deepEqual(layaView(view).buttons, ['Remove model']);
  const asked = [];
  view.window.confirm = question => { asked.push(question); return false; };
  view.get('laya-remove').click();
  await tick();
  assert.deepEqual(calls, ['cancel', 'download']);
  view.window.confirm = question => { asked.push(question); return true; };
  view.get('laya-remove').click();
  await tick(); await tick();
  assert.equal(asked.length, 2);
  assert.equal(asked[0], 'Remove the Laya model from this computer and turn Laya off? Turn it on again to download the model.');
  assert.deepEqual(calls, ['cancel', 'download', 'remove']);
  assert.deepEqual(layaView(view), { checked: false, disabled: false, text: 'Off. The model is a 429 MB download that runs on this computer.', progress: null, buttons: [] });
  assert.equal(view.get('toast').textContent, 'The Laya model was removed from this computer, and Laya is off.');
});

test('a Laya error shows its message with a way to try again, and a failed toggle is restored', async t => {
  const message = 'The downloaded Laya model didn’t match its expected checksum, so SecondHand deleted it. Try again.';
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId: '', bridgeRunning: true, laya: { state: 'error', enabled: true, message, sizeBytes: LAYA_BYTES } }),
    setLayaEnabled: async () => { throw new Error('Unlock SecondHand first.'); }
  });
  assert.deepEqual(layaView(view), { checked: true, disabled: false, text: message, progress: null, buttons: ['Try again', 'Remove model'] });
  view.get('laya-toggle').checked = false;
  view.get('laya-toggle').dispatchEvent(new view.window.Event('change'));
  await tick(); await tick();
  assert.equal(view.get('laya-toggle').checked, true);
  assert.equal(view.get('laya-toggle').disabled, false);
  assert.match(view.get('laya-error').textContent, /Unlock SecondHand first/);
});

test('a new install shows Laya on and downloading in the background, with its progress', async t => {
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId: '', bridgeRunning: true, laya: { state: 'downloading', enabled: true, progress: 0, sizeBytes: LAYA_BYTES } }),
    layaStatus: async () => ({ state: 'downloading', enabled: true, progress: 0.1, sizeBytes: LAYA_BYTES })
  });
  assert.match(view.get('view-extension').textContent, /While it’s on, SecondHand downloads it in the background, checks for a newer version once a day, and runs it on this computer\./);
  assert.deepEqual(layaView(view), { checked: true, disabled: false, text: 'Downloading 0% of 429 MB…', progress: 0, buttons: ['Pause download'] });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(layaView(view).text, 'Downloading 10% of 429 MB…');
});

test('an update note shows beside the model’s status: a failed check, a model that needs a newer SecondHand, or an update downloading until it is installed', async t => {
  const failed = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId: '', bridgeRunning: true,
      laya: { state: 'ready', enabled: true, sizeBytes: LAYA_BYTES, update: { state: 'error', message: 'Update check failed: the server answered 404.' } } })
  });
  assert.deepEqual(layaView(failed), { checked: true, disabled: false, text: 'Ready. The model (429 MB) is on this computer. Update check failed: the server answered 404.', progress: null, buttons: ['Remove model'] });
  const incompatible = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId: '', bridgeRunning: true,
      laya: { state: 'ready', enabled: true, sizeBytes: LAYA_BYTES, update: { state: 'incompatible', message: 'A newer Laya model is available, but it needs a newer version of SecondHand.' } } })
  });
  assert.equal(layaView(incompatible).text, 'Ready. The model (429 MB) is on this computer. A newer Laya model is available, but it needs a newer version of SecondHand.');

  let polled = 0;
  const updating = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId: '', bridgeRunning: true,
      laya: { state: 'ready', enabled: true, sizeBytes: LAYA_BYTES, update: { state: 'downloading', progress: 0.3, sizeBytes: 431e6 } } }),
    layaStatus: async () => ++polled === 1 ? { state: 'ready', enabled: true, sizeBytes: LAYA_BYTES, update: { state: 'downloading', progress: 0.9, sizeBytes: 431e6 } } :
      { state: 'ready', enabled: true, sizeBytes: 431e6 }
  });
  assert.deepEqual(layaView(updating), { checked: true, disabled: false, text: 'Ready. The model (429 MB) is on this computer. Downloading an update: 30% of 431 MB…', progress: null, buttons: ['Remove model'] });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(layaView(updating).text, 'Ready. The model (429 MB) is on this computer. Downloading an update: 90% of 431 MB…');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(layaView(updating).text, 'Ready. The model (431 MB) is on this computer.');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(polled, 2, 'polling stops once the update is installed');
});

test('on a computer Laya can’t run on, the toggle is off and disabled, whatever the saved choice', async t => {
  const message = 'Laya can’t run on this computer. It needs Windows, Linux, or a Mac with Apple silicon.';
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId: '', bridgeRunning: true, laya: { state: 'unavailable', enabled: true, message } })
  });
  assert.deepEqual(layaView(view), { checked: false, disabled: true, text: message, progress: null, buttons: [] });
});

test('turning Laya off says so and stops showing download controls', async t => {
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: true, extensionId: '', bridgeRunning: true, laya: { state: 'ready', enabled: true, sizeBytes: LAYA_BYTES } }),
    setLayaEnabled: async enabled => ({ state: 'off', enabled, sizeBytes: LAYA_BYTES })
  });
  view.get('laya-toggle').checked = false;
  view.get('laya-toggle').dispatchEvent(new view.window.Event('change'));
  await tick(); await tick();
  assert.deepEqual(layaView(view), { checked: false, disabled: false, text: 'Off. The model is a 429 MB download that runs on this computer.', progress: null, buttons: [] });
  assert.match(view.get('toast').textContent, /Laya is off/);
});

test('start over is offered on the reset screen, needs the typed phrase, and returns to creating a password', async t => {
  let status = { exists: true, unlocked: false, recoveryKey: true, deviceReset: false, lockRevision: 0 };
  const calls = [];
  const view = await renderer(t, {
    status: async () => status,
    exportBackup: async () => { calls.push('export'); return { cancelled: false }; },
    startOver: async request => { calls.push(request); status = { exists: false, unlocked: false, lockRevision: 0 }; return status; }
  });
  assert.equal(view.get('start-over-form').hidden, true);
  view.get('forgot-password').click();
  assert.equal(view.get('reset-form').hidden, false);
  view.get('start-over').click();
  assert.equal(view.get('start-over-form').hidden, false);
  assert.equal(view.get('reset-form').hidden, true);
  assert.equal(view.get('auth-title').textContent, 'Start over');
  assert.equal(view.get('start-over-submit').disabled, true);

  view.edit('start-over-confirm', 'start');
  assert.equal(view.get('start-over-submit').disabled, true);
  view.submit('start-over-form');
  await tick();
  assert.deepEqual(calls, [], 'Nothing is erased until the phrase is typed');

  view.get('start-over-save').click();
  await tick();
  assert.deepEqual(calls, ['export']);

  view.edit('start-over-confirm', ' Start Over ');
  assert.equal(view.get('start-over-submit').disabled, false);
  view.submit('start-over-form');
  await tick(); await tick();
  assert.equal(calls[1].confirmation, ' Start Over ');
  assert.equal(view.get('start-over-form').hidden, true);
  assert.equal(view.get('confirm-passphrase-field').hidden, false);
  assert.match(view.get('auth-submit').textContent, /Create password/);
  assert.equal(view.get('forgot-password').hidden, true);
});

test('going back from start over returns to the reset screen, and a failed erase shows why', async t => {
  const view = await renderer(t, {
    status: async () => ({ exists: true, unlocked: false, recoveryKey: false, deviceReset: false, lockRevision: 0 }),
    startOver: async () => { throw new Error('Could not erase your saved information. Please try again.'); }
  });
  view.get('forgot-password').click();
  assert.equal(view.get('reset-unavailable').hidden, false, 'Older saves without a reset option still see Start over');
  view.get('start-over').click();
  view.edit('start-over-confirm', 'start over');
  view.submit('start-over-form');
  await tick(); await tick();
  assert.equal(view.get('start-over-error').hidden, false);
  assert.match(view.get('start-over-error').textContent, /Could not erase/);
  assert.equal(view.get('start-over-form').hidden, false);

  view.get('start-over-cancel').click();
  assert.equal(view.get('start-over-form').hidden, true);
  assert.equal(view.get('reset-form').hidden, false);
  assert.equal(view.get('auth-title').textContent, 'Reset your password');
  assert.equal(view.get('start-over-confirm').value, '', 'Leaving start over clears the typed phrase');
});

// The household list and the guided setup (#98).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const openProfile = view => view.window.document.querySelector('.nav-item[data-view="profile"]').click();
const memberRows = view => [...view.get('household-members').querySelectorAll('.household-member')];
const inRow = (row, field) => row.querySelector(`[data-member-field="${field}"]`);
function editRow(view, row, field, value) {
  const control = inRow(row, field);
  control.value = value;
  control.dispatchEvent(new view.window.Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  if (control.tagName === 'SELECT') control.dispatchEvent(new view.window.Event('input', { bubbles: true }));
}

test('the household list starts with the applicant, who mirrors their own name and birth date, and saves each person with their own answers', async t => {
  const saved = [];
  const view = await renderer(t, { saveProfile: async profile => { saved.push(structuredClone(profile)); return structuredClone(profile); } });
  openProfile(view);
  assert.deepEqual(memberRows(view), []);
  assert.equal(view.get('add-household-member').textContent.trim(), 'Add a person');
  view.get('add-household-member').click();
  const [self, other] = memberRows(view);
  assert.equal(self.querySelector('legend').textContent, 'You');
  assert.equal(other.querySelector('legend').textContent, 'Person 2');
  assert.equal(inRow(self, 'firstName').value, 'Initial');
  assert.equal(inRow(self, 'firstName').readOnly, true, 'your own name is edited in About you');
  assert.equal(inRow(self, 'relationship'), null, 'you are you');
  assert.equal(self.querySelector('.remove-member'), null, 'you stay on the list while others are on it');
  view.edit('firstName', 'Avery');
  view.edit('birthDate', '1985-04-12');
  assert.equal(inRow(self, 'firstName').value, 'Avery');
  assert.equal(inRow(self, 'birthDate').value, '1985-04-12');
  editRow(view, self, 'student', 'no');
  for (const [field, value] of [['firstName', 'Riley'], ['lastName', 'Example'], ['birthDate', '2015-09-03'], ['relationship', 'child']]) editRow(view, other, field, value);
  assert.equal(inRow(other, 'grade').closest('.field').hidden, true, 'a grade is asked only for a student');
  editRow(view, other, 'student', 'yes');
  assert.equal(inRow(other, 'grade').closest('.field').hidden, false);
  editRow(view, other, 'grade', '5th');
  assert.equal(view.get('profile-save-state').hidden, false, 'list edits are unsaved changes too');
  view.submit('profile-form');
  await tick();
  const members = saved[0].householdMembers;
  assert.ok(members.every(member => UUID.test(member.id)) && members[0].id !== members[1].id);
  assert.deepEqual(members.map(({ id, ...member }) => member), [
    { firstName: 'Avery', lastName: 'Test', birthDate: '1985-04-12', relationship: 'self', student: 'no', grade: '' },
    { firstName: 'Riley', lastName: 'Example', birthDate: '2015-09-03', relationship: 'child', student: 'yes', grade: '5th' }]);
  // A student answer changed to No clears the grade, so a grade is never saved for someone who isn't a student.
  editRow(view, memberRows(view)[1], 'student', 'no');
  view.submit('profile-form');
  await tick();
  assert.deepEqual([saved[1].householdMembers[1].student, saved[1].householdMembers[1].grade], ['no', '']);
});

test('a saved household list shows again after a reload, and the applicant can be removed only when alone', async t => {
  const view = await renderer(t);
  view.database.profile = structuredClone(fictionalProfile);
  view.lock(1);
  await view.window.secondHand.unlock();
  view.submit('auth-form');
  await tick(); await tick();
  openProfile(view);
  const rows = memberRows(view);
  assert.deepEqual(rows.map(row => inRow(row, 'firstName').value), ['Avery', 'Riley', 'Sam', 'Morgan']);
  assert.equal(inRow(rows[1], 'relationship').value, 'child');
  assert.equal(inRow(rows[1], 'grade').value, '5th');
  for (const row of rows.slice(1)) row.querySelector('.remove-member').click();
  assert.equal(memberRows(view).length, 1);
  const alone = memberRows(view)[0].querySelector('.remove-member');
  assert.ok(alone, 'alone on the list, you can remove the list');
  assert.equal(alone.textContent.trim(), 'Remove the list');
  alone.click();
  assert.deepEqual(memberRows(view), []);
});

test('with people on the list, the household counts come from their birth dates, read-only, with a note; without it the manual counts come back', async t => {
  const view = await renderer(t, { getData: async () => structuredClone({ profile: { ...fictionalProfile, householdSize: '9', householdAdults: '9', householdChildren: '9', householdSeniors: '9' }, applications: [] }) });
  openProfile(view);
  // The fixture's household: the applicant, two children, and a parent over 65.
  assert.deepEqual(['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'].map(view.value), ['4', '1', '2', '1']);
  for (const field of ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors']) assert.equal(view.get(field).readOnly, true, field);
  assert.equal(view.get('household-counts-note').hidden, false);
  assert.equal(view.get('household-counts-note').textContent, 'Counted from your household list. To change them, change the list.');
  editRow(view, memberRows(view)[2], 'birthDate', '');
  assert.deepEqual(['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'].map(view.value), ['4', '', '', '']);
  assert.equal(view.get('household-counts-note').textContent, 'Counted from your household list. Add every person’s birth date to count their ages.');
  for (const row of memberRows(view).slice(1)) row.querySelector('.remove-member').click();
  memberRows(view)[0].querySelector('.remove-member').click();
  assert.deepEqual(['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'].map(view.value), ['9', '9', '9', '9'], 'the manual counts saved before');
  for (const field of ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors']) assert.equal(view.get(field).readOnly, false, field);
  assert.equal(view.get('household-counts-note').hidden, true);
});

test('the household list holds up to 20 people', async t => {
  const view = await renderer(t);
  openProfile(view);
  for (let n = 0; n < 19; n++) view.get('add-household-member').click();
  assert.equal(memberRows(view).length, 20);
  assert.equal(view.get('add-household-member').disabled, true);
  assert.equal(view.get('household-limit').hidden, false);
  memberRows(view)[5].querySelector('.remove-member').click();
  assert.equal(view.get('add-household-member').disabled, false);
});

test('after a new password, the app offers the guided setup once the recovery key is saved; Skip for now leaves it on Overview', async t => {
  const view = await renderer(t, {
    status: async () => ({ exists: false, unlocked: false, recoveryKey: false, extensionId: '', bridgeRunning: true }),
    createVault: async () => ({ status: { exists: true, unlocked: true, recoveryKey: true, extensionId: '', bridgeRunning: true }, recoveryKey: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789' })
  });
  view.edit('passphrase', 'synthetic long password');
  view.edit('confirm-passphrase', 'synthetic long password');
  view.submit('auth-form');
  await tick(); await tick(); await tick();
  assert.deepEqual(view.setup.calls, ['start'], 'the setup starts with the new password, so it can be resumed');
  assert.equal(view.get('recovery-dialog').open, true);
  assert.equal(view.get('setup-dialog').open, false, 'the recovery key comes first');
  view.get('recovery-saved').checked = true;
  view.get('recovery-saved').dispatchEvent(new view.window.Event('change'));
  view.get('recovery-done').click();
  assert.equal(view.get('setup-dialog').open, true);
  assert.equal(view.get('setup-start').textContent.trim(), 'Set up your information (about 5 minutes)');
  assert.equal(view.get('setup-skip').textContent.trim(), 'Skip for now');
  view.get('setup-skip').click();
  assert.equal(view.get('setup-dialog').open, false);
  assert.equal(view.get('view-overview').hidden, false);
  assert.equal(view.get('setup-resume').hidden, false);
  assert.equal(view.get('setup-resume-text').textContent, 'Finish setting up: 0 of 6 steps');
});

test('the guided setup shows one step at a time, saves each step as the applicant moves on, and finishes after the sixth', async t => {
  const saves = [];
  const view = await renderer(t, { initialSetup: { step: 0, steps: 6 }, saveProfile: async profile => { saves.push(structuredClone(profile)); return structuredClone(profile); } });
  // The steps whose sections show: each section of My information belongs to one step.
  const shownSteps = () => [...new Set([...view.get('profile-form').querySelectorAll('[data-setup-step]')].filter(part => !part.hidden && !part.closest('.form-card').hidden)
    .map(part => part.dataset.setupStep))].sort();
  assert.equal(view.get('setup-resume-text').textContent, 'Finish setting up: 0 of 6 steps');
  view.get('setup-resume-button').click();
  assert.equal(view.get('view-profile').hidden, false);
  assert.equal(view.get('setup-bar').hidden, false);
  assert.equal(view.get('setup-step-count').textContent, 'Step 1 of 6');
  assert.equal(view.get('setup-step-title').textContent, 'You');
  assert.equal(view.window.document.activeElement, view.get('setup-step-title'), 'the step’s heading is read first');
  assert.ok(view.get('setup-step-title').compareDocumentPosition(view.get('setup-step-count')) & view.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the step’s heading comes before the step count, with no line above it');
  assert.deepEqual(shownSteps(), ['1']);
  assert.equal(view.get('save-profile').closest('.form-save-bar').hidden, true);
  assert.equal(view.get('setup-back').disabled, true);
  view.edit('firstName', 'Avery');
  view.submit('profile-form');
  await tick(); await tick();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].firstName, 'Avery');
  assert.deepEqual(view.setup.calls, [1]);
  assert.equal(view.get('setup-step-count').textContent, 'Step 2 of 6');
  assert.equal(view.get('setup-step-title').textContent, 'Your household');
  assert.deepEqual(shownSteps(), ['2']);
  assert.equal(view.get('householdSize').closest('.form-card').querySelector('.card-heading').hidden, true, 'the step’s own title names the part of a split card');
  view.get('setup-back').click();
  assert.equal(view.get('setup-step-title').textContent, 'You');
  assert.equal(saves.length, 1, 'going back saves nothing');
  const titles = [];
  for (let step = 1; step <= 6; step++) {
    titles.push(view.get('setup-step-title').textContent);
    view.submit('profile-form');
    await tick(); await tick();
  }
  assert.deepEqual(titles, ['You', 'Your household', 'Where you live', 'Income and money on hand', 'Programs', 'About you']);
  assert.deepEqual(view.setup.calls, [1, 1, 2, 3, 4, 5, 6]);
  assert.equal(saves.length, 7);
  assert.equal(view.get('setup-bar').hidden, true, 'setup is finished');
  assert.equal(view.get('view-overview').hidden, false);
  assert.equal(view.get('setup-resume').hidden, true);
  assert.equal(view.get('toast').textContent, 'Your information is set up. Change it any time in My information.');
  openProfile(view);
  assert.deepEqual(shownSteps(), ['1', '2', '3', '4', '5', '6'], 'My information shows every section again');
  assert.equal(view.window.document.querySelectorAll('#profile-form .card-heading[hidden]').length, 0);
});

test('the guided setup resumes at the first step not done, and a step that doesn’t save stays put with its error', async t => {
  let fail = true;
  let window;
  const view = await renderer(t, { initialSetup: { step: 3, steps: 6 },
    saveProfile: async profile => { if (fail) throw new window.Error('Enter a valid email address.'); return structuredClone(profile); } });
  window = view.window;
  assert.equal(view.get('setup-resume-text').textContent, 'Finish setting up: 3 of 6 steps');
  view.get('setup-resume-button').click();
  assert.equal(view.get('setup-step-count').textContent, 'Step 4 of 6');
  assert.equal(view.get('setup-step-title').textContent, 'Income and money on hand');
  view.submit('profile-form');
  await tick(); await tick();
  assert.equal(view.get('setup-step-count').textContent, 'Step 4 of 6');
  assert.equal(view.get('profile-error').textContent, 'Enter a valid email address.');
  assert.deepEqual(view.setup.calls, []);
  fail = false;
  view.submit('profile-form');
  await tick(); await tick();
  assert.deepEqual(view.setup.calls, [4]);
  assert.equal(view.get('setup-step-count').textContent, 'Step 5 of 6');
  view.get('setup-later').click();
  assert.equal(view.get('view-overview').hidden, false);
  assert.equal(view.get('setup-bar').hidden, true);
  assert.equal(view.get('setup-resume-text').textContent, 'Finish setting up: 4 of 6 steps');
  view.lock(1);
  assert.equal(view.get('setup-resume').hidden, true, 'locking clears the setup from the screen');
});

test('an answer saved from Chrome shows in My information without losing the applicant’s own unsaved edits', async t => {
  const view = await renderer(t);
  openProfile(view);
  view.edit('lastName', 'Edited, not saved');
  view.database.profile = { ...view.database.profile, county: 'Story', city: 'Ames' };
  view.profileChanged(['county', 'city']);
  await tick(); await tick();
  assert.equal(view.get('county').value, 'Story');
  assert.equal(view.get('city').value, 'Ames');
  assert.equal(view.get('lastName').value, 'Edited, not saved');
  assert.equal(view.get('profile-save-state').hidden, false, 'the applicant’s own edit still needs saving');
  assert.equal(view.get('toast').textContent, 'An answer you saved from Chrome is now in My information.');
  view.edit('zip', '50011');
  view.database.profile = { ...view.database.profile, zip: '50309' };
  view.profileChanged(['zip']);
  await tick(); await tick();
  assert.equal(view.get('zip').value, '50011', 'a field the applicant is editing keeps their edit');
});
