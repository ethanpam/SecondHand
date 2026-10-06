'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const schema = require('../shared/schema.cjs');
const { PORTAL_URL, FIELD_LABELS } = schema;
const realLaya = require('../desktop/laya.cjs');
const { plain, tick, startMain } = require('./helpers/harness.cjs');

const extensionId = 'a'.repeat(32);
const context = { extensionId };
// The day every test here runs on (#135): ages and birth-date checks never depend on when the tests run.
// A test may name another day (`today`), or its own environment (`env`) to run on the clock.
const TODAY = '2026-10-05';
const IDLE_MS = 10 * 60 * 1000;
// Each desktop's data folder: its own empty one inside this temporary folder. Settings, setup progress and
// the vault are stand-ins; the real Laya runtime and Touch ID look in the folder and find nothing.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-assistance-main-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const customRecord = (n = 1, changes = {}) => ({ id: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`, label: 'Pickup location', value: 'North entrance', aliases: ['Pickup point'], ...changes });
const customRequest = changes => ({ type: 'getCustomFields', url: 'https://pantry.example.org/intake', fields: [{ id: 'field1', label: 'Pickup point', type: 'text' }], ...changes });
const customSettings = changes => ({ extensionId, trustedSites: ['https://pantry.example.org'], ...changes });

// An everyday custom answer follows getFields' ordinary approval; only one about a sensitive subject waits for Fill
// sensitive details (#186).
test('custom answers disclose only exact matched question IDs and values after one approval, never the saved catalog', async () => {
  const app = await desktop({ settings: customSettings(), profile: { customFields: [customRecord(), customRecord(2, { label: 'Diet notes', aliases: [], value: 'Private unrelated answer' })] } });
  const response = plain(await app.request(customRequest()));
  assert.deepEqual(response.values, { field1: 'North entrance' });
  assert.deepEqual(Object.keys(response).sort(), ['accessRevision', 'values']);
  assert.equal(app.prompts.length, 1); assert.equal(app.prompts[0].title, 'Let Chrome fill this form?');
  assert.match(app.prompts[0].detail, /Pickup point: "North entrance"/);
  assert.doesNotMatch(app.prompts[0].detail, /Private unrelated answer|00000000/);
  assert.equal(app.writes.length, 0);
});

test('custom answer capability appears only for an unlocked nonempty vault and carries no labels or count', async () => {
  const app = await desktop({ profile: { customFields: [customRecord()] } });
  const available = plain(await app.request({ type: 'status' }));
  assert.equal(available.customFieldsAvailable, true); assert.doesNotMatch(JSON.stringify(available), /Pickup|North entrance|customFieldsCount/);
  await app.invoke('lock');
  assert.equal((await app.request({ type: 'status' })).customFieldsAvailable, undefined);
  const empty = await desktop(); assert.equal((await empty.request({ type: 'status' })).customFieldsAvailable, undefined);
});

test('custom request scope, trust, extension identity and metadata are checked before profile access', async () => {
  const app = await desktop({ settings: customSettings({ autofillWithoutAsking: true }), profile: { customFields: [customRecord()] } });
  for (const changes of [{ url: PORTAL_URL }, { url: 'http://pantry.example.org' }, { url: 'https://untrusted.example.org' }, { fields: [{ id: 'field1', label: 'Pickup point', type: 'password' }] }, { customFields: [customRecord()] }]) await assert.rejects(app.request(customRequest(changes)));
  assert.equal(app.dataReads, 0); assert.equal(app.prompts.length, 0);
  const other = await desktop({ settings: customSettings({ extensionId: 'b'.repeat(32), autofillWithoutAsking: true }), profile: { customFields: [customRecord()] } });
  await assert.rejects(other.request(customRequest()), /access changed/); assert.equal(other.dataReads, 0);
  await app.invoke('lock'); await assert.rejects(app.request(customRequest()), /Unlock/);
});

test('ambiguous, unsafe, and missing custom answers send no values and show no dialog', async () => {
  for (const records of [[], [customRecord(), customRecord(2)], [customRecord(1, { label: 'Password', aliases: ['Pickup point'] })]]) {
    const app = await desktop({ settings: customSettings(), profile: { customFields: records } });
    assert.deepEqual(plain((await app.request(customRequest())).values), {}); assert.equal(app.prompts.length, 0);
  }
});

test('custom answer cancellation returns no values; existing per-site/global Always allow skips the prompt', async () => {
  const cancelled = await desktop({ settings: customSettings(), profile: { customFields: [customRecord()] } });
  cancelled.answer(async () => ({ response: 0 })); assert.deepEqual(plain((await cancelled.request(customRequest())).values), {});
  for (const settings of [customSettings({ autofillWithoutAsking: true }), customSettings({ alwaysAllowedSites: ['https://pantry.example.org'] })]) {
    const app = await desktop({ settings, profile: { customFields: [customRecord()] } });
    assert.deepEqual(plain((await app.request(customRequest())).values), { field1: 'North entrance' }); assert.equal(app.prompts.length, 0);
  }
});

test('Always allow on this site returns the updated custom receipt and does not authorize another origin', async () => {
  // Always allow on this site comes with the sensitive prompt: a custom answer about a sensitive subject (#186).
  const income = customRecord(1, { label: 'Monthly income', aliases: [], value: '1200' });
  const incomeRequest = changes => customRequest({ fields: [{ id: 'field1', label: 'Monthly income', type: 'number' }], sensitive: true, ...changes });
  const app = await desktop({ settings: customSettings({ trustedSites: ['https://pantry.example.org', 'https://other.example.org'] }), profile: { customFields: [income] } });
  const before = (await app.request({ type: 'status' })).accessRevision;
  app.answer(async () => ({ response: 2 })); const result = await app.request(incomeRequest());
  assert.equal(result.accessRevision, before + 1);
  await app.request(incomeRequest()); assert.equal(app.prompts.length, 1);
  await app.request(incomeRequest({ url: 'https://other.example.org/form' })); assert.equal(app.prompts.length, 2);
});

for (const mutation of ['lock', 'profile', 'registration', 'trust']) test(`pending custom approval releases nothing after ${mutation}`, async () => {
  const app = await desktop({ settings: customSettings(), profile: { customFields: [customRecord()] } });
  let resolve; app.answer(() => new Promise(done => { resolve = done; }));
  const pending = app.request(customRequest()); await tick();
  await assert.rejects(app.request(customRequest()), /waiting for your approval/);
  if (mutation === 'lock') { await app.invoke('lock'); await app.invoke('unlock', 'synthetic'); }
  if (mutation === 'profile') await app.invoke('saveProfile', { customFields: [customRecord(1, { value: 'Changed answer' })] });
  if (mutation === 'registration') { await app.invoke('connectExtension', 'b'.repeat(32)); await app.invoke('connectExtension', extensionId); }
  if (mutation === 'trust') await app.request({ type: 'untrustSite', url: 'https://pantry.example.org' });
  resolve({ response: 1 }); await assert.rejects(pending, /access changed/);
});

test('general-site navigation returns only a fresh receipt and reads no profile fields', async () => {
  const app = await desktop({ settings: customSettings() });
  const result = plain(await app.request({ type: 'authorizeSiteNavigation', url: 'https://pantry.example.org/form' }));
  assert.deepEqual(Object.keys(result), ['accessRevision']); assert.ok(Number.isSafeInteger(result.accessRevision));
  assert.equal(app.dataReads, 0); assert.equal(app.prompts.length, 1);
  assert.match(app.prompts[0].detail, /send entered answers/); assert.match(app.prompts[0].detail, /does not authorize consent, signatures, certification, payments, or final submission/);
  for (const changes of [{ url: PORTAL_URL }, { url: 'https://other.example.org' }, { url: 'http://pantry.example.org' }, { fields: [] }]) await assert.rejects(app.request({ type: 'authorizeSiteNavigation', url: 'https://pantry.example.org/form', ...changes }));
  assert.equal(app.dataReads, 0);
});

test('general-site navigation honors existing Always allow and rejects cancelled or stale approval', async () => {
  const request = { type: 'authorizeSiteNavigation', url: 'https://pantry.example.org/form' };
  for (const settings of [customSettings({ autofillWithoutAsking: true }), customSettings({ alwaysAllowedSites: ['https://pantry.example.org'] })]) {
    const app = await desktop({ settings }); await app.request(request); assert.equal(app.prompts.length, 0); assert.equal(app.dataReads, 0);
  }
  const app = await desktop({ settings: customSettings() });
  app.answer(async () => ({ response: 0 })); await assert.rejects(app.request(request), /cancelled/);
  let resolve; app.answer(() => new Promise(done => { resolve = done; }));
  const pending = app.request(request); await tick(); await app.invoke('lock'); await app.invoke('unlock', 'synthetic');
  resolve({ response: 1 }); await assert.rejects(pending, /access changed/);
});

test('expanded SNAP answers are Iowa-only even when another site is trusted; record lists never leave the vault', async () => {
  const app = await desktop({ profile: { iowaResident: 'yes', ssnCardFirstName: 'Synthetic', jobs: [{ employer: 'Private' }] },
    settings: { extensionId, autofillWithoutAsking: true, allSites: true, trustedSites: ['https://pantry.example.org'] } });
  for (const key of schema.SNAP_IOWA_ONLY_FIELDS) {
    await assert.rejects(app.request({ type: 'getFields', url: 'https://pantry.example.org/intake', fields: [key] }), /only be shared with Iowa/);
  }
  for (const key of schema.LIST_FIELDS) for (const url of [PORTAL_URL, 'https://pantry.example.org/intake']) {
    await assert.rejects(app.request({ type: 'getFields', url, fields: [key] }), /doesn’t share/);
  }
  assert.equal(app.dataReads, 0, 'blocked requests do not even read the profile');
  assert.equal(app.prompts.length, 0);
  const response = await app.request({ type: 'getFields', fields: ['iowaResident', 'ssnCardFirstName'] });
  assert.deepEqual(plain(response.values), { iowaResident: 'yes', ssnCardFirstName: 'Synthetic' });
});

// The real main process with Electron simulated (tests/helpers/harness.cjs). The vault, its files and the
// bridge are stand-ins; Laya is the real runtime unless a test gives `laya`.
async function desktop(options = {}) {
  const userData = fs.mkdtempSync(path.join(scratch, 'app-'));
  let dataReads = 0;
  const writes = [];
  const removed = [];
  let setupFile = options.setup === undefined ? null : typeof options.setup === 'string' ? options.setup : JSON.stringify(options.setup);
  let answer = async () => ({ response: 1 });
  const prompts = [];
  const opened = [];
  let registrations = 0;
  class Vault {
    // `options.profile`: information saved earlier, as the vault reads it back, without today's checks.
    // `options.applications`: application records saved earlier.
    constructor() {
      this.unlocked = true;
      this.data = { profile: options.profile ? structuredClone(options.profile) : { firstName: 'Synthetic', lastName: '' }, applications: structuredClone(options.applications ?? []) };
    }
    async exists() { return true; }
    async inspect() { return { recoveryKey: true }; }
    async lock() { if (options.beforeLock) await options.beforeLock(); this.unlocked = false; }
    async unlock() { this.unlocked = true; }
    getData() { dataReads++; return this.data; }
    async update(change) { change(this.data); }
  }
  const main = await startMain({
    userData, packaged: options.packaged === true,
    env: options.env ?? { SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_TODAY: options.today ?? TODAY },
    dialog: { async showMessageBox(_parent, options) { prompts.push(options); return answer(); } },
    electron: { shell: { async openPath(folder) { opened.push(folder); return ''; } } },
    modules: {
      // settings.json from `options.settings`; the guided setup's progress file from `options.setup` (none by default), as written since.
      'node:fs/promises': { mkdir: async () => {}, stat: async () => ({ size: 10 }), rm: async file => { removed.push(file); if (file.endsWith('setup-progress.json')) setupFile = null; },
        readFile: async file => {
          if (!String(file).endsWith('setup-progress.json')) return JSON.stringify(options.settings ?? { extensionId });
          if (setupFile === null) throw Object.assign(new Error('No such file'), { code: 'ENOENT' });
          return setupFile;
        } },
      // `options.beforeWrite(file)` runs before each write, for a test that acts while one is under way.
      './vault.cjs': { Vault, atomicWrite: async (file, bytes) => {
        await options.beforeWrite?.(file);
        writes.push({ file, json: JSON.parse(bytes.toString()) });
        if (file.endsWith('setup-progress.json')) setupFile = bytes.toString();
      }, MAX_VAULT_BYTES: 1000 },
      './extension-setup.cjs': options.extensionCopy?.module ?? { getExtensionSetup: async () => ({ prepared: true }) },
      './registration.cjs': { registerHost: async () => { registrations++; return {}; } },
      // The real schema. A record main.cjs builds here (recordProgress) has this vm context's Object prototype,
      // which the schema's plain-object check refuses; in the app both share one realm, so it is copied across.
      '../shared/schema.cjs': { ...schema, validateApplication: (input, existing) => schema.validateApplication(JSON.parse(JSON.stringify(input)), existing) },
      // The app's one Laya runtime (#38). Without an override it is the real one with the shipped model,
      // minus its background download and update checks (tests/desktop-laya-main.test.cjs covers those).
      './laya.cjs': { ...realLaya, createLaya: runtimeOptions => options.laya ?? { ...realLaya.createLaya(runtimeOptions), startUpdates() {}, update() {} } }
    }
  });
  // The idle lock's timers now armed: set, and not cleared or run.
  const armed = () => main.timers.filter(timer => timer.ms === IDLE_MS && !timer.cleared);
  return {
    userData, prompts, notifications: main.sent, writes, removed,
    idleTimers: () => armed().map(timer => timer.ms),
    // Runs the armed idle lock, as ten minutes without activity would.
    async idle() {
      const timers = armed();
      assert.equal(timers.length, 1, 'one idle lock is armed');
      timers[0].cleared = true;
      timers[0].callback();
      for (let i = 0; i < 5; i++) await tick();
    },
    get shows() { return main.shows; },
    get dataReads() { return dataReads; },
    get registrations() { return registrations; },
    opened,
    answer: callback => { answer = callback; },
    request: request => main.bridge({ id: 'synthetic', url: PORTAL_URL, ...request }, context),
    invoke: main.invoke,
    async sleep() { main.powerEvents.get('suspend')(); await tick(); }
  };
}

test('renderer lock status and notifications identify each completed lock monotonically', async () => {
  const app = await desktop();
  assert.equal((await app.invoke('status')).lockRevision, 0);
  const first = await app.invoke('lock');
  assert.equal(first.lockRevision, 1);
  assert.equal(first.unlocked, false);
  assert.equal(app.notifications[0][0], 'secondhand:locked');
  assert.deepEqual(JSON.parse(JSON.stringify(app.notifications[0][1])), { lockRevision: 1 });
  assert.equal((await app.invoke('unlock', 'synthetic-passphrase')).lockRevision, 1);
  await app.sleep();
  assert.equal((await app.invoke('status')).lockRevision, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(app.notifications[1][1])), { lockRevision: 2 });
});

test('ten minutes without activity lock SecondHand: the access receipt moves on, the window hears of it, and saved answers are refused', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  assert.deepEqual(app.idleTimers(), [], 'nothing is armed before any activity');
  await app.request({ type: 'getFields', fields: ['firstName'] });
  await app.invoke('getData');
  assert.deepEqual(app.idleTimers(), [IDLE_MS], 'activity starts the ten minutes again: one idle lock is armed');
  const before = (await app.request({ type: 'status' })).accessRevision;
  const notified = app.notifications.length;

  await app.idle();
  const status = await app.invoke('status');
  assert.equal(status.unlocked, false);
  assert.equal(status.lockRevision, 1);
  assert.deepEqual(app.notifications.slice(notified).map(plain), [['secondhand:locked', { lockRevision: 1 }]]);
  assert.ok((await app.request({ type: 'status' })).accessRevision > before, 'access receipts from before the lock are outdated');
  await assert.rejects(app.request({ type: 'getFields', fields: ['firstName'] }), /Unlock SecondHand first/);
  assert.deepEqual(app.idleTimers(), [], 'nothing is armed while locked');
  await app.invoke('unlock', 'synthetic password');
  assert.deepEqual(app.idleTimers(), [IDLE_MS], 'an unlock starts the ten minutes');
});

test('trusted autofill returns saved values with no dialog; lock still blocks it', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  assert.equal((await app.invoke('status')).autofillWithoutAsking, true);
  const { values } = await app.request({ type: 'getFields', fields: ['firstName', 'lastName'] });
  assert.deepEqual(plain(values), { firstName: 'Synthetic' });
  assert.equal(app.prompts.length, 0);
  await app.invoke('lock');
  await assert.rejects(app.request({ type: 'getFields', fields: ['firstName'] }), /Unlock/);
  assert.equal(app.prompts.length, 0);
});

test('untrusted autofill asks once per click with Allow once, Always allow, and Cancel', async () => {
  const app = await desktop();
  app.answer(async () => ({ response: 1 }));
  assert.equal((await app.request({ type: 'getFields', fields: ['firstName'] })).values.firstName, 'Synthetic');
  assert.deepEqual(plain(app.prompts[0].buttons), ['Cancel', 'Allow once', 'Always allow on this computer']);
  // Always allow covers sensitive details too (#175), and the prompt that turns it on says so.
  assert.match(app.prompts[0].detail, /Choose “Always allow” to let the SecondHand extension fill without asking whenever this app is unlocked, on every site SecondHand is on\. That includes your Social Security number, birth date, income, benefits, and citizenship and disability answers\. You can turn it off on the Chrome extension page\./);
  assert.match(app.prompts[0].detail, /initial applicant page/);
  assert.match(app.prompts[0].detail, /first possible home-address suggestion and choose Save and Continue/);
  assert.match(app.prompts[0].detail, /home-address suggestions only/);
  assert.match(app.prompts[0].detail, /does not authorize consent, signatures, or submitting/);
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request({ type: 'getFields', fields: ['firstName'] }), /cancelled/);
  app.answer(async () => ({ response: 2 }));
  await app.request({ type: 'getFields', fields: ['firstName'] });
  assert.equal((await app.invoke('status')).autofillWithoutAsking, true);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: true, trustedSites: [] });
  await app.request({ type: 'getFields', fields: ['firstName'] });
  assert.equal(app.prompts.length, 3, 'no dialog after Always allow');
});

test('exact Iowa navigation authorization reads no saved profile values and follows existing trust or consent', async t => {
  for (const page of ['enterPersonalInfo', 'addressValidation', 'dynamicQuestions', 'dynamicQuestionsStart', 'ssaVerificationRender']) for (const trusted of [false, true]) {
    await t.test(`${page}, trusted=${trusted}`, async () => {
      const app = await desktop({ settings: { extensionId, autofillWithoutAsking: trusted } });
      const response = await app.request({ type: 'getFields', url: `${PORTAL_URL}/applyForBenefits/${page}`, fields: [] });
      assert.deepEqual(plain(response.values), {});
      assert.deepEqual(Object.keys(response).sort(), ['accessRevision', 'values']);
      assert.equal(Number.isSafeInteger(response.accessRevision), true);
      assert.equal(app.dataReads, 0, 'Navigation authorization must not read the profile');
      assert.equal(app.prompts.length, trusted ? 0 : 1);
      if (!trusted) {
        assert.match(app.prompts[0].detail, /No saved profile fields will be read/);
        assert.match(app.prompts[0].detail, /verified Tell Us More page/);
        assert.match(app.prompts[0].detail, /first possible home-address suggestion and choose Save and Continue/);
      }
      await app.invoke('lock');
      await assert.rejects(app.request({ type: 'getFields', url: `${PORTAL_URL}/applyForBenefits/${page}`, fields: [] }), /Unlock/);
      assert.equal(app.dataReads, 0);
    });
  }
  const app = await desktop();
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request({ type: 'getFields', url: `${PORTAL_URL}/applyForBenefits/addressValidation`, fields: [] }), /cancelled/);
  assert.equal(app.dataReads, 0);
});

