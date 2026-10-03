'use strict';

// Live-form QA of Laya (#42): the real desktop app, extension and Laya model on real pantry forms, with
// the rules alone and with Laya on. macOS only. Everything runs isolated:
// - the desktop app in test mode, with a throwaway data folder in the system temporary directory and a
//   vault made for this run with the fictional profile in tests/fixtures/applicant-profile.json;
// - a throwaway Playwright Chromium profile per run, with this checkout's extension, and the native
//   host registered only inside that profile. Google Chrome, its profile and its native-host
//   registration, and the real SecondHand data folder are never touched.
//
// Each run is a fresh browser. It opens the form, clicks the toolbar icon, turns SecondHand on from the
// side panel ("Turn on", then "Also turn on the embedded form" when there is one), and clicks the
// widget's Autofill once. It never clicks Next, Submit or Save, and never types into a form.
//
// Test glue that stands in for a person's clicks:
// - The extension copy lists the forms' origins as host permissions, so Chrome's own permission prompt
//   is already answered (Playwright can't click it). The side panel still asks Chrome for them.
// - The toolbar icon is clicked with CDP Extensions.triggerAction, and the copy opens its side panel from
//   that click, as Chrome does with openPanelOnActionClick.
// - The desktop's message boxes are answered by a stub that records them: "Trust this site", "Always
//   allow on this computer", and "Allow once" for sensitive details.
// - In headless Chromium a tab that had the side panel open gets no more mouse input, so after turning
//   the site on, the form is opened again in a new tab, where the site and its frames stay on.
//
//   SECONDHAND_LAYA_MODEL_DIR=<export> SECONDHAND_LAYA_MODEL_FORMAT=<format> \
//     node scripts/qa-live-forms.cjs <label> [csi,hornets,sfu,embedded,insecurity,embedded-synthetic] [rules,laya,laya]
//   QA_DESKTOP_ROOT=<checkout> runs another checkout's desktop app (its node_modules included).
// It writes artifacts/qa-live/<label>/results.json, the desktop app's output, and a screenshot of each
// filled form, and prints each run's questions and what they hold after the click.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium, _electron: electron, expect } = require('@playwright/test');
const { attachNativePanel } = require('./smoke-extension.cjs');
const strings = require('../extension/strings.js');
const profile = require('../tests/fixtures/applicant-profile.json');
// What this checkout's desktop asks Laya: which choice questions (factsCover) and which saved fields per text box.
const { factsCover, offeredFields } = require('../shared/laya-prompts.cjs');

const ROOT = path.join(__dirname, '..');
const DESKTOP_ROOT = path.resolve(process.env.QA_DESKTOP_ROOT || ROOT);
const EXT_ID = 'jogldddafjfbmfjnjlbjloakjbecnjpl';
const en = (key, params) => strings.text('en', key, params);

