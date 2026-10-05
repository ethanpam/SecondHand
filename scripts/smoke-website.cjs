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
  assert.doesNotMatch(await page.locator('body').innerText(), /secondHand/, 'Visible branding must use SecondHand');
  assert.doesNotMatch(await page.title(), /secondHand/, 'Page titles must use SecondHand');
  for (const description of await page.locator('meta[name="description"], meta[property="og:site_name"], meta[property="og:title"]').evaluateAll(elements => elements.map(element => element.getAttribute('content')))) {
    assert.doesNotMatch(description, /secondHand/, 'Metadata must use SecondHand');
  }
  await expect(page.locator('.brand').first()).toHaveAccessibleName('SecondHand home');
  await expect(page.locator('.brand').first()).toHaveText('SecondHand');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/brand/secondhand-icon.png');
  assert.equal(await page.locator('.brand-mark').first().evaluate(image => image.complete && image.naturalWidth > 0), true, 'The mascot must load');
  assert.equal(await page.evaluate(width => document.documentElement.scrollWidth > width + 1, page.viewportSize().width), false, 'Page must not overflow horizontally');
}

async function inspectHeroLayout(page) {
  await expect(page.locator('.workflow-preview, .paper-stack, .stack-controls')).toHaveCount(0);
  await expect(page.locator('.hero')).not.toContainText(/A place for your details|Your say, every time|Filled in. Still your call/);
  const background = await page.locator('.gradient-background').boundingBox();
  const header = await page.locator('.site-header').boundingBox();
  const content = await page.locator('.hero h1').boundingBox();
  assert.ok(background && header && content);
  assert.ok(background.y <= header.y, 'Shader must extend behind the top navigation');
  assert.equal(background.x, 0, 'Shader must reach the left edge');
  assert.equal(background.width, page.viewportSize().width, 'Shader must span the viewport');
  assert.ok(header.y + header.height < content.y, 'Navigation must not overlap hero copy');
  assert.notEqual(await page.locator('.gradient-background').evaluate(element => getComputedStyle(element).maskImage), 'none', 'Shader must fade out before its bottom edge');
  for (const selector of ['.site-header', '.site-header nav', '.demo-section']) {
    assert.equal(await page.locator(selector).evaluate(element => {
      const style = getComputedStyle(element);
      return parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    }), 0, 'Header and hero transitions must not have a dividing border');
  }
}

async function inspectWordmark(page) {
  await page.goto(site, { waitUntil: 'networkidle' });
  await expect(page.locator('.variable-wordmark')).toHaveText('SecondHand');
  const letter = page.locator('.variable-wordmark [data-letter]').nth(4);
  const weight = () => letter.evaluate(element => getComputedStyle(element).fontVariationSettings);
  await letter.hover();
  await expect.poll(weight).not.toBe('"wght" 450');
  await page.mouse.move(0, 0);
  await expect.poll(weight).toBe('"wght" 450');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await letter.hover();
  assert.equal(await weight(), '"wght" 450', 'Reduced motion must disable proximity animation');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(0, 0);
  console.log('React Bits wordmark, reduced motion, and branding passed.');
}

async function inspectStaticDemo(page) {
  await expect(page.locator('#demo-heading')).toHaveAccessibleName('Ready for less typing?');
  await expect(page.locator('.text-type__content')).toHaveText('Ready for less typing?');
  await expect(page.locator('.text-type')).toHaveAttribute('data-running', 'false');
  await expect(page.locator('.text-type__cursor')).toBeHidden();
  await expect(page.locator('.autofill-demo')).toHaveAttribute('data-phase', 'complete');
  await expect(page.locator('.autofill-demo')).toHaveAttribute('data-running', 'false');
  await expect(page.locator('.autofill-field[data-filled="true"]')).toHaveCount(3);
  await expect(page.locator('.autofill-cursor')).toBeHidden();
  await expect(page.locator('.autofill-demo input, .autofill-demo form')).toHaveCount(0);
}