test('access receipts advance for lock, profile, trust, and extension changes independently of renderer lock revisions', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  let revision = (await app.request({ type: 'status' })).accessRevision;
  assert.equal(Number.isSafeInteger(revision), true);
  const restarted = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  assert.notEqual((await restarted.request({ type: 'status' })).accessRevision, revision, 'A new desktop process cannot reuse a prior access receipt');
  assert.equal((await app.request({ type: 'getFields', fields: ['firstName'] })).accessRevision, revision);
  const mutations = [
    () => app.invoke('lock'),
    async () => { await app.invoke('unlock', 'synthetic password'); await app.invoke('saveProfile', { firstName: 'Updated synthetic name' }); },
    () => app.invoke('setAutofillTrust', false),
    () => app.request({ type: 'trustSite', url: 'https://pantry.example.org/intake' }),
    () => app.invoke('removeTrustedSite', 'https://pantry.example.org'),
    () => app.request({ type: 'trustAllSites' }),
    () => app.request({ type: 'untrustAllSites' }),
    async () => { await app.request({ type: 'trustAllSites' }); await app.invoke('turnOffAllSites'); },
    async () => { await app.invoke('connectExtension', 'b'.repeat(32)); await app.invoke('connectExtension', extensionId); }
  ];
  for (const mutate of mutations) {
    await mutate();
    const next = (await app.request({ type: 'status' })).accessRevision;
    assert.equal(Number.isSafeInteger(next), true);
    assert.ok(next > revision);
    revision = next;
  }
  assert.equal((await app.invoke('status')).lockRevision, 1);
  const receipt = await app.request({ type: 'getFields', url: `${PORTAL_URL}/applyForBenefits/addressValidation`, fields: [] });
  assert.equal(receipt.accessRevision, revision);
  app.answer(async () => ({ response: 2 }));
  const trustedReceipt = await app.request({ type: 'getFields', url: `${PORTAL_URL}/applyForBenefits/addressValidation`, fields: [] });
  assert.ok(trustedReceipt.accessRevision > revision, 'Always allow returns the post-approval revision');
  assert.equal(trustedReceipt.accessRevision, (await app.request({ type: 'status' })).accessRevision);
});

test('pending consent cannot authorize after a profile edit, trust change, or extension identity round trip', async t => {
  for (const mutation of ['profile', 'trust', 'registration']) await t.test(mutation, async () => {
    const app = await desktop();
    let resolve;
    app.answer(() => new Promise(done => { resolve = done; }));
    const pending = app.request({ type: 'getFields', url: `${PORTAL_URL}/applyForBenefits/addressValidation`, fields: [] });
    if (mutation === 'profile') await app.invoke('saveProfile', { firstName: 'Updated synthetic name' });
    if (mutation === 'trust') await app.invoke('setAutofillTrust', false);
    if (mutation === 'registration') { await app.invoke('connectExtension', 'b'.repeat(32)); await app.invoke('connectExtension', extensionId); }
    resolve({ response: 2 });
    await assert.rejects(pending, /changed/);
    assert.equal((await app.invoke('status')).autofillWithoutAsking, false);
    assert.equal(app.dataReads, 0);
  });
});

test('an access receipt issued while a queued lock settles cannot survive the next unlock', async () => {
  let finishLock;
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true }, beforeLock: () => new Promise(resolve => { finishLock = resolve; }) });
  const locking = app.invoke('lock');
  const receipt = await app.request({ type: 'getFields', url: `${PORTAL_URL}/applyForBenefits/addressValidation`, fields: [] });
  finishLock();
  await locking;
  await app.invoke('unlock', 'synthetic-password');
  const status = await app.request({ type: 'status' });
  assert.equal(status.unlocked, true);
  assert.ok(status.accessRevision > receipt.accessRevision);
});

test('a late approval after lock and unlock is rejected', async () => {
  const app = await desktop();
  let resolve;
  app.answer(() => new Promise(done => { resolve = done; }));
  const pending = app.request({ type: 'getFields', fields: ['firstName'] });
  await app.invoke('lock');
  await app.invoke('unlock', 'synthetic-passphrase');
  resolve({ response: 2 });
  await assert.rejects(pending, /changed/);
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);
});

// The next prompt waits until the test answers it; any prompt after it is cancelled at once.
function holdPrompt(app) {
  let respond;
  app.answer(() => respond ? Promise.resolve({ response: 0 }) : new Promise(resolve => { respond = response => resolve({ response }); }));
  return {
    async shown() { await until(() => Boolean(respond)); },
    answer: response => respond(response)
  };
}
const WIC = 'https://wic.example.gov';
// Changes to SecondHand's access while a prompt is open, and the refusal each one gives the approval.
const ACCESS_CHANGES = {
  lock: [app => app.invoke('lock'), /Unlock SecondHand first/],
  'lock and unlock': [async app => { await app.invoke('lock'); await app.invoke('unlock', 'synthetic password'); }, /SecondHand access changed/],
  'another site turned off': [app => app.request({ type: 'untrustSite', url: `${WIC}/apply` }), /SecondHand access changed/],
  'all websites turned off': [app => app.request({ type: 'untrustAllSites' }), /SecondHand access changed/]
};

test('a lock or a site turned off while “Trust this site?” is open trusts nothing', async t => {
  for (const [change, [apply, refusal]] of Object.entries(ACCESS_CHANGES)) await t.test(change, async () => {
    const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: [WIC], allSites: true } });
    const prompt = holdPrompt(app);
    const pending = app.request({ type: 'trustSite', url: PANTRY });
    await prompt.shown();
    await apply(app);
    prompt.answer(1);
    await assert.rejects(pending, refusal);
    if (change === 'lock') await app.invoke('unlock', 'synthetic password');
    assert.equal((await app.invoke('status')).trustedSites.includes('https://pantry.example.org'), false);
    assert.equal(app.writes.some(write => write.json.trustedSites?.includes('https://pantry.example.org')), false, 'nothing about the site is saved');
  });
});

test('a lock or a site turned off while “Trust all websites?” is open turns nothing on', async t => {
  for (const change of ['lock', 'lock and unlock', 'another site turned off']) await t.test(change, async () => {
    const [apply, refusal] = ACCESS_CHANGES[change];
    const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: [WIC] } });
    const prompt = holdPrompt(app);
    const pending = app.request({ type: 'trustAllSites' });
    await prompt.shown();
    await apply(app);
    prompt.answer(1);
    await assert.rejects(pending, refusal);
    assert.equal((await app.request({ type: 'status' })).allSites, false);
    assert.equal(app.writes.some(write => write.json.allSites), false, 'nothing is saved');
  });
});

test('a lock while an approved trust is being saved refuses the reply', async t => {
  for (const type of ['trustSite', 'trustAllSites']) for (const change of ['lock', 'lock and unlock']) await t.test(`${type}, ${change}`, async () => {
    const [apply, refusal] = ACCESS_CHANGES[change];
    let app;
    let saving = false;
    app = await desktop({ settings: { extensionId, autofillWithoutAsking: true }, beforeWrite: async file => { if (saving && file.endsWith('settings.json')) { saving = false; await apply(app); } } });
    saving = true;
    await assert.rejects(app.request({ type, url: PANTRY }), refusal);
  });
});

test('a lock or the site turned off while “Save to My information?” is open saves nothing', async t => {
  for (const [change, [apply, refusal]] of Object.entries(ACCESS_CHANGES)) await t.test(change, async () => {
    const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: [WIC], allSites: true } });
    const prompt = holdPrompt(app);
    const pending = app.request({ type: 'saveFields', url: `${WIC}/apply`, fields: { county: 'Story' } });
    await prompt.shown();
    await apply(app);
    prompt.answer(1);
    await assert.rejects(pending, refusal);
    if (change === 'lock') await app.invoke('unlock', 'synthetic password');
    assert.equal(plain(await app.invoke('getData')).profile.county, undefined);
    assert.equal(app.notifications.some(([channel]) => channel === 'secondhand:profile-changed'), false);
  });
});

test('one trust prompt at a time: a second trust request waits for the first one’s answer', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  const prompt = holdPrompt(app);
  const first = app.request({ type: 'trustAllSites' });
  await prompt.shown();
  await assert.rejects(app.request({ type: 'trustAllSites' }), /Another request is waiting for your approval/);
  await assert.rejects(app.request({ type: 'trustSite', url: PANTRY }), /Another request is waiting for your approval/);
  assert.equal(app.prompts.length, 1, 'one prompt');
  prompt.answer(1);
  assert.deepEqual(plain(await first), { allSites: true });
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await app.request({ type: 'trustSite', url: PANTRY })), { trusted: true, origin: 'https://pantry.example.org' }, 'the next one asks once the first is answered');
});

test('SecondHand trusts at most 50 sites one by one: the 51st is refused until one is removed', async () => {
  const fifty = Array.from({ length: 50 }, (_, n) => `https://site-${n}.example.org`);
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: fifty } });
  app.answer(async () => ({ response: 1 }));
  const writes = app.writes.length;
  await assert.rejects(app.request({ type: 'trustSite', url: PANTRY }), /Remove a trusted site before adding another/);
  assert.equal(app.writes.length, writes, 'nothing is saved');
  assert.deepEqual(plain((await app.invoke('status')).trustedSites), fifty);
  assert.deepEqual(plain(await app.request({ type: 'trustSite', url: `${fifty[7]}/form` })), { trusted: true, origin: fifty[7] }, 'a site already trusted stays trusted');
  await app.invoke('removeTrustedSite', fifty[0]);
  assert.deepEqual(plain(await app.request({ type: 'trustSite', url: PANTRY })), { trusted: true, origin: 'https://pantry.example.org' });
  assert.equal(app.writes.at(-1).json.trustedSites.length, 50);
  const tooMany = await desktop({ settings: { extensionId, trustedSites: [...fifty, 'https://one-more.example.org', fifty[0]] } });
  assert.deepEqual(plain((await tooMany.invoke('status')).trustedSites), fifty, 'a saved list longer than 50 keeps the first 50');
});

test('the trust switch round-trips through the renderer and resets for a new extension ID', async () => {
  const app = await desktop();
  assert.equal((await app.invoke('setAutofillTrust', true)).autofillWithoutAsking, true);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: true, trustedSites: [] });
  await assert.rejects(app.invoke('setAutofillTrust', 'yes'), /Invalid setting/);
  await app.invoke('connectExtension', 'b'.repeat(32));
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);
  assert.deepEqual(app.writes.at(-1).json, { extensionId: 'b'.repeat(32), autofillWithoutAsking: false, trustedSites: [] });
  const untrusted = await desktop({ settings: { extensionId: 'c'.repeat(32), autofillWithoutAsking: true } });
  await assert.rejects(untrusted.request({ type: 'getFields', fields: ['firstName'] }), /changed/);
  assert.equal(untrusted.prompts.length, 1, 'trust only applies to the stored extension ID');
});

test('showApp brings the window forward even while locked and returns no profile data', async () => {
  const app = await desktop();
  await app.invoke('lock');
  const before = app.shows;
  assert.deepEqual(plain(await app.request({ type: 'showApp' })), { shown: true });
  assert.equal(app.shows, before + 1);
});

test('openApp relayed to a running app (the Windows relay passes it on) brings the window forward like showApp', async () => {
  const app = await desktop();
  await app.invoke('lock');
  const before = app.shows;
  assert.deepEqual(plain(await app.request({ type: 'openApp' })), { opened: 'shown' });
  assert.equal(app.shows, before + 1);
});

test('desktop releases explicit No choices but omits unknown answers', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  await app.invoke('saveProfile', { programSnap: 'yes', programFip: 'no', hasHomeAddress: 'no', mailingSameAsHome: 'no', mailingAddressLine1: 'PO Box 123' });
  const fields = ['programSnap', 'programFip', 'programMedicaid', 'hasHomeAddress', 'mailingSameAsHome', 'mailingAddressLine1'];
  const { values } = await app.request({ type: 'getFields', fields });
  assert.deepEqual(plain(values), { programSnap: 'yes', programFip: 'no', hasHomeAddress: 'no', mailingSameAsHome: 'no', mailingAddressLine1: 'PO Box 123' });
});

const PANTRY = 'https://pantry.example.org/intake';
test('a site must be trusted in the desktop before any values are released to it', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  await assert.rejects(app.request({ type: 'getFields', url: PANTRY, fields: ['firstName'] }), /isn’t trusted/);
  assert.equal(app.prompts.length, 0);
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request({ type: 'trustSite', url: PANTRY }), /cancelled/);
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await app.request({ type: 'trustSite', url: `${PANTRY}?week=2` })), { trusted: true, origin: 'https://pantry.example.org' });
  assert.match(app.prompts.at(-1).message, /pantry\.example\.org/);
  assert.deepEqual(plain((await app.invoke('status')).trustedSites), ['https://pantry.example.org']);
  assert.deepEqual(app.writes.at(-1).json.trustedSites, ['https://pantry.example.org']);
  const prompts = app.prompts.length;
  assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: ['firstName'] })).values), { firstName: 'Synthetic' });
  assert.equal(app.prompts.length, prompts, 'Always allow covers ordinary fields on trusted sites');
});

test('with Always allow on, sensitive fields fill with no dialog on a site SecondHand is on, as on Iowa’s portal (#175)', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', { firstName: 'Synthetic', ssn: '123-45-6789', monthlyEarnedIncome: '900' });
  const { values } = await app.request({ type: 'getFields', url: PANTRY, fields: ['firstName', 'ssn', 'monthlyEarnedIncome'] });
  assert.deepEqual(plain(values), { firstName: 'Synthetic', ssn: '123-45-6789', monthlyEarnedIncome: '900' });
  assert.equal(app.prompts.length, 0);
  assert.equal(plain(await app.request({ type: 'getFields', fields: ['ssn'] })).values.ssn, '123-45-6789');
  assert.equal(app.prompts.length, 0, 'Iowa keeps its own trust rules');
});

test('Always allow gives sensitive fields to no other extension ID, to no site SecondHand isn’t on, and nothing while locked', async () => {
  const sensitive = { ssn: '123-45-6789', birthDate: '1985-04-12', usCitizen: 'yes', disabled: 'no' };
  const other = await desktop({ settings: { extensionId: 'c'.repeat(32), autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await other.invoke('saveProfile', sensitive);
  // Another extension ID's Autofill gets them held back (#176), and its Fill sensitive details is asked, then refused.
  const reads = other.dataReads;
  assert.deepEqual(plain(await other.request({ type: 'getFields', url: PANTRY, fields: Object.keys(sensitive) })).held, Object.keys(sensitive));
  assert.equal(other.dataReads, reads, 'nothing is read');
  await assert.rejects(other.request({ type: 'getFields', url: PANTRY, fields: Object.keys(sensitive), sensitive: true }), /SecondHand access changed/);
  assert.equal(other.prompts.length, 1, 'another extension ID is asked, then refused');
  assert.equal(other.prompts[0].title, 'Share sensitive details?');

  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', sensitive);
  await assert.rejects(app.request({ type: 'getFields', url: 'https://never.example.net/apply', fields: Object.keys(sensitive) }), /This site isn’t trusted/);
  await app.invoke('lock');
  await assert.rejects(app.request({ type: 'getFields', url: PANTRY, fields: Object.keys(sensitive) }), /Unlock SecondHand first/);
  assert.equal(app.prompts.length, 0);
});

test('getFields says whether an SSN is saved without ever releasing the number', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  await app.invoke('saveProfile', { ssn: '123-45-6789', birthDate: '1985-04-12' });
  const response = plain(await app.request({ type: 'getFields', fields: ['birthDate', 'hasSsn'] }));
  assert.deepEqual(response.values, { birthDate: '1985-04-12', hasSsn: 'yes' });
  assert.doesNotMatch(JSON.stringify(response), /123-?45-?6789/);
  await app.invoke('saveProfile', { birthDate: '1985-04-12' });
  assert.deepEqual(plain((await app.request({ type: 'getFields', fields: ['birthDate', 'hasSsn'] })).values), { birthDate: '1985-04-12' }, 'no saved SSN leaves the answer out');
  const asking = await desktop();
  await asking.invoke('saveProfile', { ssn: '123-45-6789' });
  asking.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain((await asking.request({ type: 'getFields', fields: ['hasSsn'] })).values), { hasSsn: 'yes' });
  assert.match(asking.prompts[0].detail, /Whether you have a Social Security number/);
  assert.doesNotMatch(asking.prompts[0].detail, /123-?45-?6789/);
  // On other sites it counts as a sensitive detail: without Always allow, Autofill holds it back (#176), and
  // Fill sensitive details gets the sensitive prompt.
  const site = await desktop({ settings: { extensionId, trustedSites: ['https://pantry.example.org'] } });
  await site.invoke('saveProfile', { ssn: '123-45-6789' });
  site.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await site.request({ type: 'getFields', url: PANTRY, fields: ['hasSsn'] })).held, ['hasSsn']);
  assert.deepEqual(plain((await site.request({ type: 'getFields', url: PANTRY, fields: ['hasSsn'], sensitive: true })).values), { hasSsn: 'yes' });
  assert.equal(site.prompts.length, 1);
  assert.equal(site.prompts[0].title, 'Share sensitive details?');
  assert.deepEqual(plain(site.prompts[0].buttons), ['Cancel', 'Allow once', 'Always allow on this site']);
  assert.match(site.prompts[0].detail, /Whether you have a Social Security number/);
});

test('a saved No to having a Social Security number answers Iowa without a number', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  await app.invoke('saveProfile', { hasSsnAnswer: 'no' });
  assert.deepEqual(plain((await app.request({ type: 'getFields', fields: ['hasSsn'] })).values), { hasSsn: 'no' });
  await app.invoke('saveProfile', { hasSsnAnswer: 'yes' });
  assert.deepEqual(plain((await app.request({ type: 'getFields', fields: ['hasSsn'] })).values), { hasSsn: 'yes' });
  await assert.rejects(app.invoke('saveProfile', { ssn: '123-45-6789', hasSsnAnswer: 'no' }), /Social Security number/);
});

// What "Trust this site?" and "Trust all websites?" say about Always allow (#175).
const ALWAYS_ALLOW_INCLUDES = 'It asks before filling unless you chose Always allow. Always allow on this computer includes your Social Security number, date of birth, income and where it comes from, the benefits your household gets, money on hand, medical expenses, and your answers about citizenship, disability, blindness, health, Medicare, and having a Social Security number';
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('your citizenship, disability, blindness, health, Medicare and Social Security answers are held back on other sites without Always allow, and fill from the sensitive prompt', async () => {
  const sensitive = { usCitizen: 'yes', disabled: 'no', blind: 'no', healthLimitation: 'no', medicare: 'no', hasSsnAnswer: 'yes' };
  const everyday = { sex: 'Female', maritalStatus: 'Never Married', militaryOrVeteran: 'no', ssnCardNameMatches: 'yes' };
  const app = await desktop({ settings: { extensionId, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', { ...sensitive, ...everyday });
  app.answer(async () => ({ response: 1 }));
  for (const field of Object.keys(sensitive)) {
    const before = app.prompts.length;
    const autofill = plain(await app.request({ type: 'getFields', url: PANTRY, fields: ['sex', field] }));
    assert.deepEqual([autofill.values, autofill.held], [{ sex: 'Female' }, [field]], field);
    assert.equal(app.prompts.at(-1).title, 'Let Chrome fill this form?', field);
    assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: [field], sensitive: true })).values), { [field]: sensitive[field] });
    assert.equal(app.prompts.length, before + 2, field);
    assert.equal(app.prompts.at(-1).title, 'Share sensitive details?', field);
    assert.match(app.prompts.at(-1).detail, new RegExp(`^${escaped(FIELD_LABELS[field])}\n`));
  }
  assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: Object.keys(everyday) })).values), everyday);
  assert.equal(app.prompts.at(-1).title, 'Let Chrome fill this form?', 'the other answers get the everyday prompt');
  assert.deepEqual(plain((await app.request({ type: 'getFields', fields: Object.keys(sensitive) })).values), sensitive);
  assert.equal(app.prompts.at(-1).title, 'Let Chrome fill this form?', 'Iowa keeps its own trust rules: never a sensitive prompt');
  await app.request({ type: 'trustSite', url: 'https://wic.example.gov/apply' });
  assert.match(app.prompts.at(-1).detail, /Autofill fills only\. If you choose Fill and continue/);
  assert.match(app.prompts.at(-1).detail, /ordinary Next after checking completeness and desktop authorization/);
  assert.match(app.prompts.at(-1).detail, new RegExp(`Consent, signatures, and final submission stay with you\\. ${escaped(ALWAYS_ALLOW_INCLUDES)}\\. You can remove this site on the Chrome extension page\\.$`));

  const allowed = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await allowed.invoke('saveProfile', { ...sensitive, ...everyday });
  assert.deepEqual(plain((await allowed.request({ type: 'getFields', url: PANTRY, fields: [...Object.keys(sensitive), ...Object.keys(everyday)] })).values), { ...sensitive, ...everyday });
  assert.equal(allowed.prompts.length, 0, 'Always allow covers them on other sites too');
});

