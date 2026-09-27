'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { PORTAL_URL } = require('../shared/schema.cjs');

const extensionId = 'a'.repeat(32);
const context = { extensionId };
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
// Values created inside the vm context have foreign prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

async function desktop(options = {}) {
  let bridge;
  let shows = 0;
  let dataReads = 0;
  const writes = [];
  let invoke;
  let window;
  let answer = async () => ({ response: 1 });
  const prompts = [];
  const notifications = [];
  const powerEvents = new Map();
  class Vault {
    constructor() { this.unlocked = true; this.data = { profile: { firstName: 'Synthetic', lastName: '' }, applications: [] }; }
    async exists() { return true; }
    async inspect() { return { recoveryKey: true }; }
    async lock() { if (options.beforeLock) await options.beforeLock(); this.unlocked = false; }
    async unlock() { this.unlocked = true; }
    getData() { dataReads++; return this.data; }
    async update(change) { change(this.data); }
  }
  class BrowserWindow {
    constructor() {
      window = this;
      this.webContents = { mainFrame: { url: pathToFileURL(path.join(root, 'renderer/index.html')).href },
        setWindowOpenHandler() {}, on() {}, send(...args) { notifications.push(args); } };
    }
    show() { shows++; } focus() {} setMenuBarVisibility() {} once() {} on() {} loadFile() {}
    isDestroyed() { return false; }
  }
  const app = { isPackaged: false, setName() {}, setPath() {}, getPath: () => '/synthetic-local-data',
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on() {} };
  const electron = { app, BrowserWindow, ipcMain: { handle(_name, handler) { invoke = handler; } },
    dialog: { async showMessageBox(_parent, options) { prompts.push(options); return answer(); }, showErrorBox() { assert.fail('Desktop setup failed'); } },
    shell: {}, clipboard: {}, powerMonitor: { on(name, handler) { powerEvents.set(name, handler); } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } };
  const overrides = {
    electron,
    'node:fs/promises': { mkdir: async () => {}, stat: async () => ({ size: 10 }), readFile: async () => JSON.stringify(options.settings ?? { extensionId }) },
    './vault.cjs': { Vault, atomicWrite: async (file, bytes) => { writes.push({ file, json: JSON.parse(bytes.toString()) }); }, MAX_VAULT_BYTES: 1000 },
    './bridge.cjs': { ...require('../desktop/bridge.cjs'), startBridge: async (_directory, _getId, handler) => { bridge = handler; return { close: async () => {} }; } },
    './extension-setup.cjs': { getExtensionSetup: async () => ({ prepared: true }) },
    './registration.cjs': { registerHost: async () => ({}) },
    './test-storage-path.cjs': { testStoragePath: () => null },
    // The one place the desktop gets its Laya runtime. Without an override, this build's real module answers.
    ...(options.laya ? { './laya-runtime.cjs': { createLayaRuntime: () => options.laya } } : {})
  };
  vm.runInNewContext(source, {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name.startsWith('.') ? path.join(root, 'desktop', name) : name),
    __dirname: path.join(root, 'desktop'), process: { platform: process.platform, env: {}, argv: ['synthetic-electron'] },
    setTimeout: () => 1, clearTimeout() {}, Buffer
  });
  await tick();
  assert.equal(typeof bridge, 'function');
  return {
    prompts, notifications, writes,
    get shows() { return shows; },
    get dataReads() { return dataReads; },
    answer: callback => { answer = callback; },
    request: request => bridge({ id: 'synthetic', url: PORTAL_URL, ...request }, context),
    invoke: (method, argument) => invoke({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, method, ...(argument === undefined ? [] : [argument])),
    async sleep() { powerEvents.get('suspend')(); await tick(); }
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
  for (const page of ['enterPersonalInfo', 'addressValidation']) for (const trusted of [false, true]) {
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

test('sensitive fields on a non-Iowa site always ask, even with Always allow on', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', { firstName: 'Synthetic', ssn: '123-45-6789', monthlyEarnedIncome: '900' });
  app.answer(async () => ({ response: 1 }));
  const { values } = await app.request({ type: 'getFields', url: PANTRY, fields: ['firstName', 'ssn', 'monthlyEarnedIncome'] });
  assert.equal(values.ssn, '123-45-6789');
  assert.equal(app.prompts.length, 1);
  assert.deepEqual(plain(app.prompts[0].buttons), ['Cancel', 'Allow once']);
  assert.match(app.prompts[0].detail, /Social Security number/);
  assert.match(app.prompts[0].message, /pantry\.example\.org/);
  await app.request({ type: 'getFields', fields: ['ssn'] });
  assert.equal(app.prompts.length, 1, 'Iowa keeps its own trust rules');
});

test('money on hand and medical expenses always ask on other sites but follow Iowa’s trust rules on Iowa', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', { assetsOnHand: '250', monthlyMedicalExpenses: '40', householdPregnant: 'no' });
  app.answer(async () => ({ response: 1 }));
  for (const field of ['assetsOnHand', 'monthlyMedicalExpenses']) {
    const before = app.prompts.length;
    await app.request({ type: 'getFields', url: PANTRY, fields: ['householdPregnant', field] });
    assert.equal(app.prompts.length, before + 1, field);
    assert.deepEqual(plain(app.prompts.at(-1).buttons), ['Cancel', 'Allow once']);
    assert.match(app.prompts.at(-1).detail, field === 'assetsOnHand' ? /Money on hand/ : /Monthly medical expenses/);
  }
  const prompts = app.prompts.length;
  assert.deepEqual(plain((await app.request({ type: 'getFields', fields: ['assetsOnHand', 'monthlyMedicalExpenses'] })).values), { assetsOnHand: '250', monthlyMedicalExpenses: '40' });
  assert.equal(app.prompts.length, prompts, 'Iowa keeps its own trust rules');
  app.answer(async () => ({ response: 1 }));
  await app.request({ type: 'trustSite', url: 'https://wic.example.gov/apply' });
  assert.match(app.prompts.at(-1).detail, /money on hand, and medical expenses still ask every time/);
});

test('removing a trusted site stops field release; a locked vault cannot trust sites', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org', 'https://wic.example.gov'] } });
  assert.deepEqual(plain((await app.invoke('removeTrustedSite', 'https://pantry.example.org')).trustedSites), ['https://wic.example.gov']);
  await assert.rejects(app.request({ type: 'getFields', url: PANTRY, fields: ['firstName'] }), /isn’t trusted/);
  await app.invoke('lock');
  await assert.rejects(app.request({ type: 'trustSite', url: PANTRY }), /Unlock/);
  const stored = await desktop({ settings: { extensionId, trustedSites: ['https://ok.example.org', 'http://bad.example.org', 'javascript:1', 42] } });
  assert.deepEqual(plain((await stored.invoke('status')).trustedSites), ['https://ok.example.org']);
});

