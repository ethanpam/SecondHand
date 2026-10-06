'use strict';

// SecondHand updates its Chrome extension itself (#85), end to end: the real desktop app in a temporary
// data folder (Laya off), and Chromium with SecondHand's native host registered only in its own
// temporary profile. Chromium runs an older build from the app's prepared folder; the app refreshes
// that folder from its bundle and the extension reloads itself once, then reports the new build.
// Iowa pages are synthetic and served locally; DNS is off. The real SecondHand data folder, Chrome,
// and Chrome's native-host registration are never touched.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, _electron: electron, expect: playwrightExpect } = require('@playwright/test');
// Every wait counts wall-clock time, which runs on while the computer sleeps (see host-sleep.cjs).
const expect = require('./host-sleep.cjs').sleepTolerant(playwrightExpect);
const { EXTENSION_FILES } = require('../desktop/extension-setup.cjs');
const { HOST_NAME } = require('../desktop/bridge.cjs');
const { fixture, attachNativePanel, applicant } = require('./smoke-extension.cjs');
const strings = require('../extension/strings.js');

const root = path.join(__dirname, '..');
const EXTENSION_ID = 'jogldddafjfbmfjnjlbjloakjbecnjpl';
const BUILD_LINE = /^const BUILD = '([^']+)';$/m;
const OLD_BUILD = '2000-01-01.1';
const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;

