'use strict';

// Live QA of SecondHand on everyday websites: the real extension, with SecondHand on for all websites, on
// real public pages. For each page it waits for the card (or its absence), clicks Autofill once, and
// records what each question holds afterwards, the card's words, page and extension errors, and a
// screenshot. The desktop app is a DevTools stub answering with the fictional profile in
// tests/fixtures/applicant-profile.json (Always allow on, Laya off). Nothing is ever submitted: the run
// never clicks Next, Submit or Save, and any request that carries a saved value is reported.
//
//   npm run qa:any-website -- <label> [name,name,...]
// A third-party page can change or block a headless browser at any time, so this is a report to read, not a gate.
// It writes artifacts/qa-any/<label>/results.json and a screenshot of each page.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const profile = require('../tests/fixtures/applicant-profile.json');

const ROOT = path.join(__dirname, '..');
const EXT_ID = 'jogldddafjfbmfjnjlbjloakjbecnjpl';
const LAUNCHER = `chrome-extension://${EXT_ID}/panel.html?surface=launcher`;
const SAVED = [profile.firstName, profile.lastName, profile.email, profile.phone, profile.mobilePhone, profile.addressLine1];

// expect: 'form' (a card should come and fill something), 'none' (no card: search or reading only).
const SITES = {
  'gforms-csi': { url: 'https://docs.google.com/forms/d/e/1FAIpQLSePpl2_E4U4RduWCqiB5M6h5rH3LVFPFKGsgNc2mLdwDOLT7Q/viewform', expect: 'form' },
  'gforms-hornets': { url: 'https://docs.google.com/forms/d/e/1FAIpQLSd0cnJkLvgaP_oRQGFJZUGGUaWnpl2CJ3qJrgJ5YVFBWsvYNQ/viewform', expect: 'form' },
  'jotform-insecurity': { url: 'https://form.jotform.com/220655704608052', expect: 'form' },
  'demoqa': { url: 'https://demoqa.com/automation-practice-form', expect: 'form' },
  'selenium-webform': { url: 'https://www.selenium.dev/selenium/web/web-form.html', expect: 'form' },
  'formy': { url: 'https://formy-project.herokuapp.com/form', expect: 'form' },
  'httpbin': { url: 'https://httpbin.org/forms/post', expect: 'form' },
  'w3schools-form': { url: 'https://www.w3schools.com/html/tryit.asp?filename=tryhtml_form_submit', expect: 'form' },
  'login-only': { url: 'https://the-internet.herokuapp.com/login', expect: 'none' },
  'wikipedia': { url: 'https://en.wikipedia.org/wiki/Supplemental_Nutrition_Assistance_Program', expect: 'none' },
  'usda-snap': { url: 'https://www.fns.usda.gov/snap/supplemental-nutrition-assistance-program', expect: 'none' },
  'feeding-america': { url: 'https://www.feedingamerica.org/find-your-local-foodbank', expect: 'none' },
  'salesforce-trial': { url: 'https://www.salesforce.com/form/signup/freetrial-sales/', expect: 'form' },
  'github-signup': { url: 'https://github.com/signup', expect: 'form' },
  'redcross-volunteer': { url: 'https://www.redcross.org/volunteer/become-a-volunteer.html', expect: 'none' },
  'mailchimp-signup': { url: 'https://login.mailchimp.com/signup/', expect: 'form' },
  'wufoo-example': { url: 'https://examples.wufoo.com/forms/contact-form/', expect: 'form' },
  'tutorialspoint': { url: 'https://www.tutorialspoint.com/selenium/practice/selenium_automation_practice.php', expect: 'form' },
  'uitesting-sample': { url: 'https://www.globalsqa.com/samplepagetest/', expect: 'form' },
  'iowa-hhs-home': { url: 'https://hhs.iowa.gov/food-assistance', expect: 'none' },
  'foodbankiowa': { url: 'https://www.foodbankiowa.org/contact-us', expect: 'form' },
  'testautomation-blog': { url: 'https://testautomationpractice.blogspot.com/', expect: 'form' },
  'lambdatest-input': { url: 'https://www.lambdatest.com/selenium-playground/input-form-demo', expect: 'form' },
  'expandtesting-inputs': { url: 'https://practice.expandtesting.com/inputs', expect: 'form' },
  'techlistic': { url: 'https://www.techlistic.com/p/selenium-practice-form.html', expect: 'form' },
  'hubspot-contact': { url: 'https://www.hubspot.com/company/contact', expect: 'form' },
  'jotform-template': { url: 'https://www.jotform.com/form-templates/food-bank-registration-form', expect: 'form' },
  '211': { url: 'https://www.211.org/', expect: 'none' },
  'nifb': { url: 'https://solvehungertoday.org/get-help/', expect: 'none' },
  'bbc-news': { url: 'https://www.bbc.com/news', expect: 'none' },
  'mdn-form-example': { url: 'https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/Your_first_form', expect: 'none' },
  'usa-gov': { url: 'https://www.usa.gov/food-help', expect: 'none' }
};

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const decoded = text => { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; } };

