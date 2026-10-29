'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = name => (...args) => ipcRenderer.invoke('key-tool:admin-' + name, ...args);
contextBridge.exposeInMainWorld('groupAdmin', {
  state: call('state'), refresh: call('refresh'), save: call('save-groups'),
  authState: call('auth-state'), login: call('login'), completeLogin: call('complete-login'),
  recoverAuthorization: call('recover-authorization'),
  registrationRecords: call('registration-records'), registrationReview: call('registration-review'),
  records: call('records'), record: call('record'), secret: call('secret'), copySecret: call('copy-secret'),
  feishuState: call('feishu-state'), feishuConnect: call('feishu-connect'), feishuDisconnect: call('feishu-disconnect'),
  feishuSaveCredentials: call('feishu-save-credentials'),
  feishuStartOwnerBinding: call('feishu-start-owner-binding'), feishuConfirmOwner: call('feishu-confirm-owner'),
  feishuStartGroupBinding: call('feishu-start-group-binding'), feishuConfirmGroup: call('feishu-confirm-group'),
  feishuSavePolicy: call('feishu-save-policy'), feishuOnState: callback => { const listener = (_event, state) => callback(state);
    ipcRenderer.on('key-tool:feishu-state', listener); return () => ipcRenderer.removeListener('key-tool:feishu-state', listener); },
  onRecordsChanged: callback => { const listener = () => callback(); ipcRenderer.on('key-tool:admin-records-changed', listener);
    return () => ipcRenderer.removeListener('key-tool:admin-records-changed', listener); },
  onAuth: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('key-tool:admin-auth', listener);
    return () => ipcRenderer.removeListener('key-tool:admin-auth', listener); },
  onAuthError: callback => { const listener = (_event, message) => callback(message); ipcRenderer.on('key-tool:admin-auth-error', listener);
    return () => ipcRenderer.removeListener('key-tool:admin-auth-error', listener); },
  onLoginComplete: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('key-tool:admin-login-complete', listener);
    return () => ipcRenderer.removeListener('key-tool:admin-login-complete', listener); }
});
