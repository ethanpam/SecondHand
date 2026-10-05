'use strict';

// Screenshots of every SecondHand extension surface, for before-and-after comparisons in a pull request.
// Real Chromium loads the unpacked extension. Pages are synthetic fixtures at their real addresses, the
// desktop app is a DevTools stub, DNS is disabled, and every answer is fictional.
//
//   node scripts/capture-ui.cjs before                  every shot, as docs/pr-media/<shot>-before.png
//   node scripts/capture-ui.cjs after card- panel-iowa  only panel-iowa and the shots that start with card-
//
// The side panel is Chrome's own, 360 by 765 CSS pixels in this window. The card is a 330 by 140 crop of
// the page's corner. Both are captured at twice that size. The card-autofill recording needs ffmpeg on the
// PATH. Each browser session ends by asking Chrome for the extension's error list, and fails if it has one.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium, expect } = require('@playwright/test');
const smoke = require('./smoke-extension.cjs');
const preApplicant = require('../tests/fixtures/iowa-pre-applicant.cjs');

const root = path.join(__dirname, '..');
const output = path.join(root, 'docs/pr-media');
const [label, ...only] = process.argv.slice(2);
const VIEW = { width: 1200, height: 900 };
const CARD = { x: VIEW.width - 330, y: VIEW.height - 140, width: 330, height: 140 };
const FILM = { width: 800, height: 600 };
const applicant = `${smoke.applicant}?next=stay`;
const screen = name => `${smoke.portal}${preApplicant.screens[name].path}`;
const UNKNOWN = `${smoke.portal}/applyForBenefits/householdMembers`;
const PANTRY = 'https://pantry.example.org/intake';
const HOUSEHOLD = 'https://pantry.example.org/household';
const DESPENSA = 'https://despensa.example.org/registro';
// A shot is asked for by its name, or by the start of its name ending in a hyphen.
const wanted = name => !only.length || only.some(asked => asked.endsWith('-') ? name.startsWith(asked) : name === asked);

