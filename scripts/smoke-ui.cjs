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
  const launch = async () => {
    application = await electron.launch({ args: [root], env: { ...process.env, SECONDHAND_USER_DATA: userData }, timeout: 30000 });
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#auth-view').waitFor({ state: 'visible' });
    await page.evaluate(() => {
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
    let page = await launch();
    await captureDiagnostic(page, 'vault-setup.png');
    await page.locator('#passphrase').fill(passphrase);
    await page.locator('#confirm-passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="profile"]').click();
    for (const field of PROFILE_FIELDS) {
      const control = page.locator(`#${field}`);
      if (await control.evaluate(element => element.tagName === 'SELECT')) await control.selectOption(applicantFixture[field]);
      else await control.fill(applicantFixture[field]);
    }
    await page.locator('#save-profile').click();
    await expect(page.locator('#profile-save-state')).toHaveText('Saved locally');
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
    await page.locator('#passphrase').fill('incorrect-passphrase');
    await submitAuthForm(page);
    await expect(page.locator('#auth-error')).toBeVisible();
    await expect(page.locator('#workspace')).not.toBeVisible();
    await page.locator('#passphrase').fill(passphrase);
    await submitAuthForm(page);
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="profile"]').click();
    await expect(page.locator('#firstName')).toHaveValue(applicantFixture.firstName);
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
    const bytes = await fs.readFile(path.join(userData, 'vault.secondhand'), 'utf8');
    for (const secret of ['Avery', 'Example', '123 Test Way', '2025550147', 'SYNTHETIC-RECEIPT-ONLY', passphrase]) assert.equal(bytes.includes(secret), false);
    assert.deepEqual(errors, []);
    console.log('Electron UI smoke passed: create, save full applicant choices and mailing details, track application, lock/clear all fields, wrong password, unlock, restart persistence.');
  } finally {
    if (application) await application.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
