'use strict';

// Real Chromium smoke for SecondHand on all websites. Chrome can't show its permission prompt to a test,
// so a first launch of a temporary copy of the extension lists https://*/* (and one synthetic site turned
// on by itself) as required host permissions, which Chrome grants at load. The second launch, on the same
// profile, uses the shipped manifest unchanged: https://*/* is optional there and already granted, so the
// side panel's own chrome.permissions.request in the click resolves without a prompt, as it does for a
// person who granted it before. Everything else is SecondHand's own path. Native desktop replies are DevTools stubs; fixtures and profile data are
// synthetic, DNS is disabled, and nothing is ever submitted.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect: playwrightExpect } = require('@playwright/test');
// Every wait counts wall-clock time, which runs on while the computer sleeps (see host-sleep.cjs).
const expect = require('./host-sleep.cjs').sleepTolerant(playwrightExpect);
const strings = require('../extension/strings.js');
const { attachNativePanel, fixture, applicant, syntheticProfile } = require('./smoke-extension.cjs');
const { validateProfile, releasedValue } = require('../shared/schema.cjs');

const root = path.join(__dirname, '..');
const PANTRY = 'https://pantry.example.org/intake';
const WIC = 'https://wic.example.org/apply';
const SEARCH = 'https://search.example.org/';
const FORMS = 'https://forms.example.net/embed';
const EMBEDDING = 'https://pantry.example.org/sign-up';
const NEVER = 'https://never.example.net/apply';
// #98: the household questions the live QA (#89) found on a pantry form, plus one the fictional profile has no answer for.
const HOUSEHOLD = 'https://pantry.example.org/household';
const HOUSEHOLD_QUESTIONS = { young: '# of people in your household 0 - 17 yrs old', middle: '# of people in your household 18 - 59 yrs old', older: '# of people in your household 60 + yrs',
  student: 'Student name and grade. Order will be assigned to(first and Last)', guardian: 'Guardian first and last name', apt: 'Apartment number' };
// What the desktop works out from the fictional household list, as the app does: band counts and the one student's name and grade.
const listed = validateProfile(syntheticProfile);
const desktopProfile = { ...syntheticProfile, ...Object.fromEntries(['householdCount:18-59', 'householdCount:60+', 'studentNameGrade'].map(key => [key, releasedValue(listed, key)])) };
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
  [WIC]: formPage('WIC pre-screening', '<form><label for="name">Full name</label><input id="name" name="name"><button type="submit">Submit</button></form>' +
    `<iframe src="${FORMS}" title="Embedded sign-up" style="width:420px;height:180px;border:1px solid #ced7c5"></iframe>`),
  [EMBEDDING]: formPage('Sign up below', `<iframe src="${FORMS}" title="Embedded sign-up" style="width:420px;height:180px;border:1px solid #ced7c5"></iframe>`),
  // Money on hand is one of the details the app asks about on every site but Iowa's (SENSITIVE_FIELDS in desktop/main.cjs).
  // The fictional profile has no apartment, so Save to My information offers it.
  [FORMS]: formPage('Embedded sign-up', '<form><label for="city">City</label><input id="city" name="city"><label for="cash">Money on hand</label><input id="cash" name="cash">' +
    '<label for="apt">Apartment number</label><input id="apt" name="apt"><button type="submit">Submit</button></form>'),
  [SEARCH]: formPage('Find a pantry', '<form role="search"><input type="search" name="q" aria-label="Search"><button>Search</button></form>'),
  [NEVER]: formPage('Never trusted', '<form><label for="first">First name</label><input id="first" name="first"><button type="submit">Submit</button></form>'),
  [HOUSEHOLD]: formPage('Pantry order: household', `<form>${Object.entries(HOUSEHOLD_QUESTIONS).map(([id, label]) => `<label for="${id}">${label}</label><input id="${id}" name="${id}">`).join('')}` +
    '<button type="submit">Submit</button></form>')
};

