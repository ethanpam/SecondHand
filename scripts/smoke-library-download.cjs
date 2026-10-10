'use strict';
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const site = process.env.SECONDHAND_WEBSITE_URL || 'http://localhost:5173';
(async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce', acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/download/**', route => route.fulfill({ status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="synthetic.txt"' }, body: 'Synthetic download' }));
    await page.goto(`${site}/downloads`, { waitUntil: 'networkidle' });
    await page.getByRole('radio', { name: 'Library', exact: true }).check();
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const platform of ['Windows', 'Mac']) {
        await page.getByRole('tab', { name: platform, exact: true }).click();
        await expect(page.locator('.library-download-note')).toBeVisible();
        const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(layout.scroll <= layout.width + 1, `${platform} overflow at ${width}px`);
        for (const button of await page.locator('.download-content:not([hidden]) a').all()) {
          const bounds = await button.boundingBox();
          assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        }
      }
    }
    const directory = path.join(__dirname, '../artifacts/website');
    await fs.mkdir(directory, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(directory, 'library-download-mobile.png'), fullPage: true });
    for (const [platform, tab, label, file] of [
      ['windows', 'Windows', 'Download Library for Windows', /secondHand-library-.*-win-x64\.exe$/],
      ['mac-apple-silicon', 'Mac', 'Library for Apple Silicon', /secondHand-library-.*-mac-arm64\.dmg$/],
      ['mac-intel', 'Mac', 'Download Library for Intel Mac', /secondHand-library-.*-mac-x64\.dmg$/],
    ]) {
      await page.goto(`${site}/downloads`, { waitUntil: 'networkidle' });
      await page.getByRole('radio', { name: 'Library', exact: true }).check();
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await expect(page.getByRole('link', { name: 'Download checksums' })).toHaveAttribute('href', /SHA256SUMS-library/);
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: label }).click()]);
      assert.match(download.url(), file);
      await expect(page).toHaveURL(`${site}/thank-you/library-${platform}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thanks for downloading SecondHand Library');
      await expect(page.getByText(/Library mode is already on/)).toBeVisible();
    }
    await page.goto(`${site}/downloads`, { waitUntil: 'networkidle' });
    await page.getByRole('radio', { name: 'Library', exact: true }).check();
    await page.getByRole('radio', { name: 'Personal', exact: true }).check();
    await page.getByRole('tab', { name: 'Windows', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Download for Windows' })).toHaveAttribute('href', '/thank-you/windows');
    await expect(page.locator('.library-download-note')).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log('Library download smoke passed: 320–1440px, three installer routes, checksums, confirmation pages, Personal switch-back.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
