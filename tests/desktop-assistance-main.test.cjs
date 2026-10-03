'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { PORTAL_URL, FIELD_LABELS } = require('../shared/schema.cjs');
const realLaya = require('../desktop/laya.cjs');

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
  const removed = [];
  let setupFile = options.setup === undefined ? null : typeof options.setup === 'string' ? options.setup : JSON.stringify(options.setup);
  let invoke;
  let window;
  let answer = async () => ({ response: 1 });
  const prompts = [];
  const notifications = [];
  const powerEvents = new Map();
  const opened = [];
  let registrations = 0;
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
    shell: { async openPath(folder) { opened.push(folder); return ''; } }, clipboard: {}, powerMonitor: { on(name, handler) { powerEvents.set(name, handler); } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } } };
  // A Mac without Touch ID; tests/desktop-touch-id-main.test.cjs covers Touch ID.
  electron.systemPreferences = { canPromptTouchID: () => false };
  const overrides = {
    electron,
    // settings.json from `options.settings`; the guided setup's progress file from `options.setup` (none by default), as written since.
    'node:fs/promises': { mkdir: async () => {}, stat: async () => ({ size: 10 }), rm: async file => { removed.push(file); if (file.endsWith('setup-progress.json')) setupFile = null; },
      readFile: async file => {
        if (!String(file).endsWith('setup-progress.json')) return JSON.stringify(options.settings ?? { extensionId });
        if (setupFile === null) throw Object.assign(new Error('No such file'), { code: 'ENOENT' });
        return setupFile;
      } },
    './vault.cjs': { Vault, atomicWrite: async (file, bytes) => { writes.push({ file, json: JSON.parse(bytes.toString()) }); if (file.endsWith('setup-progress.json')) setupFile = bytes.toString(); }, MAX_VAULT_BYTES: 1000 },
    './bridge.cjs': { ...require('../desktop/bridge.cjs'), startBridge: async (_directory, _getId, handler) => { bridge = handler; return { close: async () => {} }; } },
    './extension-setup.cjs': options.extensionCopy?.module ?? { getExtensionSetup: async () => ({ prepared: true }) },
    './registration.cjs': { registerHost: async () => { registrations++; return {}; } },
    './test-storage-path.cjs': { testStoragePath: () => null },
    // The app's one Laya runtime (#38). Without an override it is the real one with the shipped model,
    // minus its background download and update checks (tests/desktop-laya-main.test.cjs covers those).
    './laya.cjs': { ...realLaya, createLaya: runtimeOptions => options.laya ?? { ...realLaya.createLaya(runtimeOptions), startUpdates() {}, update() {} } }
  };
  vm.runInNewContext(source, {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name.startsWith('.') ? path.join(root, 'desktop', name) : name),
    __dirname: path.join(root, 'desktop'), process: { platform: process.platform, env: {}, argv: ['synthetic-electron'] },
    setTimeout: () => 1, clearTimeout() {}, Buffer
  });
  await tick();
  assert.equal(typeof bridge, 'function');
  return {
    prompts, notifications, writes, removed,
    get shows() { return shows; },
    get dataReads() { return dataReads; },
    get registrations() { return registrations; },
    opened,
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
  // On other sites it counts as a sensitive detail and always asks.
  const site = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await site.invoke('saveProfile', { ssn: '123-45-6789' });
  site.answer(async () => ({ response: 1 }));
  assert.deepEqual(plain((await site.request({ type: 'getFields', url: PANTRY, fields: ['hasSsn'] })).values), { hasSsn: 'yes' });
  assert.equal(site.prompts.length, 1);
  assert.deepEqual(plain(site.prompts[0].buttons), ['Cancel', 'Allow once']);
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

test('your citizenship, disability, blindness, health, Medicare and Social Security answers always ask on other sites but follow Iowa’s trust rules on Iowa', async () => {
  const sensitive = { usCitizen: 'yes', disabled: 'no', blind: 'no', healthLimitation: 'no', medicare: 'no', hasSsnAnswer: 'yes' };
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, trustedSites: ['https://pantry.example.org'] } });
  await app.invoke('saveProfile', { ...sensitive, sex: 'Female', maritalStatus: 'Never Married', militaryOrVeteran: 'no', ssnCardNameMatches: 'yes' });
  app.answer(async () => ({ response: 1 }));
  for (const field of Object.keys(sensitive)) {
    const before = app.prompts.length;
    assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: ['sex', field] })).values), { sex: 'Female', [field]: sensitive[field] });
    assert.equal(app.prompts.length, before + 1, field);
    assert.deepEqual(plain(app.prompts.at(-1).buttons), ['Cancel', 'Allow once']);
    assert.match(app.prompts.at(-1).detail, new RegExp(`^${FIELD_LABELS[field].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`));
  }
  const prompts = app.prompts.length;
  assert.deepEqual(plain((await app.request({ type: 'getFields', url: PANTRY, fields: ['sex', 'maritalStatus', 'militaryOrVeteran', 'ssnCardNameMatches'] })).values),
    { sex: 'Female', maritalStatus: 'Never Married', militaryOrVeteran: 'no', ssnCardNameMatches: 'yes' });
  assert.equal(app.prompts.length, prompts, 'the other answers follow Always allow');
  assert.deepEqual(plain((await app.request({ type: 'getFields', fields: Object.keys(sensitive) })).values), sensitive);
  assert.equal(app.prompts.length, prompts, 'Iowa keeps its own trust rules');
  await app.request({ type: 'trustSite', url: 'https://wic.example.gov/apply' });
  assert.match(app.prompts.at(-1).detail, /your answers about citizenship, disability, blindness, health, Medicare, and having a Social Security number still ask every time/);
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
  assert.match(app.prompts.at(-1).detail, /money on hand, medical expenses, and your answers about/);
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
  const stored = await desktop({ settings: { extensionId, trustedSites: ['https://ok.example.org', 'http://bad.example.org', 'javascript:1', 42] } });
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
  assert.match(prompt.detail, /never clicks Next or Submit/);
  assert.match(prompt.detail, /Social Security number, date of birth, the ages of the people in your household, income, money on hand, medical expenses, and your answers about citizenship, disability, blindness, health, Medicare, and having a Social Security number still ask every time, on each site/);
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

