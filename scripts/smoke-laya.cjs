'use strict';

// Real Chromium smoke for Laya on a trusted pantry form (#39, #42). The desktop app, and Laya
// inside it, are DevTools stubs of the worker's native requests: they implement suggestFields and
// answerFields with the bridge's shapes. A temporary copy of the extension also lists the synthetic
// pantry origin as a host permission (same key, so the same extension ID), so no Chrome prompt is
// needed; the site is then turned on through the worker's own enableSite path. All fixtures and
// profile data are synthetic, DNS is disabled, and nothing is ever submitted.
// A Spanish form (#84) goes through Chrome's own Translator and LanguageDetector in the worker, as this
// Chromium has them: translated for Laya when Chrome has the Spanish model, else kept from Laya with the reason.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const strings = require('../extension/strings.js');
// The fictional applicant as a household of one with no seniors, the household these stand-in decisions read (#98
// gives the shared fixture a fictional household list; Laya's side of a household list is in tests/facts.test.cjs).
const syntheticProfile = { ...require('../tests/fixtures/applicant-profile.json'), householdSize: '1', householdAdults: '1', householdChildren: '0', householdSeniors: '0', householdMembers: [] };
const { attachNativePanel } = require('./smoke-extension.cjs');
const { checkLayaRequests } = require('./smoke-checks.cjs');

const root = path.join(__dirname, '..');
const ORIGIN = 'https://pantry.example.org';
const CONTACT = `${ORIGIN}/intake/contact`;
const HOUSEHOLD = `${ORIGIN}/intake/household`;
const SPANISH = `${ORIGIN}/intake/es`;
const en = (key, params) => strings.text('en', key, params);

const radios = (name, question, [yes, no] = ['Yes', 'No']) => `<fieldset><legend>${question}</legend><label><input type="radio" name="${name}" value="yes">${yes}</label>` +
  `<label><input type="radio" name="${name}" value="no">${no}</label></fieldset>`;