test('money on hand and medical expenses are held back on other sites without Always allow, and fill from the sensitive prompt', async () => {
  const app = await desktop({ settings: { extensionId, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', { assetsOnHand: '250', monthlyMedicalExpenses: '40', householdPregnant: 'no' });
  app.answer(async () => ({ response: 1 }));
  for (const field of ['assetsOnHand', 'monthlyMedicalExpenses']) {
    const before = app.prompts.length;
    const autofill = plain(await app.request({ type: 'getFields', url: PANTRY, fields: ['householdPregnant', field] }));
    assert.deepEqual([autofill.values, autofill.held], [{ householdPregnant: 'no' }, [field]], field);
    assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: [field], sensitive: true })).values), { [field]: field === 'assetsOnHand' ? '250' : '40' });
    assert.equal(app.prompts.length, before + 2, field);
    assert.equal(app.prompts.at(-1).title, 'Share sensitive details?', field);
    assert.match(app.prompts.at(-1).detail, field === 'assetsOnHand' ? /^Money on hand/ : /^Monthly medical expenses/);
  }
  assert.deepEqual(plain((await app.request({ type: 'getFields', fields: ['assetsOnHand', 'monthlyMedicalExpenses'] })).values), { assetsOnHand: '250', monthlyMedicalExpenses: '40' });
  assert.equal(app.prompts.at(-1).title, 'Let Chrome fill this form?', 'Iowa keeps its own trust rules: never a sensitive prompt');

  const allowed = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await allowed.invoke('saveProfile', { assetsOnHand: '250', monthlyMedicalExpenses: '40', householdPregnant: 'no' });
  assert.deepEqual(plain((await allowed.request({ type: 'getFields', url: PANTRY, fields: ['householdPregnant', 'assetsOnHand', 'monthlyMedicalExpenses'] })).values),
    { householdPregnant: 'no', assetsOnHand: '250', monthlyMedicalExpenses: '40' });
  assert.equal(allowed.prompts.length, 0, 'Always allow covers them on other sites too');
});

test('income sources and current benefits are held back on other sites without Always allow; student status and the help wanted are everyday answers (#184)', async () => {
  const answers = { studentLevel: 'undergraduate', incomeSources: 'financial-aid,family-support', currentBenefits: 'snap,school-meals', helpWanted: 'food-pantry,fresh-produce' };
  const app = await desktop({ settings: { extensionId, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', answers);
  app.answer(async () => ({ response: 1 }));
  const autofill = plain(await app.request({ type: 'getFields', url: PANTRY, fields: Object.keys(answers) }));
  assert.deepEqual([autofill.values, autofill.held], [{ studentLevel: 'undergraduate', helpWanted: 'food-pantry,fresh-produce' }, ['incomeSources', 'currentBenefits']]);
  assert.equal(app.prompts.at(-1).title, 'Let Chrome fill this form?');
  assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: ['incomeSources', 'currentBenefits'], sensitive: true })).values),
    { incomeSources: 'financial-aid,family-support', currentBenefits: 'snap,school-meals' });
  assert.equal(app.prompts.at(-1).title, 'Share sensitive details?');
  assert.match(app.prompts.at(-1).detail, /^Where your household’s income comes from, Benefits your household gets now\n/);
  assert.deepEqual(plain((await app.request({ type: 'getFields', fields: Object.keys(answers) })).values), answers);
  assert.equal(app.prompts.at(-1).title, 'Let Chrome fill this form?', 'Iowa keeps its own trust rules: never a sensitive prompt');

  const allowed = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await allowed.invoke('saveProfile', answers);
  assert.deepEqual(plain((await allowed.request({ type: 'getFields', url: PANTRY, fields: Object.keys(answers) })).values), answers);
  assert.equal(allowed.prompts.length, 0, 'Always allow covers them on other sites too');
});

test('turning a site off in the extension drops it from the trusted list at once, even while locked, with no prompt', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org', 'https://wic.example.gov'] } });
  let revision = (await app.request({ type: 'status' })).accessRevision;
  await app.invoke('lock');
  revision = (await app.request({ type: 'status' })).accessRevision;
  assert.deepEqual(plain(await app.request({ type: 'untrustSite', url: `${PANTRY}?week=2` })), { trusted: false, origin: 'https://pantry.example.org' });
  assert.ok((await app.request({ type: 'status' })).accessRevision > revision, 'an access receipt from before can’t fill it');
  assert.equal(app.prompts.length, 0);
  assert.deepEqual(app.writes.at(-1).json.trustedSites, ['https://wic.example.gov']);
  await app.invoke('unlock', 'synthetic password');
  await assert.rejects(app.request({ type: 'getFields', url: PANTRY, fields: ['firstName'] }), /isn’t trusted/);
  assert.equal((await app.request({ type: 'getFields', url: 'https://wic.example.gov/apply', fields: ['firstName'] })).values.firstName, 'Synthetic');
  const writes = app.writes.length;
  assert.deepEqual(plain(await app.request({ type: 'untrustSite', url: PANTRY })), { trusted: false, origin: 'https://pantry.example.org' }, 'a site not in the list is already off');
  assert.equal(app.writes.length, writes);
});

test('removing a trusted site stops field release; a locked vault cannot trust sites', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org', 'https://wic.example.gov'] } });
  assert.deepEqual(plain((await app.invoke('removeTrustedSite', 'https://pantry.example.org')).trustedSites), ['https://wic.example.gov']);
  await assert.rejects(app.request({ type: 'getFields', url: PANTRY, fields: ['firstName'] }), /isn’t trusted/);
  await app.invoke('lock');
  await assert.rejects(app.request({ type: 'trustSite', url: PANTRY }), /Unlock/);
  // A host name longer than DNS allows (254 characters) is never a trusted site either.
  const tooLong = `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
  const stored = await desktop({ settings: { extensionId, trustedSites: ['https://ok.example.org', 'http://bad.example.org', 'javascript:1', 42, tooLong] } });
  assert.deepEqual(plain((await stored.invoke('status')).trustedSites), ['https://ok.example.org']);
});

const ANYWHERE = 'https://never.example.net/apply';
test('trusting all websites asks once, is saved, and lets any https site ask for saved answers', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  assert.equal((await app.request({ type: 'status' })).allSites, false);
  assert.equal((await app.invoke('status')).allSites, false);
  await assert.rejects(app.request({ type: 'getFields', url: ANYWHERE, fields: ['firstName'] }), /isn’t trusted/);
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request({ type: 'trustAllSites' }), /cancelled trusting all websites/);
  assert.equal((await app.request({ type: 'status' })).allSites, false);
  assert.equal(app.writes.some(write => 'allSites' in write.json), false, 'a cancelled approval saves nothing');
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await app.request({ type: 'trustAllSites' })), { allSites: true });
  const prompt = app.prompts.at(-1);
  assert.equal(prompt.title, 'Trust all websites?');
  assert.equal(prompt.message, 'Let SecondHand fill forms on any website?');
  assert.deepEqual(plain(prompt.buttons), ['Cancel', 'Trust all websites']);
  assert.equal(prompt.cancelId, 0);
  assert.match(prompt.detail, /Nothing is filled until you click Autofill/);
  assert.match(prompt.detail, /Autofill fills only\. If you choose Fill and continue/);
  assert.match(prompt.detail, /ordinary Next after checking completeness and desktop authorization/);
  assert.match(prompt.detail, new RegExp(`Consent, signatures, and final submission stay with you\\. ${escaped(ALWAYS_ALLOW_INCLUDES)}, on every site\\. You can turn this off`));
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: true, trustedSites: [], allSites: true });
  assert.equal((await app.request({ type: 'status' })).allSites, true);
  assert.equal((await app.invoke('status')).allSites, true);
  const prompts = app.prompts.length;
  assert.deepEqual(plain((await app.request({ type: 'getFields', url: ANYWHERE, fields: ['firstName'] })).values), { firstName: 'Synthetic' });
  assert.equal(app.prompts.length, prompts, 'Always allow covers ordinary fields there too');
  assert.deepEqual(plain((await app.invoke('status')).trustedSites), [], 'no site is added to the trusted list');
  await assert.rejects(app.request({ type: 'getFields', url: 'http://never.example.net/apply', fields: ['firstName'] }), /isn’t trusted/, 'https only');
  const restarted = await desktop({ settings: app.writes.at(-1).json });
  assert.equal((await restarted.request({ type: 'status' })).allSites, true, 'the setting survives a restart');
  await app.invoke('lock');
  await assert.rejects(app.request({ type: 'trustAllSites' }), /Unlock/);
});

test('on every site that all websites allows, sensitive fields fill with Always allow on, and wait for the sensitive prompt without it; Iowa keeps its rules', async () => {
  const allowed = await desktop({ settings: { extensionId, autofillWithoutAsking: true, allSites: true } });
  await allowed.invoke('saveProfile', { firstName: 'Synthetic', ssn: '123-45-6789', monthlyEarnedIncome: '900' });
  const everything = plain(await allowed.request({ type: 'getFields', url: ANYWHERE, fields: ['firstName', 'ssn', 'monthlyEarnedIncome'] }));
  assert.deepEqual(everything.values, { firstName: 'Synthetic', ssn: '123-45-6789', monthlyEarnedIncome: '900' });
  assert.equal(everything.held, undefined, 'nothing is held back');
  assert.equal(allowed.prompts.length, 0);

  const app = await desktop({ settings: { extensionId, allSites: true } });
  await app.invoke('saveProfile', { firstName: 'Synthetic', ssn: '123-45-6789', monthlyEarnedIncome: '900' });
  app.answer(async () => ({ response: 1 }));
  const autofill = plain(await app.request({ type: 'getFields', url: ANYWHERE, fields: ['firstName', 'ssn', 'monthlyEarnedIncome'] }));
  assert.deepEqual([autofill.values, autofill.held], [{ firstName: 'Synthetic' }, ['ssn', 'monthlyEarnedIncome']]);
  const { values } = await app.request({ type: 'getFields', url: ANYWHERE, fields: ['ssn', 'monthlyEarnedIncome'], sensitive: true });
  assert.equal(values.ssn, '123-45-6789');
  assert.deepEqual(app.prompts.map(prompt => prompt.title), ['Let Chrome fill this form?', 'Share sensitive details?']);
  assert.match(app.prompts[1].message, /never\.example\.net/);
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request({ type: 'getFields', url: ANYWHERE, fields: ['ssn'], sensitive: true }), /You cancelled this field request/);
  app.answer(async () => ({ response: 1 }));
  await app.request({ type: 'getFields', fields: ['ssn'] });
  assert.equal(app.prompts.at(-1).title, 'Let Chrome fill this form?', 'Iowa keeps its own trust rules: never a sensitive prompt');
});

test('turning all websites off, from the extension or the app, stops sites it allowed at once; trusted sites stay', async () => {
  const settings = { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'], allSites: true };
  const app = await desktop({ settings });
  assert.equal((await app.request({ type: 'getFields', url: ANYWHERE, fields: ['firstName'] })).values.firstName, 'Synthetic');
  await app.invoke('lock');
  assert.deepEqual(plain(await app.request({ type: 'untrustAllSites' })), { allSites: false }, 'turning off works while locked');
  assert.equal(app.prompts.length, 0, 'turning off needs no approval');
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] });
  assert.equal((await app.request({ type: 'status' })).allSites, false);
  await app.invoke('unlock', 'synthetic password');
  await assert.rejects(app.request({ type: 'getFields', url: ANYWHERE, fields: ['firstName'] }), /isn’t trusted/);
  assert.equal((await app.request({ type: 'getFields', url: PANTRY, fields: ['firstName'] })).values.firstName, 'Synthetic', 'a trusted site stays');
  assert.deepEqual(plain(await app.request({ type: 'untrustAllSites' })), { allSites: false }, 'turning off twice is fine');

  const renderer = await desktop({ settings });
  const status = await renderer.invoke('turnOffAllSites');
  assert.equal(status.allSites, false);
  assert.deepEqual(plain(status.trustedSites), ['https://pantry.example.org']);
  assert.equal(renderer.writes.at(-1).json.allSites, undefined);
  await assert.rejects(renderer.request({ type: 'getFields', url: ANYWHERE, fields: ['firstName'] }), /isn’t trusted/);
  await assert.rejects(renderer.invoke('trustAllSites'), /Request denied/, 'only the extension turns it on, after Chrome’s prompt');
  await renderer.invoke('lock');
  await assert.rejects(renderer.invoke('turnOffAllSites'), /Unlock/);
});

// Always allow on this site (#175): offered by the sensitive prompt, which shows only while Always allow is off.
const PANTRY_SITE = 'https://pantry.example.org';
const ALWAYS_HERE = 2;
const SENSITIVE_PROFILE = { firstName: 'Synthetic', ssn: '123-45-6789', birthDate: '1985-04-12' };
// A desktop whose sensitive prompts would answer Always allow on this site, with `settings` and a profile with sensitive details.
async function alwaysAllowing(settings, options = {}) {
  const app = await desktop({ settings, profile: SENSITIVE_PROFILE, ...options });
  app.answer(async () => ({ response: ALWAYS_HERE }));
  return app;
}
// Autofill's request, and Fill sensitive details' request for the details it held back (#176).
const sensitiveRequest = (url = PANTRY) => ({ type: 'getFields', url, fields: ['firstName', 'ssn', 'birthDate'] });
const heldRequest = (url = PANTRY) => ({ type: 'getFields', url, fields: ['ssn', 'birthDate'], sensitive: true });
const HELD_VALUES = { ssn: '123-45-6789', birthDate: '1985-04-12' };

test('the sensitive prompt offers Always allow on this site: saved for that site, it fills there with no prompt after, and nowhere else', async () => {
  const app = await alwaysAllowing({ extensionId, trustedSites: [PANTRY_SITE, WIC] });
  const before = (await app.request({ type: 'status' })).accessRevision;
  const reply = await app.request(heldRequest());
  assert.deepEqual(plain(reply.values), HELD_VALUES);
  const [prompt] = app.prompts;
  assert.equal(prompt.title, 'Share sensitive details?');
  assert.deepEqual(plain(prompt.buttons), ['Cancel', 'Allow once', 'Always allow on this site']);
  assert.equal(prompt.defaultId, 0, 'Cancel stays the default');
  assert.equal(prompt.cancelId, 0);
  assert.match(prompt.detail, /\n\nChoose “Always allow on this site” to fill on https:\/\/pantry\.example\.org without asking from now on, sensitive details included\. You can remove it on the Chrome extension page\.$/);
  assert.ok(reply.accessRevision > before, 'earlier receipts are outdated');
  assert.equal(reply.accessRevision, (await app.request({ type: 'status' })).accessRevision, 'the values carry the new receipt');
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: false, trustedSites: [PANTRY_SITE, WIC], alwaysAllowedSites: [PANTRY_SITE] });
  const status = await app.invoke('status');
  assert.deepEqual(plain(status.alwaysAllowedSites), [PANTRY_SITE]);
  assert.equal(status.autofillWithoutAsking, false, 'Always allow on this computer stays off');

  // That site fills in one go from now on, with no prompt and nothing held back, sensitive details and everyday answers alike.
  const autofill = plain(await app.request(sensitiveRequest(`${PANTRY_SITE}/another-page`)));
  assert.deepEqual([autofill.values, autofill.held], [SENSITIVE_PROFILE, undefined]);
  assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: ['firstName'] })).values), { firstName: 'Synthetic' });
  assert.equal(app.prompts.length, 1);
  // Another site still holds them back for its own sensitive prompt.
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await app.request(sensitiveRequest(`${WIC}/apply`))).held, ['ssn', 'birthDate']);
  await app.request(heldRequest(`${WIC}/apply`));
  assert.deepEqual(app.prompts.map(prompt => prompt.title), ['Share sensitive details?', 'Let Chrome fill this form?', 'Share sensitive details?']);
  // The everyday prompt keeps its own Always allow, for this computer.
  assert.deepEqual(plain(app.prompts[1].buttons), ['Cancel', 'Allow once', 'Always allow on this computer']);

  const restarted = await desktop({ settings: app.writes.at(-1).json, profile: SENSITIVE_PROFILE });
  assert.deepEqual(plain((await restarted.request(sensitiveRequest())).values), SENSITIVE_PROFILE);
  assert.equal(restarted.prompts.length, 0, 'it survives a restart');
});

test('Always allow on this site belongs to the extension ID that asked, never covers Iowa’s portal, and still needs SecondHand unlocked', async () => {
  // Saved for another extension ID: this one holds them back, and its Fill sensitive details is asked, then refused.
  const other = await alwaysAllowing({ extensionId: 'c'.repeat(32), trustedSites: [PANTRY_SITE], alwaysAllowedSites: [PANTRY_SITE] });
  assert.deepEqual(plain(await other.request({ type: 'getFields', url: PANTRY, fields: ['ssn'] })).held, ['ssn']);
  await assert.rejects(other.request(heldRequest()), /SecondHand access changed/);
  assert.equal(other.prompts.length, 1);
  assert.equal(other.writes.some(write => write.json.alwaysAllowedSites), false, 'nothing is saved for it');

  // Iowa's portal shares its origin with the rest of hhsservices.iowa.gov, which all websites lets in as another site.
  const iowaSite = await alwaysAllowing({ extensionId, allSites: true });
  await iowaSite.request(heldRequest('https://hhsservices.iowa.gov/other/apply'));
  assert.deepEqual(plain((await iowaSite.invoke('status')).alwaysAllowedSites), ['https://hhsservices.iowa.gov']);
  iowaSite.answer(async () => ({ response: 1 }));
  await iowaSite.request({ type: 'getFields', fields: ['firstName', 'ssn'] });
  assert.equal(iowaSite.prompts.length, 2, 'Iowa’s portal keeps its own rule');
  assert.equal(iowaSite.prompts[1].title, 'Let Chrome fill this form?');

  const app = await alwaysAllowing({ extensionId, trustedSites: [PANTRY_SITE], alwaysAllowedSites: [PANTRY_SITE] });
  for (const key of schema.SNAP_IOWA_ONLY_FIELDS) {
    await assert.rejects(app.request({ type: 'getFields', url: PANTRY, fields: [key] }), /only be shared with Iowa/);
  }
  await app.invoke('lock');
  for (const request of [sensitiveRequest(), heldRequest()]) await assert.rejects(app.request(request), /Unlock SecondHand first/);
  assert.equal(app.prompts.length, 0);
});

test('Always allow on this site is dropped when the site is turned off, from the extension or the app, even while locked', async () => {
  const settings = { extensionId, trustedSites: [PANTRY_SITE, WIC], alwaysAllowedSites: [PANTRY_SITE, WIC] };
  const app = await alwaysAllowing(settings);
  await app.invoke('lock');
  const revision = (await app.request({ type: 'status' })).accessRevision;
  assert.deepEqual(plain(await app.request({ type: 'untrustSite', url: PANTRY })), { trusted: false, origin: PANTRY_SITE });
  assert.ok((await app.request({ type: 'status' })).accessRevision > revision, 'an access receipt from before can’t fill it');
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: false, trustedSites: [WIC], alwaysAllowedSites: [WIC] });
  await app.invoke('unlock', 'synthetic password');
  app.answer(async () => ({ response: 1 }));
  await app.request({ type: 'trustSite', url: PANTRY });
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await app.request(sensitiveRequest())).held, ['ssn', 'birthDate'], 'trusted again, it holds them back again');
  await app.request(heldRequest());
  assert.equal(app.prompts.at(-1).title, 'Share sensitive details?', 'and asks again');

  const fromApp = await alwaysAllowing(settings);
  const status = await fromApp.invoke('removeTrustedSite', PANTRY_SITE);
  assert.deepEqual(plain([status.trustedSites, status.alwaysAllowedSites]), [[WIC], [WIC]]);
  assert.deepEqual(fromApp.writes.at(-1).json.alwaysAllowedSites, [WIC]);

  // A site all websites lets in, never trusted on its own: turning it off from the extension takes Always allow back too.
  const anywhere = await alwaysAllowing({ extensionId, allSites: true, alwaysAllowedSites: ['https://never.example.net'] });
  await anywhere.request({ type: 'untrustSite', url: ANYWHERE });
  assert.deepEqual(plain((await anywhere.invoke('status')).alwaysAllowedSites), []);
  assert.equal(anywhere.writes.at(-1).json.alwaysAllowedSites, undefined, 'an empty list isn’t saved');
  const writes = anywhere.writes.length;
  await anywhere.request({ type: 'untrustSite', url: ANYWHERE });
  assert.equal(anywhere.writes.length, writes, 'a site already off saves nothing');
});

test('turning all websites off drops Always allow on the sites it let in, and keeps it on sites trusted on their own', async () => {
  const settings = { extensionId, trustedSites: [WIC], allSites: true, alwaysAllowedSites: [PANTRY_SITE, WIC] };
  const app = await alwaysAllowing(settings);
  await app.invoke('lock');
  await app.request({ type: 'untrustAllSites' });
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: false, trustedSites: [WIC], alwaysAllowedSites: [WIC] });
  await app.invoke('unlock', 'synthetic password');
  assert.deepEqual(plain((await app.request(sensitiveRequest(`${WIC}/apply`))).values), SENSITIVE_PROFILE);
  assert.equal(app.prompts.length, 0, 'the site trusted on its own keeps it');

  const fromApp = await alwaysAllowing(settings);
  assert.deepEqual(plain((await fromApp.invoke('turnOffAllSites')).alwaysAllowedSites), [WIC]);
  assert.deepEqual(fromApp.writes.at(-1).json.alwaysAllowedSites, [WIC]);
});

test('Always allow on this site is dropped when the extension ID changes, and doesn’t come back with the old ID', async () => {
  const app = await alwaysAllowing({ extensionId, trustedSites: [PANTRY_SITE], alwaysAllowedSites: [PANTRY_SITE] });
  await app.invoke('connectExtension', extensionId);
  assert.deepEqual(plain((await app.invoke('status')).alwaysAllowedSites), [PANTRY_SITE], 'the same ID keeps it');
  await app.invoke('connectExtension', 'b'.repeat(32));
  assert.deepEqual(app.writes.at(-1).json, { extensionId: 'b'.repeat(32), autofillWithoutAsking: false, trustedSites: [PANTRY_SITE] });
  await app.invoke('connectExtension', extensionId);
  assert.deepEqual(plain((await app.invoke('status')).alwaysAllowedSites), []);
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await app.request(sensitiveRequest())).held, ['ssn', 'birthDate']);
  await app.request(heldRequest());
  assert.equal(app.prompts.at(-1).title, 'Share sensitive details?');
});

test('the app removes Always allow on one site, which stays trusted and asks again; it needs SecondHand unlocked', async () => {
  const app = await alwaysAllowing({ extensionId, trustedSites: [PANTRY_SITE, WIC], alwaysAllowedSites: [PANTRY_SITE, WIC] });
  const revision = (await app.request({ type: 'status' })).accessRevision;
  const status = await app.invoke('removeAlwaysAllowedSite', PANTRY_SITE);
  assert.deepEqual(plain([status.trustedSites, status.alwaysAllowedSites]), [[PANTRY_SITE, WIC], [WIC]]);
  assert.ok((await app.request({ type: 'status' })).accessRevision > revision, 'an access receipt from before can’t fill it');
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: false, trustedSites: [PANTRY_SITE, WIC], alwaysAllowedSites: [WIC] });
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await app.request(sensitiveRequest())).held, ['ssn', 'birthDate']);
  await app.request(heldRequest());
  assert.equal(app.prompts.at(-1).title, 'Share sensitive details?');
  await assert.rejects(app.invoke('removeAlwaysAllowedSite', PANTRY_SITE), /That site isn’t in your Always allow list/);
  await assert.rejects(app.invoke('removeAlwaysAllowedSite', 42), /That site isn’t in your Always allow list/);
  await app.invoke('lock');
  await assert.rejects(app.invoke('removeAlwaysAllowedSite', WIC), /Unlock SecondHand first/);
});

test('a saved Always allow list keeps only sites SecondHand is on, as https origins, at most 50, and only with a saved extension ID', async () => {
  const tooLong = `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
  const stored = await desktop({ settings: { extensionId, trustedSites: [PANTRY_SITE, 'https://ok.example.org'],
    alwaysAllowedSites: [PANTRY_SITE, 'https://elsewhere.example.org', 'http://pantry.example.org', `${PANTRY_SITE}/intake`, 'javascript:1', 42, tooLong, PANTRY_SITE, 'https://ok.example.org'] } });
  assert.deepEqual(plain((await stored.invoke('status')).alwaysAllowedSites), [PANTRY_SITE, 'https://ok.example.org']);
  const fiftyOne = Array.from({ length: 51 }, (_, n) => `https://site-${n}.example.org`);
  const many = await desktop({ settings: { extensionId, allSites: true, alwaysAllowedSites: fiftyOne } });
  assert.deepEqual(plain((await many.invoke('status')).alwaysAllowedSites), fiftyOne.slice(0, 50), 'a saved list longer than 50 keeps the first 50');
  const noId = await desktop({ settings: { extensionId: 'not an extension ID', trustedSites: [PANTRY_SITE], alwaysAllowedSites: [PANTRY_SITE] } });
  assert.deepEqual(plain((await noId.invoke('status')).alwaysAllowedSites), []);
});

