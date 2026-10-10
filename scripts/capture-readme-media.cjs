'use strict';

// Records the README's pictures of the extension (docs/media/autofill.gif and docs/media/side-panel.png) and of the
// desktop app's My information page (docs/media/desktop-my-information.png) from this checkout. Like capture-guide-card.cjs, it loads extension/ into Chromium against the synthetic Iowa page and
// stubbed desktop app of smoke-extension.cjs, with the fictional applicant Avery Example, and blocks every other
// request. The first name is left out of the saved profile so the card shows "1 question left". The desktop picture runs
// the real Electron app with its data in a temporary folder, a throwaway password, and the same fictional profile.
// Needs ffmpeg on the PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium, _electron: electron, expect } = require('@playwright/test');
const { fixture, installNativeStub, attachNativePanel, applicant, extensionDirectory, syntheticProfile } = require('./smoke-extension.cjs');

const run = promisify(execFile);
const media = path.join(__dirname, '..', 'docs', 'media');
const FPS = 8;

async function open(userData) {
  const context = await chromium.launchPersistentContext(userData, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1500,1000']
  });
  await context.route('**/*', route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.isNavigationRequest() && `${url.origin}${url.pathname}` === applicant) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: fixture(url.searchParams.get('next')) });
    }
    if (url.protocol === 'chrome-extension:') return route.continue();
    return route.abort('blockedbyclient');
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  await installNativeStub(worker);
  await worker.evaluate(profile => { globalThis.__nativeSmoke = { locked: false, accessRevision: 0, calls: [], profile }; }, { ...syntheticProfile, firstName: '' });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(`${applicant}?next=stay`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  // Presentation only: a field the card jumps to keeps its label in view.
  await page.addStyleTag({ content: 'input,select,fieldset{scroll-margin-top:96px}' });
  const extensionId = new URL(worker.url()).hostname;
  const launcherUrl = `chrome-extension://${extensionId}/panel.html?surface=launcher`;
  await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 15000 }).toBe(true);
  const widget = page.frames().find(frame => frame.url() === launcherUrl);
  await expect(widget.locator('#autofill')).toBeVisible();
  await widget.evaluate(() => document.fonts.ready);
  return { context, page, widget, extensionId };
}

// Takes page screenshots at about FPS frames a second until stopped.
function record(page, directory) {
  let stopped = false, count = 0;
  const done = (async () => {
    while (!stopped) {
      const started = Date.now();
      await page.screenshot({ path: path.join(directory, `f${String(count++).padStart(4, '0')}.png`), caret: 'initial' });
      await page.waitForTimeout(Math.max(0, 1000 / FPS - (Date.now() - started)));
    }
  })();
  return async () => { stopped = true; await done; return count; };
}