// The desktop app as the worker sees it over native messaging, with Always allow on. It keeps its own
// all-websites setting, as the real app does, and reports it in status. Asked for money on hand, or to save
// an answer, it shows the prompt the app shows, naming the site the request names.
async function installDesktop(worker, profile) {
  await worker.evaluate(profile => {
    globalThis.__desktop = { allSites: false, calls: [], saves: [], prompts: [], profile };
    nativeRequest = async (type, payload = {}) => {
      const desktop = globalThis.__desktop;
      desktop.calls.push({ type, url: payload.url || '', fields: payload.fields || [] });
      if (type === 'status') return { unlocked: true, applicationCount: 0, accessRevision: 0, allSites: desktop.allSites, laya: { state: 'unavailable' } };
      if (type === 'trustAllSites') { desktop.allSites = true; return { allSites: true }; }
      if (type === 'untrustAllSites') { desktop.allSites = false; return { allSites: false }; }
      if (type === 'trustSite') return { trusted: true, origin: new URL(payload.url).origin };
      if (type === 'untrustSite') return { trusted: false, origin: new URL(payload.url).origin };
      if (type === 'showApp') return { shown: true };
      if (type === 'warmLaya') return { state: 'unavailable' };
      if (type === 'suggestFields' || type === 'answerFields') throw Object.assign(new Error('Laya isn’t ready on this computer.'), { code: 'LAYA_NOT_READY' });
      if (type === 'getFields' && payload.fields.includes('assetsOnHand')) desktop.prompts.push(`Fill sensitive details on ${new URL(payload.url).origin}?`);
      if (type === 'getFields') return { accessRevision: 0, values: Object.fromEntries(payload.fields.filter(field => desktop.profile[field]).map(field => [field, desktop.profile[field]])) };
      if (type === 'recordProgress') return { recorded: true };
      // Save to My information (#98): the app's confirmation and save, as Allow.
      if (type === 'saveFields') {
        desktop.prompts.push(`Save ${Object.keys(payload.fields).length === 1 ? 'this answer' : 'these answers'} from ${new URL(payload.url).origin} to My information?`);
        desktop.saves.push({ url: payload.url, fields: payload.fields });
        return { saved: Object.keys(payload.fields) };
      }
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
    await installDesktop(worker, desktopProfile);
    assert.equal(await worker.evaluate(() => allSitesOn()), false, 'all websites starts off');
    const calls = type => worker.evaluate(type => globalThis.__desktop.calls.filter(call => call.type === type), type);
    // The worker's own record, so a check that nothing came waits on events and state, not on the clock (#143): the
    // tab loads Chrome reported complete (a page's content scripts have run by then), the pages whose content script
    // reported whether they have a form, and whether the worker is busy (a click, a site fill, an autopilot step).
    await worker.evaluate(() => {
      globalThis.__smokeProbe = { complete: 0, reports: [] };
      chrome.tabs.onUpdated.addListener((_tabId, change) => { if (change.status === 'complete') globalThis.__smokeProbe.complete++; });
      chrome.runtime.onMessage.addListener((message, sender) => { if (message?.type === 'secondhand:generic:form') globalThis.__smokeProbe.reports.push(sender.url); });
    });
    const probe = () => worker.evaluate(() => ({ complete: globalThis.__smokeProbe.complete, reports: [...globalThis.__smokeProbe.reports],
      busy: Boolean(clicksUnderway || siteRuns.size || [...autopilots.values()].some(pilot => pilot.running)) }));
    // Waits until the worker is busy with nothing and, given its record from before a navigation, Chrome has finished
    // loading the page and, for a page SecondHand is on (`reportFrom`), its content script has reported.
    async function settled(since, { reportFrom } = {}) {
      await expect.poll(async () => {
        const now = await probe();
        return !now.busy && (!since || now.complete > since.complete) && (!reportFrom || now.reports.slice(since.reports.length).includes(reportFrom));
      }, { timeout: 20000 }).toBe(true);
    }
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
    let since = await probe();
    await page.goto(PANTRY, { waitUntil: 'domcontentloaded' });
    await settled(since);
    assert.equal(await cards(), 0, 'no card on a site that is off');

    // Another site turned on by itself, the existing way (the desktop's trust is the stub).
    await page.goto(WIC, { waitUntil: 'domcontentloaded' });
    assert.deepEqual(await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return enableSite(tab.id); }),
      { enabled: true, origin: new URL(WIC).origin });
    console.log('Per-site: wic.example.org is turned on by itself.');

    // Open the side panel from Iowa's widget. Then, on the site turned on by itself (its card and an embedded
    // form from another site on screen), turn on all websites with a trusted click.
    await page.goto(`${applicant}?next=stay`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await (await launcherFrame()).locator('#details').click();
    panel = await attachNativePanel(context, page, extensionId);
    await page.goto(WIC, { waitUntil: 'domcontentloaded' });
    await launcherFrame();
    await expect.poll(() => panel.visible('#all-sites-enable'), { timeout: 15000 }).toBe(true);
    assert.equal(await panel.text('#all-sites-enable'), en('panel.allSitesEnable'));
    await expect.poll(() => panel.text('#frames-enable'), { timeout: 15000 }).toContain('forms.example.net');
    assert.equal(await panel.visible('#frames-enable'), true, 'before, the embedded form needs its own approval');
    await panel.click('#all-sites-enable');
    await expect.poll(() => panel.visible('#all-sites-disable'), { timeout: 15000 }).toBe(true);
    assert.equal(await panel.evaluate(() => document.getElementById('status').classList.contains('error')), false, await panel.text('#status'));
    assert.equal(await worker.evaluate(() => allSitesOn()), true);
    await expect.poll(() => panel.visible('#frames-enable'), { timeout: 15000 }).toBe(false);
    assert.equal(await cards(), 1, 'the page keeps one card when both registrations match');
    const embedded = page.frames().find(frame => frame.url() === FORMS);
    assert.equal(await embedded.evaluate(() => document.querySelectorAll('[data-secondhand-assistant]').length), 0, 'an embedded form makes no card of its own');
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
    await settled();
    assert.equal(await page.evaluate(() => window.__submits), 0, 'nothing is submitted');
    assert.equal(page.url(), PANTRY, 'nothing navigates');
    assert.deepEqual((await calls('getFields')).map(call => ({ url: call.url, fields: call.fields })),
      [{ url: PANTRY, fields: ['firstName', 'lastName', 'zip', 'email', 'householdSize'] }], 'one desktop request for this page');
    await page.screenshot({ path: path.join(root, 'artifacts/all-websites/all-websites-filled.png') });
    console.log('All websites: a form on a site never turned on filled from the fictional profile with one click; nothing was submitted.');

    // #98: the live QA's household questions fill from the fictional household list: counts by age and the one
    // student's name and grade. The guardian's name is never filled. The apartment, which the profile lacks, is
    // offered to Save to My information once the applicant types it, and read only after the Save click.
    await page.goto(HOUSEHOLD, { waitUntil: 'domcontentloaded' });
    await launcherFrame();
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofill'));
    await panel.click('#panel-autofill');
    await expect(page.locator('#young')).toHaveValue(syntheticProfile.householdChildren, { timeout: 20000 });
    await expect(page.locator('#middle')).toHaveValue(desktopProfile['householdCount:18-59']);
    await expect(page.locator('#older')).toHaveValue(desktopProfile['householdCount:60+']);
    await expect(page.locator('#student')).toHaveValue('Riley Example, 5th');
    assert.deepEqual([syntheticProfile.householdChildren, desktopProfile['householdCount:18-59'], desktopProfile['householdCount:60+']], ['2', '1', '1'], 'the fictional household: two children, the applicant, and a parent over 60');
    assert.equal(await page.locator('#guardian').inputValue(), '', 'a guardian’s name is never filled');
    assert.equal(await page.locator('#apt').inputValue(), '');
    assert.deepEqual((await calls('getFields')).filter(call => call.url === HOUSEHOLD).map(call => call.fields),
      [['householdChildren', 'householdCount:18-59', 'householdCount:60+', 'studentNameGrade', 'addressLine2']]);
    await expect.poll(() => panel.visible('#save-section'), { timeout: 15000 }).toBe(true);
    await expect.poll(() => panel.text('#save-list')).toBe(`${HOUSEHOLD_QUESTIONS.apt}${en('save.answerFirst')}`);
    await page.locator('#apt').fill('Unit 5');
    await expect.poll(() => panel.visible('[data-save-id] button'), { timeout: 15000 }).toBe(true);
    assert.equal(await panel.text('[data-save-id] button'), en('save.button'));
    assert.equal(await panel.evaluate(() => document.getElementById('save-section').textContent.includes('Unit 5')), false, 'the panel never shows the answer');
    assert.deepEqual(await worker.evaluate(() => globalThis.__desktop.saves), [], 'nothing is saved before the click');
    await panel.screenshot(path.join(root, 'artifacts/household/side-panel-save.png'));
    await page.screenshot({ path: path.join(root, 'artifacts/household/household-form-filled.png') });
    await panel.click('[data-save-id] button');
    await expect.poll(() => panel.text('#status'), { timeout: 15000 }).toBe(en('save.saved'));
    assert.deepEqual(await worker.evaluate(() => globalThis.__desktop.saves), [{ url: HOUSEHOLD, fields: { addressLine2: 'Unit 5' } }]);
    await expect.poll(() => panel.visible('#save-section'), { timeout: 15000 }).toBe(false);
    await settled();
    assert.equal(await page.evaluate(() => window.__submits), 0, 'nothing is submitted');
    console.log('#98: a pantry form’s household questions filled from the fictional household list (0-17, 18-59, 60+, and the student’s name and grade); the guardian stayed blank; the typed apartment was saved to My information after the Save click.');

    // A page whose only input is a search box gets no card.
    since = await probe();
    await page.goto(SEARCH, { waitUntil: 'domcontentloaded' });
    await settled(since, { reportFrom: SEARCH });
    assert.equal(await cards(), 0, 'no card on a search-only page');
    console.log('All websites: no card on a search-only page.');

    // A page whose only form is embedded from another site gets the card through the worker. Its answers are asked
    // for in the name of the site the form is from, the frame's address as Chrome gives it, and the sensitive-details
    // prompt names that site, not the page around it (#137).
    const prompts = () => worker.evaluate(() => globalThis.__desktop.prompts.splice(0));
    const requested = async since => (await calls('getFields')).slice(since).map(call => ({ url: call.url, fields: call.fields }));
    await prompts();
    let asked = (await calls('getFields')).length;
    await page.goto(EMBEDDING, { waitUntil: 'domcontentloaded' });
    await expect.poll(cards, { timeout: 15000 }).toBe(1);
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofill'));
    await panel.click('#panel-autofill');
    const signUp = page.frames().find(frame => frame.url() === FORMS);
    await expect(signUp.locator('#city')).toHaveValue(syntheticProfile.city, { timeout: 20000 });
    await expect(signUp.locator('#cash')).toHaveValue(syntheticProfile.assetsOnHand);
    assert.equal(await signUp.evaluate(() => window.__submits), 0);
    assert.deepEqual(await requested(asked), [{ url: FORMS, fields: ['city', 'assetsOnHand', 'addressLine2'] }], 'one request, in the embedded form’s own name');
    assert.deepEqual(await prompts(), ['Fill sensitive details on https://forms.example.net?'], 'the prompt names the site that gets the answers');
    // Save to My information from the embedded form: the answer is saved in the name of the site it came from.
    await expect.poll(() => panel.visible('#save-section'), { timeout: 15000 }).toBe(true);
    await expect.poll(() => panel.text('#save-list')).toBe(`Apartment number${en('save.answerFirst')}`);
    await signUp.locator('#apt').fill('Unit 7');
    await expect.poll(() => panel.visible('[data-save-id] button'), { timeout: 15000 }).toBe(true);
    await panel.click('[data-save-id] button');
    await expect.poll(() => panel.text('#status'), { timeout: 15000 }).toBe(en('save.saved'));
    assert.deepEqual((await worker.evaluate(() => globalThis.__desktop.saves)).at(-1), { url: FORMS, fields: { addressLine2: 'Unit 7' } });
    assert.deepEqual(await prompts(), ['Save this answer from https://forms.example.net to My information?'], 'the save prompt names the site the answer came from');
    console.log('All websites: a form embedded from another site brought the card and filled with no second approval; its sensitive prompt and its Save to My information named forms.example.net.');

    // A page with its own form and one embedded from another site: one click asks for each site's answers in that
    // site's name, apart, and each frame gets only its own site's.
    asked = (await calls('getFields')).length;
    await page.goto(WIC, { waitUntil: 'domcontentloaded' });
    await launcherFrame();
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofill'));
    await panel.click('#panel-autofill');
    const embeddedWic = page.frames().find(frame => frame.url() === FORMS);
    await expect(page.locator('#name')).toHaveValue(`${syntheticProfile.firstName} ${syntheticProfile.lastName}`, { timeout: 20000 });
    await expect(embeddedWic.locator('#city')).toHaveValue(syntheticProfile.city, { timeout: 20000 });
    await expect(embeddedWic.locator('#cash')).toHaveValue(syntheticProfile.assetsOnHand);
    const [wicRequest, formRequest] = await requested(asked);
    assert.deepEqual([wicRequest?.url, formRequest], [WIC, { url: FORMS, fields: ['city', 'assetsOnHand', 'addressLine2'] }], 'one request for each site, in page order');
    assert.equal(['city', 'assetsOnHand', 'addressLine2'].some(field => wicRequest.fields.includes(field)), false, 'the host page’s request asks only for its own questions');
    assert.deepEqual(await prompts(), ['Fill sensitive details on https://forms.example.net?']);
    assert.equal(await page.evaluate(() => window.__submits) + await embeddedWic.evaluate(() => window.__submits), 0);
    console.log('All websites: one click on a page and the form embedded in it asked for each site’s answers apart, each in its own name.');

    // Turn it off from the side panel: the card leaves the open page at once and doesn't come back.
    // Chrome's grant is kept, unused, and Iowa's portal is untouched.
    const allowed = origins => worker.evaluate(origins => chrome.permissions.contains({ origins }), origins);
    await page.goto(PANTRY, { waitUntil: 'domcontentloaded' });
    await launcherFrame();
    assert.equal(await cards(), 1);
    await panel.click('#all-sites-disable');
    await expect.poll(() => panel.visible('#all-sites-enable'), { timeout: 15000 }).toBe(true);
    await expect.poll(cards, { timeout: 10000 }).toBe(0);
    assert.equal(await worker.evaluate(() => allSitesOn()), false);
    assert.deepEqual((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).map(script => script.id), ['site-wic.example.org'],
      'the site turned on by itself keeps its registration');
    assert.equal(await allowed(['https://*/*']), true, 'Chrome’s grant is kept');
    assert.equal(await allowed([IOWA_HOST]), true, 'Iowa’s site is untouched');
    assert.equal((await calls('untrustAllSites')).length, 1);
    const shown = await panel.text('#status');
    assert.equal(shown, en('joined', { first: { key: 'worker.allSitesOff' }, second: { key: 'worker.chromeStillAllows' } }));
    since = await probe();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settled(since);
    assert.equal(await cards(), 0, 'the card stays gone after a reload');
    await panel.screenshot(path.join(root, 'artifacts/all-websites/all-websites-off-panel.png'));
    console.log(`All websites: off. The card left the open page; Chrome’s grant and Iowa’s access are kept. The side panel says: "${shown}"`);

    // With the grant kept and all websites off, a site that was never trusted gets nothing.
    since = await probe();
    await page.goto(NEVER, { waitUntil: 'domcontentloaded' });
    await settled(since);
    assert.equal(await cards(), 0, 'no card on a site that was never trusted');
    assert.equal(await worker.evaluate(origin => siteEnabled(origin), new URL(NEVER).origin), false);
    await expect.poll(() => panel.visible('#site-enable'), { timeout: 15000 }).toBe(true);
    assert.equal(await panel.visible('#panel-autofill'), false, 'the panel offers to turn the site on, not Autofill');
    assert.equal((await calls('getFields')).some(call => call.url.startsWith(new URL(NEVER).origin)), false);
    console.log('Off: a site that was never trusted gets no card and no fill, though Chrome’s grant is kept.');

    // Iowa's portal still works, with no Chrome restart.
    await page.goto(`${applicant}?next=stay`, { waitUntil: 'domcontentloaded' });
    await launcherFrame();
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofill'));
    await panel.click('#panel-autofill');
    await expect(page.locator('#firstName')).toHaveValue(syntheticProfile.firstName, { timeout: 20000 });
    await expect(page.locator('#lastName')).toHaveValue(syntheticProfile.lastName);
    console.log('Off: Iowa’s portal filled from the fictional profile without a Chrome restart.');

    // The site turned on by itself is still on, and turning it off works under the kept grant: the app drops it.
    await page.goto(WIC, { waitUntil: 'domcontentloaded' });
    await launcherFrame();
    await expect.poll(() => panel.visible('#site-disable'), { timeout: 15000 }).toBe(true);
    await panel.click('#site-disable');
    await expect.poll(() => panel.text('#status'), { timeout: 15000 }).toBe(en('panel.siteOffDone'));
    assert.deepEqual((await calls('untrustSite')).map(call => call.url), [new URL(WIC).origin]);
    assert.deepEqual(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts()), []);
    assert.equal(await allowed(['https://*/*']), true);
    since = await probe();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settled(since);
    assert.equal(await cards(), 0);
    console.log('Per-site: wic.example.org turned off under the kept grant; the app dropped it and its card is gone.');

    // Turning all websites on again needs no second Chrome prompt (one would never be answered here).
    await panel.click('#all-sites-enable');
    await expect.poll(() => panel.visible('#all-sites-disable'), { timeout: 15000 }).toBe(true);
    assert.equal((await calls('trustAllSites')).length, 2, 'the app still asks');
    await page.goto(PANTRY, { waitUntil: 'domcontentloaded' });
    await expect.poll(cards, { timeout: 15000 }).toBe(1);
    await panel.click('#all-sites-disable');
    await expect.poll(cards, { timeout: 10000 }).toBe(0);
    assert.equal(await worker.evaluate(() => allSitesOn()), false);
    console.log('All websites: on again with no second Chrome prompt, then off.');

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