test('SecondHand always allows at most 50 sites: Always allow on a 51st is refused, and Allow once still fills', async () => {
  const fifty = Array.from({ length: 50 }, (_, n) => `https://site-${n}.example.org`);
  const app = await alwaysAllowing({ extensionId, trustedSites: [PANTRY_SITE], allSites: true, alwaysAllowedSites: fifty });
  const writes = app.writes.length;
  await assert.rejects(app.request(heldRequest()), /Remove a site under Sites that fill sensitive details without asking before adding another/);
  assert.equal(app.writes.length, writes, 'nothing is saved');
  assert.deepEqual(plain((await app.invoke('status')).alwaysAllowedSites), fifty);
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain((await app.request(heldRequest())).values), HELD_VALUES);
});

test('a lock or a site turned off while the sensitive prompt is open saves no Always allow and fills nothing', async t => {
  for (const [change, [apply, refusal]] of Object.entries(ACCESS_CHANGES)) await t.test(change, async () => {
    const app = await desktop({ settings: { extensionId, trustedSites: [WIC], allSites: true }, profile: SENSITIVE_PROFILE });
    const prompt = holdPrompt(app);
    const pending = app.request(heldRequest());
    await prompt.shown();
    await apply(app);
    prompt.answer(ALWAYS_HERE);
    await assert.rejects(pending, refusal);
    assert.equal(app.writes.some(write => write.json.alwaysAllowedSites), false, 'nothing about the site is saved');
    if (change === 'lock') await app.invoke('unlock', 'synthetic password');
    assert.deepEqual(plain((await app.invoke('status')).alwaysAllowedSites), []);
  });
});

test('a lock while Always allow on this site is being saved refuses the reply', async t => {
  for (const change of ['lock', 'lock and unlock']) await t.test(change, async () => {
    const [apply, refusal] = ACCESS_CHANGES[change];
    let saving = true;
    const app = await alwaysAllowing({ extensionId, trustedSites: [PANTRY_SITE] },
      { beforeWrite: async file => { if (saving && file.endsWith('settings.json')) { saving = false; await apply(app); } } });
    await assert.rejects(app.request(heldRequest()), refusal);
    assert.equal(app.prompts[0].title, 'Share sensitive details?');
  });
});

// #176: without Always allow, Autofill's getFields holds the sensitive details back and answers the rest. Its reply names
// them, and the side panel's Fill sensitive details asks for them alone, with `sensitive: true`.
test('without Always allow, getFields holds the sensitive details back and answers the rest after the everyday prompt (#176)', async () => {
  const app = await desktop({ settings: { extensionId, trustedSites: [PANTRY_SITE] }, profile: SENSITIVE_PROFILE });
  app.answer(async () => ({ response: 1 }));
  const reply = plain(await app.request(sensitiveRequest()));
  assert.deepEqual(reply.values, { firstName: 'Synthetic' });
  assert.deepEqual(reply.held, ['ssn', 'birthDate'], 'the reply names what it held back');
  assert.equal(reply.accessRevision, (await app.request({ type: 'status' })).accessRevision);
  assert.deepEqual(app.prompts.map(prompt => prompt.title), ['Let Chrome fill this form?'], 'only the everyday prompt');
  assert.equal(app.prompts[0].message, 'Fill these saved answers into https://pantry.example.org?');
  assert.match(app.prompts[0].detail, /^Website: https:\/\/pantry\.example\.org\n\nFirst name\n\n/, 'it names only the field it fills');
  assert.doesNotMatch(JSON.stringify(app.prompts[0]), /123-45-6789|1985/, 'the held details are never shown');
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);
  // Cancel on the everyday prompt fills nothing, as it did.
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request(sensitiveRequest()), /You cancelled this field request/);

  // With only sensitive details asked for, nothing is asked and nothing is read.
  const reads = app.dataReads;
  const held = plain(await app.request({ type: 'getFields', url: PANTRY, fields: ['ssn', 'birthDate'] }));
  assert.deepEqual(held, { values: {}, accessRevision: reply.accessRevision, held: ['ssn', 'birthDate'] });
  assert.equal(app.dataReads, reads);
  assert.equal(app.prompts.length, 2);
  // A saved birth date the app can't use is said for the answers it released, never for a held one.
  const unusable = await desktop({ settings: { extensionId, trustedSites: [PANTRY_SITE] }, profile: { ...SENSITIVE_PROFILE, birthDate: '2026-12-01' } });
  unusable.answer(async () => ({ response: 1 }));
  assert.equal(plain(await unusable.request(sensitiveRequest())).reason, undefined);
  assert.equal(plain(await unusable.request(heldRequest())).reason, 'birthDate');
});

test('Fill sensitive details asks for the held details alone with the sensitive prompt: Allow once fills them, Cancel fills nothing (#176)', async () => {
  const app = await desktop({ settings: { extensionId, trustedSites: [PANTRY_SITE] }, profile: SENSITIVE_PROFILE });
  app.answer(async () => ({ response: 1 }));
  const reply = plain(await app.request(heldRequest()));
  assert.deepEqual(reply.values, HELD_VALUES);
  assert.equal(reply.held, undefined);
  assert.equal(reply.accessRevision, (await app.request({ type: 'status' })).accessRevision);
  const [prompt] = app.prompts;
  assert.equal(prompt.title, 'Share sensitive details?');
  assert.equal(prompt.message, 'Fill sensitive details on https://pantry.example.org?');
  assert.deepEqual(plain(prompt.buttons), ['Cancel', 'Allow once', 'Always allow on this site']);
  assert.equal(prompt.defaultId, 0, 'Cancel stays the default');
  assert.equal(prompt.detail, 'Social Security number, Date of birth\n\nOnly allow this if you meant to give these details to https://pantry.example.org.\n\n' +
    'Choose “Always allow on this site” to fill on https://pantry.example.org without asking from now on, sensitive details included. You can remove it on the Chrome extension page.');
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false, 'Allow once changes no setting');
  assert.deepEqual(plain((await app.invoke('status')).alwaysAllowedSites), []);
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request(heldRequest()), /You cancelled this field request/);
  assert.equal(app.prompts.length, 2);

  // Only sensitive details are asked for this way, never on Iowa's portal, and only from a site SecondHand is on.
  for (const fields of [['firstName', 'ssn'], ['county']]) await assert.rejects(app.request({ ...heldRequest(), fields }), /Only sensitive details/, fields.join());
  await assert.rejects(app.request({ ...heldRequest(), url: PORTAL_URL }), /Only sensitive details/);
  await assert.rejects(app.request(heldRequest('https://never.example.net/apply')), /isn’t trusted/);
  assert.equal(app.prompts.length, 2, 'none of them asks');
});

test('with Always allow on, on this computer or on this site, getFields holds nothing back and Fill sensitive details asks nothing (#176)', async () => {
  for (const settings of [{ extensionId, autofillWithoutAsking: true, trustedSites: [PANTRY_SITE] }, { extensionId, trustedSites: [PANTRY_SITE], alwaysAllowedSites: [PANTRY_SITE] }]) {
    const app = await desktop({ settings, profile: SENSITIVE_PROFILE });
    const autofill = plain(await app.request(sensitiveRequest()));
    assert.deepEqual([autofill.values, autofill.held], [SENSITIVE_PROFILE, undefined], JSON.stringify(settings));
    assert.deepEqual(plain((await app.request(heldRequest())).values), HELD_VALUES, 'a setting turned on since the click covers the button too');
    assert.equal(app.prompts.length, 0);
  }
});

test('on Iowa’s portal, getFields holds nothing back: Iowa’s flow is unchanged (#176)', async () => {
  const app = await desktop({ settings: { extensionId }, profile: SENSITIVE_PROFILE });
  app.answer(async () => ({ response: 1 }));
  const reply = plain(await app.request({ type: 'getFields', fields: ['firstName', 'ssn', 'birthDate'] }));
  assert.deepEqual([reply.values, reply.held], [SENSITIVE_PROFILE, undefined]);
  assert.deepEqual(app.prompts.map(prompt => prompt.title), ['Let Chrome fill this form?']);
  assert.match(app.prompts[0].detail, /\n\nFirst name, Social Security number, Date of birth\n\n/);
});

// A stand-in for desktop/laya.cjs (#38) running a noul-v1 model, with its exact interface. `scores(state)` plays the model.
function stubLaya(scores = () => 0.01, state = 'ready', delayMs = 0) {
  const batches = [];
  const warms = [];
  return { batches, warms, format: async () => 'noul-v1', status: async () => ({ state, enabled: state !== 'off', sizeBytes: 1 }), decide: async () => { throw new Error('the desktop scores in batches'); },
    decideBatch: async items => {
      batches.push(items);
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      return items.map(item => { const noul = scores(item.state); return { answers: { correct: { type: 'noul', noul, confidence: Math.max(noul, 1 - noul) } } }; });
    },
    warm: async () => { warms.push(Date.now()); }, setEnabled: async () => {}, startDownload: async () => {}, cancelDownload: async () => {}, remove: async () => {}, close: async () => {},
    update: async () => {}, startUpdates: async () => {} };
}
const box = { id: 'f0:sh-1-2', label: 'Where can we reach you by email?', type: 'email', options: [] };
const sixty = { id: 'f0:sh-1-3', label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'] };
const veteran = { id: 'f0:sh-1-4', label: 'Is anyone in your household a veteran?', type: 'radio', options: ['Yes', 'No'] };
const suggest = (fields, extra = {}) => ({ type: 'suggestFields', url: PANTRY, fields, budgetMs: 3000, ...extra });
const answerRequest = (questions, extra = {}) => ({ type: 'answerFields', url: PANTRY, questions, budgetMs: 3000, ...extra });
const layaRequests = [suggest([box]), answerRequest([sixty])];
// Only the applicant's age (a sensitive fact) settles 60+ for a household of one.
const sixtyFromAge = state => {
  if (state.question === sixty.label) return state.facts.includes('years old') ? (state.candidate === 'No' ? 0.97 : 0.01) : (state.candidate.startsWith('None') ? 0.95 : 0.01);
  if (state.question === veteran.label) return state.candidate === 'No' ? 0.98 : 0.01;
  return state.candidate === 'Saved answer: email address' ? 0.99 : 0.01;
};
const household = { birthDate: '1985-04-12', householdSize: '1', householdAdults: '1', householdChildren: '0', householdSeniors: '0', householdVeteran: 'no', county: 'Polk' };
const trusted = { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] };
const asking = { extensionId, trustedSites: ['https://pantry.example.org'] };
async function answering(settings) {
  const app = await desktop({ laya: stubLaya(sixtyFromAge), settings });
  await app.invoke('saveProfile', household);
  return app;
}

test('suggestFields and answerFields take an untrusted https site only while all websites is on', async () => {
  const anywhere = [suggest([box], { url: ANYWHERE }), answerRequest([sixty], { url: ANYWHERE })];
  const off = await answering({ extensionId, autofillWithoutAsking: true });
  for (const request of anywhere) await assert.rejects(off.request(request), /isn’t trusted/, request.type);
  const on = await answering({ extensionId, autofillWithoutAsking: true, allSites: true });
  assert.deepEqual(plain((await on.request(anywhere[0])).suggestions), { [box.id]: 'email' });
  const answered = plain(await on.request(anywhere[1]));
  assert.deepEqual(answered.answers, { [sixty.id]: 'No' });
  assert.equal(on.prompts.length, 0, 'with Always allow on, an answer that needed sensitive facts fills there with no prompt (#175)');
  await on.request({ type: 'untrustAllSites' });
  for (const request of anywhere) await assert.rejects(on.request(request), /isn’t trusted/, request.type);
});

// #137: an embedded form's requests carry the form's own address, so trust and every prompt follow that site.
const EMBEDDED_FORM = 'https://forms.example.net/embed';
test('an embedded form’s requests are trusted and prompted for the form’s own site, never the page around it', async () => {
  const sixtyThere = answerRequest([sixty], { url: EMBEDDED_FORM });
  // Only the host page is trusted: its trust doesn't cover a form from another site.
  const hostOnly = await answering({ extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] });
  for (const request of [{ type: 'getFields', url: EMBEDDED_FORM, fields: ['firstName'] }, suggest([box], { url: EMBEDDED_FORM }), sixtyThere]) {
    await assert.rejects(hostOnly.request(request), /isn’t trusted/, request.type);
  }
  await assert.rejects(hostOnly.request({ type: 'saveFields', url: EMBEDDED_FORM, fields: { email: 'synthetic@example.org' } }), /isn’t trusted/, 'saveFields');
  assert.equal(hostOnly.prompts.length, 0);
  hostOnly.answer(async () => ({ response: 1 }));
  await hostOnly.request({ type: 'trustSite', url: EMBEDDED_FORM });
  assert.deepEqual(plain((await hostOnly.request({ type: 'getFields', url: EMBEDDED_FORM, fields: ['county'] })).values), { county: 'Polk' },
    'trusting the form’s own site lets it ask');

  // With all websites on and Always allow off, the sensitive prompts name the form's site, the one that gets the answers.
  const everywhere = await answering({ extensionId, trustedSites: ['https://pantry.example.org'], allSites: true });
  await everywhere.invoke('saveProfile', { ...household, firstName: 'Synthetic', assetsOnHand: '250' });
  everywhere.answer(async () => ({ response: 1 }));
  const autofill = plain(await everywhere.request({ type: 'getFields', url: EMBEDDED_FORM, fields: ['firstName', 'assetsOnHand'] }));
  assert.deepEqual([autofill.values, autofill.held], [{ firstName: 'Synthetic' }, ['assetsOnHand']]);
  assert.deepEqual(plain((await everywhere.request({ type: 'getFields', url: EMBEDDED_FORM, fields: ['assetsOnHand'], sensitive: true })).values), { assetsOnHand: '250' });
  assert.deepEqual(plain((await everywhere.request(sixtyThere)).answers), { [sixty.id]: 'No' });
  const [everyday, fields, answers] = everywhere.prompts;
  assert.equal(everyday.message, 'Fill these saved answers into https://forms.example.net?');
  assert.equal(fields.title, 'Share sensitive details?');
  assert.equal(fields.message, 'Fill sensitive details on https://forms.example.net?');
  assert.match(fields.detail, /give these details to https:\/\/forms\.example\.net\./);
  assert.equal(answers.message, 'Fill this answer on https://forms.example.net? It uses sensitive details.');
  assert.match(answers.detail, /meant to give these answers to https:\/\/forms\.example\.net:/);
  // Saving an answer the form's page holds names that site too.
  assert.deepEqual(plain(await everywhere.request({ type: 'saveFields', url: EMBEDDED_FORM, fields: { email: 'synthetic@example.org' } })), { saved: ['email'] });
  assert.equal(everywhere.prompts.at(-1).message, 'Save this answer from https://forms.example.net to My information?');
  for (const prompt of everywhere.prompts) assert.doesNotMatch(`${prompt.message} ${prompt.detail}`, /pantry\.example\.org/);

  // Without Always allow, the everyday prompt names it too.
  const ordinary = await desktop({ settings: { extensionId, allSites: true } });
  ordinary.answer(async () => ({ response: 1 }));
  await ordinary.request({ type: 'getFields', url: EMBEDDED_FORM, fields: ['firstName'] });
  assert.equal(ordinary.prompts[0].message, 'Fill these saved answers into https://forms.example.net?');
  assert.match(ordinary.prompts[0].detail, /^Website: https:\/\/forms\.example\.net\n/);
});