async function inspectDemoMotion(page) {
  await page.goto(site, { waitUntil: 'networkidle' });
  // The demo sits under the hero, so it starts from the footer, where the demo is off screen.
  const footer = page.locator('.site-footer');
  await footer.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'end' }));
  const heading = page.locator('#demo-heading');
  const text = page.locator('.text-type');
  const content = page.locator('.text-type__content');
  const demo = page.locator('.autofill-demo');
  await expect(text).toHaveAttribute('data-running', 'false');
  await expect(demo).toHaveAttribute('data-running', 'false');
  await demo.evaluate(element => {
    const samples = [];
    function record() {
      const phase = element.dataset.phase;
      if (samples.at(-1)?.[0] !== phase) samples.push([phase, element.querySelectorAll('[data-filled="true"]').length]);
    }
    const observer = new MutationObserver(record);
    observer.observe(element, { attributes: true, subtree: true });
    record();
    element.motionProbe = { samples, observer };
  });
  await page.locator('.demo-section').evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'start' }));
  await expect(text).toHaveAttribute('data-running', 'true');
  await expect(demo).toHaveAttribute('data-running', 'true');
  await expect(heading).toHaveAccessibleName('Ready for less typing?');
  const headingSize = await heading.boundingBox();
  await expect.poll(async () => (await content.innerText()).length).toBeGreaterThan(0);
  assert.ok((await content.innerText()).length < 'Ready for\nless typing?'.length, 'The heading must type, not appear in one frame');
  await expect(demo).toHaveAttribute('data-phase', 'complete');
  const stages = await demo.evaluate(element => {
    element.motionProbe.observer.disconnect();
    return element.motionProbe.samples;
  });
  assert.deepEqual(stages, [['approach', 0], ['click', 0], ['name', 1], ['email', 2], ['city', 3], ['complete', 3]], 'Approval must precede fields filling one at a time');
  await expect(content).toHaveText('Ready for less typing?');
  await expect(text).toHaveAttribute('data-deleting', 'true');
  await expect.poll(async () => (await content.innerText()).length).toBeLessThan('Ready for\nless typing?'.length);
  assert.deepEqual(await heading.boundingBox(), headingSize, 'Typing and deleting must not shift the heading layout');
  await expect(heading).toHaveAccessibleName('Ready for less typing?');
  await expect(demo).toHaveAttribute('data-phase', 'approach');
  await expect(demo).toHaveAttribute('data-phase', 'complete');
  await page.screenshot({ path: path.join(artifacts, 'text-type-desktop.png') });

  async function assertSuspended() {
    await expect(text).toHaveAttribute('data-running', 'false');
    await expect(demo).toHaveAttribute('data-running', 'false');
    const previousText = await content.innerText();
    const previousPhase = await demo.getAttribute('data-phase');
    assert.equal(await page.locator('.text-type__cursor').evaluate(element => getComputedStyle(element).animationPlayState), 'paused');
    await page.waitForTimeout(500);
    assert.equal(await content.innerText(), previousText);
    assert.equal(await demo.getAttribute('data-phase'), previousPhase);
  }

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await assertSuspended();
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(text).toHaveAttribute('data-running', 'true');
  await footer.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'end' }));
  await assertSuspended();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await inspectStaticDemo(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  console.log('Text Type and click-to-autofill: typing/deleting, stable layout, field sequence, reduced motion, and visibility suspension passed.');
}

