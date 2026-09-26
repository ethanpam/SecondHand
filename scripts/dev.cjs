'use strict';

// Local development loop. desktop/ and shared/ edits restart Electron; renderer/
// edits reload the window inside the app so the vault stays unlocked. extension/
// edits reload the unpacked extension in an isolated Chromium profile, so the
// everyday Chrome profile is never touched. Iowa tabs are never refreshed
// automatically, because a refresh can resend a form to the government portal.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HOST_NAME } = require('../desktop/bridge.cjs');
const { chromeHostManifestDirectory } = require('../desktop/registration.cjs');
const { extensionIdFromKey } = require('../desktop/extension-setup.cjs');
const { PORTAL_URL } = require('../shared/schema.cjs');

const root = path.join(__dirname, '..');
const extensionDirectory = path.join(root, 'extension');
const browserProfile = path.join(root, 'node_modules', '.cache', 'secondhand-dev-chromium');
const PANEL_PAGE = /^panel\.(html|css|js)$/;
const log = message => console.log(`[dev] ${message}`);

function classifyChange(relativePath) {
  const [top, ...rest] = relativePath.split(/[\\/]/);
  const name = rest.at(-1) || '';
  // Skip OS and editor scratch files (.DS_Store, .swp, backup~, vim's 4913 probe).
  if (!name || name.startsWith('.') || name.endsWith('~') || /^\d+$/.test(name)) return null;
  if (top === 'desktop' || top === 'shared') return 'desktop';
  if (top === 'extension') return PANEL_PAGE.test(rest.join('/')) ? 'panel' : 'extension';
  return null;
}

function createBatcher(flush, delayMs) {
  let kinds = new Set();
  let timer;
  return {
    add(kind) {
      kinds.add(kind);
      clearTimeout(timer);
      timer = setTimeout(() => { const ready = kinds; kinds = new Set(); flush(ready); }, delayMs);
    },
    cancel() { clearTimeout(timer); kinds = new Set(); }
  };
}

// Chromium looks for user-level native hosts inside its profile directory.
async function syncNativeHost(source, profileDirectory) {
  let manifest;
  try { manifest = await fsp.readFile(source); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const target = path.join(profileDirectory, 'NativeMessagingHosts', path.basename(source));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, manifest);
  return true;
}

