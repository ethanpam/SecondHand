'use strict';

// Real Chromium for "What this page says". Headless Chromium has no summary model, so the side panel
// hides the section and says nothing about it. The page reader still runs for real: Iowa's
// information screens are read through the content script and worker, kept across autofill until the
// tab leaves Iowa, and a pantry form with long instructions reads as its words without any typed
// answer. Fixtures are synthetic, DNS is disabled, every request is recorded to show that nothing
// leaves the computer, and native desktop replies are DevTools stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const smoke = require('./smoke-extension.cjs');
const strings = require('../extension/strings.js');
const preApplicant = require('../tests/fixtures/iowa-pre-applicant.cjs');
const pantry = require('../tests/fixtures/pantry-forms.cjs');

const en = key => strings.text('en', key);
const PANTRY_URL = 'https://pantry.example.org/sign-up';
const screenUrl = name => `${smoke.portal}${preApplicant.screens[name].path}`;
const IMPORTANT = 'Important Information when applying and what to expect.\nWhat you need to do.';
const BEFORE_START = 'Before You Start...\nHave these ready before you start your application.';
const INSTRUCTIONS = ['Instructions', 'You\'ll see some questions with a star next to them.', 'Check this box next to the item you want to select.',
  'Check this button next to the item you want to select.', 'OK. Let\'s start the application.'].join('\n');
