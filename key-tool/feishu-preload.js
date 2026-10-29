'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('feishuConnection', {
  state: () => ipcRenderer.invoke('feishu-connection:state'),
  save: input => ipcRenderer.invoke('feishu-connection:save', input),
  connect: () => ipcRenderer.invoke('feishu-connection:connect'),
  disconnect: () => ipcRenderer.invoke('feishu-connection:disconnect')
});