// The desktop as the worker sees it: unlocked, all websites trusted, Always allow on, Laya off.
function installDesktop(profile) {
  globalThis.__desktop = { calls: [], profile };
  nativeRequest = async (type, payload = {}) => {
    globalThis.__desktop.calls.push({ type, fields: payload.fields || [] });
    switch (type) {
      case 'status': return { unlocked: true, applicationCount: 0, accessRevision: 0, allSites: true, laya: { state: 'unavailable' }, customFieldsAvailable: false };
      case 'trustAllSites': return { allSites: true };
      case 'trustSite': return { trusted: true, origin: new URL(payload.url).origin };
      case 'authorizeSiteNavigation': return { accessRevision: 0 };
      case 'warmLaya': return { state: 'unavailable' };
      case 'suggestFields': case 'answerFields': throw Object.assign(new Error('Laya isn’t ready on this computer.'), { code: 'LAYA_NOT_READY' });
      case 'getFields': return { accessRevision: 0, values: Object.fromEntries(payload.fields.filter(field => profile[field]).map(field => [field, profile[field]])) };
      case 'recordProgress': return { recorded: true };
      case 'showApp': case 'openHousehold': return { shown: true };
      default: throw new Error(`The any-website QA has no stub for ${type}`);
    }
  };
}

// Every visible control in a frame, open shadow roots included: what it is and what it holds.
function readControls() {
  const out = [];
  const visit = root => {
    for (const el of root.querySelectorAll('input,select,textarea,[contenteditable="true"],[role="radio"],[role="checkbox"]')) {
      if (el.type === 'hidden' || ['submit', 'button', 'reset', 'image', 'file'].includes(el.type)) continue;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if ((!rect.width && !rect.height) || style.visibility === 'hidden' || style.display === 'none') {
        if (!['radio', 'checkbox'].includes(el.type)) continue;
      }
      const label = (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const value = ['radio', 'checkbox'].includes(el.type) ? (el.checked ? 'checked' : '') : el.getAttribute('role') ? el.getAttribute('aria-checked') === 'true' ? 'checked' : ''
        : el.isContentEditable ? el.textContent.trim() : el.tagName === 'SELECT' ? (el.selectedOptions[0]?.textContent.trim() ?? '') : el.value;
      out.push({ label, type: el.type || el.getAttribute('role') || el.tagName.toLowerCase(), value, mark: el.getAttribute('data-secondhand-filled') ?? el.closest('[data-secondhand-filled]')?.getAttribute('data-secondhand-filled') ?? null });
    }
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) visit(host.shadowRoot);
  };
  visit(document);
  return out;
}

async function snapshot(page) {
  const frames = [];
  for (const frame of page.frames()) {
    if (frame.url().startsWith('chrome-extension:') || frame.url() === 'about:blank') continue;
    try { frames.push({ url: frame.url(), controls: await frame.evaluate(readControls) }); } catch (error) { frames.push({ url: frame.url(), error: error.message.split('\n')[0] }); }
  }
  return frames;
}

