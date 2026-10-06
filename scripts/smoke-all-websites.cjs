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
const CONTACT = 'https://contact.example.org/contact';
const WIZARD_ONE = 'https://appointments.example.org/step-one';
const WIZARD_TWO = 'https://appointments.example.org/step-two';
const WIZARD_REVIEW = 'https://appointments.example.org/review';
const customAnswers = [
  { id: 'b0000000-0000-4000-8000-000000000001', label: 'Member number', value: 'QA-MEMBER-4837', aliases: ['Membership ID'] },
  { id: 'b0000000-0000-4000-8000-000000000002', label: 'Biography', value: 'Fictional QA applicant.\nAfternoon appointments work best.', aliases: [] },
  { id: 'b0000000-0000-4000-8000-000000000003', label: 'Deliver to my door', value: 'Yes', aliases: [] }
];
// #176: one everyday question and one sensitive one (the date of birth, in SENSITIVE_FIELDS in desktop/main.cjs).
const DETAILS = 'https://pantry.example.org/details';
// #98: the household questions the live QA (#89) found on a pantry form, plus one the fictional profile has no answer for.
const HOUSEHOLD = 'https://pantry.example.org/household';
const HOUSEHOLD_QUESTIONS = { young: '# of people in your household 0 - 17 yrs old', middle: '# of people in your household 18 - 59 yrs old', older: '# of people in your household 60 + yrs',
  student: 'Student name and grade. Order will be assigned to(first and Last)', guardian: 'Guardian first and last name', apt: 'Apartment number' };
// What the desktop works out from the fictional household list, as the app does: band counts and the one student's name and grade.
const listed = validateProfile(syntheticProfile);
const desktopProfile = { ...syntheticProfile, customFields: customAnswers, ...Object.fromEntries(['householdCount:18-59', 'householdCount:60+', 'studentNameGrade'].map(key => [key, releasedValue(listed, key)])) };
// #185: a radio question no rule knows, which the stub Laya can only guess at.
const GUESS = 'https://pantry.example.org/service-area';
const GUESS_QUESTION = 'Do you live in our service area?';
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
  [CONTACT]: formPage('Contact form', '<form><label for="detail">Signature</label><input id="detail"><button type="submit">Send</button></form>'),
  [WIZARD_ONE]: formPage('Appointment details', `<form><div id="contact-component"></div>
    <label for="membership">Membership ID</label><input id="membership" required>
    <label id="bio-label">Biography</label><div id="biography" role="textbox" contenteditable="true" aria-labelledby="bio-label" aria-multiline="true" aria-required="true" style="min-height:65px;white-space:pre-wrap;border:1px solid #98a68f;padding:10px"></div>
    <div id="delivery" role="checkbox" tabindex="0" aria-label="Deliver to my door" aria-checked="false" aria-required="true" style="padding:12px;border:1px solid #98a68f;margin:14px 0">Deliver to my door</div>
    <button type="button" id="next">Next</button></form>
    <script>
      const shadow = document.getElementById('contact-component').attachShadow({mode:'open'});
      shadow.innerHTML = '<style>label{display:block;margin:12px 0 4px}input{display:block;width:300px;height:32px}</style><label for="first">First name</label><input id="first" required><label for="email">Email address</label><input id="email" type="email" required>';
      document.getElementById('delivery').addEventListener('click', event => { const control=event.currentTarget; control.setAttribute('aria-checked', control.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); });
      document.getElementById('next').addEventListener('click', async () => {
        await window.recordWizardStep({step:'one',firstName:shadow.getElementById('first').value,email:shadow.getElementById('email').value,membership:document.getElementById('membership').value,biography:document.getElementById('biography').textContent,delivery:document.getElementById('delivery').getAttribute('aria-checked')});
        location.assign('${WIZARD_TWO}');
      });
    </script>`),
  [WIZARD_TWO]: formPage('Appointment scheduling', `<form><label for="zip">ZIP code</label><input id="zip" required>
    <label for="topic">Appointment topic</label><input id="topic" required>
    <button type="button" id="next">Next</button></form><script>
      document.getElementById('next').addEventListener('click', async () => {
        await window.recordWizardStep({step:'two',zip:document.getElementById('zip').value,topic:document.getElementById('topic').value});
        location.assign('${WIZARD_REVIEW}');
      });
    </script>`),
  [WIZARD_REVIEW]: formPage('Final review', '<form><p>Check the fictional appointment before submitting.</p><label for="final-email">Email address</label><input id="final-email" type="email"><button type="submit">Submit</button></form>'),
  [DETAILS]: formPage('Pantry sign-up: your details', '<form><label for="first">First name</label><input id="first" name="first">' +
    '<label for="dob">Date of birth</label><input id="dob" name="dob" type="date"><button type="submit">Submit</button></form>'),
  [GUESS]: formPage('Pantry sign-up: service area', '<form><label for="first">First name</label><input id="first" name="first">' +
    `<fieldset><legend>${GUESS_QUESTION}</legend>${['Yes', 'No', 'Not sure'].map((option, index) => `<label><input type="radio" name="area" id="area-${index}" value="${option}">${option}</label>`).join('')}</fieldset>` +
    '<button type="submit">Submit</button></form>'),
  [HOUSEHOLD]: formPage('Pantry order: household', `<form>${Object.entries(HOUSEHOLD_QUESTIONS).map(([id, label]) => `<label for="${id}">${label}</label><input id="${id}" name="${id}">`).join('')}` +
    '<button type="submit">Submit</button></form>')
};

