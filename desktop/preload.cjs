'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, ...args) => ipcRenderer.invoke('secondhand:invoke', method, ...args);

contextBridge.exposeInMainWorld('secondHand', Object.freeze({
  status: () => invoke('status'),
  setLibraryMode: enabled => invoke('setLibraryMode', enabled),
  onLibraryReset: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback();
    ipcRenderer.on('secondhand:library-reset', listener);
    return () => ipcRenderer.removeListener('secondhand:library-reset', listener);
  },
  createVault: request => invoke('createVault', request),
  unlock: passphrase => invoke('unlock', passphrase),
  resetPassword: request => invoke('resetPassword', request),
  startOver: request => invoke('startOver', request),
  replaceRecoveryKey: () => invoke('replaceRecoveryKey'),
  setDeviceReset: enabled => invoke('setDeviceReset', enabled),
  setTouchIdUnlock: request => invoke('setTouchIdUnlock', request),
  unlockWithTouchId: () => invoke('unlockWithTouchId'),
  // SecondHand was unlocked from Chrome's side panel with Touch ID. Only the lock revision it
  // happened at is passed on, as for onLocked.
  onUnlocked: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = (_event, notification) => {
      if (Number.isSafeInteger(notification?.lockRevision) && notification.lockRevision >= 0) callback({ lockRevision: notification.lockRevision });
    };
    ipcRenderer.on('secondhand:unlocked', listener);
    return () => ipcRenderer.removeListener('secondhand:unlocked', listener);
  },
  saveRecoveryKey: recoveryKey => invoke('saveRecoveryKey', recoveryKey),
  copyRecoveryKey: recoveryKey => invoke('copyRecoveryKey', recoveryKey),
  lock: () => invoke('lock'),
  getData: () => invoke('getData'),
  readDocument: requestId => invoke('readDocument', requestId),
  cancelDocumentRead: requestId => invoke('cancelDocumentRead', requestId),
  reviewFields: request => invoke('reviewFields', request),
  cancelFieldReview: () => invoke('cancelFieldReview'),
  onDocumentProgress: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = (_event, value) => {
      if (typeof value?.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId) ||
          !['loading', 'rendering', 'recognizing'].includes(value.phase) || !Number.isInteger(value.page) || !Number.isInteger(value.total) ||
          value.page < 0 || value.total < 0 || value.page > value.total || value.total > 12) return;
      callback({ requestId: value.requestId, phase: value.phase, page: value.page, total: value.total });
    };
    ipcRenderer.on('secondhand:document-progress', listener);
    return () => ipcRenderer.removeListener('secondhand:document-progress', listener);
  },
  saveProfile: profile => invoke('saveProfile', profile),
  // The guided first-run setup's progress: how many of its six steps are done.
  setupProgress: () => invoke('setupProgress'),
  startSetup: () => invoke('startSetup'),
  saveSetupProgress: step => invoke('saveSetupProgress', step),
  // Save to My information in Chrome changed these saved fields. Their names only, never their values.
  onProfileChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = (_event, change) => {
      const fields = change?.fields;
      if (!Array.isArray(fields) || !fields.length || fields.length > 40 || new Set(fields).size !== fields.length ||
          fields.some(field => typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,59}$/.test(field))) return;
      callback({ fields: [...fields] });
    };
    ipcRenderer.on('secondhand:profile-changed', listener);
    return () => ipcRenderer.removeListener('secondhand:profile-changed', listener);
  },
  // Add your household in Chrome's side panel (#180): open My information at Your household. The event carries nothing.
  onOpenHousehold: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback();
    ipcRenderer.on('secondhand:open-household', listener);
    return () => ipcRenderer.removeListener('secondhand:open-household', listener);
  },
  dismissHouseholdNote: () => invoke('dismissHouseholdNote'),
  saveApplication: application => invoke('saveApplication', application),
  deleteApplication: id => invoke('deleteApplication', id),
  openPortal: () => invoke('openPortal'),
  openExtensionGuide: () => invoke('openExtensionGuide'),
  prepareExtension: () => invoke('prepareExtension'),
  openExtensionFolder: () => invoke('openExtensionFolder'),
  copyExtensionFolderPath: () => invoke('copyExtensionFolderPath'),
  copyChromeExtensionsUrl: () => invoke('copyChromeExtensionsUrl'),
  connectExtension: extensionId => invoke('connectExtension', extensionId),
  setAutofillTrust: enabled => invoke('setAutofillTrust', enabled),
  removeTrustedSite: origin => invoke('removeTrustedSite', origin),
  // Always allow on a site is only ever taken back here; the sensitive prompt is the one place that adds it.
  removeAlwaysAllowedSite: origin => invoke('removeAlwaysAllowedSite', origin),
  turnOffAllSites: () => invoke('turnOffAllSites'),
  layaStatus: () => invoke('layaStatus'),
  setLayaEnabled: enabled => invoke('setLayaEnabled', enabled),
  downloadLaya: () => invoke('downloadLaya'),
  cancelLayaDownload: () => invoke('cancelLayaDownload'),
  removeLaya: () => invoke('removeLaya'),
  exportBackup: () => invoke('exportBackup'),
  importBackup: () => invoke('importBackup'),
  onLocked: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = (_event, notification) => {
      // Expose only the transition identifier, never Electron's event or
      // arbitrary payloads. Invalid/legacy notifications still lock the UI.
      callback(Number.isSafeInteger(notification?.lockRevision) && notification.lockRevision > 0
        ? { lockRevision: notification.lockRevision } : undefined);
    };
    ipcRenderer.on('secondhand:locked', listener);
    return () => ipcRenderer.removeListener('secondhand:locked', listener);
  }
}));
