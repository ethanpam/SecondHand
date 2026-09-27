'use strict';
// All test data is synthetic and confined to a temporary vault.
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const applicantFixture = require('../tests/fixtures/applicant-profile.json');
const { PROFILE_FIELDS } = require('../shared/schema.cjs');
const root = path.join(__dirname, '..');
const passphrase = 'synthetic-test-vault-passphrase';
// Creating or unlocking the vault derives its key with scrypt (N=2^15, r=8) in the
// main process: about 65 ms on an M4 Max, but many times that on a loaded hosted
// macOS runner. Bound the whole attempt generously instead of Playwright's 5s default.
const AUTH_ATTEMPT_TIMEOUT_MS = 30000;
const resetPassword = 'synthetic-reset-password';

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

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-ui-'));
  const errors = [];
  let application;
  let page;
  const launch = async () => {
    application = await electron.launch({ args: [root], env: { ...process.env, SECONDHAND_USER_DATA: userData }, timeout: 30000 });
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
    await page.locator('.nav-item[data-view="profile"]').click();
    for (const field of PROFILE_FIELDS) {
      const control = page.locator(`#${field}`);
      if (await control.evaluate(element => element.tagName === 'SELECT')) await control.selectOption(applicantFixture[field]);
      else await control.fill(applicantFixture[field]);
    }
    await page.locator('#save-profile').click();
    await expect(page.locator('#profile-save-state')).toBeHidden();
    const profile = await page.evaluate(async () => (await window.secondHand.getData()).profile);
    assert.deepEqual(profile, applicantFixture);
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
    const clearedProfile = await page.locator('#profile-form').evaluate(form => Object.fromEntries(Array.from(form.querySelectorAll('[name]'), control => [control.name, control.value])));
    assert.deepEqual(clearedProfile, Object.fromEntries(PROFILE_FIELDS.map(field => [field, ''])));
    await rejectedPassphrase(page);
    await page.locator('#passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="profile"]').click();
    await expect(page.locator('#firstName')).toHaveValue(applicantFixture.firstName);

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

    page = await launch();
    await page.locator('#passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    const restored = await page.evaluate(() => window.secondHand.getData());
    assert.deepEqual(restored.profile, applicantFixture);
    assert.equal(restored.applications[0].confirmationNumber, 'SYNTHETIC-RECEIPT-ONLY');
    await page.locator('#lock-button').click();
    await page.locator('#forgot-password').click();
    await page.locator('#recovery-key-input').fill(recoveryKey.toLowerCase().replace(/-/g, ' '));
    await page.locator('#reset-password').fill(resetPassword);
    await page.locator('#reset-confirm').fill(resetPassword);
    await page.locator('#reset-submit').click();
    await expect(page.locator('#workspace')).toBeVisible();
    assert.deepEqual((await page.evaluate(() => window.secondHand.getData())).profile, applicantFixture);
    await page.locator('#lock-button').click();
    await page.locator('#passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#auth-error')).toBeVisible();
    await page.locator('#passphrase').fill(resetPassword);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    const bytes = await fs.readFile(path.join(userData, 'vault.secondhand'), 'utf8');
    for (const secret of ['Avery', 'Example', applicantFixture.addressLine1, '2025550147', 'SYNTHETIC-RECEIPT-ONLY', passphrase, resetPassword, recoveryKey, recoveryKey.replace(/-/g, '')]) assert.equal(bytes.includes(secret), false);
    assert.deepEqual(errors, []);
    console.log('Electron UI smoke passed: create, save full applicant choices and mailing details, track application, lock/clear all fields, wrong password with normal and delayed lock notification, unlock, restart persistence, recovery key password reset.');
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
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
