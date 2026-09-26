'use strict';

const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const site = process.env.SECONDHAND_WEBSITE_URL || 'http://localhost:5173';
const artifacts = path.join(__dirname, '..', 'artifacts', 'website');
const errors = [];
const externalRequests = new Set();

async function inspectLayout(page) {
  assert.equal(await page.locator('h1').count(), 1);
  assert.equal(await page.evaluate(width => document.documentElement.scrollWidth > width + 1, page.viewportSize().width), false, 'Page must not overflow horizontally');
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.SECONDHAND_BROWSER_CHANNEL || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(15_000);
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('download', download => console.log('Download started:', download.url()));
      page.on('request', request => {
        if (new URL(request.url()).origin !== new URL(site).origin) externalRequests.add(request.url());
      });
    });
    await context.route('**/download/**', route => route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="test-installer.txt"' },
      body: 'Synthetic installer fixture',
    }));
    const page = await context.newPage();
    await page.goto(site, { waitUntil: 'networkidle' });
    await expect(page.locator('.gradient-background canvas')).toBeVisible();
    await inspectLayout(page);
    const shaderFrame = () => page.locator('.gradient-canvas[data-paper-shader]').evaluate(element => element.paperShaderMount.getCurrentFrame());
    const initialFrame = await shaderFrame();
    await expect.poll(shaderFrame).toBeGreaterThan(initialFrame);
    await page.getByRole('button', { name: 'Pause background animation' }).click();
    await expect(page.getByRole('button', { name: 'Play background animation' })).toBeVisible();
    const pausedFrame = await shaderFrame();
    await page.waitForTimeout(200);
    assert.equal(await shaderFrame(), pausedFrame, 'Pause must stop drawing new frames');
    await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
    await page.getByRole('button', { name: 'Play background animation' }).click();
    await expect.poll(shaderFrame).toBeGreaterThan(pausedFrame);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.motion-toggle')).toHaveCount(0);
    const reducedFrame = await shaderFrame();
    await page.waitForTimeout(200);
    assert.equal(await shaderFrame(), reducedFrame, 'Reduced motion must stop animation');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(shaderFrame).toBeGreaterThan(reducedFrame);
    await page.locator('#setup').evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'start' }));
    await expect.poll(() => page.locator('.gradient-canvas[data-paper-shader]').evaluate(element => element.paperShaderMount.currentSpeed)).toBe(0);
    console.log('Shader rendering, pause/play, reduced motion, and offscreen suspension passed.');

    await page.getByRole('tab', { name: 'Windows', exact: true }).click();
    await page.getByRole('tab', { name: 'Windows', exact: true }).press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Mac', exact: true })).toBeFocused();
    await expect(page.getByRole('tabpanel', { name: 'Mac', exact: true })).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: 'Windows', exact: true })).toBeHidden();
    await page.getByRole('tab', { name: 'Mac', exact: true }).press('Home');
    await expect(page.getByRole('tab', { name: 'Windows', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Windows', exact: true }).press('End');
    await expect(page.getByRole('tab', { name: 'Mac', exact: true })).toHaveAttribute('aria-selected', 'true');

    for (const [platform, tab, label, filename] of [
      ['windows', 'Windows', 'Download for Windows', /win-x64\.exe$/],
      ['mac-apple-silicon', 'Mac', 'Apple Silicon', /mac-arm64\.dmg$/],
      ['mac-intel', 'Mac', 'Download for Intel Mac', /mac-x64\.dmg$/],
    ]) {
      await page.goto(site, { waitUntil: 'networkidle' });
      await page.getByRole('tab', { name: tab, exact: true }).click();
      console.log('Checking installer:', platform);
      const [downloaded] = await Promise.all([
        page.waitForEvent('download').catch(async error => {
          console.log('Download diagnostic:', page.url(), await page.locator('h1').allTextContents(), errors);
          await page.screenshot({ path: path.join(artifacts, 'download-failure.png') });
          throw error;
        }),
        page.getByRole('link', { name: label }).click(),
      ]);
      await expect(page).toHaveURL(`${site}/thank-you/${platform}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thanks for downloading secondHand');
      assert.match(downloaded.url(), filename);
      await inspectLayout(page);
      await page.screenshot({ path: path.join(artifacts, `${platform}.png`), fullPage: true });
    }
    console.log('Keyboard tabs and all three installer routes passed.');

    await page.goto(site, { waitUntil: 'networkidle' });
    const question = page.getByText('Does secondHand cost anything?', { exact: true });
    await question.click();
    await expect(page.getByText('No. The download is free, and there is no account or subscription.', { exact: true })).toBeVisible();
    await question.press('Enter');
    await expect(page.getByText('No. The download is free, and there is no account or subscription.', { exact: true })).toBeHidden();
    await page.getByText('If your computer shows a warning', { exact: true }).click();
    await expect(page.getByRole('link', { name: 'Apple’s guidance on opening apps' })).toBeVisible();

    for (const [route, title] of [['/privacy', 'Privacy policy'], ['/does-not-exist', 'Page not found'], ['/thank-you/unsupported', 'Page not found']]) {
      await page.goto(`${site}${route}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
      await inspectLayout(page);
      await page.screenshot({ path: path.join(artifacts, `${route.replaceAll('/', '-')}.png`), fullPage: true });
    }

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    mobile.on('pageerror', error => errors.push(error.message));
    await mobile.goto(site, { waitUntil: 'networkidle' });
    await expect(mobile.locator('.phone-note')).toBeVisible();
    await mobile.screenshot({ path: path.join(artifacts, 'mobile-hero.png') });
    await mobile.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
    for (const width of [320, 390, 768, 1024]) {
      await mobile.setViewportSize({ width, height: 844 });
      await inspectLayout(mobile);
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Privacy', exact: true }).click();
    await expect(mobile.getByRole('heading', { level: 1 })).toHaveText('Privacy policy');
    await inspectLayout(mobile);
    await mobile.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Setup guide' }).click();
    await expect(mobile).toHaveURL(`${site}/#setup`);
    await expect(mobile.getByRole('heading', { name: 'A few steps. Then you’re set.' })).toBeInViewport();

    await page.goto(site, { waitUntil: 'networkidle' });
    await page.locator('canvas').evaluate(canvas => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await expect(page.locator('.gradient-background canvas')).toHaveCount(0);
    await expect(page.locator('.motion-toggle')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const fallback = await context.newPage();
    await fallback.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        return type === 'webgl2' ? null : original.call(this, type, ...args);
      };
    });
    await fallback.goto(site, { waitUntil: 'networkidle' });
    await expect(fallback.locator('canvas')).toHaveCount(0);
    await expect(fallback.getByRole('heading', { level: 1 })).toBeVisible();
    await fallback.getByRole('tab', { name: 'Mac', exact: true }).click();
    await expect(fallback.getByRole('link', { name: 'Apple Silicon' })).toBeVisible();
    await fallback.screenshot({ path: path.join(artifacts, 'webgl-fallback.png') });
    const staticPage = await browser.newPage({ javaScriptEnabled: false });
    await staticPage.goto(site);
    await expect(staticPage.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(staticPage.getByRole('link', { name: 'Download for Windows' })).toBeAttached();
    assert.deepEqual(errors, [], 'No browser runtime errors');
    assert.deepEqual([...externalRequests], [], 'Fonts and shaders must stay self-hosted');
    console.log('Website smoke passed: shader animation, pause, reduced motion, offscreen suspension, context loss, WebGL fallback, responsive layouts, keyboard tabs, downloads, FAQ, privacy, and 404.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