function formPage(title, form, lang = 'en') {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title} · synthetic test only</title>
    <style>body{font:16px system-ui;background:#fff;color:#222;margin:0;padding:30px}main{max-width:640px}label{display:block;margin:12px 0 4px}input{display:block;width:300px;height:32px}button{margin-top:16px}</style></head>
    <body><main><p>SYNTHETIC FIXTURE. No real organization or applicant data.</p><h1>${title}</h1>${form}</main></body></html>`;
}
const field = (id, text, type = 'text') => `<label for="${id}">${text}</label><input id="${id}" name="${id}" type="${type}">`;
const pages = {
  [PANTRY]: formPage('Pantry sign-up', `<form>${field('fname', 'First name')}${field('lname', 'Last name')}${field('zip', 'ZIP code')}${field('email', 'Email', 'email')}` +
    `${field('hh', 'Household size', 'number')}${field('pet', 'Do you have a pet?')}<button type="submit">Submit</button></form>`),
  [HOUSEHOLD]: formPage('Pantry order: household', `<form>${field('young', '# of people in your household 0 - 17 yrs old')}${field('apt', 'Apartment number')}` +
    `${field('guardian', 'Guardian first and last name')}<button type="submit">Submit</button></form>`),
  [DESPENSA]: formPage('Registro de la despensa', `<form>${field('nombre', 'Nombre')}${field('apellido', 'Apellido')}${field('cp', 'Código postal')}` +
    `${field('correo', 'Correo electrónico', 'email')}<button type="submit">Enviar</button></form>`, 'es')
};

// The desktop app as the worker sees it over native messaging, with Always allow on. A session changes
// locked, closed, or laya on globalThis.__desktop to show the app in that state.
async function installDesktop(worker) {
  await worker.evaluate(profile => {
    globalThis.__desktop = { profile, locked: false, closed: false, laya: 'unavailable', allSites: false };
    nativeRequest = async (type, payload = {}) => {
      const desktop = globalThis.__desktop;
      if (type === 'openApp') return { opened: 'shown' };
      if (desktop.closed) throw Object.assign(fault('worker.desktopOffline'), { code: 'offline' });
      if (type === 'status') return { unlocked: !desktop.locked, applicationCount: 0, accessRevision: 0, allSites: desktop.allSites, laya: { state: desktop.laya } };
      if (type === 'showApp') return { shown: true };
      if (type === 'trustAllSites' || type === 'untrustAllSites') { desktop.allSites = type === 'trustAllSites'; return { allSites: desktop.allSites }; }
      if (type === 'trustSite' || type === 'untrustSite') return { trusted: type === 'trustSite', origin: new URL(payload.url).origin };
      if (type === 'warmLaya') return { state: desktop.laya };
      if (type === 'suggestFields' || type === 'answerFields') throw Object.assign(new Error('Laya isn’t ready on this computer.'), { code: 'LAYA_NOT_READY' });
      if (type === 'getFields') {
        if (desktop.locked) throw new Error('Unlock your local vault first.');
        return { accessRevision: 0, values: Object.fromEntries(payload.fields.filter(name => desktop.profile[name]).map(name => [name, desktop.profile[name]])) };
      }
      if (type === 'recordProgress') return { recorded: true };
      if (type === 'saveFields') return { saved: Object.keys(payload.fields) };
      throw new Error(`Unexpected native request in the UI capture: ${type}`);
    };
  }, smoke.syntheticProfile);
}

async function launch(userData, extensionDirectory, { viewport = VIEW, scale = 2, video } = {}) {
  const context = await chromium.launchPersistentContext(userData, {
    channel: 'chromium', headless: true, viewport, deviceScaleFactor: scale, ...(video ? { recordVideo: { dir: video, size: viewport } } : {}),
    args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1440,1050', `--force-device-scale-factor=${scale}`]
  });
  await context.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url());
    const fulfill = body => route.fulfill({ status: 200, contentType: 'text/html', body });
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (!request.isNavigationRequest()) return route.abort('blockedbyclient');
    if (Object.hasOwn(pages, request.url())) return fulfill(pages[request.url()]);
    if (url.origin !== 'https://hhsservices.iowa.gov') return route.abort('blockedbyclient');
    if (url.pathname === '/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo') return fulfill(smoke.fixture(url.searchParams.get('next')));
    const name = Object.keys(preApplicant.screens).find(name => request.url() === screen(name));
    if (name) return fulfill(smoke.preApplicantPage(name));
    if (request.url() === UNKNOWN) return fulfill('<!doctype html><html lang="en"><title>Synthetic unknown screen · test only</title><main><h1>Household Members</h1><p>SYNTHETIC TEST FIXTURE.</p></main></html>');
    return route.abort('blockedbyclient');
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;
  // Chrome keeps what an extension logs or throws only in developer mode, and only once asked to.
  // Reloading the extension then starts its worker again, so the worker's own start is kept too.
  const setup = await context.newPage();
  await setup.goto('chrome://extensions');
  await setup.evaluate(id => new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true },
    () => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, errorCollection: true }, resolve))), extensionId);
  const restarted = context.waitForEvent('serviceworker', { timeout: 20000 });
  await setup.evaluate(id => new Promise(resolve => chrome.developerPrivate.reload(id, { failQuietly: true }, resolve)), extensionId);
  worker = await restarted;
  await setup.close();
  await installDesktop(worker);
  const page = context.pages()[0] || await context.newPage();
  const launcherUrl = `chrome-extension://${extensionId}/panel.html?surface=launcher`;
  const card = async () => {
    await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 15000 }).toBe(true);
    return page.frames().find(frame => frame.url() === launcherUrl);
  };
  // Leaving the page turns a running autofill off, so every state starts clean.
  async function open(url, desktop = {}) {
    await page.goto('about:blank');
    await worker.evaluate(desktop => Object.assign(globalThis.__desktop, desktop), { locked: false, closed: false, laya: 'unavailable', profile: smoke.syntheticProfile, ...desktop });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
  }
  return { context, worker, extensionId, page, card, open };
}

async function save(name, extension, write) {
  if (!wanted(name)) return;
  const file = path.join(output, `${name}-${label}.${extension}`);
  await fs.mkdir(output, { recursive: true });
  await write(file);
  console.log(path.relative(root, file));
}

// The card asks the worker to size its frame a moment after its state changes: wait until the frame holds still.
async function cardShot(session, name) {
  const { page } = session;
  const frame = await session.card();
  await frame.evaluate(() => document.fonts.ready.then(() => {}));
  let last;
  await expect.poll(async () => {
    const now = await page.evaluate(() => document.querySelector('[data-secondhand-assistant]')?.getAttribute('style') || '');
    const still = now === last; last = now;
    return still;
  }, { intervals: [700], timeout: 15000 }).toBe(true);
  // The pointer leaves the card by way of its logo, so no button is drawn hovered.
  const box = await page.locator('[data-secondhand-assistant]').boundingBox();
  await page.mouse.move(box.x + 23, box.y + box.height / 2);
  await page.mouse.move(10, 10);
  await page.waitForTimeout(200);
  await save(name, 'png', file => page.screenshot({ path: file, clip: CARD }));
}