function startDesktop() {
  const electron = require('electron');
  let child = null;
  let expectingExit = false;
  function launch() {
    const current = spawn(electron, [root], { cwd: root, stdio: 'inherit', env: { ...process.env, SECONDHAND_DEV_RELOAD: '1' } });
    child = current;
    current.on('exit', (code, signal) => {
      if (child === current) child = null;
      if (!expectingExit) log(`Desktop app exited (${signal || `code ${code}`}). Save a file in desktop/ or shared/ to start it again.`);
    });
  }
  async function stop() {
    if (!child) return;
    const current = child;
    const exited = new Promise(resolve => current.once('exit', resolve));
    expectingExit = true;
    current.kill('SIGTERM');
    const force = setTimeout(() => current.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
    expectingExit = false;
  }
  launch();
  return { async restart() { await stop(); launch(); }, stop };
}

async function startBrowser() {
  const { chromium } = require('@playwright/test');
  const manifest = JSON.parse(await fsp.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));
  const extensionId = extensionIdFromKey(manifest.key);
  const extensionOrigin = `chrome-extension://${extensionId}/`;

  const hostDirectory = chromeHostManifestDirectory();
  const hostManifest = hostDirectory && path.join(hostDirectory, `${HOST_NAME}.json`);
  if (!hostManifest) log('The dev browser cannot reach the desktop vault on this platform; Windows needs the packaged native host.');
  else {
    if (!await syncNativeHost(hostManifest, browserProfile)) {
      log('Native bridge not registered yet. In the desktop app open Chrome extension → Prepare Chrome extension; the dev browser picks it up automatically.');
    }
    fs.watchFile(hostManifest, { interval: 2000 }, () => {
      syncNativeHost(hostManifest, browserProfile).then(found => { if (found) log('Native bridge registration copied into the dev browser.'); },
        error => log(`Could not copy the native bridge registration: ${error.message}`));
    });
  }

  const context = await chromium.launchPersistentContext(browserProfile, {
    channel: 'chromium', headless: false, viewport: null,
    args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`]
  });
  let manager;
  // Chromium disables a reloaded unpacked extension unless Developer mode is on.
  async function extensionsPage() {
    if (!manager || manager.isClosed()) {
      manager = context.pages().find(page => page.url() === 'about:blank') || await context.newPage();
      await manager.goto('chrome://extensions');
      await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    }
    return manager;
  }
  await extensionsPage();
  const portal = await context.newPage();
  await portal.goto(PORTAL_URL);

  return {
    context,
    // Reloads the worker and content-script registrations, and closes the side panel.
    async reloadExtension() {
      const page = await extensionsPage();
      const error = await page.evaluate(id => chrome.developerPrivate.reload(id, { failQuietly: true, populateErrorForUnpacked: true }), extensionId);
      if (error) throw new Error(`Extension failed to load: ${error.error}${error.path ? ` (${error.path})` : ''}`);
    },
    // Reloads the side panel and on-page widget iframe in place; the worker and Iowa form are untouched.
    // The side panel is not a Playwright page, so reach every extension document through DevTools targets.
    async reloadPanels() {
      const cdp = await context.newCDPSession(await extensionsPage());
      try {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const targets = targetInfos.filter(target => ['page', 'iframe'].includes(target.type) && target.url.startsWith(extensionOrigin));
        for (const target of targets) {
          const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
          await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'location.reload()' } }) });
          await cdp.send('Target.detachFromTarget', { sessionId });
        }
        return targets.length;
      } finally {
        await cdp.detach();
      }
    },
    async close() {
      if (hostManifest) fs.unwatchFile(hostManifest);
      await context.close();
    }
  };
}

async function main() {
  const desktop = startDesktop();
  const browser = await startBrowser();
  let browserOpen = true;
  browser.context.on('close', () => {
    browserOpen = false;
    log('Dev browser closed. Desktop reloading continues; restart npm run dev to reopen it.');
  });

  async function apply(kinds) {
    if (kinds.has('desktop')) {
      log('desktop/ or shared/ changed. Restarting the desktop app; unlock the vault again.');
      await desktop.restart();
    }
    if (!browserOpen || (!kinds.has('extension') && !kinds.has('panel'))) return;
    if (kinds.has('extension')) {
      await browser.reloadExtension();
      log('Extension reloaded. Refresh the Iowa tab for content-script changes and reopen the side panel.');
    } else {
      const count = await browser.reloadPanels();
      log(count ? `Reloaded ${count} extension page(s) in place.` : 'Panel files changed; open the side panel to see them.');
    }
  }

  let queue = Promise.resolve();
  const batcher = createBatcher(kinds => {
    queue = queue.then(() => apply(kinds)).catch(error => log(`Reload failed: ${error.message}`));
  }, 150);

  const watchers = ['desktop', 'shared', 'extension'].map(folder => {
    const watcher = fs.watch(path.join(root, folder), { recursive: true }, (_event, file) => {
      if (!file) return batcher.add(folder === 'extension' ? 'extension' : 'desktop');
      const kind = classifyChange(path.join(folder, file));
      if (kind) batcher.add(kind);
    });
    watcher.on('error', error => { log(`Watching ${folder}/ failed: ${error.message}`); shutdown(1); });
    return watcher;
  });
  log('Watching desktop/, shared/, renderer/, and extension/. Press Ctrl+C to stop.');

  let stopping = false;
  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    batcher.cancel();
    for (const watcher of watchers) watcher.close();
    await queue;
    if (browserOpen) await browser.close();
    await desktop.stop();
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

module.exports = { classifyChange, createBatcher, syncNativeHost };
