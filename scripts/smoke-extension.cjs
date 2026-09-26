'use strict';

// Real Chromium / MV3 / native side-panel smoke. Playwright fulfills all Iowa
// documents locally; DNS is disabled. Native requests alone are replaced inside
// the isolated worker's DevTools context. No production test hooks or real data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const syntheticProfile = require('../tests/fixtures/applicant-profile.json');
const applicantFixture = require('../tests/fixtures/iowa-personal-information.cjs');
const addressFixture = require('../tests/fixtures/iowa-select-address.cjs');
const selfFixture = require('../tests/fixtures/iowa-self-details.cjs');
const root = path.join(__dirname, '..');
const portal = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
const applicant = `${portal}/applyForBenefits/enterPersonalInfo`;
const extensionDirectory = path.join(root, 'extension');
const documentManualUrl = `${portal}/qa-only/document-manual`;
const documentNextMarker = 'SECONDHAND_SYNTHETIC_FULL_DOCUMENT_NEXT';
const addressUrl = addressFixture.URL;
const selfDetailsUrl = selfFixture.URL;
const verifiedApplicantMarker = 'SECONDHAND_VERIFIED_ADDRESS_APPLICANT_NEXT';
const verifiedAddressMarker = 'SECONDHAND_VERIFIED_ADDRESS_NEXT:';
const addressVariants = {
  original: { selected: 'original' },
  second: { selected: 'second', candidateCount: 2 },
  error: { selected: 'original', error: true },
  modal: { selected: 'original', modal: true },
  mailing: { selected: 'original', mailing: true },
  county: { selected: 'original', renderedCounty: true }
};