async function openPanel(session) {
  await (await session.card()).locator('#details').click();
  const panel = await smoke.attachNativePanel(session.context, session.page, session.extensionId);
  // Chrome lays the panel out a moment after it opens.
  await expect.poll(() => panel.evaluate(() => innerWidth), { timeout: 15000 }).toBeGreaterThan(0);
  const size = await panel.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }));
  assert.deepEqual(size, { width: 360, height: 765, scale: 2 }, 'the side panel is captured at one size');
  return panel;
}
// The side panel checks the tab every second and a half; `ready` says when it shows the state to capture.
async function panelShot(session, panel, name, ready, { scroll = 0, clip } = {}) {
  await expect.poll(() => panel.evaluate(ready), { timeout: 20000 }).toBe(true);
  await panel.evaluate(scroll => document.fonts.ready.then(() => { document.getElementById('sidepanel').scrollTop = scroll; }), scroll);
  // The pointer rests on the header's logo, so nothing is drawn hovered.
  await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 30, y: 30 });
  await session.page.waitForTimeout(400);
  await save(name, 'png', async file => {
    if (!clip) return panel.screenshot(file);
    const { data } = await panel.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    await fs.writeFile(file, Buffer.from(data, 'base64'));
  });
}
// The panel reads the desktop's status when it opens, after an Autofill, and when its window is shown again.
const recheck = panel => panel.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
const chooseLanguage = (panel, code) => panel.evaluate(code => { const select = document.getElementById('language'); select.value = code; select.dispatchEvent(new Event('change')); }, code);
const text = (panel, selector) => panel.evaluate(selector => document.querySelector(selector)?.textContent || '', selector);

// Headless Chromium has no on-device models. Chrome itself logs these two lines when a page asks for one;
// SecondHand catches both failures and carries on.
const NO_MODEL = ['Unable to create a text session because the service is not running.', 'The language detection model was required but not available.'];
// Every error and warning the extension logged or threw in this session, in any of its pages or its worker.
async function expectNoErrors(session) {
  const page = await session.context.newPage();
  try {
    await page.goto('chrome://extensions');
    const info = await page.evaluate(id => new Promise(resolve => chrome.developerPrivate.getExtensionInfo(id, resolve)), session.extensionId);
    assert.deepEqual(info.errorCollection, { isActive: true, isEnabled: true }, 'Chrome is keeping the extension’s errors');
    const errors = [...info.manifestErrors, ...info.runtimeErrors].filter(error => !NO_MODEL.includes(error.message)).map(error => `${error.source}: ${error.message}`);
    assert.deepEqual(errors, [], 'the extension logged errors');
  } finally { await page.close(); }
}