test('sensitive fields still ask on every site that all websites allows, and Iowa keeps its rules', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true, allSites: true } });
  await app.invoke('saveProfile', { firstName: 'Synthetic', ssn: '123-45-6789', monthlyEarnedIncome: '900' });
  app.answer(async () => ({ response: 1 }));
  const { values } = await app.request({ type: 'getFields', url: ANYWHERE, fields: ['firstName', 'ssn', 'monthlyEarnedIncome'] });
  assert.equal(values.ssn, '123-45-6789');
  assert.equal(app.prompts.length, 1);
  assert.equal(app.prompts[0].title, 'Share sensitive details?');
  assert.deepEqual(plain(app.prompts[0].buttons), ['Cancel', 'Allow once']);
  assert.match(app.prompts[0].message, /never\.example\.net/);
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request({ type: 'getFields', url: ANYWHERE, fields: ['ssn'] }), /cancelled/);
  await app.request({ type: 'getFields', fields: ['ssn'] });
  assert.equal(app.prompts.length, 2, 'Iowa keeps its own trust rules');
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
  assert.equal(on.prompts.at(-1).title, 'Share sensitive details?', 'an answer that needed sensitive facts still asks on this site');
  await on.request({ type: 'untrustAllSites' });
  for (const request of anywhere) await assert.rejects(on.request(request), /isn’t trusted/, request.type);
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

test('with Always allow on, everyday answers need no prompt; answers that needed sensitive facts get one "Share sensitive details?" prompt, and Cancel returns none', async () => {
  const app = await answering(trusted);
  const everyday = await app.request(answerRequest([veteran]));
  assert.deepEqual(plain(everyday.answers), { 'f0:sh-1-4': 'No' });
  assert.equal(everyday.accessRevision, (await app.request({ type: 'status' })).accessRevision, 'answers carry the access receipt they were made under');
  assert.equal(app.prompts.length, 0);

  app.answer(async () => ({ response: 1 }));
  const allowed = await app.request(answerRequest([sixty, veteran]));
  assert.deepEqual(plain(allowed.answers), { 'f0:sh-1-3': 'No', 'f0:sh-1-4': 'No' });
  assert.equal(app.prompts.length, 1, 'one prompt');
  const [prompt] = app.prompts;
  assert.equal(prompt.title, 'Share sensitive details?');
  assert.deepEqual(plain(prompt.buttons), ['Cancel', 'Allow once']);
  assert.equal(prompt.cancelId, 0);
  assert.match(prompt.message, /pantry\.example\.org/);
  assert.match(prompt.detail, /Date of birth/);
  assert.match(prompt.detail, /“Is anyone in your household 60 or older\?”: No/);
  assert.match(prompt.detail, /“Is anyone in your household a veteran\?”: No/);
  assert.doesNotMatch(`${prompt.message} ${prompt.detail}`, /1985|41 years/, 'saved values and facts never appear');

  app.answer(async () => ({ response: 0 }));
  const cancelled = await app.request(answerRequest([sixty, veteran]));
  assert.deepEqual(plain(cancelled.answers), {}, 'Cancel returns no answers');
});