function verifiedAddressFixture(variant) {
  const options = addressVariants[variant];
  if (!options) throw new Error('Unknown isolated address QA variant.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Verified address structure · isolated QA</title>
    <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:30px}main{max-width:900px}label{display:block;margin:12px 0}button{padding:12px 18px;margin:12px}table{border-collapse:collapse}td,th{padding:10px;text-align:left}</style></head>
    <body><main><p data-verified-address-qa>ISOLATED QA · FICTIONAL APPLICANT · PUBLIC CAMPUS ADDRESS. No government connection.</p>${addressFixture.makeHtml(options)}</main>
    <script>(${addressFixture.attachHandlers.toString()})(document);
      document.querySelector(${JSON.stringify(addressFixture.NEXT_SELECTOR)}).addEventListener('click', () => {
        console.info(${JSON.stringify(verifiedAddressMarker)} + JSON.stringify(document.__addressQa));
        location.assign(${JSON.stringify(documentManualUrl)});
      });
    </script></body></html>`;
}

function selfDetailsFixture(variant = 'verified') {
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

function fixture(nextStep) {
  if (nextStep === 'document-manual-destination') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic manual step · test only</title></head>
      <body><main><p data-qa-document>SYNTHETIC FULL-DOCUMENT QA FIXTURE. No government connection or real applicant data.</p>
      <h1>Household Members</h1><label>Fictional household member<input id="qa-household-member" name="qaHouseholdMember"></label>
      <button id="qa-manual-continue" type="button">Continue (QA only)</button></main>
      <script>window.__manualNextClicks=0;document.getElementById('qa-manual-continue').addEventListener('click',()=>{window.__manualNextClicks++;});</script></body></html>`;
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

async function installNativeStub(worker) {
  await worker.evaluate(({ profile, addressUrl }) => {
    globalThis.__nativeSmoke = { locked: false, lockAfterFill: false, calls: [], profile };
    nativeRequest = async (type, payload = {}) => {
      const state = globalThis.__nativeSmoke;
      state.calls.push({ type, fields: payload.fields || [], session: Boolean(payload.assistanceToken), url: payload.url || '' });
      if (type === 'status') return { unlocked: !state.locked, applicationCount: 0 };
      if (type === 'startAssistedSession') {
        if (state.locked) throw new Error('Unlock the synthetic desktop vault first.');
        return { assistanceToken: 'a'.repeat(64), fields: payload.fields, expiresAt: new Date(Date.now() + 900000).toISOString() };
      }
      if (type === 'checkAssistedSession') {
        if (payload.url === addressUrl && state.holdAddressNavigation) {
          state.addressChecks = (state.addressChecks || 0) + 1;
          await new Promise(resolve => { state.releaseAddressNavigation = resolve; });
        }
        return { active: !state.locked };
      }
      if (type === 'endAssistedSession') return { ended: true };
      if (type === 'getFields') {
        if (state.locked) throw new Error('Unlock the synthetic desktop vault first.');
        return { values: Object.fromEntries(payload.fields.filter(field => Object.hasOwn(state.profile, field)).map(field => [field, state.profile[field]])) };
      }
      if (type === 'recordProgress') { if (state.lockAfterFill) state.locked = true; return { recorded: true }; }
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native panel CDP timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    transport.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
      clearTimeout(timer); pending.delete(id); reject(error);
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
    async screenshot(file) { const result = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(file, Buffer.from(result.data, 'base64')); },
    async close() { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Panel test closed.')); } pending.clear(); await transport.detach().catch(() => {}); }
  };
}

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-chromium-smoke-'));
  let context, panel, page, worker;
  const errors = [];
  let documentNextClicks = 0, documentManualLoads = 0;
  let verifiedApplicantClicks = 0, verifiedAddressLoads = 0;
  let currentAddressVariant = 'original';
  let currentSelfVariant = 'verified';
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
      if (request.isNavigationRequest() && request.url() === documentManualUrl) {
        documentManualLoads++;
        return route.fulfill({ status: 200, contentType: 'text/html', body: fixture('document-manual-destination') });
      }
      if (request.isNavigationRequest() && `${url.origin}${url.pathname}` === addressUrl) {
        verifiedAddressLoads++;
        return route.fulfill({ status: 200, contentType: 'text/html', body: verifiedAddressFixture(currentAddressVariant) });
      }
      if (request.isNavigationRequest() && request.url() === selfDetailsUrl) {
        return route.fulfill({ status: 200, contentType: 'text/html', body: selfDetailsFixture(currentSelfVariant) });
      }
      if (url.protocol === 'chrome-extension:') return route.continue();
      return route.abort('blockedbyclient');
    });
    [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).hostname;
    assert.equal(extensionId, 'jogldddafjfbmfjnjlbjloakjbecnjpl');
    await installNativeStub(worker);
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'info') return;
      if (message.text() === documentNextMarker) documentNextClicks++;
      if (message.text() === verifiedApplicantMarker) verifiedApplicantClicks++;
      if (message.text().startsWith(verifiedAddressMarker)) verifiedAddressNext.push(JSON.parse(message.text().slice(verifiedAddressMarker.length)));
    });
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });

    async function startFixture({ next = 'manual', profile = {}, lockAfterFill = false } = {}) {
      if (panel && await panel.visible('#pause-auto')) await panel.click('#pause-auto');
      if (next.startsWith('verified-address-')) currentAddressVariant = next.slice('verified-address-'.length);
      await worker.evaluate(({ profile, lockAfterFill }) => {
        globalThis.__nativeSmoke = { locked: false, lockAfterFill, calls: [], profile };
      }, { profile: { ...syntheticProfile, ...profile }, lockAfterFill });
      await page.goto(`${applicant}?next=${next}`, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      await expect(page.locator('[data-secondhand-assistant]')).toHaveCount(1);
      await expect.poll(() => page.frames().some(frame => frame.url() === `chrome-extension://${extensionId}/panel.html?surface=launcher`), { timeout: 15000 }).toBe(true);
      const launcher = page.frames().find(frame => frame.url() === `chrome-extension://${extensionId}/panel.html?surface=launcher`);
      if (!panel) {
        await launcher.locator('#open-side-panel').click();
        await expect(launcher.locator('#launcher-status')).toHaveText('Assistant opened in Chrome’s sidebar.');
        panel = await attachNativePanel(context, page, extensionId);
      }
      await expect.poll(() => panel.text('#page-checklist'), { timeout: 15000 }).toContain('First name');
      await expect.poll(() => panel.evaluate(() => document.querySelector('#start-auto').disabled)).toBe(false);
      await expect(page.locator('#firstName')).toHaveValue('');
      assert.equal(await page.locator('[data-secondhand-assistant]').evaluate(element => element.getBoundingClientRect().height), 62);
      return launcher;
    }
    const nextOnce = async () => {
      await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
      await expect.poll(() => panel.text('#guided-state'), { timeout: 15000 }).toBe('PAUSED FOR YOUR REVIEW');
      await page.waitForTimeout(1800);
      assert.equal(await page.evaluate(() => window.__nextClicks), 1);
    };
    const stop = async () => { await panel.click('#pause-auto'); await expect.poll(() => panel.visible('#pause-auto')).toBe(false); };

    await startFixture({ profile: { firstName: '' } });
    await page.evaluate(() => window.postMessage({ type: 'ui:auto', enabled: true, confirmed: true }, '*'));
    await page.waitForTimeout(150);
    assert.deepEqual(await worker.evaluate(() => globalThis.__nativeSmoke.calls), []);
    await panel.click('#start-auto');
    await expect.poll(() => panel.text('#guided-state'), { timeout: 20000 }).toBe('WAITING FOR MISSING INFORMATION');
    await expect(page.locator('#lastName')).toHaveValue(syntheticProfile.lastName);
    await expect(page.locator('#addressLine1')).toHaveValue(syntheticProfile.addressLine1);
    await expect(page.locator('#mailingAddressLine1')).toHaveValue(syntheticProfile.mailingAddressLine1);
    await expect.poll(() => panel.text('[data-key="lastName"]')).toContain('Complete');
    await expect.poll(() => panel.text('[data-key="firstName"]')).toContain('Missing from saved profile');
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    const sidebarText = await panel.evaluate(() => document.body.innerText);
    const sidebarMessage = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id }));
    });
    for (const value of [syntheticProfile.firstName, syntheticProfile.middleName, syntheticProfile.lastName, syntheticProfile.addressLine1, syntheticProfile.homePhone, syntheticProfile.mailingAddressLine1]) {
      assert.equal(sidebarText.includes(value), false, `Sidebar must never render a profile value: ${value}`);
      assert.equal(sidebarMessage.includes(value), false, `Sidebar messages must never receive a profile value: ${value}`);
    }
    assert.equal(sidebarMessage.includes('assistanceToken'), false);
    assert.equal(sidebarMessage.includes('a'.repeat(64)), false);
    await panel.click('[data-key="firstName"]');
    await expect.poll(() => page.evaluate(() => document.activeElement.id)).toBe('firstName');
    await panel.screenshot(path.join(root, 'artifacts/extension-native-sidebar.png'));
    await page.screenshot({ path: path.join(root, 'artifacts/extension-assistant.png') });
    await page.waitForTimeout(1900);
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    assert.equal((await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'getFields' && call.fields.includes('firstName')).length, 1, 'Missing saved facts are not repeatedly requested while waiting.');
    await page.locator('#firstName').fill(syntheticProfile.firstName);
    await nextOnce();
    const fullAnswers = await page.evaluate(() => window.__lastAnswers);
    assert.equal(fullAnswers.firstName, syntheticProfile.firstName);
    assert.equal(fullAnswers.suffix, 'III'); assert.equal(fullAnswers.sameAddress2, true);
    assert.equal(fullAnswers.mailingCity, syntheticProfile.mailingCity); assert.equal(fullAnswers.snap, true);
    assert.equal(fullAnswers.bestTime, syntheticProfile.bestContactTime);
    await stop();
    console.log('Native Chrome sidebar: complete applicant autofill, checklist metadata, missing-profile focus, wait, and manual completion → exactly one Next passed.');

    const branches = [
      { name: 'home address with same mailing; optional blanks', profile: { mailingSameAsHome: 'yes', middleName: '', suffix: '', maidenName: '', addressLine2: '', bestContactTime: '' }, check: answers => { assert.equal(answers.sameAddress1, true); assert.equal(answers.mailingAddressLine1, ''); } },
      { name: 'no home address; separate mailing', profile: { hasHomeAddress: 'no' }, check: answers => { assert.equal(answers.hasHome2, true); assert.equal(answers.addressLine1, ''); assert.equal(answers.mailingAddressLine1, syntheticProfile.mailingAddressLine1); } },
      { name: 'Medicaid + FIP + medical-bill choice', profile: { programSnap: 'no', programMedicaid: 'yes', programFip: 'yes', helpPayMedicalBills: 'yes' }, check: answers => { assert.equal(answers.medicaid, true); assert.equal(answers.tanf, true); assert.equal(answers.helpPayMedBill1, true); assert.equal(answers.snap, false); } },
      { name: 'not applying personally hides program questions', profile: { isApplicant: 'no' }, check: answers => { assert.equal(answers.applicant2, true); assert.equal(answers.snap, false); } }
    ];
    for (const branch of branches) {
      await startFixture({ profile: branch.profile });
      await panel.click('#start-auto'); await nextOnce();
      branch.check(await page.evaluate(() => window.__lastAnswers)); await stop();
      console.log(`Native sidebar conditional branch passed: ${branch.name}.`);
    }

    await startFixture({ profile: { programSnap: 'no', programFip: 'no', programMedicaid: 'no' } });
    await panel.click('#start-auto');
    await expect.poll(() => panel.text('#guided-state'), { timeout: 20000 }).toBe('WAITING FOR MISSING INFORMATION');
    await expect.poll(() => panel.text('[data-key="programs"]')).toContain('Missing required');
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    await panel.click('[data-key="programs"]');
    await page.locator('#snap').check();
    await nextOnce(); await stop();
    console.log('Native sidebar: unanswered required program choice blocks Next, then manual selection resumes safely.');

    await startFixture({ profile: { isApplicant: '' } });
    await panel.click('#start-auto');
    await expect.poll(() => panel.text('#guided-state'), { timeout: 20000 }).toBe('WAITING FOR MISSING INFORMATION');
    await expect.poll(() => panel.text('[data-key="isApplicant"]')).toContain('Missing from saved profile');
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    await page.locator('#applicant1').check();
    await nextOnce();
    assert.equal((await page.evaluate(() => window.__lastAnswers)).snap, true);
    await stop();
    console.log('Native sidebar: completing an unanswered question reveals a new branch and safely continues approved autofill.');

    await startFixture({ profile: { mailingSameAsHome: 'yes' } });
    const preservedHome = '456 Preserved Example Lane';
    const preservedMailing = 'PO Box 999';
    await page.locator('#hasHome1').check();
    await page.locator('#addressLine1').fill(preservedHome);
    await page.locator('#sameAddress2').check();
    await page.locator('#mailingAddressLine1').fill(preservedMailing);
    // Re-clicking this already-selected parent exercises its real fixture
    // handler: the same-address question resets and mailing is hidden, but the
    // existing mailing answer stays. Saved Yes must not erase that answer.
    await page.locator('#hasHome1').click();
    await expect(page.locator('#sameAddress1')).not.toBeChecked();
    await expect(page.locator('#sameAddress2')).not.toBeChecked();
    await panel.click('#start-auto');
    await expect.poll(() => panel.text('#guided-state'), { timeout: 20000 }).toBe('WAITING FOR MISSING INFORMATION');
    await expect.poll(() => panel.text('[data-key="mailingSameAsHome"]')).toContain('review existing dependent answers');
    await expect.poll(() => panel.text('[data-key="mailingSameAsHome"]')).toContain('Needs manual review');
    await expect.poll(() => panel.text('[data-key="addressLine1"]')).toContain('Complete');
    await expect(page.locator('#addressLine1')).toHaveValue(preservedHome);
    await expect(page.locator('#mailingAddressLine1')).toHaveValue(preservedMailing);
    await expect(page.locator('#sameAddress1')).not.toBeChecked();
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    await page.waitForTimeout(1900);
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    await page.locator('#sameAddress2').check();
    await nextOnce();
    const preservedAnswers = await page.evaluate(() => window.__lastAnswers);
    assert.equal(preservedAnswers.addressLine1, preservedHome);
    assert.equal(preservedAnswers.mailingAddressLine1, preservedMailing);
    assert.equal(preservedAnswers.sameAddress2, true);
    await stop();
    console.log('Native sidebar: prefilled home/mailing addresses survive autofill; a destructive parent answer pauses until manually resolved.');

    await startFixture({ next: 'document-manual' });
    documentNextClicks = 0; documentManualLoads = 0;
    await panel.click('#start-auto');
    await expect(page).toHaveURL(documentManualUrl, { timeout: 20000 });
    await expect(page.locator('[data-qa-document]')).toContainText('SYNTHETIC FULL-DOCUMENT QA FIXTURE');
    await expect(page.locator('[data-secondhand-assistant]')).toHaveCount(1);
    await expect.poll(() => page.frames().some(frame => frame.url() === `chrome-extension://${extensionId}/panel.html?surface=launcher`), { timeout: 15000 }).toBe(true);
    assert.equal(await page.evaluate(() => typeof window.__lastAnswers), 'undefined', 'The original document and its answer snapshot were unloaded.');
    await expect.poll(() => panel.text('#guided-state'), { timeout: 15000 }).toBe('PAUSED FOR YOUR REVIEW');
    await expect.poll(() => panel.text('#manual-reason')).toContain('not verified');
    assert.equal(await panel.evaluate(() => document.querySelector('#start-auto').disabled), true);
    assert.equal(await panel.evaluate(() => document.querySelector('#fill-next').disabled), true);
    const fullNavigationRequests = (await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'getFields').length;
    assert.ok(fullNavigationRequests > 0);
    await page.waitForTimeout(3400);
    assert.equal(documentNextClicks, 1, 'Exactly one applicant Next click occurred before unloading.');
    assert.equal(documentManualLoads, 1, 'The next document was requested exactly once.');
    assert.equal(await page.evaluate(() => window.__manualNextClicks), 0);
    await expect(page.locator('#qa-household-member')).toHaveValue('');
    assert.equal((await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'getFields').length, fullNavigationRequests);
    await stop();
    console.log('Native sidebar: full-document navigation unloads the applicant, reinjects once, and pauses without a second Next or further profile request.');

    for (const variant of ['original', 'second']) {
      await startFixture({ next: `verified-address-${variant}`, profile: { mailingSameAsHome: 'yes' } });
      verifiedApplicantClicks = 0; verifiedAddressLoads = 0; verifiedAddressNext.length = 0; documentManualLoads = 0;
      // Hold only the synthetic desktop validity response, so the genuine
      // sidebar can render the address checklist before the approved Next.
      await worker.evaluate(() => { globalThis.__nativeSmoke.holdAddressNavigation = true; });
      await panel.click('#start-auto');
      await expect(page).toHaveURL(addressUrl, { timeout: 20000 });
      await expect.poll(() => worker.evaluate(() => globalThis.__nativeSmoke.addressChecks || 0), { timeout: 15000 }).toBe(1);
      await expect.poll(() => panel.text('[data-key="addressReview"]'), { timeout: 15000 }).toContain('First suggested home address');
      await expect(page.locator('#homeAddressIndex0')).not.toBeChecked();
      await expect(page.locator('#homeAddressIndex1')).toBeChecked();
      assert.deepEqual(await page.evaluate(() => document.__addressQa), { selectionClicks: [], selectedIndexes: [], nextClicks: 0 });
      const addressSidebar = await panel.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const state = await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id });
        return { text: document.body.innerText, message: JSON.stringify(state) };
      });
      assert.ok(addressSidebar.message.includes('iowa-select-address'));
      for (const value of ['411 Morrill', '411 MORRILL', '415 MORRILL', 'Ames', 'AMES', '50011', 'qaAddressLine', 'assistanceToken', 'a'.repeat(64)]) {
        assert.equal(addressSidebar.text.includes(value), false, `Address text must stay out of the sidebar: ${value}`);
        assert.equal(addressSidebar.message.includes(value), false, `Address text must stay out of extension UI messages: ${value}`);
      }
      const requestsBeforeAddress = (await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'getFields').length;
      assert.ok(requestsBeforeAddress > 0);
      await worker.evaluate(() => {
        const state = globalThis.__nativeSmoke;
        state.holdAddressNavigation = false;
        state.releaseAddressNavigation();
        delete state.releaseAddressNavigation;
      });
      await expect(page).toHaveURL(documentManualUrl, { timeout: 20000 });
      await expect.poll(() => panel.text('#guided-state'), { timeout: 15000 }).toBe('PAUSED FOR YOUR REVIEW');
      await page.waitForTimeout(1900);
      assert.equal(verifiedApplicantClicks, 1);
      assert.equal(verifiedAddressLoads, 1);
      assert.equal(documentManualLoads, 1);
      assert.deepEqual(verifiedAddressNext, [{ selectionClicks: ['0'], selectedIndexes: [['0']], nextClicks: 1 }], 'First possible home address replaces the previous selection before one address Next.');
      assert.equal(await page.evaluate(() => window.__manualNextClicks), 0);
      const callsAfterAddress = await worker.evaluate(() => globalThis.__nativeSmoke.calls);
      assert.equal(callsAfterAddress.filter(call => call.type === 'getFields').length, requestsBeforeAddress, 'The address step must never request profile values.');
      assert.equal(callsAfterAddress.filter(call => call.type === 'getFields' && call.url === addressUrl).length, 0);
      await stop();
      console.log(`Native sidebar: verified home-address selection replaces ${variant}, chooses first possible match, and advances each document exactly once without profile requests.`);
    }

    for (const variant of ['error', 'modal', 'mailing', 'county']) {
      await startFixture({ next: `verified-address-${variant}`, profile: { mailingSameAsHome: 'yes' } });
      verifiedApplicantClicks = 0; verifiedAddressLoads = 0; verifiedAddressNext.length = 0;
      await panel.click('#start-auto');
      await expect(page).toHaveURL(addressUrl, { timeout: 20000 });
      await expect.poll(() => panel.text('#guided-state'), { timeout: 15000 }).toBe('PAUSED FOR YOUR REVIEW');
      const requestsAtAddress = (await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'getFields').length;
      await page.waitForTimeout(1900);
      await expect(page.locator('#homeAddressIndex0')).not.toBeChecked();
      await expect(page.locator('#homeAddressIndex1')).toBeChecked();
      assert.deepEqual(await page.evaluate(() => document.__addressQa), { selectionClicks: [], selectedIndexes: [], nextClicks: 0 });
      assert.equal(verifiedApplicantClicks, 1);
      assert.equal(verifiedAddressLoads, 1);
      assert.deepEqual(verifiedAddressNext, []);
      const calls = await worker.evaluate(() => globalThis.__nativeSmoke.calls);
      assert.equal(calls.filter(call => call.type === 'getFields').length, requestsAtAddress);
      assert.equal(calls.filter(call => call.type === 'getFields' && call.url === addressUrl).length, 0);
      await stop();
      console.log(`Native sidebar: address ${variant} variant stays manual with unchanged selection, no Next, and no profile request.`);
    }

    await startFixture({ next: 'address-review' });
    await panel.click('#start-auto'); await nextOnce();
    await expect(page.locator('[data-qa-only]')).toContainText('HYPOTHETICAL QA CONTROLS');
    await expect.poll(() => panel.text('[data-key="addressReview"]')).toContain('Needs manual review');
    await expect.poll(() => panel.text('#manual-reason')).toContain('could not be verified');
    assert.equal(await panel.evaluate(() => document.querySelector('#start-auto').disabled), true);
    assert.equal(await panel.evaluate(() => document.querySelector('#fill-next').disabled), true);
    const addressProfileRequests = (await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'getFields').length;
    assert.ok(addressProfileRequests > 0, 'The known applicant page must have used the approved fictional profile first.');
    // Let the actual sidebar poll the address heading multiple times. These
    // hypothetical radios and Continue button must remain untouched throughout.
    await page.waitForTimeout(3400);
    await expect(page.locator('#qa-original-address')).not.toBeChecked();
    await expect(page.locator('#qa-suggested-address')).not.toBeChecked();
    assert.deepEqual(await page.evaluate(() => ({ applicantNext: window.__nextClicks, addressNext: window.__addressNextClicks, addressChanges: window.__addressChoiceEvents })), { applicantNext: 1, addressNext: 0, addressChanges: 0 });
    assert.equal((await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'getFields').length, addressProfileRequests);
    await expect.poll(() => panel.text('#guided-state')).toBe('PAUSED FOR YOUR REVIEW');
    await panel.screenshot(path.join(root, 'artifacts/extension-address-pause.png'));
    await stop();
    console.log('Native sidebar: hypothetical Select Address remains manual, with no address choice, second Next, or further native profile request.');

    await startFixture({ next: 'consent' });
    await panel.click('#start-auto'); await nextOnce();
    await expect(page.locator('#termChkbox')).not.toBeChecked();
    await expect.poll(() => panel.visible('#manual-note')).toBe(true); await stop();
    console.log('Native sidebar: consent and unsupported next pages stay manual.');

    // Exercise the separate, per-page confirmation path with all relevant
    // conditional groups revealed by real user clicks before requesting fields.
    await startFixture();
    await page.locator('#hasHome1').check(); await page.locator('#sameAddress2').check();
    await page.locator('#applicant1').check(); await page.locator('#snap').check();
    await panel.click('#refresh');
    await expect.poll(() => panel.text('#fields'), { timeout: 15000 }).toContain('Mailing street address');
    await panel.click('#confirm'); await panel.click('#fill-next');
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
    await page.waitForTimeout(1800);
    assert.equal(await page.evaluate(() => window.__nextClicks), 1);
    assert.equal((await page.evaluate(() => window.__lastAnswers)).firstName, syntheticProfile.firstName);
    assert.equal((await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'startAssistedSession').length, 0);
    console.log('Native sidebar: trusted, explicitly confirmed Fill & Next works independently of guided mode.');

    await startFixture({ lockAfterFill: true });
    await panel.click('#start-auto');
    await expect.poll(() => panel.text('#guided-state'), { timeout: 20000 }).toBe('PAUSED FOR YOUR REVIEW');
    await expect.poll(() => panel.text('#automatic-reason')).toMatch(/approval|Unlock|unlock/);
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    await worker.evaluate(() => { globalThis.__nativeSmoke.locked = false; globalThis.__nativeSmoke.lockAfterFill = false; });
    await page.waitForTimeout(1800);
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    await panel.click('#start-auto'); await nextOnce();
    assert.equal((await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'startAssistedSession').length, 2);
    await stop();

    async function startSelfDetails(variant) {
      currentSelfVariant = variant;
      await worker.evaluate(profile => { globalThis.__nativeSmoke = { locked: false, lockAfterFill: false, calls: [], profile }; }, syntheticProfile);
      await page.goto(selfDetailsUrl, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      await expect(page.locator('[data-secondhand-assistant]')).toHaveCount(1);
      await panel.click('#refresh');
      await expect(page.locator(`[id="${selfFixture.DOB_ID}"]`)).toHaveValue('');
    }
    const selfControls = () => page.evaluate(dobId => Array.from(document.querySelectorAll('input')).filter(element => element.id !== dobId)
      .map(element => ({ id: element.id, name: element.name, value: element.value, checked: element.checked })), selfFixture.DOB_ID);
    const sidebarState = () => panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id });
      if (!result.ok) throw new Error(result.error);
      return { text: document.body.innerText, state: result.data };
    });

    // Direct navigation is intentional: summary/review navigation remains a
    // manual action, and only this exact self-information context is mapped.
    await startSelfDetails('verified');
    const untouchedSelfControls = await selfControls();
    await expect.poll(() => panel.text('[data-key="birthDate"]'), { timeout: 15000 }).toContain('Date of birth');
    await expect.poll(() => panel.evaluate(() => document.querySelector('#start-auto').disabled)).toBe(false);
    await panel.click('#start-auto');
    await expect(page.locator(`[id="${selfFixture.DOB_ID}"]`)).toHaveValue('04/12/1985');
    await expect.poll(() => panel.text('#guided-state'), { timeout: 15000 }).toBe('CONTINUE IN IOWA’S FORM');
    assert.doesNotMatch(await panel.text('#automatic-reason'), /missing required answers|check again automatically/);
    await expect.poll(() => panel.text('[data-key="birthDate"]')).toContain('Complete');
    for (const key of ['self-question01', 'self-question02420', 'self-question06179']) {
      await expect.poll(() => panel.text(`[data-key="${key}"]`)).toContain('Needs manual review');
    }
    await page.waitForTimeout(1900);
    assert.deepEqual(await selfControls(), untouchedSelfControls, 'Manual gender/citizenship/SSN guards and hidden alternate DOB controls stay untouched.');
    assert.deepEqual(await page.evaluate(() => window.__selfQa), { nextClicks: 0, manualChanges: 0 });
    const selfSidebar = await sidebarState();
    assert.equal(selfSidebar.state.page.pageKey, 'iowa-self-details');
    assert.equal(selfSidebar.state.page.canAdvance, false);
    const selfMessages = JSON.stringify(selfSidebar.state);
    for (const value of ['Avery', 'Jordan', 'Example', '1985-04-12', '04/12/1985', 'assistanceToken', 'a'.repeat(64)]) {
      assert.equal(selfSidebar.text.includes(value), false, `Self-information sidebar must not render private values: ${value}`);
      assert.equal(selfMessages.includes(value), false, `Self-information metadata must not contain private values: ${value}`);
    }
    const selfCalls = await worker.evaluate(() => globalThis.__nativeSmoke.calls);
    assert.deepEqual(selfCalls.filter(call => call.type === 'getFields').map(call => ({ url: call.url, fields: call.fields })), [{ url: selfDetailsUrl, fields: ['birthDate'] }]);
    assert.equal(selfCalls.filter(call => call.type === 'startAssistedSession').length, 1);
    await panel.screenshot(path.join(root, 'artifacts/extension-self-details-sidebar.png'));
    await stop();
    console.log('Native sidebar: verified self-only DOB formats ISO as MM/DD/YYYY; manual gender/citizenship/SSN guards, hidden alternatives, and Next remain untouched, with static private-value-free metadata.');

    for (const variant of ['people', 'form', 'heading']) {
      await startSelfDetails(variant);
      await expect.poll(async () => (await sidebarState()).state.scan.recognizedPage, { timeout: 15000 }).toBe(false);
      await expect.poll(() => panel.evaluate(() => document.querySelector('#start-auto').disabled)).toBe(true);
      const originalControls = await selfControls();
      await page.waitForTimeout(1600);
      const state = (await sidebarState()).state;
      assert.notEqual(state.page.kind, 'fillable');
      assert.equal(state.page.canAdvance, false);
      assert.deepEqual(state.scan.fields, []);
      await expect(page.locator(`[id="${selfFixture.DOB_ID}"]`)).toHaveValue('');
      assert.deepEqual(await selfControls(), originalControls);
      assert.deepEqual(await page.evaluate(() => window.__selfQa), { nextClicks: 0, manualChanges: 0 });
      assert.equal((await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => ['getFields', 'startAssistedSession'].includes(call.type)).length, 0);
      console.log(`Native sidebar: unverified self-information ${variant} context stays manual with no profile release, answers, or Next.`);
    }
    assert.deepEqual(errors, []);
    console.log('Native sidebar: vault lock blocks Next and Resume gets fresh consent. All browser fixtures/data were synthetic; native desktop responses were DevTools stubs.');
  } catch (error) {
    if (panel) {
      console.error('Synthetic native sidebar state:', await panel.evaluate(() => document.body.innerText).catch(() => 'unavailable'));
      await panel.screenshot(path.join(root, 'artifacts/extension-panel-failure.png')).catch(() => {});
    }
    if (page) {
      console.error('Synthetic page state:', await page.evaluate(() => ({ url: location.href, next: window.__nextClicks, fields: Array.from(document.querySelectorAll('input,select'), e => ({ id: e.id, value: e.value, checked: e.checked, visible: Boolean(e.getClientRects().length) })) })).catch(() => 'unavailable'));
      await page.screenshot({ path: path.join(root, 'artifacts/extension-smoke-failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (panel) await panel.close();
    if (context) await context.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
module.exports = { fixture, verifiedAddressFixture, selfDetailsFixture, installNativeStub, attachNativePanel, portal, applicant, addressUrl, selfDetailsUrl, documentManualUrl, extensionDirectory, syntheticProfile };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
