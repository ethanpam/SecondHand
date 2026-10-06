'use strict';

// Captures the card the extension on this checkout shows on Iowa's application, for the website's Chrome guide
// (website/public/guide/iowa-card.png). It loads extension/ into Chromium against the synthetic applicant page and
// stubbed desktop app of smoke-extension.cjs: no real applicant data, and every other request is blocked. The picture
// is a 2x pixel capture of the page around the card, nothing drawn in or cut out of it. It writes no file unless the
// card shows the logo and Autofill and nothing else.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { fixture, installNativeStub, applicant, extensionDirectory, syntheticProfile } = require('./smoke-extension.cjs');

const output = path.join(__dirname, '..', 'website', 'public', 'guide', 'iowa-card.png');
// The card's shadow (0 12px 42px, content.js) reaches 42px past its left and top edges. Right and bottom, the
// picture runs to the window's edge, where the card sits.
const shadow = 42;

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-guide-card-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(userData, {
      channel: 'chromium', headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
      args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND']
    });
    await context.route('**/*', route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.isNavigationRequest() && `${url.origin}${url.pathname}` === applicant) {
        return route.fulfill({ status: 200, contentType: 'text/html', body: fixture(url.searchParams.get('next')) });
      }
      if (url.protocol === 'chrome-extension:') return route.continue();
      return route.abort('blockedbyclient');
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    await installNativeStub(worker);
    await worker.evaluate(profile => { globalThis.__nativeSmoke = { locked: false, accessRevision: 0, calls: [], profile }; }, syntheticProfile);
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${applicant}?next=stay`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    const host = page.locator('[data-secondhand-assistant]');
    await expect(host).toHaveAttribute('data-secondhand-size', 'full');
    const launcherUrl = `chrome-extension://${new URL(worker.url()).hostname}/panel.html?surface=launcher`;
    await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 15000 }).toBe(true);
    const widget = page.frames().find(frame => frame.url() === launcherUrl);

    // The card a reader sees on main: the logo and Autofill, and nothing that asks them to act first.
    await expect(widget.locator('#details')).toBeVisible();
    await expect(widget.locator('#autofill')).toBeVisible();
    await expect(widget.locator('#autofill')).toHaveText('Autofill');
    for (const hidden of ['#unlock', '#open-app', '#stop', '#need-you', '#translate-offer']) await expect(widget.locator(hidden)).toBeHidden();
    // The frame fits the widget once the widget has measured itself and its fonts have loaded.
    await widget.evaluate(() => document.fonts.ready);
    await expect.poll(async () => (await host.boundingBox()).width === await widget.locator('#widget').evaluate(card => Math.ceil(card.getBoundingClientRect().width)), { timeout: 15000 }).toBe(true);

    const box = await host.boundingBox();
    const viewport = page.viewportSize();
    const x = Math.floor(box.x - shadow), y = Math.floor(box.y - shadow);
    await page.screenshot({ path: output, clip: { x, y, width: viewport.width - x, height: viewport.height - y }, animations: 'disabled', caret: 'hide' });
    console.log(`Captured the card (${box.width}x${box.height}) to ${path.relative(process.cwd(), output)} at ${(viewport.width - x) * 2}x${(viewport.height - y) * 2}.`);
  } finally {
    if (context) await context.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