test('the sensitive prompt says how many of the answers needed sensitive details, in plain grammar, and that Laya read them', async () => {
  const app = await answering(trusted);
  app.answer(async () => ({ response: 1 }));
  await app.request(answerRequest([sixty]));
  await app.request(answerRequest([sixty, veteran]));
  // Both questions settled only once the applicant's age was known.
  const both = await desktop({ laya: stubLaya(state => state.facts.includes('years old') ? (state.candidate === 'No' ? 0.97 : 0.01) : (state.candidate.startsWith('None') ? 0.95 : 0.01)), settings: trusted });
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
  assert.equal(app.prompts[0].title, 'Share sensitive details?');
  assert.deepEqual(plain(app.prompts[0].buttons), ['Cancel', 'Allow once']);
  assert.match(app.prompts[0].detail, /Date of birth/);
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);
  app.answer(async () => ({ response: 0 }));
  assert.deepEqual(plain((await app.request(answerRequest([sixty, veteran]))).answers), {});
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

test('the desktop stops Laya at the time the click has left, and a decision that comes after it is not returned', async () => {
  const slow = await desktop({ laya: stubLaya(sixtyFromAge, 'ready', 40), settings: trusted });
  await slow.invoke('saveProfile', household);
  assert.deepEqual(plain(await slow.request(suggest([box], { budgetMs: 5 }))), { suggestions: {} });
  assert.deepEqual(plain((await slow.request(answerRequest([veteran], { budgetMs: 5 }))).answers), {});
  assert.deepEqual(plain(await slow.request(suggest([box], { budgetMs: 3000 }))), { suggestions: { 'f0:sh-1-2': 'email' } });
  assert.deepEqual(plain((await slow.request(answerRequest([veteran], { budgetMs: 3000 }))).answers), { 'f0:sh-1-4': 'No' });
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
function extensionCopy({ exists = true, prepared = true, refresh = async () => {} } = {}) {
  const copy = { exists, prepared, refreshes: 0 };
  const setup = () => ({ directory: '/synthetic-local-data/chrome-extension', extensionId: 'jogldddafjfbmfjnjlbjloakjbecnjpl', version: '0.4.0', build: SHIPPED, exists: copy.exists, prepared: copy.prepared });
  copy.module = {
    getExtensionSetup: async () => setup(),
    prepareBundledExtension: async () => { copy.refreshes++; await refresh(copy); copy.exists = true; copy.prepared = true; return setup(); }
  };
  return copy;
}
const shipped = async app => plain(await app.request({ type: 'status' })).extension;
const until = async condition => { for (let i = 0; i < 100 && !condition(); i++) await tick(); assert.ok(condition(), 'timed out'); };

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

test('band counts and the student answer come from the household list; counts by birth date ask as the birth date does off Iowa', async () => {
  const app = await desktop({ settings: trusted });
  await app.invoke('saveProfile', listedHousehold());
  app.answer(async () => ({ response: 1 }));
  const { values } = await app.request({ type: 'getFields', url: PANTRY, fields: [...BANDS, 'studentNameGrade', 'householdSize'] });
  assert.deepEqual(plain(values), { 'householdCount:0-17': '2', 'householdCount:18-59': '1', 'householdCount:60+': '1', studentNameGrade: 'Riley Example, 5th', householdSize: '4' });
  assert.equal(app.prompts.length, 1, 'Always allow doesn’t cover counts by birth date on other sites');
  assert.equal(app.prompts[0].title, 'Share sensitive details?');
  assert.deepEqual(plain(app.prompts[0].buttons), ['Cancel', 'Allow once']);
  assert.match(app.prompts[0].detail, /^People in the household aged 0 to 17, People in the household aged 18 to 59, People in the household aged 60 or older\n/);
  assert.match(app.prompts[0].detail, /Other fields: Student name and grade, Household size\./);
  assert.doesNotMatch(JSON.stringify(app.prompts[0]), /Riley|2015|1958/, 'the prompt names fields, never members’ details');
  // The profile's own age counts, worked out from the list, are counts by birth date too.
  await app.request({ type: 'getFields', url: PANTRY, fields: ['householdChildren'] });
  assert.equal(app.prompts.length, 2);
  assert.match(app.prompts[1].detail, /^Children in household\n/);
  // Iowa keeps its own trust rules: Always allow, no sensitive prompt.
  assert.deepEqual(plain((await app.request({ type: 'getFields', fields: ['householdCount:0-5', 'householdChildren'] })).values), { 'householdCount:0-5': '1', householdChildren: '2' });
  assert.equal(app.prompts.length, 2);
  assert.equal(app.dataReads > 0, true);
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
  const app = await desktop({ laya: stubLaya(sixtyFromAge), settings: trusted });
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

test('the guided setup remembers how many of its six steps are done until it is finished', async () => {
  const fresh = await desktop({ settings: trusted });
  assert.equal(await fresh.invoke('setupProgress'), null, 'no setup under way');
  assert.deepEqual(plain(await fresh.invoke('startSetup')), { step: 0, steps: 6 });
  assert.deepEqual(fresh.writes.at(-1), { file: '/synthetic-local-data/setup-progress.json', json: { version: 1, step: 0 } });
  assert.deepEqual(plain(await fresh.invoke('saveSetupProgress', 3)), { step: 3, steps: 6 });
  assert.deepEqual(plain(await fresh.invoke('saveSetupProgress', 2)), { step: 3, steps: 6 }, 'going back keeps the steps already done');
  assert.equal(await fresh.invoke('saveSetupProgress', 6), null, 'all six done: setup is finished');
  assert.deepEqual(fresh.removed, ['/synthetic-local-data/setup-progress.json']);
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