test('before a new install has downloaded the shipped model, both Laya requests answer "not ready" and status says so', async () => {
  const app = await desktop({ settings: trusted });
  assert.deepEqual(plain((await app.request({ type: 'status' })).laya), { state: 'not-downloaded' });
  const reads = app.dataReads;
  for (const request of [...layaRequests, answerRequest([sixty], { url: 'https://untrusted.example.org/' })]) {
    await assert.rejects(app.request(request), error => error.publicCode === 'LAYA_NOT_READY' && /Laya isn’t ready/.test(error.publicMessage), request.type);
  }
  assert.equal(app.dataReads, reads, 'the vault is never read');
  assert.equal(app.prompts.length, 0);
});

test('a Laya that is off, downloading, or failing answers "not ready" the same way; its state shows in status', async () => {
  for (const state of ['off', 'not-downloaded', 'downloading', 'error', 'unavailable']) {
    const app = await desktop({ laya: stubLaya(() => 0.99, state), settings: asking });
    assert.deepEqual(plain((await app.request({ type: 'status' })).laya), { state });
    for (const request of layaRequests) await assert.rejects(app.request(request), error => error.publicCode === 'LAYA_NOT_READY', `${state} ${request.type}`);
  }
  const switchedOff = stubLaya();
  switchedOff.decideBatch = async () => { throw Object.assign(new Error('Laya was turned off.'), { code: 'LAYA_NOT_READY' }); };
  const app = await desktop({ laya: switchedOff, settings: asking });
  await app.invoke('saveProfile', household);
  for (const request of layaRequests) await assert.rejects(app.request(request), error => error.publicCode === 'LAYA_NOT_READY', request.type);
  const confused = await desktop({ laya: stubLaya(() => 0.99, 'thinking') });
  await assert.rejects(confused.request({ type: 'status' }), /unknown state/);
  const crashed = stubLaya();
  crashed.decideBatch = async () => { throw new Error('model crashed'); };
  const failing = await desktop({ laya: crashed, settings: asking });
  await assert.rejects(failing.request(layaRequests[0]), error => /Laya couldn’t check this form/.test(error.publicMessage) && !error.publicCode);
});

test('suggestFields returns saved-field keys only, never values, so it needs no prompt even without Always allow: the values come through getFields', async () => {
  const app = await desktop({ laya: stubLaya(sixtyFromAge), settings: asking });
  const reply = plain(await app.request(layaRequests[0]));
  assert.deepEqual(reply, { suggestions: { 'f0:sh-1-2': 'email' } });
  assert.deepEqual(plain(await app.request(suggest([{ ...box, id: 'sh-1-2' }], { url: `${PORTAL_URL}/applyForBenefits/financialInfo` }))), { suggestions: { 'sh-1-2': 'email' } });
  assert.equal(app.dataReads, 0, 'matching reads no saved answers');
  assert.equal(app.prompts.length, 0);
  await assert.rejects(app.request(suggest([box], { url: 'https://other.example.org/form' })), /isn’t trusted/);
  await assert.rejects(app.request(answerRequest([sixty], { url: 'https://hhsservices.iowa.gov/other' })), /isn’t trusted/);
  await app.invoke('lock');
  for (const request of layaRequests) await assert.rejects(app.request(request), /Unlock/);
});

test('without Always allow, answers wait for one "Let Chrome fill this form?" prompt listing each question and the option that would be filled', async () => {
  const app = await answering(asking);
  app.answer(async () => ({ response: 1 }));
  const once = await app.request(answerRequest([veteran, { ...veteran, id: 'f0:sh-1-9', label: 'Do you have a pet?' }]));
  assert.deepEqual(plain(once.answers), { 'f0:sh-1-4': 'No' });
  assert.equal(app.prompts.length, 1);
  const [prompt] = app.prompts;
  assert.equal(prompt.title, 'Let Chrome fill this form?');
  assert.deepEqual(plain(prompt.buttons), ['Cancel', 'Allow once', 'Always allow on this computer']);
  assert.equal(prompt.cancelId, 0);
  assert.match(prompt.message, /pantry\.example\.org/);
  assert.match(prompt.detail, /Website: https:\/\/pantry\.example\.org/);
  assert.match(prompt.detail, /“Is anyone in your household a veteran\?”: No/);
  assert.doesNotMatch(prompt.detail, /pet/, 'only questions that would be filled are listed');
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false, 'Allow once changes no setting');

  app.answer(async () => ({ response: 0 }));
  const cancelled = await app.request(answerRequest([veteran]));
  assert.deepEqual(plain(cancelled.answers), {}, 'Cancel returns no answers');
  assert.equal(app.prompts.length, 2);
});

test('Always allow on the answers prompt works like getFields’: it saves the setting, moves the access receipt on, and later answers need no prompt', async () => {
  const app = await answering(asking);
  const before = (await app.request({ type: 'status' })).accessRevision;
  app.answer(async () => ({ response: 2 }));
  const allowed = await app.request(answerRequest([veteran]));
  assert.deepEqual(plain(allowed.answers), { 'f0:sh-1-4': 'No' });
  assert.equal((await app.invoke('status')).autofillWithoutAsking, true);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] });
  assert.ok(allowed.accessRevision > before, 'earlier receipts are outdated');
  assert.equal(allowed.accessRevision, (await app.request({ type: 'status' })).accessRevision, 'the answers carry the new receipt');
  await app.request(answerRequest([veteran]));
  assert.equal(app.prompts.length, 1, 'no prompt after Always allow');
  const other = await answering({ ...trusted, extensionId: 'c'.repeat(32) });
  await assert.rejects(other.request(answerRequest([veteran])), /changed/);
  assert.equal(other.prompts.length, 1, 'Always allow belongs to the stored extension ID: another one is asked, then refused');
});

test('with Always allow on, answers fill with no prompt, those that needed sensitive facts too (#175)', async () => {
  const app = await answering(trusted);
  const everyday = await app.request(answerRequest([veteran]));
  assert.deepEqual(plain(everyday.answers), { 'f0:sh-1-4': 'No' });
  assert.equal(everyday.accessRevision, (await app.request({ type: 'status' })).accessRevision, 'answers carry the access receipt they were made under');
  const allowed = await app.request(answerRequest([sixty, veteran]));
  assert.deepEqual(plain(allowed.answers), { 'f0:sh-1-3': 'No', 'f0:sh-1-4': 'No' });
  assert.equal(allowed.accessRevision, (await app.request({ type: 'status' })).accessRevision);
  assert.equal(app.prompts.length, 0);

  // Always allow belongs to the stored extension ID: another one gets the sensitive prompt, then is refused.
  const other = await answering({ ...trusted, extensionId: 'c'.repeat(32) });
  await assert.rejects(other.request(answerRequest([sixty])), /SecondHand access changed/);
  assert.deepEqual(other.prompts.map(prompt => prompt.title), ['Share sensitive details?']);
});

test('the sensitive prompt says how many of the answers needed sensitive details, in plain grammar, and that Laya read them', async () => {
  const app = await answering(asking);
  app.answer(async () => ({ response: 1 }));
  await app.request(answerRequest([sixty]));
  await app.request(answerRequest([sixty, veteran]));
  // Both questions settled only once the applicant's age was known.
  const both = await desktop({ laya: stubLaya(state => state.facts.includes('years old') ? (state.candidate === 'No' ? 0.97 : 0.01) : (state.candidate.startsWith('None') ? 0.95 : 0.01)), settings: asking });
  await both.invoke('saveProfile', household);
  both.answer(async () => ({ response: 1 }));
  await both.request(answerRequest([sixty, veteran]));
  const prompts = [...app.prompts, ...both.prompts];
  assert.deepEqual(prompts.map(prompt => prompt.message), [
    'Fill this answer on https://pantry.example.org? It uses sensitive details.',
    'Fill these 2 answers on https://pantry.example.org? 1 of them uses sensitive details.',
    'Fill these 2 answers on https://pantry.example.org? They use sensitive details.']);
  assert.match(prompts[0].detail, /Laya, SecondHand’s AI on this computer, read these saved details to pick this answer\./);
  assert.match(prompts[1].detail, /read these saved details to pick 1 of these answers\./);
  assert.match(prompts[2].detail, /read these saved details to pick these answers\./);
  for (const prompt of prompts) assert.doesNotMatch(prompt.detail, /used these saved details/, 'Laya was given every sensitive fact; which one it relied on is unknown');
});

test('without Always allow, answers that needed sensitive facts fold into the same single "Share sensitive details?" prompt', async () => {
  const app = await answering(asking);
  app.answer(async () => ({ response: 1 }));
  const { answers } = await app.request(answerRequest([sixty, veteran]));
  assert.deepEqual(plain(answers), { 'f0:sh-1-3': 'No', 'f0:sh-1-4': 'No' });
  assert.equal(app.prompts.length, 1, 'one prompt, not two');
  const [prompt] = app.prompts;
  assert.equal(prompt.title, 'Share sensitive details?');
  assert.deepEqual(plain(prompt.buttons), ['Cancel', 'Allow once', 'Always allow on this site']);
  assert.equal(prompt.cancelId, 0);
  assert.match(prompt.message, /pantry\.example\.org/);
  assert.match(prompt.detail, /Date of birth/);
  assert.match(prompt.detail, /“Is anyone in your household 60 or older\?”: No/);
  assert.match(prompt.detail, /“Is anyone in your household a veteran\?”: No/);
  assert.doesNotMatch(`${prompt.message} ${prompt.detail}`, /1985|41 years/, 'saved values and facts never appear');
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);

  // Cancel drops the answer that needed sensitive details. The everyday one follows its own rule: without
  // Always allow, it asks "Let Chrome fill this form?", listing only that answer.
  const responses = [0, 1];
  app.answer(async () => ({ response: responses.shift() }));
  assert.deepEqual(plain((await app.request(answerRequest([sixty, veteran]))).answers), { 'f0:sh-1-4': 'No' });
  assert.deepEqual(app.prompts.slice(1).map(prompt => prompt.title), ['Share sensitive details?', 'Let Chrome fill this form?']);
  const everyday = app.prompts.at(-1);
  assert.deepEqual(plain(everyday.buttons), ['Cancel', 'Allow once', 'Always allow on this computer']);
  assert.equal(everyday.message, 'Fill this answer into https://pantry.example.org?');
  assert.match(everyday.detail, /“Is anyone in your household a veteran\?”: No/);
  assert.doesNotMatch(everyday.detail, /60 or older/, 'the dropped answer isn’t offered again');
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);

  app.answer(async () => ({ response: 0 }));
  assert.deepEqual(plain((await app.request(answerRequest([sixty, veteran]))).answers), {}, 'Cancel on both returns none');
  assert.equal(app.prompts.length, 5);
  const cancelled = await app.request(answerRequest([sixty]));
  assert.deepEqual(plain(cancelled.answers), {}, 'with only sensitive answers, Cancel returns none');
  assert.equal(cancelled.accessRevision, (await app.request({ type: 'status' })).accessRevision);
  assert.equal(app.prompts.length, 6, 'and asks nothing more');
});

test('a lock while the "Share sensitive details?" prompt is open releases nothing when it is cancelled', async () => {
  for (const change of ['lock', 'lock and unlock']) {
    const app = await answering(asking);
    // The sensitive prompt waits for Cancel; any later prompt would be allowed at once.
    let cancel;
    app.answer(() => cancel ? Promise.resolve({ response: 1 }) : new Promise(done => { cancel = () => done({ response: 0 }); }));
    const pending = app.request(answerRequest([sixty, veteran]));
    await until(() => Boolean(cancel));
    await app.invoke('lock');
    if (change === 'lock and unlock') await app.invoke('unlock', 'synthetic password');
    cancel();
    await assert.rejects(pending, change === 'lock' ? /Unlock SecondHand first/ : /SecondHand access changed/, change);
    assert.equal(app.prompts.length, 1, 'no prompt for the everyday answer');
  }
});

test('Always allow on this site from Laya’s sensitive prompt saves the site, and its answers and saved fields fill there with no prompt after', async () => {
  const app = await answering(asking);
  app.answer(async () => ({ response: ALWAYS_HERE }));
  const allowed = await app.request(answerRequest([sixty, veteran]));
  assert.deepEqual(plain(allowed.answers), { 'f0:sh-1-3': 'No', 'f0:sh-1-4': 'No' });
  assert.equal(allowed.accessRevision, (await app.request({ type: 'status' })).accessRevision, 'the answers carry the new receipt');
  const [prompt] = app.prompts;
  assert.equal(prompt.title, 'Share sensitive details?');
  assert.deepEqual(plain(prompt.buttons), ['Cancel', 'Allow once', 'Always allow on this site']);
  assert.match(prompt.detail, /\n\nChoose “Always allow on this site” to fill on https:\/\/pantry\.example\.org without asking from now on, sensitive details included\./);
  assert.deepEqual(app.writes.at(-1).json.alwaysAllowedSites, [PANTRY_SITE]);
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);
  assert.deepEqual(plain((await app.request(answerRequest([sixty, veteran]))).answers), { 'f0:sh-1-3': 'No', 'f0:sh-1-4': 'No' });
  assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: ['birthDate', 'county'] })).values), { birthDate: '1985-04-12', county: 'Polk' });
  assert.equal(app.prompts.length, 1);
});

test('on Iowa’s portal, answers follow getFields’ Iowa rule: a prompt only without Always allow, and never a sensitive one', async () => {
  const iowa = answerRequest([sixty, veteran], { url: `${PORTAL_URL}/applyForBenefits/financialInfo` });
  const allowed = await answering({ extensionId, autofillWithoutAsking: true });
  assert.deepEqual(plain((await allowed.request(iowa)).answers), { 'f0:sh-1-3': 'No', 'f0:sh-1-4': 'No' });
  assert.equal(allowed.prompts.length, 0);
  const asked = await answering({ extensionId });
  asked.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain((await asked.request(iowa)).answers), { 'f0:sh-1-3': 'No', 'f0:sh-1-4': 'No' });
  assert.equal(asked.prompts.length, 1);
  assert.equal(asked.prompts[0].title, 'Let Chrome fill this form?');
  assert.deepEqual(plain(asked.prompts[0].buttons), ['Cancel', 'Allow once', 'Always allow on this computer']);
  assert.match(asked.prompts[0].message, /Iowa’s application/);
  assert.match(asked.prompts[0].detail, /“Is anyone in your household 60 or older\?”: No/);
});

test('one approval at a time: answers and saved fields wait for each other’s prompt, and a profile edit during the prompt releases nothing', async () => {
  const app = await answering(asking);
  let resolve;
  app.answer(() => new Promise(done => { resolve = done; }));
  const pending = app.request(answerRequest([sixty]));
  for (let i = 0; i < 50 && !resolve; i++) await tick();
  assert.equal(typeof resolve, 'function', 'the prompt is showing');
  await assert.rejects(app.request(answerRequest([veteran])), /waiting for your approval/);
  await assert.rejects(app.request({ type: 'getFields', url: PANTRY, fields: ['firstName'] }), /waiting for your approval/);
  await assert.rejects(app.request({ type: 'trustSite', url: 'https://wic.example.gov/apply' }), /waiting for your approval/);
  await app.invoke('saveProfile', { ...household, householdVeteran: 'yes' });
  resolve({ response: 1 });
  await assert.rejects(pending, /changed/);

  const other = await answering(asking);
  let release;
  other.answer(() => new Promise(done => { release = done; }));
  const fields = other.request({ type: 'getFields', url: PANTRY, fields: ['firstName'] });
  for (let i = 0; i < 50 && !release; i++) await tick();
  await assert.rejects(other.request(answerRequest([veteran])), /waiting for your approval/, 'a getFields prompt holds answers back too');
  release({ response: 1 });
  await fields;
});

test('a lock or the site turned off while Laya is choosing answers releases none of them', async t => {
  for (const [change, [apply, refusal]] of Object.entries(ACCESS_CHANGES)) await t.test(change, async () => {
    const laya = stubLaya(sixtyFromAge);
    const decideBatch = laya.decideBatch;
    let scoring = false;
    let finish;
    const held = new Promise(resolve => { finish = resolve; });
    laya.decideBatch = async items => { scoring = true; await held; return decideBatch(items); };
    const app = await desktop({ laya, settings: { extensionId, autofillWithoutAsking: true, trustedSites: [WIC], allSites: true } });
    await app.invoke('saveProfile', household);
    const pending = app.request(answerRequest([veteran], { url: `${WIC}/apply` }));
    await until(() => scoring);
    await apply(app);
    finish();
    await assert.rejects(pending, refusal);
    assert.equal(app.prompts.length, 0, 'nothing is offered');
  });
});

test('the desktop stops Laya at the time the click has left, and a decision that comes after it is not returned', async () => {
  const slow = await desktop({ laya: stubLaya(sixtyFromAge, 'ready', 40), settings: trusted });
  await slow.invoke('saveProfile', household);
  assert.deepEqual(plain(await slow.request(suggest([box], { budgetMs: 5 }))), { suggestions: {} });
  assert.deepEqual(plain((await slow.request(answerRequest([veteran], { budgetMs: 5 }))).answers), {});
  assert.deepEqual(plain(await slow.request(suggest([box], { budgetMs: 3000 }))), { suggestions: { 'f0:sh-1-2': 'email' } });
  assert.deepEqual(plain((await slow.request(answerRequest([veteran], { budgetMs: 3000 }))).answers), { 'f0:sh-1-4': 'No' });
});

// #185: a question Laya has no sure answer for, where its best guess beats "the facts don't say". Its guesses were
// mostly wrong on the final holdout (#189: ML_model/eval/reports/*-final-app-fills.json), so Autofill asks for none.
const sizeQuestion = { id: 'f0:sh-1-5', label: 'How many people live in your household?', type: 'radio', options: ['1', '2', '3 or more'] };
const guessesSize = state => state.question === sizeQuestion.label ? (state.candidate.startsWith('None') ? 0.3 : { 1: 0.6, 2: 0.1, '3 or more': 0.05 }[state.candidate]) : sixtyFromAge(state);
async function guessing(settings) {
  const app = await desktop({ laya: stubLaya(guessesSize), settings });
  await app.invoke('saveProfile', household);
  return app;
}

test('#189: Autofill asks Laya for no best guesses on any site: Laya fills only sure answers, and a question it isn’t sure of stays with the applicant', async () => {
  for (const url of [PANTRY, `${PORTAL_URL}/applyForBenefits/financialInfo`]) {
    const allowed = await guessing(trusted);
    const reply = plain(await allowed.request(answerRequest([veteran, sizeQuestion], { url })));
    assert.deepEqual(reply, { answers: { [veteran.id]: 'No' }, accessRevision: (await allowed.request({ type: 'status' })).accessRevision }, url);
    const asked = await guessing(asking);
    asked.answer(async () => ({ response: 1 }));
    assert.deepEqual(plain((await asked.request(answerRequest([veteran, sizeQuestion], { url }))).answers), { [veteran.id]: 'No' }, url);
    assert.equal(asked.prompts.length, 1, url);
    assert.doesNotMatch(asked.prompts[0].detail, /How many people|a guess/, url);
    // A question with only a best guess is never offered for approval.
    assert.deepEqual(plain(await asked.request(answerRequest([sizeQuestion], { url }))), { answers: {}, accessRevision: (await asked.request({ type: 'status' })).accessRevision }, url);
    assert.equal(asked.prompts.length, 1, url);
  }
});