const JOTFORM_INSECURITY = 'https://form.jotform.com/220655704608052';
// The embedded-form page: the README demo's sample pantry page (#40), which embeds the live Jotform
// insecurity survey in an iframe. The test browser serves it itself at a reserved .example origin.
const embeddedPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo Community Pantry · intake</title><style>
  body{margin:0;font:16px/1.5 Georgia,"Times New Roman",serif;background:#fbf6ee;color:#3a2a1c}
  header{display:flex;align-items:center;gap:14px;padding:16px 48px;background:#7a3e1d;color:#fff4e6}
  header strong{font-size:22px}header nav{margin-left:auto;display:flex;gap:26px;font:15px -apple-system,sans-serif;opacity:.9}
  .intro{max-width:980px;margin:0 auto;padding:26px 24px 8px}.intro h1{font-size:30px;margin:0 0 4px}.intro p{margin:0;color:#6b5140}
  .embed{max-width:980px;margin:14px auto 0;background:#fff;border:1px solid #e6d8c4;border-radius:12px;overflow:hidden}
  iframe{width:100%;height:1500px;border:0;display:block}
</style></head><body>
  <header><strong>Demo Community Pantry</strong><span>sample site</span><nav><span>Hours</span><span>Visit</span><span>Volunteer</span></nav></header>
  <div class="intro"><h1>Pantry intake</h1><p>Please complete our intake form before your first visit.</p></div>
  <div class="embed"><iframe title="Intake form" src="${JOTFORM_INSECURITY}"></iframe></div>
</body></html>`;
// #60's synthetic embedded fixture: a pantry page with a synthetic form from another origin in an iframe.
const radios = (name, question) => `<fieldset><legend>${question}</legend><label><input type="radio" name="${name}" value="0">Yes</label><label><input type="radio" name="${name}" value="1">No</label></fieldset>`;
const box = (id, label, type = 'text') => `<label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}">`;
const synthetic = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · synthetic test only</title>
  <style>body{font:16px system-ui;margin:0;padding:24px;background:#f7f8f2;color:#1f2a24}label{display:block;margin:10px 0 4px}input:not([type=radio]){display:block;width:280px;height:30px}
  fieldset{border:1px solid #ccd;margin:12px 0;max-width:520px}fieldset label{display:inline-block;margin-right:10px}iframe{width:640px;height:760px;border:1px solid #ccd}</style></head>
  <body><main><p>SYNTHETIC PANTRY FIXTURE. No real organization or applicant data.</p><h1>${title}</h1><form id="intake">${body}<button type="submit">Submit</button></form></main>
  <script>window.__submits=0;document.getElementById('intake').addEventListener('submit',e=>{e.preventDefault();window.__submits++;});</script></body></html>`;
const FIXTURES = {
  'https://pantry.example/embedded': embeddedPage,
  'https://pantry.example.org/embedded': synthetic('Riverbend pantry (form below)', '<iframe src="https://form.example.org/intake" title="Intake form"></iframe>'),
  'https://form.example.org/intake': synthetic('Embedded intake form', [box('fullName', 'Full name'), box('reach', 'Where can we reach you?', 'email'),
    radios('veteran', 'Is anyone in your household a veteran?'), radios('medicare', 'Does anyone in your household get Medicare?'),
    radios('sixty', 'Is anyone in your household 60 or older?'), radios('pet', 'Do you have a pet?')].join(''))
};
const FORMS = {
  csi: { url: 'https://docs.google.com/forms/d/e/1FAIpQLSePpl2_E4U4RduWCqiB5M6h5rH3LVFPFKGsgNc2mLdwDOLT7Q/viewform' },
  hornets: { url: 'https://docs.google.com/forms/d/e/1FAIpQLSd0cnJkLvgaP_oRQGFJZUGGUaWnpl2CJ3qJrgJ5YVFBWsvYNQ/viewform' },
  // Its questions are on pages 2 and 3, behind Next. Print media shows every page at once (Jotform's
  // own print stylesheet), so nothing has to click Next.
  sfu: { url: 'https://www.jotform.com/251526594376062', print: true },
  embedded: { url: 'https://pantry.example/embedded', frames: true },
  insecurity: { url: JOTFORM_INSECURITY },
  'embedded-synthetic': { url: 'https://pantry.example.org/embedded', frames: true }
};
const ORIGINS = ['https://docs.google.com', 'https://www.jotform.com', 'https://form.jotform.com', 'https://pantry.example', 'https://pantry.example.org', 'https://form.example.org'];
// Distinctive saved values: any of them in a request body means a page sent an answer somewhere.
const SAVED = [profile.firstName, profile.lastName, profile.email, profile.phone, profile.mobilePhone, profile.addressLine1];

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const decoded = text => { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; } };
const load = () => os.loadavg().map(value => value.toFixed(2)).join('/');

// Stops on battery under 40%: the model runs on every core.
function requirePower() {
  const text = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' });
  const percent = Number(text.match(/(\d+)%/)?.[1]);
  if (!/AC Power/.test(text) && !(percent >= 40)) throw new Error(`Stopped: on battery at ${percent}%.`);
  return percent;
}
// Timings start on a quiet machine: a 1-minute load under 6, waiting up to 2 minutes for it.
async function quiet() {
  const started = Date.now();
  while (os.loadavg()[0] >= 6 && Date.now() - started < 120000) await sleep(5000);
  return load();
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('The live-form QA runs on macOS.');
  const [label, formArg, modeArg] = process.argv.slice(2);
  const modelDir = process.env.SECONDHAND_LAYA_MODEL_DIR, modelFormat = process.env.SECONDHAND_LAYA_MODEL_FORMAT;
  if (!label || !modelDir || !modelFormat) throw new Error('Usage: SECONDHAND_LAYA_MODEL_DIR=<export> SECONDHAND_LAYA_MODEL_FORMAT=<format> node scripts/qa-live-forms.cjs <label> [forms] [modes]');
  const formNames = formArg ? formArg.split(',') : Object.keys(FORMS);
  const modes = modeArg ? modeArg.split(',') : ['rules', 'laya', 'laya'];
  for (const name of formNames) if (!FORMS[name]) throw new Error(`Unknown form: ${name}`);
  for (const mode of modes) if (!['rules', 'laya'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  const out = path.join(ROOT, 'artifacts', 'qa-live', label);
  await fs.mkdir(path.join(out, 'shots'), { recursive: true });
  log(`battery ${requirePower()}%, load ${load()}`);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-qa-live-'));
  const desktopData = path.join(tmp, 'desktop');
  await fs.mkdir(desktopData, { mode: 0o700 });
  // The extension ID the app saves on "Prepare Chrome extension". That button also writes Google
  // Chrome's native-host file, so it is never pressed here.
  await fs.writeFile(path.join(desktopData, 'settings.json'), JSON.stringify({ extensionId: EXT_ID, layaEnabled: false }), { mode: 0o600 });
  const electronPath = require(path.join(DESKTOP_ROOT, 'node_modules/electron'));
  const env = { ...process.env, SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_USER_DATA: desktopData, SECONDHAND_LAYA_MODEL_DIR: path.resolve(modelDir), SECONDHAND_LAYA_MODEL_FORMAT: modelFormat };
  delete env.SECONDHAND_USER_DATA;
  delete env.ELECTRON_RUN_AS_NODE;
  // The native host Chromium starts: the same app in native-host mode, bound to the throwaway data.
  const hostScript = path.join(tmp, 'native-host');
  const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
  await fs.writeFile(hostScript, `#!/bin/sh\nunset SECONDHAND_USER_DATA\nexport SECONDHAND_TEST_MODE=1\nexport SECONDHAND_TEST_USER_DATA=${quote(desktopData)}\nexec ${quote(electronPath)} ${quote(DESKTOP_ROOT)} "$@"\n`, { mode: 0o700 });
  const extension = path.join(tmp, 'extension');
  await fs.cp(path.join(ROOT, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...manifest.host_permissions, ...ORIGINS.map(origin => `${origin}/*`)];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));

  const report = { label, desktopRoot: DESKTOP_ROOT, commit: execFileSync('git', ['-C', DESKTOP_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    model: { dir: modelDir, format: modelFormat }, started: new Date().toISOString(), runs: [] };
  const reportPath = path.join(out, 'results.json');
  const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  const appLog = await fs.open(path.join(out, 'desktop.log'), 'w');
  let desktop;
  try {
    desktop = await electron.launch({ executablePath: electronPath, args: [DESKTOP_ROOT], env, timeout: 60000 });
    desktop.process().stdout.on('data', chunk => appLog.write(chunk));
    desktop.process().stderr.on('data', chunk => appLog.write(chunk));
    const win = await desktop.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    win.on('close', () => log('The desktop window closed.'));
    // Message boxes are answered and recorded, and the window stays hidden so it never takes focus.
    await desktop.evaluate(({ dialog, BrowserWindow }) => {
      globalThis.__prompts = [];
      dialog.showMessageBox = async (_window, options) => {
        const pick = ['Trust this site', 'Always allow on this computer', 'Allow once'].map(name => options.buttons.indexOf(name)).find(index => index >= 0) ?? 0;
        globalThis.__prompts.push({ title: options.title, message: options.message, detail: options.detail, answered: options.buttons[pick] });
        return { response: pick };
      };
      for (const window of BrowserWindow.getAllWindows()) { window.hide(); window.show = () => {}; window.focus = () => {}; }
    });
    const password = crypto.randomBytes(18).toString('base64url');
    await win.evaluate(async ({ password, profile }) => {
      await window.secondHand.createVault({ password, allowDeviceReset: false });
      await window.secondHand.saveProfile(profile);
    }, { password, profile });
    const setLaya = async on => {
      if (!(await win.evaluate(() => window.secondHand.status())).unlocked) await win.evaluate(password => window.secondHand.unlock(password), password);
      await win.evaluate(on => window.secondHand.setLayaEnabled(on), on);
      await expect.poll(async () => (await win.evaluate(() => window.secondHand.layaStatus())).state, { timeout: 30000 }).toBe(on ? 'ready' : 'off');
    };

    for (const name of formNames) {
      const counts = {};
      for (const mode of modes) {
        requirePower();
        counts[mode] = (counts[mode] || 0) + 1;
        const run = `${name}-${mode}${mode === 'laya' ? counts[mode] : ''}`;
        await setLaya(mode === 'laya');
        const record = await oneRun({ name, run, mode, form: FORMS[name], tmp, extension, hostScript, desktop, shots: path.join(out, 'shots') });
        report.runs.push(record);
        await save();
        log(run, record.error ? `FAILED: ${record.error.split('\n')[0]}` : `"${record.widget.text}" ${record.widget.needYou} | Laya ${record.layaMs.total} ms`);
      }
    }
    report.finished = new Date().toISOString();
    await save();
  } finally {
    try { if (desktop) await desktop.close(); }
    finally {
      await appLog.close();
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  printReport(report);
  log('Wrote', reportPath);
  if (report.runs.some(run => run.error)) process.exitCode = 1;
}

// One fresh browser: open the form, turn SecondHand on from the side panel, click Autofill once, record.
async function oneRun({ name, run, mode, form, tmp, extension, hostScript, desktop, shots }) {
  const profileDir = path.join(tmp, `chromium-${run}`);
  await fs.mkdir(path.join(profileDir, 'NativeMessagingHosts'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'NativeMessagingHosts', 'org.secondhand.bridge.json'),
    JSON.stringify({ name: 'org.secondhand.bridge', description: 'SecondHand live-form QA', path: hostScript, type: 'stdio', allowed_origins: [`chrome-extension://${EXT_ID}/`] }));
  const record = { name, run, mode, url: form.url, at: new Date().toISOString() };
  const sent = [];
  const notes = [];
  let context, panel, page, worker;
  await desktop.evaluate(() => { globalThis.__runMark = globalThis.__prompts.length; });
  try {
    context = await chromium.launchPersistentContext(profileDir, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging'] });
    await context.route(/^https:\/\/(pantry\.example(\.org)?|form\.example\.org)\//, route => {
      const body = FIXTURES[route.request().url()];
      return body ? route.fulfill({ status: 200, contentType: 'text/html', body }) : route.abort('blockedbyclient');
    });
    // Anything a page sends besides fetching: method, host and path, and whether it carried a saved value.
    context.on('request', request => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || /^(chrome-extension|data):/.test(request.url())) return;
      const body = request.postData() || '';
      const url = new URL(request.url());
      sent.push({ method: request.method(), url: `${url.host}${url.pathname}`, savedValue: SAVED.some(value => body.includes(value) || decoded(body).includes(value)) });
    });
    [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    worker.on('console', message => notes.push(`worker ${message.type()}: ${message.text().slice(0, 300)}`));
    await worker.evaluate(installProbes);

    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => notes.push(`page error: ${error.message.slice(0, 200)}`));
    await page.goto(form.url, { waitUntil: 'load', timeout: 60000 });
    if (form.print) await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(2500);
    const origin = new URL(page.url()).origin;
    record.finalUrl = page.url();

    // The toolbar icon, then "Turn on SecondHand for this site" in the side panel.
    const browser = await context.browser().newBrowserCDPSession();
    const tab = (await browser.send('Target.getTargets', { filter: [{}] })).targetInfos.find(target => target.type === 'tab' && target.url === page.url());
    if (!tab) throw new Error('The form’s tab wasn’t found.');
    await browser.send('Extensions.triggerAction', { id: EXT_ID, targetId: tab.targetId });
    panel = await attachNativePanel(context, page, EXT_ID);
    await expect.poll(() => panel.visible('#site-enable'), { timeout: 20000 }).toBe(true);
    record.panelBefore = await panel.text('#status');
    await panel.click('#site-enable');
    await expect.poll(() => panel.text('#status'), { timeout: 30000 }).toBe(en('panel.siteOn', { host: new URL(origin).host }));
    if (form.frames) {
      await expect.poll(() => panel.visible('#frames-enable'), { timeout: 20000 }).toBe(true);
      record.framesButton = await panel.text('#frames-enable');
      await panel.click('#frames-enable');
      await expect.poll(() => panel.text('#status'), { timeout: 30000 }).toBe(en('panel.framesOn'));
    }
    record.panelLaya = await panel.text('#laya-status');
    await panel.close();
    panel = null;
    const windowId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(item => item.url === url)?.windowId, page.url());
    await worker.evaluate(windowId => chrome.sidePanel.close({ windowId }), windowId);
    await expect.poll(async () => (await browser.send('Target.getTargets', { filter: [{}] })).targetInfos.some(target => target.url === `chrome-extension://${EXT_ID}/panel.html`), { timeout: 10000 }).toBe(false);
    const formPage = await context.newPage();
    formPage.on('pageerror', error => notes.push(`page error: ${error.message.slice(0, 200)}`));
    await formPage.goto(form.url, { waitUntil: 'load', timeout: 60000 });
    if (form.print) await formPage.emulateMedia({ media: 'print' });
    await page.close();
    page = formPage;
    await page.bringToFront();
    await page.waitForTimeout(2500);
    const tabIds = await worker.evaluate(async url => (await chrome.tabs.query({})).filter(item => item.url === url).map(item => item.id), page.url());
    if (tabIds.length !== 1) throw new Error(`Expected one form tab, found ${tabIds.length}.`);
    const [tabId] = tabIds;

    const launcherUrl = `chrome-extension://${EXT_ID}/panel.html?surface=launcher`;
    await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 30000 }).toBe(true);
    const widget = page.frames().find(frame => frame.url() === launcherUrl);
    await expect(widget.locator('#widget-text')).toHaveText(en('widget.siteReady', { host: new URL(origin).host }), { timeout: 30000 });

    // The questions the engine plans in each form frame, tagged, and which of them would go to Laya.
    const frames = await worker.evaluate(async ({ tabId, url }) => (await siteFramePlans(tabId, url)).frames.map(frame => frame.frameId), { tabId, url: page.url() });
    const inventory = [];
    for (const frameId of frames) {
      const [{ result }] = await worker.evaluate(({ tabId, frameId }) => chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: self.__qaTag }), { tabId, frameId });
      if (result.error) throw new Error(`Frame ${frameId}: ${result.error}`);
      inventory.push({ frameId, ...result });
    }
    const layaSees = await worker.evaluate(inventory => layaQuestions(inventory.map(({ frameId, rows }) => ({ frameId,
      plan: { unmatched: rows.filter(row => !row.rule).map(row => ({ id: `qa-${row.i}`, label: row.label, type: row.type, options: row.options })) } })), true), inventory);
    const toLaya = new Map([...layaSees.boxes.map(item => [item.id, { as: 'text box', asked: offeredFields(item).length > 0 }]),
      ...layaSees.choices.map(item => [item.id, { as: 'choice', asked: factsCover(item) }])]);
    record.questions = inventory.flatMap(({ frameId, rows }) => rows.map(row => ({ frameId, ...row, laya: row.rule ? undefined : toLaya.get(`f${frameId}:qa-${row.i}`) || { as: 'never sent' } })));

    // One Autofill click on the widget.
    await worker.evaluate(id => { results.delete(id); globalThis.__native = []; }, tabId);
    record.loadBefore = await quiet();
    const started = Date.now();
    await widget.locator('#autofill').click();
    await expect.poll(() => worker.evaluate(id => results.has(id), tabId), { timeout: 90000, intervals: [100] }).toBe(true);
    record.clickMs = Date.now() - started;
    record.loadAfter = load();
    record.result = await worker.evaluate(id => results.get(id), tabId);
    await page.waitForTimeout(600);
    record.widget = await widget.evaluate(() => ({ text: document.getElementById('widget-text').textContent, needYou: document.getElementById('need-you').hidden ? '' : document.getElementById('need-you').textContent }));
    const native = await worker.evaluate(() => globalThis.__native);
    record.native = native.map(({ start, ...item }) => ({ ...item, at: start - started }));
    const ms = type => native.filter(item => item.type === type).reduce((sum, item) => sum + item.ms, 0);
    // warm: readying the model, before the click's budget starts; total: Laya's requests inside the budget.
    record.layaMs = { warm: ms('warmLaya'), answer: ms('answerFields'), match: ms('suggestFields'), total: ms('answerFields') + ms('suggestFields') };

    // What each question holds now, and which went to "need you".
    const needByFrame = new Map();
    for (const id of record.result.needYou || []) {
      const frameId = Number(id.slice(1, id.indexOf(':')));
      needByFrame.set(frameId, [...(needByFrame.get(frameId) || []), id.slice(id.indexOf(':') + 1)]);
    }
    const after = [];
    for (const frameId of frames) {
      const [{ result }] = await worker.evaluate(({ tabId, frameId, ids }) => chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: self.__qaRead, args: [ids] }), { tabId, frameId, ids: needByFrame.get(frameId) || [] });
      after.push({ frameId, ...result });
    }
    for (const question of record.questions) {
      const frame = after.find(item => item.frameId === question.frameId);
      const state = frame.tagged.find(item => item.i === question.i);
      question.mark = state?.mark || null;
      question.value = state?.mark ? state.value : null;
      question.needYou = frame.needYou.some(item => item.i === question.i);
    }
    record.revealedFilled = after.flatMap(item => item.extra.map(extra => ({ frameId: item.frameId, ...extra })));
    record.needYouUntagged = after.flatMap(item => item.needYou.filter(entry => entry.i === null).map(entry => ({ frameId: item.frameId, ...entry })));

    record.screenshot = path.join(shots, `${run}.png`);
    await page.screenshot({ path: record.screenshot, fullPage: true });
    // A page that saves answers as they are typed would send them by now.
    await page.waitForTimeout(3000);
    record.submits = await page.evaluate(() => window.__submits ?? null);
    record.urlAfter = page.url();
  } catch (error) {
    record.error = error.stack || error.message;
    record.nativeAtError = await worker?.evaluate(() => globalThis.__native).catch(failure => `unreadable: ${failure.message}`);
    if (page && !page.isClosed()) {
      record.errorShot = path.join(shots, `${run}-error.png`);
      await page.screenshot({ path: record.errorShot, fullPage: true }).catch(failure => { record.errorShot = `not taken: ${failure.message}`; });
    }
  } finally {
    record.sent = sent;
    record.prompts = await desktop.evaluate(() => globalThis.__prompts.slice(globalThis.__runMark));
    record.notes = notes;
    if (panel) await panel.close();
    if (context) await context.close();
    await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return record;
}

