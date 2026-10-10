'use strict';
// Real Electron window, isolated synthetic vault; only the OS idle reading is controlled.
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  const libraryEdition = process.argv.includes('--library-edition');
  let appRoot = root;
  if (libraryEdition) {
    appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-library-edition-'));
    for (const folder of ['desktop', 'renderer', 'shared']) await fs.cp(path.join(root, folder), path.join(appRoot, folder), { recursive: true });
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ ...pkg, secondHandEdition: 'library' }));
    await fs.symlink(path.join(root, 'node_modules'), path.join(appRoot, 'node_modules'), 'dir');
  }
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-library-ui-'));
  await fs.writeFile(path.join(userData, 'settings.json'), '{"layaEnabled":false}');
  let app;
  const launch = async () => {
    app = await electron.launch({ args: [appRoot], env: { ...process.env, SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_USER_DATA: userData } });
    await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
    const page = await app.firstWindow();
    await expect(page.locator('#auth-view')).toBeVisible();
    return page;
  };
  try {
    let page = await launch();
    await page.evaluate(async () => {
      await window.secondHand.createVault({ password: 'synthetic library password', allowDeviceReset: false });
      await window.secondHand.saveProfile({ firstName: 'LibrarySynthetic' });
    });
    await page.reload();
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('.nav-item[data-view="privacy"]').click();
    if (libraryEdition) {
      await expect(page.locator('#library-mode-toggle')).toBeChecked();
      await expect(page.locator('#library-mode-toggle')).toBeDisabled();
      assert.equal(await app.evaluate(({ app }) => app.getName()), 'SecondHand Library');
      assert.equal(await page.evaluate(async () => (await window.secondHand.status()).libraryEdition), true);
    } else {
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#library-mode-toggle').check();
    }
    await expect(page.locator('#library-mode-notice')).toBeVisible();
    await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 119; });
    await page.waitForTimeout(1100);
    assert.equal(await page.evaluate(async () => (await window.secondHand.status()).exists), true);
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/library-mode.png') });
    await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 120; });
    await expect(page.locator('#auth-title')).toHaveText('Create a password');
    await expect(page.locator('#auth-submit')).toBeEnabled();
    await expect(page.locator('#workspace')).toBeHidden();
    assert.equal(await page.evaluate(async () => (await window.secondHand.status()).exists), false);
    assert.ok(!(await page.content()).includes('LibrarySynthetic'));
    await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
    await page.evaluate(() => window.secondHand.createVault({ password: 'synthetic next patron password', allowDeviceReset: false }));
    await app.close(); app = null;
    await assert.rejects(fs.access(path.join(userData, 'vault.secondhand')), { code: 'ENOENT' });
    page = await launch();
    await expect(page.locator('#library-mode-notice')).toBeVisible();
    await expect(page.locator('#auth-title')).toHaveText('Create a password');
    console.log('Library mode UI passed: enable, 119/120-second boundary, cleared DOM, next patron, exit deletion, persistent mode.');
  } finally {
    if (app) await app.close();
    await fs.rm(userData, { recursive: true, force: true });
    if (libraryEdition) await fs.rm(appRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
