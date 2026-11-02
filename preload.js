'use strict';
// The widget's only bridge to the main process: a few fire-and-forget
// messages and one state listener. No Node APIs are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usage', Object.freeze({
  onState: (fn) => {
    ipcRenderer.removeAllListeners('state');
    ipcRenderer.on('state', (_e, s) => fn(s));
  },
  resize: (h) => ipcRenderer.send('widget:resize', Number(h) || 0),
  refresh: () => ipcRenderer.send('widget:refresh'),
  hide: () => ipcRenderer.send('widget:hide'),
  signIn: () => ipcRenderer.send('widget:signin'),
  menu: () => ipcRenderer.send('widget:menu'),
}));
