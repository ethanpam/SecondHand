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
const { PROFILE_FIELDS, LIST_FIELDS, validateProfile } = require('../shared/schema.cjs');
const { MODEL_FILES } = require('../desktop/laya-model.cjs');
const { relayRequest } = require('../desktop/bridge.cjs');
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
const withoutIds = profile => { const normalized = validateProfile(profile); return { ...normalized, householdMembers: normalized.householdMembers.map(({ id, ...member }) => member) }; };
const COUNT_FIELDS = ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'];
// Fields My information shows one by one; the household list has its own rows.
const SCALAR_FIELDS = PROFILE_FIELDS.filter(field => !LIST_FIELDS.includes(field));
const scalars = profile => Object.fromEntries(SCALAR_FIELDS.map(field => [field, profile[field] || '']));
// Questions answered with several choices (#184): one checkbox per choice, saved comma-separated.
const SEVERAL_FIELDS = ['incomeSources', 'currentBenefits', 'helpWanted'];
async function checkChoices(page, field, value) {
  const chosen = value ? value.split(',') : [];
  for (const box of await page.locator(`#profile-form input[type="checkbox"][name="${field}"]`).all()) await box.setChecked(chosen.includes(await box.getAttribute('value')));
}

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
  // #184: the student status is asked in You; the applicant's row on the household list follows it.
  await expect(page.locator('#studentLevel-hint')).toBeVisible();
  await page.locator('#studentLevel').selectOption(applicantFixture.studentLevel);
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
  await expect(self.locator('[data-member-field="student"]')).toBeDisabled();
  await expect(self.locator('[data-member-field="student"]')).toHaveValue('no');
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
    // #184: where the household's income comes from, the benefits it gets now and the help wanted. None stands alone.
    if (title === 'Income and money on hand') await checkChoices(page, 'incomeSources', applicantFixture.incomeSources);
    if (title === 'Programs') {
      await expect(page.locator('#currentBenefits-hint')).toBeVisible();
      await page.locator('#currentBenefits-snap').check();
      await page.locator('#currentBenefits-none').check();
      await expect(page.locator('#currentBenefits-snap')).not.toBeChecked();
      await checkChoices(page, 'currentBenefits', applicantFixture.currentBenefits);
      await checkChoices(page, 'helpWanted', applicantFixture.helpWanted);
      await captureDiagnostic(page, 'household/setup-programs.png', { fullPage: true });
    }
    await page.locator('#setup-next').click();
  }
  const answered = await page.evaluate(async () => (await window.secondHand.getData()).profile);
  assert.deepEqual(['studentLevel', ...SEVERAL_FIELDS].map(field => answered[field]), ['studentLevel', ...SEVERAL_FIELDS].map(field => applicantFixture[field]),
    'the setup saved the student status and the answers from lists');
  await expect(page.locator('#view-overview')).toBeVisible();
  await expect(page.locator('#toast')).toHaveText('Your information is set up. Change it any time in My information.');
  await expect(page.locator('#setup-resume')).toBeHidden();
  await assert.rejects(fs.access(progressFile), 'a finished setup keeps no progress file');
  console.log('Guided setup: offered after the recovery key, six steps saved as the applicant moved on, finished later from Overview; the household step listed four people and counted their ages.');
}