// A stand-in for the Laya runtime (#38) with its exact interface. `scores(state)` plays the model.
function stubLaya(scores = () => 0.01, state = 'ready') {
  const batches = [];
  return { batches, status: () => ({ state }), decide: async () => { throw new Error('the desktop scores in batches'); },
    decideBatch: async items => { batches.push(items); return items.map(item => ({ answers: { correct: { noul: scores(item.state) } } })); } };
}
const box = { id: 'f0:sh-1-2', label: 'Where can we reach you by email?', type: 'email', options: [] };
const sixty = { id: 'f0:sh-1-3', label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'] };
const veteran = { id: 'f0:sh-1-4', label: 'Is anyone in your household a veteran?', type: 'radio', options: ['Yes', 'No'] };
const layaRequests = [{ type: 'suggestFields', url: PANTRY, fields: [box] }, { type: 'answerFields', url: PANTRY, questions: [sixty] }];
// Only the applicant's age (a sensitive fact) settles 60+ for a household of one.
const sixtyFromAge = state => {
  if (state.question === sixty.label) return state.facts.includes('years old') ? (state.candidate === 'No' ? 0.97 : 0.01) : (state.candidate.startsWith('None') ? 0.95 : 0.01);
  if (state.question === veteran.label) return state.candidate === 'No' ? 0.98 : 0.01;
  return state.candidate === 'Saved answer: email address' ? 0.99 : 0.01;
};
const household = { birthDate: '1985-04-12', householdSize: '1', householdAdults: '1', householdChildren: '0', householdSeniors: '0', householdVeteran: 'no', county: 'Polk' };

test('this build has no Laya runtime: both Laya requests answer "not ready" and status says Laya is unavailable', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  assert.deepEqual(plain((await app.request({ type: 'status' })).laya), { state: 'unavailable' });
  const reads = app.dataReads;
  for (const request of [...layaRequests, { type: 'answerFields', url: 'https://untrusted.example.org/', questions: [sixty] }]) {
    await assert.rejects(app.request(request), error => error.publicCode === 'LAYA_NOT_READY' && /Laya isn’t ready/.test(error.publicMessage), request.type);
  }
  assert.equal(app.dataReads, reads, 'the vault is never read');
  assert.equal(app.prompts.length, 0);
});

