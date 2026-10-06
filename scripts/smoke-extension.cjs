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
  if (!['verified', 'people'].includes(variant)) throw new Error('Unknown Tell Us More QA variant.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tell Us More · isolated QA</title>
    <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:30px}main{max-width:900px}li{display:inline-block;margin-right:12px}label{margin:0 12px 0 4px}input[type=text],select{padding:8px}button{padding:12px;margin:10px}.questionAnswer{margin:16px 0}</style></head>
    <body><main><p>ISOLATED QA · FICTIONAL APPLICANT. Trimmed from a sanitized capture; the script below is a QA stand-in for Iowa's.</p>${html}</main>
    <script>
      window.__startQa = { nextClicks: 0, shown: [] };
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
  return { evaluate, text, visible, click,
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
  let currentAddressVariant = 'original', currentSelfVariant = 'verified', currentStartVariant = 'verified';
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
        return route.fulfill({ status: 200, contentType: 'text/html', body: fixture(url.searchParams.get('next')) });
      }
      if (request.isNavigationRequest() && request.url() === addressUrl) {
        verifiedAddressLoads++;
        return route.fulfill({ status: 200, contentType: 'text/html', body: verifiedAddressFixture(currentAddressVariant) });
      }
      if (request.isNavigationRequest() && request.url() === selfDetailsUrl) return route.fulfill({ status: 200, contentType: 'text/html', body: selfDetailsFixture(currentSelfVariant) });
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
    // and page polls it has received, whether it is busy (handling a click, running an autopilot step or a site
    // fill), and whether an autopilot waits for the applicant. A waiting autopilot looks at the page again at each poll.
    await worker.evaluate(() => {
      globalThis.__smokeProbe = { actions: 0, polls: 0 };
      chrome.runtime.onMessage.addListener(message => {
        if (message?.confirmed === true) globalThis.__smokeProbe.actions++;
        if (message?.type === 'ui:pageState') globalThis.__smokeProbe.polls++;
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
    await expect(widget.locator('#need-you')).toHaveText('1 need you', { timeout: 20000 });
    await expect(page.locator('#lastName')).toHaveValue(syntheticProfile.lastName);
    await widget.locator('#need-you').click();
    await expect.poll(() => page.evaluate(() => document.activeElement.id)).toBe('firstName');
    assert.equal(await page.evaluate(() => window.__nextClicks), 0, 'Missing required profile data cannot trigger Next.');
    const beforeManual = (await calls('getFields')).length;
    await page.locator('#firstName').fill(syntheticProfile.firstName);
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
    assert.equal((await calls('getFields')).filter(call => call.fields.length).length, beforeManual, 'Manual completion requests no additional saved profile values.');
    assert.deepEqual((await calls('getFields')).at(-1).fields, [], 'Manual completion obtains fresh no-data navigation authorization.');
    console.log('Widget: missing profile data blocks Next; field focus and manual completion allow one later Next.');

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
    await expect(widget.locator('#need-you')).toHaveText('1 need you', { timeout: 20000 });
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
    await widget.locator('#autofill').click();
    await expect.poll(() => page.url(), { timeout: 20000 }).toBe(`${portal}/applyForBenefits/letsGetStarted`);
    widget = await launcherFrame();
    await expect(widget.locator('#widget-text')).toHaveText('Read and accept Iowa’s consent, then click Continue.', { timeout: 20000 });
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
    await widget.locator('#autofill').click();
    await expect(page.locator('#householdApplyProgYes')).toBeChecked({ timeout: 20000 });
    await expect(widget.locator('#widget-text')).toHaveText('Filled 1 · Solve the CAPTCHA, then click Continue.', { timeout: 20000 });
    assert.deepEqual((await calls('getFields'))[0].fields, ['programSnap', 'programFip', 'programMedicaid']);
    assert.equal(await page.evaluate(() => window.__continues), 0);
    console.log('Autopilot: the household question is answered from saved programs and the CAPTCHA is left to the applicant.');

    // After Autofill, the widget draws the whole next step inside its frame, in every language.
    // The language is chosen as the side panel saves it, in the extension's own storage.
    const frameBox = () => page.locator('[data-secondhand-assistant]').boundingBox();
    const widgetLine = frame => frame.evaluate(() => {
      const text = document.getElementById('widget-text'), box = text.getBoundingClientRect(), card = document.getElementById('widget').getBoundingClientRect();
      const inside = rect => rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      return { text: text.textContent, shown: !text.classList.contains('visually-hidden') && box.width > 0 && box.height > 0,
        clipped: text.scrollHeight > text.clientHeight, inFrame: inside(box) && inside(card), dir: document.documentElement.dir };
    });
    const lineProblems = async (frame, expected, code) => {
      const line = await widgetLine(frame), box = await frameBox();
      return [line.text !== expected && `text "${line.text}"`, !line.shown && 'line hidden', line.clipped && 'line clipped',
        !line.inFrame && 'line past the frame', box.width > 272 && `frame ${box.width}px wide`, box.height > 110 && `frame ${box.height}px tall`,
        line.dir !== strings.direction(code) && `dir ${line.dir}`].filter(Boolean);
    };
    const wholeSteps = [
      { name: 'Job Information', url: selfDetailsUrl, pageKey: 'iowa-self-details-unverified', line: code => strings.text(code, 'iowa.selfUnverifiedTodo') },
      { name: 'unexpected Enter Personal Information', url: `${applicant}?next=unexpected`, pageKey: 'iowa-personal-unverified', line: code => strings.text(code, 'iowa.personalUnverifiedTodo') },
      // Save and Continue disabled: SecondHand fills the page and does not continue.
      { name: 'Enter Personal Information, Save and Continue disabled', url: `${applicant}?next=stay`, pageKey: 'iowa-personal-information', disabled: true,
        line: (code, filled) => `${strings.text(code, 'widget.filled', { count: filled })} · ${strings.text(code, 'iowa.reviewSaveContinue')}` }
    ];
    // Before Autofill there is no line, so the frame is 46px tall. On these English pages the
    // widget may offer the page in the applicant's language instead, and that offer gets the row.
    const beforeProblems = async (frame, code) => {
      const state = await frame.evaluate(() => ({ line: !document.getElementById('widget-text').classList.contains('visually-hidden'), offer: !document.getElementById('translate-offer').hidden }));
      const box = await frameBox();
      return [state.line && 'line shown before Autofill', code === 'en' && state.offer && 'offer on an English page',
        !state.offer && box.height !== 46 && `frame ${box.height}px tall without a line`, box.width > 272 && `frame ${box.width}px wide`, box.height > 110 && `frame ${box.height}px tall`].filter(Boolean);
    };
    const measured = [];
    currentSelfVariant = 'job';
    for (const code of strings.LANGUAGES) {
      await resetTo(wholeSteps[0].url);
      await (await launcherFrame()).evaluate(code => globalThis.SecondHandStrings.setLanguage(code), code);
      for (const step of wholeSteps) {
        await resetTo(step.url);
        widget = await launcherFrame();
        await expect(widget.locator('#autofill')).toBeVisible();
        if (step.disabled) await page.locator('.saveAndContinueButton').evaluate(button => button.setAttribute('disabled', ''));
        await expect.poll(() => beforeProblems(widget, code), { timeout: 10000, message: `${code} ${step.name} before Autofill` }).toEqual([]);
        const before = await frameBox();
        const offered = await widget.locator('#translate-offer').isVisible();
        await widget.locator('#autofill').click();
        await expect.poll(async () => (await widget.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pageState' })))?.data?.result?.state, { timeout: 20000 }).toMatch(/^(waiting|done)$/);
        const { page: probed, result } = (await widget.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pageState' }))).data;
        assert.equal(probed.pageKey, step.pageKey, `${step.name} is classified as ${step.pageKey}`);
        if (step.disabled) assert.ok(result.filled > 0, 'SecondHand fills the applicant page');
        // A disabled button fires no click, so the worker's own result says it never tried to continue
        // (it would say it is continuing, or waiting after a try).
        if (step.disabled) assert.equal(result.state, 'done', 'SecondHand does not try to continue');
        const expected = step.line(code, result.filled);
        await expect.poll(() => lineProblems(widget, expected, code), { timeout: 10000, message: `${code} ${step.name}` }).toEqual([]);
        assert.equal(await page.evaluate(() => window.__nextClicks || 0), 0, 'SecondHand does not continue');
        const after = await frameBox();
        measured.push(`${code} ${step.name}: ${before.width}x${before.height} before${offered ? ' (language offer)' : ''}, ${after.width}x${after.height} after`);
      }
    }
    for (const line of measured) console.log(`Widget frame, ${line}.`);
    console.log('Widget: after Autofill, the whole next step shows inside the frame in all six languages, and Arabic reads right to left.');

    // A narrow page (an old laptop at high zoom with the side panel open leaves about 260px): the
    // widget keeps its buttons' width and its line takes more rows, all of it inside the frame.
    const settledLine = async (code, expected) => {
      await expect.poll(async () => (await widget.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pageState' })))?.data?.result?.state, { timeout: 20000 }).toMatch(/^(waiting|done)$/);
      const { result } = (await widget.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pageState' }))).data;
      await expect.poll(() => lineProblems(widget, expected(result.filled), code), { timeout: 10000, message: `${code} at ${page.viewportSize().width}px` }).toEqual([]);
    };
    const narrow = [];
    await page.setViewportSize({ width: 260, height: 900 });
    for (const code of strings.LANGUAGES) {
      await (await launcherFrame()).evaluate(code => globalThis.SecondHandStrings.setLanguage(code), code);
      await resetTo(selfDetailsUrl);
      widget = await launcherFrame();
      await expect.poll(() => beforeProblems(widget, code), { timeout: 10000, message: `${code} at 260px before Autofill` }).toEqual([]);
      const before = await frameBox();
      await widget.locator('#autofill').click();
      await settledLine(code, () => wholeSteps[0].line(code));
      const after = await frameBox();
      assert.ok(after.width <= before.width, `${code} at 260px: the line makes the widget no wider`);
      narrow.push(`${code} Job Information at 260px: ${before.width}x${before.height} before, ${after.width}x${after.height} after`);
    }
    currentSelfVariant = 'verified';

    // Save and Continue stays as clear of the widget as main left it, on Enter Personal Information
    // scrolled to the bottom. At 390px main's widget already covers its right edge. Under 640px the
    // widget's width doesn't depend on the page's, so 390px also shows each language's line fits.
    const clearOf = { 390: ['left', 'center'], 427: ['left', 'center', 'right'], 455: ['left', 'center', 'right'], 512: ['left', 'center', 'right'], 640: ['left', 'center', 'right'] };
    for (const code of strings.LANGUAGES) {
      await (await launcherFrame()).evaluate(code => globalThis.SecondHandStrings.setLanguage(code), code);
      for (const [width, points] of Object.entries(clearOf).filter(([width]) => ['en', 'es'].includes(code) || width === '390')) {
        await page.setViewportSize({ width: Number(width), height: 700 });
        await resetTo(`${applicant}?next=stay`);
        widget = await launcherFrame();
        await expect(widget.locator('#autofill')).toBeVisible();
        await page.locator('.saveAndContinueButton').evaluate(button => button.setAttribute('disabled', ''));
        await expect.poll(() => beforeProblems(widget, code), { timeout: 10000, message: `${code} at ${width}px before Autofill` }).toEqual([]);
        const before = await frameBox();
        await widget.locator('#autofill').click();
        await settledLine(code, filled => wholeSteps[2].line(code, filled));
        const after = await frameBox();
        if (Number(width) < 640) assert.ok(after.width <= before.width, `${code} at ${width}px: the line makes the widget no wider`);
        await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
        const clear = await page.evaluate(() => {
          const button = document.querySelector('.saveAndContinueButton'), box = button.getBoundingClientRect(), y = box.top + box.height / 2;
          return [['left', box.left + 2], ['center', box.left + box.width / 2], ['right', box.right - 2]]
            .filter(([, x]) => button.contains(document.elementFromPoint(x, y))).map(([point]) => point);
        });
        for (const point of points) assert.ok(clear.includes(point), `${code} at ${width}px: Save and Continue's ${point} is clear of the widget (clear: ${clear.join(', ') || 'none'})`);
        narrow.push(`${code} Save and Continue disabled at ${width}px: ${before.width}x${before.height} before, ${after.width}x${after.height} after; button clear at ${clear.join(', ') || 'no point'}`);
      }
    }
    await page.setViewportSize({ width: 1200, height: 900 });
    await widget.evaluate(key => localStorage.removeItem(key), strings.STORAGE_KEY);
    for (const line of narrow) console.log(`Widget frame, ${line}.`);
    console.log('Widget: on narrow pages it stays inside its frame, keeps its buttons\' width, and leaves Save and Continue as clear as before.');

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
    await expect.poll(() => panel.text('#desktop-status')).toContain('unlocked');
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

    // With SecondHand closed, Autofill fills nothing and the one desktop line and its Open SecondHand
    // button say so, not a red repeat under Autofill. Opening it waits for the app, then offers Unlock.
    await resetTo(`${applicant}?next=stay`);
    await worker.evaluate(() => { globalThis.__nativeSmoke.closed = true; });
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
    await panel.click('#panel-autofill');
    await expect.poll(() => panel.text('#desktop-status'), { timeout: 15000 }).toBe('SecondHand isn’t running. Open the app on this computer.');
    await expect.poll(() => panel.text('#desktop-action')).toBe('Open SecondHand');
    assert.equal(await panel.visible('#desktop-action'), true);
    await expect.poll(() => panel.text('#status')).toBe('Click Autofill. SecondHand fills what it can and tells you what it needs.');
    assert.equal(await panel.evaluate(() => document.getElementById('status').classList.contains('error')), false);
    await expect(page.locator('#firstName')).toHaveValue('');
    await expect((await launcherFrame()).locator('#open-app')).toBeVisible({ timeout: 15000 });
    await panel.click('#desktop-action');
    await expect.poll(() => panel.text('#desktop-status'), { timeout: 10000 }).toBe('SecondHand is locked.');
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
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
      await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
      await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
    await expect.poll(() => panel.text('[data-key="addressReview"]')).toContain('Needs you');
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
      await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
    const startFields = ['sex', 'birthDate', 'hasSsn', 'ssn', 'ssnCardNameMatches', 'ssnCardFirstName', 'ssnCardMiddleName', 'ssnCardLastName', 'usCitizen', 'householdAllCitizens', 'maritalStatus',
      'militaryOrVeteran', 'disabled', 'householdDisability', 'blind', 'healthLimitation', 'medicare', 'householdMedicare'];
    const startRows = ['gender', 'birthDate', 'hasSsn', 'ssnCardName', 'usCitizen', 'maritalStatus', 'militaryOrVeteran', 'hasDisability', 'blind', 'healthLimits', 'hasMedicare'];
    const startChecked = () => page.evaluate(() => Array.from(document.querySelectorAll('#answerSet input[type="radio"]')).filter(element => element.checked).map(element => element.id));
    const startBoxes = () => page.evaluate(ids => ids.map(id => document.getElementById(id).value),
      [tellUsMore.SSN_BOX_ID, 'answerSets0.answers12.answerValue', 'answerSets0.answers15.answerValue', 'answerSets0.answers16.answerValue']);
    await resetTo(startDetailsUrl, { profile: { hasSsn: 'yes' } });
    const answered = [['gender', 2], ['hasSsn', 1], ['ssnCardName', 1], ['usCitizen', 1], ['militaryOrVeteran', 2], ['hasDisability', 2], ['blind', 2], ['healthLimits', 2], ['hasMedicare', 2]]
      .map(([key, option]) => tellUsMore.radioId(tellUsMore.ANSWERS[key], option));
    await expect.poll(() => panel.text('[data-key="gender"]')).toContain('Are you male or female?');
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
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
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
    await panel.click('#panel-autofill');
    await expect.poll(startBoxes, { timeout: 20000 }).toEqual(['321-54-9876', 'Existing card name', 'Quinn', 'Sample']);
    await expect(ssnMirror()).toHaveValue('');
    assert.equal(await page.evaluate(() => window.__startQa.nextClicks), 0);
    console.log('Tell Us More conditional controls: existing SSN and card first name are preserved.');

    currentStartVariant = 'people';
    await resetTo(startDetailsUrl, { profile: sensitiveProfile });
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
    await autofillSettled();
    assert.deepEqual(await calls('getFields'), []);
    assert.deepEqual(await startBoxes(), ['', '', '', '']);
    assert.deepEqual(await startChecked(), []);
    assert.equal(await page.evaluate(() => window.__startQa.nextClicks), 0);
    currentStartVariant = 'verified';
    console.log('Tell Us More conditional controls: another-person phase releases no profile fields and fills nothing.');

    // With nothing saved, nothing is filled and each row points to My information.
    await resetTo(startDetailsUrl, { profile: Object.fromEntries(startFields.map(field => [field, ''])) });
    await expect.poll(() => panel.text('#panel-autofill')).toBe('Autofill this page');
    await panel.click('#panel-autofill');
    for (const key of startRows.filter(key => key !== 'ssnCardName')) {
      await expect.poll(() => panel.text(`[data-key="${key}"]`), { timeout: 20000 }).toContain('Not saved in SecondHand: add it in My information');
    }
    await settled();
    assert.deepEqual(await startChecked(), []);
    await expect(page.locator(`[id="${tellUsMore.DOB_ID}"]`)).toHaveValue('');
    await expect(page.locator(`[id="${tellUsMore.MARITAL_ID}"]`)).toHaveValue('');
    assert.deepEqual(await startBoxes(), ['', '', '', '']);
    assert.deepEqual(await page.evaluate(() => window.__startQa), { nextClicks: 0, shown: [] });
    assert.deepEqual((await calls('getFields')).map(call => call.fields), [startFields]);
    console.log('Tell Us More (dynamicQuestionsStart), nothing saved: nothing filled; every row says it is not saved and points to My information.');

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
