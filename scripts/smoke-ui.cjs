'use strict';
// All test data is synthetic and confined to a temporary vault.
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const applicantFixture = require('../tests/fixtures/applicant-profile.json');
const { PROFILE_FIELDS } = require('../shared/schema.cjs');
const { MODEL_FILES } = require('../desktop/laya-model.cjs');
const root = path.join(__dirname, '..');
const passphrase = 'synthetic-test-vault-passphrase';
// Creating or unlocking the vault derives its key with scrypt (N=2^15, r=8) in the
// main process: about 65 ms on an M4 Max, but many times that on a loaded hosted
// macOS runner. Bound the whole attempt generously instead of Playwright's 5s default.
const AUTH_ATTEMPT_TIMEOUT_MS = 30000;
const resetPassword = 'synthetic-reset-password';
// Iowa's Tell Us More questions in the About you card: radio buttons, and a marital status list.
const IOWA_QUESTIONS = ['sex', 'maritalStatus', 'hasSsnAnswer', 'ssnCardNameMatches', 'usCitizen', 'militaryOrVeteran', 'disabled', 'blind', 'healthLimitation', 'medicare'];
const startOverPassword = 'synthetic-start-over-password';
// The household list (#98): member ids are made when a person is added, so profiles are compared without them.
const withoutIds = profile => ({ ...profile, householdMembers: (profile.householdMembers || []).map(({ id, ...member }) => member) });
const COUNT_FIELDS = ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'];
// Fields My information shows one by one; the household list has its own rows.
const SCALAR_FIELDS = PROFILE_FIELDS.filter(field => field !== 'householdMembers');

async function captureDiagnostic(page, name, options = {}) {
  try {
    await page.screenshot({ path: path.join(root, 'artifacts', name), ...options });
  } catch (error) {
    // Some hosted Intel macOS runners have no usable compositor capture surface.
    // Screenshots are diagnostics; every DOM, IPC, and persistence assertion below
    // must still pass. Do not suppress closed-page, timeout, or other failures.
    if (!error.message.includes('Protocol error (Page.captureScreenshot): Unable to capture screenshot')) throw error;
    console.warn(`Diagnostic screenshot unavailable (${name}): this runner cannot capture its display.`);
  }
}

async function rejectedPassphrase(page, afterEntry) {
  await page.locator('#passphrase').fill('incorrect-passphrase');
  if (afterEntry) await afterEntry();
  await expect(page.locator('#passphrase')).toHaveValue('incorrect-passphrase');
  await submitAuthForm(page);
  await expect(page.locator('#auth-error')).toBeVisible();
  await expect(page.locator('#workspace')).not.toBeVisible();
}

// Click the auth form's submit button and wait until that create/unlock attempt has
// settled (the button leaves its busy state). A form that fails validation never
// starts an attempt, so fail at once with the reason rather than waiting on a result.
async function submitAuthForm(page) {
  const before = await page.evaluate(() => ({ ...window.__smokeAuthForm }));
  await page.locator('#auth-submit').click();
  const outcome = await (await page.waitForFunction(before => {
    const counts = window.__smokeAuthForm;
    if (counts.invalid > before.invalid) return { submitted: false, passphraseEmpty: !document.querySelector('#passphrase').value };
    if (counts.submit > before.submit && document.querySelector('#auth-submit').getAttribute('aria-busy') !== 'true') return { submitted: true };
    return null;
  }, before, { polling: 50, timeout: AUTH_ATTEMPT_TIMEOUT_MS })).jsonValue();
  assert.ok(outcome.submitted, `The auth form was not submitted: it failed validation (passphrase empty: ${outcome.passphraseEmpty}). Something reset the form after the test filled it.`);
}