test('a Laya that is off, downloading, or failing answers "not ready" the same way; its state shows in status', async () => {
  for (const state of ['off', 'not-downloaded', 'downloading', 'error', 'unavailable']) {
    const app = await desktop({ laya: stubLaya(() => 0.99, state), settings: { extensionId, trustedSites: ['https://pantry.example.org'] } });
    assert.deepEqual(plain((await app.request({ type: 'status' })).laya), { state });
    for (const request of layaRequests) await assert.rejects(app.request(request), error => error.publicCode === 'LAYA_NOT_READY', `${state} ${request.type}`);
  }
  const switchedOff = stubLaya();
  switchedOff.decideBatch = async () => { throw Object.assign(new Error('Laya was turned off.'), { code: 'LAYA_NOT_READY' }); };
  const app = await desktop({ laya: switchedOff, settings: { extensionId, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', household);
  for (const request of layaRequests) await assert.rejects(app.request(request), error => error.publicCode === 'LAYA_NOT_READY', request.type);
  const confused = await desktop({ laya: stubLaya(() => 0.99, 'thinking') });
  await assert.rejects(confused.request({ type: 'status' }), /unknown state/);
  const crashed = stubLaya();
  crashed.decideBatch = async () => { throw new Error('model crashed'); };
  const failing = await desktop({ laya: crashed, settings: { extensionId, trustedSites: ['https://pantry.example.org'] } });
  await assert.rejects(failing.request(layaRequests[0]), error => /Laya couldn’t check this form/.test(error.publicMessage) && !error.publicCode);
});

test('with Laya ready, text boxes are matched for trusted sites and Iowa’s portal only, without reading the vault', async () => {
  const laya = stubLaya(sixtyFromAge);
  const app = await desktop({ laya, settings: { extensionId, trustedSites: ['https://pantry.example.org'] } });
  assert.deepEqual(plain(await app.request(layaRequests[0])), { suggestions: { 'f0:sh-1-2': 'email' } });
  assert.deepEqual(plain(await app.request({ type: 'suggestFields', url: `${PORTAL_URL}/applyForBenefits/financialInfo`, fields: [{ ...box, id: 'sh-1-2' }] })), { suggestions: { 'sh-1-2': 'email' } });
  assert.equal(app.dataReads, 0, 'matching reads no saved answers');
  assert.equal(app.prompts.length, 0);
  await assert.rejects(app.request({ ...layaRequests[0], url: 'https://other.example.org/form' }), /isn’t trusted/);
  await assert.rejects(app.request({ ...layaRequests[1], url: 'https://hhsservices.iowa.gov/other' }), /isn’t trusted/);
  await app.invoke('lock');
  for (const request of layaRequests) await assert.rejects(app.request(request), /Unlock/);
});

test('answers from everyday facts need no prompt; answers that needed sensitive facts wait for one "Share sensitive details?" prompt', async () => {
  const app = await desktop({ laya: stubLaya(sixtyFromAge), settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', household);
  const everyday = await app.request({ type: 'answerFields', url: PANTRY, questions: [veteran] });
  assert.deepEqual(plain(everyday.answers), { 'f0:sh-1-4': 'No' });
  assert.equal(everyday.accessRevision, (await app.request({ type: 'status' })).accessRevision, 'answers carry the access receipt they were made under');
  assert.equal(app.prompts.length, 0);

  app.answer(async () => ({ response: 1 }));
  const allowed = await app.request({ type: 'answerFields', url: PANTRY, questions: [sixty, veteran] });
  assert.deepEqual(plain(allowed.answers), { 'f0:sh-1-3': 'No', 'f0:sh-1-4': 'No' });
  assert.equal(app.prompts.length, 1, 'one prompt');
  const [prompt] = app.prompts;
  assert.equal(prompt.title, 'Share sensitive details?');
  assert.deepEqual(plain(prompt.buttons), ['Cancel', 'Allow once']);
  assert.equal(prompt.cancelId, 0);
  assert.match(prompt.message, /pantry\.example\.org/);
  assert.match(prompt.detail, /Date of birth/);
  assert.doesNotMatch(`${prompt.message} ${prompt.detail}`, /60 or older|1985/, 'the prompt names categories, never the page’s words or saved values');

  app.answer(async () => ({ response: 0 }));
  const cancelled = await app.request({ type: 'answerFields', url: PANTRY, questions: [sixty, veteran] });
  assert.deepEqual(plain(cancelled.answers), { 'f0:sh-1-4': 'No' }, 'cancelling drops only the sensitive answer');
});

test('on Iowa’s portal, answers that needed sensitive facts follow Iowa’s existing rule: no extra prompt', async () => {
  const app = await desktop({ laya: stubLaya(sixtyFromAge), settings: { extensionId, autofillWithoutAsking: true } });
  await app.invoke('saveProfile', household);
  const { answers } = await app.request({ type: 'answerFields', url: `${PORTAL_URL}/applyForBenefits/financialInfo`, questions: [sixty, veteran] });
  assert.deepEqual(plain(answers), { 'f0:sh-1-3': 'No', 'f0:sh-1-4': 'No' });
  assert.equal(app.prompts.length, 0);
});

test('a sensitive prompt cannot release answers after a profile edit, and waits for no other approval', async () => {
  const app = await desktop({ laya: stubLaya(sixtyFromAge), settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', household);
  let resolve;
  app.answer(() => new Promise(done => { resolve = done; }));
  const pending = app.request({ type: 'answerFields', url: PANTRY, questions: [sixty] });
  for (let i = 0; !resolve && i < 50; i++) await tick();
  assert.equal(typeof resolve, 'function', 'the prompt is showing');
  await assert.rejects(app.request({ type: 'answerFields', url: PANTRY, questions: [sixty] }), /waiting for your approval/);
  await app.invoke('saveProfile', { ...household, householdVeteran: 'yes' });
  resolve({ response: 1 });
  await assert.rejects(pending, /changed/);
});
