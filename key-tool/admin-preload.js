'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = name => (...args) => ipcRenderer.invoke('key-tool:admin-' + name, ...args);
contextBridge.exposeInMainWorld('groupAdmin', {
  operationLog: call('operation-log'),
  recordTableSync: call('record-table-sync'),recordTableOpen:call('record-table-open'),
  channelMonitorState: call('channel-monitor-state'), channelMonitorRename: call('channel-monitor-rename'),
  channelMonitorOpen: call('channel-monitor-open'), channelMonitorCheck: call('channel-monitor-check'),
  channelAccessState: call('channel-access-state'), channelAccessSave: call('channel-access-save'),
  channelAccessRevoke: call('channel-access-revoke'), channelAccessUpdate: call('channel-access-update'),
  channelAccessPreview: call('channel-access-preview'),
  channelAlertState: call('channel-alert-state'), channelAlertSave: call('channel-alert-save'),
  channelAlertPause: call('channel-alert-pause'), channelAlertClear: call('channel-alert-clear'),
  channelAlertTest: call('channel-alert-test'),
  channelAlertOnState: callback => { const listener = (_event, state) => callback(state);
    ipcRenderer.on('key-tool:channel-alert-state', listener); return () => ipcRenderer.removeListener('key-tool:channel-alert-state', listener); },
  channelLoginState: call('channel-login-state'), channelLoginSave: call('channel-login-save'),
  channelLoginPause: call('channel-login-pause'), channelLoginClear: call('channel-login-clear'),
  channelMonitorOnState: callback => { const listener = (_event, state) => callback(state);
    ipcRenderer.on('key-tool:channel-monitor-state', listener); return () => ipcRenderer.removeListener('key-tool:channel-monitor-state', listener); },
  state: call('state'), refresh: call('refresh'), save: call('save-groups'),
  authState: call('auth-state'), login: call('login'), completeLogin: call('complete-login'),
  recoverAuthorization: call('recover-authorization'),
  registrationRecords: call('registration-records'), registrationReview: call('registration-review'),
  groupSettingsRefresh: call('group-settings-refresh'), groupSettingsSave: call('group-settings-save'),
  groupSettingsRecords: call('group-settings-records'), groupSettingsReview: call('group-settings-review'),
  userOwnershipList: call('user-ownership-list'), userOwnershipSave: call('user-ownership-save'),
  userOwnershipSaveName: call('user-ownership-save-name'),
  userOwnershipLink: call('user-ownership-link'),
  userOwnershipDraftState: call('user-ownership-draft-state'), userOwnershipDraftSave: call('user-ownership-draft-save'),
  dailyUsageState: call('daily-usage-state'), dailyUsagePreview: call('daily-usage-preview'),
  dailyUsageEnable: call('daily-usage-enable'), dailyUsagePause: call('daily-usage-pause'),
  dailyUsageReviewAbsent: call('daily-usage-review-absent'),
  dailyUsageNow: call('daily-usage-now'),
  dailyUsageHistoryCatalog: call('daily-usage-history-catalog'),
  dailyUsageHistoryWeek: call('daily-usage-history-week'),
  dailyUsageHistoryExport: call('daily-usage-history-export'),
  dailyUsageBackfillStatus: call('daily-usage-backfill-status'),
  dailyUsageBackfillCurrentMonth: call('daily-usage-backfill-current-month'),
  accountScheduleSnapshot: call('account-schedule-snapshot'), accountScheduleState: call('account-schedule-state'),
  accountScheduleCreate: call('account-schedule-create'), accountScheduleCancel: call('account-schedule-cancel'),
  accountScheduleReconcile: call('account-schedule-reconcile'),
  accountScheduleOnState: callback => { const listener = (_event, state) => callback(state);
    ipcRenderer.on('key-tool:account-schedule-state', listener); return () => ipcRenderer.removeListener('key-tool:account-schedule-state', listener); },
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