// The desktop app as the worker sees it over native messaging, with Always allow on. It keeps its own
// all-websites setting, as the real app does, and reports it in status. Asked for money on hand, or to save
// an answer, it shows the prompt the app shows, naming the site the request names. With `holds`, it plays the
// app without Always allow (#176): Autofill's request gets those fields held back, and Fill sensitive details'
// request (`sensitive: true`) gets the sensitive prompt, answered by the next of `answers` ('cancel' or 'allow').
// Laya isn't ready unless a step makes it so (`laya`); then it is sure of nothing and guesses "Yes" for the
// service-area question (#185), noting each question it is asked in `questions`.
async function installDesktop(worker, profile) {
  await worker.evaluate(profile => {
    globalThis.__desktop = { allSites: false, calls: [], saves: [], prompts: [], profile, holds: [], answers: [], laya: 'unavailable', questions: [], customFieldsAvailable: false, holdNavigation: false };
    nativeRequest = async (type, payload = {}) => {
      const desktop = globalThis.__desktop;
      desktop.calls.push({ type, url: payload.url || '', fields: payload.fields || [], ...(payload.sensitive === true ? { sensitive: true } : {}) });
      if (type === 'status') return { unlocked: true, applicationCount: 0, accessRevision: 0, allSites: desktop.allSites, laya: { state: desktop.laya }, customFieldsAvailable: desktop.customFieldsAvailable };
      // The real desktop matcher/consent is tested separately. This stub returns only fictional,
      // explicitly saved exact labels or aliases and never exposes the whole custom-answer list.
      if (type === 'getCustomFields') {
        if (!desktop.customFieldsAvailable) throw new Error('Custom answers were requested without the fixture capability.');
        const values = {};
        for (const field of payload.fields) {
          const matches = desktop.profile.customFields.filter(row => [row.label, ...row.aliases].includes(field.label));
          if (matches.length === 1 && (!field.options.length || field.options.includes(matches[0].value))) values[field.id] = matches[0].value;
        }
        return { values, accessRevision: 0 };
      }
      if (type === 'authorizeSiteNavigation') {
        if (desktop.holdNavigation) {
          desktop.holdNavigation = false;
          return new Promise(resolve => { desktop.releaseNavigation = () => resolve({ accessRevision: 0 }); });
        }
        return { accessRevision: 0 };
      }
      if (type === 'trustAllSites') { desktop.allSites = true; return { allSites: true }; }
      if (type === 'untrustAllSites') { desktop.allSites = false; return { allSites: false }; }
      if (type === 'trustSite') return { trusted: true, origin: new URL(payload.url).origin };
      if (type === 'untrustSite') return { trusted: false, origin: new URL(payload.url).origin };
      if (type === 'showApp') return { shown: true };
      if (type === 'warmLaya') return { state: desktop.laya };
      if ((type === 'suggestFields' || type === 'answerFields') && desktop.laya !== 'ready') throw Object.assign(new Error('Laya isn’t ready on this computer.'), { code: 'LAYA_NOT_READY' });
      if (type === 'suggestFields') return { suggestions: {} };
      if (type === 'answerFields') {
        desktop.questions.push(...payload.questions.map(question => ({ label: question.label, type: question.type, options: question.options })));
        const area = payload.questions.find(question => question.label === 'Do you live in our service area?');
        return { answers: {}, guesses: area ? { [area.id]: 'Yes' } : {}, accessRevision: 0 };
      }
      if (type === 'getFields' && payload.sensitive === true) {
        desktop.prompts.push(`Fill sensitive details on ${new URL(payload.url).origin}?`);
        const answer = desktop.answers.shift();
        if (answer === 'cancel') throw new Error('You cancelled this field request.');
        if (answer !== 'allow') throw new Error(`The all-websites smoke has no answer for this sensitive prompt: ${answer}`);
      } else if (type === 'getFields' && payload.fields.includes('assetsOnHand')) desktop.prompts.push(`Fill sensitive details on ${new URL(payload.url).origin}?`);
      if (type === 'getFields') {
        const held = payload.sensitive === true ? [] : payload.fields.filter(field => desktop.holds.includes(field));
        return { accessRevision: 0, values: Object.fromEntries(payload.fields.filter(field => desktop.profile[field] && !held.includes(field)).map(field => [field, desktop.profile[field]])),
          ...(held.length ? { held } : {}) };
      }
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
  const wizardSteps = [];
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
      busy: Boolean(clicksUnderway || siteRuns.size || [...autopilots.values()].some(pilot => pilot.running) || [...sitePilots.values()].some(pilot => pilot.running)) }));
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

    // An ordinary contact form needs no benefits-specific site adapter. A framework may update only
    // the label's text node, with no added element or changed attribute: that must reveal the card too.
    since = await probe();
    await page.goto(CONTACT, { waitUntil: 'domcontentloaded' });
    await settled(since, { reportFrom: CONTACT });
    assert.equal(await cards(), 0, 'a signature-only form offers no autofill');
    await page.locator('label[for="detail"]').evaluate(label => { label.firstChild.data = 'First name'; });
    await launcherFrame();
    assert.equal(await page.locator('#detail').inputValue(), '', 'recognition alone releases no saved answer');
    assert.deepEqual((await calls('getFields')).filter(call => call.url === CONTACT), []);
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofill'));
    await panel.click('#panel-autofill');
    await expect(page.locator('#detail')).toHaveValue(syntheticProfile.firstName, { timeout: 20000 });
    await settled();
    assert.deepEqual((await calls('getFields')).filter(call => call.url === CONTACT).map(call => call.fields), [['firstName']]);
    assert.equal(await page.evaluate(() => window.__submits), 0, 'the contact form was not sent');
    assert.equal(page.url(), CONTACT);
    await page.locator('label[for="detail"]').evaluate(label => { label.firstChild.data = 'Signature'; });
    await expect.poll(cards, { timeout: 10000 }).toBe(0);
    console.log('All websites: text-only label changes reveal and hide the card on an ordinary contact form; one click fills only the saved first name, without sending the form.');

    // A general-purpose wizard, not a benefits adapter. Genuine open-shadow controls,
    // a multiline editor, and an ARIA checkbox receive only the fictional saved answers.
    await page.exposeFunction('recordWizardStep', step => { wizardSteps.push(step); });
    const wizardCallsFrom = (await worker.evaluate(() => globalThis.__desktop.calls.length));
    await worker.evaluate(() => { globalThis.__desktop.customFieldsAvailable = true; globalThis.__desktop.holdNavigation = true; });
    await page.goto(WIZARD_ONE, { waitUntil: 'domcontentloaded' });
    await launcherFrame();
    await expect.poll(() => panel.visible('#site-continue'), { timeout: 15000 }).toBe(true);
    assert.equal(await panel.text('#site-continue'), en('panel.fillAndContinue'));
    assert.match(await panel.text('#site-continue-hint'), /may send and save answers/);
    assert.equal((await calls('getCustomFields')).filter(call => call.url === WIZARD_ONE).length, 0, 'recognition alone cannot release custom answers');
    await panel.click('#site-continue');
    // Hold only the synthetic desktop navigation approval so the actual filled page can be
    // inspected before Next. Production code contains no test hook or fabricated controls.
    await expect.poll(() => worker.evaluate(() => typeof globalThis.__desktop.releaseNavigation === 'function'), { timeout: 25000 }).toBe(true);
    await expect(page.locator('#contact-component #first')).toHaveValue(syntheticProfile.firstName);
    await expect(page.locator('#contact-component #email')).toHaveValue(syntheticProfile.email);
    await expect(page.locator('#membership')).toHaveValue(customAnswers[0].value);
    assert.equal(await page.locator('#biography').textContent(), customAnswers[1].value, 'multiline text is preserved');
    await expect(page.locator('#delivery')).toHaveAttribute('aria-checked', 'true');
    assert.deepEqual(wizardSteps, [], 'Next waits for the desktop navigation approval');
    assert.equal(await page.evaluate(() => window.__submits), 0);
    const customRequests = (await calls('getCustomFields')).filter(call => call.url === WIZARD_ONE);
    assert.deepEqual(customRequests[0].fields.map(({ label, type, options }) => ({ label, type, options })), [
      { label: 'Membership ID', type: 'text', options: [] },
      { label: 'Biography', type: 'textarea', options: [] },
      { label: 'Deliver to my door', type: 'checkbox', options: ['Yes', 'No'] }
    ]);
    for (const call of customRequests) assert.equal(call.fields.some(field => Object.hasOwn(field, 'value')), false, 'only question metadata is requested');
    const sidebarText = await panel.evaluate(() => document.body.innerText);
    for (const answer of customAnswers) assert.equal(sidebarText.includes(answer.value), false, 'saved custom values never appear in the sidebar');
    // Default caret hiding changes inline styles and rightly invalidates the private Next snapshot.
    await page.screenshot({ path: path.join(root, 'artifacts/all-websites/custom-controls-filled.png'), caret: 'initial' });
    await worker.evaluate(() => { globalThis.__desktop.releaseNavigation(); delete globalThis.__desktop.releaseNavigation; });
    await expect(page).toHaveURL(WIZARD_TWO, { timeout: 20000 });
    await expect(page.locator('#zip')).toHaveValue(syntheticProfile.zip, { timeout: 20000 });
    await expect.poll(() => panel.text('#status'), { timeout: 20000 }).toBe(en('worker.siteNext.missing'));
    await settled();
    assert.equal(await page.locator('#topic').inputValue(), '');
    assert.deepEqual(wizardSteps, [{ step: 'one', firstName: syntheticProfile.firstName, email: syntheticProfile.email,
      membership: customAnswers[0].value, biography: customAnswers[1].value, delivery: 'true' }]);
    assert.equal(await worker.evaluate(() => sitePilots.size), 0, 'missing information ends automatic continuation until an explicit restart');
    await panel.screenshot(path.join(root, 'artifacts/all-websites/continue-missing-answer-panel.png'));
    await page.locator('#topic').fill('Fictional scheduling request');
    assert.equal(await worker.evaluate(() => sitePilots.size), 0, 'typing an answer does not authorize another Next');
    assert.equal(page.url(), WIZARD_TWO);
    assert.equal(wizardSteps.length, 1);
    await expect.poll(() => panel.visible('#site-continue'), { timeout: 15000 }).toBe(true);
    await panel.click('#site-continue');
    await expect(page).toHaveURL(WIZARD_REVIEW, { timeout: 20000 });
    await expect.poll(() => panel.text('#status'), { timeout: 20000 }).toBe(en('worker.siteNext.protected'));
    await settled();
    assert.deepEqual(wizardSteps.map(step => step.step), ['one', 'two'], 'each ordinary Next clicked exactly once');
    assert.deepEqual(wizardSteps[1], { step: 'two', zip: syntheticProfile.zip, topic: 'Fictional scheduling request' });
    assert.equal(await page.evaluate(() => window.__submits), 0, 'final submission never runs');
    assert.equal(await page.locator('#final-email').inputValue(), '', 'the protected final review is not filled either');
    assert.equal(await worker.evaluate(() => sitePilots.size), 0);
    const wizardCalls = await worker.evaluate(from => globalThis.__desktop.calls.slice(from), wizardCallsFrom);
    assert.deepEqual(wizardCalls.filter(call => call.type === 'authorizeSiteNavigation').map(call => call.url), [WIZARD_ONE, WIZARD_TWO]);
    assert.equal(wizardCalls.some(call => ['getFields', 'getCustomFields', 'authorizeSiteNavigation'].includes(call.type) && call.url === WIZARD_REVIEW), false);
    assert.equal(wizardCalls.some(call => ['suggestFields', 'answerFields'].includes(call.type)), false, 'Fill and continue never asks a model for guesses');
    await panel.screenshot(path.join(root, 'artifacts/all-websites/continue-final-review-panel.png'));
    await worker.evaluate(() => { globalThis.__desktop.customFieldsAvailable = false; });
    console.log('General wizard: explicit saved custom aliases, multiline text, ARIA checkbox and open-shadow identity fields filled; Next waited for approval, required manual information required an explicit restart, and final review/Submit stayed untouched. Native approvals and values were stubs.');

    // #185: a radio question no rule knows gets Laya's best guess. It is filled with its own dotted outline, the side
    // panel says how many Laya guessed and lists the question, and its row finds it on the page.
    await worker.evaluate(() => { globalThis.__desktop.laya = 'ready'; });
    await page.goto(GUESS, { waitUntil: 'domcontentloaded' });
    const guessWidget = await launcherFrame();
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofill'));
    await panel.click('#panel-autofill');
    await expect(page.locator('#area-0')).toBeChecked({ timeout: 20000 });
    await expect(page.locator('#first')).toHaveValue(syntheticProfile.firstName);
    await settled();
    assert.deepEqual(await worker.evaluate(() => globalThis.__desktop.questions.splice(0)), [{ label: GUESS_QUESTION, type: 'radio', options: ['Yes', 'No', 'Not sure'] }],
      'Laya sees the question’s words and options only');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('input[name="area"]')].map(input => [input.checked, input.getAttribute('data-secondhand-filled'), getComputedStyle(input).outlineStyle])),
      [[true, 'laya-guess', 'dotted'], [false, 'laya-guess', 'dotted'], [false, 'laya-guess', 'dotted']], 'the guess has its own dotted outline');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('first')).outlineStyle), 'solid', 'a rule’s answer keeps its solid one');
    const guessed = en('result.layaGuessed', { summary: { key: 'result.siteFilled', params: { count: 2 } }, count: 1 });
    await expect.poll(() => panel.text('#status'), { timeout: 15000 }).toBe(guessed);
    await expect.poll(() => panel.visible('#guesses-section'), { timeout: 15000 }).toBe(true);
    assert.equal(await panel.text('#guesses-title'), en('guesses.title'));
    assert.equal(await panel.text('#guesses-list'), GUESS_QUESTION);
    await expect(guessWidget.locator('#widget-text')).toHaveText(guessed, { timeout: 15000 });
    await page.screenshot({ path: path.join(root, 'artifacts/all-websites/laya-guess-filled.png') });
    await panel.screenshot(path.join(root, 'artifacts/all-websites/laya-guess-panel.png'));
    await panel.click('[data-guess-id]');
    await expect.poll(() => page.evaluate(() => Boolean(document.querySelector('fieldset[data-secondhand-attention], input[name="area"][data-secondhand-attention]'))), { timeout: 15000 }).toBe(true);
    assert.equal(await page.evaluate(() => window.__submits), 0, 'nothing is submitted');
    await worker.evaluate(() => { globalThis.__desktop.laya = 'unavailable'; });
    console.log('#185: a radio question no rule knows got Laya’s best guess, with its own dotted outline; the side panel said "1 guessed by Laya, check it", listed the question, and its row found it on the page.');

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
    // The side panel names the two questions Autofill left, in the form's own words; a row finds its box.
    const leftRows = () => panel.evaluate(() => [...document.querySelectorAll('#left-list > *')].map(row => [row.querySelector('.checklist-label').textContent, row.querySelector('.checklist-detail').textContent]));
    await expect.poll(() => panel.visible('#left-section'), { timeout: 15000 }).toBe(true);
    assert.deepEqual((await leftRows()).sort(), [[HOUSEHOLD_QUESTIONS.apt, en('checklist.missing')], [HOUSEHOLD_QUESTIONS.guardian, en('checklist.missing')]].sort());
    assert.equal(await panel.text('#left-summary'), en('checklist.left', { count: 2 }));
    await panel.click(`#left-list > :nth-child(${(await leftRows()).findIndex(([label]) => label === HOUSEHOLD_QUESTIONS.guardian) + 1})`);
    // On another site a question is scrolled to and outlined; the keyboard's focus is left where it was.
    await expect.poll(() => page.evaluate(() => Boolean(document.getElementById('guardian').closest('[data-secondhand-attention]'))), { timeout: 15000 }).toBe(true);
    assert.equal(await page.evaluate(() => Boolean(document.getElementById('apt').closest('[data-secondhand-attention]'))), false);
    assert.equal(await page.locator('#guardian').inputValue(), '', 'finding a question writes nothing');
    // What was filled is named too, folded away until opened: the four household answers, none a guess.
    assert.equal(await panel.visible('#filled-section'), true);
    assert.equal(await panel.evaluate(() => document.getElementById('filled-section').open), false);
    assert.equal(await panel.text('#filled-summary'), en('questions.count', { count: 4 }));
    await panel.click('#filled-section > summary');
    await expect.poll(() => panel.evaluate(() => document.getElementById('filled-section').open), { timeout: 5000 }).toBe(true);
    assert.deepEqual(await panel.evaluate(() => [...document.querySelectorAll('#filled-list > *')].map(row => [row.querySelector('.checklist-label').textContent, row.querySelector('.checklist-detail').textContent])),
      [HOUSEHOLD_QUESTIONS.young, HOUSEHOLD_QUESTIONS.middle, HOUSEHOLD_QUESTIONS.older, HOUSEHOLD_QUESTIONS.student].map(label => [label, en('checklist.complete')]));
    await expect.poll(() => panel.visible('#save-section'), { timeout: 15000 }).toBe(true);
    await expect.poll(() => panel.text('#save-list')).toBe(`${HOUSEHOLD_QUESTIONS.apt}${en('save.answerFirst')}`);
    await page.locator('#apt').fill('Unit 5');
    await expect.poll(() => panel.visible('[data-save-id] button'), { timeout: 15000 }).toBe(true);
    // The apartment now holds an answer, so its row is done and one question is left.
    await expect.poll(async () => (await leftRows()).find(([label]) => label === HOUSEHOLD_QUESTIONS.apt)?.[1], { timeout: 15000 }).toBe(en('checklist.complete'));
    assert.equal(await panel.text('#left-summary'), en('checklist.left', { count: 1 }));
    assert.equal(await panel.evaluate(() => document.getElementById('left-section').textContent.includes('Unit 5')), false, 'the list never shows an answer');
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
    console.log('#98: a pantry form’s household questions filled from the fictional household list (0-17, 18-59, 60+, and the student’s name and grade); the guardian stayed blank and the side panel named it and the apartment as left; the typed apartment was saved to My information after the Save click.');

    // #176: without Always allow, the app holds the date of birth back. One click fills the first name at once; the date of
    // birth counts under need-you and waits in the side panel's list. Fill sensitive details asks the app for it alone:
    // Cancel leaves the first name filled and the date listed, and Allow once fills it.
    await worker.evaluate(() => { Object.assign(globalThis.__desktop, { holds: ['birthDate'], answers: ['cancel', 'allow'] }); globalThis.__desktop.prompts.length = 0; });
    const heldCalls = async since => (await calls('getFields')).slice(since).map(call => ({ url: call.url, fields: call.fields, sensitive: call.sensitive === true }));
    let since176 = (await calls('getFields')).length;
    await page.goto(DETAILS, { waitUntil: 'domcontentloaded' });
    const detailsWidget = await launcherFrame();
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofill'));
    await panel.click('#panel-autofill');
    await expect(page.locator('#first')).toHaveValue(syntheticProfile.firstName, { timeout: 20000 });
    await settled();
    assert.equal(await page.locator('#dob').inputValue(), '', 'the date of birth waits');
    assert.deepEqual(await heldCalls(since176), [{ url: DETAILS, fields: ['firstName', 'birthDate'], sensitive: false }], 'one request, as before');
    await expect(detailsWidget.locator('#need-you')).toHaveText(en('widget.needYou', { count: 1 }), { timeout: 15000 });
    await expect(detailsWidget.locator('#widget-text')).toHaveText(en('result.withHeld', { summary: { key: 'result.siteFilled', params: { count: 1 } }, count: 1 }));
    await expect.poll(() => panel.visible('#held-section'), { timeout: 15000 }).toBe(true);
    assert.equal(await panel.text('#held-list'), 'Date of birth');
    assert.equal(await panel.text('#held-fill'), en('held.fill'));
    const waiting = en('result.withHeldBelow', { summary: { key: 'result.siteFilledNeedYou', params: { count: 1, needYou: 1 } }, count: 1 });
    assert.equal(await panel.text('#status'), waiting);
    assert.equal(await panel.visible('#save-section'), false, 'a held date of birth is saved: it is never offered to Save to My information');
    assert.deepEqual(await worker.evaluate(() => globalThis.__desktop.prompts), [], 'nothing about it was asked yet');
    await panel.screenshot(path.join(root, 'artifacts/held/side-panel-held.png'));
    since176 = (await calls('getFields')).length;
    await panel.click('#held-fill');
    await expect.poll(() => panel.text('#status'), { timeout: 15000 }).toBe(en('worker.heldCancelled'));
    assert.deepEqual(await heldCalls(since176), [{ url: DETAILS, fields: ['birthDate'], sensitive: true }], 'the held field alone');
    assert.equal(await page.locator('#first').inputValue(), syntheticProfile.firstName, 'Cancel leaves what filled in place');
    assert.equal(await page.locator('#dob').inputValue(), '');
    assert.equal(await panel.visible('#held-section'), true, 'and keeps the date of birth listed');
    assert.equal(await panel.text('#held-list'), 'Date of birth');
    await panel.click('#held-fill');
    await expect(page.locator('#dob')).toHaveValue(syntheticProfile.birthDate, { timeout: 20000 });
    await expect.poll(() => panel.visible('#held-section'), { timeout: 15000 }).toBe(false);
    await expect.poll(() => panel.text('#status'), { timeout: 15000 }).toBe(en('result.siteFilled', { count: 2 }));
    await expect(detailsWidget.locator('#need-you')).toBeHidden({ timeout: 15000 });
    await expect(detailsWidget.locator('#widget-text')).toHaveText(en('result.siteFilled', { count: 2 }));
    assert.deepEqual(await worker.evaluate(() => globalThis.__desktop.prompts), ['Fill sensitive details on https://pantry.example.org?', 'Fill sensitive details on https://pantry.example.org?'],
      'the sensitive prompt came only from the button, once for Cancel and once for Allow once');
    await settled();
    assert.equal(await page.evaluate(() => window.__submits), 0, 'nothing is submitted');
    await page.screenshot({ path: path.join(root, 'artifacts/held/details-filled.png') });
    await worker.evaluate(() => { Object.assign(globalThis.__desktop, { holds: [], answers: [] }); globalThis.__desktop.prompts.length = 0; });
    console.log('#176: without Always allow, one click filled the first name and held the date of birth; Fill sensitive details asked for it alone: Cancel kept it listed with the first name filled, and Allow once filled it.');

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
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofillIowa'));
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
    console.error('Synthetic wizard steps/errors:', JSON.stringify({ steps: wizardSteps.map(step => step.step), errors }));
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
