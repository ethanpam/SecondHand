'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, ...args) => ipcRenderer.invoke('secondhand:invoke', method, ...args);

contextBridge.exposeInMainWorld('secondHand', Object.freeze({
  status: () => invoke('status'),
  createVault: request => invoke('createVault', request),
  unlock: passphrase => invoke('unlock', passphrase),
  resetPassword: request => invoke('resetPassword', request),
  replaceRecoveryKey: () => invoke('replaceRecoveryKey'),
  setDeviceReset: enabled => invoke('setDeviceReset', enabled),
  saveRecoveryKey: recoveryKey => invoke('saveRecoveryKey', recoveryKey),
  copyRecoveryKey: recoveryKey => invoke('copyRecoveryKey', recoveryKey),
  lock: () => invoke('lock'),
  getData: () => invoke('getData'),
  saveProfile: profile => invoke('saveProfile', profile),
  saveApplication: application => invoke('saveApplication', application),
  deleteApplication: id => invoke('deleteApplication', id),
  openPortal: () => invoke('openPortal'),
  prepareExtension: () => invoke('prepareExtension'),
  openExtensionFolder: () => invoke('openExtensionFolder'),
  copyExtensionFolderPath: () => invoke('copyExtensionFolderPath'),
  copyChromeExtensionsUrl: () => invoke('copyChromeExtensionsUrl'),
  connectExtension: extensionId => invoke('connectExtension', extensionId),
  setAutofillTrust: enabled => invoke('setAutofillTrust', enabled),
  removeTrustedSite: origin => invoke('removeTrustedSite', origin),
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
