'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, powerMonitor, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Vault, atomicWrite, MAX_VAULT_BYTES } = require('./vault.cjs');
const { startBridge, runNativeHost, nativeStreams, extensionFromOrigin, EXTENSION_ID } = require('./bridge.cjs');
const { registerHost } = require('./registration.cjs');
const { getExtensionSetup, prepareBundledExtension } = require('./extension-setup.cjs');
const { testStoragePath } = require('./test-storage-path.cjs');
const { AssistedSession } = require('./assistance.cjs');
const { validateProfile, validateApplication, FIELD_LABELS, PORTAL_URL } = require('../shared/schema.cjs');

app.setName('SecondHand');
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
  let quitting = false;
  let fieldRequestPending = false;
  let extensionSetupPending = false;
  const userData = app.getPath('userData');
  const vault = new Vault(path.join(userData, 'vault.secondhand'));
  const assistance = new AssistedSession();
  const configPath = path.join(userData, 'settings.json');
  const rendererPath = path.join(__dirname, '../renderer/index.html');
  const rendererUrl = pathToFileURL(rendererPath).href;
  const AUTO_LOCK_MS = 10 * 60 * 1000;
  const publicError = message => Object.assign(new Error(message), { publicMessage: message });
  const validated = (validator, ...values) => {
    try { return validator(...values); } catch (error) { throw publicError(error.message); }
  };

  async function status() {
    return { exists: await vault.exists(), unlocked: vault.unlocked, extensionId,
      bridgeRunning: Boolean(bridge), platform: process.platform,
      extensionSetup: await getExtensionSetup(app).catch(() => ({ prepared: false, available: false })) };
  }
  function touch() {
    clearTimeout(lockTimer);
    if (vault.unlocked) lockTimer = setTimeout(() => lockVault().catch(() => {}), AUTO_LOCK_MS);
  }
  async function lockVault() {
    clearTimeout(lockTimer);
    assistance.revoke();
    await vault.lock();
    assistance.revoke();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('secondhand:locked');
    return status();
  }
  function requireUnlocked() {
    if (!vault.unlocked) throw publicError('Unlock your local vault first.');
  }
  async function saveExtensionRegistration(id) {
    assistance.revoke();
    let registration;
    try { registration = await registerHost(app, id); }
    catch (error) { throw publicError(error.message.startsWith('On Windows') ? error.message : 'Could not prepare the Chrome connection. Try again or see the setup instructions.'); }
    await atomicWrite(configPath, Buffer.from(JSON.stringify({ extensionId: id })));
    extensionId = id;
    assistance.revoke();
    return registration;
  }
  async function bridgeRequest(request, context) {
    if (request.type === 'status') return { unlocked: vault.unlocked, applicationCount: vault.unlocked ? vault.getData().applications.length : 0 };
    if (request.type === 'endAssistedSession') return assistance.end({ ...request, extensionId: context.extensionId });
    requireUnlocked();
    if (request.type === 'checkAssistedSession') {
      const active = validated(assistance.check.bind(assistance), { ...request, extensionId: context.extensionId });
      touch();
      return active;
    }
    if (request.type === 'startAssistedSession') {
      if (fieldRequestPending) throw publicError('Another request is waiting for your approval.');
      fieldRequestPending = true;
      const generation = assistance.generation;
      try {
        mainWindow.show(); mainWindow.focus();
        const answer = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: 'Start guided Iowa SNAP assistance?',
          message: 'Allow guided filling for the next 15 minutes?',
          detail: `Website: ${PORTAL_URL}\n\nApproved profile fields: ${request.fields.map(field => FIELD_LABELS[field]).join(', ')}\n\nSecondHand may fill these saved fields and click ordinary Next or Save and Continue on supported Iowa SNAP pages. These actions send entered answers to Iowa, which may save them immediately.\n\nIt must pause for unsupported or unanswered questions, CAPTCHA, consent, signatures, review, and final submission. This approval does not authorize consent, signatures, or submitting your application.\n\nStop from the extension or lock SecondHand at any time.`,
          buttons: ['Cancel', 'Allow guided assistance'], defaultId: 0, cancelId: 0, noLink: true
        });
        if (answer.response !== 1) throw publicError('You cancelled guided assistance.');
        requireUnlocked();
        if (generation !== assistance.generation || extensionId !== context.extensionId) throw publicError('The vault or Chrome connection changed. Start guided assistance again.');
        const grant = assistance.issue({ ...request, extensionId: context.extensionId });
        touch();
        return grant;
      } finally { fieldRequestPending = false; }
    }
    if (request.type === 'getFields') {
      if (request.assistanceToken) {
        validated(assistance.authorize.bind(assistance), { ...request, extensionId: context.extensionId });
        const profile = vault.getData().profile;
        const values = {};
        for (const field of request.fields) if (typeof profile[field] === 'string' && profile[field].trim()) values[field] = profile[field];
        touch();
        return { values };
      }
      if (fieldRequestPending) throw publicError('Another field request is waiting for your approval.');
      fieldRequestPending = true;
      const generation = assistance.generation;
      try {
        mainWindow.show(); mainWindow.focus();
        const answer = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: 'Share fields with Iowa HHS?',
          message: 'Allow this page to fill these fields once?',
          detail: `Website: ${PORTAL_URL}\n\n${request.fields.map(field => FIELD_LABELS[field]).join(', ')}\n\nThe Iowa website may save entered information. Review every answer before submitting.`,
          buttons: ['Cancel', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true
        });
        if (answer.response !== 1) throw publicError('You cancelled this field request.');
        requireUnlocked();
        if (generation !== assistance.generation || extensionId !== context.extensionId) throw publicError('The vault or Chrome connection changed. Review this request again.');
        const profile = vault.getData().profile;
        const values = {};
        for (const field of request.fields) if (typeof profile[field] === 'string' && profile[field].trim()) values[field] = profile[field];
        touch();
        return { values };
      } finally { fieldRequestPending = false; }
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
    async createVault(passphrase) {
      try { await vault.create(passphrase); }
      catch (error) { throw publicError(/passphrase|already exists/.test(error.message) ? error.message : 'Could not create the local vault.'); }
      touch(); return status();
    },
    async unlock(passphrase) {
      try { await vault.unlock(passphrase); }
      catch (error) { throw publicError(/passphrase|already unlocked|Unable to unlock/.test(error.message) ? error.message : 'Could not open the local vault.'); }
      touch(); return status();
    },
    lock: lockVault,
    async getData() {
      requireUnlocked(); touch();
      const { profile, applications } = vault.getData(); return { profile, applications };
    },
    async saveProfile(profile) {
      requireUnlocked();
      const clean = validated(validateProfile, profile);
      assistance.revoke();
      await vault.update(data => { data.profile = clean; });
      assistance.revoke();
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
    async openPortal() { await shell.openExternal(PORTAL_URL); return true; },
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
      if (!await vault.exists()) throw publicError('Create a local vault before exporting a backup.');
      const result = await dialog.showSaveDialog(mainWindow, { title: 'Export encrypted backup', defaultPath: 'secondhand-backup.secondhand', filters: [{ name: 'Encrypted SecondHand vault', extensions: ['secondhand'] }] });
      if (result.canceled || !result.filePath) return { cancelled: true };
      await atomicWrite(result.filePath, await vault.readEncrypted());
      return { cancelled: false };
    },
    async importBackup() {
      if (vault.unlocked) throw publicError('Lock your vault before importing a backup.');
      const result = await dialog.showOpenDialog(mainWindow, { title: 'Import encrypted backup', properties: ['openFile'], filters: [{ name: 'Encrypted SecondHand vault', extensions: ['secondhand'] }] });
      if (result.canceled || !result.filePaths[0]) return { cancelled: true };
      const file = result.filePaths[0];
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_VAULT_BYTES) throw publicError('This is not a supported encrypted backup.');
      const bytes = await fs.readFile(file);
      // Validate before offering to replace the current encrypted file.
      const { parseEnvelope } = require('./vault.cjs');
      try { parseEnvelope(bytes); } catch { throw publicError('This is not a supported encrypted backup.'); }
      if (await vault.exists()) {
        const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Replace local vault?',
          message: 'Importing replaces your current local vault.', detail: 'An encrypted recovery copy of your current vault will be kept in the local app data folder. The imported backup requires its original passphrase; its contents cannot be verified until you unlock it.',
          buttons: ['Cancel', 'Replace vault'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return { cancelled: true };
      }
      await vault.importEncrypted(bytes);
      return { cancelled: false };
    }
  };

  function createWindow() {
    mainWindow = new BrowserWindow({ width: 1220, height: 850, minWidth: 860, minHeight: 650,
      title: 'SecondHand', backgroundColor: '#f5f5ed', show: false,
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

  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    await fs.mkdir(userData, { recursive: true, mode: 0o700 });
    try {
      const stat = await fs.stat(configPath);
      if (stat.size <= 4096) { const config = JSON.parse(await fs.readFile(configPath, 'utf8')); if (EXTENSION_ID.test(config.extensionId || '')) extensionId = config.extensionId; }
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
    try { bridge = await startBridge(userData, () => extensionId, bridgeRequest); }
    catch { dialog.showErrorBox('Local bridge unavailable', 'Your local vault is available. Restart SecondHand to connect the Chrome extension.'); }
    powerMonitor.on('suspend', () => lockVault().catch(() => {}));
    powerMonitor.on('lock-screen', () => lockVault().catch(() => {}));
  }).catch(() => { dialog.showErrorBox('SecondHand could not start', 'Check that the app can access its local data folder.'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    clearTimeout(lockTimer);
    assistance.revoke();
    Promise.allSettled([vault.lock(), bridge?.close()]).then(() => app.quit());
  });
}