async function autofillGif(userData, frames) {
  const { context, page, widget } = await open(userData);
  let stop;
  try {
    await page.waitForTimeout(500);
    stop = record(page, frames);
    await page.waitForTimeout(1200);
    await widget.locator('#autofill').click();
    await expect(widget.locator('#need-you')).toHaveText('1 question left', { timeout: 20000 });
    await expect(page.locator('#lastName')).toHaveValue(syntheticProfile.lastName);
    await page.waitForTimeout(1600);
    await widget.locator('#need-you').click();
    await expect.poll(() => page.evaluate(() => document.activeElement.id)).toBe('firstName');
    await page.waitForTimeout(600);
    await page.locator('#firstName').pressSequentially(syntheticProfile.firstName, { delay: 160 });
    await page.waitForTimeout(2200);
    const count = await stop();
    stop = null;
    assert.ok(count > 20, 'enough frames were recorded');
    const output = path.join(media, 'autofill.gif');
    await run('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png'), '-vf',
      'scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      '-loop', '0', output]);
    console.log(`Recorded ${count} frames to ${path.relative(process.cwd(), output)}.`);
  } finally {
    // A failed step stops the recording first, so its own error is the one reported.
    if (stop) await stop().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function sidePanelPng(userData, work) {
  const { context, page, widget, extensionId } = await open(userData);
  let panel;
  try {
    await widget.locator('#autofill').click();
    await expect(widget.locator('#need-you')).toHaveText('1 question left', { timeout: 20000 });
    await widget.locator('#details').click();
    panel = await attachNativePanel(context, page, extensionId);
    await expect.poll(() => panel.text('#page-checklist'), { timeout: 15000 }).toContain('First name');
    // Opening the side panel resizes the page; let that paint before the capture.
    // Headless Chromium gives the side panel its own fixed height; the page is cut to match. The panel scrolls to
    // the status line and the checklist, where First name says what it needs.
    const panelViewport = await panel.evaluate(() => innerHeight);
    await page.setViewportSize({ width: 1100, height: panelViewport });
    await page.evaluate(() => window.scrollTo(0, 0));
    await panel.evaluate(() => {
      document.querySelector('#page-checklist').scrollIntoView({ block: 'start' });
      document.getElementById('panel-body').scrollBy(0, -150);
    });
    await page.screenshot();
    await page.waitForTimeout(1100);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pageShot = path.join(work, 'page.png'), panelShot = path.join(work, 'panel.png');
    await page.screenshot({ path: pageShot, animations: 'disabled', caret: 'hide' });
    await panel.screenshot(panelShot);
    const output = path.join(media, 'side-panel.png');
    // Side by side, as Chrome shows them, with a thin divider. Both are captured from the same window, so they
    // should be the same height; the panel is padded to the page's height if it isn't.
    const height = async file => Number((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', file])).stdout.trim());
    const pageHeight = await height(pageShot), panelHeight = await height(panelShot);
    assert.ok(panelHeight <= pageHeight, `the side panel (${panelHeight}px) is no taller than the page (${pageHeight}px)`);
    await run('ffmpeg', ['-v', 'error', '-y', '-i', pageShot, '-i', panelShot, '-filter_complex',
      `[0]pad=iw+6:ih:0:0:color=0xdcded8[l];[1]pad=iw:${pageHeight}:0:0:color=0xf8faf7[r];[l][r]hstack=inputs=2`, output]);
    console.log(`Captured the page and side panel to ${path.relative(process.cwd(), output)}.`);
  } finally {
    if (panel) await panel.close();
    await context.close().catch(() => {});
  }
}

async function desktopPng(userData) {
  const password = 'synthetic-readme-capture-password';
  const application = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, SECONDHAND_USER_DATA: userData }, timeout: 30000 });
  try {
    let page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 860));
    await page.locator('#auth-view').waitFor({ state: 'visible' });
    await page.locator('#passphrase').fill(password);
    await page.locator('#confirm-passphrase').fill(password);
    // Keep the capture away from the real Keychain or Windows protected storage.
    if (await page.locator('#device-reset-field').isVisible()) await page.locator('#allow-device-reset').uncheck();
    await page.locator('#auth-submit').click();
    await expect(page.locator('#recovery-dialog')).toBeVisible({ timeout: 30000 });
    await page.locator('#recovery-saved').check();
    await page.locator('#recovery-done').click();
    await page.locator('#setup-skip').click();
    await page.evaluate(profile => window.secondHand.saveProfile(profile), syntheticProfile);
    // Lock and unlock so the window shows the profile it just saved.
    await page.locator('#lock-button').click();
    await page.locator('#passphrase').fill(password);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#workspace')).toBeVisible({ timeout: 30000 });
    await page.locator('.nav-item[data-view="profile"]').click();
    await expect(page.locator('#firstName')).toHaveValue(syntheticProfile.firstName);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const output = path.join(media, 'desktop-my-information.png');
    await page.screenshot({ path: output, animations: 'disabled', caret: 'hide' });
    console.log(`Captured My information to ${path.relative(process.cwd(), output)}.`);
  } finally {
    await application.close().catch(() => {});
  }
}

async function main() {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-readme-media-'));
  try {
    const frames = path.join(work, 'frames');
    await fs.mkdir(frames);
    await autofillGif(path.join(work, 'gif-profile'), frames);
    await sidePanelPng(path.join(work, 'panel-profile'), work);
    await desktopPng(path.join(work, 'desktop-data'));
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