async function oneSite(context, worker, name, site, shots) {
  const record = { name, url: site.url, expect: site.expect, notes: [] };
  const sent = [];
  const onRequest = request => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    const body = request.postData() || '';
    if (SAVED.some(value => body.includes(value) || decoded(body).includes(value))) sent.push(`${request.method()} ${request.url().slice(0, 120)}`);
  };
  context.on('request', onRequest);
  const page = await context.newPage();
  page.on('pageerror', error => record.notes.push(`page error: ${error.message.slice(0, 200)}`));
  page.on('console', message => { if (message.type() === 'error' && /secondhand/i.test(message.text())) record.notes.push(`console: ${message.text().slice(0, 200)}`); });
  try {
    await page.goto(site.url, { waitUntil: 'load', timeout: 45000 }).catch(error => record.notes.push(`load: ${error.message.split('\n')[0]}`));
    await sleep(4000);
    record.title = await page.title().catch(() => '');
    const before = await snapshot(page);
    record.controls = before.reduce((sum, frame) => sum + (frame.controls?.length || 0), 0);
    let widget = null;
    for (let i = 0; i < 20 && !widget; i++) { widget = page.frames().find(frame => frame.url() === LAUNCHER); if (!widget) await sleep(500); }
    record.card = Boolean(widget);
    record.cardHosts = await page.locator('[data-secondhand-assistant]').count();
    if (widget) {
      await widget.locator('#widget-text').waitFor({ timeout: 10000 }).catch(() => {});
      record.cardBefore = (await widget.locator('#widget-text').textContent().catch(() => '')).trim();
      const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
      await worker.evaluate(id => results.delete(id), tabId);
      const autofill = widget.locator('#autofill');
      if (await autofill.isVisible().catch(() => false)) {
        const started = Date.now();
        await autofill.click({ timeout: 10000 });
        for (let i = 0; i < 120; i++) { if (await worker.evaluate(id => results.has(id), tabId)) break; await sleep(250); }
        record.clickMs = Date.now() - started;
        record.result = await worker.evaluate(id => { const r = results.get(id); return r && { state: r.state, filled: r.filled, needYou: (r.needYou || []).length, message: r.message }; }, tabId);
        await sleep(800);
        record.cardAfter = (await widget.locator('#widget-text').textContent().catch(() => '')).trim();
        record.needYouText = (await widget.locator('#need-you').textContent().catch(() => '')).trim();
      } else record.notes.push('card has no visible Autofill button');
    }
    const after = await snapshot(page);
    record.changed = [];
    after.forEach((frame, f) => (frame.controls || []).forEach((control, c) => {
      const old = before[f]?.url === frame.url ? before[f].controls?.[c] : null;
      if (control.value !== (old?.value ?? '') || control.mark) record.changed.push({ frame: f ? `${f}:${new URL(frame.url).host}${new URL(frame.url).pathname}` : '', index: c, label: control.label, type: control.type, value: control.value, mark: control.mark });
    }));
    record.screenshot = path.join(shots, `${name}.png`);
    await page.screenshot({ path: record.screenshot, fullPage: false });
    await sleep(1500);
  } catch (error) {
    record.error = error.message.split('\n')[0];
    await page.screenshot({ path: path.join(shots, `${name}-error.png`) }).catch(() => {});
  } finally {
    record.sentSaved = sent;
    context.off('request', onRequest);
    await page.close().catch(() => {});
  }
  return record;
}

async function main() {
  const [label = 'run', only] = process.argv.slice(2);
  const names = only ? only.split(',') : Object.keys(SITES);
  for (const name of names) if (!SITES[name]) throw new Error(`Unknown site: ${name}`);
  const out = path.join(ROOT, 'artifacts', 'qa-any', label);
  await fs.mkdir(path.join(out, 'shots'), { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-qa-any-'));
  const extension = path.join(tmp, 'extension');
  await fs.cp(path.join(ROOT, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...manifest.host_permissions, 'https://*/*'];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const report = { label, started: new Date().toISOString(), runs: [] };
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    worker.on('console', message => { if (message.type() === 'error') report.workerErrors = [...(report.workerErrors || []), message.text().slice(0, 300)]; });
    await worker.evaluate(installDesktop, profile);
    await worker.evaluate(() => enableAllSites());
    for (const name of names) {
      const record = await oneSite(context, worker, name, SITES[name], path.join(out, 'shots'));
      report.runs.push(record);
      const verdict = record.error ? `ERROR ${record.error}` : record.card ? `card: "${record.cardAfter || record.cardBefore}" filled ${record.result?.filled ?? '?'} need ${record.result?.needYou ?? '?'}` : 'no card';
      log(name.padEnd(20), `[expect ${record.expect}]`, `controls ${record.controls}`, verdict, record.notes.length ? `notes ${record.notes.length}` : '', record.sentSaved.length ? 'SENT SAVED VALUE' : '');
    }
  } finally {
    report.finished = new Date().toISOString();
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    await context.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
  log('Wrote', path.join(out, 'results.json'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
