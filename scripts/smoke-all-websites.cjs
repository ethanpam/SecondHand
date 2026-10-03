'use strict';

// Real Chromium smoke for SecondHand on all websites. Chrome can't show its permission prompt to a test,
// so a first launch of a temporary copy of the extension lists https://*/* (and one synthetic site turned
// on by itself) as required host permissions, which Chrome grants at load. The second launch, on the same
// profile, uses the shipped manifest unchanged: https://*/* is optional there and already granted, so the
// side panel's own chrome.permissions.request in the click resolves without a prompt. Everything else is
// SecondHand's own path. Native desktop replies are DevTools stubs; fixtures and profile data are
// synthetic, DNS is disabled, and nothing is ever submitted.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const strings = require('../extension/strings.js');
const { attachNativePanel, fixture, applicant, syntheticProfile } = require('./smoke-extension.cjs');

const root = path.join(__dirname, '..');
const PANTRY = 'https://pantry.example.org/intake';
const WIC = 'https://wic.example.org/apply';
const SEARCH = 'https://search.example.org/';
const IOWA_HOST = 'https://hhsservices.iowa.gov/*';
const en = (key, params) => strings.text('en', key, params);

function formPage(title, form) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · synthetic test only</title>
    <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:30px}main{max-width:640px}label{display:block;margin:12px 0 4px}input{display:block;width:300px;height:32px}</style></head>
    <body><main><p>SYNTHETIC FIXTURE. No real organization or applicant data.</p><h1>${title}</h1>${form}</main>
    <script>window.__submits = 0; document.querySelector('form')?.addEventListener('submit', event => { event.preventDefault(); window.__submits++; });</script></body></html>`;
}
const pages = {
  [PANTRY]: formPage('Pantry sign-up', '<form><label for="fname">First name</label><input id="fname" name="fname"><label for="lname">Last name</label><input id="lname" name="lname">' +
    '<label for="zip">ZIP code</label><input id="zip" name="zip"><label for="email">Email</label><input id="email" name="email" type="email">' +
    '<label for="hh">Household size</label><input id="hh" name="hh" type="number"><button type="submit">Submit</button></form>'),
  [WIC]: formPage('WIC pre-screening', '<form><label for="name">Full name</label><input id="name" name="name"><button type="submit">Submit</button></form>'),
  [SEARCH]: formPage('Find a pantry', '<form role="search"><input type="search" name="q" aria-label="Search"><button>Search</button></form>')
};

// The desktop app as the worker sees it over native messaging, with Always allow on. It keeps its own
// all-websites setting, as the real app does, and reports it in status.
async function installDesktop(worker, profile) {
  await worker.evaluate(profile => {
    globalThis.__desktop = { allSites: false, calls: [], profile };
    nativeRequest = async (type, payload = {}) => {
      const desktop = globalThis.__desktop;
      desktop.calls.push({ type, url: payload.url || '', fields: payload.fields || [] });
      if (type === 'status') return { unlocked: true, applicationCount: 0, accessRevision: 0, allSites: desktop.allSites, laya: { state: 'unavailable' } };
      if (type === 'trustAllSites') { desktop.allSites = true; return { allSites: true }; }
      if (type === 'untrustAllSites') { desktop.allSites = false; return { allSites: false }; }
      if (type === 'trustSite') return { trusted: true, origin: new URL(payload.url).origin };
      if (type === 'showApp') return { shown: true };
      if (type === 'warmLaya') return { state: 'unavailable' };
      if (type === 'suggestFields' || type === 'answerFields') throw Object.assign(new Error('Laya isn’t ready on this computer.'), { code: 'LAYA_NOT_READY' });
      if (type === 'getFields') return { accessRevision: 0, values: Object.fromEntries(payload.fields.filter(field => desktop.profile[field]).map(field => [field, desktop.profile[field]])) };
      if (type === 'recordProgress') return { recorded: true };
      throw new Error(`Unexpected native request in the all-websites smoke: ${type}`);
    };
  }, profile);
}

async function launch(userData, extensionDirectory, requests) {
  const context = await chromium.launchPersistentContext(userData, {
    channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1440,1050']
  });
  context.on('request', request => requests?.push(request.url()));
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.isNavigationRequest() && Object.hasOwn(pages, request.url())) return route.fulfill({ status: 200, contentType: 'text/html', body: pages[request.url()] });
    if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && url.pathname === '/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: fixture(url.searchParams.get('next')) });
    }
    if (url.protocol === 'chrome-extension:') return route.continue();
    return route.abort('blockedbyclient');
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  assert.equal(new URL(worker.url()).hostname, 'jogldddafjfbmfjnjlbjloakjbecnjpl');
  return { context, worker };
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-all-websites-smoke-'));
  const extensionDirectory = path.join(temporary, 'extension');
  const userData = path.join(temporary, 'profile');
  await fs.cp(path.join(root, 'extension'), extensionDirectory, { recursive: true });
  const manifestPath = path.join(extensionDirectory, 'manifest.json');
  const shipped = await fs.readFile(manifestPath, 'utf8');
  const granting = JSON.parse(shipped);
  granting.host_permissions = [...granting.host_permissions, 'https://*/*', `${new URL(WIC).origin}/*`];
  await fs.mkdir(path.join(root, 'artifacts/all-websites'), { recursive: true });
  let context, panel, page;
  const errors = [];
  const requests = [];
  try {
    // First launch: Chrome grants the test copy's extra host permissions at load.
    await fs.writeFile(manifestPath, JSON.stringify(granting));
    ({ context } = await launch(userData, extensionDirectory));
    await context.close();
    context = null;
    // Second launch: the shipped manifest.
    await fs.writeFile(manifestPath, shipped);
    let worker;
    ({ context, worker } = await launch(userData, extensionDirectory, requests));
    await installDesktop(worker, syntheticProfile);
    assert.equal(await worker.evaluate(() => allSitesOn()), false, 'all websites starts off');
    const calls = type => worker.evaluate(type => globalThis.__desktop.calls.filter(call => call.type === type), type);
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const extensionId = new URL(worker.url()).hostname;
    const launcherUrl = `chrome-extension://${extensionId}/panel.html?surface=launcher`;
    const launcherFrame = async () => {
      await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 15000 }).toBe(true);
      return page.frames().find(frame => frame.url() === launcherUrl);
    };
    const cards = () => page.locator('[data-secondhand-assistant]').count();

    // A site that was never turned on gets nothing yet.
    await page.goto(PANTRY, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    assert.equal(await cards(), 0, 'no card on a site that is off');

    // Another site turned on by itself, the existing way (the desktop's trust is the stub).
    await page.goto(WIC, { waitUntil: 'domcontentloaded' });
    assert.deepEqual(await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return enableSite(tab.id); }),
      { enabled: true, origin: new URL(WIC).origin });
    console.log('Per-site: wic.example.org is turned on by itself.');

    // Open the side panel from Iowa's widget, then turn on all websites with a trusted click.
    await page.goto(`${applicant}?next=stay`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await (await launcherFrame()).locator('#details').click();
    panel = await attachNativePanel(context, page, extensionId);
    await expect.poll(() => panel.visible('#all-sites-enable'), { timeout: 15000 }).toBe(true);
    assert.equal(await panel.text('#all-sites-enable'), en('panel.allSitesEnable'));
    await panel.click('#all-sites-enable');
    await expect.poll(() => panel.visible('#all-sites-disable'), { timeout: 15000 }).toBe(true);
    assert.equal(await worker.evaluate(() => allSitesOn()), true);
    assert.deepEqual((await calls('trustAllSites')).length, 1);
    const registered = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts({ ids: ['site-all'] }));
    assert.deepEqual(registered.map(script => [script.matches, script.excludeMatches, script.allFrames]), [[['https://*/*'], [IOWA_HOST], true]]);
    console.log('All websites: on, after the side panel’s click and the app’s approval (stub).');

    // A synthetic form on an origin that was never turned on: the card shows, and Autofill fills from the fictional profile.
    await page.goto(PANTRY, { waitUntil: 'domcontentloaded' });
    const widget = await launcherFrame();
    await expect(widget.locator('#widget-text')).toHaveText(en('widget.siteReady', { host: 'pantry.example.org' }), { timeout: 20000 });
    // In headless Chromium the open side panel covers the card's corner, so Autofill is clicked there.
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofill'));
    await panel.click('#panel-autofill');
    await expect(page.locator('#fname')).toHaveValue(syntheticProfile.firstName, { timeout: 20000 });
    await expect(page.locator('#lname')).toHaveValue(syntheticProfile.lastName);
    await expect(page.locator('#zip')).toHaveValue(syntheticProfile.zip);
    await expect(page.locator('#email')).toHaveValue(syntheticProfile.email);
    await expect(page.locator('#hh')).toHaveValue(syntheticProfile.householdSize);
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => window.__submits), 0, 'nothing is submitted');
    assert.equal(page.url(), PANTRY, 'nothing navigates');
    assert.deepEqual((await calls('getFields')).map(call => ({ url: call.url, fields: call.fields })),
      [{ url: PANTRY, fields: ['firstName', 'lastName', 'zip', 'email', 'householdSize'] }], 'one desktop request for this page');
    await page.screenshot({ path: path.join(root, 'artifacts/all-websites/all-websites-filled.png') });
    console.log('All websites: a form on a site never turned on filled from the fictional profile with one click; nothing was submitted.');

    // A page whose only input is a search box gets no card.
    await page.goto(SEARCH, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    assert.equal(await cards(), 0, 'no card on a search-only page');
    console.log('All websites: no card on a search-only page.');

    // Turn it off from the side panel: the card leaves the open page at once and doesn't come back.
    await page.goto(PANTRY, { waitUntil: 'domcontentloaded' });
    await launcherFrame();
    assert.equal(await cards(), 1);
    await panel.click('#all-sites-disable');
    await expect.poll(() => panel.visible('#all-sites-enable'), { timeout: 15000 }).toBe(true);
    await expect.poll(cards, { timeout: 10000 }).toBe(0);
    assert.equal(await worker.evaluate(() => allSitesOn()), false);
    assert.deepEqual((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).map(script => script.id), ['site-wic.example.org'],
      'the site turned on by itself keeps its registration');
    assert.equal(await worker.evaluate(() => chrome.permissions.contains({ origins: ['https://*/*'] })), false);
    assert.equal((await calls('untrustAllSites')).length, 1);
    // What Chrome took back with https://*/* is named, as Chrome did it.
    const wicKept = await worker.evaluate(origin => chrome.permissions.contains({ origins: [`${origin}/*`] }), new URL(WIC).origin);
    const iowaKept = await worker.evaluate(host => chrome.permissions.contains({ origins: [host] }), IOWA_HOST);
    const shown = await panel.text('#status');
    assert.ok(shown.startsWith(en('worker.allSitesOff')), shown);
    assert.equal(shown.includes('wic.example.org'), !wicKept, shown);
    assert.equal(shown.includes(en('worker.chromePausedIowa')), !iowaKept, shown);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    assert.equal(await cards(), 0, 'the card stays gone after a reload');
    await panel.screenshot(path.join(root, 'artifacts/all-websites/all-websites-off-panel.png'));
    console.log(`All websites: off. The card left the open page. Chrome ${wicKept ? 'kept' : 'took back'} wic.example.org and ${iowaKept ? 'kept' : 'paused'} Iowa’s site; the side panel says: "${shown}"`);

    const synthetic = new Set([...Object.keys(pages).map(url => new URL(url).origin), 'https://hhsservices.iowa.gov']);
    // The extension's own files, and inline data: URLs, load nothing from anywhere.
    const own = url => url.startsWith(`chrome-extension://${extensionId}/`) || url.startsWith('data:');
    assert.deepEqual(requests.filter(url => !own(url) && !synthetic.has(new URL(url).origin)), [], 'only synthetic pages and the extension were asked for');
    assert.deepEqual(errors, []);
    console.log('All browser fixtures and data were synthetic; native desktop replies were DevTools stubs.');
  } catch (error) {
    if (panel) console.error('Synthetic side panel state:', await panel.evaluate(() => document.body.innerText).catch(() => 'unavailable'));
    if (page) await page.screenshot({ path: path.join(root, 'artifacts/all-websites/all-websites-smoke-failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (panel) await panel.close();
    if (context) await context.close().catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