test('warmLaya loads Laya’s model before a click’s questions are asked and answers with Laya’s state; it reads no saved answers and needs no unlock', async () => {
  const laya = stubLaya();
  const app = await desktop({ laya, settings: asking });
  await app.invoke('lock');
  const reads = app.dataReads;
  assert.deepEqual(plain(await app.request({ type: 'warmLaya' })), { state: 'ready' });
  assert.equal(laya.warms.length, 1);
  assert.equal(app.dataReads, reads);
  assert.equal(app.prompts.length, 0);

  const off = stubLaya(() => 0.5, 'off');
  const offApp = await desktop({ laya: off });
  assert.deepEqual(plain(await offApp.request({ type: 'warmLaya' })), { state: 'off' });
  assert.equal(off.warms.length, 0, 'a Laya that is off is not loaded');
  assert.deepEqual(plain(await (await desktop()).request({ type: 'warmLaya' })), { state: 'not-downloaded' }, 'the shipped model isn’t loaded before it is downloaded');
  assert.deepEqual(plain(await (await desktop({ settings: { extensionId, layaEnabled: false } })).request({ type: 'warmLaya' })), { state: 'off' }, 'Laya stays off once turned off');

  // A model that fails to load reports as an error, as the runtime does, instead of failing the click.
  let state = 'ready';
  const broken = { ...stubLaya(), status: async () => ({ state, enabled: true }),
    warm: async () => { state = 'error'; throw Object.assign(new Error('The Laya model couldn’t be loaded (synthetic).'), { code: 'LAYA_NOT_READY' }); } };
  assert.deepEqual(plain(await (await desktop({ laya: broken })).request({ type: 'warmLaya' })), { state: 'error' });
  const crashing = { ...stubLaya(), warm: async () => { throw new Error('synthetic bug'); } };
  await assert.rejects((await desktop({ laya: crashing })).request({ type: 'warmLaya' }), /synthetic bug/, 'anything else fails loudly');
});

// The app's prepared copy of its extension, as extension-setup.cjs reports it. `refresh` plays
// prepareBundledExtension, which copies only the app's own bundle; every call is counted.
const SHIPPED = '2026-10-05.1';
// `newerCopy` is the build of a whole copy a newer app prepared (#142).
function extensionCopy({ exists = true, prepared = true, newerCopy = null, refresh = async () => {} } = {}) {
  const copy = { exists, prepared, refreshes: 0 };
  const setup = () => ({ directory: '/synthetic-local-data/chrome-extension', extensionId: 'jogldddafjfbmfjnjlbjloakjbecnjpl', version: '0.4.0', build: SHIPPED, exists: copy.exists, prepared: copy.prepared,
    newerCopy: copy.prepared ? null : newerCopy });
  copy.module = {
    getExtensionSetup: async () => setup(),
    prepareBundledExtension: async () => { copy.refreshes++; await refresh(copy); copy.exists = true; copy.prepared = true; return setup(); }
  };
  return copy;
}
const shipped = async app => plain(await app.request({ type: 'status' })).extension;
// Waits up to 5 seconds, a turn of the event loop at a time. Status reads the real Laya model
// folder first, and on a busy machine that disk read can take hundreds of turns.
const until = async condition => { const end = performance.now() + 5000; while (!condition() && performance.now() < end) await tick(); assert.ok(condition(), 'timed out'); };

test('status reports the extension build the app ships and that the copy it prepared for Chrome has it', async () => {
  const copy = extensionCopy();
  const app = await desktop({ extensionCopy: copy });
  assert.deepEqual(await shipped(app), { build: SHIPPED, copy: 'ready' });
  assert.equal(copy.refreshes, 0);
  await app.invoke('lock');
  assert.deepEqual(await shipped(app), { build: SHIPPED, copy: 'ready' }, 'it needs no unlock: it carries no saved information');
});

test('with no prepared copy, status says so and the app writes nothing', async () => {
  const copy = extensionCopy({ exists: false, prepared: false });
  const app = await desktop({ extensionCopy: copy });
  assert.deepEqual(await shipped(app), { build: SHIPPED, copy: 'absent' });
  assert.equal(copy.refreshes, 0);
});

test('a prepared copy from another build is refreshed from the app’s bundle once, without registering Chrome again or opening the folder', async () => {
  const copy = extensionCopy({ prepared: false });
  const app = await desktop({ extensionCopy: copy });
  assert.deepEqual(await shipped(app), { build: SHIPPED, copy: 'ready' });
  assert.deepEqual(await shipped(app), { build: SHIPPED, copy: 'ready' });
  assert.equal(copy.refreshes, 1);
  assert.equal(app.registrations, 0);
  assert.deepEqual(app.opened, []);
});

test('one refresh runs at a time: status requests, and the Chrome extension page’s refresh, share it', async () => {
  let release;
  const copy = extensionCopy({ prepared: false, refresh: () => new Promise(resolve => { release = resolve; }) });
  const app = await desktop({ extensionCopy: copy });
  const first = shipped(app), second = shipped(app);
  await until(() => release);
  for (let i = 0; i < 5; i++) await tick();
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ build: SHIPPED, copy: 'ready' }, { build: SHIPPED, copy: 'ready' }]);
  assert.equal(copy.refreshes, 1);

  const page = extensionCopy({ prepared: false, refresh: () => new Promise(resolve => { release = resolve; }) });
  const other = await desktop({ extensionCopy: page });
  release = null;
  const prepared = other.invoke('prepareExtension');
  await until(() => release);
  const status = shipped(other);
  for (let i = 0; i < 5; i++) await tick();
  release();
  await prepared;
  assert.deepEqual(await status, { build: SHIPPED, copy: 'ready' }, 'status waits for the page’s refresh instead of starting another');
  assert.equal(page.refreshes, 1);
});

test('an older app never refreshes a copy a newer app prepared: status names that newer build, ready to load (#142)', async () => {
  const copy = extensionCopy({ prepared: false, newerCopy: '2026-10-06.1' });
  const app = await desktop({ extensionCopy: copy });
  assert.deepEqual(await shipped(app), { build: '2026-10-06.1', copy: 'ready' });
  assert.deepEqual(await shipped(app), { build: '2026-10-06.1', copy: 'ready' });
  assert.equal(copy.refreshes, 0, 'nothing older is written over it');
});

test('a refresh that fails is reported, and isn’t tried again until the files are refreshed on the Chrome extension page', async () => {
  let failing = true;
  const copy = extensionCopy({ prepared: false, refresh: async () => { if (failing) throw new Error('synthetic disk failure'); } });
  const app = await desktop({ extensionCopy: copy });
  assert.deepEqual(await shipped(app), { build: SHIPPED, copy: 'failed' });
  assert.deepEqual(await shipped(app), { build: SHIPPED, copy: 'failed' });
  assert.equal(copy.refreshes, 1, 'no refresh loop');
  await assert.rejects(app.invoke('prepareExtension'), /could not be completed/);
  assert.equal(copy.refreshes, 2);
  failing = false;
  await app.invoke('prepareExtension');
  assert.equal(copy.refreshes, 3);
  assert.deepEqual(await shipped(app), { build: SHIPPED, copy: 'ready' });
});

// A household list (#98): the applicant (41), two children (11 and 5, the older a student in 5th grade) and a parent (67).
const SELF_ID = '0f2c8d4e-1a3b-4c5d-8e6f-7a8b9c0d1e2f';
const memberId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const listedHousehold = (changes = {}) => ({ firstName: 'Synthetic', lastName: 'Applicant', birthDate: '1985-04-12', householdSize: '9', householdChildren: '0',
  householdMembers: [
    { id: SELF_ID, relationship: 'self', student: 'no' },
    { id: memberId(1), firstName: 'Riley', lastName: 'Example', birthDate: '2015-09-03', relationship: 'child', student: 'yes', grade: '5th' },
    { id: memberId(2), firstName: 'Sam', lastName: 'Example', birthDate: '2021-02-14', relationship: 'child', student: 'no' },
    { id: memberId(3), firstName: 'Morgan', lastName: 'Sample', birthDate: '1958-11-20', relationship: 'parent', student: 'no' }
  ].map((member, n) => ({ ...member, ...changes[n] })) });
const BANDS = ['householdCount:0-17', 'householdCount:18-59', 'householdCount:60+'];

test('band counts and the student answer come from the household list; counts by birth date are everyday answers on every site (#175)', async () => {
  const app = await desktop({ settings: trusted });
  await app.invoke('saveProfile', listedHousehold());
  const { values } = await app.request({ type: 'getFields', url: PANTRY, fields: [...BANDS, 'studentNameGrade', 'householdSize'] });
  assert.deepEqual(plain(values), { 'householdCount:0-17': '2', 'householdCount:18-59': '1', 'householdCount:60+': '1', studentNameGrade: 'Riley Example, 5th', householdSize: '4' });
  // A food-pantry intake asking for people aged 0 to 5 and 6 to 18, and the profile's own age counts worked out from the list.
  assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: ['householdCount:0-5', 'householdCount:6-18', 'householdAdults', 'householdChildren', 'householdSeniors'] })).values),
    { 'householdCount:0-5': '1', 'householdCount:6-18': '1', householdAdults: '1', householdChildren: '2', householdSeniors: '1' });
  assert.equal(app.prompts.length, 0, 'Always allow covers counts by birth date as it covers any everyday answer');
  // Iowa keeps its own trust rules.
  assert.deepEqual(plain((await app.request({ type: 'getFields', fields: ['householdCount:0-5', 'householdChildren'] })).values), { 'householdCount:0-5': '1', householdChildren: '2' });
  assert.equal(app.prompts.length, 0);
  assert.equal(app.dataReads > 0, true);

  // Without Always allow, the counts get the everyday prompt, never the sensitive one.
  const asked = await desktop({ settings: asking });
  await asked.invoke('saveProfile', listedHousehold());
  asked.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain((await asked.request({ type: 'getFields', url: PANTRY, fields: [...BANDS, 'householdChildren', 'studentNameGrade'] })).values),
    { 'householdCount:0-17': '2', 'householdCount:18-59': '1', 'householdCount:60+': '1', householdChildren: '2', studentNameGrade: 'Riley Example, 5th' });
  assert.equal(asked.prompts.length, 1);
  assert.equal(asked.prompts[0].title, 'Let Chrome fill this form?');
  assert.match(asked.prompts[0].detail, /\n\nPeople in the household aged 0 to 17, People in the household aged 18 to 59, People in the household aged 60 or older, Children in household, Student name and grade\n\n/);
  assert.doesNotMatch(JSON.stringify(asked.prompts[0]), /Riley|2015|1958/, 'the prompt names fields, never members’ details');
  // Beside a sensitive field, the counts fill after the everyday prompt and the sensitive field is held back (#176).
  const beside = plain(await asked.request({ type: 'getFields', url: PANTRY, fields: ['householdCount:0-5', 'birthDate'] }));
  assert.deepEqual([beside.values, beside.held], [{ 'householdCount:0-5': '1' }, ['birthDate']]);
  assert.equal(asked.prompts[1].title, 'Let Chrome fill this form?');
  assert.match(asked.prompts[1].detail, /\n\nPeople in the household aged 0 to 5\n\n/);
});

test('without the household list, the manual counts are everyday answers and band counts have no answer', async () => {
  const app = await desktop({ settings: trusted });
  await app.invoke('saveProfile', { householdSize: '3', householdChildren: '1', householdAdults: '2', householdSeniors: '0' });
  const { values } = await app.request({ type: 'getFields', url: PANTRY, fields: ['householdSize', 'householdChildren', 'householdAdults', 'householdSeniors', 'studentNameGrade'] });
  assert.deepEqual(plain(values), { householdSize: '3', householdChildren: '1', householdAdults: '2', householdSeniors: '0' });
  assert.equal(app.prompts.length, 0);
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: BANDS })).values), {}, 'no list: the applicant answers each band');
});

test('a household member without a birth date leaves every count by age unanswered; the list still wins over the manual counts', async () => {
  const app = await desktop({ settings: trusted });
  await app.invoke('saveProfile', listedHousehold({ 2: { birthDate: '' } }));
  app.answer(async () => ({ response: 1 }));
  const { values } = await app.request({ type: 'getFields', url: PANTRY, fields: [...BANDS, 'householdChildren', 'householdSize'] });
  assert.deepEqual(plain(values), { householdSize: '4' }, 'not the stale manual count of 0 children');
});

test('the household list itself is never released, whatever asks for it', async () => {
  const app = await desktop({ settings: trusted });
  await app.invoke('saveProfile', listedHousehold());
  await assert.rejects(app.request({ type: 'getFields', url: PANTRY, fields: ['householdMembers'] }), /doesn’t share/);
  const reply = JSON.stringify(plain(await app.request({ type: 'getFields', url: PANTRY, fields: ['firstName', 'studentNameGrade'] })));
  assert.doesNotMatch(reply, /Sam|Morgan|1958|2021|householdMembers/);
});

test('Laya’s sensitive prompt names household members’ birth dates when facts from them were read', async () => {
  const app = await desktop({ laya: stubLaya(sixtyFromAge), settings: asking });
  await app.invoke('saveProfile', listedHousehold());
  app.answer(async () => ({ response: 1 }));
  await app.request(answerRequest([sixty]));
  assert.equal(app.prompts.at(-1).title, 'Share sensitive details?');
  assert.match(app.prompts.at(-1).detail, /^Date of birth, Household members’ birth dates\n/);
});

const SAVE = { type: 'saveFields', url: PANTRY };
test('Save to My information saves an answer only after the app’s confirmation naming the field and its value', async () => {
  const app = await desktop({ settings: trusted });
  await app.invoke('saveProfile', { firstName: 'Synthetic', state: 'IA', householdVeteran: '' });
  const before = (await app.request({ type: 'status' })).accessRevision;
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await app.request({ ...SAVE, fields: { addressLine2: ' Unit 5 ', householdVeteran: 'no' } })), { saved: ['addressLine2', 'householdVeteran'] });
  const [prompt] = app.prompts;
  assert.equal(prompt.title, 'Save to My information?');
  assert.equal(prompt.message, 'Save these answers from https://pantry.example.org to My information?');
  assert.match(prompt.detail, /^Apartment or unit: Unit 5\nAnyone in household a veteran: No\n\n/);
  assert.deepEqual(plain(prompt.buttons), ['Cancel', 'Save']);
  assert.equal(prompt.cancelId, 0);
  const { profile } = plain(await app.invoke('getData'));
  assert.equal(profile.addressLine2, 'Unit 5');
  assert.equal(profile.householdVeteran, 'no');
  assert.equal(profile.firstName, 'Synthetic', 'the rest of the profile stays as it was');
  assert.ok((await app.request({ type: 'status' })).accessRevision > before, 'a saved change outdates earlier fill approvals');
  assert.deepEqual(app.notifications.filter(([channel]) => channel === 'secondhand:profile-changed').map(([, value]) => plain(value)), [{ fields: ['addressLine2', 'householdVeteran'] }],
    'My information hears which fields changed, never their values');
  // Iowa's portal may save too.
  assert.deepEqual(plain(await app.request({ type: 'saveFields', url: `${PORTAL_URL}/applyForBenefits/enterPersonalInfo`, fields: { county: 'Story' } })), { saved: ['county'] });
  assert.equal(app.prompts.at(-1).message, 'Save this answer from Iowa’s application to My information?');
});

test('sensitive answers get the warning confirmation, as filling them does', async () => {
  const app = await desktop({ settings: trusted });
  app.answer(async () => ({ response: 1 }));
  await app.request({ ...SAVE, fields: { birthDate: '1985-04-12', assetsOnHand: '250' } });
  const [prompt] = app.prompts;
  assert.equal(prompt.type, 'warning');
  assert.equal(prompt.title, 'Save sensitive details to My information?');
  assert.equal(prompt.defaultId, 0, 'Cancel is the default for sensitive details');
  assert.match(prompt.detail, /Date of birth and Money on hand \(cash, checking, savings\) are sensitive\./);
  assert.equal(plain(await app.invoke('getData')).profile.birthDate, '1985-04-12');
});

test('nothing is saved without the confirmation, on a locked app, from a site that isn’t on, or with a value the schema refuses', async () => {
  const cancelled = await desktop({ settings: trusted });
  cancelled.answer(async () => ({ response: 0 }));
  await assert.rejects(cancelled.request({ ...SAVE, fields: { county: 'Story' } }), /cancelled/);
  assert.equal(plain(await cancelled.invoke('getData')).profile.county, undefined);
  assert.equal(cancelled.notifications.some(([channel]) => channel === 'secondhand:profile-changed'), false);

  const app = await desktop({ settings: trusted });
  app.answer(async () => ({ response: 1 }));
  await assert.rejects(app.request({ ...SAVE, url: ANYWHERE, fields: { county: 'Story' } }), /isn’t trusted/);
  for (const fields of [{ zip: 'ABCDE' }, { birthDate: '2999-01-01' }, { state: 'Iowa' }, { householdVeteran: 'maybe' }, { email: 'not an email' }]) {
    await assert.rejects(app.request({ ...SAVE, fields }), error => Boolean(error.publicMessage), JSON.stringify(fields));
  }
  assert.equal(app.prompts.length, 0, 'a refused value is never offered for confirmation');
  await app.invoke('lock');
  await assert.rejects(app.request({ ...SAVE, fields: { county: 'Story' } }), /Unlock/);
  assert.equal(app.prompts.length, 0);
});

test('an answer already saved, or a household count while the list sets it, is never overwritten from a page', async () => {
  const app = await desktop({ settings: trusted });
  await app.invoke('saveProfile', { ...listedHousehold(), county: 'Polk' });
  app.answer(async () => ({ response: 1 }));
  await assert.rejects(app.request({ ...SAVE, fields: { county: 'Story' } }), /already saved/);
  await assert.rejects(app.request({ ...SAVE, fields: { householdChildren: '3' } }), /household list/);
  assert.equal(app.prompts.length, 0);
  const manual = await desktop({ settings: trusted });
  manual.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await manual.request({ ...SAVE, fields: { householdChildren: '3' } })), { saved: ['householdChildren'] }, 'without a list, a count is saved like any answer');
});

test('a change while the confirmation is open cancels the save', async () => {
  const app = await desktop({ settings: trusted });
  let resolve;
  app.answer(() => new Promise(done => { resolve = done; }));
  const pending = app.request({ ...SAVE, fields: { county: 'Story' } });
  await tick();
  await assert.rejects(app.request({ ...SAVE, fields: { city: 'Ames' } }), /waiting for your approval/, 'one approval at a time');
  await app.invoke('saveProfile', { firstName: 'Edited meanwhile' });
  resolve({ response: 1 });
  await assert.rejects(pending, /changed/);
  assert.equal(plain(await app.invoke('getData')).profile.county, '');
});

// Custom answers by subject (#186): only one about a sensitive subject waits for Fill sensitive details (#176); an everyday
// one follows getFields' ordinary approval, so Let Chrome fill without asking fills it with no dialog.
const PICKUP = customRecord(1);
const INCOME = customRecord(2, { label: 'Monthly income', aliases: [], value: '1200' });
const PICKUP_QUESTION = { id: 'field1', label: 'Pickup point', type: 'text' };
const INCOME_QUESTION = { id: 'field2', label: 'Monthly income', type: 'number' };
const customAsk = changes => ({ type: 'getCustomFields', url: PANTRY, fields: [PICKUP_QUESTION, INCOME_QUESTION], ...changes });

