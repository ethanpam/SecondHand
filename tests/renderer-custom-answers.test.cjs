'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { loadRenderer, tick, deferred, plain } = require('./helpers/harness.cjs');

const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const id = number => `a0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const answer = (number = 1) => ({ id: id(number), label: `Question ${number}`, value: `Saved answer ${number}`, aliases: [`Alternative question ${number}`] });

async function renderer(t, { customFields = [answer()], save } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://secondhand.invalid/' });
  t.after(() => dom.window.close());
  const window = dom.window;
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let locked, profileChanged;
  let status = { exists: true, unlocked: true, lockRevision: 0, extensionId: '', bridgeRunning: true };
  const database = { profile: {
    firstName: 'Fictional', lastName: 'Applicant', email: 'saved@example.invalid', customFields,
    householdMembers: [{ id: id(101), firstName: 'Fictional', lastName: 'Applicant', birthDate: '', relationship: 'self', student: '', grade: '' },
      { id: id(102), firstName: 'Other', lastName: 'Member', birthDate: '', relationship: 'other', student: 'no', grade: '' }],
    jobs: [{ id: id(103), person: 'Fictional Applicant', employer: 'Synthetic Employer', amount: '1200', frequency: 'Monthly' }]
  }, applications: [] };
  const saves = [], reviews = [];
  window.secondHand = {
    status: async () => status, getData: async () => structuredClone(database), setupProgress: async () => null,
    onLocked: callback => { locked = callback; return () => {}; }, onUnlocked: () => () => {}, onProfileChanged: callback => { profileChanged = callback; return () => {}; },
    unlock: async () => { status = { ...status, unlocked: true }; return status; },
    saveProfile: async profile => {
      saves.push(plain(profile));
      const saved = save ? await save(plain(profile)) : plain(profile);
      database.profile = structuredClone(saved);
      return saved;
    },
    reviewFields: async request => { reviews.push(plain(request)); return { profile: [], document: [], laya: { state: 'not-requested', message: '' } }; }
  };
  loadRenderer(window); await tick();
  const get = key => window.document.getElementById(key);
  const rows = () => [...get('custom-answer-list').children];
  const field = (key, index = 0) => rows()[index].querySelector(`[data-custom-field="${key}"]`);
  const navigate = view => window.document.querySelector(`.nav-item[data-view="${view}"]`).click();
  navigate('profile');
  return { window, get, rows, field, navigate, database, saves, reviews,
    edit(input, value) { input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); },
    submit() { get('profile-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
    // Remember for next time in Chrome changed the saved custom answers (#186).
    async changedElsewhere(fields) { profileChanged({ fields }); for (let i = 0; i < 4; i++) await tick(); },
    lock() { status = { ...status, unlocked: false, lockRevision: status.lockRevision + 1 }; locked({ lockRevision: status.lockRevision }); },
    async unlock() { get('passphrase').value = 'synthetic-passphrase'; get('auth-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); }
  };
}

test('custom answers load and edit as an unsaved draft; explicit Save preserves household and record edits', async t => {
  const view = await renderer(t);
  assert.equal(view.rows()[0].dataset.customId, answer().id);
  assert.equal(view.field('aliases').value, answer().aliases[0]);
  assert.deepEqual(view.saves, []);
  view.edit(view.get('email'), 'new@example.invalid');
  const member = view.get('household-members').querySelector('[data-self="false"] [data-member-field="firstName"]');
  view.edit(member, 'Edited member');
  const employer = view.window.document.querySelector('[data-record-list="jobs"] [data-record-field="employer"]');
  view.edit(employer, 'Edited employer');
  view.edit(view.field('value'), '  My explicit answer\nSecond line  ');
  view.edit(view.field('aliases'), ' Alternate wording \n\nAnother question\n');
  view.get('add-custom-answer').click();
  const added = view.rows()[1].dataset.customId;
  assert.match(added, /^[a-f0-9-]{36}$/i);
  assert.equal(view.window.document.activeElement, view.field('label', 1));
  view.edit(view.field('label', 1), 'New question');
  view.edit(view.field('value', 1), 'New explicit answer');
  assert.deepEqual(view.saves, [], 'Typing and adding never write the vault.');
  assert.equal(view.get('profile-save-state').textContent, 'Unsaved changes');
  view.submit(); await tick();
  assert.deepEqual(view.saves[0].customFields, [
    { ...answer(), value: 'My explicit answer\nSecond line', aliases: ['Alternate wording', 'Another question'] },
    { id: added, label: 'New question', value: 'New explicit answer', aliases: [] }
  ]);
  assert.equal(view.saves[0].email, 'new@example.invalid');
  assert.equal(view.saves[0].householdMembers[1].firstName, 'Edited member');
  assert.equal(view.saves[0].jobs[0].employer, 'Edited employer');
  assert.equal(view.rows()[1].dataset.customId, added, 'Saving retains stable IDs.');
  assert.equal(view.get('profile-save-state').hidden, true);
});

test('custom-answer edits during Save remain dirty and visible until the next explicit Save', async t => {
  const pending = deferred();
  let first = true;
  const view = await renderer(t, { save: value => { if (first) { first = false; return pending.promise; } return value; } });
  view.edit(view.field('value'), 'Submitted answer');
  view.submit();
  view.edit(view.field('value'), 'Newer unsaved answer');
  pending.resolve(view.saves[0]); await tick();
  assert.equal(view.field('value').value, 'Newer unsaved answer');
  assert.equal(view.get('profile-save-state').hidden, false);
  assert.equal(view.database.profile.customFields[0].value, 'Submitted answer');
  view.submit(); await tick();
  assert.equal(view.saves[1].customFields[0].value, 'Newer unsaved answer');
  assert.equal(view.get('profile-save-state').hidden, true);
});

test('removing or discarding custom answers does not save them or erase unrelated records', async t => {
  const view = await renderer(t);
  view.rows()[0].querySelector('button').click();
  assert.equal(view.rows().length, 0);
  assert.equal(view.get('custom-answers-empty').hidden, false);
  assert.deepEqual(view.saves, []);
  view.navigate('overview'); view.navigate('profile');
  assert.equal(view.rows().length, 1, 'Discard restores the saved draft.');
  assert.equal(view.rows()[0].dataset.customId, answer().id);
  view.rows()[0].querySelector('button').click();
  view.submit(); await tick();
  assert.deepEqual(view.saves[0].customFields, []);
  assert.equal(view.saves[0].jobs[0].employer, 'Synthetic Employer');
  assert.equal(view.saves[0].householdMembers.length, 2);
});

test('blank questions or answers and excess aliases stop Save with an accessible focused explanation', async t => {
  const view = await renderer(t, { customFields: [] });
  view.get('add-custom-answer').click();
  view.get('custom-answers').open = false;
  view.submit(); await tick();
  assert.match(view.get('custom-answers-error').textContent, /question label/);
  assert.equal(view.get('custom-answers-error').getAttribute('role'), 'alert');
  assert.equal(view.get('custom-answers').open, true);
  assert.equal(view.window.document.activeElement, view.field('label'));
  view.edit(view.field('label'), 'Explicit question');
  view.edit(view.field('value'), ' \n ');
  view.submit(); await tick();
  assert.match(view.get('custom-answers-error').textContent, /Enter your answer/);
  assert.equal(view.window.document.activeElement, view.field('value'));
  view.edit(view.field('value'), 'Explicit answer');
  for (const aliases of ['a\nb\nc\nd\ne\nf', 'a'.repeat(121)]) {
    view.edit(view.field('aliases'), aliases); view.submit(); await tick();
    assert.match(view.get('custom-answers-error').textContent, /up to 5 aliases/);
    assert.equal(view.rows()[0].querySelector('details').open, true);
    assert.equal(view.window.document.activeElement, view.field('aliases'));
  }
  assert.deepEqual(view.saves, []);
  view.edit(view.field('aliases'), 'One alternate label');
  view.submit(); await tick();
  assert.equal(view.saves.length, 1);
});

test('custom-answer limits are visible and removing a row restores capacity', async t => {
  const view = await renderer(t, { customFields: Array.from({ length: 50 }, (_, index) => answer(index + 1)) });
  assert.equal(view.get('add-custom-answer').disabled, true);
  assert.equal(view.get('custom-answers-limit').hidden, false);
  assert.equal(view.get('custom-answers-count').textContent, '50 of 50');
  view.get('add-custom-answer').click(); assert.equal(view.rows().length, 50);
  view.rows()[10].querySelector('button').click();
  assert.equal(view.get('add-custom-answer').disabled, false);
  view.get('add-custom-answer').click();
  assert.equal(view.rows().length, 50);
  assert.equal(view.field('label').maxLength, 120);
  assert.equal(view.field('value').maxLength, 1000);
  assert.equal(view.rows()[49].querySelector('button').getAttribute('aria-label'), 'Remove custom answer 50');
});

test('custom answers are text-only, stay out of review/model requests, and clear on lock despite a late Save', async t => {
  const pending = deferred();
  const malicious = { ...answer(), label: '<img src=x onerror=alert(1)>', value: '<script>private answer</script>', aliases: ['<b>private alias</b>'] };
  const view = await renderer(t, { customFields: [malicious], save: () => pending.promise });
  assert.equal(view.get('custom-answer-list').querySelector('img, script, b'), null);
  assert.equal(view.field('value').value, malicious.value);
  view.get('check-profile-fields').click(); await tick();
  assert.equal(Object.hasOwn(view.reviews[0].profile, 'customFields'), false);
  assert.equal(JSON.stringify(view.reviews).includes('private answer'), false);
  assert.equal(view.reviews[0].useLaya, false);
  view.submit(); view.lock();
  assert.equal(view.rows().length, 0);
  assert.equal(view.get('custom-answers').open, false);
  assert.equal(view.get('custom-answers-error').textContent, '');
  assert.equal(view.window.document.documentElement.outerHTML.includes('private answer'), false);
  pending.resolve(view.saves[0]); await tick();
  assert.equal(view.rows().length, 0, 'Late Save cannot restore locked answers.');
  await view.unlock();
  assert.equal(view.field('value').value, malicious.value);
  assert.equal(view.window.localStorage.length, 0);
  assert.equal(view.window.sessionStorage.length, 0);
});

// Remember for next time (#186): an answer saved from a page keeps its question's kind, its choices, and the site it came from.
const fromPage = (number, changes = {}) => ({ id: id(number), label: 'How did you hear about us?', value: 'Church', aliases: [], type: 'radio', options: ['Friend', 'Church', 'Flyer'],
  site: 'https://pantry.example.org', ...changes });

test('an answer saved from a page shows the site it came from, offers only its own choices, and keeps its kind and choices when saved', async t => {
  const emplid = fromPage(3, { label: 'EMPLID', value: 'SYN-4471', type: 'text', options: [], site: 'https://wic.example.org' });
  const view = await renderer(t, { customFields: [answer(), fromPage(2), emplid] });
  const site = index => view.rows()[index].querySelector('.custom-answer-site');
  assert.equal(site(0), null, 'an answer typed here has no site');
  assert.equal(site(1).textContent, 'Saved from pantry.example.org with Remember for next time.');
  assert.equal(site(2).textContent, 'Saved from wic.example.org with Remember for next time.');
  const choice = view.field('value', 1);
  assert.equal(choice.tagName, 'SELECT');
  assert.deepEqual([...choice.options].map(option => option.value), ['Friend', 'Church', 'Flyer']);
  assert.equal(choice.value, 'Church');
  assert.equal(view.field('value', 2).tagName, 'TEXTAREA');
  choice.value = 'Flyer'; for (const type of ['input', 'change']) choice.dispatchEvent(new view.window.Event(type, { bubbles: true }));
  view.edit(view.field('value', 2), 'SYN-9000');
  assert.equal(view.get('profile-save-state').textContent, 'Unsaved changes');
  view.submit(); await tick();
  assert.deepEqual(view.saves[0].customFields, [answer(), fromPage(2, { value: 'Flyer' }), { ...emplid, value: 'SYN-9000' }]);
});

test('answers remembered in Chrome show in Custom answers at once, and join an unsaved draft without losing its edits', async t => {
  const view = await renderer(t);
  view.database.profile = { ...view.database.profile, customFields: [answer(), fromPage(2)] };
  await view.changedElsewhere(['customFields']);
  assert.deepEqual(view.rows().map(row => row.dataset.customId), [answer().id, id(2)]);
  assert.equal(view.get('toast').textContent, 'An answer you chose to remember in Chrome is now in My information, under Custom answers.');
  assert.equal(view.get('profile-save-state').hidden, true);

  // With unsaved edits here, the new answer joins the draft and the edits stay.
  view.edit(view.field('value'), 'My unsaved edit');
  view.database.profile = { ...view.database.profile, customFields: [answer(), { ...fromPage(2), value: 'Flyer' }, fromPage(3, { label: 'EMPLID', value: 'SYN-4471', type: 'text', options: [] })] };
  await view.changedElsewhere(['customFields']);
  assert.deepEqual(view.rows().map(row => row.dataset.customId), [answer().id, id(2), id(3)]);
  assert.equal(view.field('value').value, 'My unsaved edit');
  assert.equal(view.field('value', 1).value, 'Flyer', 'an answer not edited here takes the one remembered in Chrome');
  assert.equal(view.get('profile-save-state').hidden, false);
  view.submit(); await tick();
  assert.deepEqual(view.saves[0].customFields.map(item => item.value), ['My unsaved edit', 'Flyer', 'SYN-4471']);
});

test('Custom answers says which answers wait for approval, and how an answer saved from a form matches', async t => {
  const view = await renderer(t);
  const hints = [...view.get('custom-answers').querySelectorAll(':scope > .field-hint')].map(hint => hint.textContent).join(' ');
  assert.match(hint(hints), /An answer you saved from a form with Remember for next time matches only the same question, in the same kind of box, with the same choices\./);
  assert.match(hint(hints), /Answers about a sensitive subject, such as income, health, citizenship, or a date of birth, wait for Fill sensitive details in Chrome unless you chose Always allow\./);
  assert.doesNotMatch(hints, /Custom answers are sensitive/);
});
const hint = text => text.replace(/\s+/g, ' ');
