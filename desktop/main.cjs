'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, powerMonitor, session, safeStorage } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const os = require('node:os');
const { pathToFileURL, URL } = require('node:url');
const { Vault, atomicWrite, normalizeRecoveryKey, MAX_VAULT_BYTES } = require('./vault.cjs');
const { startBridge, runNativeHost, nativeStreams, extensionFromOrigin, EXTENSION_ID, isIowaNavigationAuthorization } = require('./bridge.cjs');
const { registerHost } = require('./registration.cjs');
const { getExtensionSetup, prepareBundledExtension } = require('./extension-setup.cjs');
const { testStoragePath } = require('./test-storage-path.cjs');
const { validateProfile, validateApplication, FIELD_LABELS, PORTAL_URL, isPortalUrl, siteOrigin } = require('../shared/schema.cjs');

app.setName('SecondHand');
// The step-by-step Chrome setup guide on SecondHand's website. During
// development, SECONDHAND_WEBSITE_URL can point it at a local website.
const EXTENSION_GUIDE_URL = 'https://secondhand-download.khoidoan00.chatgpt.site/chrome-extension';
function extensionGuideUrl() {
  const local = !app.isPackaged && process.env.SECONDHAND_WEBSITE_URL;
  if (!local) return EXTENSION_GUIDE_URL;
  try {
    const url = new URL('/chrome-extension', local);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch { /* Fall back to the published guide. */ }
  return EXTENSION_GUIDE_URL;
}
const localAppData = process.platform === 'win32' ?
  (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')) : app.getPath('appData');
app.setPath('userData', testStoragePath() || (!app.isPackaged && process.env.SECONDHAND_USER_DATA ?
  path.resolve(process.env.SECONDHAND_USER_DATA) : path.join(localAppData, 'SecondHand')));

// On macOS/Linux, Chrome invokes the app executable with its origin. Handle this
// before the desktop single-instance lock. Windows uses its standalone C# relay.
const nativeOrigin = process.argv.find(argument => argument.startsWith('chrome-extension://'));
if (nativeOrigin) {
  const extensionId = extensionFromOrigin(nativeOrigin);
  if (!extensionId) app.exit(1);
  else {
    app.whenReady().then(() => { if (process.platform === 'darwin') app.dock?.hide(); });
    const { input, output } = nativeStreams();
    runNativeHost(app.getPath('userData'), extensionId, input, output).then(() => app.exit(0), () => app.exit(1));
  }
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow;
  let bridge;
  let extensionId = null;
  let lockTimer;
  let lockRevision = 0;
  let quitting = false;
  let fieldRequestPending = false;
  let extensionSetupPending = false;
  let autofillWithoutAsking = false;
  let trustedSites = [];
  // Released only after a named confirmation on sites other than Iowa's portal.
  const SENSITIVE_FIELDS = ['ssn', 'birthDate', 'monthlyEarnedIncome', 'monthlyOtherIncome', 'assetsOnHand', 'monthlyMedicalExpenses'];
  const MAX_TRUSTED_SITES = 50;
  // A worker may survive a desktop restart. A per-process seed prevents its old
  // access receipt matching a new process; six bytes leave ample safe-integer headroom.
  let accessRevision = crypto.randomBytes(6).readUIntBE(0, 6);
  const userData = app.getPath('userData');
  const vault = new Vault(path.join(userData, 'vault.secondhand'));
  const configPath = path.join(userData, 'settings.json');
  const deviceSecretPath = path.join(userData, 'device-reset.bin');
  const deviceResetSupported = ['darwin', 'win32'].includes(process.platform);
  const rendererPath = path.join(__dirname, '../renderer/index.html');
  const rendererUrl = pathToFileURL(rendererPath).href;
  const AUTO_LOCK_MS = 10 * 60 * 1000;
  const publicError = message => Object.assign(new Error(message), { publicMessage: message });
  const validated = (validator, ...values) => {
    try { return validator(...values); } catch (error) { throw publicError(error.message); }
  };
  const formattedRecoveryKey = value => validated(normalizeRecoveryKey, value).match(/.{4}/g).join('-');

  // The operating system protects this secret (macOS Keychain or Windows data
  // protection), so only this computer account can use it to reset the password.
  function sealDeviceSecret() {
    if (!deviceResetSupported || !safeStorage.isEncryptionAvailable()) throw new Error('Device reset is unavailable.');
    const secret = crypto.randomBytes(32);
    return { secret, sealed: safeStorage.encryptString(secret.toString('base64')) };
  }
  async function readDeviceSecret() {
    try {
      if ((await fs.stat(deviceSecretPath)).size > 4096) return null;
      const secret = Buffer.from(safeStorage.decryptString(await fs.readFile(deviceSecretPath)), 'base64');
      return secret.length === 32 ? secret : null;
    } catch { return null; }
  }
  async function hasDeviceSecret() {
    try { await fs.access(deviceSecretPath); return true; } catch { return false; }
  }
  async function status() {
    const details = await vault.inspect().catch(() => null);
    return { exists: await vault.exists(), unlocked: vault.unlocked, lockRevision, recoveryKey: Boolean(details?.recoveryKey),
      deviceReset: Boolean(details?.deviceReset) && await hasDeviceSecret(), deviceResetSupported, extensionId, autofillWithoutAsking, trustedSites: [...trustedSites],
      bridgeRunning: Boolean(bridge), platform: process.platform,
      extensionSetup: await getExtensionSetup(app).catch(() => ({ prepared: false, available: false })) };
  }
  function touch() {
    clearTimeout(lockTimer);
    if (vault.unlocked) lockTimer = setTimeout(() => lockVault().catch(() => {}), AUTO_LOCK_MS);
  }
  async function lockVault() {
    clearTimeout(lockTimer);
    accessRevision++;
    await vault.lock();
    accessRevision++;
    lockRevision++;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('secondhand:locked', { lockRevision });
    return status();
  }
  function requireUnlocked() {
    if (!vault.unlocked) throw publicError('Unlock SecondHand first.');
  }
  async function saveSettings() {
    await atomicWrite(configPath, Buffer.from(JSON.stringify({ extensionId, autofillWithoutAsking, trustedSites })));
  }
  async function saveExtensionRegistration(id) {
    accessRevision++;
    let registration;
    try { registration = await registerHost(app, id); }
    catch (error) { throw publicError(error.message.startsWith('On Windows') ? error.message : 'Could not prepare the Chrome connection. Try again or see the setup instructions.'); }
    // Trust belongs to one extension identity; a different ID must be approved again.
    if (id !== extensionId) autofillWithoutAsking = false;
    extensionId = id;
    accessRevision++;
    await saveSettings();
    return registration;
  }
  async function bridgeRequest(request, context) {
    if (request.type === 'status') return { unlocked: vault.unlocked, applicationCount: vault.unlocked ? vault.getData().applications.length : 0, accessRevision };
    if (request.type === 'showApp') {
      if (mainWindow) { if (mainWindow.isMinimized?.()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
      return { shown: true };
    }
    requireUnlocked();
    if (request.type === 'trustSite') {
      const origin = siteOrigin(request.url);
      if (fieldRequestPending) throw publicError('Another request is waiting for your approval.');
      fieldRequestPending = true;
      const generation = accessRevision;
      try {
        mainWindow.show(); mainWindow.focus();
        const answer = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: 'Trust this site?', message: `Let SecondHand fill forms on ${origin}?`,
          detail: 'When you click Autofill on this site, SecondHand fills the saved answers it can match. It never clicks Next or Submit. Social Security number, date of birth, income, money on hand, and medical expenses still ask every time. You can remove this site on the Chrome extension page.',
          buttons: ['Cancel', 'Trust this site'], defaultId: 1, cancelId: 0, noLink: true
        });
        if (answer.response !== 1) throw publicError('You cancelled trusting this site.');
        requireUnlocked();
        if (generation !== accessRevision || extensionId !== context.extensionId) throw publicError('SecondHand access changed. Try again.');
        if (!trustedSites.includes(origin)) {
          if (trustedSites.length >= MAX_TRUSTED_SITES) throw publicError('Remove a trusted site before adding another.');
          trustedSites = [...trustedSites, origin];
          const approvedRevision = ++accessRevision;
          await saveSettings();
          requireUnlocked();
          if (approvedRevision !== accessRevision || extensionId !== context.extensionId) throw publicError('SecondHand access changed. Try again.');
        }
        touch();
        return { trusted: true, origin };
      } finally { fieldRequestPending = false; }
    }
    if (request.type === 'getFields') {
      const iowa = isPortalUrl(request.url);
      const navigationOnly = isIowaNavigationAuthorization(request);
      if (!request.fields.length && !navigationOnly) throw publicError('This page does not support navigation authorization.');
      const origin = siteOrigin(request.url);
      if (!iowa && !trustedSites.includes(origin)) throw publicError('This site isn’t trusted. Turn on SecondHand for it first.');
      const sensitive = iowa ? [] : request.fields.filter(field => SENSITIVE_FIELDS.includes(field));
      const trusted = autofillWithoutAsking && extensionId === context.extensionId && !sensitive.length;
      if (!trusted) {
        if (fieldRequestPending) throw publicError('Another field request is waiting for your approval.');
        fieldRequestPending = true;
        const generation = accessRevision;
        try {
          mainWindow.show(); mainWindow.focus();
          const site = iowa ? 'Iowa’s application' : origin;
          const answer = await dialog.showMessageBox(mainWindow, sensitive.length ? {
            type: 'warning', title: 'Share sensitive details?',
            message: `Fill sensitive details on ${origin}?`,
            detail: `${sensitive.map(field => FIELD_LABELS[field]).join(', ')}\n\nOnly allow this if you meant to give these details to ${origin}. Other fields: ${request.fields.filter(field => !sensitive.includes(field)).map(field => FIELD_LABELS[field]).join(', ') || 'none'}.`,
            buttons: ['Cancel', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true
          } : {
            type: 'question', title: 'Let Chrome fill this form?',
            message: navigationOnly ? 'Continue this verified Iowa step?' : `Fill these saved answers into ${site}?`,
            detail: `Website: ${iowa ? PORTAL_URL : origin}\n\n${navigationOnly ? 'No saved profile fields will be read for this step.' : request.fields.map(field => FIELD_LABELS[field]).join(', ')}\n\nChoose “Always allow” to let the SecondHand extension fill without asking whenever this app is unlocked. You can turn it off on the Chrome extension page. The website may save entered information. Review every answer before continuing.${iowa ? "\n\nOn the verified initial applicant page, SecondHand may click ordinary Save and Continue after checking completeness. On the supported home-address confirmation page, it will automatically select Iowa's first possible home-address suggestion and choose Save and Continue. This applies to home-address suggestions only. These actions send entered answers to Iowa, which may save them immediately. Review the chosen home address before final submission. Other question pages require manual Next. This approval does not authorize consent, signatures, or submitting your application." : ''}`,
            buttons: ['Cancel', 'Allow once', 'Always allow on this computer'], defaultId: 1, cancelId: 0, noLink: true
          });
          if (answer.response !== 1 && answer.response !== 2) throw publicError('You cancelled this field request.');
          requireUnlocked();
          if (generation !== accessRevision || extensionId !== context.extensionId) throw publicError('SecondHand access changed. Click Autofill again.');
          if (answer.response === 2 && !sensitive.length) {
            autofillWithoutAsking = true;
            const approvedRevision = ++accessRevision;
            await saveSettings();
            requireUnlocked();
            if (approvedRevision !== accessRevision || extensionId !== context.extensionId) throw publicError('SecondHand access changed. Click Autofill again.');
          }
        } finally { fieldRequestPending = false; }
      }
      if (navigationOnly) { touch(); return { values: {}, accessRevision }; }
      const profile = vault.getData().profile;
      const values = {};
      for (const field of request.fields) if (typeof profile[field] === 'string' && profile[field].trim()) values[field] = profile[field];
      touch();
      return { values, accessRevision };
    }
    if (request.type === 'recordProgress') {
      await vault.update(data => {
        const current = [...data.applications].reverse().find(item => ['draft', 'in_progress'].includes(item.status));
        const record = validateApplication(current ? { ...current, status: 'in_progress' } : { program: 'Iowa SNAP', status: 'in_progress' }, current);
        const index = current ? data.applications.findIndex(item => item.id === current.id) : -1;
        if (index < 0) data.applications.push(record); else data.applications[index] = record;
      });
      touch();
      return { recorded: true };
    }
    throw publicError('Unsupported bridge request.');
  }

  const methods = {
    status,
    async createVault(request) {
      let device = null;
      let deviceResetFailed = false;
      if (request?.allowDeviceReset === true && deviceResetSupported) {
        try { device = sealDeviceSecret(); } catch { deviceResetFailed = true; }
      }
      let created;
      try { created = await vault.create(request?.password, { deviceSecret: device?.secret }); }
      catch (error) { throw publicError(/password/.test(error.message) ? error.message : 'Could not set up SecondHand. Please try again.'); }
      finally { device?.secret.fill(0); }
      // Store the sealed secret only after creation succeeds, so a failed attempt
      // never replaces the secret that belongs to an existing file.
      if (device) {
        try { await atomicWrite(deviceSecretPath, device.sealed); }
        catch { deviceResetFailed = true; await vault.setDeviceSecret(null).catch(() => {}); }
      }
      touch(); return { status: await status(), recoveryKey: created.recoveryKey, deviceResetFailed };
    },
    async unlock(passphrase) {
      try { await vault.unlock(passphrase); }
      catch (error) { throw publicError(/password|already unlocked|Unable to unlock/.test(error.message) ? error.message : 'Could not unlock SecondHand.'); }
      touch(); return status();
    },
    async resetPassword(request) {
      try {
        if (request?.method === 'device') {
          const secret = await readDeviceSecret();
          try { await vault.resetWithDeviceSecret(secret, request?.password); } finally { secret?.fill(0); }
        } else await vault.resetWithRecoveryKey(request?.recoveryKey, request?.password);
      }
      catch (error) { throw publicError(/password|recovery key|already unlocked/.test(error.message) ? error.message : 'Could not reset your password. Please try again.'); }
      touch(); return status();
    },
    async replaceRecoveryKey() {
      requireUnlocked();
      let recoveryKey;
      try { recoveryKey = await vault.replaceRecoveryKey(); }
      catch { throw publicError('Could not create a recovery key. Please try again.'); }
      touch(); return { recoveryKey };
    },
    async setDeviceReset(enabled) {
      requireUnlocked();
      if (typeof enabled !== 'boolean') throw publicError('Invalid setting.');
      try {
        if (enabled) {
          let secret = await readDeviceSecret();
          if (!secret) {
            const device = sealDeviceSecret();
            await atomicWrite(deviceSecretPath, device.sealed);
            secret = device.secret;
          }
          try { await vault.setDeviceSecret(secret); } finally { secret.fill(0); }
        } else {
          await vault.setDeviceSecret(null);
          await fs.rm(deviceSecretPath, { force: true });
        }
      } catch { throw publicError(enabled ? 'This computer couldn’t save a reset option. Your recovery key still works.' : 'Could not turn off reset on this computer. Please try again.'); }
      touch(); return status();
    },
    async saveRecoveryKey(value) {
      const recoveryKey = formattedRecoveryKey(value);
      const result = await dialog.showSaveDialog(mainWindow, { title: 'Save recovery key', defaultPath: 'SecondHand recovery key.txt', filters: [{ name: 'Text file', extensions: ['txt'] }] });
      if (result.canceled || !result.filePath) return { cancelled: true };
      await atomicWrite(result.filePath, Buffer.from(`SecondHand recovery key\n\n${recoveryKey}\n\nIf you forget your password, choose "Forgot password?" on the SecondHand unlock screen and enter this key.\nAnyone with this key and your SecondHand files can open your information. Keep it somewhere safe, away from this computer.\n`));
      return { cancelled: false };
    },
    async copyRecoveryKey(value) {
      const recoveryKey = formattedRecoveryKey(value);
      clipboard.writeText(recoveryKey);
      setTimeout(() => { if (clipboard.readText() === recoveryKey) clipboard.clear(); }, 60 * 1000);
      return true;
    },
    lock: lockVault,
    async getData() {
      requireUnlocked(); touch();
      const { profile, applications } = vault.getData(); return { profile, applications };
    },
    async saveProfile(profile) {
      requireUnlocked();
      const clean = validated(validateProfile, profile);
      accessRevision++;
      await vault.update(data => { data.profile = clean; });
      accessRevision++;
      touch(); return clean;
    },
    async saveApplication(application) {
      requireUnlocked();
      const existing = application?.id ? vault.getData().applications.find(item => item.id === application.id) : undefined;
      if (application?.id && !existing) throw publicError('This application record no longer exists.');
      const clean = validated(validateApplication, application, existing);
      await vault.update(data => {
        const index = data.applications.findIndex(item => item.id === clean.id);
        if (index < 0) data.applications.push(clean); else data.applications[index] = clean;
      });
      touch(); return clean;
    },
    async deleteApplication(id) {
      requireUnlocked();
      if (typeof id !== 'string' || id.length > 64) throw publicError('Invalid application record.');
      await vault.update(data => { data.applications = data.applications.filter(item => item.id !== id); });
      touch(); return true;
    },
    async setAutofillTrust(enabled) {
      requireUnlocked();
      if (typeof enabled !== 'boolean') throw publicError('Invalid setting.');
      accessRevision++;
      autofillWithoutAsking = enabled;
      await saveSettings();
      touch(); return status();
    },
    async removeTrustedSite(origin) {
      requireUnlocked();
      if (typeof origin !== 'string' || !trustedSites.includes(origin)) throw publicError('That site isn’t in your trusted list.');
      accessRevision++;
      trustedSites = trustedSites.filter(site => site !== origin);
      await saveSettings();
      touch(); return status();
    },
    async openPortal() { await shell.openExternal(PORTAL_URL); return true; },
    async openExtensionGuide() { await shell.openExternal(extensionGuideUrl()); return true; },
    async prepareExtension() {
      if (extensionSetupPending) throw publicError('Extension setup is already running.');
      extensionSetupPending = true;
      try {
        const setup = await prepareBundledExtension(app);
        const registration = await saveExtensionRegistration(setup.extensionId);
        const openError = await shell.openPath(setup.directory);
        return { ...setup, ...registration, folderOpened: !openError };
      } finally { extensionSetupPending = false; }
    },
    async openExtensionFolder() {
      const setup = await getExtensionSetup(app);
      if (!setup.prepared) throw publicError('Prepare the Chrome extension first.');
      const error = await shell.openPath(setup.directory);
      if (error) throw publicError('The folder could not be opened. Use Copy folder path instead.');
      return true;
    },
    async copyExtensionFolderPath() {
      const setup = await getExtensionSetup(app);
      if (!setup.prepared) throw publicError('Prepare the Chrome extension first.');
      clipboard.writeText(setup.directory);
      return true;
    },
    async copyChromeExtensionsUrl() { clipboard.writeText('chrome://extensions'); return true; },
    async connectExtension(id) {
      if (typeof id !== 'string' || !EXTENSION_ID.test(id)) throw publicError('Use the 32-letter extension ID shown at chrome://extensions.');
      if (extensionSetupPending) throw publicError('Wait for extension setup to finish before changing its connection.');
      return saveExtensionRegistration(id);
    },
    async exportBackup() {
      if (!await vault.exists()) throw publicError('Create a password before saving a backup.');
      const result = await dialog.showSaveDialog(mainWindow, { title: 'Export encrypted backup', defaultPath: 'secondhand-backup.secondhand', filters: [{ name: 'SecondHand encrypted backup', extensions: ['secondhand'] }] });
      if (result.canceled || !result.filePath) return { cancelled: true };
      await atomicWrite(result.filePath, await vault.readEncrypted());
      return { cancelled: false };
    },
    async importBackup() {
      if (vault.unlocked) throw publicError('Lock SecondHand before restoring a backup.');
      const result = await dialog.showOpenDialog(mainWindow, { title: 'Import encrypted backup', properties: ['openFile'], filters: [{ name: 'SecondHand encrypted backup', extensions: ['secondhand'] }] });
      if (result.canceled || !result.filePaths[0]) return { cancelled: true };
      const file = result.filePaths[0];
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_VAULT_BYTES) throw publicError('This is not a supported encrypted backup.');
      const bytes = await fs.readFile(file);
      // Validate before offering to replace the current encrypted file.
      const { parseEnvelope } = require('./vault.cjs');
      try { parseEnvelope(bytes); } catch { throw publicError('This is not a supported encrypted backup.'); }
      if (await vault.exists()) {
        const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Replace saved information?',
          message: 'Restoring replaces the information saved on this computer.', detail: 'An encrypted copy of your current information will be kept in SecondHand’s data folder. The backup opens with the password it was created with. Its contents can’t be checked until you unlock it.',
          buttons: ['Cancel', 'Replace'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return { cancelled: true };
      }
      await vault.importEncrypted(bytes);
      return { cancelled: false };
    }
  };

  function createWindow() {
    mainWindow = new BrowserWindow({ width: 1220, height: 850, minWidth: 860, minHeight: 650,
      title: 'SecondHand', backgroundColor: '#f5f5ed', show: false, icon: path.join(__dirname, 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, devTools: !app.isPackaged } });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', event => event.preventDefault());
    mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
    mainWindow.webContents.on('before-input-event', () => { if (vault.unlocked) touch(); });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; lockVault().catch(() => {}); });
    mainWindow.loadFile(rendererPath);
  }

  // `npm run dev` sets this so renderer edits reload the window without locking the vault.
  function watchRendererForDev() {
    if (app.isPackaged || process.env.SECONDHAND_DEV_RELOAD !== '1') return;
    let timer;
    watch(path.dirname(rendererPath), () => {
      clearTimeout(timer);
      timer = setTimeout(() => mainWindow?.webContents.reloadIgnoringCache(), 100);
    });
  }

  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    // Packaged builds get the icon from electron-builder; show it in development too.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'icon.png'));
    await fs.mkdir(userData, { recursive: true, mode: 0o700 });
    try {
      const stat = await fs.stat(configPath);
      if (stat.size <= 4096) { const config = JSON.parse(await fs.readFile(configPath, 'utf8')); if (EXTENSION_ID.test(config.extensionId || '')) { extensionId = config.extensionId; autofillWithoutAsking = config.autofillWithoutAsking === true; }
      if (Array.isArray(config.trustedSites)) trustedSites = [...new Set(config.trustedSites.filter(origin => typeof origin === 'string' && siteOrigin(origin) === origin))].slice(0, MAX_TRUSTED_SITES); }
    } catch { /* Missing or invalid non-sensitive setup settings are reset. */ }
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    ipcMain.handle('secondhand:invoke', async (event, method, ...args) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
          event.senderFrame.url !== rendererUrl || !Object.hasOwn(methods, method) || args.length > 1) throw new Error('Request denied.');
      try { return await methods[method](...args); }
      catch (error) { throw new Error(error.publicMessage || 'The local operation could not be completed. Please try again.'); }
    });
    createWindow();
    watchRendererForDev();
    try { bridge = await startBridge(userData, () => extensionId, bridgeRequest); }
    catch { dialog.showErrorBox('Local bridge unavailable', 'Your saved information is available. Restart SecondHand to connect the Chrome extension.'); }
    powerMonitor.on('suspend', () => lockVault().catch(() => {}));
    powerMonitor.on('lock-screen', () => lockVault().catch(() => {}));
  }).catch(() => { dialog.showErrorBox('SecondHand could not start', 'Check that the app can access its local data folder.'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    clearTimeout(lockTimer);
    Promise.allSettled([vault.lock(), bridge?.close()]).then(() => app.quit());
  });
}