// Chromium with its own temporary profile, set up as the setup guide says: Developer mode on, then
// SecondHand loaded unpacked. Chrome reloads an unpacked extension only while Developer mode is on;
// without it, a reload leaves SecondHand turned off. DevTools listens on this computer only, for this run.
async function launchChromium(profile) {
  const child = spawn(chromium.executablePath(), ['--headless', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1200,900',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', 'about:blank'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    let port = null;
    for (let tries = 0; !port; tries++) {
      if (child.exitCode !== null || tries > 300) throw new Error('Chromium did not start.');
      await new Promise(resolve => setTimeout(resolve, 100));
      port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).split('\n')[0];
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    return { browser, async close() { await browser.close(); child.kill(); await exited; } };
  } catch (error) { child.kill(); await exited; throw error; }
}

async function main() {
  if (process.platform === 'win32') throw new Error('This smoke registers the native host in Chromium’s own profile folder, which Chromium reads on macOS and Linux only. On Windows it would need the registry.');
  const newBuild = BUILD_LINE.exec(await fs.readFile(path.join(root, 'extension/background.js'), 'utf8'))[1];
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-self-update-'));
  const appData = path.join(temporary, 'app-data');
  const copy = path.join(appData, 'chrome-extension');
  const profile = path.join(temporary, 'chromium-profile');
  let launched, context, application, panel;
  // Each start of SecondHand's worker, as DevTools reports it.
  const starts = [];
  try {
    // The app's prepared folder, as an older SecondHand left it: this extension under an older build.
    await fs.mkdir(copy, { recursive: true, mode: 0o700 });
    for (const file of EXTENSION_FILES) {
      const bytes = await fs.readFile(path.join(root, 'extension', file));
      await fs.writeFile(path.join(copy, file), ['background.js', 'panel.js'].includes(file)
        ? bytes.toString('utf8').replace(`const BUILD = '${newBuild}';`, `const BUILD = '${OLD_BUILD}';`) : bytes);
    }
    assert.equal(BUILD_LINE.exec(await fs.readFile(path.join(copy, 'background.js'), 'utf8'))[1], OLD_BUILD);
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({ extensionId: EXTENSION_ID, autofillWithoutAsking: false, trustedSites: [], layaEnabled: false }));

    // Chromium finds native hosts in its own profile folder; the host is this app, bound to the temporary data.
    const host = path.join(temporary, 'native-host');
    await fs.writeFile(host, `#!/bin/sh\nexport SECONDHAND_USER_DATA=${shellQuote(appData)}\nunset SECONDHAND_TEST_MODE SECONDHAND_TEST_USER_DATA\nexec ${shellQuote(require('electron'))} ${shellQuote(root)} "$@"\n`, { mode: 0o700 });
    await fs.mkdir(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    await fs.writeFile(path.join(profile, 'NativeMessagingHosts', `${HOST_NAME}.json`), JSON.stringify({ name: HOST_NAME, description: 'SecondHand self-update smoke',
      path: host, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }));

    launched = await launchChromium(profile);
    [context] = launched.browser.contexts();
    const devtools = await launched.browser.newBrowserCDPSession();
    devtools.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type === 'service_worker' && targetInfo.url === `chrome-extension://${EXTENSION_ID}/background.js`) starts.push(targetInfo.targetId);
    });
    await devtools.send('Target.setDiscoverTargets', { discover: true });
    const settings = await context.newPage();
    await settings.goto('chrome://extensions');
    await settings.evaluate(() => new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, resolve)));
    assert.equal(await settings.evaluate(() => new Promise(resolve => chrome.developerPrivate.getProfileConfiguration(profile => resolve(profile.inDeveloperMode)))), true);
    await settings.close();
    assert.deepEqual(await devtools.send('Extensions.loadUnpacked', { path: copy }), { id: EXTENSION_ID });
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.isNavigationRequest() && url.origin === 'https://hhsservices.iowa.gov' && url.pathname === '/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: fixture('stay') });
      }
      if (url.protocol === 'chrome-extension:') return route.continue();
      return route.abort('blockedbyclient');
    });
    // SecondHand's running worker and its build (another extension of Chromium's own also has a worker).
    const current = async () => {
      for (const candidate of context.serviceWorkers().filter(worker => worker.url() === `chrome-extension://${EXTENSION_ID}/background.js`)) {
        const build = await candidate.evaluate(() => BUILD).catch(() => null);
        if (build) return { candidate, build };
      }
      return null;
    };
    await expect.poll(async () => (await current())?.build, { timeout: 20000 }).toBe(OLD_BUILD);
    const started = starts.length;
    console.log(`Chromium runs SecondHand ${OLD_BUILD} from the app’s prepared folder.`);

    // The newer app, in the temporary data folder. Laya is off, and its update address leads nowhere.
    application = await electron.launch({ args: [root], timeout: 30000,
      env: { ...process.env, SECONDHAND_USER_DATA: appData, SECONDHAND_LAYA_UPDATE_URL: 'http://127.0.0.1:9/latest.json' } });
    await expect.poll(() => fs.access(path.join(appData, 'bridge-session.json')).then(() => true, () => false), { timeout: 30000 }).toBe(true);
    console.log(`The SecondHand app (${newBuild}) is running.`);

    // Opening the side panel asks the app for its status: the app refreshes its folder, and the
    // extension reloads itself from it.
    const page = context.pages()[0] || await context.newPage();
    const launcherUrl = `chrome-extension://${EXTENSION_ID}/panel.html?surface=launcher`;
    const openPanel = async () => {
      await page.goto(`${applicant}?next=stay`, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      await expect.poll(() => page.frames().some(frame => frame.url() === launcherUrl), { timeout: 15000 }).toBe(true);
      const widget = page.frames().find(frame => frame.url() === launcherUrl);
      await widget.locator('#details').click();
      return { widget, panel: await attachNativePanel(context, page, EXTENSION_ID) };
    };
    let widget;
    ({ widget, panel } = await openPanel());
    await expect.poll(async () => (await current())?.build, { timeout: 60000 }).toBe(newBuild);
    // The reload took the side panel with it.
    await panel.close();
    panel = null;
    const { candidate: updated } = await current();
    assert.equal(starts.length - started, 1, 'SecondHand reloaded once');
    assert.equal(BUILD_LINE.exec(await fs.readFile(path.join(copy, 'background.js'), 'utf8'))[1], newBuild, 'the app refreshed its folder');
    for (const file of EXTENSION_FILES) assert.deepEqual(await fs.readFile(path.join(copy, file)), await fs.readFile(path.join(root, 'extension', file)), file);
    console.log(`SecondHand reloaded itself once and runs ${newBuild}; the app’s folder matches its bundle.`);
    // The widget the old SecondHand left on the open page asks for the page to be reloaded.
    await expect.poll(() => widget.locator('#widget-text').textContent(), { timeout: 15000 }).toBe(strings.english('panel.reloadPage'));
    console.log('The widget left on the open page asks for the page to be reloaded.');

    // The next side panel says once that SecondHand was updated, and asking the app again reloads nothing.
    await updated.evaluate(() => { globalThis.__selfUpdateSmoke = 'same worker'; });
    ({ panel } = await openPanel());
    await expect.poll(() => panel.text('#update-note'), { timeout: 15000 }).toBe(strings.english('panel.updated'));
    await expect.poll(() => panel.text('#desktop-status'), { timeout: 30000 }).toBe(strings.english('desktop.locked'));
    assert.equal(await panel.text('#status') === strings.english('panel.outdated'), false, 'the side panel and the worker agree on the build');
    await panel.screenshot(path.join(root, 'artifacts/self-update/self-update-panel.png'));
    // The worker read that status: with no newer build to reload into, it has no update waiting, and a reload comes
    // only from one that is waiting (#143: state, not a 3-second wait).
    await expect.poll(() => updated.evaluate(() => selfUpdate), { timeout: 15000 }).toBe(null);
    assert.equal(await updated.evaluate(() => globalThis.__selfUpdateSmoke), 'same worker', 'no second reload');
    assert.equal(starts.length - started, 1);
    await panel.evaluate(() => { setTimeout(() => location.reload(), 0); });
    await expect.poll(() => panel.evaluate(() => document.readyState === 'complete' && document.getElementById('desktop-status').textContent), { timeout: 30000 })
      .toBe(strings.english('desktop.locked'));
    assert.equal(await panel.visible('#update-note'), false, 'said once');
    assert.equal(await updated.evaluate(() => globalThis.__selfUpdateSmoke), 'same worker');
    assert.equal(starts.length - started, 1);
    console.log('The side panel said once that SecondHand was updated; versions now match, so nothing reloads again.');
  } finally {
    if (panel) await panel.close();
    if (launched) await launched.close();
    if (application) await application.close();
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
