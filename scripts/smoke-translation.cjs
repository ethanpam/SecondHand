'use strict';

// Real Chromium set up for a Spanish reader: --lang=es-ES, and Spanish as Chrome's preferred language
// (the setting navigator.language reflects on every OS; macOS ignores --lang). SecondHand's widget and side panel speak
// Spanish, the language choice survives a reload, the widget offers the translated question list
// on an English page, and the list shows every question and finds each one in the form. Headless
// Chromium cannot get a translation model, so the list keeps the page's own words and says why in
// one line. Fixtures are synthetic, DNS is disabled, every request is recorded to show that nothing
// leaves the computer, and native desktop replies are DevTools stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const smoke = require('./smoke-extension.cjs');
const strings = require('../extension/strings.js');

const es = (key, params) => strings.text('es', key, params);
const { en: EN, es: ES } = strings.catalogs;
const englishOnly = Object.keys(EN).filter(key => typeof EN[key] === 'string' && EN[key] !== ES[key]).map(key => EN[key]);
const instructionsUrl = `${smoke.portal}/applyForBenefits/instructions`;
const instructions = ['Instructions', 'You\'ll see some questions with a star next to them.', 'Check this box next to the item you want to select.',
  'Check this button next to the item you want to select.', 'OK. Let\'s start the application.'];
// The side panel reports a translator download with no progress after 20 seconds.
const STALL_WAIT_MS = 35000;