test('a custom answer about a sensitive subject waits for Fill sensitive details; an everyday one follows the ordinary approval (#186)', async () => {
  const app = await desktop({ settings: asking, profile: { customFields: [PICKUP, INCOME] } });
  app.answer(async () => ({ response: 1 }));
  const reply = plain(await app.request(customAsk()));
  assert.deepEqual(reply, { values: { field1: 'North entrance' }, held: ['field2'], accessRevision: (await app.request({ type: 'status' })).accessRevision });
  const [prompt] = app.prompts;
  assert.equal(prompt.title, 'Let Chrome fill this form?');
  assert.equal(prompt.message, 'Fill this custom answer into https://pantry.example.org?');
  assert.match(prompt.detail, /^Website: https:\/\/pantry\.example\.org\n\nYour custom answers:\nPickup point: "North entrance"\n\n/);
  assert.doesNotMatch(JSON.stringify(prompt), /1200|Monthly income/, 'a held answer is never shown');
  // Only a sensitive answer matched: nothing is asked.
  assert.deepEqual(plain(await app.request(customAsk({ fields: [INCOME_QUESTION] }))), { values: {}, held: ['field2'], accessRevision: reply.accessRevision });
  assert.equal(app.prompts.length, 1);

  // Fill sensitive details asks for it alone, with the sensitive prompt.
  const sensitive = plain(await app.request(customAsk({ fields: [INCOME_QUESTION], sensitive: true })));
  assert.deepEqual([sensitive.values, sensitive.held], [{ field2: '1200' }, undefined]);
  const asked = app.prompts.at(-1);
  assert.equal(asked.title, 'Share sensitive details?');
  assert.equal(asked.message, 'Fill sensitive details on https://pantry.example.org?');
  assert.equal(asked.detail, 'Your custom answers:\nMonthly income: "1200"\n\nOnly allow this if you meant to give these details to https://pantry.example.org.\n\n' +
    'Choose “Always allow on this site” to fill on https://pantry.example.org without asking from now on, sensitive details included. You can remove it on the Chrome extension page.');
  await assert.rejects(app.request(customAsk({ sensitive: true })), /Only sensitive details/, 'never an everyday answer this way');
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request(customAsk({ fields: [INCOME_QUESTION], sensitive: true })), /You cancelled this field request/);
  assert.deepEqual(plain(await app.request(customAsk())).values, {}, 'Cancel on the ordinary prompt fills nothing, as before');

  for (const settings of [{ ...asking, autofillWithoutAsking: true }, { ...asking, alwaysAllowedSites: [PANTRY_SITE] }]) {
    const always = await desktop({ settings, profile: { customFields: [PICKUP, INCOME] } });
    const released = plain(await always.request(customAsk()));
    assert.deepEqual([released.values, released.held], [{ field1: 'North entrance', field2: '1200' }, undefined], JSON.stringify(settings));
    assert.equal(always.prompts.length, 0);
  }
});

// Remember for next time (#186): the applicant's answers from a page, kept as custom answers after the app's confirmation.
const HEARD = { label: 'How did you hear about us?', type: 'radio', options: ['Friend', 'Church', 'Flyer'], answer: 'Church' };
const EMPLID = { label: 'EMPLID', type: 'text', options: [], answer: 'SYN-4471' };
const REMEMBER = { type: 'rememberAnswers', url: PANTRY };
const customAnswers = async app => plain(await app.invoke('getData')).profile.customFields;

test('Remember for next time keeps answers as custom answers only after the app’s confirmation naming each question and answer (#186)', async () => {
  const app = await desktop({ settings: { ...trusted, trustedSites: [PANTRY_SITE, WIC] }, profile: { firstName: 'Synthetic', customFields: [PICKUP] } });
  const before = (await app.request({ type: 'status' })).accessRevision;
  app.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain(await app.request({ ...REMEMBER, answers: [HEARD, { ...EMPLID, answer: ' SYN-4471 ' }] })), { remembered: 2 });
  const [prompt] = app.prompts;
  assert.equal(prompt.type, 'question');
  assert.equal(prompt.title, 'Remember these answers?');
  assert.equal(prompt.message, 'Remember these answers from https://pantry.example.org for next time?');
  assert.equal(prompt.detail, '“How did you hear about us?”: "Church"\n“EMPLID”: "SYN-4471"\n\nSecondHand keeps them in My information under Custom answers and fills them when a form asks ' +
    'the same question with the same choices. You can change or remove them there.');
  assert.deepEqual(plain(prompt.buttons), ['Cancel', 'Remember']);
  assert.deepEqual([prompt.defaultId, prompt.cancelId], [1, 0]);
  const list = await customAnswers(app);
  assert.deepEqual(list[0], PICKUP, 'the answers already there stay as they were');
  assert.deepEqual(list.slice(1).map(({ id, ...answer }) => answer), [
    { label: 'How did you hear about us?', value: 'Church', aliases: [], type: 'radio', options: ['Friend', 'Church', 'Flyer'], site: PANTRY_SITE },
    { label: 'EMPLID', value: 'SYN-4471', aliases: [], type: 'text', options: [], site: PANTRY_SITE }]);
  assert.equal(plain(await app.invoke('getData')).profile.firstName, 'Synthetic', 'nothing else in My information changes');
  assert.ok((await app.request({ type: 'status' })).accessRevision > before, 'a change outdates earlier fill approvals');
  assert.deepEqual(app.notifications.filter(([channel]) => channel === 'secondhand:profile-changed').map(([, value]) => plain(value)), [{ fields: ['customFields'] }],
    'My information hears that its custom answers changed, never what they are');

  // The same question on another site takes the new answer; the site it was first saved from stays.
  await app.request({ ...REMEMBER, url: `${WIC}/apply`, answers: [{ ...EMPLID, label: 'Emplid:', answer: 'SYN-9000' }] });
  assert.equal(app.prompts.at(-1).title, 'Remember this answer?');
  assert.equal(app.prompts.at(-1).message, 'Remember this answer from https://wic.example.gov for next time?');
  assert.match(app.prompts.at(-1).detail, /^“Emplid:”: "SYN-9000"\n\nSecondHand keeps it in My information under Custom answers and fills it when a form asks /);
  const again = await customAnswers(app);
  assert.equal(again.length, 3);
  assert.deepEqual([again[2].id, again[2].value, again[2].site], [list[2].id, 'SYN-9000', PANTRY_SITE]);

  // The next Autofill fills it into the same question, and only that one.
  const fill = plain(await app.request({ type: 'getCustomFields', url: `${WIC}/apply`, fields: [{ id: 'q1', label: '2. HOW DID YOU HEAR ABOUT US *', type: 'radio', options: ['flyer', 'friend', 'church'] },
    { id: 'q2', label: 'How did you hear about us?', type: 'select', options: ['Friend', 'Church', 'Flyer'] }] }));
  assert.deepEqual(fill.values, { q1: 'church' });
});

test('an answer about a sensitive subject gets the warning confirmation, with Cancel the default (#186)', async () => {
  const app = await desktop({ settings: trusted });
  app.answer(async () => ({ response: 1 }));
  await app.request({ ...REMEMBER, answers: [{ label: 'Monthly income', type: 'number', options: [], answer: '1200' }, HEARD] });
  const [prompt] = app.prompts;
  assert.equal(prompt.type, 'warning');
  assert.equal(prompt.title, 'Remember sensitive details?');
  assert.equal(prompt.defaultId, 0);
  assert.match(prompt.detail, /\n\nYour answer to “Monthly income” is sensitive: SecondHand fills it only after you allow it on each site\. SecondHand keeps them in My information/);
  assert.equal((await customAnswers(app)).length, 2);
});

test('nothing is remembered without the confirmation, while locked, from a site that isn’t on, for a question only the applicant answers, or past 50 (#186)', async () => {
  const cancelled = await desktop({ settings: trusted });
  cancelled.answer(async () => ({ response: 0 }));
  await assert.rejects(cancelled.request({ ...REMEMBER, answers: [HEARD] }), /You cancelled\. Nothing was remembered\./);
  assert.deepEqual(await customAnswers(cancelled), undefined);
  assert.equal(cancelled.notifications.some(([channel]) => channel === 'secondhand:profile-changed'), false);

  const app = await desktop({ settings: trusted, profile: { customFields: [customRecord(1, { label: 'EMPLID', aliases: [] })] } });
  app.answer(async () => ({ response: 1 }));
  await assert.rejects(app.request({ ...REMEMBER, url: ANYWHERE, answers: [HEARD] }), /isn’t trusted/);
  await assert.rejects(app.request({ ...REMEMBER, url: PORTAL_URL, answers: [HEARD] }), /other HTTPS sites/);
  for (const answer of [{ ...EMPLID, label: 'Signature' }, { ...EMPLID, label: 'Routing number' }, { ...EMPLID, type: 'email', answer: 'not an email' }]) {
    await assert.rejects(app.request({ ...REMEMBER, answers: [answer] }), error => Boolean(error.publicMessage), JSON.stringify(answer));
  }
  await assert.rejects(app.request({ ...REMEMBER, answers: [EMPLID] }), /You already have a custom answer for “EMPLID”\. Change it in My information\./);
  const full = await desktop({ settings: trusted, profile: { customFields: Array.from({ length: 50 }, (_, n) => customRecord(n, { label: `Question ${n}`, aliases: [] })) } });
  full.answer(async () => ({ response: 1 }));
  await assert.rejects(full.request({ ...REMEMBER, answers: [HEARD] }), error => error.publicMessage ===
    'You have 50 custom answers, the most SecondHand keeps. Remove one in My information, then remember this answer again.');
  assert.equal(app.prompts.length + full.prompts.length, 0, 'a refused answer is never offered for confirmation');
  await app.invoke('lock');
  await assert.rejects(app.request({ ...REMEMBER, answers: [HEARD] }), /Unlock/);
  assert.equal(app.prompts.length, 0);
});

test('a lock or the site turned off while “Remember these answers?” is open remembers nothing (#186)', async t => {
  for (const [change, [apply, refusal]] of Object.entries(ACCESS_CHANGES)) await t.test(change, async () => {
    const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: [WIC], allSites: true } });
    const prompt = holdPrompt(app);
    const pending = app.request({ ...REMEMBER, url: `${WIC}/apply`, answers: [HEARD] });
    await prompt.shown();
    await apply(app);
    prompt.answer(1);
    await assert.rejects(pending, refusal);
    if (change === 'lock') await app.invoke('unlock', 'synthetic password');
    assert.deepEqual(await customAnswers(app), undefined);
  });
});

test('the guided setup remembers how many of its six steps are done until it is finished', async () => {
  const fresh = await desktop({ settings: trusted });
  assert.equal(await fresh.invoke('setupProgress'), null, 'no setup under way');
  assert.deepEqual(plain(await fresh.invoke('startSetup')), { step: 0, steps: 6 });
  assert.deepEqual(fresh.writes.at(-1), { file: path.join(fresh.userData, 'setup-progress.json'), json: { version: 1, step: 0 } });
  assert.deepEqual(plain(await fresh.invoke('saveSetupProgress', 3)), { step: 3, steps: 6 });
  assert.deepEqual(plain(await fresh.invoke('saveSetupProgress', 2)), { step: 3, steps: 6 }, 'going back keeps the steps already done');
  assert.equal(await fresh.invoke('saveSetupProgress', 6), null, 'all six done: setup is finished');
  assert.deepEqual(fresh.removed, [path.join(fresh.userData, 'setup-progress.json')]);
  for (const step of [-1, 7, 2.5, '3', null]) await assert.rejects(fresh.invoke('saveSetupProgress', step), /Request denied|step/, JSON.stringify(step));

  const resumed = await desktop({ settings: trusted, setup: { version: 1, step: 3 } });
  assert.deepEqual(plain(await resumed.invoke('setupProgress')), { step: 3, steps: 6 });
  await resumed.invoke('lock');
  await assert.rejects(resumed.invoke('setupProgress'), /Unlock/);
  await assert.rejects(resumed.invoke('saveSetupProgress', 4), /Unlock/);
  const finished = await desktop({ settings: trusted });
  await assert.rejects(finished.invoke('saveSetupProgress', 2), /isn’t under way/);
  const broken = await desktop({ settings: trusted, setup: '{"version":1,"step":"three"}' });
  await assert.rejects(broken.invoke('setupProgress'), /setup progress/, 'an unreadable progress file fails loudly');
});

// recordProgress: after Autofill fills Iowa's form, the application record says it is in progress. A
// submission is never inferred: only the applicant marks an application submitted, with its receipt number.
const record = (n, status, changes = {}) => ({ id: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`, program: 'Iowa SNAP', status,
  createdAt: '2020-09-01T12:00:00.000Z', updatedAt: '2020-09-02T12:00:00.000Z', confirmationNumber: status === 'submitted' ? `SYNTHETIC-RECEIPT-${n}` : '',
  notes: `Synthetic note ${n}`, nextAction: 'Upload pay stubs', dueDate: '2026-10-20', ...changes });
const PROGRESS = { type: 'recordProgress', filledCount: 100 };

test('recordProgress starts an in-progress Iowa SNAP record when there is none, and fills after it update the same one', async () => {
  const app = await desktop();
  assert.deepEqual(plain(await app.request(PROGRESS)), { recorded: true });
  const [started] = plain(await app.invoke('getData')).applications;
  assert.equal(started.program, 'Iowa SNAP');
  assert.equal(started.status, 'in_progress');
  assert.equal(started.confirmationNumber, '');
  assert.match(started.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(app.idleTimers(), [IDLE_MS], 'a fill is activity');
  await app.request(PROGRESS);
  const after = plain(await app.invoke('getData')).applications;
  assert.equal(after.length, 1);
  assert.equal(after[0].id, started.id);
  assert.equal(after[0].status, 'in_progress');
});

test('recordProgress moves only the newest draft or in-progress record to in progress, keeping its details, and never marks it submitted', async () => {
  const records = [record(1, 'draft'), record(2, 'draft'), record(3, 'submitted'), record(4, 'approved')];
  const app = await desktop({ applications: records });
  for (let fill = 0; fill < 3; fill++) await app.request(PROGRESS);
  const after = plain(await app.invoke('getData')).applications;
  assert.equal(after.length, 4, 'no record is added');
  assert.deepEqual(after[0], records[0], 'an older draft stays as it was');
  const { updatedAt, ...moved } = after[1];
  assert.deepEqual(moved, (({ updatedAt: _, ...rest }) => ({ ...rest, status: 'in_progress' }))(records[1]), 'the newest draft keeps its id, dates, receipt number, notes, next step and due date');
  assert.ok(updatedAt > records[1].updatedAt);
  assert.deepEqual(after.slice(2), records.slice(2), 'submitted and decided records stay as they were');
});

test('with only submitted, decided or needs-action records, recordProgress adds a new in-progress record and changes none of them', async () => {
  const records = [record(1, 'submitted'), record(2, 'approved'), record(3, 'denied'), record(4, 'needs_action')];
  const app = await desktop({ applications: records });
  await app.request(PROGRESS);
  const after = plain(await app.invoke('getData')).applications;
  assert.deepEqual(after.slice(0, 4), records);
  assert.equal(after.length, 5);
  assert.equal(after[4].status, 'in_progress');
  assert.equal(after.filter(item => item.status === 'submitted').length, 1, 'no submission is inferred');
});

test('recordProgress needs SecondHand unlocked', async () => {
  const app = await desktop({ applications: [record(1, 'draft')] });
  await app.invoke('lock');
  await assert.rejects(app.request(PROGRESS), /Unlock SecondHand first/);
  await app.invoke('unlock', 'synthetic password');
  assert.deepEqual(plain(await app.invoke('getData')).applications, [record(1, 'draft')]);
});

// #135: one "today", on this computer's calendar, for checking birth dates when they are saved and for
// working out ages. A birth date saved earlier that today's checks would refuse never fails a request.
test('ages follow the day the app runs on: on 2027-02-14 the child born 2021-02-14 turns 6 and leaves the 0 to 5 band', async () => {
  const birthday = await desktop({ settings: trusted, today: '2027-02-14' });
  await birthday.invoke('saveProfile', listedHousehold());
  assert.deepEqual(plain((await birthday.request({ type: 'getFields', fields: ['householdCount:0-5', 'householdCount:6-17', 'householdChildren'] })).values),
    { 'householdCount:0-5': '0', 'householdCount:6-17': '2', householdChildren: '2' });
  const before = await desktop({ settings: trusted, today: '2027-02-13' });
  await before.invoke('saveProfile', listedHousehold());
  assert.deepEqual(plain((await before.request({ type: 'getFields', fields: ['householdCount:0-5'] })).values), { 'householdCount:0-5': '1' }, 'the day before, still 5');
});

test('a pinned day is for tests only: it needs test mode and an unpackaged app, and must be a real date', async () => {
  await assert.rejects(desktop({ env: { SECONDHAND_TEST_TODAY: TODAY } }), /SECONDHAND_TEST_TODAY needs SECONDHAND_TEST_MODE=1/);
  await assert.rejects(desktop({ packaged: true, env: { SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_TODAY: TODAY } }), /packaged SecondHand refuses SECONDHAND_TEST_TODAY/);
  await assert.rejects(desktop({ env: { SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_TODAY: '2026-02-30' } }), /real date/);
});

test('on an Iowa evening, with no day pinned, My information refuses a child born tomorrow', async t => {
  const before = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  t.after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
  // 8:30 pm on October 5 in Iowa: already October 6 in UTC.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T01:30:00Z') });
  const app = await desktop({ settings: trusted, env: {} });
  await assert.rejects(app.invoke('saveProfile', listedHousehold({ 2: { birthDate: '2026-10-06' } })), /Person 3’s date of birth can’t be after today \(2026-10-05 on this computer\)\./);
  const saved = await app.invoke('saveProfile', listedHousehold({ 2: { birthDate: '2026-10-05' } }));
  assert.equal(saved.householdMembers[2].birthDate, '2026-10-05', 'born today');
});

test('My information and Save to My information refuse a birth date after today or more than 130 years ago, and say which', async () => {
  const app = await desktop({ settings: trusted });
  await assert.rejects(app.invoke('saveProfile', { birthDate: '2026-10-06' }), /Your date of birth can’t be after today \(2026-10-05 on this computer\)\./);
  await assert.rejects(app.invoke('saveProfile', listedHousehold({ 3: { birthDate: '1825-06-01' } })), /Person 4’s date of birth can’t be more than 130 years ago\./);
  app.answer(async () => ({ response: 1 }));
  await assert.rejects(app.request({ type: 'saveFields', url: PANTRY, fields: { birthDate: '2026-10-06' } }), error => /can’t be after today/.test(error.publicMessage));
  assert.equal(app.prompts.length, 0, 'a refused date is never offered for confirmation');
});

// Saved while the clock was later (a child born 2026-10-08), or before the 130-year limit existed (a parent born 1825).
// As the vault keeps it, the applicant's own row carries their name and birth date.
const unusableDates = listedHousehold({ 0: { firstName: 'Synthetic', lastName: 'Applicant', birthDate: '1985-04-12' }, 2: { birthDate: '2026-10-08' }, 3: { birthDate: '1825-06-01' } });

test('a saved birth date the app can’t use never fails a field request: answers from ages stay with the applicant, and the reply says why', async () => {
  const app = await desktop({ settings: trusted, profile: unusableDates });
  app.answer(async () => ({ response: 1 }));
  const reply = plain(await app.request({ type: 'getFields', url: PANTRY, fields: [...BANDS, 'householdChildren', 'householdSize', 'studentNameGrade', 'firstName'] }));
  assert.deepEqual(reply.values, { householdSize: '4', studentNameGrade: 'Riley Example, 5th', firstName: 'Synthetic' });
  assert.equal(reply.reason, 'birthDate');
  const unrelated = plain(await app.request({ type: 'getFields', url: PANTRY, fields: ['firstName', 'householdSize'] }));
  assert.equal(unrelated.reason, undefined, 'nothing was left out because of a birth date');
  // The applicant's own date: never filled into a page.
  const own = await desktop({ settings: trusted, profile: { firstName: 'Synthetic', birthDate: '2026-10-08' } });
  const ownReply = plain(await own.request({ type: 'getFields', fields: ['birthDate', 'firstName'] }));
  assert.deepEqual(ownReply.values, { firstName: 'Synthetic' });
  assert.equal(ownReply.reason, 'birthDate');
});

test('a saved birth date the app can’t use never fails Laya: it answers from the other facts and the reply says why', async () => {
  const ownDate = listedHousehold({ 0: { firstName: 'Synthetic', lastName: 'Applicant', birthDate: '2026-10-08' } });
  const app = await desktop({ laya: stubLaya(sixtyFromAge), settings: trusted, profile: { ...ownDate, birthDate: '2026-10-08', householdVeteran: 'no' } });
  app.answer(async () => ({ response: 1 }));
  const reply = plain(await app.request(answerRequest([sixty, veteran])));
  assert.deepEqual(reply.answers, { [veteran.id]: 'No' }, 'no age, so 60 or older stays with the applicant');
  assert.equal(reply.reason, 'birthDate');
  const fine = await desktop({ laya: stubLaya(sixtyFromAge), settings: trusted, profile: { ...household } });
  const answered = plain(await fine.request(answerRequest([sixty, veteran])));
  assert.equal(answered.reason, undefined);
});

test('Save to My information is refused while a saved birth date can’t be used, naming whose date to fix in My information', async () => {
  const app = await desktop({ settings: trusted, profile: unusableDates });
  app.answer(async () => ({ response: 1 }));
  await assert.rejects(app.request({ type: 'saveFields', url: PANTRY, fields: { county: 'Story' } }), error => error.publicMessage ===
    'Person 3’s date of birth can’t be after today (2026-10-05 on this computer). Fix the date in My information, then save this answer again.');
  const own = await desktop({ settings: trusted, profile: { firstName: 'Synthetic', birthDate: '1825-06-01' } });
  await assert.rejects(own.request({ type: 'saveFields', url: PANTRY, fields: { county: 'Story' } }), error => error.publicMessage ===
    'Your date of birth can’t be more than 130 years ago. Fix the date in My information, then save this answer again.');
  assert.equal(app.prompts.length + own.prompts.length, 0, 'nothing is offered for confirmation');
  assert.equal(plain(await app.invoke('getData')).profile.county, undefined);
  // A date of birth saved from the page is that answer’s own problem, not My information’s.
  const fresh = await desktop({ settings: trusted, profile: { firstName: 'Synthetic' } });
  await assert.rejects(fresh.request({ type: 'saveFields', url: PANTRY, fields: { birthDate: '2026-10-06' } }), error => error.publicMessage ===
    'Your date of birth can’t be after today (2026-10-05 on this computer).');
});

const jobId = number => `aaaaaaaa-bbbb-4ccc-8ddd-${String(number).padStart(12, '0')}`;
const savedJob = (number, extra = {}) => ({ id: jobId(number), person: 'Avery Example', employer: `Fictional Employer ${number}`,
  workOrTraining: 'Work', monthlyHours: '160', amount: '1200', frequency: 'Every Other Week', ...extra });
const jobRequest = extra => ({ type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, pageKey: 'iowa-job-history',
  recordType: 'jobs', fields: ['person', 'employer', 'monthlyHours'], ...extra });

test('one explicitly owned job releases only requested fields after ordinary approval, without saving or exposing the list', async () => {
  const app = await desktop({ profile: { jobs: [savedJob(1)], taxStatements: [{ annualIncome: '90000' }], ssn: '123456789' } });
  const response = plain(await app.request(jobRequest({ personName: '  avery   EXAMPLE ' })));
  assert.deepEqual(response.values, { person: 'Avery Example', employer: 'Fictional Employer 1', monthlyHours: '160' });
  assert.equal(response.recordId, jobId(1)); assert.ok(Number.isSafeInteger(response.accessRevision));
  assert.equal(app.prompts.length, 1); assert.match(app.prompts[0].message, /saved job record/);
  assert.deepEqual(Object.keys(response).sort(), ['accessRevision', 'recordId', 'values']);
  assert.equal(app.writes.length, 0); assert.equal(app.notifications.length, 0);
});

test('record scope and extension identity are checked before reading even for Always allow or all websites', async () => {
  const app = await desktop({ profile: { jobs: [savedJob(1)] }, settings: { extensionId, autofillWithoutAsking: true, allSites: true } });
  for (const change of [{ url: 'https://pantry.example.org/intake' }, { url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions?x=1` },
    { recordType: 'taxStatements' }, { pageKey: 'iowa-expenses' }, { pageKey: '__proto__' }, { fields: ['employer'] },
    { fields: ['person', 'ssn'] }, { fields: ['person', 'jobs'] }, { recordId: jobId(1) }, { personName: 'Avery\u202EExample' }]) {
    await assert.rejects(app.request(jobRequest(change)), /unsupported record or field/);
  }
  assert.equal(app.dataReads, 0); assert.equal(app.prompts.length, 0);
  await app.invoke('connectExtension', 'b'.repeat(32));
  await assert.rejects(app.request(jobRequest()), /access changed/);
  assert.equal(app.dataReads, 0);
});

