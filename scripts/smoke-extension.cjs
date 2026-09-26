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
const root = path.join(__dirname, '..');
const portal = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
const applicant = `${portal}/applyForBenefits/enterPersonalInfo`;
const extensionDirectory = path.join(root, 'extension');

function fixture(nextStep) {
  // Address controls below are hypothetical QA controls, not an observed Iowa
  // schema. They verify the shipping adapter's refusal to operate this step.
  const addressReview = nextStep === 'address-review';
  const nextMarkup = addressReview
    ? '<h1>Select Address</h1><p data-qa-only>HYPOTHETICAL QA CONTROLS. These are not verified Iowa selectors or address-selection behavior.</p><fieldset><legend>Fictional address choices for the isolation test</legend><label><input id="qa-original-address" name="qa-address-choice" type="radio" value="original">123 Test Way, Unit 4, Demo City, IA 50309</label><label><input id="qa-suggested-address" name="qa-address-choice" type="radio" value="suggested">123 TEST WAY, UNIT 4, DEMO CITY, IA 50309</label></fieldset><button id="qa-address-continue" type="button">Continue (QA only)</button>'
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
        document.getElementById('synthetic-content').innerHTML = ${JSON.stringify(nextMarkup)};
        history.pushState({}, '', ${JSON.stringify(addressReview ? `${portal}/qa-only/select-address` : `${portal}/applyForBenefits/${nextStep === 'consent' ? 'consent' : 'household'}`)});
        document.getElementById('qa-address-continue')?.addEventListener('click', () => { window.__addressNextClicks++; });
        document.querySelectorAll('[name="qa-address-choice"]').forEach(input => input.addEventListener('change', () => { window.__addressChoiceEvents++; }));
      });
    </script></body></html>`;
}

async function installNativeStub(worker) {
  await worker.evaluate(profile => {
    globalThis.__nativeSmoke = { locked: false, lockAfterFill: false, calls: [], profile };
    nativeRequest = async (type, payload = {}) => {
      const state = globalThis.__nativeSmoke;
      state.calls.push({ type, fields: payload.fields || [], session: Boolean(payload.assistanceToken) });
      if (type === 'status') return { unlocked: !state.locked, applicationCount: 0 };
      if (type === 'startAssistedSession') {
        if (state.locked) throw new Error('Unlock the synthetic desktop vault first.');
        return { assistanceToken: 'a'.repeat(64), fields: payload.fields, expiresAt: new Date(Date.now() + 900000).toISOString() };
      }
      if (type === 'checkAssistedSession') return { active: !state.locked };
      if (type === 'endAssistedSession') return { ended: true };
      if (type === 'getFields') {
        if (state.locked) throw new Error('Unlock the synthetic desktop vault first.');
        return { values: Object.fromEntries(payload.fields.filter(field => Object.hasOwn(state.profile, field)).map(field => [field, state.profile[field]])) };
      }
      if (type === 'recordProgress') { if (state.lockAfterFill) state.locked = true; return { recorded: true }; }
      throw new Error('Unexpected native test message: ' + type);
    };
  }, syntheticProfile);
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
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });

    async function startFixture({ next = 'manual', profile = {}, lockAfterFill = false } = {}) {
      if (panel && await panel.visible('#pause-auto')) await panel.click('#pause-auto');
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
    for (const value of ['Avery', 'Jordan', 'Example', '123 Test Way', '2025550147', 'PO Box 123']) {
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
    assert.equal(fullAnswers.mailingCity, 'Demo City'); assert.equal(fullAnswers.snap, true);
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

    await startFixture({ next: 'address-review' });
    await panel.click('#start-auto'); await nextOnce();
    await expect(page.locator('[data-qa-only]')).toContainText('HYPOTHETICAL QA CONTROLS');
    await expect.poll(() => panel.text('[data-key="addressReview"]')).toContain('Needs manual review');
    await expect.poll(() => panel.text('#manual-reason')).toContain('has not been live-verified');
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
main().catch(error => { console.error(error); process.exitCode = 1; });