// Evaluated in the extension's worker: native request timings, and two functions it injects into form
// frames (in the content scripts' world, where SecondHandGeneric is).
function installProbes() {
  // The toolbar icon opens the side panel (see the header).
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  chrome.action.onClicked.addListener(tab => { chrome.sidePanel.open({ tabId: tab.id }); });
  globalThis.__native = [];
  const original = nativeRequest;
  nativeRequest = async (type, payload = {}) => {
    const item = { type, start: Date.now(), budgetMs: payload.budgetMs, asked: (payload.fields || payload.questions || []).length };
    try {
      const data = await original(type, payload);
      globalThis.__native.push({ ...item, ms: Date.now() - item.start, ...(type === 'answerFields' ? { answers: data?.answers } : type === 'suggestFields' ? { suggestions: data?.suggestions } : {}) });
      return data;
    } catch (error) { globalThis.__native.push({ ...item, ms: Date.now() - item.start, code: error.code, error: error.message }); throw error; }
  };
  // Tags every question the engine plans (data-qa-live) and lists it with the engine's label, type,
  // options and rule match, and the label shown on the page.
  self.__qaTag = function () {
    const engine = globalThis.SecondHandGeneric;
    if (!engine) return { error: 'SecondHand isn’t on in this frame.' };
    const clean = text => (text || '').replace(/\s+/g, ' ').trim();
    const labelOf = el => {
      const legend = el.closest('fieldset')?.querySelector('legend'); if (legend) return clean(legend.textContent);
      const heading = el.closest('[role="listitem"]')?.querySelector('[role="heading"]'); if (heading) return clean(heading.textContent);
      const line = el.closest('.form-line');
      if (line) { const title = clean(line.querySelector('.form-label')?.textContent); const sub = clean(el.closest('.form-sub-label-container')?.querySelector('.form-sub-label')?.textContent); return sub ? `${title} › ${sub}` : title; }
      if (el.labels?.length && !['radio', 'checkbox'].includes(el.type)) return clean(el.labels[0].textContent);
      return el.getAttribute('aria-label') || el.name || el.id;
    };
    const plan = engine.plan(document);
    const rows = [];
    const tag = (id, row) => { const el = engine.elementFor(id); const i = rows.length; if (el) el.setAttribute('data-qa-live', String(i)); rows.push({ i, page: el ? labelOf(el) : '', ...row }); };
    for (const field of plan.matched) tag(field.id, { rule: field.key });
    for (const field of plan.unmatched) tag(field.id, { label: field.label, type: field.type, options: field.options, required: field.required });
    return { url: location.href, rows };
  };
  // After the click: each tagged question's value and mark, filled questions the click revealed, and
  // the need-you questions (ids from the click's last plan in this frame).
  self.__qaRead = function (needYouIds) {
    const engine = globalThis.SecondHandGeneric;
    const clean = text => (text || '').replace(/\s+/g, ' ').trim();
    const optionText = el => clean(el.labels?.[0]?.textContent) || el.getAttribute('aria-label') || el.getAttribute('data-value') || el.value;
    const valueOf = el => {
      const role = el.getAttribute('role');
      if (el.matches('input[type=radio], input[type=checkbox]')) {
        const group = el.name ? [...(el.form ? el.form.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`) : document.getElementsByName(el.name))] : [el];
        const on = group.filter(item => item.checked).map(optionText);
        return on.length ? on.join(' | ') : null;
      }
      if (role === 'radio' || role === 'checkbox') {
        const box = el.closest('[role="radiogroup"], [role="list"], [role="group"], [role="listitem"]') || el.parentElement;
        const on = [...box.querySelectorAll(`[role="${role}"][aria-checked="true"]`)].map(item => item.getAttribute('aria-label') || item.getAttribute('data-value') || clean(item.textContent));
        return on.length ? on.join(' | ') : null;
      }
      if (el.tagName === 'SELECT') return el.value ? clean(el.selectedOptions[0]?.textContent) : null;
      if (role === 'listbox') { const chosen = el.querySelector('[aria-selected="true"]'); return chosen ? chosen.getAttribute('data-value') || clean(chosen.textContent) : null; }
      return el.value || null;
    };
    const tagged = [...document.querySelectorAll('[data-qa-live]')].map(el => ({ i: Number(el.getAttribute('data-qa-live')), mark: el.getAttribute('data-secondhand-filled'), value: valueOf(el) }));
    const extra = [...document.querySelectorAll('[data-secondhand-filled]')].filter(el => !el.hasAttribute('data-qa-live') && !el.closest('[role="radiogroup"], [role="listitem"], fieldset, .form-line')?.querySelector('[data-qa-live]'))
      .map(el => ({ mark: el.getAttribute('data-secondhand-filled'), value: valueOf(el), name: el.name || el.getAttribute('aria-label') || el.tagName }));
    const needYou = needYouIds.map(id => { const el = engine.elementFor(id); return { id, i: el?.hasAttribute('data-qa-live') ? Number(el.getAttribute('data-qa-live')) : null, page: el ? labelOf(el) : '(gone)' }; });
    function labelOf(el) { return clean(el.closest('.form-line, [role="listitem"], fieldset')?.innerText?.split('\n')[0]) || el.getAttribute('aria-label') || el.name; }
    return { tagged, extra, needYou };
  };
}

function printReport(report) {
  console.log(`\n${report.label}: desktop ${report.commit}, model ${report.model.dir} (${report.model.format})`);
  for (const run of report.runs) {
    console.log(`\n${run.run}  ${run.url}`);
    if (run.error) { console.log(`  FAILED: ${run.error.split('\n')[0]}`); continue; }
    const filled = run.questions.filter(question => question.mark);
    console.log(`  ${run.questions.length} questions, ${filled.length} filled (${filled.filter(question => question.mark === 'guess').length} guesses), ${run.result.needYou?.length ?? 0} need you. ` +
      `Widget: "${run.widget.text}" ${run.widget.needYou}. Click ${run.clickMs} ms. Laya: ready ${run.layaMs.warm} ms, then ${run.layaMs.answer} ms answering and ${run.layaMs.match} ms matching (load ${run.loadBefore}).`);
    for (const question of run.questions) {
      const why = question.rule ? `rule ${question.rule}` : `${question.type}, Laya: ${question.laya.as}${question.laya.asked === false ? ' (not asked)' : ''}`;
      const state = question.mark ? `${question.mark}: ${question.value}` : question.needYou ? 'need you' : '-';
      console.log(`  - ${(question.label || question.page).slice(0, 80)} [${why}] -> ${state}`);
    }
    for (const extra of run.revealedFilled) console.log(`  - revealed and filled: ${extra.name} -> ${extra.mark}: ${extra.value}`);
    for (const prompt of run.prompts) console.log(`  prompt: ${prompt.title} "${prompt.message}" -> ${prompt.answered}`);
    const withValues = run.sent.filter(item => item.savedValue);
    console.log(`  The page sent ${run.sent.length} non-GET requests${withValues.length ? `, ${withValues.length} with a saved value: ${withValues.map(item => item.url).join(', ')}` : ', none with a saved value'}. Screenshot: ${run.screenshot}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