const SIXTY_ES = '¿Hay alguien en su hogar de 60 años o más?';
function pantryPage(title, questions, lang = 'en') {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title} · synthetic test only</title>
    <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:30px}main{max-width:640px}label{display:block;margin:12px 0 4px}
    input:not([type=radio]){display:block;width:300px;height:32px}fieldset{border:1px solid #ced7c5;margin:16px 0;padding:12px}fieldset label{display:inline-block;margin-right:12px}</style></head>
    <body><main><p>SYNTHETIC PANTRY FIXTURE. No real organization or applicant data.</p><h1>${title}</h1>
    <form id="intake">${questions}<button type="submit">Submit</button></form></main>
    <script>window.__submits = 0; document.getElementById('intake').addEventListener('submit', event => { event.preventDefault(); window.__submits++; });</script></body></html>`;
}
const pages = {
  [CONTACT]: pantryPage('Pantry intake: contact', '<label for="name">Full name</label><input id="name" name="name"><label for="reach">Where can we reach you?</label><input id="reach" name="reach" type="email">'),
  [HOUSEHOLD]: pantryPage('Pantry intake: household', `<label for="name">Full name</label><input id="name" name="name">${radios('sixty', 'Is anyone in your household 60 or older?')}${radios('pet', 'Do you have a pet?')}`),
  [SPANISH]: pantryPage('Registro de la despensa', `<label for="name">Nombre completo</label><input id="name" name="name" autocomplete="name">${radios('sixty', SIXTY_ES, ['Sí', 'No'])}`, 'es')
};

// The desktop app with Laya, as the worker sees it over native messaging, with Always allow on. Laya's
// decisions here stand in for the model: the email box is the saved email address, and a household of
// one with no seniors answers "No" to 60 or older. "Do you have a pet?" is something the facts never say.
// Each Laya request must carry the milliseconds its click has left, as the bridge requires. `calls` holds the
// requests since the last page opened, and `all` every request of the run.
async function installDesktop(worker, profile) {
  await worker.evaluate(profile => {
    globalThis.__desktop = { laya: 'ready', calls: [], all: [], profile };
    nativeRequest = async (type, payload = {}) => {
      const desktop = globalThis.__desktop;
      desktop.calls.push({ type, ...JSON.parse(JSON.stringify(payload)) });
      desktop.all.push({ type, ...JSON.parse(JSON.stringify(payload)) });
      if (type === 'status') return { unlocked: true, applicationCount: 0, accessRevision: 0, laya: { state: desktop.laya } };
      if (type === 'warmLaya') return { state: desktop.laya };
      if (type === 'showApp') return { shown: true };
      if (type === 'trustSite') return { trusted: true, origin: new URL(payload.url).origin };
      if (type === 'getFields') return { accessRevision: 0, values: Object.fromEntries(payload.fields.filter(field => desktop.profile[field]).map(field => [field, desktop.profile[field]])) };
      if (type === 'suggestFields' || type === 'answerFields') {
        if (!Number.isInteger(payload.budgetMs) || payload.budgetMs < 1 || payload.budgetMs > 3000) throw new Error('Invalid time budget for Laya.');
        if (desktop.laya !== 'ready') throw Object.assign(new Error('Laya isn’t ready on this computer.'), { code: 'LAYA_NOT_READY' });
        if (type === 'suggestFields') return { suggestions: Object.fromEntries(payload.fields.filter(field => /reach you/i.test(field.label) && field.type === 'email').map(field => [field.id, 'email'])) };
        const noSeniors = desktop.profile.householdSize === '1' && desktop.profile.householdSeniors === '0';
        return { accessRevision: 0, answers: Object.fromEntries(payload.questions.filter(question => /\b60 (years )?or older/i.test(question.label) && noSeniors && question.options.includes('No')).map(question => [question.id, 'No'])) };
      }
      throw new Error(`Unexpected native request in the Laya smoke: ${type}`);
    };
  }, profile);
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-laya-smoke-'));
  const extensionDirectory = path.join(temporary, 'extension');
  const userData = path.join(temporary, 'profile');
  await fs.cp(path.join(root, 'extension'), extensionDirectory, { recursive: true });
  const manifestPath = path.join(extensionDirectory, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...manifest.host_permissions, `${ORIGIN}/*`];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  let context, page, worker, panel;
  const errors = [];
  const requests = [];
  try {
    context = await chromium.launchPersistentContext(userData, {
      channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
      args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1440,1050']
    });
    context.on('request', request => requests.push(request.url()));
    await context.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest() && Object.hasOwn(pages, request.url())) return route.fulfill({ status: 200, contentType: 'text/html', body: pages[request.url()] });
      if (request.url().startsWith('chrome-extension:')) return route.continue();
      return route.abort('blockedbyclient');
    });
    [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).hostname;
    assert.equal(extensionId, 'jogldddafjfbmfjnjlbjloakjbecnjpl');
    await installDesktop(worker, syntheticProfile);
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const launcherUrl = `chrome-extension://${extensionId}/panel.html?surface=launcher`;
    const launcherFrame = async () => {
      await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 15000 }).toBe(true);
      return page.frames().find(frame => frame.url() === launcherUrl);
    };
    const calls = () => worker.evaluate(() => globalThis.__desktop.calls);
    async function open(url, laya) {
      await page.goto('about:blank');
      await worker.evaluate(laya => { globalThis.__desktop.laya = laya; globalThis.__desktop.calls = []; }, laya);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      const widget = await launcherFrame();
      await expect(widget.locator('#widget-text')).toHaveText(en('widget.siteReady', { host: 'pantry.example.org' }), { timeout: 20000 });
      return widget;
    }
    const mark = selector => page.locator(selector).getAttribute('data-secondhand-filled');
    // Every saved answer that could identify the applicant; plain yes/no also appears in the forms' own options.
    const savedValues = Object.values(syntheticProfile).filter(value => typeof value === 'string' && value.length > 2 && !['yes', 'no'].includes(value));
    const layaRequests = async () => (await calls()).filter(call => ['suggestFields', 'answerFields'].includes(call.type));

    // Turn the synthetic pantry on: Chrome access comes from the test copy's manifest; the desktop's trust is the stub.
    await page.goto(CONTACT, { waitUntil: 'domcontentloaded' });
    const enabled = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return enableSite(tab.id);
    });
    assert.deepEqual(enabled, { enabled: true, origin: ORIGIN });
    console.log('Site: the synthetic pantry is on (desktop trust is a stub).');

    // #39: a text box the rules miss is matched by Laya and filled from the vault as a guess.
    let widget = await open(CONTACT, 'ready');
    await widget.locator('#autofill').click();
    await expect(widget.locator('#widget-text')).toHaveText(`${en('widget.filledSuggested', { count: 2, suggested: 1 })} · ${en('widget.suggestedByLaya')}`, { timeout: 20000 });
    await expect(page.locator('#name')).toHaveValue(`${syntheticProfile.firstName} ${syntheticProfile.lastName}`);
    await expect(page.locator('#reach')).toHaveValue(syntheticProfile.email);
    assert.equal(await mark('#name'), 'rule');
    assert.equal(await mark('#reach'), 'guess', 'Laya’s match has the dashed guess outline');
    assert.equal(await page.locator('#reach').evaluate(element => getComputedStyle(element).outlineStyle), 'dashed');
    await expect(widget.locator('#need-you')).toBeHidden();
    const suggest = (await layaRequests()).find(call => call.type === 'suggestFields');
    assert.deepEqual(suggest.fields, [{ id: suggest.fields[0].id, label: 'Where can we reach you?', type: 'email', options: [] }]);
    assert.match(suggest.fields[0].id, /^f0:sh-\d+-\d+$/);
    assert.deepEqual((await calls()).find(call => call.type === 'getFields').fields, ['firstName', 'lastName', 'email'], 'one vault request with Laya’s match in it');
    console.log(`#39: "Where can we reach you?" filled from the vault as a guess; the widget says "${await widget.locator('#widget-text').textContent()}".`);

    // #42: "Is anyone in your household 60 or older?" gets "No" for a household with no seniors; the pet question needs the applicant.
    widget = await open(HOUSEHOLD, 'ready');
    await widget.locator('#autofill').click();
    await expect(widget.locator('#widget-text')).toHaveText(`${en('widget.filledSuggested', { count: 2, suggested: 1 })} · ${en('widget.suggestedByLaya')}`, { timeout: 20000 });
    await expect(page.locator('input[name="sixty"][value="no"]')).toBeChecked();
    await expect(page.locator('input[name="sixty"][value="yes"]')).not.toBeChecked();
    assert.equal(await mark('input[name="sixty"][value="no"]'), 'guess');
    assert.equal(await page.locator('input[name="pet"]:checked').count(), 0, '"Do you have a pet?" is left alone');
    await expect(widget.locator('#need-you')).toHaveText(en('widget.needYou', { count: 1 }));
    await widget.locator('#need-you').click();
    await expect(page.locator('fieldset:has(input[name="pet"])')).toHaveAttribute('data-secondhand-attention', '');
    const answer = (await layaRequests()).find(call => call.type === 'answerFields');
    assert.deepEqual(answer.questions.map(({ label, type, options }) => ({ label, type, options })), [
      { label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'] }, { label: 'Do you have a pet?', type: 'radio', options: ['Yes', 'No'] }]);
    console.log(`#42: 60 or older answered "No" as a guess, the pet question is under need you; the widget says "${await widget.locator('#widget-text').textContent()}".`);

    // #84: a Spanish form. Laya reads English, so the worker reads the question with Chrome's own LanguageDetector and
    // Translator, here in this Chromium's service worker, before Laya sees it. What they report decides the path.
    const chromeAI = await worker.evaluate(async () => ({
      translator: typeof Translator === 'undefined' ? 'missing' : await Translator.availability({ sourceLanguage: 'es', targetLanguage: 'en' }),
      detector: typeof LanguageDetector === 'undefined' ? 'missing' : await LanguageDetector.availability()
    }));
    console.log(`#84: in this Chromium's worker, Chrome's Translator (Spanish to English) is ${chromeAI.translator} and its LanguageDetector is ${chromeAI.detector}.`);
    widget = await open(SPANISH, 'ready');
    await widget.locator('#autofill').click();
    await expect(page.locator('#name')).toHaveValue(`${syntheticProfile.firstName} ${syntheticProfile.lastName}`, { timeout: 20000 });
    const spanishLaya = await layaRequests();
    assert.equal(JSON.stringify(spanishLaya).includes('años'), false, 'Laya never gets the Spanish words as if they were English');
    let spanishLine = null;
    if (chromeAI.translator === 'available') {
      await expect(page.locator('input[name="sixty"][value="no"]')).toBeChecked({ timeout: 20000 });
      assert.equal(await mark('input[name="sixty"][value="no"]'), 'guess');
      const asked = spanishLaya.find(call => call.type === 'answerFields').questions;
      assert.deepEqual(asked.map(question => question.options), [['Yes', 'No']]);
      console.log(`#84: Chrome translated the question on this computer to "${asked[0].label}", and Laya's "No" checked the page's own "No".`);
    } else {
      const reason = chromeAI.translator === 'missing' || chromeAI.translator === 'unavailable' ? 'translate.layaCantTranslate' : 'translate.layaNeedsDownload';
      const line = spanishLine = en('result.withReason', { summary: { key: 'result.siteFilledNeedYou', params: { count: 1, needYou: 1 } }, reason: { key: reason, params: {} } });
      await expect(widget.locator('#widget-text')).toHaveAttribute('title', line, { timeout: 20000 });
      await expect(widget.locator('#need-you')).toHaveText(en('widget.needYou', { count: 1 }));
      assert.equal(await page.locator('input[name="sixty"]:checked').count(), 0);
      assert.deepEqual(spanishLaya, [], 'Laya is asked nothing it can’t read');
      console.log(`#84: Chrome can't translate Spanish here (${chromeAI.translator}), so the question stays under need you and the result says why: "${line}"`);
    }

    // Laya not ready: exactly today's click. Rules only (Chrome's AI isn't available in headless Chromium), and Laya is asked nothing.
    widget = await open(CONTACT, 'off');
    await widget.locator('#autofill').click();
    await expect(widget.locator('#widget-text')).toHaveText(`${en('widget.filled', { count: 1 })} · ${en('widget.aiUnavailable')}`, { timeout: 20000 });
    await expect(page.locator('#reach')).toHaveValue('');
    await expect(widget.locator('#need-you')).toHaveText(en('widget.needYou', { count: 1 }));
    assert.deepEqual((await calls()).map(call => call.type), ['warmLaya', 'status', 'getFields', 'status'], 'one readiness check, then the same requests as before Laya');
    widget = await open(HOUSEHOLD, 'off');
    await widget.locator('#autofill').click();
    await expect(widget.locator('#widget-text')).toHaveText(`${en('widget.filled', { count: 1 })} · ${en('widget.aiUnavailable')}`, { timeout: 20000 });
    assert.equal(await page.locator('input[type="radio"]:checked').count(), 0);
    await expect(widget.locator('#need-you')).toHaveText(en('widget.needYou', { count: 2 }));
    assert.deepEqual(await layaRequests(), []);
    console.log('Laya off: the widget fills with the rules only, exactly as before, and Laya is asked nothing.');

    // The side panel shows whether Laya is ready. It runs last: in headless Chromium the open panel covers the widget's corner.
    widget = await open(HOUSEHOLD, 'off');
    await widget.locator('#details').click();
    panel = await attachNativePanel(context, page, extensionId);
    await expect.poll(() => panel.text('#laya-status'), { timeout: 15000 }).toBe(en('desktop.layaOff'));
    console.log(`Side panel with Laya off: "${en('desktop.layaOff')}"`);
    // The side panel's own Autofill has no widget plan: the worker asks Laya itself.
    await worker.evaluate(() => { globalThis.__desktop.laya = 'ready'; globalThis.__desktop.calls = []; });
    await expect.poll(() => panel.text('#panel-autofill')).toBe(en('panel.autofill'));
    await panel.click('#panel-autofill');
    await expect(page.locator('input[name="sixty"][value="no"]')).toBeChecked({ timeout: 20000 });
    await expect.poll(() => panel.text('#status'), { timeout: 15000 }).toBe(en('result.suggestedByLaya', { summary: { key: 'result.siteFilledSuggestedNeedYou', params: { count: 2, suggested: 1, needYou: 1 } } }));
    await expect.poll(() => panel.text('#laya-status'), { timeout: 15000 }).toBe(en('desktop.layaReady'));
    assert.deepEqual((await layaRequests()).map(call => call.type), ['answerFields']);
    console.log(`Side panel Autofill with Laya ready: "${await panel.text('#status')}" and "${en('desktop.layaReady')}"`);

    // The side panel says why the Spanish question stayed with the applicant.
    if (spanishLine) {
      await page.goto(SPANISH, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe(en('panel.autofill'));
      await panel.click('#panel-autofill');
      await expect.poll(() => panel.text('#status'), { timeout: 15000 }).toBe(spanishLine);
      console.log(`#84: the side panel's Autofill on the Spanish form says: "${await panel.text('#status')}"`);
    }

    // No saved value ever reached Laya on any page: every request of the run carried labels, types, and options only.
    const checked = checkLayaRequests(await worker.evaluate(() => globalThis.__desktop.all), savedValues);
    console.log(`Laya's requests over the whole run: ${checked.suggestFields} suggestFields and ${checked.answerFields} answerFields, each with labels only and its click's time left.`);
    assert.equal(await page.evaluate(() => window.__submits), 0, 'nothing was submitted');
    const outside = requests.filter(url => !url.startsWith(`chrome-extension://${extensionId}/`) && !Object.hasOwn(pages, url) && url !== 'about:blank');
    assert.deepEqual(outside, [], 'nothing left the computer');
    assert.deepEqual(errors, []);
    console.log('All fixtures and data were synthetic; the desktop app and Laya were DevTools stubs. Nothing was submitted.');
  } finally {
    if (panel) await panel.close();
    if (context) await context.close().catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