// A local stand-in for the Laya model repo: latest.json names a synthetic model (placeholder bytes;
// this smoke never loads it), so a new install's automatic download never leaves this computer.
async function layaFixtureServer() {
  const revision = 'f'.repeat(40);
  const small = path.join(root, 'tests/fixtures/laya/small-tokenizer');
  const files = {
    'model.onnx': Buffer.from('synthetic graph, never loaded by this smoke'),
    'model.onnx.data': crypto.randomBytes(2 * 1000 * 1000),
    'tokenizer/tokenizer.json': await fs.readFile(path.join(small, 'tokenizer.json')),
    'tokenizer/tokenizer_config.json': await fs.readFile(path.join(small, 'tokenizer_config.json')),
    'rl_agent_config.json': Buffer.from(JSON.stringify({ max_len: 512, head_max_len: 192 }))
  };
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const file = request.url.startsWith(`/${revision}/`) ? decodeURIComponent(request.url.slice(revision.length + 2)) : null;
    const bytes = request.url === '/latest.json' ? Buffer.from(JSON.stringify(latest)) : file && files[file];
    if (!bytes) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const latest = { version: 1, model: { revision, format: 'noul-v1', files: MODEL_FILES.map(name => ({ path: name, url: `${base}/${revision}/${name}`,
    size: files[name].length, sha256: crypto.createHash('sha256').update(files[name]).digest('hex') })) } };
  return { revision, requests, updateUrl: `${base}/latest.json`, close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}

// The guided first-run setup (#98), right after the new password's recovery key: offered with Skip for now, one
// step at a time, each saved as the applicant moves on, finished later from Overview. The household step adds the
// fictional household; the counts come from its birth dates.
async function guidedSetup(page, application, userData) {
  const progressFile = path.join(userData, 'setup-progress.json');
  await expect(page.locator('#setup-dialog')).toBeVisible();
  await expect(page.locator('#setup-start')).toHaveText('Set up your information (about 5 minutes)');
  await expect(page.locator('#setup-skip')).toHaveText('Skip for now');
  await captureDiagnostic(page, 'household/setup-offer.png');
  assert.deepEqual(JSON.parse(await fs.readFile(progressFile, 'utf8')), { version: 1, step: 0 });
  await page.locator('#setup-start').click();
  await expect(page.locator('#setup-step-count')).toHaveText('Step 1 of 6');
  await expect(page.locator('#setup-step-title')).toHaveText('You');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'setup-step-title', 'a screen reader starts at the step’s heading');
  await expect(page.locator('#addressLine1')).toBeHidden();
  for (const field of ['firstName', 'lastName', 'birthDate']) await page.locator(`#${field}`).fill(applicantFixture[field]);
  await page.locator('#setup-next').click();
  await expect(page.locator('#setup-step-count')).toHaveText('Step 2 of 6');
  await expect(page.locator('#setup-step-title')).toHaveText('Your household');
  const members = applicantFixture.householdMembers;
  for (let index = 1; index < members.length; index++) {
    await page.locator('#add-household-member').click();
    const row = page.locator('.household-member').nth(index);
    for (const field of ['firstName', 'lastName', 'birthDate']) await row.locator(`[data-member-field="${field}"]`).fill(members[index][field]);
    await row.locator('[data-member-field="relationship"]').selectOption(members[index].relationship);
    await row.locator('[data-member-field="student"]').selectOption(members[index].student);
    if (members[index].grade) await row.locator('[data-member-field="grade"]').fill(members[index].grade);
  }
  const self = page.locator('.household-member').first();
  await expect(self.locator('legend')).toHaveText('You');
  await expect(self.locator('[data-member-field="firstName"]')).toHaveValue(applicantFixture.firstName);
  await self.locator('[data-member-field="student"]').selectOption('no');
  for (const field of COUNT_FIELDS) await expect(page.locator(`#${field}`)).toHaveValue(applicantFixture[field]);
  await expect(page.locator('#household-counts-note')).toHaveText('Counted from your household list. To change them, change the list.');
  // #135: a birth date after today counts no ages, the note says whose it is, and the app refuses to save it, saying why.
  const sam = page.locator('.household-member').nth(2).locator('[data-member-field="birthDate"]');
  await sam.fill('2999-01-01');
  for (const field of COUNT_FIELDS.slice(1)) await expect(page.locator(`#${field}`)).toHaveValue('');
  await expect(page.locator('#household-counts-note')).toHaveText('Counted from your household list. Person 3’s date of birth is after today, so ages can’t be counted. Check the date.');
  await page.locator('#setup-next').click();
  await expect(page.locator('#profile-error')).toHaveText(/Person 3’s date of birth can’t be after today \(\d{4}-\d{2}-\d{2} on this computer\)\.$/);
  await expect(page.locator('#setup-step-count')).toHaveText('Step 2 of 6');
  await sam.fill(members[2].birthDate);
  for (const field of COUNT_FIELDS) await expect(page.locator(`#${field}`)).toHaveValue(applicantFixture[field]);
  await captureDiagnostic(page, 'household/setup-household.png', { fullPage: true });
  // Keyboard: Save and continue from the keyboard.
  await page.locator('#setup-next').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#setup-step-count')).toHaveText('Step 3 of 6');
  assert.deepEqual(JSON.parse(await fs.readFile(progressFile, 'utf8')), { version: 1, step: 2 });
  const saved = await page.evaluate(async () => (await window.secondHand.getData()).profile);
  assert.deepEqual(withoutIds(saved).householdMembers, withoutIds(applicantFixture).householdMembers, 'each step is saved as the applicant moves on');
  // Readable at 200% zoom: the step, its fields and its buttons fit the window with no sideways scrolling.
  const width = await page.evaluate(() => window.innerWidth);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(Math.ceil(width / 2));
  const zoomed = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    buttons: ['setup-back', 'setup-later', 'setup-next'].map(id => { const box = document.getElementById(id).getBoundingClientRect(); return box.width > 0 && box.right <= document.documentElement.clientWidth; }) }));
  assert.ok(zoomed.overflow <= 1, `no sideways scrolling at 200% (${zoomed.overflow}px)`);
  assert.deepEqual(zoomed.buttons, [true, true, true]);
  // Playwright's own screenshot doesn't know about the zoom, so the window draws itself.
  const drawn = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await fs.mkdir(path.join(root, 'artifacts/household'), { recursive: true });
  await fs.writeFile(path.join(root, 'artifacts/household/setup-zoom-200.png'), Buffer.from(drawn, 'base64'));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  // Finish later, then pick up from Overview at the first step not done.
  await page.locator('#setup-later').click();
  await expect(page.locator('#view-overview')).toBeVisible();
  await expect(page.locator('#setup-resume-text')).toHaveText('Finish setting up: 2 of 6 steps');
  await captureDiagnostic(page, 'household/setup-resume.png');
  await page.locator('#setup-resume-button').click();
  await expect(page.locator('#setup-step-count')).toHaveText('Step 3 of 6');
  for (const title of ['Where you live', 'Income and money on hand', 'Programs', 'About you']) {
    await expect(page.locator('#setup-step-title')).toHaveText(title);
    await page.locator('#setup-next').click();
  }
  await expect(page.locator('#view-overview')).toBeVisible();
  await expect(page.locator('#toast')).toHaveText('Your information is set up. Change it any time in My information.');
  await expect(page.locator('#setup-resume')).toBeHidden();
  await assert.rejects(fs.access(progressFile), 'a finished setup keeps no progress file');
  console.log('Guided setup: offered after the recovery key, six steps saved as the applicant moved on, finished later from Overview; the household step listed four people and counted their ages.');
}

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-ui-'));
  const layaServer = await layaFixtureServer();
  const errors = [];
  let application;
  let page;
  // `touchId` turns on the Touch ID test hook (#99): it stands in for Touch ID and the Keychain, so no
  // real prompt shows and no Keychain item is touched. It needs test mode, which keeps the app's data
  // in this temporary folder; a packaged app refuses it.
  const launch = async ({ touchId = false } = {}) => {
    const touchIdEnv = touchId ? { SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_USER_DATA: userData, SECONDHAND_TEST_TOUCH_ID: 'approve' } : {};
    application = await electron.launch({ args: [root], env: { ...process.env, SECONDHAND_USER_DATA: userData, SECONDHAND_LAYA_UPDATE_URL: layaServer.updateUrl, ...touchIdEnv }, timeout: 30000 });
    // Track the open window here so a failure during launch can still be diagnosed.
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#auth-view').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      // Failure diagnostics contain event types/booleans only, never input text.
      window.__secondHandSmokeAuth = [];
      const record = event => {
        window.__secondHandSmokeAuth.push(event);
        if (window.__secondHandSmokeAuth.length > 30) window.__secondHandSmokeAuth.shift();
      };
      for (const type of ['submit', 'invalid', 'reset']) document.querySelector('#auth-form').addEventListener(type, () => record({ type }), true);
      window.secondHand.onLocked(event => record({ type: 'locked', revision: event?.lockRevision }));
      const form = document.querySelector('#auth-form');
      const counts = window.__smokeAuthForm = { submit: 0, invalid: 0 };
      // Capture phase also sees `invalid`, which fires on the control and does not bubble.
      form.addEventListener('submit', () => { counts.submit++; }, true);
      form.addEventListener('invalid', () => { counts.invalid++; }, true);
    });
    return page;
  };
  try {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    page = await launch();
    await captureDiagnostic(page, 'vault-setup.png');
    await page.locator('#passphrase').fill(passphrase);
    await page.locator('#confirm-passphrase').fill(passphrase);
    // Keep automated runs away from the real Keychain or Windows protected storage;
    // tests/desktop-recovery-main.test.cjs covers reset on this computer.
    if (await page.locator('#device-reset-field').isVisible()) await page.locator('#allow-device-reset').uncheck();
    await submitAuthForm(page);
    await expect(page.locator('#recovery-dialog')).toBeVisible();
    const recoveryKey = await page.locator('#recovery-key-value').textContent();
    assert.match(recoveryKey, /^[0-9A-Z]{4}(?:-[0-9A-Z]{4}){7}$/);
    await expect(page.locator('#recovery-done')).toBeDisabled();
    await page.locator('#recovery-saved').check();
    await page.locator('#recovery-done').click();
    await expect(page.locator('#recovery-dialog')).not.toBeVisible();
    await expect(page.locator('#workspace')).toBeVisible();
    await guidedSetup(page, application, userData);
    // A new install has Laya on and downloads its model on its own: the newest one latest.json names.
    await page.locator('.nav-item[data-view="extension"]').click();
    await expect(page.locator('#laya-toggle')).toBeChecked();
    await expect(page.locator('#laya-status')).toHaveText(/^Ready\. The model \(2 MB\) is on this computer\.$/, { timeout: 15000 });
    assert.equal(layaServer.requests[0], '/latest.json', 'the app checked for the newest model first');
    assert.deepEqual(layaServer.requests.slice(1).sort(), MODEL_FILES.map(name => `/${layaServer.revision}/${name}`).sort());
    assert.deepEqual((await fs.readdir(path.join(userData, 'models/laya'))).sort(), [layaServer.revision, 'installed.json']);
    await captureDiagnostic(page, 'desktop-laya-ready.png', { fullPage: true });
    // All websites starts off, and only the extension's side panel can turn it on.
    await expect(page.locator('#all-sites-status')).toHaveText('All websites: off. To turn it on, open SecondHand’s side panel in Chrome and choose Use SecondHand on all websites.');
    await expect(page.locator('#all-sites-off')).toBeHidden();
    // Turning it off is saved, and stays off after a restart (checked below).
    await page.locator('#laya-toggle').uncheck();
    await expect(page.locator('#toast')).toHaveText('Laya is off.');
    await expect(page.locator('#laya-status')).toHaveText(/^Off\. /);
    assert.equal(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).layaEnabled, false);
    await page.locator('.nav-item[data-view="profile"]').click();
    // What My information shows for every saved field, read the way the form submits it.
    const shownProfile = () => page.locator('#profile-form').evaluate((form, fields) => Object.fromEntries(fields.map(field => [field, form.elements.namedItem(field).value])), SCALAR_FIELDS);
    const { householdMembers: _, ...scalarFixture } = applicantFixture;
    for (const field of SCALAR_FIELDS) {
      // The guided setup saved the household list, so the counts come from it, read-only.
      if (COUNT_FIELDS.includes(field)) {
        await expect(page.locator(`#${field}`)).toHaveJSProperty('readOnly', true);
        await expect(page.locator(`#${field}`)).toHaveValue(applicantFixture[field]);
        continue;
      }
      const radios = page.locator(`#profile-form input[type="radio"][name="${field}"]`);
      if (await radios.count()) { await page.locator(`#profile-form input[type="radio"][name="${field}"][value="${applicantFixture[field]}"]`).check(); continue; }
      const control = page.locator(`#${field}`);
      if (await control.evaluate(element => element.tagName === 'SELECT')) await control.selectOption(applicantFixture[field]);
      else await control.fill(applicantFixture[field]);
    }
    await page.locator('#save-profile').click();
    await expect(page.locator('#profile-save-state')).toBeHidden();
    const profile = await page.evaluate(async () => (await window.secondHand.getData()).profile);
    assert.deepEqual(withoutIds(profile), withoutIds(applicantFixture));
    assert.ok(profile.householdMembers.every(member => /^[0-9a-f-]{36}$/.test(member.id)));
    assert.equal(profile.monthlyEarnedIncome, '0');
    assert.equal(profile.ssn, '');
    await captureDiagnostic(page, 'desktop-profile.png', { fullPage: true });
    await page.locator('.nav-item[data-view="applications"]').click();
    await page.locator('#new-application').click();
    await page.locator('#application-status').selectOption('submitted');
    await page.locator('#application-confirmation').fill('SYNTHETIC-RECEIPT-ONLY');
    await page.locator('#application-next-action').fill('Synthetic follow-up task');
    await page.locator('#application-due-date').fill('2026-12-01');
    await page.locator('#application-notes').fill('Synthetic private note. Never sent to a government website.');
    await page.locator('#save-application').click();
    await expect(page.locator('#application-dialog')).not.toBeVisible();
    await expect(page.locator('#application-list')).toContainText('Synthetic follow-up task');
    await page.locator('.nav-item[data-view="overview"]').click();
    await captureDiagnostic(page, 'desktop-overview.png', { fullPage: true });
    await page.locator('#lock-button').click();
    await expect(page.locator('#auth-view')).toBeVisible();
    const cleared = await page.evaluate(() => ({
      firstName: document.querySelector('#firstName').value,
      notes: document.querySelector('#application-notes').value,
      cards: document.querySelector('#application-list').textContent,
      overview: document.querySelector('#overview-applications').textContent
    }));
    assert.deepEqual(cleared, { firstName: '', notes: '', cards: '', overview: '' });
    assert.deepEqual(await shownProfile(), Object.fromEntries(SCALAR_FIELDS.map(field => [field, ''])));
    assert.equal(await page.locator('.household-member').count(), 0, 'the household list is cleared on lock');
    await rejectedPassphrase(page);
    await page.locator('#passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="profile"]').click();
    await expect(page.locator('#firstName')).toHaveValue(applicantFixture.firstName);
    // After unlocking, My information shows every saved answer again, Iowa's questions and the household list included.
    assert.deepEqual(await shownProfile(), scalarFixture);
    assert.deepEqual(await page.locator('.household-member [data-member-field="firstName"]').evaluateAll(inputs => inputs.map(input => input.value)),
      applicantFixture.householdMembers.map(member => member.firstName));
    await expect(page.locator('#sex-female')).toBeChecked();
    await expect(page.locator('#maritalStatus')).toHaveValue(applicantFixture.maritalStatus);

    // Force the opposite IPC ordering: the lock status reply is rendered before
    // its notification. This test-only main-process hook is not shipped code.
    await application.evaluate(({ BrowserWindow }) => {
      const webContents = BrowserWindow.getAllWindows()[0].webContents;
      const send = webContents.send.bind(webContents);
      webContents.send = (...args) => {
        if (args[0] !== 'secondhand:locked') return send(...args);
        webContents.send = send;
        globalThis.__secondHandSmokeDeliverLock = () => { send(...args); return args[1].lockRevision; };
      };
    });
    await page.locator('#lock-button').click();
    await expect(page.locator('#auth-view')).toBeVisible();
    await rejectedPassphrase(page, async () => {
      const revision = await application.evaluate(() => {
        const deliver = globalThis.__secondHandSmokeDeliverLock;
        delete globalThis.__secondHandSmokeDeliverLock;
        return deliver();
      });
      await expect.poll(() => page.evaluate(() => window.__secondHandSmokeAuth.filter(event => event.type === 'locked').at(-1)?.revision)).toBe(revision);
    });
    await page.locator('#passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    await page.evaluate(() => window.secondHand.lock());
    await expect(page.locator('#auth-view')).toBeVisible();
    await expect(page.locator('#firstName')).toHaveValue('');
    await application.close();
    application = null;

    const layaRequests = layaServer.requests.length;
    // As if the extension had turned on all websites before this start: the app's page offers Turn off.
    const settingsPath = path.join(userData, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await fs.readFile(settingsPath, 'utf8')), allSites: true }));
    page = await launch();
    await page.locator('#passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="extension"]').click();
    await expect(page.locator('#laya-toggle')).not.toBeChecked();
    await expect(page.locator('#laya-status')).toHaveText(/^Off\. /);
    await expect(page.locator('#all-sites-status')).toHaveText(/^All websites: on\. /);
    await captureDiagnostic(page, 'desktop-all-websites-on.png', { fullPage: true });
    await page.locator('#all-sites-off').click();
    await expect(page.locator('#toast')).toHaveText('SecondHand will no longer fill forms on every website. Sites you trusted one by one stay on.');
    await expect(page.locator('#all-sites-status')).toHaveText(/^All websites: off\. /);
    assert.equal(JSON.parse(await fs.readFile(settingsPath, 'utf8')).allSites, undefined, 'turning it off is saved');
    await page.waitForTimeout(1500);
    assert.equal(layaServer.requests.length, layaRequests, 'Laya, turned off, checked and downloaded nothing after the restart');
    const restored = await page.evaluate(() => window.secondHand.getData());
    assert.deepEqual(withoutIds(restored.profile), withoutIds(applicantFixture));
    assert.equal(restored.applications[0].confirmationNumber, 'SYNTHETIC-RECEIPT-ONLY');

    // Unlock with Touch ID (#99): turned on with the password, used after an automatic lock, and ready
    // at once after a restart. It stays on until it's turned off.
    await application.close();
    application = null;
    page = await launch({ touchId: true });
    await expect(page.locator('#touch-id-unlock')).toBeHidden();
    await expect(page.locator('#touch-id-note')).toBeHidden();
    await page.locator('#passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="privacy"]').click();
    await expect(page.locator('#touch-id-setting')).toBeVisible();
    await expect(page.locator('#touch-id-toggle')).not.toBeChecked();
    // Turning it on opens the password dialog; the box stays clear until the password is checked.
    await page.locator('#touch-id-toggle').click();
    await expect(page.locator('#touch-id-dialog')).toBeVisible();
    await expect(page.locator('#touch-id-toggle')).not.toBeChecked();
    await page.locator('#touch-id-password').fill('incorrect-passphrase');
    await page.locator('#touch-id-confirm').click();
    await expect(page.locator('#touch-id-error')).toHaveText(/That password isn’t right/);
    await expect(page.locator('#touch-id-dialog')).toBeVisible();
    await page.locator('#touch-id-password').fill(passphrase);
    await page.locator('#touch-id-confirm').click();
    await expect(page.locator('#touch-id-dialog')).toBeHidden();
    await expect(page.locator('#touch-id-toggle')).toBeChecked();
    await expect(page.locator('#toast')).toHaveText(/^Touch ID is on\./);
    const sealedPath = path.join(userData, 'touch-unlock.bin');
    assert.match(await fs.readFile(sealedPath, 'utf8'), /^test-sealed:/, 'sealed by the test hook, never this Mac’s Keychain');
    assert.ok(JSON.parse(await fs.readFile(path.join(userData, 'vault.secondhand'), 'utf8')).slots.touchId, 'the vault has a Touch ID slot');
    await captureDiagnostic(page, 'desktop-touch-id-setting.png', { fullPage: true });
    // SecondHand locks itself when the screen locks; Touch ID then unlocks it.
    await application.evaluate(({ powerMonitor }) => { powerMonitor.emit('lock-screen'); });
    await expect(page.locator('#auth-view')).toBeVisible();
    await expect(page.locator('#firstName')).toHaveValue('');
    await expect(page.locator('#touch-id-unlock')).toBeVisible();
    await expect(page.locator('#touch-id-note')).toBeHidden();
    await captureDiagnostic(page, 'desktop-touch-id-lock.png');
    await page.locator('#touch-id-unlock').click();
    await expect(page.locator('#workspace')).toBeVisible();
    assert.deepEqual(withoutIds((await page.evaluate(() => window.secondHand.getData())).profile), withoutIds(applicantFixture));
    await application.close();
    application = null;
    // After a restart, Touch ID is ready at once: no password first.
    page = await launch({ touchId: true });
    await expect(page.locator('#touch-id-unlock')).toBeVisible();
    await expect(page.locator('#touch-id-note')).toBeHidden();
    await captureDiagnostic(page, 'desktop-touch-id-after-restart.png');
    await page.locator('#touch-id-unlock').click();
    await expect(page.locator('#workspace')).toBeVisible();
    assert.deepEqual(withoutIds((await page.evaluate(() => window.secondHand.getData())).profile), withoutIds(applicantFixture));
    await page.locator('#lock-button').click();
    await page.locator('#forgot-password').click();
    await page.locator('#recovery-key-input').fill(recoveryKey.toLowerCase().replace(/-/g, ' '));
    await page.locator('#reset-password').fill(resetPassword);
    await page.locator('#reset-confirm').fill(resetPassword);
    await page.locator('#reset-submit').click();
    await expect(page.locator('#workspace')).toBeVisible();
    assert.deepEqual(withoutIds((await page.evaluate(() => window.secondHand.getData())).profile), withoutIds(applicantFixture));
    // A password reset keeps the data key, so Touch ID stays on: its key and slot stay, and it unlocks.
    await fs.access(path.join(userData, 'touch-unlock.bin'));
    assert.ok(JSON.parse(await fs.readFile(path.join(userData, 'vault.secondhand'), 'utf8')).slots.touchId, 'the Touch ID slot stays');
    await page.locator('.nav-item[data-view="privacy"]').click();
    await expect(page.locator('#touch-id-toggle')).toBeChecked();
    await page.locator('#lock-button').click();
    await expect(page.locator('#touch-id-unlock')).toBeVisible();
    await page.locator('#touch-id-unlock').click();
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('#lock-button').click();
    await page.locator('#passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#auth-error')).toBeVisible();
    await page.locator('#passphrase').fill(resetPassword);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    const bytes = await fs.readFile(path.join(userData, 'vault.secondhand'), 'utf8');
    for (const secret of ['Avery', 'Example', 'Riley', 'Morgan', '2015-09-03', applicantFixture.addressLine1, '2025550147', 'SYNTHETIC-RECEIPT-ONLY', passphrase, resetPassword, recoveryKey, recoveryKey.replace(/-/g, '')]) assert.equal(bytes.includes(secret), false);

    // Each of Iowa's questions clears back to Not answered, and stays cleared after unlocking again.
    const unanswered = { ...applicantFixture, ...Object.fromEntries(IOWA_QUESTIONS.map(field => [field, ''])) };
    await page.locator('.nav-item[data-view="profile"]').click();
    for (const field of IOWA_QUESTIONS) {
      if (field === 'maritalStatus') await page.locator('#maritalStatus').selectOption('');
      else await page.locator(`#${field}-none`).check();
    }
    await page.locator('#save-profile').click();
    await expect(page.locator('#profile-save-state')).toBeHidden();
    assert.deepEqual(withoutIds((await page.evaluate(() => window.secondHand.getData())).profile), withoutIds(unanswered));
    await page.locator('#lock-button').click();
    await page.locator('#passphrase').fill(resetPassword);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="profile"]').click();
    const { householdMembers: __, ...scalarUnanswered } = unanswered;
    assert.deepEqual(await shownProfile(), scalarUnanswered);
    for (const field of IOWA_QUESTIONS.filter(field => field !== 'maritalStatus')) await expect(page.locator(`#${field}-none`)).toBeChecked();

    // Locked out with no password or recovery key: start over from the reset screen.
    await page.locator('#lock-button').click();
    await page.locator('#forgot-password').click();
    await page.locator('#start-over').click();
    await expect(page.locator('#start-over-submit')).toBeDisabled();
    await page.locator('#start-over-confirm').fill('start over');
    await page.locator('#start-over-submit').click();
    await expect(page.locator('#confirm-passphrase-field')).toBeVisible();
    await assert.rejects(fs.access(path.join(userData, 'vault.secondhand')));
    await assert.rejects(fs.access(path.join(userData, 'touch-unlock.bin')), 'Start over removes Touch ID’s key');
    await expect(page.locator('#touch-id-unlock')).toBeHidden();
    await page.locator('#passphrase').fill(startOverPassword);
    await page.locator('#confirm-passphrase').fill(startOverPassword);
    if (await page.locator('#device-reset-field').isVisible()) await page.locator('#allow-device-reset').uncheck();
    await page.locator('#auth-submit').click();
    await page.locator('#recovery-saved').check();
    await page.locator('#recovery-done').click();
    await expect(page.locator('#workspace')).toBeVisible();
    // A new password offers the setup again; skipping it leaves it on Overview to finish later.
    await expect(page.locator('#setup-dialog')).toBeVisible();
    await page.locator('#setup-skip').click();
    await expect(page.locator('#setup-dialog')).not.toBeVisible();
    await expect(page.locator('#setup-resume-text')).toHaveText('Finish setting up: 0 of 6 steps');
    assert.deepEqual((await page.evaluate(() => window.secondHand.getData())).profile, {});
    assert.deepEqual(errors, []);
    console.log('Electron UI smoke passed: guided setup offered after the recovery key, saved step by step with a household list, finished later from Overview and readable at 200% zoom; Laya downloads on its own on a new install and stays off once turned off, create, save full applicant choices, Iowa’s questions about you and mailing details, track application, lock/clear all fields, wrong password with normal and delayed lock notification, unlock, restart persistence, Touch ID on (test hook) with a lock-screen lock, a Touch ID unlock, and Touch ID ready at once after a restart, recovery key password reset that keeps Touch ID, clear Iowa’s questions, start over (which removes Touch ID) and its setup offer.');
  } catch (error) {
    if (page && !page.isClosed()) {
      const auth = await page.evaluate(() => ({
        events: window.__secondHandSmokeAuth,
        focused: document.hasFocus(), activeControl: document.activeElement?.id,
        passphrasePresent: Boolean(document.querySelector('#passphrase').value),
        errorHidden: document.querySelector('#auth-error').hidden,
        submitDisabled: document.querySelector('#auth-submit').disabled,
        submitBusy: document.querySelector('#auth-submit').getAttribute('aria-busy'),
        workspaceHidden: document.querySelector('#workspace').hidden
      })).catch(() => ({ unavailable: true }));
      console.error('Sanitized auth failure diagnostics:', JSON.stringify(auth));
      // Record what the window showed when a step failed; CI uploads artifacts/.
      await captureDiagnostic(page, 'ui-smoke-failure.png')
        .catch(screenshotError => console.error('Failure screenshot unavailable:', screenshotError.message));
    }
    throw error;
  } finally {
    if (application) await application.close().catch(() => {});
    await layaServer.close();
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
