'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = name => (...args) => ipcRenderer.invoke('key-tool:' + name, ...args);
contextBridge.exposeInMainWorld('keyTool', {
  state: call('state'), refresh: call('refresh'), create: call('create'),
  reconcile: call('reconcile'), acknowledge: call('acknowledge'), copy: call('copy'),
  onState: fn => ipcRenderer.on('key-tool:state', (_e, state) => fn(state)),
  onNotice: fn => ipcRenderer.on('key-tool:notice', (_e, message) => fn(message))
});
