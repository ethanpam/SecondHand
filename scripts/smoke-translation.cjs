'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const smoke = require('./smoke-extension.cjs');

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-translation-smoke-'));
  let context, panel, page, worker;
  const errors = [];
  try {
    context = await chromium.launchPersistentContext(userData, {
      channel: 'chromium', headless: true, locale: 'es-ES', viewport: { width: 1200, height: 900 },
      args: [`--disable-extensions-except=${smoke.extensionDirectory}`, `--load-extension=${smoke.extensionDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1440,1050', '--lang=es-ES']
    });
    
    await context.route('**/*', route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && url.pathname === '/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: smoke.fixture(url.searchParams.get('next')) });
      }
      if (url.protocol === 'chrome-extension:') return route.continue();
      return route.abort('blockedbyclient');
    });

    [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).hostname;
    await smoke.installNativeStub(worker);
    
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    
    const launcherUrl = `chrome-extension://${extensionId}/panel.html?surface=launcher`;
    const launcherFrame = async () => {
      await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 15000 }).toBe(true);
      return page.frames().find(frame => frame.url() === launcherUrl);
    };

    await page.goto('about:blank');
    await page.goto(`${smoke.applicant}?next=stay`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    
    let widget = await launcherFrame();
    await expect(widget.locator('#autofill')).toHaveText('Autocompletar', { timeout: 20000 });
    console.log('Verified: widget renders in Spanish');

    await widget.locator('#details').click();
    panel = await smoke.attachNativePanel(context, page, extensionId);
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBeTruthy();
    await panel.evaluate(() => {
      const select = document.getElementById('language-picker');
      select.value = 'es';
      select.dispatchEvent(new Event('change'));
    });
    await expect.poll(() => panel.text('#panel-autofill'), { timeout: 15000 }).toBe('Autocompletar esta página');
    console.log('Verified: side panel renders in Spanish');
    
    await panel.evaluate(() => {
      const select = document.getElementById('language-picker');
      select.value = 'en';
      select.dispatchEvent(new Event('change'));
    });
    
    await worker.evaluate(profile => { globalThis.__nativeSmoke.profile = profile; globalThis.__nativeSmoke.calls.length = 0; }, { profile: smoke.syntheticProfile });
    await page.goto('about:blank');
    await page.goto(`${smoke.applicant}?next=stay`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    widget = await launcherFrame();
    await expect(widget.locator('#autofill')).toHaveText('Autofill', { timeout: 20000 });
    
    await panel.evaluate(() => {
      const select = document.getElementById('language-picker');
      select.value = 'es';
      select.dispatchEvent(new Event('change'));
    });
    console.log('Verified: language picker switches surfaces and persists');

    await worker.evaluate(profile => { globalThis.__nativeSmoke.profile = profile; globalThis.__nativeSmoke.calls.length = 0; }, { profile: smoke.syntheticProfile });
    await page.goto('about:blank');
    await page.goto(`${smoke.applicant}?next=stay`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    widget = await launcherFrame();
    await expect(widget.locator('#widget-translate')).toBeVisible({ timeout: 20000 });
    await expect(widget.locator('#widget-translate')).toHaveText('Ver preguntas en español');
    console.log('Verified: widget offers the Spanish question list');

    await panel.click('#panel-translate');
    
    await expect.poll(() => panel.visible('#translation-error'), { timeout: 15000 }).toBe(true);
    const errText = await panel.text('#translation-error');
    assert.equal(errText, 'Traducción no disponible.');
    console.log('Verified: side-panel translation fallback line shown');
    
    await widget.locator('#autofill').click();
    await expect(widget.locator('#widget-text')).toHaveText(/usa la primera sugerencia/, { timeout: 20000 });
    console.log('Verified: autofill works after fallback');
    
  } finally {
    if (panel) await panel.close();
    if (context) await context.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