const OPTIONS = { type: 'key-points', length: 'short', format: 'plain-text', outputLanguage: 'en', expectedInputLanguages: ['en'] };

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-summary-smoke-'));
  let context, panel, page, worker;
  const errors = [];
  const requests = [];
  try {
    context = await chromium.launchPersistentContext(userData, {
      channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
      args: [`--disable-extensions-except=${smoke.extensionDirectory}`, `--load-extension=${smoke.extensionDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1440,1050']
    });
    context.on('request', request => requests.push(request.url()));
    await context.route('**/*', route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && url.pathname === '/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: smoke.fixture(url.searchParams.get('next')) });
      }
      const screen = Object.keys(preApplicant.screens).find(name => url.pathname === `/apspssp/ssp.portal${preApplicant.screens[name].path}`);
      if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && screen) return route.fulfill({ status: 200, contentType: 'text/html', body: smoke.preApplicantPage(screen) });
      if (request.isNavigationRequest() && request.url() === PANTRY_URL) {
        return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic pantry sign-up · test only</title></head><body>${pantry.pantryInstructions}</body></html>` });
      }
      if (url.protocol === 'chrome-extension:') return route.continue();
      return route.abort('blockedbyclient');
    });
    [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).hostname;
    await smoke.installNativeStub(worker);
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const launcherUrl = `chrome-extension://${extensionId}/panel.html?surface=launcher`;
    const launcherFrame = async () => {
      await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 15000 }).toBe(true);
      return page.frames().find(frame => frame.url() === launcherUrl);
    };
    async function resetTo(url) {
      await page.goto('about:blank');
      await worker.evaluate(profile => { globalThis.__nativeSmoke = { locked: false, accessRevision: 0, calls: [], profile }; }, smoke.syntheticProfile);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
    }
    // The worker's reply to the side panel's page-text request, for the tab on screen.
    const pageText = () => panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.runtime.sendMessage({ type: 'ui:pageText', tabId: tab.id });
    });
    const textsOf = reply => reply.data.pages.map(item => [item.pageKey, item.text, item.current, item.unread]);

    // Iowa's Important Information screen: the side panel opens from the widget, and Chrome here has no summary model.
    await resetTo(screenUrl('importantInfo'));
    let widget = await launcherFrame();
    await expect(widget.locator('#details')).toBeVisible({ timeout: 20000 });
    await widget.locator('#details').click();
    panel = await smoke.attachNativePanel(context, page, extensionId);
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofillIowa'));
    const chrome = await panel.evaluate(async options => typeof Summarizer === 'undefined' ? 'missing' : Summarizer.availability(options), OPTIONS);
    // A Chrome that can't summarize is not the applicant's concern: nothing is said. One that can download its model offers to.
    const note = { missing: '', unavailable: '', downloadable: en('summary.needsDownload'), downloading: en('summary.needsDownload') }[chrome];
    assert.notEqual(note, undefined, `Chrome’s Summarizer here is ${chrome}; this smoke covers a Chrome without a ready model`);
    // Long enough for the panel to have asked Chrome and settled.
    await page.waitForTimeout(2000);
    await expect.poll(() => panel.text('#summary-note'), { timeout: 15000 }).toBe(note);
    assert.equal(await panel.visible('#summary-note'), Boolean(note));
    assert.equal(await panel.visible('#summary'), false, 'the section is hidden');
    assert.equal(await panel.visible('#summary-get'), Boolean(note), 'a download is offered only when Chrome can get the model');
    console.log(`Side panel: Chrome’s Summarizer here is ${chrome}, so the section is hidden ${note ? `with one line: ${note}` : 'and nothing is said'}`);

    // The content script and worker read the screen's own words, and nothing else.
    const important = await pageText();
    assert.equal(important.ok, true, important.error);
    assert.deepEqual(textsOf(important), [['iowa-information', IMPORTANT, true, false]]);
    console.log('Page reader: Iowa’s Important Information screen reads as its own words, without Iowa’s buttons.');

    // One click walks the screens: each information screen is read before Continue, and kept for the tab.
    await resetTo(screenUrl('beforeYouStart'));
    widget = await launcherFrame();
    // In headless Chromium the open side panel covers the card's corner, so Autofill is pressed in the side panel (the same request to the worker).
    await expect.poll(() => panel.evaluate(() => !document.getElementById('panel-autofill').disabled), { timeout: 15000 }).toBe(true);
    await panel.click('#panel-autofill');
    await expect.poll(() => page.url(), { timeout: 20000 }).toBe(screenUrl('letsGetStarted'));
    await page.locator('#termChkbox').check();
    await page.locator('button.saveButton').click();
    await expect.poll(() => page.url(), { timeout: 20000 }).toBe(`${smoke.applicant}?next=stay`);
    await expect(page.locator('#lastName')).toHaveValue(smoke.syntheticProfile.lastName, { timeout: 20000 });
    await expect.poll(async () => textsOf(await pageText()), { timeout: 15000 }).toEqual([
      ['iowa-instructions', INSTRUCTIONS, false, false], ['iowa-information', IMPORTANT, false, false], ['iowa-before-start', BEFORE_START, false, false]]);
    const applicantReply = JSON.stringify(await pageText());
    for (const value of [smoke.syntheticProfile.firstName, smoke.syntheticProfile.lastName, smoke.syntheticProfile.addressLine1, smoke.syntheticProfile.homePhone]) {
      assert.equal(applicantReply.includes(value), false, `A filled answer is never page text: ${value}`);
    }
    await expect.poll(() => panel.text('#summary-note'), { timeout: 15000 }).toBe(note);
    assert.equal(await panel.visible('#summary'), false);
    console.log('Autofill: Before You Start, Important Information, and Instructions were each read before Continue and kept; the filled applicant page was never read.');

    // Leaving Iowa forgets them.
    await page.goto(PANTRY_URL, { waitUntil: 'domcontentloaded' });
    await page.goto(screenUrl('importantInfo'), { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => textsOf(await pageText()), { timeout: 15000 }).toEqual([['iowa-information', IMPORTANT, true, false]]);
    console.log('Leaving Iowa: the kept screens are forgotten; only the screen on view is read.');

    // A pantry form with long instructions, read by the same page reader in real Chromium layout, with typed answers in its fields.
    await page.goto(PANTRY_URL, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ path: path.join(smoke.extensionDirectory, 'page-text.js') });
    await page.fill('#p-name', 'Synthetic Private Name');
    await page.fill('#p-zip', '50309');
    await page.fill('#p-size', '4');
    await page.fill('#p-notes', 'Synthetic private note');
    await page.selectOption('#p-county', 'Story');
    await page.check('input[value="fri"]');
    const pantryText = await page.evaluate(() => SecondHandPageText.read(document));
    assert.ok(pantryText.startsWith('Food pantry sign-up\nBefore you visit\nBring a photo ID for the adult picking up food.'), pantryText);
    assert.ok(pantryText.includes('Pickup is on Tuesdays and Fridays from 3 to 6 p.m.'));
    for (const value of ['Synthetic Private', '50309', 'Synthetic private note', 'Choose one', 'Sign up', 'Donate', 'Privacy', 'Staff note', 'Hidden promotion', 'pantryReady']) {
      assert.equal(pantryText.includes(value), false, `Never page text: ${value}`);
    }
    assert.deepEqual(pantryText.split('\n').filter(line => ['4', 'Story', 'Tuesday', 'Friday'].includes(line)), [], 'answers and choices are not page text');
    console.log(`Page reader: the pantry form reads as ${pantryText.split('\n').length} lines of instructions and question labels, with no typed or chosen answer.`);

    // Nothing left the computer: every request was SecondHand's own page or a local fixture, and the extension's pages fetched only their own files.
    const outside = requests.filter(url => !url.startsWith(`chrome-extension://${extensionId}/`) && !url.startsWith('https://hhsservices.iowa.gov/') && !url.startsWith(PANTRY_URL) && url !== 'about:blank');
    assert.deepEqual(outside, []);
    const panelFetches = await panel.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    assert.deepEqual(panelFetches.filter(url => !url.startsWith(`chrome-extension://${extensionId}/`)), [], 'the side panel fetched nothing from the network');
    assert.deepEqual(await worker.evaluate(() => globalThis.__nativeSmoke.calls.filter(call => call.type === 'getFields').length), 1, 'reading pages asks the desktop for nothing');
    assert.deepEqual(errors, []);
    console.log(`Network: ${requests.length} requests, all to the extension or local fixtures. All data was synthetic; native desktop replies were DevTools stubs.`);
  } catch (error) {
    if (panel) console.error('Synthetic side panel state:', await panel.evaluate(() => document.body.innerText).catch(failure => `unreadable: ${failure.message}`));
    throw error;
  } finally {
    if (panel) await panel.close();
    if (context) await context.close();
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
