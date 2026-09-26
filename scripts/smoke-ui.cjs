'use strict';
// All test data is synthetic and confined to a temporary vault.
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..');
const passphrase = 'synthetic-test-vault-passphrase';

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-ui-'));
  const errors = [];
  let application;
  const launch = async () => {
    application = await electron.launch({ args: [root], env: { ...process.env, SECONDHAND_USER_DATA: userData }, timeout: 30000 });
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#auth-view').waitFor({ state: 'visible' });
    return page;
  };
  try {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    let page = await launch();
    await page.screenshot({ path: path.join(root, 'artifacts/vault-setup.png') });
    await page.locator('#passphrase').fill(passphrase);
    await page.locator('#confirm-passphrase').fill(passphrase);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="profile"]').click();
    await page.locator('#firstName').fill('Synthetic');
    await page.locator('#lastName').fill('Tester');
    await page.locator('#state').fill('IA');
    await page.locator('#monthlyEarnedIncome').fill('0');
    await page.locator('#save-profile').click();
    await expect(page.locator('#profile-save-state')).toHaveText('Saved locally');
    const profile = await page.evaluate(async () => (await window.secondHand.getData()).profile);
    assert.equal(profile.firstName, 'Synthetic');
    assert.equal(profile.monthlyEarnedIncome, '0');
    assert.equal(profile.monthlyRent, '');
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
    await page.screenshot({ path: path.join(root, 'artifacts/desktop-overview.png'), fullPage: true });
    await page.locator('#lock-button').click();
    await expect(page.locator('#auth-view')).toBeVisible();
    const cleared = await page.evaluate(() => ({
      firstName: document.querySelector('#firstName').value,
      notes: document.querySelector('#application-notes').value,
      cards: document.querySelector('#application-list').textContent,
      overview: document.querySelector('#overview-applications').textContent
    }));
    assert.deepEqual(cleared, { firstName: '', notes: '', cards: '', overview: '' });
    await page.locator('#passphrase').fill('incorrect-passphrase');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#auth-error')).toBeVisible();
    await expect(page.locator('#workspace')).not.toBeVisible();
    await page.locator('#passphrase').fill(passphrase);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="profile"]').click();
    await expect(page.locator('#firstName')).toHaveValue('Synthetic');
    await page.evaluate(() => window.secondHand.lock());
    await expect(page.locator('#auth-view')).toBeVisible();
    await expect(page.locator('#firstName')).toHaveValue('');
    await application.close();
    application = null;

    page = await launch();
    await page.locator('#passphrase').fill(passphrase);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#workspace')).toBeVisible();
    const restored = await page.evaluate(() => window.secondHand.getData());
    assert.equal(restored.profile.firstName, 'Synthetic');
    assert.equal(restored.applications[0].confirmationNumber, 'SYNTHETIC-RECEIPT-ONLY');
    const bytes = await fs.readFile(path.join(userData, 'vault.secondhand'), 'utf8');
    for (const secret of ['Synthetic', 'Tester', 'SYNTHETIC-RECEIPT-ONLY', passphrase]) assert.equal(bytes.includes(secret), false);
    assert.deepEqual(errors, []);
    console.log('Electron UI smoke passed: create, save profile, track application, lock/clear, wrong password, unlock, restart persistence.');
  } finally {
    if (application) await application.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