async function withSession(extensionDirectory, options, work) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-capture-'));
  let session;
  try {
    session = await launch(userData, extensionDirectory, options);
    await work(session);
    await expectNoErrors(session);
  } finally {
    if (session) await session.context.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
// A temporary copy of the extension, changed by `edit` before Chrome loads it.
async function withCopy(edit, work) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-capture-copy-'));
  const copy = path.join(temporary, 'extension');
  try {
    await fs.cp(smoke.extensionDirectory, copy, { recursive: true });
    await edit(copy);
    await work(copy);
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

// The card on Iowa's application, with the side panel closed: an open panel covers the page's corner.
async function iowaCard() {
  await withSession(smoke.extensionDirectory, {}, async session => {
    const { page, open, card } = session;
    await open(applicant);
    await expect((await card()).locator('#autofill')).toBeVisible();
    await cardShot(session, 'card-ready');
    // Tab from the logo, so the button shows the ring a keyboard gives it.
    await (await card()).locator('#details').focus();
    await page.keyboard.press('Tab');
    await expect((await card()).locator('#autofill:focus-visible')).toBeVisible();
    await cardShot(session, 'card-focus');

    await open(applicant, { profile: { ...smoke.syntheticProfile, firstName: '' } });
    await (await card()).locator('#autofill').click();
    await expect((await card()).locator('#need-you')).toBeVisible({ timeout: 20000 });
    await cardShot(session, 'card-need-you');

    await open(screen('household'));
    await (await card()).locator('#autofill').click();
    // "Filled 1 · Solve the CAPTCHA, then click Continue.", once the fill has settled.
    await expect((await card()).locator('#widget-text')).toContainText('·', { timeout: 20000 });
    await cardShot(session, 'card-message');

    await open(applicant, { locked: true });
    await (await card()).locator('#autofill').click();
    await expect((await card()).locator('#unlock')).toBeVisible({ timeout: 20000 });
    await cardShot(session, 'card-locked');

    await open(applicant, { closed: true });
    await (await card()).locator('#autofill').click();
    await expect((await card()).locator('#open-app')).toBeVisible({ timeout: 20000 });
    await cardShot(session, 'card-closed');

    await open(UNKNOWN);
    await expect((await card()).locator('#pill')).toBeVisible();
    await cardShot(session, 'card-pill');
  });
}

// The side panel on Iowa's application, in English, Spanish, and Arabic.
async function iowaPanel() {
  await withSession(smoke.extensionDirectory, {}, async session => {
    const { page, worker, open } = session;
    const missingName = { profile: { ...smoke.syntheticProfile, firstName: '' } };
    const listed = () => document.querySelectorAll('#page-checklist .checklist-item').length > 0;
    await open(applicant, missingName);
    const panel = await openPanel(session);
    await panelShot(session, panel, 'panel-iowa', listed);
    await panelShot(session, panel, 'panel-header', listed, { clip: { x: 0, y: 0, width: 360, height: 72 } });
    // Tab to Autofill from the control before it, so the button shows the ring a keyboard gives it.
    await panel.evaluate(() => {
      const controls = [...document.querySelectorAll('button, select')].filter(control => !control.disabled && control.getClientRects().length);
      controls[controls.indexOf(document.getElementById('panel-autofill')) - 1].focus();
    });
    for (const type of ['keyDown', 'keyUp']) await panel.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await panelShot(session, panel, 'panel-focus', () => document.activeElement?.id === 'panel-autofill');
    await panel.evaluate(() => document.activeElement.blur());

    await panel.click('#panel-autofill');
    const filled = () => document.querySelector('[data-key="lastName"]')?.classList.contains('complete') === true;
    await panelShot(session, panel, 'panel-iowa-filled', filled);
    await panelShot(session, panel, 'panel-checklist', filled, { scroll: 100000 });

    await open(applicant, { locked: true });
    await recheck(panel);
    await panelShot(session, panel, 'panel-locked', () => !document.getElementById('desktop-action').hidden && document.querySelectorAll('.checklist-item').length > 0);
    await open(applicant, { closed: true });
    await recheck(panel);
    await panelShot(session, panel, 'panel-closed', () => !document.getElementById('desktop-action').hidden && document.querySelectorAll('.checklist-item').length > 0);

    // An information-only screen: nothing to fill, and Chrome here has no summary model.
    await open(screen('instructions'));
    await recheck(panel);
    await page.waitForTimeout(2500);
    await panelShot(session, panel, 'panel-info', () => !document.getElementById('panel-autofill').disabled);
    // A tab SecondHand can't read.
    await page.goto('about:blank');
    await panelShot(session, panel, 'panel-elsewhere', () => document.getElementById('panel-autofill').disabled && Boolean(document.getElementById('status').textContent));

    // Arabic reads right to left. Spanish lists the page's questions in Spanish.
    await open(applicant);
    await recheck(panel);
    await expect.poll(() => panel.evaluate(listed), { timeout: 20000 }).toBe(true);
    await chooseLanguage(panel, 'ar');
    await panelShot(session, panel, 'panel-arabic', () => document.documentElement.dir === 'rtl' && document.querySelectorAll('.checklist-item').length > 0);
    await chooseLanguage(panel, 'es');
    await expect.poll(() => panel.visible('#questions-show'), { timeout: 20000 }).toBe(true);
    await panel.click('#questions-show');
    await expect.poll(() => panel.evaluate(() => document.querySelectorAll('#questions-list > *').length > 0), { timeout: 20000 }).toBe(true);
    const top = await panel.evaluate(() => document.getElementById('questions-show').getBoundingClientRect().top + document.getElementById('sidepanel').scrollTop - document.querySelector('.panel-header').offsetHeight - 12);
    await panelShot(session, panel, 'panel-questions', () => !document.getElementById('questions').hidden, { scroll: top });
    await chooseLanguage(panel, 'en');
    assert.equal(await worker.evaluate(() => globalThis.__desktop.closed), false);
    await panel.close();
  });
}

// Other websites. Chrome can't show its permission prompt to a script, so a first launch of a copy of the
// extension lists these sites as required host permissions, which Chrome grants at load. The second launch,
// on the same profile, uses the shipped manifest: the panel's own request then resolves without a prompt.
async function granted(work) {
  await withCopy(async () => {}, async copy => {
    const manifestPath = path.join(copy, 'manifest.json');
    const shipped = await fs.readFile(manifestPath, 'utf8');
    const granting = JSON.parse(shipped);
    granting.host_permissions = [...granting.host_permissions, 'https://*/*', ...[PANTRY, DESPENSA].map(url => `${new URL(url).origin}/*`)];
    const session = async work => {
      const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-capture-'));
      let running;
      try {
        await fs.writeFile(manifestPath, JSON.stringify(granting));
        await (await launch(userData, copy)).context.close();
        await fs.writeFile(manifestPath, shipped);
        running = await launch(userData, copy);
        await work(running);
        await expectNoErrors(running);
      } finally {
        if (running) await running.context.close().catch(() => {});
        await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    };
    await work(session);
  });
}
const turnOn = session => session.worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return enableSite(tab.id); });

async function sites() {
  await granted(async session => {
    await session(async running => {
      const { page, worker, open } = running;
      await open(applicant);
      const panel = await openPanel(running);
      const shown = id => panel.evaluate(id => !document.getElementById(id).hidden, id);
      // A site that is off, with Laya ready.
      await open(PANTRY, { laya: 'ready' });
      await recheck(panel);
      await panelShot(running, panel, 'panel-site-off', () => !document.getElementById('site-enable').hidden);
      await panel.click('#site-enable');
      await expect.poll(() => shown('site-disable'), { timeout: 20000 }).toBe(true);
      await panel.click('#panel-autofill');
      await expect(page.locator('#fname')).toHaveValue(smoke.syntheticProfile.firstName, { timeout: 20000 });
      await page.waitForTimeout(2000);
      await panelShot(running, panel, 'panel-site-filled', () => !document.getElementById('panel-autofill').disabled && /\d/.test(document.getElementById('status').textContent));
      // The same site with Laya turned off in the app.
      await open(PANTRY, { laya: 'off' });
      await recheck(panel);
      await page.waitForTimeout(2000);
      await panelShot(running, panel, 'panel-laya-off', () => !document.getElementById('panel-autofill').disabled);
      // An answer the profile lacks, typed on the page: Save to My information.
      await open(HOUSEHOLD, { laya: 'ready' });
      await recheck(panel);
      await expect.poll(() => panel.evaluate(() => !document.getElementById('panel-autofill').disabled), { timeout: 20000 }).toBe(true);
      await panel.click('#panel-autofill');
      await expect.poll(() => shown('save-section'), { timeout: 20000 }).toBe(true);
      await page.locator('#apt').fill('Unit 5');
      await panelShot(running, panel, 'panel-save', () => Boolean(document.querySelector('[data-save-id] button')));
      // All websites on, then off: the notice says how to remove the access Chrome keeps.
      await panel.click('#all-sites-enable');
      await expect.poll(() => shown('all-sites-disable'), { timeout: 20000 }).toBe(true);
      await panel.click('#all-sites-disable');
      await panelShot(running, panel, 'panel-all-sites-off', () => !document.getElementById('all-sites-enable').hidden && !document.getElementById('all-sites-enable').disabled);
      assert.equal(await worker.evaluate(() => allSitesOn()), false);
      await panel.close();
    });
    // The card on other sites, with the side panel closed.
    await session(async running => {
      const { page, open, card } = running;
      await open(PANTRY);
      await turnOn(running);
      await open(PANTRY);
      await (await card()).locator('#autofill').click();
      await expect(page.locator('#fname')).toHaveValue(smoke.syntheticProfile.firstName, { timeout: 20000 });
      await expect((await card()).locator('#need-you')).toBeVisible({ timeout: 20000 });
      await cardShot(running, 'card-site');
      // A page in Spanish for an English reader: the card offers its questions in English.
      await open(DESPENSA);
      await turnOn(running);
      await open(DESPENSA);
      await expect((await card()).locator('#translate-offer')).toBeVisible({ timeout: 20000 });
      await cardShot(running, 'card-offer');
    });
  });
}

// Pages from a newer build than the worker Chrome still runs: both surfaces show the steps to reload.
async function outdated() {
  await withCopy(async copy => {
    const file = path.join(copy, 'panel.js');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/const BUILD = '[^']+'/, 'const BUILD = \'2099-01-01.1\''));
  }, copy => withSession(copy, {}, async session => {
    const { open, card } = session;
    await open(applicant);
    const frame = await card();
    await expect(frame.locator('#widget')).toHaveClass(/outdated/, { timeout: 20000 });
    await cardShot(session, 'card-outdated');
    // An outdated card hides its buttons. Show the logo again for one click, which opens the side panel.
    await frame.evaluate(() => { document.querySelector('.widget-row').style.display = 'flex'; });
    const panel = await openPanel(session);
    await frame.evaluate(() => { document.querySelector('.widget-row').style.display = ''; });
    await panelShot(session, panel, 'panel-outdated', () => document.getElementById('status').classList.contains('error'));
    await panel.close();
  }));
}

