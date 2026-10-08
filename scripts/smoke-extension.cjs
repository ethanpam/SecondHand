'use strict';

// Real Chromium / MV3 / native side-panel smoke. Playwright fulfills all Iowa
// documents locally; DNS is disabled. Native requests alone are replaced inside
// the isolated worker's DevTools context. No production test hooks or real data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect: playwrightExpect } = require('@playwright/test');
const { despiteSleep, sleepTolerant, host: hostSleep } = require('./host-sleep.cjs');
const syntheticProfile = require('../tests/fixtures/applicant-profile.json');
const applicantFixture = require('../tests/fixtures/iowa-personal-information.cjs');
const preApplicant = require('../tests/fixtures/iowa-pre-applicant.cjs');
const addressFixture = require('../tests/fixtures/iowa-select-address.cjs');
const selfFixture = require('../tests/fixtures/iowa-self-details.cjs');
const tellUsMore = require('../tests/fixtures/iowa-tell-us-more.cjs');
const laterFixture = require('../tests/fixtures/iowa-later-pages.cjs');
const jobFixture = require('../tests/fixtures/iowa-job-history.cjs');
const strings = require('../extension/strings.js');
const root = path.join(__dirname, '..');
const portal = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
const applicant = `${portal}/applyForBenefits/enterPersonalInfo`;
const extensionDirectory = path.join(root, 'extension');
// Every wait counts wall-clock time, which runs on while the computer sleeps (see host-sleep.cjs).
const expect = sleepTolerant(playwrightExpect);

const documentManualUrl = `${portal}/qa-only/document-manual`;
const documentNextMarker = 'SECONDHAND_SYNTHETIC_FULL_DOCUMENT_NEXT';
const addressUrl = addressFixture.URL;
const selfDetailsUrl = selfFixture.URL;
const startDetailsUrl = tellUsMore.URL;
const backgroundUrl = laterFixture.url('background');
const verifiedApplicantMarker = 'SECONDHAND_VERIFIED_ADDRESS_APPLICANT_NEXT';
const verifiedAddressMarker = 'SECONDHAND_VERIFIED_ADDRESS_NEXT:';
const addressVariants = {
  original: { selected: 'original' },
  second: { selected: 'second', candidateCount: 2 },
  error: { selected: 'original', error: true },
  modal: { selected: 'original', modal: true },
  mailing: { selected: 'original', mailing: true },
  county: { selected: 'original', renderedCounty: true },
  countyStays: { selected: 'original', renderedCounty: true, countyStaysVisible: true }
};

function verifiedAddressFixture(variant) {
  const options = addressVariants[variant];
  if (!options) throw new Error('Unknown isolated address QA variant.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Verified address structure · isolated QA</title>
    <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:30px}main{max-width:900px}label{display:block;margin:12px 0}button{padding:12px 18px;margin:12px}table{border-collapse:collapse}td,th{padding:10px;text-align:left}</style></head>
    <body><main><p data-verified-address-qa>ISOLATED QA · FICTIONAL APPLICANT · PUBLIC CAMPUS ADDRESS. No government connection.</p>${addressFixture.makeHtml(options)}</main>
    <script>(${addressFixture.attachHandlers.toString()})(document, ${JSON.stringify(options)});
      document.querySelector(${JSON.stringify(addressFixture.NEXT_SELECTOR)}).addEventListener('click', () => {
        console.info(${JSON.stringify(verifiedAddressMarker)} + JSON.stringify(document.__addressQa));
        location.assign(${JSON.stringify(documentManualUrl)});
      });
    </script></body></html>`;
}

function selfDetailsFixture(variant = 'verified') {
  // Iowa serves Job Information at the same address. SecondHand fills nothing there.
  if (variant === 'job') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Job Information · isolated QA</title></head>
      <body><main><p>ISOLATED QA · FICTIONAL APPLICANT. No government connection.</p><h2>Job Information</h2>
      <form id="qaJob"><fieldset><legend>Does anyone in your household have a job? (QA only)</legend><label><input name="qaJob" type="radio" value="yes">Yes</label><label><input name="qaJob" type="radio" value="no">No</label></fieldset>
      <button type="button">Save and Continue</button></form></main></body></html>`;
  }
  let html = selfFixture.html;
  if (variant === 'people') html = html.replace('People | Unvisited', 'People | Active');
  else if (variant === 'form') html = html.replace('action="simple"', 'action="otherPerson"');
  else if (variant === 'heading') html = html.replace('<h2>Tell Us More</h2>', '<h2>Tell Us About Another Person</h2>');
  else if (variant !== 'verified') throw new Error('Unknown self-details QA variant.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Self-information DOB · isolated QA</title>
    <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:30px}main{max-width:900px}label{display:block;margin:8px 0}input[type=text]{padding:8px}button{padding:12px;margin:10px}.questionAnswer{margin:16px 0}</style></head>
    <body><main><p>ISOLATED QA · FICTIONAL APPLICANT. Only date-of-birth metadata is verified; the additional test controls below are synthetic guards.</p>${html}</main>
    <script>
      // These controls are deliberately QA-only, not purported Iowa mappings.
      document.getElementById('question01').insertAdjacentHTML('beforeend', '<label><input data-qa-manual name="qaGender" type="radio" value="qa-option-one">QA gender option one</label><label><input data-qa-manual name="qaGender" type="radio" value="qa-option-two">QA gender option two</label>');
      document.getElementById('question06179').insertAdjacentHTML('beforeend', '<label><input data-qa-manual name="qaCitizenship" type="radio" value="qa-option-one">QA citizenship option one</label><label><input data-qa-manual name="qaCitizenship" type="radio" value="qa-option-two">QA citizenship option two</label>');
      document.getElementById('question02420').insertAdjacentHTML('beforeend', '<label>QA SSN placeholder<input data-qa-manual name="qaSsn" type="text"></label><label><input data-qa-manual name="qaSsnChoice" type="checkbox">QA SSN choice</label>');
      window.__selfQa = { nextClicks: 0, manualChanges: 0 };
      document.querySelectorAll('[data-qa-manual]').forEach(element => element.addEventListener('change', () => { window.__selfQa.manualChanges++; }));
      document.getElementById('dqButtonId309').onclick = () => { window.__selfQa.nextClicks++; };
    </script></body></html>`;
}

// The trimmed Tell Us More page at dynamicQuestionsStart, with a QA stand-in for Iowa's
// hideShowQuestions: each rule is "answer:shown ids:hidden ids", and ids follow the prefix.
function startDetailsFixture(variant = 'verified') {
  const html = variant === 'people' ? tellUsMore.html.replace('People | Unvisited', 'People | Active') : tellUsMore.html;
  if (!['verified', 'people', 'synchronized', 'mirror-mismatch', 'meal', 'unknown', 'error', 'modal'].includes(variant)) throw new Error('Unknown Tell Us More QA variant.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tell Us More · isolated QA</title>
    <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:30px}main{max-width:900px}li{display:inline-block;margin-right:12px}label{margin:0 12px 0 4px}input[type=text],select{padding:8px}button{padding:12px;margin:10px}.questionAnswer{margin:16px 0}</style></head>
    <body><main><p>ISOLATED QA · FICTIONAL APPLICANT. Trimmed from a sanitized capture; the script below is a QA stand-in for Iowa's.</p>${html}</main>
    <script>
      window.__startQa = { nextClicks: 0, shown: [] };
      // Explicitly synthetic stand-in, not evidence of Iowa's external masking script.
      // The ordinary fixture intentionally has no mirror synchronization.
      if (${JSON.stringify(['synchronized', 'mirror-mismatch'].includes(variant))}) {
        document.getElementById(${JSON.stringify(tellUsMore.SSN_BOX_ID)}).addEventListener('input', event => {
          const digits = event.target.value.replace(/[^0-9]/g, '');
          event.target.parentElement.querySelector('[name="ssndiv"] input').value =
            ${JSON.stringify(variant === 'mirror-mismatch')} ? '123456780' : digits;
        });
      }
      if (${JSON.stringify(variant === 'meal')}) {
        const question = document.getElementById('question02422');
        question.classList.remove('disabledQuestion', 'hidden'); question.style.display = '';
      }
      if (${JSON.stringify(variant === 'unknown')}) document.getElementById('answerSet').insertAdjacentHTML('beforeend', '<div class="questionAnswer"><label>Unmapped synthetic follow-up<input value="Answered only for QA"></label></div>');
      if (${JSON.stringify(variant === 'error')}) document.getElementById('answerSet').insertAdjacentHTML('beforeend', '<div role="alert">Synthetic validation error</div>');
      if (${JSON.stringify(variant === 'modal')}) {
        const modal = document.getElementById('customModalBox'); modal.style.display = 'block'; modal.setAttribute('role', 'dialog');
      }
      function hideShowQuestions(prefix, input, rules) {
        const rule = rules.split('|').map(part => part.split(':')).find(([answer]) => answer === input.value);
        if (!rule) return;
        for (const id of rule[1].split(',').filter(Boolean)) {
          const question = document.getElementById(prefix + id);
          question.classList.remove('hidden'); question.style.display = '';
          if (!window.__startQa.shown.includes(question.id)) window.__startQa.shown.push(question.id);
        }
        for (const id of rule[2].split(',').filter(Boolean)) document.getElementById(prefix + id).classList.add('hidden');
      }
      document.getElementById('dqButtonId309').onclick = () => { window.__startQa.nextClicks++; };
    </script></body></html>`;
}

function backgroundBrowserFixture() {
  // This positive path has no language/naturalization/race follow-ups. Handler
  // stubs are synthetic; browser QA does not claim Iowa's scripts were executed.
  return laterFixture.makeHtml('background') + `<script>
    window.__backgroundQa = { nextClicks: 0 };
    function hideShowQuestions() {}
    document.getElementById('dqButtonId311').onclick = () => { window.__backgroundQa.nextClicks++; };
  </script>`;
}

function jobBrowserFixture() {
  // In English, as Iowa's pages are, so the card offers the questions in the reader's language.
  return jobFixture.html.replace('<html>', '<html lang="en">').replace('</body>', `<script>(${jobFixture.attachHandlers.toString()})(document);</script></body>`);
}