// The site says only what the extension on main does: the scope note, the update steps, and the card.
async function inspectWhatItDoes(page) {
  await page.goto(site, { waitUntil: 'networkidle' });
  const scope = await page.locator('.scope-note').innerText();
  for (const phrase of ['first suggested home address', 'guesses', 'Vietnamese', 'Arabic', 'on this computer']) {
    assert.ok(scope.includes(phrase), `What it does today must mention "${phrase}"`);
  }
  // The address the applicant must review ends the first paragraph, where a skimming reader sees it.
  await expect(page.locator('.scope-note p')).toHaveCount(3);
  await expect(page.locator('.scope-note p').first()).toContainText(/review that address before you submit\.$/);
  await page.getByText('Updating from an earlier version', { exact: true }).click();
  await expect(page.locator('#setup details[open] .details-body')).toContainText('reloads itself');
  await expect(page.locator('#setup details[open] .details-body')).toContainText('0.4.0 or earlier');
  await page.goto(`${site}/chrome-extension`, { waitUntil: 'networkidle' });
  await inspectLayout(page);
  await expect(page.locator('main')).not.toContainText(/Details link|\bDetails\b to open/);
  await expect(page.locator('img.guide-card')).not.toHaveAttribute('alt', /Details/);
  await expect(page.locator('section[aria-labelledby="after-update"]')).toContainText('reloads itself');
  await expect(page.locator('section[aria-labelledby="after-update"]')).toContainText('0.4.0 or earlier');
  await page.goto(site, { waitUntil: 'networkidle' });
  console.log('What it does today, update steps, and the Chrome guide card passed.');
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
    await inspectHeroLayout(page);
    const structuredData = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    assert.equal(structuredData.find(entry => entry['@type'] === 'SoftwareApplication').name, 'SecondHand');
    assert.equal(structuredData.some(entry => entry['@type'] === 'FAQPage'), false, 'The questions are described on their own page');
    const shaderFrame = () => page.locator('.gradient-canvas[data-paper-shader]').evaluate(element => element.paperShaderMount.getCurrentFrame());
    const initialFrame = await shaderFrame();
    await expect.poll(shaderFrame).toBeGreaterThan(initialFrame);
    // Animations always play: there is no pause, play, or replay button.
    await expect(page.getByRole('button', { name: /animations|replay/i })).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedFrame = await shaderFrame();
    await page.waitForTimeout(200);
    assert.equal(await shaderFrame(), reducedFrame, 'Reduced motion must stop animation');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(shaderFrame).toBeGreaterThan(reducedFrame);
    await page.locator('#setup').evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'start' }));
    await expect.poll(() => page.locator('.gradient-canvas[data-paper-shader]').evaluate(element => element.paperShaderMount.currentSpeed)).toBe(0);
    console.log('Shader rendering, reduced motion, and offscreen suspension passed.');
    await inspectWordmark(page);
    await inspectDemoMotion(page);
    await inspectWhatItDoes(page);

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
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thanks for downloading SecondHand');
      assert.match(downloaded.url(), filename);
      await inspectLayout(page);
      await page.screenshot({ path: path.join(artifacts, `${platform}.png`), fullPage: true });
    }
    console.log('Keyboard tabs and all three installer routes passed.');

    // The common questions live on their own page, linked from the bottom of the home page.
    await page.goto(site, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Read the common questions' }).click();
    await expect(page).toHaveURL(`${site}/faq`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Common questions');
    await inspectLayout(page);
    const faqData = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    assert.equal(faqData['@type'], 'FAQPage');
    assert.equal(faqData.mainEntity.length, await page.locator('.faq-list details').count(), 'Every question on the page is described for search engines');
    await page.screenshot({ path: path.join(artifacts, '-faq.png'), fullPage: true });
    const question = page.getByText('Does SecondHand cost anything?', { exact: true });
    await question.click();
    await expect(page.getByText('No. The download is free, and there is no account or subscription.', { exact: true })).toBeVisible();
    await question.press('Enter');
    await expect(page.getByText('No. The download is free, and there is no account or subscription.', { exact: true })).toBeHidden();
    await page.goto(site, { waitUntil: 'networkidle' });
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
      await inspectHeroLayout(mobile);
      await inspectStaticDemo(mobile);
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Privacy', exact: true }).click();
    await expect(mobile.getByRole('heading', { level: 1 })).toHaveText('Privacy policy');
    await inspectLayout(mobile);
    await mobile.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Setup guide' }).click();
    await expect(mobile).toHaveURL(`${site}/#setup`);
    await expect(mobile.getByRole('heading', { name: /A few steps.*Then you’re set./ })).toBeInViewport();

    await page.goto(site, { waitUntil: 'networkidle' });
    await page.locator('canvas').evaluate(canvas => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await expect(page.locator('.gradient-background canvas')).toHaveCount(0);
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
    await inspectHeroLayout(staticPage);
    await inspectLayout(staticPage);
    await inspectStaticDemo(staticPage);
    await expect(staticPage.getByRole('link', { name: 'Download for Windows' })).toBeAttached();
    await staticPage.route('**/download/**', route => route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="test-installer.txt"' },
      body: 'Synthetic installer fixture',
    }));
    await staticPage.goto(`${site}/thank-you/windows`);
    await expect(staticPage.locator('meta[http-equiv="refresh"]')).toHaveCount(0);
    await expect(staticPage.getByRole('heading', { level: 1 })).toHaveText('Thanks for downloading SecondHand');
    const [manualDownload] = await Promise.all([
      staticPage.waitForEvent('download'),
      staticPage.getByRole('link', { name: 'download it directly' }).click(),
    ]);
    assert.match(manualDownload.url(), /\/download\/secondHand-.*-win-x64\.exe$/);
    await expect(staticPage).toHaveURL(`${site}/thank-you/windows`);
    assert.deepEqual(errors, [], 'No browser runtime errors');
    assert.deepEqual([...externalRequests], [], 'Fonts and shaders must stay self-hosted');
    console.log('Website smoke passed: shader animation, reduced motion, offscreen suspension, context loss, WebGL fallback, responsive layouts, keyboard tabs, downloads, FAQ, privacy, and 404.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