// A short recording of the card at work: Autofill, then the link to the answer that is missing.
async function recording() {
  const run = promisify(execFile);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-capture-film-'));
  try {
    let video, begins;
    const started = Date.now();
    await withSession(smoke.extensionDirectory, { viewport: FILM, scale: 1, video: temporary }, async session => {
      const { page, open, card } = session;
      await open(applicant, { profile: { ...smoke.syntheticProfile, firstName: '' } });
      await expect((await card()).locator('#autofill')).toBeVisible();
      // Chrome records no pointer, so the page draws one that follows each move.
      await page.evaluate(() => {
        const pointer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        pointer.id = 'capture-pointer';
        pointer.setAttribute('viewBox', '0 0 28 34');
        pointer.innerHTML = '<path d="M3 2v24l6-6 5 11 5-2-5-11h10L3 2Z" fill="#163a2c" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>';
        pointer.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:27px;z-index:2147483647;pointer-events:none;transform:translate(300px,260px);transition:transform 700ms ease';
        document.documentElement.append(pointer);
      });
      const clickOn = async selector => {
        const box = await (await card()).locator(selector).boundingBox();
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.evaluate(point => { document.getElementById('capture-pointer').style.transform = `translate(${point.x}px,${point.y}px)`; }, point);
        await page.waitForTimeout(900);
        await page.mouse.click(point.x, point.y);
      };
      await page.waitForTimeout(600);
      begins = Date.now() - started;
      await page.waitForTimeout(800);
      await clickOn('#autofill');
      await expect((await card()).locator('#need-you')).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1600);
      await clickOn('#need-you');
      await expect.poll(() => page.evaluate(() => document.activeElement.id), { timeout: 20000 }).toBe('firstName');
      await page.waitForTimeout(1800);
      video = await page.video().path();
    });
    await save('card-autofill', 'gif', async file => {
      // The recording starts when Chrome does; the film starts once the page and its card are ready.
      const filter = 'fps=10,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', (begins / 1000).toFixed(2), '-i', video, '-vf', filter, file]);
    });
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

