'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, ...args) => ipcRenderer.invoke('secondhand:invoke', method, ...args);

contextBridge.exposeInMainWorld('secondHand', Object.freeze({
  status: () => invoke('status'),
  createVault: passphrase => invoke('createVault', passphrase),
  unlock: passphrase => invoke('unlock', passphrase),
  lock: () => invoke('lock'),
  getData: () => invoke('getData'),
  saveProfile: profile => invoke('saveProfile', profile),
  saveApplication: application => invoke('saveApplication', application),
  deleteApplication: id => invoke('deleteApplication', id),
  openPortal: () => invoke('openPortal'),
  connectExtension: extensionId => invoke('connectExtension', extensionId),
  exportBackup: () => invoke('exportBackup'),
  importBackup: () => invoke('importBackup'),
  onLocked: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = () => callback();
    ipcRenderer.on('secondhand:locked', listener);
    return () => ipcRenderer.removeListener('secondhand:locked', listener);
  }
}));
