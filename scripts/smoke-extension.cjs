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
  const nextMarkup = nextStep === 'consent'
    ? '<h1>Terms and Consent</h1><label><input id="termChkbox" type="checkbox">I agree to the terms</label><button type="button">Continue</button>'
    : '<h1>Household Members</h1><label>Household member<input name="householdMember"></label><button type="button">Continue</button>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Iowa flow · test only</title>
    <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:30px}main{max-width:690px}h1{font-size:30px}h3{font-size:18px;margin:25px 0 12px}label{display:block;margin:12px 0 4px}input:not([type=checkbox]):not([type=radio]),select{display:block;box-sizing:border-box;width:310px;height:36px;border:1px solid #a2b294;border-radius:5px;padding:7px}fieldset{border:1px solid #ced7c5;margin:16px 0;padding:12px}fieldset label{display:inline-block;margin-right:10px}button{padding:12px 18px;background:#285c45;color:white;border:0;border-radius:6px;margin-top:12px}.test-only{font-size:12px;color:#7c866e}.saveAndContinueButton{margin-left:15px}input:focus,select:focus{outline:3px solid #b39040}</style>
    </head><body><main id="synthetic-content"><p class="test-only">SYNTHETIC TEST FIXTURE. No government connection or real applicant data.</p>
    ${applicantFixture.html}</main><script>
      (${applicantFixture.attachConditionalHandlers.toString()})(document);
      window.__nextClicks = 0; window.__lastAnswers = null;
      document.querySelector('.saveAndContinueButton').addEventListener('click', () => {
        window.__nextClicks++;
        window.__lastAnswers = Object.fromEntries(Array.from(document.querySelectorAll('#personalInformation input, #personalInformation select'), element => [element.id, ['checkbox','radio'].includes(element.type) ? element.checked : element.value]));
        document.getElementById('synthetic-content').innerHTML = ${JSON.stringify(nextMarkup)};
        history.pushState({}, '', ${JSON.stringify(`${portal}/applyForBenefits/${nextStep === 'consent' ? 'consent' : 'household'}`)});
      });
    </script></body></html>`;
}

async function installNativeStub(worker) {
  await worker.evaluate(profile => {
    globalThis.__nativeSmoke = { locked: false, calls: [], profile };
    nativeRequest = async (type, payload = {}) => {
      const state = globalThis.__nativeSmoke;
      state.calls.push({ type, fields: payload.fields || [] });
      if (type === 'status') return { unlocked: !state.locked, applicationCount: 0 };
      if (type === 'showApp') return { shown: true };
      if (type === 'getFields') {
        if (state.locked) throw new Error('Unlock your local vault first.');
        return { values: Object.fromEntries(payload.fields.filter(field => state.profile[field]).map(field => [field, state.profile[field]])) };
      }
      if (type === 'recordProgress') return { recorded: true };
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
      if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && url.pathname === '/apspssp/ssp.portal/applyForBenefits/aboutYou') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic Iowa intro · test only</title><main><h1>About you</h1><p>SYNTHETIC TEST FIXTURE.</p></main>' });
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
    const launcherUrl = `chrome-extension://${extensionId}/panel.html?surface=launcher`;
    const launcherFrame = async () => {
      await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 15000 }).toBe(true);
      return page.frames().find(frame => frame.url() === launcherUrl);
    };
    const calls = type => worker.evaluate(type => globalThis.__nativeSmoke.calls.filter(call => call.type === type), type);

    async function startFixture({ profile = {}, locked = false } = {}) {
      await worker.evaluate(({ profile, locked }) => { globalThis.__nativeSmoke = { locked, calls: [], profile }; }, { profile: { ...syntheticProfile, ...profile }, locked });
      await page.goto(applicant, { waitUntil: 'domcontentloaded' });
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
    await page.evaluate(() => window.postMessage({ type: 'ui:autofill', confirmed: true }, '*'));
    await page.waitForTimeout(200);
    assert.deepEqual(await calls('getFields'), []);

    // One click fills the whole applicant page, including revealed sections.
    await widget.locator('#autofill').click();
    await expect(widget.locator('#widget-text')).toHaveText(/^Filled \d+$/, { timeout: 20000 });
    const full = await answers();
    assert.equal(full.firstName, syntheticProfile.firstName); assert.equal(full.lastName, syntheticProfile.lastName);
    assert.equal(full.suffix, 'III'); assert.equal(full.phoneNumber, '(202)555-0147');
    assert.equal(full.hasHome1, true); assert.equal(full.addressLine1, syntheticProfile.addressLine1);
    assert.equal(full.sameAddress2, true); assert.equal(full.mailingCity, 'Demo City');
    assert.equal(full.applicant1, true); assert.equal(full.snap, true);
    assert.equal(full.bestTime, syntheticProfile.bestContactTime);
    await expect(widget.locator('#need-you')).toBeHidden();
    assert.equal((await calls('getFields')).length, 1, 'One click makes one desktop request.');
    assert.equal((await calls('recordProgress')).length, 1);
    assert.equal(await page.evaluate(() => window.__nextClicks), 0, 'Autofill never clicks Next.');
    await page.screenshot({ path: path.join(root, 'artifacts/extension-assistant.png') });
    console.log('Widget: one click fills the full applicant page with one desktop request and no Next.');

    // Missing saved answers become "need you" links that jump to the field.
    widget = await startFixture({ profile: { firstName: '' } });
    await widget.locator('#autofill').click();
    await expect(widget.locator('#need-you')).toHaveText('1 need you', { timeout: 20000 });
    await expect(page.locator('#lastName')).toHaveValue(syntheticProfile.lastName);
    await widget.locator('#need-you').click();
    await expect.poll(() => page.evaluate(() => document.activeElement.id)).toBe('firstName');
    console.log('Widget: a missing saved answer is flagged and one click finds it.');

    const branches = [
      { name: 'home address with same mailing; optional blanks', profile: { mailingSameAsHome: 'yes', middleName: '', suffix: '', maidenName: '', addressLine2: '', bestContactTime: '' }, check: answers => { assert.equal(answers.sameAddress1, true); assert.equal(answers.mailingAddressLine1, ''); } },
      { name: 'no home address; separate mailing', profile: { hasHomeAddress: 'no' }, check: answers => { assert.equal(answers.hasHome2, true); assert.equal(answers.addressLine1, ''); assert.equal(answers.mailingAddressLine1, syntheticProfile.mailingAddressLine1); } },
      { name: 'Medicaid + FIP + medical-bill choice', profile: { programSnap: 'no', programMedicaid: 'yes', programFip: 'yes', helpPayMedicalBills: 'yes' }, check: answers => { assert.equal(answers.medicaid, true); assert.equal(answers.tanf, true); assert.equal(answers.helpPayMedBill1, true); assert.equal(answers.snap, false); } },
      { name: 'not applying personally hides program questions', profile: { isApplicant: 'no' }, check: answers => { assert.equal(answers.applicant2, true); assert.equal(answers.snap, false); } }
    ];
    for (const branch of branches) {
      widget = await startFixture({ profile: branch.profile });
      await widget.locator('#autofill').click();
      await expect(widget.locator('#widget-text')).toHaveText(/^Filled \d+$/, { timeout: 20000 });
      branch.check(await answers());
      assert.equal(await page.evaluate(() => window.__nextClicks), 0);
      console.log(`Widget conditional branch passed: ${branch.name}.`);
    }

    widget = await startFixture({ profile: { programSnap: 'no', programFip: 'no', programMedicaid: 'no' } });
    await widget.locator('#autofill').click();
    await expect(widget.locator('#need-you')).toHaveText('1 need you', { timeout: 20000 });
    console.log('Widget: an unanswered required program choice is flagged for the applicant.');

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

    // Other portal pages show only a small pill and never contact the desktop.
    await worker.evaluate(() => { globalThis.__nativeSmoke.calls = []; });
    await page.goto(`${portal}/applyForBenefits/aboutYou`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-secondhand-assistant]')).toHaveAttribute('data-secondhand-size', 'pill');
    widget = await launcherFrame();
    await expect(widget.locator('#pill')).toBeVisible();
    await expect(widget.locator('#widget')).toBeHidden();
    assert.deepEqual(await worker.evaluate(() => globalThis.__nativeSmoke.calls), []);
    // The side panel shows the same page as a plain checklist and never renders values.
    // It runs last: in headless Chromium the open panel covers the widget's corner.
    widget = await startFixture();
    await widget.locator('#autofill').click();
    await expect(widget.locator('#widget-text')).toHaveText(/^Filled \d+$/, { timeout: 20000 });
    await widget.locator('#details').click();
    panel = await attachNativePanel(context, page, extensionId);
    await expect.poll(() => panel.text('[data-key="lastName"]'), { timeout: 15000 }).toContain('Done');
    await expect.poll(() => panel.text('#desktop-status')).toContain('unlocked');
    const sidebarText = await panel.evaluate(() => document.body.innerText);
    const sidebarMessage = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return JSON.stringify(await chrome.runtime.sendMessage({ type: 'ui:pageState', tabId: tab.id }));
    });
    for (const value of ['Avery', 'Jordan', '123 Test Way', '2025550147', 'PO Box 123']) {
      assert.equal(sidebarText.includes(value), false, `Sidebar must never render a profile value: ${value}`);
      assert.equal(sidebarMessage.includes(value), false, `Sidebar messages must never receive a profile value: ${value}`);
    }
    await panel.screenshot(path.join(root, 'artifacts/extension-native-sidebar.png'));
    console.log('Side panel: checklist and desktop status without profile values.');

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
main().catch(error => { console.error(error); process.exitCode = 1; });