test('missing or blank-owner job records return only a generic missing result, without inference or candidate details', async () => {
  for (const profile of [{ jobs: [] }, { jobs: [savedJob(1, { person: '  ' })] }, { jobs: [savedJob(1, { person: 'Avery Q. Example' })] },
    { firstName: 'Avery', lastName: 'Example', jobs: [], taxStatements: [{ recipientName: 'Avery Example', sourceName: 'Tax payer', annualIncome: '20000' }] }]) {
    const app = await desktop({ profile });
    const response = plain(await app.request(jobRequest({ personName: 'Avery Example' })));
    assert.deepEqual(response, { values: {}, reason: 'recordMissing', accessRevision: response.accessRevision });
    assert.ok(Number.isSafeInteger(response.accessRevision)); assert.equal(app.prompts.length, 0); assert.equal(app.writes.length, 0);
  }
});

test('multiple exact-owner jobs require a desktop record choice even with Always allow; other owners are not offered', async () => {
  const app = await desktop({ profile: { jobs: [savedJob(1), savedJob(2), savedJob(3, { person: 'Different Person' })] },
    settings: { extensionId, autofillWithoutAsking: true } });
  app.answer(async () => ({ response: 2 }));
  const response = plain(await app.request(jobRequest({ personName: 'Avery Example' })));
  assert.equal(response.recordId, jobId(2)); assert.equal(response.values.employer, 'Fictional Employer 2');
  assert.equal(app.prompts.length, 1); assert.equal(app.prompts[0].defaultId, 0);
  assert.match(app.prompts[0].detail, /Fictional Employer 1/); assert.match(app.prompts[0].detail, /Fictional Employer 2/);
  assert.doesNotMatch(JSON.stringify(app.prompts), /Different Person|Employer 3/);
});

test('an unselected portal person can choose one explicitly owned saved record; blank owners are never offered', async () => {
  const app = await desktop({ profile: { jobs: [savedJob(1), savedJob(2, { person: 'Jordan Sample' }), savedJob(3, { person: '' })] } });
  let prompt = 0; app.answer(async () => ({ response: ++prompt === 1 ? 2 : 1 }));
  const response = plain(await app.request(jobRequest({ personName: '' })));
  assert.equal(response.recordId, jobId(2)); assert.equal(response.values.person, 'Jordan Sample');
  assert.equal(app.prompts.length, 2); assert.doesNotMatch(JSON.stringify(app.prompts), /Employer 3/);
});

test('record chooser and field approval cancellation release nothing, and overlapping requests cannot skip the chooser', async () => {
  for (const choice of ['choose', 'approve']) {
    const app = await desktop({ profile: { jobs: choice === 'choose' ? [savedJob(1), savedJob(2)] : [savedJob(1)] } });
    let resolve; app.answer(() => new Promise(done => { resolve = done; }));
    const pending = app.request(jobRequest());
    await tick();
    await assert.rejects(app.request(jobRequest()), /waiting for your approval/);
    resolve({ response: 0 }); await assert.rejects(pending, /cancelled/);
    assert.equal(app.prompts.length, 1); assert.equal(app.writes.length, 0);
  }
});

for (const phase of ['chooser', 'approval']) for (const mutation of ['lock', 'profile', 'registration']) test(`record ${phase} invalidates after ${mutation}`, async () => {
  const app = await desktop({ profile: { jobs: phase === 'chooser' ? [savedJob(1), savedJob(2)] : [savedJob(1)] } });
  let resolve; app.answer(() => new Promise(done => { resolve = done; }));
  const pending = app.request(jobRequest()); await tick();
  if (mutation === 'lock') { await app.invoke('lock'); await app.invoke('unlock', 'synthetic'); }
  if (mutation === 'profile') await app.invoke('saveProfile', { jobs: [savedJob(1, { employer: 'Changed employer' })] });
  if (mutation === 'registration') { await app.invoke('connectExtension', 'b'.repeat(32)); await app.invoke('connectExtension', extensionId); }
  resolve({ response: 1 }); await assert.rejects(pending, /access changed/);
  assert.equal(app.prompts.length, 1);
});

test('Always allow returns the new receipt after saving trust while preserving the explicitly selected job', async () => {
  const app = await desktop({ profile: { jobs: [savedJob(1)] } });
  const before = (await app.request({ type: 'status' })).accessRevision;
  app.answer(async () => ({ response: 2 }));
  const response = await app.request(jobRequest({ fields: ['person', 'amount'] }));
  assert.equal(response.accessRevision, before + 1);
  assert.deepEqual(plain(response.values), { person: 'Avery Example', amount: '1200' });
  assert.equal(response.accessRevision, (await app.request({ type: 'status' })).accessRevision);
  assert.equal(app.writes.length, 1);
});

test('captured retirement form releases one explicitly owned Private Pension only, never sources, dates, taxes, or annual inference', async () => {
  const app = await desktop({ profile: { monthlyOtherIncome: '9000', jobs: [savedJob(1)],
    otherIncomeSources: [
      { id: jobId(21), person: 'Avery Example', type: 'Railroad Retirement', amount: '999', frequency: 'Monthly' },
      { id: jobId(22), person: 'Avery Example', type: 'Private Pension', amount: '1200.50', frequency: 'Monthly', source: 'Local-only payer', startDate: '2025-01-01', expectedChange: 'Local-only note' },
      { id: jobId(23), person: 'Another Person', type: 'Private Pension', amount: '5000', frequency: 'Monthly' }
    ], taxStatements: [{ annualIncome: '68450', documentType: 'ssa-1099' }] } });
  const request = { type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, pageKey: 'iowa-retirement-income',
    recordType: 'otherIncomeSources', personName: 'Avery Example', fields: ['person', 'type', 'amount', 'frequency'] };
  const response = plain(await app.request(request));
  assert.equal(response.recordId, jobId(22));
  assert.deepEqual(response.values, { person: 'Avery Example', type: 'Private Pension', amount: '1200.50', frequency: 'Monthly' });
  assert.deepEqual(Object.keys(response).sort(), ['accessRevision', 'recordId', 'values']);
  assert.equal(app.prompts.length, 1); assert.match(app.prompts[0].message, /saved income record/);
  assert.equal(app.writes.length, 0);
  const missing = await desktop({ profile: { otherIncomeSources: [{ id: jobId(21), person: 'Avery Example', type: 'private pension', amount: '900' }] } });
  const result = plain(await missing.request(request));
  assert.deepEqual(result, { values: {}, reason: 'recordMissing', accessRevision: result.accessRevision });
  assert.equal(missing.prompts.length, 0, 'unsupported or ambiguous income types are not guessed');
});

test('observed Social Security retirement uses the explicit current record, not an SSA-1099 amount', async () => {
  const app = await desktop({ profile: { otherIncomeSources: [{ id: jobId(25), person: 'Avery Example', type: 'Social Security', amount: '250', frequency: 'Monthly' }],
    taxStatements: [{ documentType: 'ssa-1099', annualIncome: '68450' }] } });
  const response = plain(await app.request({ type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, pageKey: 'iowa-retirement-income',
    recordType: 'otherIncomeSources', fields: ['person', 'type', 'amount', 'frequency'], personName: 'Avery Example' }));
  assert.deepEqual(response.values, { person: 'Avery Example', type: 'Social Security', amount: '250', frequency: 'Monthly' });
  assert.equal(response.recordId, jobId(25));
});

test('captured rent responsibility uses explicit owned Rent records and aliases, without the household rent total', async () => {
  const request = { type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, pageKey: 'iowa-housing-expenses',
    recordType: 'housingExpenses', fields: ['person', 'type', 'amount', 'frequency'], personName: 'Avery Example' };
  for (const type of ['Rent', 'Rent(Amount you are responsible to pay)', ' Rent(Amount  you are responsible to pay) ']) {
    const app = await desktop({ profile: { monthlyRent: '9999', housingExpenses: [{ id: jobId(31), person: 'Avery Example', type,
      amount: '350', frequency: 'Monthly', paidTo: 'Local-only landlord', startDate: '2026-01-01' }] } });
    const response = plain(await app.request(request));
    assert.deepEqual(response.values, { person: 'Avery Example', type: type.trim(), amount: '350', frequency: 'Monthly' });
    assert.deepEqual(Object.keys(response).sort(), ['accessRevision', 'recordId', 'values']);
  }
  for (const profile of [{ monthlyRent: '9999' }, { housingExpenses: [{ id: jobId(31), person: 'Avery Example', type: 'Mortgage', amount: '350' }] }]) {
    const app = await desktop({ profile });
    const response = plain(await app.request(request));
    assert.deepEqual(response, { values: {}, reason: 'recordMissing', accessRevision: response.accessRevision });
  }
});

test('utility release uses one explicit owner and never household utility answers or totals', async () => {
  const request = { type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, pageKey: 'iowa-utility-expenses', recordType: 'utilityExpenses',
    fields: ['person', 'gas', 'electricity', 'waterSewage', 'telephone', 'petFees', 'garageRent', 'landlordExtra', 'garbage', 'heatingCooling'], personName: 'Avery Example' };
  const app = await desktop({ profile: { utilityGas: 'yes', utilityElectricity: 'no', monthlyUtilities: '9999', utilityExpenses: [
    { id: jobId(41), person: 'Avery Example', gas: 'no', electricity: 'yes', waterSewage: 'no', telephone: 'yes', petFees: 'no', garageRent: 'no', landlordExtra: 'no', garbage: 'yes', heatingCooling: 'yes' },
    { id: jobId(42), person: 'Another Person', gas: 'yes' }] } });
  const response = plain(await app.request(request));
  assert.equal(response.recordId, jobId(41));
  assert.deepEqual(response.values, { person: 'Avery Example', gas: 'no', electricity: 'yes', waterSewage: 'no', telephone: 'yes', petFees: 'no', garageRent: 'no', landlordExtra: 'no', garbage: 'yes', heatingCooling: 'yes' });
  const missing = await desktop({ profile: { utilityGas: 'yes', utilityElectricity: 'no', monthlyUtilities: '9999' } });
  const result = plain(await missing.request(request));
  assert.deepEqual(result, { values: {}, reason: 'recordMissing', accessRevision: result.accessRevision });
  assert.equal(missing.prompts.length, 0);
});

const assetRequest = extra => ({ type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, pageKey: 'iowa-liquid-assets', recordType: 'assets',
  fields: ['person', 'type', 'currentValue', 'amountOwed', 'accountOrPolicy', 'institution', 'acquiredDate'], personName: 'Avery Example', ...extra });

test('captured cash asset releases explicit saved details without optional zero defaults, household cash, or shared-owner data', async () => {
  const app = await desktop({ profile: { cashOnHand: '9999', assets: [
    { id: jobId(51), person: 'Avery Example', type: 'Cash/Uncashed Check', currentValue: '50', description: 'Local only', sharedWith: 'Other Person', ownershipShare: 'Half' },
    { id: jobId(52), person: 'Avery Example', type: 'Checking Account', currentValue: '1000' }] } });
  const response = plain(await app.request(assetRequest()));
  assert.deepEqual(response.values, { person: 'Avery Example', type: 'Cash/Uncashed Check', currentValue: '50' });
  assert.equal(response.recordId, jobId(51)); assert.equal(app.prompts.length, 1); assert.equal(app.writes.length, 0);
  const missing = await desktop({ profile: { cashOnHand: '9999', assets: [{ id: jobId(52), person: 'Avery Example', type: 'Checking Account', currentValue: '1000' }] } });
  const result = plain(await missing.request(assetRequest()));
  assert.deepEqual(result, { values: {}, reason: 'recordMissing', accessRevision: result.accessRevision });
  assert.equal(missing.prompts.length, 0);
});

test('liquid asset approval cannot release stale values after a profile access-revision change', async () => {
  const app = await desktop({ profile: { assets: [{ id: jobId(51), person: 'Avery Example', type: 'Cash/Uncashed Check', currentValue: '50' }] } });
  let resolve; app.answer(() => new Promise(done => { resolve = done; }));
  const pending = app.request(assetRequest()); await tick();
  await app.invoke('saveProfile', { assets: [{ id: jobId(51), person: 'Avery Example', type: 'Cash/Uncashed Check', currentValue: '100' }] });
  resolve({ response: 1 }); await assert.rejects(pending, /access changed/);
});

// #180: Autofill on a pantry form leaves its household questions open while no household list is saved, and says so.
test('a household question left open because no household list is saved says so beside the answers; Iowa’s portal never hears it (#180)', async () => {
  const app = await desktop({ settings: trusted });
  await app.invoke('saveProfile', { firstName: 'Synthetic', zip: '50309', householdSize: '3' });
  const reply = plain(await app.request({ type: 'getFields', url: PANTRY, fields: ['householdCount:0-5', 'householdSize', 'zip'] }));
  assert.deepEqual(reply.values, { householdSize: '3', zip: '50309' });
  assert.deepEqual(reply.household, { need: 'list' });
  for (const fields of [['householdAdults'], ['studentNameGrade'], ['householdCount:60+', 'firstName']]) {
    assert.deepEqual(plain(await app.request({ type: 'getFields', url: PANTRY, fields })).household, { need: 'list' }, JSON.stringify(fields));
  }
  // Every household question answered, or none asked: nothing about the list is said.
  for (const fields of [['householdSize'], ['zip', 'firstName']]) assert.equal(plain(await app.request({ type: 'getFields', url: PANTRY, fields })).household, undefined, JSON.stringify(fields));
  assert.equal(plain(await app.request({ type: 'getFields', fields: ['householdCount:0-5', 'householdAdults'] })).household, undefined, 'Iowa’s portal');
});

test('with a household list saved, a count by age left open names the first person without a birth date by their row, never by name (#180)', async () => {
  const app = await desktop({ settings: trusted });
  await app.invoke('saveProfile', listedHousehold({ 2: { birthDate: '' }, 3: { birthDate: '' } }));
  const reply = plain(await app.request({ type: 'getFields', url: PANTRY, fields: [...BANDS, 'householdSize', 'studentNameGrade'] }));
  assert.deepEqual(reply.values, { householdSize: '4', studentNameGrade: 'Riley Example, 5th' });
  assert.deepEqual(reply.household, { need: 'birthDate', person: 3 });
  assert.doesNotMatch(JSON.stringify(reply), /Sam|Morgan|1958|householdMembers/);
  assert.equal(plain(await app.request({ type: 'getFields', url: PANTRY, fields: ['householdSize'] })).household, undefined, 'the size needs no birth dates');
  await app.invoke('saveProfile', { ...listedHousehold(), birthDate: '' });
  assert.deepEqual(plain(await app.request({ type: 'getFields', url: PANTRY, fields: ['householdChildren'] })).household, { need: 'birthDate', person: 'you' }, 'the applicant’s own row');
  await app.invoke('saveProfile', listedHousehold());
  assert.equal(plain(await app.request({ type: 'getFields', url: PANTRY, fields: [...BANDS] })).household, undefined, 'every birth date saved');
});

test('openHousehold brings the window forward on My information, at Your household, even while locked, and reads nothing (#180)', async () => {
  const app = await desktop();
  await app.invoke('lock');
  const before = { shows: app.shows, reads: app.dataReads, sent: app.notifications.length };
  assert.deepEqual(plain(await app.request({ type: 'openHousehold' })), { shown: true });
  assert.equal(app.shows, before.shows + 1);
  assert.deepEqual(app.notifications.slice(before.sent), [['secondhand:open-household']], 'the window hears where to go, and nothing else');
  assert.equal(app.dataReads, before.reads);
});

test('the Overview note about the household list is dismissed once, kept with the settings, and reported in status (#180)', async () => {
  const app = await desktop({ settings: { extensionId } });
  assert.equal((await app.invoke('status')).householdNoteDismissed, false);
  assert.equal((await app.invoke('dismissHouseholdNote')).householdNoteDismissed, true);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: false, trustedSites: [], householdNoteDismissed: true });
  const later = await desktop({ settings: { extensionId, householdNoteDismissed: true } });
  assert.equal((await later.invoke('status')).householdNoteDismissed, true, 'a later start reads it back');
  await later.invoke('lock');
  await assert.rejects(later.invoke('dismissHouseholdNote'), /Unlock/);
});
