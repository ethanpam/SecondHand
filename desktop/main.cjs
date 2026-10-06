'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, powerMonitor, session, safeStorage, systemPreferences } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { pathToFileURL, URL } = require('node:url');
const { Vault, atomicWrite, normalizeRecoveryKey, MAX_VAULT_BYTES } = require('./vault.cjs');
const { startBridge, runNativeHost, nativeStreams, appLaunch, startApp, extensionFromOrigin, EXTENSION_ID, isIowaNavigationAuthorization } = require('./bridge.cjs');
const { registerHost } = require('./registration.cjs');
const { getExtensionSetup, prepareBundledExtension } = require('./extension-setup.cjs');
const { testStoragePath } = require('./test-storage-path.cjs');
const { touchIdPlatform, createTouchIdUnlock } = require('./touch-id.cjs');
const { createLaya } = require('./laya.cjs');
const { createFieldSuggestions } = require('./field-suggestions.cjs');
const { createFieldAnswers } = require('./field-answers.cjs');
const { createFieldReview } = require('./field-review.cjs');
const { createOcrEngine } = require('./ocr-engine.cjs');
const { createDocumentReader } = require('./ocr-service.cjs');
const { requestId: documentRequestId } = require('./ocr-limits.cjs');
const { analyzeDocument } = require('../shared/document-parser.cjs');
const { validateProfile, validateApplication, HOUSEHOLD_COUNT_FIELDS, YES_NO_FIELDS, PORTAL_URL, isPortalUrl, siteOrigin, isRequestField, fieldLabel, releasedValue,
  blockedByBirthDate, savedBirthDateRefusal } = require('../shared/schema.cjs');
const household = require('../shared/household.cjs');