function fixture(nextStep) {
  if (nextStep === 'document-manual-destination') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic manual step · test only</title></head>
      <body><main><p data-qa-document>SYNTHETIC FULL-DOCUMENT QA FIXTURE. No government connection or real applicant data.</p>
      <h1>Household Members</h1><label>Fictional household member<input id="qa-household-member" name="qaHouseholdMember"></label>
      <button id="qa-manual-continue" type="button">Continue (QA only)</button></main>
      <script>window.__manualNextClicks=0;document.getElementById('qa-manual-continue').addEventListener('click',()=>{window.__manualNextClicks++;});</script></body></html>`;
  }
  // An applicant page whose form SecondHand doesn't recognize, so it fills nothing.
  if (nextStep === 'unexpected') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Unexpected applicant page · test only</title></head>
      <body><main><p class="test-only">SYNTHETIC TEST FIXTURE. No government connection or real applicant data.</p><h1>Enter Personal Information</h1>
      <form id="qaPersonal"><label>QA first name<input name="qaFirstName"></label><button type="button">Save and Continue</button></form></main></body></html>`;
  }
  // Address controls below are hypothetical QA controls, not an observed Iowa
  // schema. They verify the shipping adapter's refusal to operate this step.
  const addressReview = nextStep === 'address-review';
  const verifiedAddressVariant = typeof nextStep === 'string' && nextStep.startsWith('verified-address-') ? nextStep.slice('verified-address-'.length) : null;
  if (verifiedAddressVariant && !Object.hasOwn(addressVariants, verifiedAddressVariant)) throw new Error('Unknown address fixture transition.');
  const nextMarkup = addressReview
    ? '<h1>Select Address</h1><p data-qa-only>HYPOTHETICAL QA CONTROLS. These are not verified Iowa selectors or address-selection behavior.</p><fieldset><legend>Public-campus address choices for the fictional applicant isolation test</legend><label><input id="qa-original-address" name="qa-address-choice" type="radio" value="original">411 Morrill Rd, Ames, IA 50011</label><label><input id="qa-suggested-address" name="qa-address-choice" type="radio" value="suggested">411 MORRILL RD, AMES, IA 50011</label></fieldset><button id="qa-address-continue" type="button">Continue (QA only)</button>'
    : nextStep === 'consent'
    ? '<h1>Terms and Consent</h1><label><input id="termChkbox" type="checkbox">I agree to the terms</label><button type="button">Continue</button>'
    : '<h1>Household Members</h1><label>Household member<input name="householdMember"></label><button type="button">Continue</button>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Iowa flow · test only</title>
    <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:30px}main{max-width:690px}h1{font-size:30px}h3{font-size:18px;margin:25px 0 12px}label{display:block;margin:12px 0 4px}input:not([type=checkbox]):not([type=radio]),select{display:block;box-sizing:border-box;width:310px;height:36px;border:1px solid #a2b294;border-radius:5px;padding:7px}fieldset{border:1px solid #ced7c5;margin:16px 0;padding:12px}fieldset label{display:inline-block;margin-right:10px}button{padding:12px 18px;background:#285c45;color:white;border:0;border-radius:6px;margin-top:12px}.test-only{font-size:12px;color:#7c866e}.saveAndContinueButton{margin-left:15px}input:focus,select:focus{outline:3px solid #b39040}</style>
    </head><body><main id="synthetic-content"><p class="test-only">SYNTHETIC TEST FIXTURE. No government connection or real applicant data.</p>
    ${applicantFixture.html}</main><script>
      (${applicantFixture.attachConditionalHandlers.toString()})(document);
      window.__nextClicks = 0; window.__lastAnswers = null;
      window.__addressNextClicks = 0; window.__addressChoiceEvents = 0;
      document.querySelector('.saveAndContinueButton').addEventListener('click', () => {
        window.__nextClicks++;
        window.__lastAnswers = Object.fromEntries(Array.from(document.querySelectorAll('#personalInformation input, #personalInformation select'), element => [element.id, ['checkbox','radio'].includes(element.type) ? element.checked : element.value]));
        if (${JSON.stringify(nextStep === 'stay')}) return;
        if (${JSON.stringify(Boolean(verifiedAddressVariant))}) {
          console.info(${JSON.stringify(verifiedApplicantMarker)});
          location.assign(${JSON.stringify(addressUrl)});
          return;
        }
        if (${JSON.stringify(nextStep === 'document-manual')}) {
          // Static QA marker survives unloading through the browser console
          // listener. It carries no answers, tokens, or other applicant data.
          console.info(${JSON.stringify(documentNextMarker)});
          location.assign(${JSON.stringify(documentManualUrl)});
          return;
        }
        document.getElementById('synthetic-content').innerHTML = ${JSON.stringify(nextMarkup)};
        history.pushState({}, '', ${JSON.stringify(addressReview ? `${portal}/qa-only/select-address` : `${portal}/applyForBenefits/${nextStep === 'consent' ? 'consent' : 'household'}`)});
        document.getElementById('qa-address-continue')?.addEventListener('click', () => { window.__addressNextClicks++; });
        document.querySelectorAll('[name="qa-address-choice"]').forEach(input => input.addEventListener('change', () => { window.__addressChoiceEvents++; }));
      });
    </script></body></html>`;
}

// Pre-applicant screens with stand-ins for Iowa's page functions. About you is not
// recorded yet, so Instructions' Continue leads straight to the applicant page.
// Iowa's applicant heading over a form SecondHand doesn't know: a page it fills nothing on.
const anotherApplicantForm = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic unknown applicant form · test only</title>
  <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:30px}label{display:block;margin:12px 0 4px}</style></head>
  <body><main><p class="test-only">SYNTHETIC TEST FIXTURE. No government connection or real applicant data.</p><h1>Enter Personal Information</h1>
  <form id="qa-another-form"><label for="qa-nickname">Preferred name (QA only)</label><input id="qa-nickname" name="qaNickname"><button type="button">Save and Continue</button></form></main></body></html>`;

function preApplicantPage(name) {
  const targets = { letsGetStarted: '/applyForBenefits/letsGetStarted', instructions: '/applyForBenefits/instructions', aboutYou: '/applyForBenefits/enterPersonalInfo?next=stay', welcome: '/applyForBenefits/welcome', importantInfo: '/applyForBenefits/importantInfo' };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Iowa screen · test only</title></head><body>
    <p class="test-only">SYNTHETIC TEST FIXTURE. No government connection or real applicant data.</p>${preApplicant.screens[name].html}
    <script>
      const targets = ${JSON.stringify(targets)};
      window.__continues = 0;
      function submitUrlLink(target) { window.__continues++; location.href = '${portal}' + targets[target]; }
      function toggleCaptcha() { document.getElementById('captchaDiv').style.display = 'block'; }
      function validateMsg() {}
      function onCheck() {}
      function welcomeSubmit() { if (document.getElementById('termChkbox').checked) location.href = '${portal}/applyForBenefits/importantInfo'; }
    </script></body></html>`;
}

async function installNativeStub(worker) {
  await worker.evaluate(({ profile, addressUrl }) => {
    globalThis.__nativeSmoke = { locked: false, accessRevision: 0, calls: [], profile };
    nativeRequest = async (type, payload = {}) => {
      const state = globalThis.__nativeSmoke;
      state.calls.push({ type, fields: payload.fields || [], url: payload.url || '' });
      if (type === 'getRecordFields') Object.assign(state.calls.at(-1), { pageKey: payload.pageKey, recordType: payload.recordType, personName: payload.personName || '' });
      // A closed app can't be reached, as the worker reports a host that can't reach it; openApp starts it, locked.
      if (type === 'openApp') {
        if (!state.closed) return { opened: 'shown' };
        state.closed = false; state.locked = true;
        return { opened: 'launched' };
      }
      if (state.closed) throw Object.assign(fault('worker.desktopOffline'), { code: 'offline' });
      if (type === 'status') return { unlocked: !state.locked, applicationCount: 0, accessRevision: state.accessRevision };
      if (type === 'showApp') return { shown: true };
      if (type === 'getFields') {
        if (payload.fields.length === 0 && state.holdNavigation) {
          state.navigationAuthorizationWaiting = true;
          await new Promise(resolve => { state.releaseNavigation = resolve; });
        }
        if (payload.url === addressUrl && state.holdAddressNavigation) {
          state.addressAuthorizationWaiting = true;
          await new Promise(resolve => { state.releaseAddressNavigation = resolve; });
        }
        if (state.locked) throw new Error('Unlock your local vault first.');
        const receipt = state.accessRevision;
        const values = Object.fromEntries(payload.fields.filter(field => state.profile[field]).map(field => [field, state.profile[field]]));
        if (state.lockAfterFields) { state.locked = true; state.accessRevision++; }
        return { values, accessRevision: receipt };
      }
      if (type === 'getRecordFields') {
        if (state.holdRecord) {
          state.recordAuthorizationWaiting = true;
          await new Promise(resolve => { state.releaseRecord = resolve; });
        }
        if (state.locked) throw new Error('Unlock your local vault first.');
        const record = state.record;
        if (!record) return { values: {}, reason: 'recordMissing', accessRevision: state.accessRevision };
        const receipt = state.accessRevision;
        const values = Object.fromEntries(payload.fields.filter(field => record[field]).map(field => [field, record[field]]));
        if (state.lockAfterRecord) { state.locked = true; state.accessRevision++; }
        return { recordId: record.id, values, accessRevision: receipt };
      }
      if (type === 'recordProgress') return { recorded: true };
      // This build ships no Laya model, so Laya is unavailable and both Laya requests answer "not ready".
      if (type === 'warmLaya') return { state: 'unavailable' };
      if (type === 'suggestFields' || type === 'answerFields') throw Object.assign(new Error('Laya isn’t ready on this computer.'), { code: 'LAYA_NOT_READY' });
      throw new Error('Unexpected native test message: ' + type);
    };
  }, { profile: syntheticProfile, addressUrl });
}

// Chrome native side-panel targets are real extension pages but are not exposed
// in Playwright's context.pages(). Attach to that existing target using CDP.
// Interactions use trusted browser Input events, never element.click().
async function attachNativePanel(context, page, extensionId) {
  const transport = await context.newCDPSession(page);
  let target;
  await expect.poll(async () => {
    target = (await transport.send('Target.getTargets')).targetInfos.find(item => item.type === 'page' && item.url === `chrome-extension://${extensionId}/panel.html`);
    return Boolean(target);
  }, { timeout: 15000 }).toBe(true);
  const { sessionId } = await transport.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let sequence = 0;
  const pending = new Map();
  transport.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const request = { resolve, reject, timer: null };
    // A sleep of the computer doesn't use up the reply's 15 seconds.
    const arm = () => {
      const mark = hostSleep.mark();
      request.timer = setTimeout(() => {
        if (hostSleep.slept(mark)) return arm();
        pending.delete(id); reject(new Error(`Native panel CDP timed out: ${method}`));
      }, 15000);
    };
    arm();
    pending.set(id, request);
    transport.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
      clearTimeout(request.timer); pending.delete(id); reject(error);
    });
  });
  const evaluate = async (fn, argument) => {
    const result = await send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(argument)})`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Native panel evaluation failed.');
    return result.result.value;
  };
  const text = selector => evaluate(selector => document.querySelector(selector)?.textContent || '', selector);
  const visible = selector => evaluate(selector => {
    const element = document.querySelector(selector); return Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  }, selector);
  const click = async selector => {
    let point;
    await expect.poll(async () => {
      point = await evaluate(selector => {
        const element = document.querySelector(selector);
        if (!element || element.disabled || !element.getClientRects().length) return null;
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        return top && (top === element || element.contains(top)) ? { x, y } : null;
      }, selector);
      return Boolean(point);
    }, { timeout: 15000 }).toBe(true);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  return { send, evaluate, text, visible, click,
    // Like Playwright's page.screenshot, it creates the file's folder.
    async screenshot(file) {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.from(result.data, 'base64'));
    },
    async close() { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Panel test closed.')); } pending.clear(); await transport.detach().catch(() => {}); }
  };
}

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-chromium-smoke-'));
  let context, panel, page, worker;
  const errors = [];
  let currentAddressVariant = 'original', currentSelfVariant = 'verified', currentStartVariant = 'verified', currentSharedPage = 'self';
  let verifiedApplicantClicks = 0, verifiedAddressLoads = 0, documentManualLoads = 0;
  const verifiedAddressNext = [];
  try {
    context = await chromium.launchPersistentContext(userData, {
      channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
      args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1440,1050']
    });
    await context.route('**/*', route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && url.pathname === '/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: url.searchParams.get('next') === 'another-form' ? anotherApplicantForm : fixture(url.searchParams.get('next')) });
      }
      if (request.isNavigationRequest() && request.url() === addressUrl) {
        verifiedAddressLoads++;
        return route.fulfill({ status: 200, contentType: 'text/html', body: verifiedAddressFixture(currentAddressVariant) });
      }
      if (request.isNavigationRequest() && request.url() === selfDetailsUrl) return route.fulfill({ status: 200, contentType: 'text/html', body: currentSharedPage === 'job' ? jobBrowserFixture() : selfDetailsFixture(currentSelfVariant) });
      if (request.isNavigationRequest() && request.url() === backgroundUrl) return route.fulfill({ status: 200, contentType: 'text/html', body: backgroundBrowserFixture() });
      if (request.isNavigationRequest() && request.url() === startDetailsUrl) return route.fulfill({ status: 200, contentType: 'text/html', body: startDetailsFixture(currentStartVariant) });
      if (request.isNavigationRequest() && request.url() === documentManualUrl) {
        documentManualLoads++;
        return route.fulfill({ status: 200, contentType: 'text/html', body: fixture('document-manual-destination') });
      }
      const screen = Object.keys(preApplicant.screens).find(name => url.pathname === `/apspssp/ssp.portal${preApplicant.screens[name].path}`);
      if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && screen) {
        return route.fulfill({ status: 200, contentType: 'text/html', body: preApplicantPage(screen) });
      }
      if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && url.pathname === '/apspssp/ssp.portal/applyForBenefits/householdMembers') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic unknown screen · test only</title><main><h1>Household Members</h1><p>SYNTHETIC TEST FIXTURE.</p></main>' });
      }
      if (url.protocol === 'chrome-extension:') return route.continue();
      return route.abort('blockedbyclient');
    });
    worker = await despiteSleep(async () => context.serviceWorkers()[0] || context.waitForEvent('serviceworker', { timeout: 20000 }));
    const extensionId = new URL(worker.url()).hostname;
    assert.equal(extensionId, 'jogldddafjfbmfjnjlbjloakjbecnjpl');
    await installNativeStub(worker);
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.text() === verifiedApplicantMarker) verifiedApplicantClicks++;
      if (message.text().startsWith(verifiedAddressMarker)) verifiedAddressNext.push(JSON.parse(message.text().slice(verifiedAddressMarker.length)));
    });
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const launcherUrl = `chrome-extension://${extensionId}/panel.html?surface=launcher`;
    const launcherFrame = async () => {
      await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 15000 }).toBe(true);
      return page.frames().find(frame => frame.url() === launcherUrl);
    };
    const calls = type => worker.evaluate(type => globalThis.__nativeSmoke.calls.filter(call => call.type === type), type);
    // The worker's own state, so a check that nothing more happened waits on it, not on the clock (#143): the clicks
    // and page polls it has received (and how many came from the side panel), whether it is busy (handling a click,
    // running an autopilot step or a site fill), and whether an autopilot waits for the applicant. A waiting autopilot
    // looks at the page again at each poll.
    await worker.evaluate(() => {
      globalThis.__smokeProbe = { actions: 0, polls: 0, panelPolls: 0 };
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (message?.confirmed === true) globalThis.__smokeProbe.actions++;
        if (message?.type === 'ui:pageState') globalThis.__smokeProbe.polls++;
        if (message?.type === 'ui:pageState' && sender.url === chrome.runtime.getURL('panel.html')) globalThis.__smokeProbe.panelPolls++;
      });
    });
    const workerState = () => worker.evaluate(() => ({ ...globalThis.__smokeProbe, waiting: autopilots.size,
      busy: Boolean(clicksUnderway || siteRuns.size || [...autopilots.values()].some(pilot => pilot.running)) }));
    // Waits until the worker has handled the click made after `since` (when given) and is busy with nothing. With an
    // autopilot left waiting, it waits too for the step the next page poll starts to finish. After that nothing more
    // happens until the page or the applicant changes something.
    async function settled(since) {
      await expect.poll(async () => { const state = await workerState(); return !state.busy && (!since || state.actions > since.actions); }, { timeout: 20000 }).toBe(true);
      const state = await workerState();
      if (!state.waiting) return;
      await expect.poll(async () => { const now = await workerState(); return !now.busy && now.polls >= state.polls + 2; }, { timeout: 20000 }).toBe(true);
    }
    // The side panel's Autofill, once the worker has handled the click and nothing is under way.
    async function autofillSettled() {
      const since = await workerState();
      await panel.click('#panel-autofill');
      await settled(since);
    }

    // Leaving Iowa's site turns a running autofill off, so every flow starts clean.
    async function resetTo(url, { profile = {}, locked = false } = {}) {
      await despiteSleep(() => page.goto('about:blank'));
      await worker.evaluate(({ profile, locked }) => { globalThis.__nativeSmoke = { locked, accessRevision: 0, calls: [], profile }; }, { profile: { ...syntheticProfile, ...profile }, locked });
      await despiteSleep(() => page.goto(url, { waitUntil: 'domcontentloaded' }));
    }
    async function startFixture({ profile = {}, locked = false } = {}) {
      await resetTo(`${applicant}?next=stay`, { profile, locked });
      await page.bringToFront();
      await expect(page.locator('[data-secondhand-assistant]')).toHaveAttribute('data-secondhand-size', 'full');
      const widget = await launcherFrame();
      await expect(widget.locator('#autofill')).toBeVisible();
      await expect(page.locator('#firstName')).toHaveValue('');
      return widget;
    }
    const answers = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#personalInformation input, #personalInformation select'), element => [element.id, ['checkbox', 'radio'].includes(element.type) ? element.checked : element.value])));

    // Untrusted page messages can never start autofill.
    let widget = await startFixture();
    const beforePost = await workerState();
    await page.evaluate(() => new Promise(resolve => {
      // Listeners hear a message in the order they were added, so when this one does, the page's scripts have.
      addEventListener('message', function heard(event) { if (event.data?.type === 'ui:autofill') { removeEventListener('message', heard); resolve(); } });
      window.postMessage({ type: 'ui:autofill', confirmed: true }, '*');
    }));
    // Two more page polls from the widget: one began and was answered after the message.
    await expect.poll(async () => (await workerState()).polls, { timeout: 15000 }).toBeGreaterThanOrEqual(beforePost.polls + 2);
    await settled();
    assert.equal((await workerState()).actions, beforePost.actions, 'the worker received no click');
    assert.deepEqual(await calls('getFields'), []);

    // One click fills the whole applicant page, including revealed sections.
    await widget.locator('#autofill').click();
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
    const full = await answers();
    assert.equal(full.firstName, syntheticProfile.firstName); assert.equal(full.lastName, syntheticProfile.lastName);
    assert.equal(full.suffix, 'III'); assert.equal(full.phoneNumber, '(202)555-0147');
    assert.equal(full.hasHome1, true); assert.equal(full.addressLine1, syntheticProfile.addressLine1);
    assert.equal(full.sameAddress2, true); assert.equal(full.mailingCity, syntheticProfile.mailingCity);
    assert.equal(full.applicant1, true); assert.equal(full.snap, true);
    assert.equal(full.bestTime, syntheticProfile.bestContactTime);
    await expect(widget.locator('#need-you')).toBeHidden();
    assert.equal((await calls('getFields')).length, 1, 'One click makes one desktop request.');
    assert.equal((await calls('recordProgress')).length, 1);
    assert.equal(await page.evaluate(() => window.__nextClicks), 1, 'Verified complete applicant continues once.');
    await page.screenshot({ path: path.join(root, 'artifacts/extension-assistant.png') });
    console.log('Widget: one click fills the full applicant page with one desktop request and one verified Next.');

    // Missing saved answers become "need you" links that jump to the field.
    widget = await startFixture({ profile: { firstName: '' } });
    await widget.locator('#autofill').click();
    await expect(widget.locator('#need-you')).toHaveText('1 question left', { timeout: 20000 });
    await expect(page.locator('#lastName')).toHaveValue(syntheticProfile.lastName);
    await widget.locator('#need-you').click();
    await expect.poll(() => page.evaluate(() => document.activeElement.id)).toBe('firstName');
    assert.equal(await page.evaluate(() => window.__nextClicks), 0, 'Missing required profile data cannot trigger Next.');
    const beforeManual = (await calls('getFields')).length;
    // Typed one key at a time, as a person types. While the cursor is still in the box the answer may not be
    // finished, so Autofill waits, through more than two of the card's 1.5-second checks, until the person leaves it.
    await page.locator('#firstName').pressSequentially(syntheticProfile.firstName, { delay: 60 });
    await page.waitForTimeout(4000);
    assert.equal(await page.evaluate(() => window.__nextClicks), 0, 'No Save and Continue while the person is still in the box they typed in.');
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
    assert.equal((await calls('getFields')).filter(call => call.fields.length).length, beforeManual, 'Manual completion requests no additional saved profile values.');
    assert.deepEqual((await calls('getFields')).at(-1).fields, [], 'Manual completion obtains fresh no-data navigation authorization.');
    console.log('Widget: missing profile data blocks Next; field focus and manual completion allow one later Next, once the person leaves the box.');

    const branches = [
      { name: 'home address with same mailing; optional blanks', profile: { mailingSameAsHome: 'yes', middleName: '', suffix: '', maidenName: '', addressLine2: '', bestContactTime: '' }, check: answers => { assert.equal(answers.sameAddress1, true); assert.equal(answers.mailingAddressLine1, ''); } },
      { name: 'no home address; separate mailing', profile: { hasHomeAddress: 'no' }, check: answers => { assert.equal(answers.hasHome2, true); assert.equal(answers.addressLine1, ''); assert.equal(answers.mailingAddressLine1, syntheticProfile.mailingAddressLine1); } },
      { name: 'Medicaid + FIP + medical-bill choice', profile: { programSnap: 'no', programMedicaid: 'yes', programFip: 'yes', helpPayMedicalBills: 'yes' }, check: answers => { assert.equal(answers.medicaid, true); assert.equal(answers.tanf, true); assert.equal(answers.helpPayMedBill1, true); assert.equal(answers.snap, false); } },
      { name: 'not applying personally hides program questions', profile: { isApplicant: 'no' }, check: answers => { assert.equal(answers.applicant2, true); assert.equal(answers.snap, false); } }
    ];
    for (const branch of branches) {
      widget = await startFixture({ profile: branch.profile });
      await widget.locator('#autofill').click();
      await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
      branch.check(await answers());
      assert.equal(await page.evaluate(() => window.__nextClicks), 1);
      console.log(`Widget conditional branch passed: ${branch.name}.`);
    }

    widget = await startFixture({ profile: { programSnap: 'no', programFip: 'no', programMedicaid: 'no' } });
    await widget.locator('#autofill').click();
    await expect(widget.locator('#need-you')).toHaveText('1 question left', { timeout: 20000 });
    console.log('Widget: an unanswered required program choice is flagged for the applicant.');

    // Manual completion can reveal a saved optional field. Fill that new field
    // before deciding that required answers are complete and clicking Next.
    widget = await startFixture({ profile: { isApplicant: '', programSnap: '', programFip: '', programMedicaid: '' } });
    await widget.locator('#autofill').click();
    await expect(page.locator('#lastName')).toHaveValue(syntheticProfile.lastName, { timeout: 20000 });
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    await page.locator('#applicant1').check();
    await page.locator('#snap').check();
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
    assert.equal(await page.evaluate(() => window.__lastAnswers.bestTime), syntheticProfile.bestContactTime);
    console.log('Manual program choice: newly revealed saved best-time answer fills before Next.');

    // A locked vault fills nothing and offers to bring the desktop app forward.
    widget = await startFixture({ locked: true });
    await widget.locator('#autofill').click();
    await expect(widget.locator('#unlock')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#firstName')).toHaveValue('');
    await widget.locator('#unlock').click();
    await expect(widget.locator('#autofill')).toBeVisible();
    assert.equal((await calls('showApp')).length, 1);
    assert.equal((await calls('getFields')).length, 0);
    console.log('Widget: a locked vault fills nothing and Unlock brings SecondHand forward.');

    // One click walks the pre-applicant screens: it continues info screens, waits at
    // consent for the applicant, then continues again and fills the applicant page.
    await resetTo(`${portal}/applyForBenefits/welcome`);
    widget = await launcherFrame();
    // As on a first run, the card says what Stop would do; a Chrome that started Autofill again gets the short form.
    await widget.evaluate(() => localStorage.removeItem('secondhand.autofillStarted'));
    await widget.locator('#autofill').click();
    await expect.poll(() => page.url(), { timeout: 20000 }).toBe(`${portal}/applyForBenefits/letsGetStarted`);
    widget = await launcherFrame();
    await expect(widget.locator('#widget-text')).toHaveText('Read and accept Iowa’s consent, then click Continue. Stop erases nothing.', { timeout: 20000 });
    await expect(widget.locator('#stop')).toBeVisible();
    await page.locator('#termChkbox').check();
    await page.locator('button.saveButton').click();
    await expect.poll(() => page.url(), { timeout: 20000 }).toBe(`${applicant}?next=stay`);
    await expect(page.locator('#lastName')).toHaveValue(syntheticProfile.lastName, { timeout: 20000 });
    widget = await launcherFrame();
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
    await expect(widget.locator('#stop')).toBeVisible();
    assert.equal(await page.evaluate(() => window.__nextClicks), 1, 'Verified complete applicant continues once.');
    assert.equal((await calls('getFields')).length, 1);
    console.log('Autopilot: one click continued Before You Start, waited at consent, then continued Important Information and Instructions and filled the applicant page.');

    // The household question is answered from saved program choices; the CAPTCHA stays with the applicant.
    await resetTo(`${portal}/applyForBenefits/guestLogin`);
    widget = await launcherFrame();
    await widget.evaluate(() => localStorage.removeItem('secondhand.autofillStarted'));
    await widget.locator('#autofill').click();
    await expect(page.locator('#householdApplyProgYes')).toBeChecked({ timeout: 20000 });
    // The fill revealed the security check, so the step after it leaves the applicant's next move on the card.
    await expect(widget.locator('#widget-text')).toHaveText('Type the characters shown in Iowa’s security check, then click Continue. Stop erases nothing.', { timeout: 20000 });
    assert.deepEqual((await calls('getFields'))[0].fields, ['programSnap', 'programFip', 'programMedicaid']);
    assert.equal(await page.evaluate(() => window.__continues), 0);
    console.log('Autopilot: the household question is answered from saved programs and the CAPTCHA is left to the applicant.');

    // On an Iowa page SecondHand doesn't fill, the widget says what Autofill will do, then the whole next step,
    // every word of it on screen, in each language SecondHand speaks, in a frame never past 272 by 166 (#110).
    // The language is chosen as the side panel saves it, in the extension's own storage.
    const host = page.locator('[data-secondhand-assistant]');
    const frameBox = () => host.boundingBox();
    const widgetLine = frame => frame.evaluate(() => {
      const text = document.getElementById('widget-text'), box = text.getBoundingClientRect(), card = document.getElementById('widget').getBoundingClientRect();
      const inside = rect => rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      // Letters overhang their line by a pixel or so; a line cut off is 16px more.
      return { text: text.textContent, shown: !text.classList.contains('visually-hidden') && box.width > 0 && box.height > 0,
        clipped: text.scrollHeight - text.clientHeight > 7, inFrame: inside(box) && inside(card), dir: document.documentElement.dir };
    });
    const lineProblems = async (frame, expected, code) => {
      const line = await widgetLine(frame), box = await frameBox();
      return [line.text !== expected && `text "${line.text}"`, !line.shown && 'line hidden', line.clipped && 'line clipped',
        !line.inFrame && 'line past the frame', box.width > 272 && `frame ${box.width}px wide`, box.height > 166 && `frame ${box.height}px tall`,
        line.dir !== strings.direction(code) && `dir ${line.dir}`].filter(Boolean);
    };
    const stopNote = code => strings.text(code, 'widget.stopNote');
    const wholeSteps = [
      { name: 'Job Information', url: selfDetailsUrl, pageKey: 'iowa-job-screening-unverified', line: code => `${strings.text(code, 'iowa.laterManualTodo')} ${stopNote(code)}` },
      { name: 'unexpected Enter Personal Information', url: `${applicant}?next=unexpected`, pageKey: 'iowa-personal-unverified', line: code => `${strings.text(code, 'iowa.personalUnverifiedTodo')} ${stopNote(code)}` },
      // Save and Continue disabled: SecondHand fills the page and does not continue.
      { name: 'Enter Personal Information, Save and Continue disabled', url: `${applicant}?next=stay`, pageKey: 'iowa-personal-information', disabled: true,
        line: (code, filled) => `${strings.text(code, 'result.thenTodo', { summary: { key: 'result.filled', params: { count: filled } }, todo: { key: 'iowa.reviewSaveContinue' } })} ${stopNote(code)}` },
      // A question left: Autofill fills the rest and waits, with its longest line, beside the offer of the
      // questions in the reader's language where there is one.
      { name: 'Enter Personal Information, a question left', url: `${applicant}?next=stay`, pageKey: 'iowa-personal-information', profile: { firstName: '' },
        line: (code, filled) => `${strings.text(code, 'result.thenTodo', { summary: { key: 'result.filled', params: { count: filled } }, todo: { key: 'iowa.missingAnswers' } })} ${strings.text(code, 'widget.stopToCheck')}` }
    ];
    // Before Autofill: Autofill has been started from this profile above, so the card speaks only where it matters.
    // On the applicant page it says what the address page after it may bring; elsewhere it is its buttons. On these
    // English pages the widget may offer the page in the applicant's language too.
    const beforeProblems = async (frame, code, pageKey) => {
      const offer = await frame.evaluate(() => !document.getElementById('translate-offer').hidden);
      const english = code === 'en' && offer && 'offer on an English page';
      if (pageKey !== 'iowa-personal-information') {
        const shown = await frame.evaluate(() => !document.getElementById('widget-text').classList.contains('visually-hidden'));
        return [shown && 'a line where there is nothing to say', english].filter(Boolean);
      }
      return [...await lineProblems(frame, strings.text(code, 'widget.addressNext'), code), english].filter(Boolean);
    };
    // On a narrow page the widget is as wide as its buttons alone, or the least wider that shows its whole line:
    // a frame 24px narrower would be narrower than the buttons, or would cut the line.
    const narrowest = frame => frame.evaluate(() => {
      const card = document.getElementById('widget'), text = document.getElementById('widget-text');
      const width = Math.ceil(card.getBoundingClientRect().width);
      card.style.maxWidth = '272px'; text.classList.add('visually-hidden');
      const buttons = Math.ceil(card.getBoundingClientRect().width);
      text.classList.remove('visually-hidden');
      card.style.width = `${width - 24}px`;
      const cut = text.scrollHeight - text.clientHeight > 7;
      const detail = `${width}px wide, buttons ${buttons}px, at ${width - 24}px the line ${cut ? 'is cut' : 'shows whole'} (${text.scrollHeight} of ${text.clientHeight}), frame ${innerWidth}px`;
      for (const property of ['max-width', 'width']) card.style.removeProperty(property);
      return width - 24 < buttons || cut ? '' : detail;
    });
    const measured = [];
    currentSelfVariant = 'job';
    for (const code of strings.LANGUAGES) {
      await resetTo(wholeSteps[0].url);
      await (await launcherFrame()).evaluate(code => globalThis.SecondHandStrings.setLanguage(code), code);
      // Until Autofill is first started from this Chrome, the line says all of what it does, and all of it shows.
      await (await launcherFrame()).evaluate(() => localStorage.removeItem('secondhand.autofillStarted'));
      await resetTo(wholeSteps[0].url);
      widget = await launcherFrame();
      await expect(widget.locator('#autofill')).toBeVisible({ timeout: 20000 });
      await expect.poll(() => lineProblems(widget, strings.text(code, 'widget.iowaReady'), code), { timeout: 10000, message: `${code} before the first Autofill` }).toEqual([]);
      const first = await frameBox();
      measured.push(`${code} before the first Autofill: ${first.width}x${first.height}`);
      await widget.evaluate(() => localStorage.setItem('secondhand.autofillStarted', '1'));
      for (const step of wholeSteps) {
        await resetTo(step.url, { profile: step.profile });
        widget = await launcherFrame();
        await expect(widget.locator('#autofill')).toBeVisible({ timeout: 20000 });
        if (step.disabled) await page.locator('.saveAndContinueButton').evaluate(button => button.setAttribute('disabled', ''));
        await expect.poll(() => beforeProblems(widget, code, step.pageKey), { timeout: 10000, message: `${code} ${step.name} before Autofill` }).toEqual([]);
        const before = await frameBox();
        const offered = await widget.locator('#translate-offer').isVisible();
        if (step.pageKey === 'iowa-personal-information' || offered) assert.ok(before.height > 46, `${code} ${step.name} before Autofill: the frame holds the line (${before.width} by ${before.height})`);
        else assert.equal(before.height, 46, `${code} ${step.name} before Autofill: the card is its buttons`);
        // As on a first run, so the line after the click is its longest: it ends with what Stop would do.
        await widget.evaluate(() => localStorage.removeItem('secondhand.autofillStarted'));
        await widget.locator('#autofill').click();
        await expect.poll(async () => (await widget.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pageState' })))?.data?.result?.state, { timeout: 20000 }).toMatch(/^(waiting|done)$/);
        const { page: probed, result } = (await widget.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pageState' }))).data;
        assert.equal(probed.pageKey, step.pageKey, `${step.name} is classified as ${step.pageKey}`);
        if (step.disabled || step.profile) assert.ok(result.filled > 0, 'SecondHand fills the applicant page');
        // A disabled button fires no click, so the worker's own result says it never tried to continue
        // (it would say it is continuing, or waiting after a try).
        if (step.disabled) assert.equal(result.state, 'done', 'SecondHand does not try to continue');
        // Autofill is still on, waiting for the applicant: the line ends with what Stop would do.
        const expected = step.line(code, result.filled);
        await expect.poll(() => lineProblems(widget, expected, code), { timeout: 10000, message: `${code} ${step.name}` }).toEqual([]);
        assert.equal(await page.evaluate(() => window.__nextClicks || 0), 0, 'SecondHand does not continue');
        if (!step.disabled && !step.profile) assert.deepEqual(await calls('getFields'), [], 'nothing is asked of the desktop for a page SecondHand does not fill');
        const after = await frameBox();
        measured.push(`${code} ${step.name}: ${before.width}x${before.height} before${offered ? ' (language offer)' : ''}, ${after.width}x${after.height} after`);
      }
    }
    for (const line of measured) console.log(`Widget frame, ${line}.`);
    console.log(`Widget: on Iowa pages SecondHand doesn’t fill, what Autofill will do and then the whole next step show in ${strings.LANGUAGES.join(', ')}, in a frame no larger than 272 by 166, and Arabic reads right to left.`);
    await (await launcherFrame()).evaluate(() => globalThis.SecondHandStrings.setLanguage('en'));

    // The keyboard can hide the widget, down to its logo and the word Show in the page's corner, and bring it back from there.
    widget = await startFixture();
    await widget.locator('#autofill').focus();
    await page.keyboard.press('Tab');
    await expect(widget.locator('#hide')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(widget.locator('#pill')).toBeFocused();
    await expect(widget.locator('#autofill')).toBeHidden();
    await expect.poll(async () => { const box = await host.boundingBox(); return box.height === 46 && box.width > 46 && box.width < 140; }, { timeout: 10000 }).toBe(true);
    assert.equal(await host.evaluate(element => element.style.borderRadius), '23px');
    await expect(widget.locator('#pill-label')).toHaveText('Show');
    // The logo fills its round frame, so the keyboard's ring is drawn inside the circle, where it shows.
    await expect(widget.locator('#pill:focus-visible')).toBeVisible();
    const ring = await widget.evaluate(() => { const style = getComputedStyle(document.getElementById('pill')); return [style.outlineStyle, style.outlineWidth, style.outlineOffset]; });
    assert.deepEqual(ring, ['solid', '3px', '-5px'], 'a 3px ring, 5px inside the logo’s edge');
    await page.keyboard.press('Enter');
    await expect(widget.locator('#autofill')).toBeVisible();
    await expect(widget.locator('#hide')).toBeFocused();
    await expect.poll(async () => (await host.boundingBox()).height, { timeout: 10000 }).toBeGreaterThan(46);
    assert.equal(await host.evaluate(element => element.style.borderRadius), '12px');
    assert.deepEqual(await calls('getFields'), [], 'hiding and showing the widget asks nothing of the desktop');
    // Hidden, the card stays hidden on the tab's next page, and its logo says when the hidden card needs the reader.
    await widget.locator('#hide').click();
    await expect(widget.locator('#pill')).toBeVisible();
    await page.goto(`${portal}/applyForBenefits/guestLogin`, { waitUntil: 'domcontentloaded' });
    widget = await launcherFrame();
    await expect(widget.locator('#pill')).toBeVisible({ timeout: 15000 });
    await expect(widget.locator('#widget')).toBeHidden();
    await expect.poll(async () => { const box = await host.boundingBox(); return box.height === 46 && box.width > 46 && box.width < 140; }, { timeout: 10000 }).toBe(true);
    await expect(widget.locator('#pill-label')).toHaveText('Show');
    await expect(widget.locator('#pill')).toHaveAttribute('aria-label', 'Show SecondHand’s card');
    await widget.locator('#pill').click();
    await expect(widget.locator('#autofill')).toBeVisible();
    await widget.locator('#autofill').click();
    await expect(page.locator('#householdApplyProgYes')).toBeChecked({ timeout: 20000 });
    await widget.locator('#hide').click();
    await expect(widget.locator('#pill')).toHaveClass(/waiting/);
    await expect(widget.locator('#pill')).toHaveAttribute('aria-label', 'Show · needs you: SecondHand’s card');
    await widget.locator('#pill').click();
    await expect(widget.locator('#stop')).toBeVisible();
    console.log('Widget: Tab reaches its hide control; Enter leaves the round logo, and Enter on the logo brings the widget back. Hidden, it stays hidden on the next page, and the logo says when it needs the reader.');

    // A narrow page (an old laptop at high zoom with the side panel open leaves about 260px): the
    // widget keeps its buttons' width and its line takes more rows, all of it inside the frame.
    const settledLine = async (code, expected) => {
      await expect.poll(async () => (await widget.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pageState' })))?.data?.result?.state, { timeout: 20000 }).toMatch(/^(waiting|done)$/);
      const { result } = (await widget.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pageState' }))).data;
      await expect.poll(() => lineProblems(widget, expected(result.filled), code), { timeout: 10000, message: `${code} at ${page.viewportSize().width}px` }).toEqual([]);
    };
    await page.setViewportSize({ width: 260, height: 900 });
    for (const code of strings.LANGUAGES) {
      await (await launcherFrame()).evaluate(code => globalThis.SecondHandStrings.setLanguage(code), code);
      await resetTo(selfDetailsUrl);
      widget = await launcherFrame();
      await expect.poll(() => beforeProblems(widget, code, 'iowa-self-details-unverified'), { timeout: 10000, message: `${code} at 260px before Autofill` }).toEqual([]);
      const before = await frameBox();
      await expect.poll(() => narrowest(widget), { timeout: 10000, message: `${code} at 260px before Autofill: the widget is as narrow as its line lets it be` }).toBe('');
      // As on a first run, so the line is its longest (see above).
      await widget.evaluate(() => localStorage.removeItem('secondhand.autofillStarted'));
      await widget.locator('#autofill').click();
      await settledLine(code, () => wholeSteps[0].line(code));
      await expect.poll(() => narrowest(widget), { timeout: 10000, message: `${code} at 260px: the widget is as narrow as its line lets it be` }).toBe('');
      const after = await frameBox();
      console.log(`Widget frame, ${code} Job Information at 260px: ${before.width}x${before.height} before, ${after.width}x${after.height} after.`);
    }
    currentSelfVariant = 'verified';

    // Save and Continue stays clear of the widget, on Enter Personal Information scrolled to the bottom:
    // its left at every width, and all of it from 512px. The widget's buttons, its hide control and the
    // offer of the questions in the reader's language make it wider than the compact widget before it, so
    // under 512px it covers more of the button's right side (the reader can hide it). Under 640px the
    // widget's width doesn't depend on the page's, so 390px also shows each language's line fits.
    const clearOf = { 390: ['left'], 427: ['left', 'center'], 455: ['left', 'center'], 512: ['left', 'center', 'right'], 640: ['left', 'center', 'right'] };
    for (const code of strings.LANGUAGES) {
      await (await launcherFrame()).evaluate(code => globalThis.SecondHandStrings.setLanguage(code), code);
      for (const [width, points] of Object.entries(clearOf).filter(([width]) => ['en', 'es'].includes(code) || width === '390')) {
        await page.setViewportSize({ width: Number(width), height: 700 });
        await resetTo(`${applicant}?next=stay`);
        widget = await launcherFrame();
        await expect(widget.locator('#autofill')).toBeVisible();
        await page.locator('.saveAndContinueButton').evaluate(button => button.setAttribute('disabled', ''));
        await expect.poll(() => beforeProblems(widget, code, 'iowa-personal-information'), { timeout: 10000, message: `${code} at ${width}px before Autofill` }).toEqual([]);
        const before = await frameBox();
        await widget.evaluate(() => localStorage.removeItem('secondhand.autofillStarted'));
        await widget.locator('#autofill').click();
        await settledLine(code, filled => wholeSteps[2].line(code, filled));
        if (Number(width) < 640) await expect.poll(() => narrowest(widget), { timeout: 10000, message: `${code} at ${width}px: the widget is as narrow as its line lets it be` }).toBe('');
        const after = await frameBox();
        await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
        const { clear, button } = await page.evaluate(() => {
          const button = document.querySelector('.saveAndContinueButton'), box = button.getBoundingClientRect(), y = box.top + box.height / 2;
          return { clear: [['left', box.left + 2], ['center', box.left + box.width / 2], ['right', box.right - 2]]
            .filter(([, x]) => button.contains(document.elementFromPoint(x, y))).map(([point]) => point), button: `${Math.round(box.left)}..${Math.round(box.right)} by ${Math.round(box.top)}..${Math.round(box.bottom)}` };
        });
        console.log(`Widget frame, ${code} Save and Continue disabled at ${width}px: ${before.width}x${before.height} before, ${after.width}x${after.height} after (${Math.round(after.x)}..${Math.round(after.x + after.width)} by ${Math.round(after.y)}..${Math.round(after.y + after.height)}); button at ${button}, clear at ${clear.join(', ') || 'no point'}.`);
        for (const point of points) assert.ok(clear.includes(point), `${code} at ${width}px: Save and Continue's ${point} is clear of the widget (clear: ${clear.join(', ') || 'none'})`);
      }
    }
    await page.setViewportSize({ width: 1200, height: 900 });
    await widget.evaluate(key => localStorage.removeItem(key), strings.STORAGE_KEY);
    console.log('Widget: on narrow pages it stays inside its frame, is as narrow as its line lets it be, and leaves Save and Continue\'s left clear.');

    // Other portal pages show only a small pill and never contact the desktop.
    await resetTo(`${portal}/applyForBenefits/householdMembers`);
    await expect(page.locator('[data-secondhand-assistant]')).toHaveAttribute('data-secondhand-size', 'pill');
    widget = await launcherFrame();
    await expect(widget.locator('#pill')).toBeVisible();
    await expect(widget.locator('#widget')).toBeHidden();
    assert.deepEqual(await worker.evaluate(() => globalThis.__nativeSmoke.calls), []);
    // The side panel shows the same page as a plain checklist and never renders values.
    // It runs last: in headless Chromium the open panel covers the widget's corner.
    widget = await startFixture();
    await widget.locator('#autofill').click();
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
    await widget.locator('#details').click();
    panel = await attachNativePanel(context, page, extensionId);
    await expect.poll(() => panel.text('[data-key="lastName"]'), { timeout: 15000 }).toContain('Done');
    // An unlocked app needs nothing from the applicant, so the panel's desktop row stays out of the way.
    assert.deepEqual(await panel.evaluate(async () => { const { data } = await chrome.runtime.sendMessage({ type: 'ui:desktopStatus' }); return [data.connected, data.unlocked]; }), [true, true]);
    assert.equal(await panel.visible('#desktop-status'), false);
    assert.equal(await panel.text('#desktop-status'), '');
    const sidebarText = await panel.evaluate(() => document.body.innerText);
    const sidebarMessage = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id }));
    });
    for (const value of [syntheticProfile.firstName, syntheticProfile.middleName, syntheticProfile.addressLine1, syntheticProfile.homePhone, syntheticProfile.mailingAddressLine1]) {
      assert.equal(sidebarText.includes(value), false, `Sidebar must never render a profile value: ${value}`);
      assert.equal(sidebarMessage.includes(value), false, `Sidebar messages must never receive a profile value: ${value}`);
    }
    await panel.screenshot(path.join(root, 'artifacts/extension-native-sidebar.png'));
    console.log('Side panel: checklist and desktop status without profile values.');
    // Autofill's button and status stay in view while the checklist scrolls, and never cover the row the
    // keyboard is on: from the end of the list, focus on the first row brings it into view below them.
    const pinned = await panel.evaluate(async () => {
      const scroller = document.getElementById('sidepanel'), strip = document.querySelector('.actions'), row = document.querySelector('#page-checklist .checklist-item');
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const scrolled = scroller.scrollTop > 200, held = Math.round(strip.getBoundingClientRect().top) === 0 && document.getElementById('panel-autofill').getClientRects().length > 0;
      row.focus();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { scrolled, held, clear: row.getBoundingClientRect().top >= strip.getBoundingClientRect().bottom };
    });
    assert.deepEqual(pinned, { scrolled: true, held: true, clear: true });
    await panel.evaluate(() => { document.activeElement.blur(); document.getElementById('sidepanel').scrollTop = 0; });
    console.log('Side panel: Autofill and its status stay in view over the scrolled checklist, clear of the row in focus.');

    // With SecondHand closed, Autofill fills nothing and the one desktop line and its Open SecondHand
    // button say so, not a red repeat under Autofill. Opening it waits for the app, then offers Unlock.
    await resetTo(`${applicant}?next=stay`);
    await worker.evaluate(() => { globalThis.__nativeSmoke.closed = true; });
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect.poll(() => panel.text('#desktop-status'), { timeout: 15000 }).toBe('The SecondHand app on this computer is closed.');
    await expect.poll(() => panel.text('#desktop-action')).toBe('Open SecondHand');
    assert.equal(await panel.visible('#desktop-action'), true);
    await expect.poll(() => panel.text('#status')).toBe('');
    assert.equal(await panel.evaluate(() => document.getElementById('status').classList.contains('error')), false);
    await expect(page.locator('#firstName')).toHaveValue('');
    await expect((await launcherFrame()).locator('#open-app')).toBeVisible({ timeout: 15000 });
    await panel.click('#desktop-action');
    await expect.poll(() => panel.text('#desktop-status'), { timeout: 10000 }).toBe('The SecondHand app on this computer is locked.');
    await expect.poll(() => panel.text('#desktop-action')).toBe('Unlock');
    assert.equal((await calls('openApp')).length, 1);
    await panel.click('#desktop-action');
    await expect.poll(async () => (await calls('showApp')).length).toBe(1);
    console.log('Side panel: with SecondHand closed, one line and Open SecondHand; opening it waited for the app, then offered Unlock.');

    // Existing answers are not overwritten, including answers a saved parent
    // choice would clear through a portal conditional handler.
    await resetTo(`${applicant}?next=stay`, { profile: { mailingSameAsHome: 'yes' } });
    await page.locator('#firstName').fill('Preserved fictional name');
    await page.locator('#hasHome1').check();
    await page.locator('#sameAddress2').check();
    await page.locator('#mailingAddressLine1').fill('Preserved fictional mailing');
    await page.locator('#sameAddress2').evaluate(element => { element.checked = false; });
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect(page.locator('#lastName')).toHaveValue(syntheticProfile.lastName, { timeout: 20000 });
    await expect(page.locator('#firstName')).toHaveValue('Preserved fictional name');
    await expect(page.locator('#mailingAddressLine1')).toHaveValue('Preserved fictional mailing');
    await expect(page.locator('#sameAddress1')).not.toBeChecked();
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    console.log('Applicant: prefilled answers and dependent mailing details remain unchanged.');

    // A genuine document unload exercises native sidebar/tab identity and private
    // address snapshots. The address authorization returns no saved fields.
    for (const variant of ['original', 'second']) {
      currentAddressVariant = variant;
      verifiedApplicantClicks = 0; verifiedAddressLoads = 0; documentManualLoads = 0; verifiedAddressNext.length = 0;
      await resetTo(`${applicant}?next=verified-address-${variant}`, { profile: { mailingSameAsHome: 'yes' } });
      await worker.evaluate(() => { globalThis.__nativeSmoke.holdAddressNavigation = true; });
      await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
      await panel.click('#panel-autofill');
      await expect.poll(() => page.url(), { timeout: 20000 }).toBe(addressUrl);
      await expect.poll(() => worker.evaluate(() => globalThis.__nativeSmoke.addressAuthorizationWaiting), { timeout: 20000 }).toBe(true);
      await expect(page.locator('#homeAddressIndex0')).not.toBeChecked();
      await expect(page.locator('#homeAddressIndex1')).toBeChecked();
      await expect.poll(() => panel.text('[data-key="addressReview"]')).toContain('First suggested home address');
      const metadata = await panel.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return JSON.stringify(await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id }));
      });
      const text = await panel.evaluate(() => document.body.innerText);
      for (const value of ['411 Morrill', '411 MORRILL', '415 MORRILL', 'Ames', 'AMES', '50011']) {
        assert.equal(text.includes(value), false); assert.equal(metadata.includes(value), false);
      }
      await worker.evaluate(() => { const state = globalThis.__nativeSmoke; state.holdAddressNavigation = false; state.releaseAddressNavigation(); });
      await expect.poll(() => page.url(), { timeout: 20000 }).toBe(documentManualUrl);
      await expect.poll(() => verifiedAddressNext.length).toBe(1);
      assert.equal(verifiedApplicantClicks, 1); assert.equal(verifiedAddressLoads, 1); assert.equal(documentManualLoads, 1);
      assert.deepEqual(verifiedAddressNext, [{ selectionClicks: ['0'], selectedIndexes: [['0']], shownCountyRows: [[]], nextClicks: 1 }]);
      const requests = await calls('getFields');
      assert.equal(requests.length, 2);
      assert.deepEqual(requests.filter(call => call.url === addressUrl).map(call => call.fields), [[]]);
      await settled();
      assert.equal((await calls('getFields')).length, 2);
      assert.equal(await page.evaluate(() => window.__manualNextClicks), 0);
      console.log(`Address ${variant}: one applicant Next, first suggestion selected, one address Next, no address profile values.`);
    }

    for (const variant of ['error', 'modal', 'mailing']) {
      currentAddressVariant = variant; verifiedAddressNext.length = 0;
      await resetTo(addressUrl);
      await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
      const before = await page.evaluate(() => JSON.stringify(document.__addressQa));
      const requests = (await calls('getFields')).length;
      await autofillSettled();
      await expect(page.locator('#homeAddressIndex0')).not.toBeChecked();
      await expect(page.locator('#homeAddressIndex1')).toBeChecked();
      assert.equal(await page.evaluate(() => JSON.stringify(document.__addressQa)), before);
      assert.equal((await calls('getFields')).length, requests);
      assert.deepEqual(verifiedAddressNext, []);
      console.log(`Address ${variant}: unsupported variation stays manual and unchanged.`);
    }

    // The entered address is chosen and Iowa shows its county question, defaulted to the wrong county.
    const enteredCounty = page.locator('[id="homeAddressLst1.county"]');
    currentAddressVariant = 'county'; verifiedAddressNext.length = 0; documentManualLoads = 0;
    await resetTo(addressUrl);
    await expect(page.locator('#homeAddressIndex1')).toBeChecked();
    await expect(enteredCounty).toBeVisible();
    await expect.poll(() => panel.text('[data-key="addressReview"]')).toContain('Not filled yet');
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect.poll(() => page.url(), { timeout: 20000 }).toBe(documentManualUrl);
    await expect.poll(() => verifiedAddressNext.length).toBe(1);
    assert.deepEqual(verifiedAddressNext, [{ selectionClicks: ['0'], selectedIndexes: [['0']], shownCountyRows: [[]], nextClicks: 1 }]);
    assert.equal(documentManualLoads, 1);
    assert.deepEqual((await calls('getFields')).map(call => ({ url: call.url, fields: call.fields })), [{ url: addressUrl, fields: [] }]);
    console.log('Address county: first suggestion selected, county hidden, one Save and Continue.');

    // If Iowa keeps the county question shown after the switch, the page is left to the applicant.
    currentAddressVariant = 'countyStays'; verifiedAddressNext.length = 0;
    await resetTo(addressUrl);
    await expect(enteredCounty).toBeVisible();
    const countyBefore = await enteredCounty.inputValue();
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect.poll(() => page.evaluate(() => document.__addressQa.selectionClicks.length), { timeout: 20000 }).toBe(1);
    await expect.poll(() => panel.text('[data-key="addressReview"]')).toContain('Do it yourself');
    await settled();
    assert.deepEqual(await page.evaluate(() => document.__addressQa), { selectionClicks: ['0'], selectedIndexes: [], shownCountyRows: [], nextClicks: 0 });
    await expect(enteredCounty).toBeVisible();
    assert.equal(await enteredCounty.inputValue(), countyBefore);
    assert.equal(page.url(), addressUrl);
    assert.deepEqual(verifiedAddressNext, []);
    console.log('Address county stays visible: stays manual; Save and Continue not pressed and the county untouched.');

    await resetTo(`${applicant}?next=address-review`, { profile: { mailingSameAsHome: 'yes' } });
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect(page.locator('[data-qa-only]')).toBeVisible({ timeout: 20000 });
    await expect.poll(() => panel.text('[data-key="addressReview"]')).toContain('address');
    const hypotheticalRequests = (await calls('getFields')).length;
    await settled();
    assert.equal(await page.evaluate(() => window.__addressNextClicks), 0);
    assert.equal(await page.evaluate(() => window.__addressChoiceEvents), 0);
    assert.equal((await calls('getFields')).length, hypotheticalRequests);
    console.log('Hypothetical Select Address controls remain manual; no fabricated schema is activated.');

    // Authorization receipt becomes stale if the desktop locks before navigation.
    currentAddressVariant = 'original'; verifiedAddressNext.length = 0;
    await resetTo(addressUrl);
    await worker.evaluate(() => { globalThis.__nativeSmoke.lockAfterFields = true; });
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect.poll(() => panel.text('#status')).toMatch(/lock|unlock|changed/i);
    await expect(page.locator('#homeAddressIndex1')).toBeChecked();
    assert.deepEqual(verifiedAddressNext, []);
    assert.equal(await page.evaluate(() => document.__addressQa.nextClicks), 0);
    console.log('A desktop lock after authorization prevents address selection and Next.');

    const selfControls = () => page.evaluate(dobId => Array.from(document.querySelectorAll('input')).filter(element => element.id !== dobId)
      .map(element => ({ id: element.id, name: element.name, value: element.value, checked: element.checked })), selfFixture.DOB_ID);
    currentSelfVariant = 'verified';
    await resetTo(selfDetailsUrl);
    const untouched = await selfControls();
    await expect.poll(() => panel.text('[data-key="birthDate"]')).toContain('Date of birth');
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect(page.locator(`[id="${selfFixture.DOB_ID}"]`)).toHaveValue('04/12/1985', { timeout: 20000 });
    await expect.poll(() => panel.text('[data-key="birthDate"]')).toContain('Done');
    await settled();
    assert.deepEqual(await selfControls(), untouched);
    assert.deepEqual(await page.evaluate(() => window.__selfQa), { nextClicks: 0, manualChanges: 0 });
    assert.deepEqual((await calls('getFields')).map(call => ({ url: call.url, fields: call.fields })), [{ url: selfDetailsUrl, fields: ['birthDate'] }]);
    const dobMetadata = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id }));
    });
    const dobText = await panel.evaluate(() => document.body.innerText);
    for (const value of ['Avery', 'Example', '1985-04-12', '04/12/1985']) {
      assert.equal(dobMetadata.includes(value), false); assert.equal(dobText.includes(value), false);
    }
    console.log('Tell Us More: only self DOB filled/formatted; manual questions and Next untouched; no answers in sidebar.');
    for (const variant of ['people', 'form', 'heading']) {
      currentSelfVariant = variant;
      await resetTo(selfDetailsUrl);
      await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
      await autofillSettled();
      await expect(page.locator(`[id="${selfFixture.DOB_ID}"]`)).toHaveValue('');
      assert.deepEqual(await calls('getFields'), []);
      assert.deepEqual(await page.evaluate(() => window.__selfQa), { nextClicks: 0, manualChanges: 0 });
      console.log(`Tell Us More ${variant}: mismatched context stays manual.`);
    }

    // Tell Us More at dynamicQuestionsStart with the original non-number answers saved: Autofill types the date of birth,
    // picks the marital status and clicks each saved answer, then answers the Social Security card
    // question Iowa's script shows after Yes. The number box stays empty and Save and Continue is never
    // clicked. (The native stub answers hasSsn itself, as the desktop works it out from saved answers.)
    const startFields = ['sex', 'birthDate', 'hasSsn', 'ssn', 'ssnCardNameMatches', 'ssnCardFirstName', 'ssnCardMiddleName', 'ssnCardLastName', 'usCitizen', 'householdAllCitizens', 'bornInUs', 'maritalStatus',
      'militaryOrVeteran', 'eatsMealsWithHousehold', 'disabled', 'householdDisability', 'blind', 'healthLimitation', 'medicare', 'householdMedicare', 'pregnant', 'pregnancyDueDate', 'pregnancyExpectedBabies'];
    const startRows = ['gender', 'birthDate', 'hasSsn', 'ssnCardName', 'usCitizen', 'maritalStatus', 'militaryOrVeteran', 'hasDisability', 'blind', 'healthLimits', 'hasMedicare'];
    const startChecked = () => page.evaluate(() => Array.from(document.querySelectorAll('#answerSet input[type="radio"]')).filter(element => element.checked).map(element => element.id));
    const startBoxes = () => page.evaluate(ids => ids.map(id => document.getElementById(id).value),
      [tellUsMore.SSN_BOX_ID, 'answerSets0.answers12.answerValue', 'answerSets0.answers15.answerValue', 'answerSets0.answers16.answerValue']);
    await resetTo(startDetailsUrl, { profile: { hasSsn: 'yes' } });
    const answered = [['gender', 2], ['hasSsn', 1], ['ssnCardName', 1], ['usCitizen', 1], ['militaryOrVeteran', 2], ['hasDisability', 2], ['blind', 2], ['healthLimits', 2], ['hasMedicare', 2]]
      .map(([key, option]) => tellUsMore.radioId(tellUsMore.ANSWERS[key], option));
    await expect.poll(() => panel.text('[data-key="gender"]')).toContain('Are you male or female?');
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect(page.locator(`[id="${tellUsMore.DOB_ID}"]`)).toHaveValue('04/12/1985', { timeout: 20000 });
    await expect.poll(startChecked, { timeout: 20000 }).toEqual(answered);
    await expect(page.locator(`[id="${tellUsMore.MARITAL_ID}"]`)).toHaveValue('Never Married');
    for (const key of startRows) await expect.poll(() => panel.text(`[data-key="${key}"]`)).toContain('Done');
    await settled();
    assert.deepEqual(await startChecked(), answered);
    assert.deepEqual(await startBoxes(), ['', '', '', '']);
    assert.deepEqual(await page.evaluate(() => window.__startQa), { nextClicks: 0, shown: ['question08008', 'question08107', 'question08108', 'question08109',
      'question03261', 'question03262', 'question03263', 'question03', 'question04068', 'question04070', 'question04071', 'question04072', 'question06181'] });
    assert.deepEqual((await calls('getFields')).map(call => ({ url: call.url, fields: call.fields })), [{ url: startDetailsUrl, fields: startFields }]);
    const startMetadata = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id }));
    });
    const startText = await panel.evaluate(() => document.body.innerText);
    for (const value of ['Avery', 'Example', '1985-04-12', '04/12/1985', 'Female', 'Never Married']) {
      assert.equal(startMetadata.includes(value), false, value); assert.equal(startText.includes(value), false, value);
    }
    console.log('Tell Us More (dynamicQuestionsStart): all ten original questions and the revealed card question filled; an unsaved SSN stays blank and Next stays manual.');

    // The newly supported follow-ups use the captured controls and the same bounded multi-pass
    // flow. No masking-script synchronization is fabricated: the submitted hidden mirror stays empty.
    const sensitiveProfile = { hasSsn: 'yes', ssn: '123456789', ssnCardNameMatches: 'no',
      ssnCardFirstName: 'Alex', ssnCardMiddleName: 'Quinn', ssnCardLastName: 'Sample' };
    const cardIds = ['answerSets0.answers12.answerValue', 'answerSets0.answers15.answerValue', 'answerSets0.answers16.answerValue'];
    const ssnMirror = () => page.locator('input[name="answerSets[0].answers[8].answerValue"]');
    await resetTo(startDetailsUrl, { profile: sensitiveProfile });
    await expect(page.locator(`[id="${tellUsMore.SSN_BOX_ID}"]`)).toBeHidden();
    for (const id of cardIds) await expect(page.locator(`[id="${id}"]`)).toBeHidden();
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect.poll(startBoxes, { timeout: 20000 }).toEqual(['123-45-6789', 'Alex', 'Quinn', 'Sample']);
    await expect(page.locator(`[id="${tellUsMore.radioId(11, 2)}"]`)).toBeChecked();
    for (const key of ['ssnCardFirstName', 'ssnCardMiddleName', 'ssnCardLastName']) await expect.poll(() => panel.text(`[data-key="${key}"]`)).toContain('Done');
    await expect.poll(() => panel.text('[data-key="ssn"]')).toContain('Do it yourself');
    await expect(ssnMirror()).toHaveValue('');
    await settled();
    assert.equal(await page.evaluate(() => window.__startQa.nextClicks), 0);
    assert.deepEqual((await calls('getFields')).map(call => call.fields), [startFields]);
    for (const index of [9, 13, 14, 17]) await expect(page.locator(`[id="answerSets0.answers${index}.answerValue"]`)).toHaveValue('');
    const sensitiveMetadata = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id }));
    });
    const sensitiveText = await panel.evaluate(() => document.body.innerText);
    for (const value of ['123456789', '123-45-6789', 'Alex', 'Quinn', 'Sample']) {
      assert.equal(sensitiveMetadata.includes(value), false, value); assert.equal(sensitiveText.includes(value), false, value);
    }
    console.log('Tell Us More conditional SSN/card-name controls: explicit saved answers filled across fresh scans; hidden mirror/alternatives untouched, SSN manual review and Next manual, sidebar has no answer values.');

    // Existing answers are preserved while other eligible blank card fields still fill.
    await resetTo(startDetailsUrl, { profile: sensitiveProfile });
    await page.locator(`[id="${tellUsMore.radioId(6, 1)}"]`).check();
    await page.locator(`[id="${tellUsMore.radioId(11, 2)}"]`).check();
    await page.locator(`[id="${tellUsMore.SSN_BOX_ID}"]`).fill('321-54-9876');
    await page.locator(`[id="${cardIds[0]}"]`).fill('Existing card name');
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect.poll(startBoxes, { timeout: 20000 }).toEqual(['321-54-9876', 'Existing card name', 'Quinn', 'Sample']);
    await expect(ssnMirror()).toHaveValue('');
    assert.equal(await page.evaluate(() => window.__startQa.nextClicks), 0);
    console.log('Tell Us More conditional controls: existing SSN and card first name are preserved.');

    currentStartVariant = 'people';
    await resetTo(startDetailsUrl, { profile: sensitiveProfile });
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await autofillSettled();
    assert.deepEqual(await calls('getFields'), []);
    assert.deepEqual(await startBoxes(), ['', '', '', '']);
    assert.deepEqual(await startChecked(), []);
    assert.equal(await page.evaluate(() => window.__startQa.nextClicks), 0);
    currentStartVariant = 'verified';
    console.log('Tell Us More conditional controls: another-person phase releases no profile fields and fills nothing.');

    // The complete captured layout has a bounded ordinary Next; unsupported follow-ups
    // remain negative cases above. All answers and any mirror behavior here are synthetic.
    const completeStartProfile = { sex: 'Male', hasSsn: 'no', ssn: '', usCitizen: 'no', bornInUs: '',
      militaryOrVeteran: 'no', disabled: 'no', blind: 'no', healthLimitation: 'no', medicare: 'no' };
    const startNextClicks = () => page.evaluate(() => window.__startQa.nextClicks);
    async function startCompleteCase(variant = 'verified', profile = {}) {
      currentStartVariant = variant;
      await resetTo(startDetailsUrl, { profile: { ...completeStartProfile, ...profile } });
      await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
      const since = await workerState();
      await panel.click('#panel-autofill');
      await settled(since);
    }
    await startCompleteCase();
    await expect.poll(startNextClicks, { timeout: 20000 }).toBe(1);
    await settled();
    assert.equal(await startNextClicks(), 1);
    assert.deepEqual((await calls('getFields')).map(call => call.fields), [startFields]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-secondhand-assistant]')).toBeAttached();
    await settled();
    assert.equal(await startNextClicks(), 0, 'same-step reload cannot repeat a potentially accepted Continue');
    assert.equal((await calls('getFields')).length, 1, 'same-step reload does not request the profile again');
    console.log('Tell Us More: complete no-SSN page continues once; reload cannot duplicate the same step.');

    await startCompleteCase('synchronized', { hasSsn: 'yes', ssn: '123456789', ssnCardNameMatches: 'no',
      ssnCardFirstName: 'Alex', ssnCardMiddleName: '', ssnCardLastName: 'Sample' });
    await expect.poll(startNextClicks, { timeout: 20000 }).toBe(1);
    await expect(ssnMirror()).toHaveValue('123456789');
    await expect(page.locator(`[id="${cardIds[1]}"]`)).toHaveValue('');
    const completedMetadata = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id }));
    });
    for (const value of ['123456789', '123-45-6789', 'Alex', 'Sample', '1985-04-12', '04/12/1985', 'pageInstance', 'nextToken', 'accessRevision']) {
      assert.equal(completedMetadata.includes(value), false, value);
    }
    await panel.screenshot(path.join(root, 'artifacts/extension-tell-us-more-complete-sidebar.png'));
    console.log('Tell Us More: matching synthetic SSN mirror permits one Next; optional card middle name stays blank; metadata contains no answers or private tokens.');

    await startCompleteCase('meal', { usCitizen: 'yes', bornInUs: 'yes', eatsMealsWithHousehold: 'no', eatsWithHousehold: 'yes' });
    await expect.poll(startNextClicks, { timeout: 20000 }).toBe(1);
    await expect(page.locator(`[id="${tellUsMore.radioId(21, 1)}"]`)).toBeChecked();
    await expect(page.locator(`[id="${tellUsMore.radioId(25, 2)}"]`)).toBeChecked();
    console.log('Tell Us More: captured birthplace and eating follow-ups use their own explicit answers.');

    for (const variant of ['unknown', 'error', 'modal', 'mirror-mismatch']) {
      await startCompleteCase(variant, variant === 'mirror-mismatch' ? { hasSsn: 'yes', ssn: '123456789', ssnCardNameMatches: 'yes' } : {});
      if (variant !== 'modal') await expect(page.locator(`[id="${tellUsMore.DOB_ID}"]`)).toHaveValue('04/12/1985', { timeout: 20000 });
      await settled();
      assert.equal(await startNextClicks(), 0, variant);
      if (variant === 'modal') assert.deepEqual(await calls('getFields'), []);
      if (variant === 'mirror-mismatch') await expect.poll(() => panel.text('[data-key="ssn"]')).toContain('Do it yourself');
      console.log(`Tell Us More ${variant}: automatic Continue stays paused.`);
    }

    await startCompleteCase('verified', { blind: '' });
    await expect(page.locator(`[id="${tellUsMore.DOB_ID}"]`)).toHaveValue('04/12/1985', { timeout: 20000 });
    await settled();
    assert.equal(await startNextClicks(), 0);
    await page.locator(`[id="${tellUsMore.radioId(27, 2)}"]`).check();
    await expect.poll(startNextClicks, { timeout: 20000 }).toBe(1);
    assert.deepEqual((await calls('getFields')).map(call => call.fields), [startFields, []]);
    console.log('Tell Us More: a missing answer pauses, then manual completion obtains no-data authorization before one Next.');

    for (const interruption of ['lock', 'edited-during-approval']) {
      await startCompleteCase('verified', { blind: '' });
      await expect(page.locator(`[id="${tellUsMore.DOB_ID}"]`)).toHaveValue('04/12/1985', { timeout: 20000 });
      await settled();
      await worker.evaluate(interruption => {
        if (interruption === 'lock') globalThis.__nativeSmoke.lockAfterFields = true;
        else globalThis.__nativeSmoke.holdNavigation = true;
      }, interruption);
      await page.locator(`[id="${tellUsMore.radioId(27, 2)}"]`).check();
      await expect.poll(() => calls('getFields').then(items => items.length), { timeout: 20000 }).toBe(2);
      if (interruption === 'edited-during-approval') {
        await expect.poll(() => worker.evaluate(() => globalThis.__nativeSmoke.navigationAuthorizationWaiting)).toBe(true);
        await page.locator(`[id="${tellUsMore.MARITAL_ID}"]`).selectOption('Widowed');
        await worker.evaluate(() => { const state = globalThis.__nativeSmoke; state.holdNavigation = false; state.releaseNavigation(); });
      }
      await settled();
      assert.equal(await startNextClicks(), 0, interruption);
      console.log(`Tell Us More ${interruption}: authorization cannot continue the changed or locked page.`);
    }
    currentStartVariant = 'verified';

    // With nothing saved, nothing is filled; each row says to type the answer in Iowa's form, and one note above
    // the list says where to save answers for next time.
    await resetTo(startDetailsUrl, { profile: Object.fromEntries(startFields.map(field => [field, ''])) });
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    for (const key of startRows.filter(key => key !== 'ssnCardName')) {
      await expect.poll(() => panel.text(`[data-key="${key}"]`), { timeout: 20000 }).toContain('No saved answer: type it in Iowa’s form');
    }
    assert.equal(await panel.visible('#checklist-note'), true);
    assert.match(await panel.text('#checklist-note'), /add it in the SecondHand app, under My information/);
    await settled();
    assert.deepEqual(await startChecked(), []);
    await expect(page.locator(`[id="${tellUsMore.DOB_ID}"]`)).toHaveValue('');
    await expect(page.locator(`[id="${tellUsMore.MARITAL_ID}"]`)).toHaveValue('');
    assert.deepEqual(await startBoxes(), ['', '', '', '']);
    assert.deepEqual(await page.evaluate(() => window.__startQa), { nextClicks: 0, shown: [] });
    assert.deepEqual((await calls('getFields')).map(call => call.fields), [startFields]);
    console.log('Tell Us More (dynamicQuestionsStart), nothing saved: nothing filled; every row says to type the answer in Iowa’s form, and a note points to My information.');

    // Captured later scalar form through the actual extension. The origin,
    // document injection, UI gesture and one-use Next are real; Iowa handlers
    // and desktop answers remain the explicit isolated QA stubs above.
    await resetTo(backgroundUrl, { profile: { iowaResident: 'yes', migrantSeasonalFarmworker: 'no', preferredLanguage: 'English',
      naturalizedCitizen: 'no', birthState: 'IA', race: '' } });
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    await panel.click('#panel-autofill');
    await expect(page.locator('[id="answerSets0.answers187.answerValue"]')).toHaveValue('Iowa', { timeout: 20000 });
    await expect.poll(() => page.evaluate(() => window.__backgroundQa.nextClicks), { timeout: 20000 }).toBe(1);
    await settled();
    assert.equal(await page.evaluate(() => window.__backgroundQa.nextClicks), 1);
    assert.deepEqual((await calls('getFields')).map(call => call.url), [backgroundUrl]);
    assert.deepEqual(await calls('getRecordFields'), []);
    assert.doesNotMatch(await panel.evaluate(() => document.body.innerText), /Synthetic Example|qa-person|qa-token/);
    console.log('Background Information: exact scalar fields fill and ordinary Next occurs once; no record list is requested.');

    currentSharedPage = 'job';
    const fictionalJob = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000071', person: 'Jordan Sample', workOrTraining: 'Work', startDate: '2026-02-03', selfEmployed: 'no',
      employer: 'Fictional Job QA Company', jobTitle: 'Synthetic Clerk', monthlyHours: '120', amount: '850.50', frequency: 'Every Other Week', tipsOrCommissions: '0',
      incomeExpectedSame: 'yes', changedJobs30Days: 'no', stoppedWorking30Days: 'no', fewerHours30Days: 'no' };
    async function resetJob({ record = fictionalJob, lockAfterRecord = false, holdRecord = false } = {}) {
      await resetTo(jobFixture.URL);
      await worker.evaluate(options => Object.assign(globalThis.__nativeSmoke, options), { record, lockAfterRecord, holdRecord });
      await expect.poll(() => panel.text('#panel-autofill')).toBe('Start Autofill');
    }
    await resetJob();
    await panel.click('#panel-autofill');
    await expect(page.locator('[id="answerSets0.personSelection"]')).toHaveValue('1', { timeout: 20000 });
    await expect(page.locator('[id="answerSets0.answers8.answerValue"]')).toHaveValue('850.50', { timeout: 20000 });
    await expect.poll(() => page.evaluate(() => document.__jobQa.nextClicks), { timeout: 20000 }).toBe(1);
    await settled();
    assert.equal(await page.evaluate(() => document.__jobQa.nextClicks), 1);
    const requests = await calls('getRecordFields'); assert.equal(requests.length, 1);
    assert.equal(requests[0].pageKey, 'iowa-job-history'); assert.equal(requests[0].recordType, 'jobs'); assert.ok(requests[0].fields.includes('person'));
    assert.equal(requests[0].personName, '');
    assert.deepEqual(await calls('getFields'), [], 'record pages never request the scalar profile or whole list');
    const sidebar = await panel.evaluate(() => document.body.innerText);
    assert.doesNotMatch(sidebar, /Jordan Sample|Fictional Job QA Company|Synthetic Clerk|850\.50|aaaaaaaa-bbbb/);
    await panel.screenshot(path.join(root, 'artifacts/extension-job-record-sidebar.png'));
    console.log('Job record: second person selected by exact name, one scoped release, explicit No proofs, private values, and one Next.');

    for (const variant of ['missing', 'owner-conflict', 'locked-receipt', 'edit-during-approval']) {
      await resetJob({ record: variant === 'missing' ? null : fictionalJob, lockAfterRecord: variant === 'locked-receipt', holdRecord: variant === 'edit-during-approval' });
      if (variant === 'owner-conflict') await page.locator('[id="answerSets0.personSelection"]').selectOption('0');
      await panel.click('#panel-autofill');
      await expect.poll(async () => (await calls('getRecordFields')).length, { timeout: 20000 }).toBe(1);
      if (variant === 'edit-during-approval') {
        await expect.poll(() => worker.evaluate(() => globalThis.__nativeSmoke.recordAuthorizationWaiting)).toBe(true);
        await page.locator('[id="answerSets0.personSelection"]').selectOption('0');
        await worker.evaluate(() => { const state = globalThis.__nativeSmoke; state.holdRecord = false; state.releaseRecord(); });
      }
      await settled();
      assert.equal(await page.evaluate(() => document.__jobQa.nextClicks), 0);
      await expect(page.locator('[id="answerSets0.answers8.answerValue"]')).toHaveValue('');
      await expect(page.locator('[id="answerSets0.answers4.answerValue"]')).toHaveValue('');
      assert.deepEqual(await calls('getFields'), []);
      console.log(`Job record ${variant}: no financial fill and no Next.`);
      if (variant !== 'missing') continue;
      // No saved record ends the run, as a lock does: Autofill's button is back, and nothing asks the app again until
      // it is clicked, however many polls pass. Once the record is saved, that one click fills the page (#236).
      await expect.poll(() => panel.text('#status')).toContain(strings.text('en', 'worker.recordMissing'));
      assert.equal(await panel.text('#panel-autofill'), strings.text('en', 'panel.autofillIowa'));
      widget = await launcherFrame();
      await expect(widget.locator('#autofill')).toBeVisible({ timeout: 10000 });
      await expect(widget.locator('#stop')).toBeHidden();
      const saved = await workerState();
      await worker.evaluate(record => { globalThis.__nativeSmoke.record = record; }, fictionalJob);
      await expect.poll(async () => (await workerState()).panelPolls, { timeout: 15000 }).toBeGreaterThanOrEqual(saved.panelPolls + 2);
      await settled();
      assert.equal((await calls('getRecordFields')).length, 1);
      await panel.click('#panel-autofill');
      await expect(page.locator('[id="answerSets0.answers8.answerValue"]')).toHaveValue('850.50', { timeout: 20000 });
      assert.equal((await calls('getRecordFields')).length, 2);
      await settled();
      console.log('Job record missing: the run ends with Start Autofill and the card’s Autofill; saving the record asks nothing until one click, which fills the page.');
    }
    // No saved record, on a first run: the card shows the whole step in each language, 6 lines at most beside the offer
    // of the questions in the reader's language, and its tooltip holds the whole step (#207). The run has ended (#236),
    // so nothing about Stop follows the step.
    for (const code of strings.LANGUAGES) {
      await resetTo(jobFixture.URL);
      await (await launcherFrame()).evaluate(code => { globalThis.SecondHandStrings.setLanguage(code); localStorage.removeItem('secondhand.autofillStarted'); }, code);
      await resetTo(jobFixture.URL);
      widget = await launcherFrame();
      // The side panel is open by now and, headless, covers the card's corner: Autofill is started from the panel.
      await expect.poll(() => panel.text('#panel-autofill')).toBe(strings.text(code, 'panel.autofillIowa'));
      await panel.click('#panel-autofill');
      await expect.poll(async () => (await calls('getRecordFields')).length, { timeout: 20000 }).toBe(1);
      const step = strings.text(code, 'worker.recordMissing');
      await expect.poll(() => lineProblems(widget, step, code), { timeout: 10000, message: `${code} no saved record` }).toEqual([]);
      assert.equal(await widget.locator('#translate-offer').isVisible(), code !== 'en', `${code}: the offer of the questions in the reader's language`);
      assert.equal(await widget.evaluate(() => document.getElementById('widget-text').title), step, `${code}: the tooltip holds the whole step`);
      assert.equal(await page.evaluate(() => document.__jobQa.nextClicks), 0);
    }
    await (await launcherFrame()).evaluate(() => globalThis.SecondHandStrings.setLanguage('en'));
    console.log(`Job record missing: the card shows the whole step in ${strings.LANGUAGES.join(', ')}, and its tooltip holds the step.`);
    currentSharedPage = 'self';

    assert.deepEqual(errors, []);
    console.log('Widget: intro pages show a small pill. All browser fixtures/data were synthetic; native desktop responses were DevTools stubs.');
  } catch (error) {
    if (panel) {
      console.error('Synthetic native sidebar state:', await panel.evaluate(() => document.body.innerText).catch(() => 'unavailable'));
      await panel.screenshot(path.join(root, 'artifacts/extension-panel-failure.png')).catch(() => {});
    }
    if (page) {
      console.error('Synthetic page state:', await page.evaluate(() => ({ url: location.href, nextClicks: window.__nextClicks, fields: Array.from(document.querySelectorAll('input,select'), e => ({ id: e.id, value: e.value, checked: e.checked, visible: Boolean(e.getClientRects().length) })) })).catch(() => 'unavailable'));
      await page.screenshot({ path: path.join(root, 'artifacts/extension-smoke-failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (panel) await panel.close();
    if (context) await context.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fixture, preApplicantPage, verifiedAddressFixture, selfDetailsFixture, installNativeStub, attachNativePanel, portal, applicant, addressUrl, selfDetailsUrl, documentManualUrl, extensionDirectory, syntheticProfile };
