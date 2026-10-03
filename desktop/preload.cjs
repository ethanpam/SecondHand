'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, ...args) => ipcRenderer.invoke('secondhand:invoke', method, ...args);

contextBridge.exposeInMainWorld('secondHand', Object.freeze({
  status: () => invoke('status'),
  createVault: request => invoke('createVault', request),
  unlock: passphrase => invoke('unlock', passphrase),
  resetPassword: request => invoke('resetPassword', request),
  startOver: request => invoke('startOver', request),
  replaceRecoveryKey: () => invoke('replaceRecoveryKey'),
  setDeviceReset: enabled => invoke('setDeviceReset', enabled),
  saveRecoveryKey: recoveryKey => invoke('saveRecoveryKey', recoveryKey),
  copyRecoveryKey: recoveryKey => invoke('copyRecoveryKey', recoveryKey),
  lock: () => invoke('lock'),
  getData: () => invoke('getData'),
  readDocument: requestId => invoke('readDocument', requestId),
  cancelDocumentRead: requestId => invoke('cancelDocumentRead', requestId),
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