app.setName('SecondHand');
// The step-by-step Chrome setup guide on SecondHand's website. During
// development, SECONDHAND_WEBSITE_URL can point it at a local website.
const EXTENSION_GUIDE_URL = 'https://secondhand-download.khoidoan00.chatgpt.site/chrome-extension';
// The Laya model repo's pointer to its newest model (docs/laya-model.md).
const LAYA_UPDATE_URL = 'https://huggingface.co/JacobTDang/secondhand-laya/resolve/main/latest.json';
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
    // Asked to open SecondHand while it isn't running, the host starts this same app on its own.
    const launch = appLaunch({ execPath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged, env: process.env });
    runNativeHost(app.getPath('userData'), extensionId, input, output, () => startApp(launch, spawn)).then(() => app.exit(0), () => app.exit(1));
  }
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Today on this computer's calendar (#135): what a birth date being saved is checked against and what
  // ages are worked out from. Tests pin it with SECONDHAND_TEST_TODAY (YYYY-MM-DD) in test mode; a packaged
  // SecondHand refuses it.
  const pinnedToday = process.env.SECONDHAND_TEST_TODAY;
  if (pinnedToday !== undefined) {
    if (app.isPackaged) throw new Error('A packaged SecondHand refuses SECONDHAND_TEST_TODAY.');
    if (process.env.SECONDHAND_TEST_MODE !== '1') throw new Error('SECONDHAND_TEST_TODAY needs SECONDHAND_TEST_MODE=1.');
    household.localDate(pinnedToday);
  }
  const today = () => household.localDate(pinnedToday);
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
  // SecondHand on all websites: any https site may ask, as a trusted one does. Saved only while on.
  let allSites = false;
  // Laya is on unless the person turned it off. Until they choose, this is undefined and not saved.
  let layaEnabled;
  // What was reset because settings.json couldn't be read at startup, until a setting is saved (#139).
  let settingsNotice = null;
  // Released only after a named confirmation on sites other than Iowa's portal.
  const SENSITIVE_FIELDS = ['ssn', 'hasSsn', 'hasSsnAnswer', 'birthDate', 'monthlyEarnedIncome', 'monthlyOtherIncome', 'assetsOnHand', 'monthlyMedicalExpenses',
    'usCitizen', 'disabled', 'blind', 'healthLimitation', 'medicare'];
  // Counts worked out from household members' birth dates reveal ages, as the birth date does: band counts
  // always, and the profile's own age counts while the household list sets them.
  const AGE_COUNT_FIELDS = Object.freeze(['householdAdults', 'householdChildren', 'householdSeniors']);
  const MAX_TRUSTED_SITES = 50;
  // A trusted site's host name is at most 253 characters, the longest DNS allows, so its origin is at most 261.
  const MAX_HOST_LENGTH = 253;
  const hostTooLong = origin => new URL(origin).hostname.length > MAX_HOST_LENGTH;
  // settings.json at its largest: 50 origins of 261 characters (13.2 KB) and the other settings. 16 KB holds it.
  const MAX_SETTINGS_BYTES = 16 * 1024;
  // The guided first-run setup's progress: how many of its six steps are done. Not sensitive, and kept
  // beside the settings only while the setup is under way.
  const SETUP_STEPS = 6;
  // A worker may survive a desktop restart. A per-process seed prevents its old
  // access receipt matching a new process; six bytes leave ample safe-integer headroom.
  let accessRevision = crypto.randomBytes(6).readUIntBE(0, 6);
  const userData = app.getPath('userData');
  // The app's one Laya runtime. While it is on, it downloads its model and keeps it up to date in
  // the background; the model loads when a decision is asked for. Desktop request handlers call
  // laya.decide / laya.decideBatch.
  // Development builds may check another latest.json (its files are still pinned by SHA-256), or use
  // a local export, which skips the pin, with its prompt format named.
  const localModel = !app.isPackaged && process.env.SECONDHAND_LAYA_MODEL_DIR;
  const laya = createLaya({ userDataDir: userData, manifest: require('./laya-model.json'),
    updateUrl: !app.isPackaged && process.env.SECONDHAND_LAYA_UPDATE_URL || LAYA_UPDATE_URL,
    modelDir: localModel ? path.resolve(localModel) : undefined, modelFormat: localModel ? process.env.SECONDHAND_LAYA_MODEL_FORMAT : undefined });
  // An unreadable Laya status is shown as an error; it must not keep the app from opening.
  const layaStatus = () => laya.status().catch(error => ({ state: 'error', enabled: layaEnabled !== false, message: `Laya’s status couldn’t be read (${error.message}).` }));
  // The extension's uses of that runtime: matching text boxes (#39) and answering choice questions (#42).
  const fieldSuggestions = createFieldSuggestions({ laya });
  const fieldAnswers = createFieldAnswers({ laya });
  const fieldReview = createFieldReview({ laya });
  let fieldReviewRevision = 0;
  const vault = new Vault(path.join(userData, 'vault.secondhand'));
  // Unlock with Touch ID on a Mac (#99). Its key is sealed in this Mac's Keychain in touch-unlock.bin.
  const touchIdUnlock = createTouchIdUnlock({ vault, filePath: path.join(userData, 'touch-unlock.bin'), revision: () => accessRevision,
    platform: touchIdPlatform({ systemPreferences, safeStorage, platform: process.platform, packaged: app.isPackaged, env: process.env }) });
  const configPath = path.join(userData, 'settings.json');
  const deviceSecretPath = path.join(userData, 'device-reset.bin');
  const deviceResetSupported = ['darwin', 'win32'].includes(process.platform);
  const rendererPath = path.join(__dirname, '../renderer/index.html');
  const rendererUrl = pathToFileURL(rendererPath).href;
  const AUTO_LOCK_MS = 10 * 60 * 1000;
  const publicError = message => Object.assign(new Error(message), { publicMessage: message });
  // While Laya is off, not downloaded, or failing, the extension's Laya requests answer "not ready".
  const LAYA_STATES = ['off', 'unavailable', 'not-downloaded', 'downloading', 'ready', 'error'];
  const layaNotReady = () => Object.assign(publicError('Laya isn’t ready on this computer.'), { publicCode: 'LAYA_NOT_READY' });
  const validated = (validator, ...values) => {
    try { return validator(...values); } catch (error) { throw publicError(error.message); }
  };
  const formattedRecoveryKey = value => validated(normalizeRecoveryKey, value).match(/.{4}/g).join('-');
  const documentReader = createDocumentReader({
    isUnlocked: () => vault.unlocked,
    chooseFile: () => dialog.showOpenDialog(mainWindow, { title: 'Read a document on this computer',
      properties: ['openFile'], filters: [{ name: 'PDF or image', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }] }),
    createEngine: () => createOcrEngine({ BrowserWindow, session, ipcMain,
      assetsDirectory: app.isPackaged ? path.join(process.resourcesPath, 'ocr') : path.join(__dirname, '../build/ocr') }),
    onProgress: progress => {
      if (vault.unlocked && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('secondhand:document-progress', progress);
    },
    analyzeDocument
  });

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
      deviceReset: Boolean(details?.deviceReset) && await hasDeviceSecret(), deviceResetSupported, extensionId, autofillWithoutAsking, trustedSites: [...trustedSites], allSites,
      touchId: await touchIdUnlock.state(), touchIdSupported: touchIdUnlock.supported(), touchIdNotice: touchIdUnlock.notice, settingsNotice,
      bridgeRunning: Boolean(bridge), platform: process.platform, laya: await layaStatus(),
      extensionSetup: await getExtensionSetup(app).catch(() => ({ prepared: false, available: false })) };
  }
  function touch() {
    clearTimeout(lockTimer);
    if (vault.unlocked) lockTimer = setTimeout(() => lockVault().catch(() => {}), AUTO_LOCK_MS);
  }
  async function lockVault() {
    clearTimeout(lockTimer);
    documentReader.cancel();
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
    await atomicWrite(configPath, Buffer.from(JSON.stringify({ extensionId, autofillWithoutAsking, trustedSites, layaEnabled, ...(allSites && { allSites }) })));
    settingsNotice = null;
  }
  // settings.json at startup. None is a new install. A file that can't be read, or isn't settings, leaves
  // every setting at its default, and the app says so. Only Laya's off choice is kept, when it can still be
  // read: it gives no access, and it keeps the model's download away.
  async function loadSettings() {
    let text = null;
    try {
      if ((await fs.stat(configPath)).size <= MAX_SETTINGS_BYTES) text = await fs.readFile(configPath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return; }
    let config;
    try { config = JSON.parse(text); } catch { config = null; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      if (/"layaEnabled"\s*:\s*false\b/.test(text ?? '')) layaEnabled = false;
      settingsNotice = 'SecondHand couldn’t read its settings file, so it reset the Chrome connection, Always allow, your trusted sites, and all websites. Set them up again on the Chrome extension page.' +
        (layaEnabled === false ? ' Laya stays off.' : ' Laya is on again. If you had turned it off, turn it off again on that page.');
      return;
    }
    if (EXTENSION_ID.test(config.extensionId || '')) { extensionId = config.extensionId; autofillWithoutAsking = config.autofillWithoutAsking === true; }
    if (Array.isArray(config.trustedSites)) trustedSites = [...new Set(config.trustedSites.filter(origin => typeof origin === 'string' && siteOrigin(origin) === origin && !hostTooLong(origin)))].slice(0, MAX_TRUSTED_SITES);
    if (typeof config.layaEnabled === 'boolean') layaEnabled = config.layaEnabled;
    allSites = config.allSites === true;
  }
  // A site other than Iowa's portal may receive saved answers when the person trusted it, or every
  // https site while all websites is on. Sensitive details still ask on each one.
  const siteAllowed = origin => trustedSites.includes(origin) || (allSites && Boolean(origin));
  const SITE_RULES = 'Social Security number, date of birth, the ages of the people in your household, income, money on hand, medical expenses, and your answers about citizenship, disability, blindness, health, Medicare, and having a Social Security number still ask every time';
  async function turnOffAllSites() {
    if (!allSites) return;
    accessRevision++;
    allSites = false;
    await saveSettings();
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
  // Laya's state for the extension. Nothing else about the model leaves the app.
  async function extensionLayaState() {
    const { state } = await layaStatus();
    if (!LAYA_STATES.includes(state)) throw new Error(`Laya reported an unknown state: ${String(state)}`);
    return { state };
  }
  // One approval before saved information reaches a website: getFields' values, or the answers
  // Laya picked from them. Without Always allow, or for another extension ID, it asks with Cancel,
  // Allow once, and Always allow; `sensitive` details always ask, with Cancel and Allow once.
  // `generation` is the access revision the information was read under. False when cancelled.
  async function approveRelease({ context, iowa, origin, generation, message, items, sensitive = null }) {
    if (autofillWithoutAsking && extensionId === context.extensionId && !sensitive) return true;
    if (fieldRequestPending) throw publicError('Another field request is waiting for your approval.');
    fieldRequestPending = true;
    try {
      mainWindow.show(); mainWindow.focus();
      const answer = await dialog.showMessageBox(mainWindow, sensitive ? {
        type: 'warning', title: 'Share sensitive details?', message: sensitive.message, detail: sensitive.detail,
        buttons: ['Cancel', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true
      } : {
        type: 'question', title: 'Let Chrome fill this form?', message,
        detail: `Website: ${iowa ? PORTAL_URL : origin}\n\n${items}\n\nChoose “Always allow” to let the SecondHand extension fill without asking whenever this app is unlocked. You can turn it off on the Chrome extension page. The website may save entered information. Review every answer before continuing.${iowa ? "\n\nOn the verified initial applicant page, SecondHand may click ordinary Save and Continue after checking completeness. On the supported home-address confirmation page, it will automatically select Iowa's first possible home-address suggestion and choose Save and Continue. This applies to home-address suggestions only. These actions send entered answers to Iowa, which may save them immediately. Review the chosen home address before final submission. Other question pages require manual Next. This approval does not authorize consent, signatures, or submitting your application." : ''}`,
        buttons: ['Cancel', 'Allow once', 'Always allow on this computer'], defaultId: 1, cancelId: 0, noLink: true
      });
      if (answer.response !== 1 && answer.response !== 2) return false;
      requireUnlocked();
      if (generation !== accessRevision || extensionId !== context.extensionId) throw publicError('SecondHand access changed. Click Autofill again.');
      if (answer.response === 2 && !sensitive) {
        autofillWithoutAsking = true;
        const approvedRevision = ++accessRevision;
        await saveSettings();
        requireUnlocked();
        if (approvedRevision !== accessRevision || extensionId !== context.extensionId) throw publicError('SecondHand access changed. Click Autofill again.');
      }
      return true;
    } finally { fieldRequestPending = false; }
  }
  // warmLaya: when an Autofill click starts on a page with open questions, the model's first load
  // after idle (process start, checksum, load: seconds) happens here, not in the click's Laya
  // budget. Answers with Laya's state; a model that fails to load reports as an error.
  async function warmLaya() {
    if ((await extensionLayaState()).state === 'ready') {
      try { await laya.warm(); } catch (error) { if (error.code !== 'LAYA_NOT_READY') throw error; }
    }
    return extensionLayaState();
  }
  // suggestFields and answerFields: question labels and options in, a saved-field key or an
  // option's text out, within the time the click has left. The facts sheet never leaves this app.
  // Matching needs no approval: its keys' values come through getFields, which asks.
  async function layaRequest(request, context) {
    if ((await extensionLayaState()).state !== 'ready') throw layaNotReady();
    const iowa = isPortalUrl(request.url);
    const origin = siteOrigin(request.url);
    if (!iowa && !siteAllowed(origin)) throw publicError('This site isn’t trusted. Turn on SecondHand for it first.');
    requireUnlocked();
    try {
      if (request.type === 'suggestFields') {
        const suggestions = await fieldSuggestions.suggest(request.fields, { budgetMs: request.budgetMs });
        touch();
        return { suggestions };
      }
      const generation = accessRevision;
      const now = today();
      const profile = vault.getData().profile;
      const { answers, sensitive, sensitiveFields } = await fieldAnswers.answer({ questions: request.questions, profile, budgetMs: request.budgetMs, today: now });
      requireUnlocked();
      if (generation !== accessRevision) throw publicError('SecondHand access changed. Click Autofill again.');
      const chosen = request.questions.filter(question => Object.hasOwn(answers, question.id));
      // Laya had no age from a saved birth date it can't use; the questions it left say why (#135).
      const reason = chosen.length < request.questions.length && household.hasUnusableBirthDate(profile, { today: now }) ? { reason: 'birthDate' } : {};
      if (!chosen.length) return { answers: {}, accessRevision, ...reason };
      // Answers are profile information: they follow getFields' approval, each question listed
      // with the option that would be filled. Iowa's portal keeps its rule of no sensitive prompt.
      const lines = list => list.map(question => `“${question.label}”: ${answers[question.id]}`).join('\n');
      const these = list => list.length === 1 ? 'this answer' : 'these answers';
      const approve = (list, sensitivePrompt = null) => approveRelease({ context, iowa, origin, generation,
        message: `Fill ${these(list)} into ${iowa ? 'Iowa’s application' : origin}?`,
        items: `Laya, SecondHand’s AI on this computer, picked ${these(list)} from your saved information:\n${lines(list)}`, sensitive: sensitivePrompt });
      const count = chosen.length;
      // Laya reads every sensitive fact at once, so the prompt names them all and says how many
      // answers needed them; which fact decided an answer is not known.
      const needed = sensitive.length;
      const which = needed === count ? these(chosen) : `${needed} of these answers`;
      const uses = needed === count ? (count === 1 ? 'It uses' : 'They use') : `${needed} of them ${needed === 1 ? 'uses' : 'use'}`;
      const asksSensitive = !iowa && needed > 0;
      const approved = await approve(chosen, asksSensitive ? { message: `Fill ${count === 1 ? 'this answer' : `these ${count} answers`} on ${origin}? ${uses} sensitive details.`,
        detail: `${sensitiveFields.map(fieldLabel).join(', ')}\n\nLaya, SecondHand’s AI on this computer, read these saved details to pick ${which}. The details stay on this computer. Only allow this if you meant to give these answers to ${origin}:\n${lines(chosen)}` } : null);
      touch();
      if (approved) return { answers, accessRevision, ...reason };
      // Cancel on "Share sensitive details?" drops only the answers that needed sensitive details (#42).
      // The others follow their own rule: no prompt with Always allow, else "Let Chrome fill this form?".
      const everyday = asksSensitive ? chosen.filter(question => !sensitive.includes(question.id)) : [];
      if (!everyday.length) return { answers: {}, accessRevision, ...reason };
      requireUnlocked();
      if (generation !== accessRevision) throw publicError('SecondHand access changed. Click Autofill again.');
      const kept = await approve(everyday);
      touch();
      return { answers: kept ? Object.fromEntries(everyday.map(question => [question.id, answers[question.id]])) : {}, accessRevision, ...reason };
    } catch (error) {
      if (error.publicMessage) throw error;
      if (error.code === 'LAYA_NOT_READY') throw layaNotReady();
      throw Object.assign(publicError('Laya couldn’t check this form. Fill the remaining questions yourself.'), { cause: error });
    }
  }
  // The extension this app ships, for the extension's own update (#85): its build, and whether the
  // copy prepared for Chrome has it ('ready'), couldn't be refreshed ('failed'), or doesn't exist
  // ('absent'). A copy from another build is refreshed from the app's own bundle only, never from
  // anything in a request. A failed refresh isn't tried again by itself: the extension shows the
  // steps, and the Chrome extension page's refresh tries again.
  let copyRefresh = null;
  let copyFailed = false;
  function refreshCopy() {
    copyRefresh ||= prepareBundledExtension(app)
      .then(setup => { copyFailed = false; return setup; }, error => { copyFailed = true; throw error; })
      .finally(() => { copyRefresh = null; });
    return copyRefresh;
  }
  async function shippedExtension() {
    // A refresh under way finishes first; its own caller reports how it went.
    if (copyRefresh) await Promise.allSettled([copyRefresh]);
    const setup = await getExtensionSetup(app);
    if (setup.prepared) return { build: setup.build, copy: 'ready' };
    if (!setup.exists) return { build: setup.build, copy: 'absent' };
    if (copyFailed) return { build: setup.build, copy: 'failed' };
    try { await refreshCopy(); }
    catch { return { build: setup.build, copy: 'failed' }; }
    return { build: setup.build, copy: 'ready' };
  }
  async function bridgeRequest(request, context) {
    if (request.type === 'status') return { unlocked: vault.unlocked, applicationCount: vault.unlocked ? vault.getData().applications.length : 0, accessRevision, allSites,
      laya: await extensionLayaState(), extension: await shippedExtension(), touchId: await touchIdUnlock.state() };
    // The side panel's Unlock: this app's Touch ID prompt, which macOS shows over Chrome. Only whether
    // it unlocked, or why not, goes back; the window hears of an unlock to show the saved information.
    if (request.type === 'unlockWithTouchId') {
      const result = await touchIdUnlock.unlock();
      if (!result.unlocked) return { unlocked: false, reason: result.reason };
      touch();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('secondhand:unlocked', { lockRevision });
      return { unlocked: true };
    }
    // On Windows the native relay passes openApp on as it is; the app is running, so it comes forward.
    if (request.type === 'showApp' || request.type === 'openApp') {
      if (mainWindow) { if (mainWindow.isMinimized?.()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
      return request.type === 'showApp' ? { shown: true } : { opened: 'shown' };
    }
    if (request.type === 'warmLaya') return warmLaya();
    if (request.type === 'suggestFields' || request.type === 'answerFields') return layaRequest(request, context);
    // Turning a site, or all websites, off only ever takes access away, so it needs no unlock or approval.
    if (request.type === 'untrustAllSites') { await turnOffAllSites(); return { allSites: false }; }
    if (request.type === 'untrustSite') {
      const origin = siteOrigin(request.url);
      if (trustedSites.includes(origin)) {
        accessRevision++;
        trustedSites = trustedSites.filter(site => site !== origin);
        await saveSettings();
      }
      return { trusted: false, origin };
    }
    requireUnlocked();
    if (request.type === 'trustSite') {
      const origin = siteOrigin(request.url);
      if (origin && hostTooLong(origin)) throw publicError('This site’s address is too long for SecondHand to trust.');
      if (fieldRequestPending) throw publicError('Another request is waiting for your approval.');
      fieldRequestPending = true;
      const generation = accessRevision;
      try {
        mainWindow.show(); mainWindow.focus();
        const answer = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: 'Trust this site?', message: `Let SecondHand fill forms on ${origin}?`,
          detail: `When you click Autofill on this site, SecondHand fills the saved answers it can match. It never clicks Next or Submit. ${SITE_RULES}. You can remove this site on the Chrome extension page.`,
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
    if (request.type === 'trustAllSites') {
      if (fieldRequestPending) throw publicError('Another request is waiting for your approval.');
      fieldRequestPending = true;
      const generation = accessRevision;
      try {
        mainWindow.show(); mainWindow.focus();
        const answer = await dialog.showMessageBox(mainWindow, {
          type: 'question', title: 'Trust all websites?', message: 'Let SecondHand fill forms on any website?',
          detail: `Nothing is filled until you click Autofill on a website. Then SecondHand fills the saved answers it can match there. It never clicks Next or Submit. ${SITE_RULES}, on each site. You can turn this off in SecondHand’s side panel in Chrome or on the Chrome extension page.`,
          buttons: ['Cancel', 'Trust all websites'], defaultId: 1, cancelId: 0, noLink: true
        });
        if (answer.response !== 1) throw publicError('You cancelled trusting all websites.');
        requireUnlocked();
        if (generation !== accessRevision || extensionId !== context.extensionId) throw publicError('SecondHand access changed. Try again.');
        allSites = true;
        const approvedRevision = ++accessRevision;
        await saveSettings();
        requireUnlocked();
        if (approvedRevision !== accessRevision || extensionId !== context.extensionId) throw publicError('SecondHand access changed. Try again.');
        touch();
        return { allSites: true };
      } finally { fieldRequestPending = false; }
    }
    if (request.type === 'getFields') {
      const iowa = isPortalUrl(request.url);
      const navigationOnly = isIowaNavigationAuthorization(request);
      if (!request.fields.length && !navigationOnly) throw publicError('This page does not support navigation authorization.');
      const origin = siteOrigin(request.url);
      if (!iowa && !siteAllowed(origin)) throw publicError('This site isn’t trusted. Turn on SecondHand for it first.');
      if (!request.fields.every(isRequestField)) throw publicError('This page asked for something SecondHand doesn’t share.');
      const byAge = !iowa && request.fields.some(field => AGE_COUNT_FIELDS.includes(field)) && household.listed(vault.getData().profile);
      const sensitive = iowa ? [] : request.fields.filter(field => SENSITIVE_FIELDS.includes(field) || household.isBandKey(field) || (byAge && AGE_COUNT_FIELDS.includes(field)));
      const approved = await approveRelease({ context, iowa, origin, generation: accessRevision,
        message: navigationOnly ? 'Continue this verified Iowa step?' : `Fill these saved answers into ${iowa ? 'Iowa’s application' : origin}?`,
        items: navigationOnly ? 'No saved profile fields will be read for this step.' : request.fields.map(fieldLabel).join(', '),
        sensitive: sensitive.length ? { message: `Fill sensitive details on ${origin}?`,
          detail: `${sensitive.map(fieldLabel).join(', ')}\n\nOnly allow this if you meant to give these details to ${origin}. Other fields: ${request.fields.filter(field => !sensitive.includes(field)).map(fieldLabel).join(', ') || 'none'}.` } : null });
      if (!approved) throw publicError('You cancelled this field request.');
      if (navigationOnly) { touch(); return { values: {}, accessRevision }; }
      const profile = vault.getData().profile;
      const now = today();
      const values = {};
      for (const field of request.fields) {
        const value = releasedValue(profile, field, { today: now });
        if (typeof value === 'string' && value.trim()) values[field] = value;
      }
      // An answer left out because a saved birth date can't be used stays with the applicant, who is told why (#135).
      const blocked = request.fields.some(field => !Object.hasOwn(values, field) && blockedByBirthDate(profile, field, { today: now }));
      touch();
      return { values, accessRevision, ...(blocked ? { reason: 'birthDate' } : {}) };
    }
    if (request.type === 'saveFields') return saveAnswers(request, context);
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

  // saveFields (Save to My information): answers the applicant gave on a page for questions SecondHand
  // couldn't fill, saved after one confirmation that names each field and value. Only blank fields are
  // filled in: a saved answer, or a household count the household list sets, is never replaced from a page.
  const shown = (field, value) => YES_NO_FIELDS.includes(field) ? (value === 'yes' ? 'Yes' : 'No') : value;
  const listing = items => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  async function saveAnswers(request, context) {
    const iowa = isPortalUrl(request.url);
    const origin = siteOrigin(request.url);
    if (!iowa && !siteAllowed(origin)) throw publicError('This site isn’t trusted. Turn on SecondHand for it first.');
    const fields = Object.keys(request.fields);
    const answers = Object.fromEntries(fields.map(field => [field, request.fields[field].trim()]));
    const current = vault.getData().profile;
    if (household.listed(current) && fields.some(field => Object.hasOwn(HOUSEHOLD_COUNT_FIELDS, field))) {
      throw publicError('Your household list sets the household counts. Update the list in My information.');
    }
    const saved = fields.filter(field => typeof current[field] === 'string' && current[field].trim());
    if (saved.length) throw publicError(`${listing(saved.map(fieldLabel))} ${saved.length === 1 ? 'is' : 'are'} already saved in My information. Change ${saved.length === 1 ? 'it' : 'them'} there.`);
    // A plain record of the profile with the answers filled in, checked as My information checks it.
    const filledIn = profile => Object.assign(Object.create(null), profile, answers);
    const now = today();
    // A birth date already saved that today's checks refuse is fixed in My information first (#135): the side panel names whose.
    const stored = savedBirthDateRefusal(current, { today: now });
    if (stored) throw publicError(`${stored} Fix the date in My information, then save this answer again.`);
    const clean = validated(validateProfile, filledIn(current), { today: now });
    if (fieldRequestPending) throw publicError('Another request is waiting for your approval.');
    fieldRequestPending = true;
    const generation = accessRevision;
    try {
      mainWindow.show(); mainWindow.focus();
      const sensitive = fields.filter(field => SENSITIVE_FIELDS.includes(field));
      const one = fields.length === 1;
      const answer = await dialog.showMessageBox(mainWindow, {
        type: sensitive.length ? 'warning' : 'question', title: sensitive.length ? 'Save sensitive details to My information?' : 'Save to My information?',
        message: `Save ${one ? 'this answer' : 'these answers'} from ${iowa ? 'Iowa’s application' : origin} to My information?`,
        detail: `${fields.map(field => `${fieldLabel(field)}: ${shown(field, clean[field])}`).join('\n')}\n\n` +
          `${sensitive.length ? `${listing(sensitive.map(fieldLabel))} ${sensitive.length === 1 ? 'is' : 'are'} sensitive. ` : ''}` +
          `SecondHand keeps ${one ? 'it' : 'them'} on this computer and can fill ${one ? 'it' : 'them'} the next time a form asks. Save only answers about you and your household.`,
        buttons: ['Cancel', 'Save'], defaultId: sensitive.length ? 0 : 1, cancelId: 0, noLink: true
      });
      if (answer.response !== 1) throw publicError('You cancelled saving to My information.');
      requireUnlocked();
      if (generation !== accessRevision || extensionId !== context.extensionId) throw publicError('SecondHand access changed. Try again.');
      accessRevision++;
      await vault.update(data => { data.profile = validateProfile(filledIn(data.profile), { today: now }); });
      accessRevision++;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('secondhand:profile-changed', { fields });
      touch();
      return { saved: fields };
    } finally { fieldRequestPending = false; }
  }

  const setupPath = path.join(userData, 'setup-progress.json');
  async function readSetup() {
    let text;
    try { text = await fs.readFile(setupPath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw publicError('SecondHand couldn’t read your setup progress.'); }
    let progress;
    try { progress = JSON.parse(text); } catch { progress = null; }
    if (progress?.version !== 1 || !Number.isInteger(progress.step) || progress.step < 0 || progress.step >= SETUP_STEPS) throw publicError('SecondHand couldn’t read your setup progress.');
    return progress.step;
  }
  async function writeSetup(step) {
    if (step >= SETUP_STEPS) { await fs.rm(setupPath, { force: true }); return null; }
    await atomicWrite(setupPath, Buffer.from(JSON.stringify({ version: 1, step })));
    return { step, steps: SETUP_STEPS };
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
      // A Touch ID key left from earlier information can't open this one.
      await touchIdUnlock.forget();
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
      await touchIdUnlock.passwordUnlocked();
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
      // A reset keeps the data key, so Touch ID stays on.
      touch(); return status();
    },
    // For someone who has lost both their password and recovery key: erase the
    // saved information and the reset secret so a new password can be created.
    // Chrome extension settings stay. The person must type the phrase.
    async startOver(request) {
      if (vault.unlocked) throw publicError('Lock SecondHand before starting over.');
      if (typeof request?.confirmation !== 'string' || request.confirmation.trim().toLowerCase() !== 'start over') throw publicError('Type “start over” to confirm.');
      accessRevision++;
      try {
        await vault.erase();
        await fs.rm(deviceSecretPath, { force: true });
        await touchIdUnlock.removeSealed();
      } catch { throw publicError('Could not erase your saved information. Please try again.'); }
      finally { accessRevision++; }
      return status();
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
    // { enabled: true, password } turns Touch ID on; { enabled: false } turns it off.
    async setTouchIdUnlock(request) {
      requireUnlocked();
      if (typeof request?.enabled !== 'boolean') throw publicError('Invalid setting.');
      if (request.enabled) await touchIdUnlock.turnOn(request.password); else await touchIdUnlock.turnOff();
      touch(); return status();
    },
    async unlockWithTouchId() {
      const result = await touchIdUnlock.unlock();
      if (!result.unlocked) throw publicError(result.message);
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
    async readDocument(requestId) {
      requireUnlocked();
      touch();
      const result = await documentReader.read(requestId);
      if (vault.unlocked) touch();
      return result;
    },
    cancelDocumentRead: requestId => documentReader.cancel(documentRequestId(requestId)),
    async reviewFields(request) {
      requireUnlocked();
      const revision = accessRevision;
      const sequence = ++fieldReviewRevision;
      const isCurrent = () => vault.unlocked && !quitting && revision === accessRevision && sequence === fieldReviewRevision;
      touch();
      const result = await fieldReview.review(request, { today: today(), isCurrent });
      if (!isCurrent()) throw publicError('Your information changed during review. Check it again.');
      touch();
      return result;
    },
    // Cancels only this desktop review. Other local model callers keep their own work.
    cancelFieldReview() { fieldReviewRevision++; return true; },
    async saveProfile(profile) {
      requireUnlocked();
      const clean = validated(validateProfile, profile, { today: today() });
      accessRevision++;
      await vault.update(data => { data.profile = clean; });
      accessRevision++;
      touch(); return clean;
    },
    // The guided first-run setup: how many of its six steps are done, or null when none is under way.
    async setupProgress() {
      requireUnlocked();
      const step = await readSetup();
      touch(); return step === null ? null : { step, steps: SETUP_STEPS };
    },
    async startSetup() {
      requireUnlocked();
      const progress = await writeSetup(0);
      touch(); return progress;
    },
    // Steps done never go down; all six done finishes the setup.
    async saveSetupProgress(step) {
      requireUnlocked();
      if (!Number.isInteger(step) || step < 0 || step > SETUP_STEPS) throw publicError('Invalid setup step.');
      const done = await readSetup();
      if (done === null) throw publicError('The guided setup isn’t under way.');
      const progress = await writeSetup(Math.max(done, step));
      touch(); return progress;
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
    async turnOffAllSites() {
      requireUnlocked();
      await turnOffAllSites();
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
    layaStatus,
    async setLayaEnabled(enabled) {
      requireUnlocked();
      if (typeof enabled !== 'boolean') throw publicError('Invalid setting.');
      const current = await laya.status();
      if (enabled && current.state === 'unavailable') throw publicError(current.message);
      layaEnabled = enabled;
      await laya.setEnabled(enabled);
      await saveSettings();
      // One click: turning Laya on checks for its newest model and downloads it. Progress and
      // failures show in its status.
      if (enabled) laya.update();
      touch(); return layaStatus();
    },
    async downloadLaya() {
      requireUnlocked();
      try { laya.startDownload(); } catch (error) { throw publicError(error.message); }
      touch(); return layaStatus();
    },
    async cancelLayaDownload() { requireUnlocked(); await laya.cancelDownload(); touch(); return layaStatus(); },
    // Removing the model also turns Laya off, so it isn't downloaded again at the next start.
    async removeLaya() {
      requireUnlocked();
      layaEnabled = false;
      await laya.remove();
      await saveSettings();
      touch(); return layaStatus();
    },
    async openPortal() { await shell.openExternal(PORTAL_URL); return true; },
    async openExtensionGuide() { await shell.openExternal(extensionGuideUrl()); return true; },
    async prepareExtension() {
      if (extensionSetupPending) throw publicError('Extension setup is already running.');
      extensionSetupPending = true;
      try {
        const setup = await refreshCopy();
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
      // A restored backup opens with its own password first. Touch ID's key goes before the file is
      // replaced, and the access revision moves on, so a Touch ID prompt that is already up can't open it.
      try { await touchIdUnlock.removeSealed(); }
      catch (error) { throw publicError(`Touch ID’s key on this Mac couldn’t be removed (${error.code || error.message}), so the backup wasn’t restored. Please try again.`); }
      accessRevision++;
      await vault.importEncrypted(bytes);
      // Setup progress belonged to the information just replaced.
      await fs.rm(setupPath, { force: true });
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
    await loadSettings();
    await laya.setEnabled(layaEnabled !== false);
    // Downloads the model if it's missing, then checks for a newer one now and every 24 hours.
    // It needs no unlock: it touches no saved information. It does nothing while Laya is off.
    laya.startUpdates();
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
    documentReader.cancel();
    Promise.allSettled([vault.lock(), bridge?.close(), laya.close()]).then(() => app.quit());
  });
}
