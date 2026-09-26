'use strict';

// Real bundled Chromium / MV3 extension smoke. All "Iowa" documents are fulfilled
// locally by Playwright; host resolution is disabled and no real portal is used.
// Only nativeRequest is stubbed inside this isolated worker's DevTools context.
// Native framing, IPC, encryption, and desktop approvals have separate tests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const root = path.join(__dirname, '..');
const portal = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
const applicant = `${portal}/applyForBenefits/enterPersonalInfo`;
const extensionDirectory = path.join(root, 'extension');

function fixture(nextStep) {
  const target = nextStep === 'consent' ? 'consent' : 'household';
  const nextMarkup = nextStep === 'consent'
    ? '<h1>Terms and Consent</h1><label><input id="termChkbox" type="checkbox">I agree to the terms</label><button type="button">Continue</button>'
    : '<h1>Household Members</h1><label>Household member<input name="householdMember"></label><button type="button">Continue</button>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Iowa flow · test only</title>
    <style>body{font:16px system-ui;background:#f7f8f2;color:#294035;margin:0;padding:35px}main{max-width:680px}h1{font-size:30px}h3{font-size:17px;margin:22px 0 10px}label{display:block;margin:12px 0}input[type=text]{display:block;box-sizing:border-box;width:300px;height:36px;border:1px solid #a2b294;border-radius:5px;padding:7px}fieldset{border:1px solid #ced7c5;margin:16px 0;padding:12px}fieldset label{display:inline-block;margin-right:16px}button{padding:12px 18px;background:#285c45;color:white;border:0;border-radius:6px;margin-top:12px}.test-only{font-size:12px;color:#7c866e}.saveAndContinueButton{position:fixed;right:35px;bottom:28px}</style>
    </head><body><main id="synthetic-content"><p class="test-only">SYNTHETIC TEST FIXTURE. No government connection or real applicant data.</p>
    <h1>Enter Personal Information</h1><form id="personalInformation" action="enterPersonalInfo" method="post">
      <h3>Applicant's Information</h3>
      <label for="firstName">First Name*</label><input type="text" id="firstName" name="firstName">
      <label for="lastName">Last Name*</label><input type="text" id="lastName" name="lastName">
      <h3>Address Information</h3><fieldset><legend>Do you have a home address?*</legend>
      <label>Yes <input type="radio" id="hasHome1" name="hasHome"></label><label>No <input type="radio" id="hasHome2" name="hasHome" checked></label></fieldset>
      <h3>Program Information</h3><fieldset><legend>Are you applying for benefits?*</legend>
      <label>Yes <input type="radio" id="applicant1" name="applicant" checked></label><label>No <input type="radio" id="applicant2" name="applicant"></label></fieldset>
      <fieldset><legend>What benefits are you applying for?*</legend>
      <label>Supplemental Nutritional Assistance Program(SNAP) <input type="checkbox" id="snap" name="programs" checked></label></fieldset>
      <button type="button" class="saveAndContinueButton" onclick="submitAction('#personalInformation');">Save and Continue</button>
    </form></main><script>
      window.__nextClicks = 0;
      window.__lastAnswers = null;
      function submitAction(selector) {
        if (selector !== '#personalInformation') throw new Error('Unexpected synthetic form');
        window.__nextClicks++;
        window.__lastAnswers = { firstName: document.getElementById('firstName').value, lastName: document.getElementById('lastName').value };
        document.getElementById('synthetic-content').innerHTML = ${JSON.stringify(nextMarkup)};
        history.pushState({}, '', ${JSON.stringify(`${portal}/applyForBenefits/${target}`)});
      }
    </script></body></html>`;
}

async function installNativeStub(worker) {
  await worker.evaluate(() => {
    globalThis.__nativeSmoke = { locked: false, lockAfterFill: false, calls: [] };
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
        const syntheticProfile = { firstName: 'Chromium', lastName: 'Synthetic' };
        return { values: Object.fromEntries(payload.fields.filter(field => Object.hasOwn(syntheticProfile, field)).map(field => [field, syntheticProfile[field]])) };
      }
      if (type === 'recordProgress') {
        if (state.lockAfterFill) state.locked = true;
        return { recorded: true };
      }
      throw new Error('Unexpected native test message: ' + type);
    };
  });
}

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-chromium-smoke-'));
  let context;
  const errors = [];
  try {
    context = await chromium.launchPersistentContext(userData, {
      channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
      args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND']
    });
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && url.pathname === '/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: fixture(url.searchParams.get('next')) });
      }
      if (url.protocol === 'chrome-extension:') return route.continue();
      return route.abort('blockedbyclient');
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).hostname;
    assert.equal(extensionId, 'jogldddafjfbmfjnjlbjloakjbecnjpl');
    await installNativeStub(worker);
    const page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => errors.push(error.message));

    async function startFixture(next, lockAfterFill = false) {
      await worker.evaluate(lock => {
        globalThis.__nativeSmoke.locked = false;
        globalThis.__nativeSmoke.lockAfterFill = lock;
        globalThis.__nativeSmoke.calls = [];
      }, lockAfterFill);
      await page.goto(`${applicant}?next=${next}`, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      await expect(page.locator('[data-secondhand-assistant]')).toHaveCount(1);
      await expect.poll(() => page.frames().some(frame => frame.url() === `chrome-extension://${extensionId}/panel.html`), { timeout: 15000 }).toBe(true);
      const panel = page.frames().find(frame => frame.url() === `chrome-extension://${extensionId}/panel.html`);
      await expect(panel.locator('#fields .field')).toHaveCount(2, { timeout: 15000 });
      await expect(page.locator('#firstName')).toHaveValue('');
      await expect(page.locator('#lastName')).toHaveValue('');
      return panel;
    }

    let panel = await startFixture('manual');
    // The page cannot operate the extension-origin panel using a postMessage.
    await page.evaluate(() => window.postMessage({ type: 'ui:auto', enabled: true, confirmed: true }, '*'));
    await page.waitForTimeout(150);
    assert.deepEqual(await worker.evaluate(() => globalThis.__nativeSmoke.calls), []);
    assert.equal(await page.evaluate(() => {
      const button = document.querySelector('.saveAndContinueButton');
      const box = button.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return Boolean(top?.closest('[data-secondhand-assistant]'));
    }), true, 'The real assistant overlay covers Next; only its own temporary hiding may allow adapter checks.');
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/extension-assistant.png') });
    await panel.locator('#confirm').check();
    await panel.locator('#fill-next').click();
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 15000 }).toBe(1);
    assert.deepEqual(await page.evaluate(() => window.__lastAnswers), { firstName: 'Chromium', lastName: 'Synthetic' });
    await expect(panel.locator('#manual-note')).toBeVisible();
    await page.waitForTimeout(2300);
    assert.equal(await page.evaluate(() => window.__nextClicks), 1);
    console.log('Real extension: auto-injected panel + trusted Fill & Next filled synthetic fields and clicked the verified button exactly once.');

    for (const next of ['manual', 'consent']) {
      panel = await startFixture(next);
      await panel.locator('#start-auto').click();
      await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 15000 }).toBe(1);
      await expect(panel.locator('#guided-state')).toHaveText('PAUSED FOR YOUR REVIEW', { timeout: 15000 });
      await expect(panel.locator('#manual-note')).toBeVisible();
      await expect(panel.locator('#pause-auto')).toHaveText('Stop guided session');
      await page.waitForTimeout(2300);
      assert.equal(await page.evaluate(() => window.__nextClicks), 1);
      if (next === 'consent') await expect(page.locator('#termChkbox')).not.toBeChecked();
      await panel.locator('#pause-auto').click();
      await expect(panel.locator('#pause-auto')).not.toBeVisible();
      assert.ok((await worker.evaluate(() => globalThis.__nativeSmoke.calls)).some(call => call.type === 'endAssistedSession'));
      console.log(`Real extension: guided autofill paused on synthetic ${next} step without answering or advancing it.`);
    }

    panel = await startFixture('manual', true);
    await panel.locator('#start-auto').click();
    await expect(page.locator('#firstName')).toHaveValue('Chromium');
    await expect(page.locator('#lastName')).toHaveValue('Synthetic');
    await expect(panel.locator('#guided-state')).toHaveText('PAUSED FOR YOUR REVIEW', { timeout: 15000 });
    await expect(panel.locator('#automatic-reason')).toContainText(/approval|Unlock|unlock/);
    assert.equal(await page.evaluate(() => window.__nextClicks), 0);
    assert.ok((await worker.evaluate(() => globalThis.__nativeSmoke.calls)).some(call => call.type === 'checkAssistedSession'));
    await worker.evaluate(() => { globalThis.__nativeSmoke.locked = false; globalThis.__nativeSmoke.lockAfterFill = false; });
    await page.waitForTimeout(2300);
    assert.equal(await page.evaluate(() => window.__nextClicks), 0, 'Unlocking must not silently resume a revoked guided approval.');
    await panel.locator('#start-auto').click();
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 15000 }).toBe(1);
    assert.equal((await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'startAssistedSession').length, 2, 'Explicit Resume must obtain a fresh desktop grant after a lock.');
    await expect(panel.locator('#guided-state')).toHaveText('PAUSED FOR YOUR REVIEW', { timeout: 15000 });
    await panel.locator('#pause-auto').click();
    await expect(panel.locator('#pause-auto')).not.toBeVisible();
    assert.deepEqual(errors, []);
    console.log('Real extension: synthetic desktop lock prevented Next; explicit Resume requested a fresh desktop grant. Native requests were test stubs; no real Iowa traffic or applicant data.');
  } catch (error) {
    if (context) {
      const page = context.pages().find(candidate => candidate.url().startsWith(portal));
      if (page) {
        const panel = page.frames().find(frame => frame.url().endsWith('/panel.html'));
        console.error('Synthetic panel state:', panel ? await panel.locator('body').innerText().catch(() => 'unavailable') : 'iframe missing');
        await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
        await page.screenshot({ path: path.join(root, 'artifacts/extension-smoke-failure.png') }).catch(() => {});
      }
    }
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
