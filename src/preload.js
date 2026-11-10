'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('edge', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getLastStats: () => ipcRenderer.invoke('stats:last'),
  runAction: (action) => ipcRenderer.invoke('action:run', action),
  getAppIcon: (filePath) => ipcRenderer.invoke('icon:get', filePath),
  openConfig: () => ipcRenderer.invoke('config:open'),
  onStats: (cb) => subscribe('stats:update', cb),
  onConfig: (cb) => subscribe('config:changed', cb),
  onToast: (cb) => subscribe('toast', cb),
  isElectron: true,
});
