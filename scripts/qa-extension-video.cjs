'use strict';

// A reproducible, filmed QA journey through the actual extension and native
// Chrome sidebar. Portal documents and native desktop responses are simulated.
// Every answer is fictional. No requests can reach Iowa's live service.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { fixture, installNativeStub, attachNativePanel, applicant, extensionDirectory, syntheticProfile } = require('./smoke-extension.cjs');
const { startRecording } = require('./record-extension-video.cjs');

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDirectory = path.resolve(__dirname, '../artifacts/extension-qa', runId);

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-filmed-qa-'));
  let context, panel, recording;
  const chapters = [];
  const errors = [];
  let startedAt;
  try {
    await fs.mkdir(outputDirectory, { recursive: true });
    context = await chromium.launchPersistentContext(userData, {
      channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
      args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`,
        '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1440,1050']
    });
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.isNavigationRequest() && `${url.origin}${url.pathname}` === applicant) {
        return route.fulfill({ status: 200, contentType: 'text/html', body: fixture('address-review') });
      }
      if (url.protocol === 'chrome-extension:') return route.continue();
      return route.abort('blockedbyclient');
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).hostname;
    assert.equal(extensionId, 'jogldddafjfbmfjnjlbjloakjbecnjpl');
    await installNativeStub(worker);
    await worker.evaluate(profile => { globalThis.__nativeSmoke.profile = profile; }, {
      ...syntheticProfile, firstName: '', isApplicant: '', programSnap: ''
    });
    const page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(applicant, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await page.addStyleTag({ content: 'body{padding-top:146px}input,select,fieldset{scroll-margin-top:160px}#qa-video-caption{position:fixed;z-index:2147483646;left:0;right:0;top:0;background:#173d30;color:#fff;padding:18px 26px;box-shadow:0 2px 8px #0002;font:14px/1.55 system-ui;pointer-events:none}#qa-video-caption strong{display:block;font-size:19px}#qa-video-caption small{display:block;color:#d2e0cd}#qa-video-chapter{margin-top:6px;color:#f1d894;font-weight:600}' });
    await page.evaluate(() => {
      const caption = document.createElement('div');
      caption.id = 'qa-video-caption';
      caption.innerHTML = '<strong>secondHand extension QA · fictional applicant</strong><small>Isolated portal + simulated desktop connection · actual Chrome extension and sidebar</small><div id="qa-video-chapter">Open the assistant. Your saved profile stays on your computer.</div>';
      document.body.append(caption);
    });
    await expect.poll(() => page.frames().some(frame => frame.url() === `chrome-extension://${extensionId}/panel.html?surface=launcher`), { timeout: 15000 }).toBe(true);
    const launcher = page.frames().find(frame => frame.url() === `chrome-extension://${extensionId}/panel.html?surface=launcher`);
    await launcher.locator('#details').click();
    panel = await attachNativePanel(context, page, extensionId);
    await expect.poll(() => panel.text('#page-checklist'), { timeout: 15000 }).toContain('First name');
    await expect.poll(() => panel.evaluate(() => document.querySelector('#panel-autofill').disabled)).toBe(false);
    await expect(page.locator('#firstName')).toHaveValue('');

    // Opening Chrome's native sidebar resizes its compositor surface. Discard
    // the first capture and let that resize paint before filming; otherwise
    // Chromium can briefly tile the old surface into the larger screenshot.
    await page.screenshot();
    await page.waitForTimeout(1100);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    recording = await startRecording({ page, panel, outputDirectory });
    startedAt = Date.now();
    async function chapter(text, hold = 2200) {
      chapters.push({ seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)), text });
      console.log(text);
      await page.evaluate(text => { document.getElementById('qa-video-chapter').textContent = text; }, text);
      await page.waitForTimeout(hold);
    }
    async function panelTop() {
      await panel.evaluate(() => { document.getElementById('panel-body').scrollTop = 0; });
    }
    async function noNext() { assert.equal(await page.evaluate(() => window.__nextClicks), 0); }

    await chapter('1. Start Autofill with an intentionally incomplete fictional profile.', 3200);
    await panel.click('#panel-autofill');
    await expect.poll(() => panel.text('[data-key="firstName"]'), { timeout: 20000 }).toContain('Needs you');
    await expect(page.locator('#lastName')).toHaveValue(syntheticProfile.lastName);
    await expect(page.locator('#addressLine1')).toHaveValue(syntheticProfile.addressLine1);
    await expect(page.locator('#mailingAddressLine1')).toHaveValue(syntheticProfile.mailingAddressLine1);
    await noNext();
    await panelTop();
    await chapter('Saved details are filled. Missing required answers keep Next paused.', 3000);

    await page.locator('#addressLine1').scrollIntoViewIfNeeded();
    await chapter('Home address filled automatically from the fictional saved profile.', 3000);
    await page.locator('#mailingAddressLine1').scrollIntoViewIfNeeded();
    await chapter('Separate mailing address filled automatically too.', 3000);
    await panel.click('[data-key="firstName"]');
    await expect.poll(() => page.evaluate(() => document.activeElement.id)).toBe('firstName');
    await expect.poll(() => panel.text('[data-key="firstName"]')).toContain('Needs you');
    await chapter('2. Click a missing checklist item to focus its field in the form.', 3000);
    await page.locator('#firstName').pressSequentially(syntheticProfile.firstName, { delay: 160 });
    await expect.poll(() => panel.text('[data-key="firstName"]')).toContain('Done');
    await noNext();
    await chapter('First name is complete. Other required questions still need an answer.', 2200);

    await panel.click('[data-key="isApplicant"]');
    await chapter('3. Acting as the fictional applicant: answer Yes to applying for benefits.', 2600);
    await page.locator('#applicant1').check();
    await expect(page.locator('#progSelection')).toBeVisible();
    await expect.poll(() => panel.text('[data-key="programs"]'), { timeout: 15000 }).toContain('Needs you');
    await noNext();
    await panel.click('[data-key="programs"]');
    await chapter('The new program question is detected. Select SNAP for this QA applicant.', 3000);
    await page.locator('#snap').check();
    await expect.poll(() => page.evaluate(() => window.__nextClicks), { timeout: 20000 }).toBe(1);
    const submitted = await page.evaluate(() => window.__lastAnswers);
    assert.equal(submitted.firstName, syntheticProfile.firstName);
    assert.equal(submitted.applicant1, true);
    assert.equal(submitted.snap, true);
    assert.equal(submitted.bestTime, syntheticProfile.bestContactTime);
    await expect.poll(() => panel.text('#status'), { timeout: 15000 }).toMatch(/address|review/i);
    await page.evaluate(() => window.scrollTo(0, 0));
    await panelTop();
    await chapter('4. All required answers complete: the extension clicked Next exactly once.', 3400);
    await expect(page.locator('[data-qa-only]')).toContainText('HYPOTHETICAL QA CONTROLS');
    await expect.poll(() => panel.text('[data-key="addressReview"]')).toContain('Do it yourself');
    await expect(page.locator('#qa-original-address')).not.toBeChecked();
    await expect(page.locator('#qa-suggested-address')).not.toBeChecked();
    const requestsAtPause = (await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'getFields').length;
    await chapter('Select Address pauses for review. These example choices are hypothetical.', 3800);
    assert.deepEqual(await page.evaluate(() => ({ next: window.__nextClicks, addressNext: window.__addressNextClicks, changes: window.__addressChoiceEvents })), { next: 1, addressNext: 0, changes: 0 });
    assert.equal((await worker.evaluate(() => globalThis.__nativeSmoke.calls)).filter(call => call.type === 'getFields').length, requestsAtPause);
    await page.locator('#qa-original-address').check();
    await chapter('Manual QA action: confirm the fictional address. Automation stays paused.', 3000);
    await expect(page.locator('#qa-original-address')).toBeChecked();
    assert.equal(await page.evaluate(() => window.__addressChoiceEvents), 1);
    assert.equal(await page.evaluate(() => window.__addressNextClicks), 0);
    await expect.poll(() => panel.text('#status')).toMatch(/address|review/i);
    await chapter('PASS: autofill, missing-answer guidance, manual choices, one Next, and review pause.', 3800);
    await panel.screenshot(path.join(outputDirectory, 'final-sidebar.png'));
    await page.screenshot({ path: path.join(outputDirectory, 'final-form.png') });
    assert.deepEqual(errors, []);

    const video = await recording.stop();
    recording = null;
    const report = { passed: true, createdAt: new Date().toISOString(), video, chapters,
      boundaries: { extensionAndNativeSidebar: 'real Chromium', desktopConnection: 'simulated responses', portal: 'locally intercepted fixtures; DNS disabled', data: 'fictional applicant only', addressChoices: 'hypothetical; unverified live schema' },
      assertions: ['Profile address and mailing address filled', 'Missing first name prevented navigation', 'Checklist focused missing field', 'Manual first name and applicant answers accepted', 'Revealed program question required an answer', 'SNAP choice resumed filling and exactly one Next', 'Address review made zero automatic choices or further Next clicks', 'Manual address choice did not resume unsupported automation', 'No JavaScript page errors'] };
    await fs.writeFile(path.join(outputDirectory, 'qa-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`QA video: ${video.path}`);
    console.log('Recorded journey passed. No live Iowa connection or application was made.');
  } finally {
    if (recording) await recording.stop().catch(error => console.error('Recording cleanup:', error.message));
    if (panel) await panel.close();
    if (context) await context.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