// Readable text (#166): every visible element `selector` matches that has text is at least `min` px (a `.field-hint`
// at least 12px), has 4.5:1 contrast with the nearest background that isn't transparent, and an h3 is at least as
// large as the paragraphs under it. Returns one line per element that falls short, naming its text, size and ratio.
async function unreadableText(page, selector, min) {
  return page.evaluate(({ selector, min }) => {
    const rgba = value => { const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number); return [r, g, b, a]; };
    const over = ([r, g, b, a], below) => [r, g, b].map((channel, index) => channel * a + below[index] * (1 - a));
    const luminance = rgb => {
      const [r, g, b] = rgb.map(channel => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const background = element => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) {
        const color = rgba(getComputedStyle(node).backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] === 1) break;
      }
      return layers.reduceRight((below, color) => over(color, below), [255, 255, 255]);
    };
    const visible = element => element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && element.textContent.trim();
    const size = element => parseFloat(getComputedStyle(element).fontSize);
    const name = element => `“${element.textContent.replace(/\s+/g, ' ').trim().slice(0, 70)}”`;
    const problems = [];
    for (const element of Array.from(document.querySelectorAll(selector)).filter(visible)) {
      const fill = background(element);
      const [l1, l2] = [luminance(over(rgba(getComputedStyle(element).color), fill)), luminance(fill)].sort((a, b) => b - a);
      const ratio = (l1 + 0.05) / (l2 + 0.05);
      const least = element.matches('.field-hint') ? 12 : min;
      if (size(element) < least || ratio < 4.5) problems.push(`${name(element)}: ${size(element)}px (needs ${least}px), ${ratio.toFixed(2)}:1 (needs 4.5:1)`);
      if (element.tagName !== 'H3') continue;
      for (let next = element.nextElementSibling; next && next.tagName !== 'H3'; next = next.nextElementSibling) {
        if (next.tagName === 'P' && visible(next) && size(next) > size(element)) problems.push(`${name(element)}: ${size(element)}px heading over a ${size(next)}px paragraph`);
      }
    }
    return problems;
  }, { selector, min });
}

// #200: every element each selector in `texts` matches is visible, and none falls short of unreadableText at the
// size it maps to. Problems name the selector, so a failure says which rule to fix.
async function assertReadable(page, texts, where) {
  const problems = [];
  for (const [selector, min] of Object.entries(texts)) {
    await expect(page.locator(selector)).not.toHaveCount(0);
    for (const element of await page.locator(selector).all()) await expect(element).toBeVisible();
    problems.push(...(await unreadableText(page, selector, min)).map(problem => `${selector} ${problem}`));
  }
  assert.equal(problems.length, 0, `Text too small or faint on ${where}:\n${problems.join('\n')}`);
}