// Every word of SecondHand's shown in a surface: visible text, tooltips, and screen-reader labels.
// The page's own words kept under a translation in the question list are the page's, not SecondHand's.
function shownWords() {
  const found = [document.title];
  for (const element of document.body.querySelectorAll('*')) {
    if (element.closest('[hidden]') || element.closest('#questions-list .checklist-detail')) continue;
    for (const node of element.childNodes) if (node.nodeType === 3 && node.textContent.trim()) found.push(node.textContent.trim());
    for (const name of ['title', 'aria-label']) if (element.getAttribute(name)) found.push(element.getAttribute(name));
  }
  return found;
}

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-translation-smoke-'));
  // Chrome settings > Languages > Spanish first, as a Spanish reader's Chrome has it.
  await fs.mkdir(path.join(userData, 'Default'), { recursive: true });
  await fs.writeFile(path.join(userData, 'Default', 'Preferences'), JSON.stringify({ intl: { accept_languages: 'es-ES,es' } }));
  let context, panel, page, worker;
  const errors = [];
  const requests = [];
  try {
    context = await chromium.launchPersistentContext(userData, {
      channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
      args: [`--disable-extensions-except=${smoke.extensionDirectory}`, `--load-extension=${smoke.extensionDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1440,1050', '--lang=es-ES']
    });
    context.on('request', request => requests.push(request.url()));
    await context.route('**/*', route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && url.pathname === '/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: smoke.fixture(url.searchParams.get('next')) });
      }
      if (request.isNavigationRequest() && request.url() === instructionsUrl) return route.fulfill({ status: 200, contentType: 'text/html', body: smoke.preApplicantPage('instructions') });
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
    const calls = type => worker.evaluate(type => globalThis.__nativeSmoke.calls.filter(call => call.type === type), type);
    async function resetTo(url) {
      await page.goto('about:blank');
      await worker.evaluate(profile => { globalThis.__nativeSmoke = { locked: false, accessRevision: 0, calls: [], profile }; }, smoke.syntheticProfile);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
    }
    const answers = () => page.evaluate(() => Array.from(document.querySelectorAll('input:not([type=hidden]), select'), element => ['checkbox', 'radio'].includes(element.type) ? element.checked : element.value));
    const rows = () => panel.evaluate(() => [...document.querySelectorAll('#questions-list > *')].map(row => row.querySelector('.checklist-label').textContent));

    // The widget speaks the browser's language and offers the Spanish question list on an English page.
    assert.equal(await worker.evaluate(() => navigator.language), 'es-ES', 'Chrome itself is set to Spanish');
    await resetTo(`${smoke.applicant}?next=stay`);
    let widget = await launcherFrame();
    await expect(widget.locator('#autofill')).toHaveText(es('widget.autofill'), { timeout: 20000 });
    await expect(widget.locator('#widget-text')).toHaveText(es('widget.iowaReady'));
    await expect(widget.locator('#details')).toHaveAttribute('aria-label', es('widget.detailsTitle'));
    await expect(widget.locator('#translate-offer')).toBeVisible({ timeout: 20000 });
    await expect(widget.locator('#translate-offer')).toHaveText(es('widget.offer'));
    assert.deepEqual((await widget.evaluate(shownWords)).filter(text => englishOnly.includes(text)), []);
    console.log('Widget: Spanish throughout, with the Spanish question-list offer on an English page.');

    // Autofill in Spanish on the Iowa fixture: one fill, one verified Next, and the result in Spanish.
    await widget.locator('#autofill').click();
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
    assert.equal(await page.inputValue('#lastName'), smoke.syntheticProfile.lastName);
    await expect(widget.locator('#widget-text')).toHaveText(`${es('worker.selectedSaveContinue')} ${es('widget.stopNote')}`, { timeout: 20000 });
    console.log(`Widget: Autofill fills the fixture and reports in Spanish: ${es('worker.selectedSaveContinue')}`);

    // The offer opens the side panel straight on the page's questions: every one, in Spanish.
    await resetTo(`${smoke.applicant}?next=stay`);
    widget = await launcherFrame();
    await expect(widget.locator('#translate-offer')).toBeVisible({ timeout: 20000 });
    await widget.locator('#translate-offer').click();
    panel = await smoke.attachNativePanel(context, page, extensionId);
    await expect.poll(() => panel.visible('#questions'), { timeout: 15000 }).toBe(true);
    const checklist = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return (await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id })).data.page.checklist;
    });
    const expected = checklist.map(item => es(item.labelKey, item.labelParams));
    assert.ok(expected.length > 5 && expected.includes(es('iowa.firstName')), JSON.stringify(expected));
    await expect.poll(rows, { timeout: 15000 }).toEqual(expected);
    assert.equal(await panel.text('#questions-summary'), es('questions.count', { count: expected.length }));
    // Under each Spanish question is the English it stands for, to match it with Iowa's English form.
    const originals = await panel.evaluate(() => [...document.querySelectorAll('#questions-list > *')].map(row => row.querySelector('.checklist-detail').textContent));
    assert.deepEqual(originals, checklist.map(item => item.label));
    console.log(`Side panel: the offer opened the list of all ${expected.length} questions, in Spanish.`);

    // A row scrolls the form to its question through the existing focus route. Nothing is written.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await panel.click(`#questions-list > :nth-child(${expected.indexOf(es('iowa.firstName')) + 1})`);
    await expect.poll(() => page.evaluate(() => document.activeElement.id)).toBe('firstName');
    assert.ok(await page.evaluate(() => { const box = document.getElementById('firstName').getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), 'the question is on screen');
    assert.ok((await answers()).every(value => value === '' || value === false), 'nothing was written into the form');
    assert.deepEqual(await calls('getFields'), [], 'the question list never reaches the desktop');
    console.log('Side panel: a row scrolls to its question; the form stays empty.');

    // The side panel shows none of SecondHand's English.
    await expect.poll(() => panel.text('#panel-autofill')).toBe(es('panel.autofillIowa'));
    await expect.poll(() => panel.text('#iowa-policy')).toBe(es('panel.iowaPolicyAgain'));
    assert.equal(await panel.text('#status'), '', 'ready to fill, there is nothing more to say');
    assert.equal(await panel.evaluate(() => document.documentElement.lang), 'es');
    assert.equal(await panel.evaluate(() => document.getElementById('language').value), 'es');
    assert.deepEqual((await panel.evaluate(shownWords)).filter(text => englishOnly.includes(text)), []);
    console.log('Side panel: Spanish throughout.');

    // Iowa's instructions screen is the page's own words. Headless Chromium has no translation model,
    // so the list keeps the English and the panel says why in one line.
    await resetTo(instructionsUrl);
    widget = await launcherFrame();
    await expect(widget.locator('#translate-offer')).toBeVisible({ timeout: 20000 });
    await expect(widget.locator('#widget-text')).not.toHaveText(es('widget.languageCheckFailed'));
    const chrome = await panel.evaluate(async () => typeof Translator === 'undefined' ? 'missing' : Translator.availability({ sourceLanguage: 'en', targetLanguage: 'es' }));
    if (chrome === 'missing') {
      await expect.poll(() => panel.text('#questions-note'), { timeout: 15000 }).toBe(es('translate.missing'));
      assert.equal(await panel.visible('#questions-show'), false);
    } else {
      await expect.poll(() => panel.visible('#questions-show'), { timeout: 15000 }).toBe(true);
      await panel.click('#questions-show');
      await expect.poll(rows, { timeout: 15000 }).toEqual(instructions);
      const line = chrome === 'unavailable' ? es('translate.unavailable', { source: 'inglés', target: 'español' }) : es('translate.stalled', { language: 'español', source: 'inglés' });
      await expect.poll(() => panel.text('#questions-note'), { timeout: STALL_WAIT_MS }).toBe(line);
    }
    assert.equal(await panel.visible('#questions-note'), true);
    console.log(`Side panel: Chrome's translator here is ${chrome}, so the list keeps the page's words and shows one line: ${await panel.text('#questions-note')}`);

    // The picker: English wins over the Spanish browser, survives reloading the panel and the page, and the widget follows.
    const choose = value => panel.evaluate(value => { const select = document.getElementById('language'); select.value = value; select.dispatchEvent(new Event('change')); }, value);
    await choose('en');
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await expect(widget.locator('#autofill')).toHaveText('Autofill', { timeout: 10000 });
    await panel.evaluate(() => { window.__beforeReload = true; setTimeout(() => location.reload(), 0); });
    // While the panel reloads, its old page is gone: that read fails and the poll tries again.
    await expect.poll(() => panel.evaluate(() => !window.__beforeReload && document.readyState === 'complete').catch(() => false), { timeout: 15000 }).toBe(true);
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe('Start Autofill');
    assert.equal(await panel.evaluate(() => document.getElementById('language').value), 'en');
    await page.reload({ waitUntil: 'domcontentloaded' });
    widget = await launcherFrame();
    await expect(widget.locator('#autofill')).toHaveText('Autofill', { timeout: 20000 });
    await choose('es');
    await expect.poll(() => panel.text('#panel-autofill')).toBe(es('panel.autofillIowa'));
    await expect(widget.locator('#autofill')).toHaveText(es('widget.autofill'), { timeout: 10000 });
    console.log('Picker: English persists over the Spanish browser across reloads of the panel and the page; both surfaces follow.');

    // Arabic turns the panel right to left; Vietnamese turns it back. The widget follows each choice.
    for (const [code, dir] of [['ar', 'rtl'], ['vi', 'ltr']]) {
      await choose(code);
      await expect.poll(() => panel.text('#panel-autofill')).toBe(strings.text(code, 'panel.autofillIowa'));
      await expect(widget.locator('#autofill')).toHaveText(strings.text(code, 'widget.autofill'), { timeout: 10000 });
      assert.deepEqual(await panel.evaluate(() => [document.documentElement.lang, document.documentElement.dir]), [code, dir]);
      assert.equal(await widget.evaluate(() => document.documentElement.dir), dir);
    }
    console.log('Picker: Arabic lays both surfaces out right to left; Vietnamese lays them out left to right.');

    // Nothing left the computer: every request was SecondHand's own page or a local fixture.
    const outside = requests.filter(url => !url.startsWith(`chrome-extension://${extensionId}/`) && !url.startsWith('https://hhsservices.iowa.gov/') && url !== 'about:blank');
    assert.deepEqual(outside, []);
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
