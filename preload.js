'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ct', {
  state: () => ipcRenderer.invoke('ct:state'),
  send: (id, text) => ipcRenderer.invoke('ct:send', { id, text }),
  stop: id => ipcRenderer.invoke('ct:stop', { id }),
  mode: mode => ipcRenderer.invoke('ct:mode', { mode }),
  demo: on => ipcRenderer.invoke('ct:demo', { on }),
  clearAll: () => ipcRenderer.invoke('ct:clearall'),
  workspace: () => ipcRenderer.invoke('ct:workspace'),
  settings: () => ipcRenderer.invoke('ct:settings'),
  info: () => ipcRenderer.invoke('ct:info'),
  on: fn => ipcRenderer.on('ct', (e, msg) => fn(msg)),
});