// #186: one answer remembered from https://pantry.example.org through the bridge, shown, changed and removed in My information.
async function remembered(page, application, userData, pantry) {
  await application.evaluate(({ dialog }) => {
    globalThis.__smokeDialogs = [];
    dialog.showMessageBox = async (_window, options) => { globalThis.__smokeDialogs.push({ title: options.title, message: options.message, detail: options.detail }); return { response: 1 }; };
  });
  const request = (type, payload) => relayRequest(userData, 'a'.repeat(32), { id: crypto.randomUUID(), type, url: `${pantry}/visit`, ...payload });
  const question = { label: 'How did you hear about us?', type: 'radio', options: ['Friend', 'Church', 'Flyer'] };
  const reply = await request('rememberAnswers', { answers: [{ ...question, answer: 'Church' }] });
  assert.deepEqual([reply.ok, reply.data], [true, { remembered: 1 }], reply.error);
  await expect(page.locator('#toast')).toHaveText('An answer you chose to remember in Chrome is now in My information, under Custom answers.');
  await page.locator('.nav-item[data-view="profile"]').click();
  await page.locator('#custom-answers > summary').click();
  const row = page.locator('.custom-answer').filter({ has: page.locator('[data-custom-field="label"]') }).last();
  await expect(row.locator('[data-custom-field="label"]')).toHaveValue(question.label);
  await expect(row.locator('.custom-answer-site')).toHaveText('Saved from pantry.example.org with Remember for next time.');
  await expect(row.locator('select[data-custom-field="value"]')).toHaveValue('Church');
  assert.deepEqual(await row.locator('select[data-custom-field="value"] option').allTextContents(), question.options);
  await captureDiagnostic(page, 'remember/desktop-custom-answers.png', { fullPage: true });
  // Changed in My information, it is what the next Autofill on the same question gets.
  await row.locator('select[data-custom-field="value"]').selectOption('Flyer');
  await page.locator('#save-profile').click();
  await expect(page.locator('#profile-save-state')).toBeHidden();
  const saved = (await page.evaluate(() => window.secondHand.getData())).profile.customFields;
  assert.deepEqual(saved.map(({ id, ...answer }) => answer), [{ label: question.label, value: 'Flyer', aliases: [], ...question, site: pantry }]);
  const fill = await request('getCustomFields', { fields: [{ id: 'f0:sh-1-0', label: '2. How did you hear about us? *', type: 'radio', options: ['flyer', 'friend', 'church'] }] });
  assert.deepEqual([fill.ok, fill.data?.values], [true, { 'f0:sh-1-0': 'flyer' }], fill.error);
  assert.deepEqual(await application.evaluate(() => globalThis.__smokeDialogs.map(dialog => dialog.title)), ['Remember this answer?', 'Let Chrome fill this form?'],
    'the app asked before it kept the answer, and again before it filled it');
  assert.match(await application.evaluate(() => globalThis.__smokeDialogs[0].detail), /^“How did you hear about us\?”: "Church"\n\n/);
  await row.getByRole('button', { name: /^Remove custom answer/ }).click();
  await page.locator('#save-profile').click();
  await expect(page.locator('#profile-save-state')).toBeHidden();
  assert.deepEqual((await page.evaluate(() => window.secondHand.getData())).profile.customFields, []);
  console.log('#186: an answer remembered through the bridge, after the app’s confirmation, showed in Custom answers with its site and choices; changed there, it filled the same question; removed, the profile was as before.');
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
    const authHints = await unreadableText(page, '.field-hint', 12);
    assert.equal(authHints.length, 0, `Hints too small or faint on the create-password screen:\n${authHints.join('\n')}`);
    await assertReadable(page, { '#auth-description': 13, '#recovery-note': 12, '.auth-footnote': 12 }, 'the create-password screen');
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
    // Only the box's change event enables Continue (renderer/app.js), and showing a key, closing the dialog or locking
    // disables it again. Click once the app has seen the box checked for this key, so a miss names its step.
    await expect(page.locator('#recovery-saved')).toBeChecked();
    await expect(page.locator('#recovery-key-value')).toHaveText(recoveryKey);
    await expect(page.locator('#recovery-done')).toBeEnabled();
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
    // Let Chrome autofill without asking says it covers sensitive details on every site, and no site has Always allow on this site yet (#175).
    await expect(page.locator('#autofill-trust-hint')).toContainText('on every site SecondHand is on. That includes your Social Security number, birth date, income, benefits, and citizenship and disability answers.');
    await expect(page.locator('#always-allowed-sites-empty')).toBeVisible();
    await expect(page.locator('#always-allowed-sites li')).toHaveCount(0);
    // Connect Chrome is readable (#199): the sensitive-details warning, the setup steps, their hints and both switches
    // are at least 13px (hints 12px) and 4.5:1, at 100% and at 200% zoom.
    for (const hint of ['#extension-folder-help', '#autofill-trust-hint', '#all-sites-status', '#trusted-sites-empty', '#always-allowed-sites-empty']) await expect(page.locator(hint)).toBeVisible();
    const toggles = page.locator('#view-extension .trust-toggle>span');
    await expect(toggles).toHaveText(['Let Chrome autofill without asking', 'Find more fields with Laya (runs on this computer)']);
    for (const toggle of await toggles.all()) await expect(toggle).toBeVisible();
    const extensionText = '#view-extension :is(p, h3, .trust-toggle>span)';
    const extension = await unreadableText(page, extensionText, 13);
    assert.equal(extension.length, 0, `Text too small or faint on Connect Chrome:\n${extension.join('\n')}`);
    const extensionWidth = await page.evaluate(() => window.innerWidth);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(Math.ceil(extensionWidth / 2));
    const extensionZoomed = await unreadableText(page, extensionText, 13);
    assert.equal(extensionZoomed.length, 0, `Text too small or faint on Connect Chrome at 200% zoom:\n${extensionZoomed.join('\n')}`);
    const drawnExtension = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await fs.writeFile(path.join(root, 'artifacts/extension-zoom-200.png'), Buffer.from(drawnExtension, 'base64'));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(extensionWidth);
    // Turning it off is saved, and stays off after a restart (checked below).
    await page.locator('#laya-toggle').uncheck();
    await expect(page.locator('#toast')).toHaveText('Laya is off.');
    await expect(page.locator('#laya-status')).toHaveText(/^Off\. /);
    assert.equal(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).layaEnabled, false);
    await page.locator('.nav-item[data-view="profile"]').click();
    await expect(page.locator('#view-profile .field-hint').first()).toBeVisible();
    const profileHints = await unreadableText(page, '.field-hint', 12);
    assert.equal(profileHints.length, 0, `Hints too small or faint on My information:\n${profileHints.join('\n')}`);
    // What My information shows for every saved field, read the way the form submits it.
    const shownProfile = () => page.locator('#profile-form').evaluate((form, fields) => Object.fromEntries(fields.map(field => {
      const control = form.elements.namedItem(field);
      const boxes = control instanceof RadioNodeList && control[0].type === 'checkbox';
      return [field, boxes ? Array.from(control).filter(box => box.checked).map(box => box.value).join(',') : control.value];
    })), SCALAR_FIELDS);
    const { householdMembers: _, ...scalarFixture } = applicantFixture;
    for (const field of SCALAR_FIELDS) {
      if (!Object.hasOwn(applicantFixture, field)) continue; // Newly optional answers stay blank in this legacy fixture.
      // The guided setup saved the household list, so the counts come from it, read-only.
      if (COUNT_FIELDS.includes(field)) {
        await expect(page.locator(`#${field}`)).toHaveJSProperty('readOnly', true);
        await expect(page.locator(`#${field}`)).toHaveValue(applicantFixture[field]);
        continue;
      }
      if (SEVERAL_FIELDS.includes(field)) { await checkChoices(page, field, applicantFixture[field]); continue; }
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
    // The sidebar's menu and "Not a government service." are readable (#200), and fit the sidebar without sideways scrolling.
    await expect(page.locator('.nav-item')).toHaveCount(6);
    await assertReadable(page, { '.nav-item': 12, '.sidebar-disclaimer': 12 }, 'Overview’s sidebar');
    const sidebarOverflow = await page.locator('.sidebar').evaluate(sidebar => sidebar.scrollWidth - sidebar.clientWidth);
    assert.ok(sidebarOverflow <= 1, `no sideways scrolling in the sidebar (${sidebarOverflow}px)`);
    await page.locator('#lock-button').click();
    await expect(page.locator('#auth-view')).toBeVisible();
    // #201 hides the create-password description on the unlock screen; the note under the form is readable (#200).
    await expect(page.locator('#auth-description')).toBeHidden();
    await expect(page.locator('#recovery-note')).toHaveText('Your password never leaves this computer.');
    await assertReadable(page, { '#recovery-note': 12 }, 'the unlock screen');
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
    assert.deepEqual(await shownProfile(), scalars(scalarFixture));
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
    // As if the extension had turned on all websites before this start: the app's page offers Turn off. And as if the
    // applicant had chosen Always allow on this site on two sites they trusted and on one all websites let in (#175).
    const settingsPath = path.join(userData, 'settings.json');
    const [pantry, wic, forms] = ['https://pantry.example.org', 'https://wic.example.gov', 'https://forms.example.net'];
    await fs.writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await fs.readFile(settingsPath, 'utf8')), extensionId: 'a'.repeat(32), allSites: true,
      trustedSites: [pantry, wic], alwaysAllowedSites: [pantry, wic, forms] }));
    page = await launch();
    await page.locator('#passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="extension"]').click();
    await expect(page.locator('#laya-toggle')).not.toBeChecked();
    await expect(page.locator('#laya-status')).toHaveText(/^Off\. /);
    await expect(page.locator('#all-sites-status')).toHaveText(/^All websites: on\. /);
    await expect(page.locator('#always-allowed-sites code')).toHaveText([pantry, wic, forms]);
    await captureDiagnostic(page, 'desktop-all-websites-on.png', { fullPage: true });
    await page.locator('#all-sites-off').click();
    await expect(page.locator('#toast')).toHaveText('SecondHand will no longer fill forms on every website. Sites you trusted one by one stay on.');
    await expect(page.locator('#all-sites-status')).toHaveText(/^All websites: off\. /);
    assert.equal(JSON.parse(await fs.readFile(settingsPath, 'utf8')).allSites, undefined, 'turning it off is saved');
    // Always allow on the site all websites let in goes with it; the sites trusted on their own keep theirs.
    await expect(page.locator('#always-allowed-sites code')).toHaveText([pantry, wic]);
    assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')).alwaysAllowedSites, [pantry, wic]);
    // Remove takes back Always allow on one site, which stays trusted; removing a trusted site takes back its Always allow too.
    await page.locator('#always-allowed-sites li').first().getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('#toast')).toHaveText(`Always allow on this site is off for ${pantry}.`);
    await expect(page.locator('#always-allowed-sites code')).toHaveText([wic]);
    await expect(page.locator('#trusted-sites code')).toHaveText([pantry, wic]);
    await page.locator('#trusted-sites li').nth(1).getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('#trusted-sites code')).toHaveText([pantry]);
    await expect(page.locator('#always-allowed-sites li')).toHaveCount(0);
    await expect(page.locator('#always-allowed-sites-empty')).toBeVisible();
    const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.deepEqual([saved.trustedSites, saved.alwaysAllowedSites], [[pantry], undefined], 'both removals are saved');
    await captureDiagnostic(page, 'desktop-always-allowed-sites.png', { fullPage: true });
    // The app's Laya runtime is off: it checks and downloads nothing while off, and this start never turned it on, so a
    // request could only have come from a check the start began, before the window opened (#143: state, not a wait).
    assert.deepEqual(await page.evaluate(() => window.secondHand.layaStatus().then(status => [status.state, status.enabled])), ['off', false]);
    assert.equal(layaServer.requests.length, layaRequests, 'Laya, turned off, checked and downloaded nothing after the restart');
    const restored = await page.evaluate(() => window.secondHand.getData());
    assert.deepEqual(withoutIds(restored.profile), withoutIds(applicantFixture));
    assert.equal(restored.applications[0].confirmationNumber, 'SYNTHETIC-RECEIPT-ONLY');

    // Remember for next time (#186), through the app's real bridge: the extension asks the app to keep a pantry's question
    // as a custom answer. The app's confirmation is answered Remember here (Electron's native dialog can't be clicked by a
    // test); the dialogs it showed are kept to check. My information's Custom answers then lists it with the site it came
    // from and its own choices; a changed answer is what the next Autofill gets; and removing it leaves the profile as it was.
    await remembered(page, application, userData, pantry);

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
    // Privacy & backups is readable (#166): its text at least 13px, hints 12px, all at 4.5:1, at 100% and at 200% zoom.
    const privacyText = '#view-privacy :is(p, h3, strong, label), .field-hint';
    const privacy = await unreadableText(page, privacyText, 13);
    assert.equal(privacy.length, 0, `Text too small or faint on Privacy & backups:\n${privacy.join('\n')}`);
    await captureDiagnostic(page, 'desktop-privacy.png', { fullPage: true });
    const privacyWidth = await page.evaluate(() => window.innerWidth);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(Math.ceil(privacyWidth / 2));
    const privacyOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(privacyOverflow <= 1, `no sideways scrolling on Privacy & backups at 200% (${privacyOverflow}px)`);
    const privacyZoomed = await unreadableText(page, privacyText, 13);
    assert.equal(privacyZoomed.length, 0, `Text too small or faint on Privacy & backups at 200% zoom:\n${privacyZoomed.join('\n')}`);
    const drawnPrivacy = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await fs.writeFile(path.join(root, 'artifacts/privacy-zoom-200.png'), Buffer.from(drawnPrivacy, 'base64'));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(privacyWidth);
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
    assert.deepEqual(await shownProfile(), scalars(scalarUnanswered));
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
    // The setup is offered only if its start is saved while the key is on screen (renderer/app.js): wait for the
    // attempt, setup save included, to settle before Continue.
    await submitAuthForm(page);
    await page.locator('#recovery-saved').check();
    await page.locator('#recovery-done').click();
    await expect(page.locator('#workspace')).toBeVisible();
    // A new password offers the setup again; skipping it leaves it on Overview to finish later.
    await expect(page.locator('#setup-dialog')).toBeVisible();
    await page.locator('#setup-skip').click();
    await expect(page.locator('#setup-dialog')).not.toBeVisible();
    await expect(page.locator('#setup-resume-text')).toHaveText('Finish setting up: 0 of 6 steps');
    assert.deepEqual((await page.evaluate(() => window.secondHand.getData())).profile, {});
    // #180: with no household list saved, Overview offers Add your household. The extension's Add your household, through the
    // app's real bridge, opens My information at Your household. Dismiss keeps the note away, and the settings keep it so.
    await expect(page.locator('#household-note')).toBeVisible();
    await expect(page.locator('#household-note-text')).toHaveText('Add your household: SecondHand can then answer questions like “# of children 0–5”.');
    await captureDiagnostic(page, 'household/overview-note.png');
    const opened = await relayRequest(userData, 'a'.repeat(32), { id: crypto.randomUUID(), type: 'openHousehold' });
    assert.deepEqual([opened.ok, opened.data], [true, { shown: true }], opened.error);
    await expect(page.locator('#view-profile')).toBeVisible();
    await expect(page.locator('#household-heading')).toBeFocused();
    await captureDiagnostic(page, 'household/opened-from-chrome.png');
    await page.locator('.nav-item[data-view="overview"]').click();
    await page.locator('#household-note-dismiss').click();
    await expect(page.locator('#household-note')).toBeHidden();
    assert.equal(JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).householdNoteDismissed, true);
    console.log('#180: with no household list saved, Overview offered Add your household; openHousehold through the bridge opened My information at Your household; Dismiss kept the note away and was saved.');
    assert.deepEqual(errors, []);
    console.log('Electron UI smoke passed: guided setup offered after the recovery key, saved step by step with a household list, the student status and the answers from lists, finished later from Overview and readable at 200% zoom; Laya downloads on its own on a new install and stays off once turned off, create, save full applicant choices, Iowa’s questions about you and mailing details, track application, lock/clear all fields, wrong password with normal and delayed lock notification, unlock, restart persistence, readable hints, password screen notes and sidebar text, Connect Chrome text and Privacy & backups text (both also at 200% zoom), Touch ID on (test hook) with a lock-screen lock, a Touch ID unlock, and Touch ID ready at once after a restart, recovery key password reset that keeps Touch ID, clear Iowa’s questions, start over (which removes Touch ID) and its setup offer.');
  } catch (error) {
    if (page && !page.isClosed()) {
      const auth = await page.evaluate(() => ({
        events: window.__secondHandSmokeAuth,
        focused: document.hasFocus(), activeControl: document.activeElement?.id,
        passphrasePresent: Boolean(document.querySelector('#passphrase').value),
        errorHidden: document.querySelector('#auth-error').hidden,
        submitDisabled: document.querySelector('#auth-submit').disabled,
        submitBusy: document.querySelector('#auth-submit').getAttribute('aria-busy'),
        workspaceHidden: document.querySelector('#workspace').hidden,
        // The recovery key dialog: whether it is open, its box checked, Continue disabled, and a key shown (never the key).
        recoveryOpen: document.querySelector('#recovery-dialog').open,
        recoverySaved: document.querySelector('#recovery-saved').checked,
        recoveryDoneDisabled: document.querySelector('#recovery-done').disabled,
        recoveryKeyShown: Boolean(document.querySelector('#recovery-key-value').textContent)
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