const sessions = [
  [iowaCard, ['card-ready', 'card-focus', 'card-need-you', 'card-message', 'card-locked', 'card-closed', 'card-pill']],
  [iowaPanel, ['panel-iowa', 'panel-header', 'panel-focus', 'panel-iowa-filled', 'panel-checklist', 'panel-locked', 'panel-closed', 'panel-info', 'panel-elsewhere', 'panel-arabic', 'panel-questions']],
  [sites, ['panel-site-off', 'panel-site-filled', 'panel-laya-off', 'panel-save', 'panel-all-sites-off', 'card-site', 'card-offer']],
  [outdated, ['card-outdated', 'panel-outdated']],
  [recording, ['card-autofill']]
];

async function main() {
  if (!/^[a-z0-9-]+$/.test(label || '')) throw new Error('Usage: node scripts/capture-ui.cjs <label> [shot name, or the start of one ending in a hyphen...]');
  const names = sessions.flatMap(([, names]) => names);
  const unknown = only.filter(asked => !names.some(name => asked.endsWith('-') ? name.startsWith(asked) : name === asked));
  if (unknown.length) throw new Error(`No shot is named ${unknown.join(' or ')}. The shots are ${names.join(', ')}.`);
  for (const [session, names] of sessions) if (names.some(wanted)) await session();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
