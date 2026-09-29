'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const channel = 'secondhand:ocr-worker';
let listening = false;
contextBridge.exposeInMainWorld('localDocumentWorker', Object.freeze({
  start: callback => {
    if (listening || typeof callback !== 'function') throw new Error('Invalid document worker initialization.');
    listening = true;
    ipcRenderer.once(channel, (_event, input) => callback(input));
    ipcRenderer.send(channel, 'ready');
  },
  progress: value => ipcRenderer.send(channel, 'progress', value),
  complete: value => ipcRenderer.send(channel, 'complete', value),
  fail: code => ipcRenderer.send(channel, 'error', typeof code === 'string' ? code : 'READ_FAILED')
}));
