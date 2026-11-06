'use strict';
const { app, BrowserWindow, ipcMain, session, safeStorage, clipboard, dialog, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { KeyService, ToolError } = require('./service');
const { makeDiskStore } = require('./disk-store');
const { UserRegistrationService, assertRegistrationBody } = require('./user-registration-service');
const { GroupSettingsService, groupRequest } = require('./group-settings-service');
const { UserOwnership, makeOwnershipStore } = require('./user-ownership');
const { makeOwnershipQueryAudit } = require('./ownership-query-audit');
const { makeOwnershipDraftStore } = require('./ownership-draft');
const { DailyUsage } = require('./daily-usage');
const { makeDailyUsageStore } = require('./daily-usage-store');
const { DailyUsagePublisher } = require('./daily-usage-publisher');
const { AccountSchedule, makeAccountScheduleStore } = require('./account-schedule');
const { makeCatalogStore } = require('./group-catalog');
const { makeSessionStore } = require('./session-store');
const { AdminSession } = require('./auth-session');
const { makeFeishuStore, validateCredentials } = require('./feishu-store');
const { makeFeishuPolicyStore, emptyPolicy, validatePolicy } = require('./feishu-policy-store');
const { FeishuConnection } = require('./feishu-connection');
const { FeishuReconnect } = require('./feishu-reconnect');
const { createClient: createFeishuClient } = require('./feishu-sdk');
const { FeishuBotWorkflow } = require('./feishu-bot-workflow');
const { makeConnectionLease } = require('./feishu-connection-lease');
const { makeFailureLog } = require('./create-diagnostics');
const { makeAdminOperationLog } = require('./admin-operation-log');
const { FeishuMemberNames } = require('./feishu-member-names');
const { makeRecordTable } = require('./record-table');
const { classifyPlatformError, readPlatformError } = require('./platform-error');
const { CHANNELS, makeNameStore, safeName } = require('./channel-monitor');
const { createChannelHost } = require('./channel-monitor-host');
const { ChannelMonitorController } = require('./channel-monitor-controller');
const { ChannelAlert, makeAlertStore, validate: validateChannelAlert } = require('./channel-alert');
const { makeChannelLoginStore, validate: validateChannelLogin } = require('./channel-login-store');
const SITE = 'https://max.cheapi.cc';
const dataDir = path.join(app.getPath('appData'), 'CheapiKeyStudio');
app.setPath('userData', dataDir);
const testMode = process.argv.includes('--fixture-test');
const adminLoginMode = process.argv.includes('--admin-login');
const adminGroupsMode = process.argv.includes('--admin-groups');
if (testMode) app.setPath('userData', path.join(__dirname, '..', '.runtime', 'key-tool-fixture'));
if (!app.requestSingleInstanceLock()) app.exit(0);
let ui, adminUI, login, loginReady, apiSession, service, auth, completingLogin, loginLoadFailed = false, copiedKey = '', closing = false, userOwnership, ownershipDraft, accountSchedule, dailyUsagePublisher;
let feishuConnection, feishuReconnect, feishuWorkflow, feishuPolicyStore, feishuPolicy = emptyPolicy(), feishuPolicyError = false;
let failureLog, registrationService, groupSettingsService, adminOperationLog, memberNames, channelMonitor, channelHost, channelLoginStores, channelAlert;
let recordTable,tableTimer,tablePreparationError=false;
const recordTableDir=path.join(__dirname,'..','本机数据');
function syncRecordTable(){
  if(!recordTable)return null;
  const healthy=service&&!service.storageFault&&registrationService&&!registrationService.storageFault&&groupSettingsService&&!groupSettingsService.storageFault;
  return recordTable.sync(healthy?{tokens:service.records.map(r=>memberNames?.decorate(r)||r),registrations:registrationService.records.map(r=>memberNames?.decorate(r)||r),settings:groupSettingsService.records}:{});
}
function recordTableState(){return recordTable?.state()||{folder:recordTableDir,updatedAt:null,rows:0,error:tablePreparationError?'本机数据目录权限准备失败，表格未更新；原业务账本不受影响。':null};}
const feishuDataDir = path.join(app.getPath('appData'), 'CheapiKeyStudioFeishu');
// safeStorage is bound to this Electron userData context. The diagnostic app's
// ciphertext must never be loaded here. Existing policy/lease paths stay intact.
const feishuBusinessDir = path.join(app.getPath('userData'), 'feishu-business');
const uiURL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const adminURL = pathToFileURL(path.join(__dirname, 'admin.html')).href;

function publishState() {
  if (ui && !ui.isDestroyed()) ui.webContents.send('key-tool:state', service.state());
}
function publishRecords() {
  if(recordTable){clearTimeout(tableTimer);tableTimer=setTimeout(syncRecordTable,300);tableTimer.unref?.();}
  if (adminUI && !adminUI.isDestroyed()) adminUI.webContents.send('key-tool:admin-records-changed');
}
function publishFeishuState() {
  if (adminUI && !adminUI.isDestroyed() && feishuWorkflow) adminUI.webContents.send('key-tool:feishu-state', feishuAdminState());
}
function feishuAdminState() {
  const workflow = feishuWorkflow?.state() || {};
  return { ...workflow, policy: workflow.policy || { enabled: false, platformOwnerId: null, maxQuota: null, maxUserDailyQuota: null, maxGroupDailyQuota: null },
    registration: { available: !!registrationService && !registrationService.storageFault, blocked: registrationService?.blocked().length || 0 },
    storageError: feishuPolicyError, connection: feishuConnection?.state() || null, autoReconnect: feishuReconnect?.state() || null,
    createFailures: failureLog?.state() || { items: [], storageError: false } };
}
function currentPlatformOwner() {
  if (!Number.isSafeInteger(service?.owner) || service.owner <= 0) {
    throw new ToolError('AUTH', '请先完成 2API 管理员授权并重新读取分组，再绑定群策略。');
  }
  return service.owner;
}
function saveFeishuPolicy(next) {
  if (!feishuPolicyStore || feishuPolicyError) throw new ToolError('STORAGE', '飞书群配置存储异常，已关闭服务；请保留配置文件并检查。');
  feishuPolicy = emptyPolicy(); feishuWorkflow?.reset(); publishFeishuState();
  try { feishuPolicy = Object.freeze(feishuPolicyStore.save(next)); }
  catch { feishuPolicyError = true; feishuPolicy = emptyPolicy(); throw new ToolError('STORAGE', '飞书群策略未安全保存，已关闭群内服务；请保留配置文件并检查。'); }
  publishFeishuState();
  return feishuAdminState();
}
async function assertFeishuAdmin() {
  if (!auth) throw new ToolError('AUTH', '管理员授权尚未就绪。');
  await auth.ensure();
  if (auth.phase !== 'ready') throw new ToolError('AUTH', '请先完成管理员平台授权核验。');
}
function assertFeishuConnected() {
  if (feishuConnection?.state().phase !== 'connected') throw new ToolError('CONNECT', '请先在管理员页连接飞书并等待“已连接”。');
}
function copySecret(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new ToolError('INPUT', '密钥格式无效。');
  copiedKey = value; clipboard.writeText(value);
  setTimeout(() => { if (clipboard.readText() === value) clipboard.clear(); if (copiedKey === value) copiedKey = ''; }, 60000).unref();
  return true;
}
function publishAuth() {
  if (adminUI && !adminUI.isDestroyed()) adminUI.webContents.send('key-tool:admin-auth', auth.state());
  if (auth.phase !== 'ready' && service) {
    service.owner = null; service.groups = []; publishState();
    feishuWorkflow?.reset(); feishuConnection?.disconnect(); publishFeishuState();
  }
}
function reportLoginError() {
  if (adminUI && !adminUI.isDestroyed()) adminUI.webContents.send('key-tool:admin-auth-error', '授权尚未保存，请完成平台登录后点击保存；持续失败请检查网络及本机安全存储。');
}
async function beginAuthorization() {
  if (service.busy || registrationService?.busy || completingLogin) throw new ToolError('BUSY', '正在处理其他操作，请稍后再登录。');
  return auth.begin();
}
async function completeAuthorization() {
  if (completingLogin) return completingLogin;
  if (service.busy || registrationService?.busy) throw new ToolError('BUSY', '正在处理其他操作，请稍后保存授权。');
  completingLogin = (async () => {
    await auth.finish();
    if (login && !login.isDestroyed()) login.hide();
    try { await service.refresh(); } finally { publishState(); }
    const result = { auth: auth.state(), catalog: service.adminState() };
    if (adminUI && !adminUI.isDestroyed()) adminUI.webContents.send('key-tool:admin-login-complete', result);
    return result;
  })();
  try { return await completingLogin; } finally { completingLogin = null; }
}
async function recoverAuthorization() {
  if (service.busy || registrationService?.busy || service.refreshing || completingLogin) throw new ToolError('BUSY', '正在处理操作，请稍后再恢复授权。');
  if (!auth.state().canRecover) throw new ToolError('STORAGE', '当前授权不符合显式恢复条件，请保留文件检查。');
  const result = await dialog.showMessageBox(adminUI, { type: 'warning',
    buttons: ['取消', '保留原件并撤销旧授权'], defaultId: 0, cancelId: 0,
    message: '保留无法解密的授权，然后重新登录？',
    detail: '仅适用于外层校验完整但当前加密环境无法解密的授权。将先保留原件，再追加持久撤销；不会删除原文件、操作记录或解除待核对保护。恢复后请您亲自重新登录并保存。' });
  if (result.response !== 1) return auth.state();
  if (service.busy || registrationService?.busy || service.refreshing || completingLogin) throw new ToolError('BUSY', '操作状态已变化，请稍后再试。');
  return auth.recover(true);
}
async function createAdmin() {
  if (adminUI && !adminUI.isDestroyed()) { adminUI.show(); adminUI.focus(); return adminUI; }
  adminUI = new BrowserWindow({ width: 1040, height: 820, minWidth: 460, minHeight: 650,
    title: '管理员 · 管理后台', backgroundColor: '#f4f3ee',
    webPreferences: { preload: path.join(__dirname, 'admin-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  adminUI.setMenuBarVisibility(false);
  adminUI.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  adminUI.webContents.on('will-navigate', e => e.preventDefault());
  adminUI.on('closed', () => { adminUI = null; });
  await adminUI.loadFile(path.join(__dirname, 'admin.html'));
  return adminUI;
}

function isSite(url) { try { return new URL(url).origin === SITE; } catch { return false; } }
function createLogin(show = false) {
  if (login && !login.isDestroyed()) {
    if (show && loginLoadFailed) login.destroy();
    else { if (show) { login.show(); login.focus(); } return loginReady; }
  }
  loginLoadFailed = false;
  login = new BrowserWindow({ width: 1180, height: 850, show,
    title: '管理员登录 · 登录后返回管理页完成保存',
    webPreferences: { partition: 'persist:cheapi-key-login', contextIsolation: true, sandbox: true, nodeIntegration: false } });
  login.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  login.webContents.on('will-navigate', (event, url) => { if (!isSite(url)) event.preventDefault(); });
  login.on('close', e => {
    if (!closing) {
      e.preventDefault(); login.hide();
      if (auth?.phase === 'login') completeAuthorization().catch(reportLoginError);
    }
  });
  const target = login;
  loginReady = target.loadURL(SITE + '/keys').then(() => true, () => { if (login === target) loginLoadFailed = true; return false; });
  return loginReady;
}
async function ensureSessionReady() {
  let timer;
  try {
    const ready = await Promise.race([createLogin(false), new Promise(resolve => { timer = setTimeout(() => resolve(false), 30000); })]);
    if (!ready) {
      loginLoadFailed = true;
      // Permit a later explicit refresh to retry loading; never display the website.
      if (login && !login.isDestroyed() && !login.isVisible()) login.destroy();
      throw new ToolError('NETWORK', '服务连接暂不可用，请稍后刷新；持续失败请联系管理员。');
    }
  } finally { clearTimeout(timer); }
}
async function readPlatformToken() {
  await ensureSessionReady();
  if (!login || login.isDestroyed() || !isSite(login.webContents.getURL())) throw new ToolError('AUTH', '管理员登录尚未完成。');
  try { return await login.webContents.executeJavaScript('localStorage.getItem("auth_token")', false); }
  catch { throw new ToolError('AUTH', '管理员登录尚未完成，请重新登录后保存。'); }
}
async function flushPlatformSession() {
  apiSession.flushStorageData();
  await apiSession.cookies.flushStore();
}
async function fetchPlatform(token, method, route, body) {
  let response;
  try {
    response = await apiSession.fetch(SITE + '/api/v1' + route, {
      method, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + token, 'X-User-UI-Request': '1', Accept: 'application/json',
        'Accept-Language': 'zh-CN', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch { throw new ToolError('NETWORK', '网络超时或连接失败；创建请求不会自动重试。'); }
  if (!response.ok) {
    const reason = [400,403,404,409,422].includes(response.status)
      ? classifyPlatformError(method, route, await readPlatformError(response)) : null;
    const e = new ToolError(response.status === 401 ? 'AUTH' : 'HTTP', response.status === 401
      ? '服务授权已失效，请联系管理员维护。' : `平台返回 HTTP ${response.status}，请联系管理员检查权限、余额及参数。`);
    e.definitive = [400,401,403,404,405,409,422,429].includes(response.status);
    e.httpStatus = response.status;
    e.reason = reason;
    throw e;
  }
  let json;
  try { json = await response.json(); } catch { throw new ToolError('SCHEMA', '平台响应不是有效 JSON，请先核对。'); }
  if (json && Object.hasOwn(json, 'code')) {
    if (json.code !== 0) {
      const e = new ToolError('API', '平台拒绝操作，请在平台核对；不会自动重试。');
      e.reason = classifyPlatformError(method, route, json);
      e.definitive = Boolean(e.reason);
      throw e;
    }
    return json.data;
  }
  return json;
}
async function request(method, route, body, context = {}) {
  const groupRoute = groupRequest(method, route, body) || (method === 'GET' && /^\/admin\/users\?page=(?:[1-9]|[1-4]\d|50)&page_size=100$/.test(route));
  const usageRoute = method === 'GET' && /^\/admin\/usage\/stats\?user_id=[1-9]\d*&start_date=\d{4}-\d{2}-\d{2}&end_date=\d{4}-\d{2}-\d{2}$/.test(route);
  const accountRoute = method === 'GET' && (/^\/admin\/accounts\?page=(?:[1-9]|[1-4]\d|50)&page_size=100$/.test(route) || /^\/admin\/accounts\/[1-9]\d*$/.test(route)) ||
    method === 'POST' && /^\/admin\/accounts\/[1-9]\d*\/schedulable$/.test(route) &&
      body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 &&
      typeof body.schedulable === 'boolean' && context.accountSchedule === true;
  if (!groupRoute && !accountRoute && !usageRoute && !(method === 'POST' && ['/keys', '/admin/users'].includes(route)) && !(method === 'GET' &&
    (['/auth/me','/groups/available'].includes(route) || /^\/keys\?(?:page=1&page_size=100&search=).+$/.test(route) || /^\/keys\/\d+$/.test(route)))) {
    throw new ToolError('ROUTE', '该接口不在工具允许范围内。');
  }
  if (route === '/admin/users') assertRegistrationBody(body);
  const credential = await auth.ensure();
  try {
    if (method === 'POST' || groupRoute || accountRoute || usageRoute) {
      // Bind the actual POST credential to the reviewed account, not a previous UI snapshot.
      let me;
      try { me = await fetchPlatform(credential.token, 'GET', '/auth/me'); }
      catch (e) { e.definitive = true; throw e; } // The POST has not been attempted.
      if ((method !== 'GET' && Number(me?.id) !== context.owner) || Number(me?.id) !== credential.owner) {
        const e = new ToolError('AUTH', '服务账户已变化或授权已失效，请联系管理员。'); e.definitive = true; throw e;
      }
      if ((route === '/admin/users' || groupRoute || accountRoute || usageRoute) && me?.role !== 'admin') {
        const e = new ToolError('DENIED', '该授权不是平台管理员，未提交注册。'); e.definitive = true; throw e;
      }
      if ((route === '/admin/users' || method === 'PUT' || (method === 'POST' && accountRoute)) && context.guard?.() !== true) {
        const e = new ToolError('POLICY', '注册授权已变化，未提交。'); e.definitive = true; throw e;
      }
    }
    auth.assertCurrent(credential);
    if (method === 'PUT' && context.groupSettings !== true) {
      const e = new ToolError('DENIED', '拒绝未经分组设置流程核对的更新。'); e.definitive = true; throw e;
    }
    const result = await fetchPlatform(credential.token, method, route, body);
    auth.assertCurrent(credential);
    if (route === '/auth/me' && Number(result?.id) !== credential.owner) throw new ToolError('AUTH', '服务账户已变化，请重新授权。');
    return result;
  } catch (e) {
    if (e.code === 'AUTH') auth.reject(credential);
    throw e;
  }
}
function register(name, action, adminOnly = false) {
  ipcMain.handle('key-tool:' + name, async (event, ...args) => {
    const target = adminOnly ? adminUI : ui;
    if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame ||
        event.senderFrame.url !== (adminOnly ? adminURL : uiURL)) {
      return { ok: false, code: 'DENIED', message: '拒绝非工具页面调用。' };
    }
    let operationId, logWarning;
    try {
      const result = adminOperationLog ? await adminOperationLog.run(name, () => action(...args)) : {data:await action(...args)};
      operationId=result.operationId;logWarning=result.logWarning;
      if(result.failed)throw result.error;
      return {ok:true,data:result.data,operationId,logWarning};
    } catch (e) { return { ok: false, code: e instanceof ToolError ? e.code : 'OPERATION_ERROR', definitive: e?.definitive === true,
      operationId,logWarning,message: e instanceof ToolError ? e.message : '操作未完成，请查看操作日志并保留原件。' }; }
  });
}
app.on('second-instance', (_event, argv) => {
  if (ui) { ui.show(); ui.focus(); }
  if (!testMode && argv.includes('--admin-login')) createAdmin().then(beginAuthorization).catch(reportLoginError);
  if (!testMode && argv.includes('--admin-groups')) createAdmin().catch(() => dialog.showErrorBox('分组设置打开失败', '请重启令牌工具后再试。'));
});
app.on('before-quit', () => {
  clearTimeout(tableTimer);syncRecordTable();
  channelMonitor?.stop();channelHost?.closeAll();
  closing = true; if (copiedKey && clipboard.readText() === copiedKey) clipboard.clear();
  feishuWorkflow?.reset(); if (feishuReconnect) feishuReconnect.stop(); else feishuConnection?.disconnect();
});
app.on('window-all-closed', () => app.quit());
function makeFixtureChannelLoginStore(channelId) {
  let current = null;
  const state = () => ({ configured: !!current, enabled: !!current?.enabled, storageError: false });
  return {
    load: () => state(), state,
    save: input => { current = { ...validateChannelLogin(input, channelId), enabled: true }; return state(); },
    claim: () => { if (!current?.enabled) return null; current.enabled = false; return { email: current.email, password: current.password }; },
    resume: input => { if (!current || current.email !== input?.email || current.password !== input?.password) throw new Error('fixture-login-state'); current.enabled = true; return state(); },
    pause: () => { if (current) current.enabled = false; return state(); },
    clear: () => { current = null; return state(); }
  };
}
function makeFixtureDailyUsageStore() {
  let state = { enabled: false, days: 3, snapshots: {}, cards: {} };
  return { load() {}, state() { return structuredClone(state); }, append(event) {
    if (event.type === 'config') state.enabled = event.enabled;
    else if (event.type === 'snapshot') state.snapshots[event.day] = structuredClone(event);
    else if (event.type === 'attempt') state.cards[event.profile] = { phase: 'attempting', ...structuredClone(event) };
    else if (event.type === 'ready' || event.type === 'unknown')
      state.cards[event.profile] = { phase: event.type, ...structuredClone(event) };
  } };
}
function makeFixtureAlertStore() {
  let current = null;
  const state = () => ({ configured: !!current, enabled: !!current?.enabled,
    recipients: current?.recipients || [], sender: current?.from || '', threshold: current?.threshold ?? 2000,
    dailyTime: current?.dailyTime ?? null, attention: [], dailyAttention: [], storageError: false });
  return { load: state, state, config: () => current?.enabled ? structuredClone(current) : null,
    configure(input) { current = { ...validateChannelAlert(input), enabled: true,
      dailyActivationAt: input?.dailyTime ? new Date().toISOString() : null }; return state(); },
    pause() { if (current) current.enabled = false; return state(); },
    clear() { current = null; return state(); },
    delivery: () => 'armed', mark: () => state(), dailyDelivery: () => null, markDaily: () => state() };
}
app.whenReady().then(async () => {
  adminOperationLog = makeAdminOperationLog(app.getPath('userData'), {memory:testMode});
  try {
    channelAlert = new ChannelAlert({ store: testMode ? makeFixtureAlertStore() :
      makeAlertStore(path.join(app.getPath('userData'), 'channel-monitor'), safeStorage),
      send: testMode ? async () => {} : undefined,
      onChange: value => { if (adminUI && !adminUI.isDestroyed()) adminUI.webContents.send('key-tool:channel-alert-state', value); } });
  } catch { channelAlert = null; }
  channelLoginStores = new Map();
  for (const channel of CHANNELS) {
    try {
      const loginStore = testMode ? makeFixtureChannelLoginStore(channel.id) :
        makeChannelLoginStore(path.join(app.getPath('userData'), 'channel-monitor'), safeStorage, undefined, channel.id);
      try { loginStore.load(); } catch { /* This channel alone fails closed; preserve its file. */ }
      channelLoginStores.set(channel.id, loginStore);
    } catch { /* Other channels must remain available. */ }
  }
  try {
    channelHost = testMode ? { load: async () => {}, observe: async () => ({ status: 'login-required' }), closeAll() {} }
      : createChannelHost({ isClosing: () => closing, autoLogin: {
        available: id => channelLoginStores.get(id)?.state().enabled === true,
        claim: id => channelLoginStores.get(id)?.claim() || null,
        resume: (id, input) => channelLoginStores.get(id)?.resume(input)
      } });
    const nameStore = testMode ? { load: () => ({}), save: rows => structuredClone(rows) }
      : makeNameStore(path.join(app.getPath('userData'), 'channel-monitor'));
    channelMonitor = new ChannelMonitorController({ store: nameStore, host: channelHost,
      onChange: data => { if (adminUI && !adminUI.isDestroyed()) adminUI.webContents.send('key-tool:channel-monitor-state', data); },
      onResult: (channel, row) => { void channelAlert?.observed(channel, row).catch(() => {}); } });
  } catch { channelMonitor = null; channelHost?.closeAll(); channelHost = null; }
  failureLog = testMode ? { items: [], state() { return { items: this.items.map(row => ({ ...row })), storageError: false }; },
    append(row) { this.items = [...this.items, { ...row }].slice(-20); } }
    : makeFailureLog(app.getPath('userData'));
  apiSession = session.fromPartition('persist:cheapi-key-login');
  apiSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  if (!testMode && !safeStorage.isEncryptionAvailable()) throw new ToolError('STORAGE', 'Windows 安全存储不可用，工具未启动。');
  let fixture;
  if (testMode) {
    fixture = require('./test-fixture').makeFixture({ admin: true });
    service = new KeyService(fixture);
  } else service = new KeyService({ request, store: makeDiskStore(app.getPath('userData'), safeStorage),
    catalog: makeCatalogStore(app.getPath('userData')) });
  try { registrationService = new UserRegistrationService({ request: testMode ? fixture.request : request,
    store: testMode ? { load: () => [], save() {} } : makeDiskStore(path.join(app.getPath('userData'), 'user-registration'), safeStorage),
    getOwner: () => service.owner });
    registrationService.onRecordsChanged = publishRecords;
  } catch { registrationService = null; } // Isolate damaged registration storage; never silently replace it.
  try {
    groupSettingsService = new GroupSettingsService({ request: testMode ? fixture.request : request, getOwner: () => service.owner,
      onProgress: stage => adminOperationLog.step(stage),
      catalog: testMode ? { load: () => [], save() {} } : makeCatalogStore(path.join(app.getPath('userData'), 'group-settings')),
      store: testMode ? { load: () => [], save() {} } : makeDiskStore(path.join(app.getPath('userData'), 'group-settings'), safeStorage) });
  } catch { groupSettingsService = null; } // A corrupt independent ledger never falls back to empty records.
  try {
    userOwnership = new UserOwnership({ request: testMode ? fixture.request : request,
      store: testMode ? { load: () => [], save() {} } : makeOwnershipStore(path.join(app.getPath('userData'), 'user-ownership'), safeStorage),
      audit: testMode ? { load: () => [], append() {}, list: () => [] } :
        makeOwnershipQueryAudit(path.join(app.getPath('userData'), 'user-ownership'), safeStorage),
      getOwner: () => service.owner, getGroupId: () => feishuPolicy?.groupId || (testMode ? 'oc_fixture_12345678' : null) });
  } catch { userOwnership = null; } // Damaged ownership must never expose another member's users.
  try {
    ownershipDraft = makeOwnershipDraftStore(path.join(app.getPath('userData'), 'user-ownership'), safeStorage);
    ownershipDraft.load();
  } catch { ownershipDraft = null; } // Preserve damaged draft file and refuse to overwrite it.

  service.onRecordsChanged = publishRecords;
  auth = new AdminSession({ store: testMode ? { load: () => ({ token: 'fixture-only', owner: 1, origin: SITE, savedAt: new Date().toISOString() }), save() {} }
    : makeSessionStore(app.getPath('userData'), safeStorage), readCandidate: testMode ? async () => 'fixture-only' : readPlatformToken,
    verify: testMode ? async () => Number((await fixture.request('GET', '/auth/me')).id)
      : async token => Number((await fetchPlatform(token, 'GET', '/auth/me'))?.id),
    flush: testMode ? async () => {} : flushPlatformSession,
    openLogin: testMode ? async () => {} : async () => { createLogin(true); await ensureSessionReady(); }, onChange: publishAuth });
  try {
    accountSchedule = new AccountSchedule({ request: testMode ? fixture.request : request,
      store: testMode ? { load: () => [], save() {} } : makeAccountScheduleStore(path.join(app.getPath('userData'), 'account-schedule'), safeStorage),
      getOwner: () => auth.state().owner,
      onChange: state => { if (adminUI && !adminUI.isDestroyed()) adminUI.webContents.send('key-tool:account-schedule-state', state); } });
  } catch { accountSchedule = null; } // Never recreate an empty plan set over a damaged journal.
  if (testMode) {
    feishuPolicyStore = { load: () => emptyPolicy(), save: value => validatePolicy(value) };
    feishuPolicy = Object.freeze(emptyPolicy());
    feishuConnection = new FeishuConnection({ store: { load: () => null, save() {} }, createClient: () => { throw new Error('fixture disabled'); }, mode: 'feishu-key-workflow' });
  } else {
    feishuPolicyStore = makeFeishuPolicyStore(feishuDataDir, safeStorage);
    try { feishuPolicy = Object.freeze(feishuPolicyStore.load()); }
    catch { feishuPolicy = emptyPolicy(); feishuPolicyError = true; }
    const lease = makeConnectionLease(path.join(feishuDataDir, 'feishu-connection.lock'));
    feishuConnection = new FeishuConnection({ store: makeFeishuStore(feishuBusinessDir, safeStorage),
      createClient: createFeishuClient, mode: 'feishu-key-workflow', lease,
      handlers: { message: event => feishuWorkflow?.handle(event), card: event => feishuWorkflow?.handleCard(event) } });
  }
  memberNames=new FeishuMemberNames({getScope:()=>{
    const c=feishuConnection?.state();
    return c?.phase==='connected'&&feishuPolicy.groupId?{client:feishuConnection.client,appId:c.appId,groupId:feishuPolicy.groupId}:null;
  }});
  service.decorateRecord=record=>memberNames.decorate(record);
  if(registrationService)registrationService.decorateRecord=record=>memberNames.decorate(record);
  service.onCreateFailure = row => { failureLog.append(row); publishFeishuState(); };
  feishuWorkflow = new FeishuBotWorkflow({ getPolicy: () => feishuPolicy, service, registrationService, groupSettingsService, userOwnership, connection: feishuConnection,
    resolveActorName:(openId,groupId)=>memberNames.actor(openId,groupId),
    sendText: message => {
      if (!feishuConnection?.client || typeof feishuConnection.client.sendText !== 'function') throw new Error('connection unavailable');
      return feishuConnection.client.sendText(message);
    }, sendCard: message => {
      if (!feishuConnection?.client || typeof feishuConnection.client.sendCard !== 'function') throw new Error('connection unavailable');
      return feishuConnection.client.sendCard(message);
    }, onCandidate: () => publishFeishuState() });
  try {
    if (userOwnership) dailyUsagePublisher = new DailyUsagePublisher({
      usage: new DailyUsage({ ownership: userOwnership, request: testMode ? fixture.request : request,
        throttle: () => new Promise(resolve => setTimeout(resolve, 200)) }),
      store: testMode ? makeFixtureDailyUsageStore() :
        makeDailyUsageStore(path.join(app.getPath('userData'), 'daily-usage'), safeStorage),
      getScope: () => testMode ? userOwnership.scope() :
        ({ owner: feishuPolicy.platformOwnerId, groupId: feishuPolicy.groupId }),
      getClient: () => testMode ? { sendGroupCard: async () => 'om_fixture_usage_card', patchGroupCard: async ({ messageId }) => messageId } : feishuConnection?.client,
      isReady: scope => testMode || (!!feishuWorkflow?.policy() && auth?.phase === 'ready' &&
        service.owner === scope.owner && feishuPolicy.groupId === scope.groupId)
    });
  } catch { dailyUsagePublisher = null; } // A damaged daily usage log cannot affect registration or tokens.
  setInterval(() => feishuWorkflow.pruneTransientState(), 30000).unref();
  if (!testMode) feishuReconnect = new FeishuReconnect({ connection: feishuConnection, ensureReady: async () => {
    if (closing) throw new ToolError('STOP', '程序正在退出。');
    await assertFeishuAdmin();
    // Restore platform owner/groups after a transient authorization check cleared them.
    if (!Number.isSafeInteger(service.owner)) await service.refresh();
    if (closing || auth.phase !== 'ready' || service.owner !== auth.state().owner)
      throw new ToolError('AUTH', '等待平台授权恢复。');
  } });
  ui = new BrowserWindow({ width: 1130, height: 860, minWidth: 420, minHeight: 650,
    title: 'Cheapi · 令牌工作台', backgroundColor: '#f4f3ee',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  ui.setMenuBarVisibility(false);
  ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ui.webContents.on('will-navigate', e => e.preventDefault());
  ui.on('closed', () => { closing = true; if (adminUI && !adminUI.isDestroyed()) adminUI.destroy(); if (login && !login.isDestroyed()) login.destroy(); app.quit(); });
  register('state', () => service.state());
  register('refresh', () => service.refresh());
  register('admin-state', () => service.adminState(), true);
  register('admin-channel-monitor-state', () => {
    if (!channelMonitor) throw new ToolError('STORAGE', '渠道监控名称配置无法安全读取，请保留原文件检查。');
    return channelMonitor.state();
  }, true);
  register('admin-channel-monitor-rename', ({ id, name } = {}) => {
    if (!channelMonitor) throw new ToolError('STORAGE', '渠道监控名称配置不可用。');
    try { channelMonitor.channel(id); safeName(name); }
    catch { throw new ToolError('INPUT', '请选择已配置渠道并填写1–40字的有效名称。'); }
    try { return channelMonitor.rename(id, name); }
    catch { throw new ToolError('STORAGE', '渠道名称未安全保存，请保留本机配置检查。'); }
  }, true);
  register('admin-channel-monitor-open', async id => {
    if (!channelMonitor) throw new ToolError('STORAGE', '渠道监控不可用。');
    try { channelMonitor.channel(id); } catch { throw new ToolError('INPUT', '未知渠道。'); }
    try { return await channelMonitor.open(id); }
    catch { throw new ToolError('NETWORK', '渠道页面未能打开，请检查网络和证书提示；不会绕过安全警告。'); }
  }, true);
  register('admin-channel-monitor-check', async id => {
    if (!channelMonitor) throw new ToolError('STORAGE', '渠道监控不可用。');
    try { channelMonitor.channel(id); } catch { throw new ToolError('INPUT', '未知渠道。'); }
    try { return await channelMonitor.check(id, true); }
    catch { throw new ToolError('BUSY', '另一个渠道正在读取，请稍后重试。'); }
  }, true);
  register('admin-channel-alert-state', () => channelAlert?.state() ||
    { configured: false, enabled: false, recipients: [], sender: '', threshold: 2000,
      dailyTime: null, attention: [], dailyAttention: [], storageError: true }, true);
  register('admin-channel-alert-save', input => {
    if (!channelAlert) throw new ToolError('STORAGE', '邮件提醒配置不可用，请保留原件检查。');
    try { return channelAlert.configure(input); }
    catch (error) { throw new ToolError(error.code === 'INPUT' ? 'INPUT' : 'STORAGE', error.message); }
  }, true);
  register('admin-channel-alert-pause', () => {
    if (!channelAlert) throw new ToolError('STORAGE', '邮件提醒配置不可用。');
    try { return channelAlert.pause(); }
    catch { throw new ToolError('STORAGE', '邮件提醒暂停未安全保存，请保留原件检查。'); }
  }, true);
  register('admin-channel-alert-clear', () => {
    if (!channelAlert) throw new ToolError('STORAGE', '邮件提醒配置不可用。');
    try { return channelAlert.clear(); }
    catch { throw new ToolError('STORAGE', '邮件提醒配置未安全清除，请保留原件检查。'); }
  }, true);
  register('admin-channel-alert-test', async scope => {
    if (!channelAlert || !channelMonitor) throw new ToolError('STORAGE', '邮件提醒或渠道状态不可用。');
    try { return await channelAlert.sendTest(channelMonitor.state(), scope); }
    catch (error) {
      throw new ToolError(['INPUT','BUSY','CONFIG','STORAGE'].includes(error?.code) ? error.code : 'OPERATION_ERROR',
        error?.code ? error.message : '测试邮件结果不明；请先核对 QQ 发件箱与收件箱，不要立即重发。');
    }
  }, true);
  const loginStore = id => {
    if (!CHANNELS.some(channel => channel.id === id)) throw new ToolError('INPUT', '未知渠道。');
    const store = channelLoginStores?.get(id);
    if (!store) throw new ToolError('STORAGE', '渠道自动登录配置不可用，请保留原文件检查。');
    return store;
  };
  register('admin-channel-login-state', id => loginStore(id).state(), true);
  register('admin-channel-login-save', input => {
    const store = loginStore(input?.id);
    try { channelHost?.cancelAutoLogin?.(input.id); return store.save(input); }
    catch (error) { throw new ToolError(error.code === 'INPUT' ? 'INPUT' : 'STORAGE', error.message); }
  }, true);
  register('admin-channel-login-pause', id => {
    const store = loginStore(id); channelHost?.cancelAutoLogin?.(id);
    try { return store.pause(); }
    catch { throw new ToolError('STORAGE', '暂停状态未能安全保存，当前进程已停止自动登录；请检查本机配置。'); }
  }, true);
  register('admin-channel-login-clear', id => {
    const store = loginStore(id); channelHost?.cancelAutoLogin?.(id);
    try { return store.clear(); }
    catch { throw new ToolError('STORAGE', '本机凭据未能清除，请保留原文件检查。'); }
  }, true);
  register('admin-operation-log', () => ({...adminOperationLog.state(),recordTable:recordTableState()}), true);
  register('admin-record-table-sync', () => {syncRecordTable();return recordTableState();}, true);
  register('admin-record-table-open', async () => {
    if(!require('node:fs').existsSync(recordTableDir))throw new ToolError('STORAGE','本机数据目录尚未准备成功。');
    const error=await shell.openPath(recordTableDir);if(error)throw new ToolError('STORAGE','无法打开本机数据文件夹。');return true;
  }, true);
  register('admin-auth-state', () => auth.state(), true);
  const schedules = () => { if (!accountSchedule) throw new ToolError('STORAGE', '账号计划记录无法安全读取，请保留原件。'); return accountSchedule; };
  register('admin-account-schedule-snapshot', async () => { await assertFeishuAdmin(); return schedules().snapshot(); }, true);
  register('admin-account-schedule-state', async () => { await assertFeishuAdmin(); return schedules().state(); }, true);
  register('admin-account-schedule-create', async input => { await assertFeishuAdmin(); return schedules().create(input); }, true);
  register('admin-account-schedule-cancel', async id => { await assertFeishuAdmin(); return schedules().cancel(id); }, true);
  register('admin-account-schedule-reconcile', async input => {
    await assertFeishuAdmin(); return schedules().reconcile(input?.id, input?.index);
  }, true);
  register('admin-login', beginAuthorization, true);
  register('admin-recover-authorization', recoverAuthorization, true);
  register('admin-complete-login', completeAuthorization, true);
  register('admin-refresh', async () => { try { await service.refresh(); return service.adminState(); } finally { publishState(); } }, true);
  register('admin-save-groups', async input => { try { return await service.saveGroupNames(input); } finally { publishState(); } }, true);
  const settings = () => { if (!groupSettingsService) throw new ToolError('STORAGE', '分组设置记录不可用，请保留原件检查。'); return groupSettingsService; };
  const ownershipNames = data => ({ ...data,
    identities: memberNames.decorateOwnershipIdentities(data.identities, userOwnership.scope().groupId) });
  register('admin-user-ownership-list', async () => {
    await assertFeishuAdmin();
    if (!userOwnership) throw new ToolError('STORAGE', '用户归属配置不可用，请保留原件。');
    const scope = userOwnership.scope();
    const snapshot = await userOwnership.adminSnapshot();
    const nameState = await memberNames.refresh();
    const current = userOwnership.scope();
    if (scope.owner !== current.owner || scope.groupId !== current.groupId)
      throw new ToolError('POLICY', '管理员或目标群已变化，请重新读取。');
    return { ...ownershipNames(snapshot), nameState };
  }, true);
  register('admin-user-ownership-save', async input => {
    await assertFeishuAdmin();
    if (!userOwnership) throw new ToolError('STORAGE', '用户归属配置不可用，请保留原件。');
    return userOwnership.assign(input);
  }, true);
  register('admin-user-ownership-save-name', async input => {
    await assertFeishuAdmin();
    if (!userOwnership) throw new ToolError('STORAGE', '用户归属配置不可用，请保留原件。');
    return ownershipNames(await userOwnership.assignName(input));
  }, true);
  register('admin-user-ownership-link', async input => {
    await assertFeishuAdmin();
    if (!userOwnership) throw new ToolError('STORAGE', '用户归属配置不可用，请保留原件。');
    return ownershipNames(await userOwnership.link(input));
  }, true);
  const usagePublisher = () => {
    if (!dailyUsagePublisher) throw new ToolError('STORAGE', '每日用量发布账本不可安全读取，请保留原件。');
    return dailyUsagePublisher;
  };
  register('admin-daily-usage-state', () => usagePublisher().state(), true);
  register('admin-daily-usage-preview', async () => usagePublisher().preview(), true);
  register('admin-daily-usage-enable', async () => {
    await assertFeishuAdmin();
    const preview = await usagePublisher().preview();
    if (!preview.rows.length || preview.rows.every(row => !row.users.length))
      throw new ToolError('INPUT', '没有可发布的归属账号，请先建立并核对姓名档案。');
    usagePublisher().setEnabled(true);
    try { return { state: usagePublisher().state(), result: await usagePublisher().tick() }; }
    catch { return { state: usagePublisher().state(), error: '已启用，但首次读取或发布未完成；请查看状态，不要重复点击。' }; }
  }, true);
  register('admin-daily-usage-pause', () => usagePublisher().setEnabled(false), true);
  register('admin-daily-usage-now', async () => {
    await assertFeishuAdmin();
    return usagePublisher().publishNow();
  }, true);
  register('admin-daily-usage-history-catalog', async () => {
    await assertFeishuAdmin();
    return usagePublisher().historyCatalog();
  }, true);
  register('admin-daily-usage-history-week', async input => {
    await assertFeishuAdmin();
    return usagePublisher().historyWeek(input);
  }, true);
  register('admin-daily-usage-backfill-status', async () => {
    await assertFeishuAdmin();
    return usagePublisher().backfillStatus();
  }, true);
  register('admin-daily-usage-backfill-current-month', async () => {
    await assertFeishuAdmin();
    const result = await usagePublisher().backfillCurrentMonth();
    if (result.phase === 'failed') throw new ToolError('OPERATION_ERROR', result.message);
    return result;
  }, true);
  register('admin-user-ownership-draft-state', async () => {
    await assertFeishuAdmin();
    if (!userOwnership || !ownershipDraft) throw new ToolError('STORAGE', '归属草稿不可读取，请保留原件。');
    return ownershipDraft.state(userOwnership.scope());
  }, true);
  register('admin-user-ownership-draft-save', async input => {
    await assertFeishuAdmin();
    if (!userOwnership || !ownershipDraft) throw new ToolError('STORAGE', '归属草稿不可安全暂存，请保留当前窗口。');
    try { return ownershipDraft.save(userOwnership.scope(), input); }
    catch { throw new ToolError('STORAGE', '归属草稿未安全暂存，请保留当前窗口及原文件。'); }
  }, true);
  register('admin-group-settings-refresh', async () => { await assertFeishuAdmin(); return settings().refresh(); }, true);
  register('admin-group-settings-save', async input => { await assertFeishuAdmin(); return settings().saveNames(input); }, true);
  register('admin-group-settings-records', async () => { await assertFeishuAdmin(); return settings().history(); }, true);
  register('admin-group-settings-review', async input => {
    await assertFeishuAdmin();
    if (!input || typeof input.requestId !== 'string' || !['readback','manual'].includes(input.mode)) throw new ToolError('INPUT', '核对参数无效。');
    if (input.mode === 'manual') {
      const result = await dialog.showMessageBox(adminUI, { type: 'warning', buttons: ['取消', '已在平台核对并记录'], defaultId: 0, cancelId: 0,
        message: '确认已人工核对这笔分组设置？', detail: '仅解除待核对保护，不代表设置成功，不重发请求。请先在平台按目标用户ID核对分组授权与倍率，并保留本机记录。操作编号：' + input.requestId });
      if (result.response !== 1) return settings().history();
    }
    return settings().review(input.requestId, input.mode === 'manual');
  }, true);
  register('admin-registration-records', async page => { if (!registrationService) throw new ToolError('STORAGE', '注册账本无法读取，注册已关闭；请保留原文件检查。');
    const nameState=await memberNames.refresh();return {...registrationService.adminRecords(page),nameState}; }, true);
  register('admin-registration-review', async id => {
    await assertFeishuAdmin();
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new ToolError('INPUT', '操作编号无效。');
    if (!registrationService) throw new ToolError('STORAGE', '注册账本未就绪。');
    const owner = currentPlatformOwner();
    const row = registrationService.records.find(r => r.requestId === id && r.owner === owner && ['pending','unknown'].includes(r.state));
    if (!row) throw new ToolError('INPUT', '未找到此管理员的待核对注册。');
    const result = await dialog.showMessageBox(adminUI, { type: 'warning', buttons: ['取消', '已在平台核对并记录'], defaultId: 0, cancelId: 0,
      message: '确认已人工核对这笔注册？',
      detail: '请先在平台用户管理按邮箱及备注操作编号核对账号、角色、余额和并发。此操作仅解除待核对保护，不证明创建成功、不重试注册。操作编号：' + id });
    if (result.response === 1) {
      const me = await request('GET', '/auth/me');
      if (Number(me?.id) !== owner || me?.role !== 'admin') throw new ToolError('DENIED', '管理员身份已变化，未解除注册保护。');
      registrationService.review(id, true, owner);
    }
    return registrationService.adminRecords();
  }, true);
  register('admin-records', async input => {const nameState=await memberNames.refresh();return {...service.adminRecords(input),nameState};}, true);
  register('admin-record', async id => {await memberNames.refresh();return service.adminRecord(id);}, true);
  register('admin-secret', id => service.adminSecret(id), true);
  register('admin-copy-secret', id => copySecret(service.adminSecret(id, 'copy')), true);
  register('admin-feishu-state', () => feishuAdminState(), true);
  register('admin-feishu-save-credentials', async input => {
    await assertFeishuAdmin();
    if (feishuConnection.state().active) throw new ToolError('BUSY', '请先断开飞书连接，再修改配置。');
    let credentials;
    try { credentials = validateCredentials(input); }
    catch { throw new ToolError('INPUT', '请填写有效的飞书 App ID 和 App Secret，仅在本机密码框输入。'); }
    feishuReconnect?.stop(); // Invalidate any pending authorization check before replacing credentials.
    // Changing an application invalidates every identity/group binding, even if
    // writing the new credentials fails. Never transfer policy to a new App ID.
    saveFeishuPolicy(emptyPolicy());
    try { feishuConnection.save(credentials); }
    catch (e) { throw new ToolError(['INPUT','BUSY'].includes(e.code) ? e.code : 'STORAGE', e.message); }
    publishFeishuState(); return feishuAdminState();
  }, true);
  register('admin-feishu-connect', async () => {
    if (feishuReconnect) await feishuReconnect.start();
    else { await assertFeishuAdmin(); feishuConnection.connect(); }
    publishFeishuState(); return feishuAdminState();
  }, true);
  register('admin-feishu-disconnect', async () => {
    feishuWorkflow.reset(); if (feishuReconnect) feishuReconnect.stop(); else feishuConnection.disconnect();
    publishFeishuState(); return feishuAdminState();
  }, true);
  register('admin-feishu-start-owner-binding', async () => { await assertFeishuAdmin(); assertFeishuConnected(); const result = feishuWorkflow.startOwnerBinding(); publishFeishuState(); return result; }, true);
  register('admin-feishu-confirm-owner', async () => {
    await assertFeishuAdmin(); const openId = feishuWorkflow.confirmOwnerCandidate();
    return saveFeishuPolicy({ ...feishuPolicy, enabled: false, ownerOpenId: openId, groupId: null,
      platformOwnerId: Number.isSafeInteger(service?.owner) && service.owner > 0 ? service.owner : feishuPolicy.platformOwnerId });
  }, true);
  register('admin-feishu-start-group-binding', async () => { await assertFeishuAdmin(); assertFeishuConnected(); currentPlatformOwner(); const result = feishuWorkflow.startGroupBinding(); publishFeishuState(); return result; }, true);
  register('admin-feishu-confirm-group', async () => {
    await assertFeishuAdmin(); const platformOwnerId = currentPlatformOwner(); const groupId = feishuWorkflow.confirmGroupCandidate();
    return saveFeishuPolicy({ ...feishuPolicy, enabled: false, groupId, platformOwnerId });
  }, true);
  register('admin-feishu-save-policy', async input => {
    await assertFeishuAdmin();
    if (!input || typeof input !== 'object' || typeof input.enabled !== 'boolean') throw new ToolError('INPUT', '群策略参数无效。');
    const currentOwnerId = Number.isSafeInteger(service?.owner) && service.owner > 0 ? service.owner : null;
    if (input.enabled && !currentOwnerId) throw new ToolError('AUTH', '请先完成 2API 管理员授权并重新读取分组。');
    if (input.enabled && feishuPolicy.platformOwnerId !== currentOwnerId) {
      throw new ToolError('POLICY', '当前 2API 授权账户与此群策略绑定账户不同。请先取消勾选并保存关闭策略，再核对额度并重新启用。');
    }
    const next = validatePolicy({ ...feishuPolicy, platformOwnerId: currentOwnerId ?? feishuPolicy.platformOwnerId, enabled: input.enabled,
      maxQuota: input.maxQuota, maxUserDailyQuota: input.maxUserDailyQuota, maxGroupDailyQuota: input.maxGroupDailyQuota });
    if (next.enabled && (!next.ownerOpenId || !next.groupId || feishuConnection.state().phase !== 'connected')) {
      throw new ToolError('POLICY', '启用前必须绑定管理员身份、唯一目标群并确保飞书长连接在线。');
    }
    return saveFeishuPolicy(next);
  }, true);
  register('create', input => {
    if (typeof input?.operator !== 'string' || !input.operator.trim()) throw new ToolError('INPUT', '请填写操作人／客户账号，便于管理员追踪创建记录。');
    return service.create(input);
  });
  register('reconcile', id => service.reconcile(id));
  register('acknowledge', async id => {
    const result = await dialog.showMessageBox(ui, { type: 'warning', buttons: ['取消', '已在平台核对，解除保护'], defaultId: 0, cancelId: 0,
      message: '确认已核对创建结果？', detail: '这不会删除、停用或重试平台上的令牌。请先在平台按操作名称查找，确认结果后再解除保护。' });
    return service.acknowledge(id, result.response === 1);
  });
  register('copy', copySecret);
  await ui.loadFile(path.join(__dirname, 'index.html'));
  if (!testMode && (adminGroupsMode || adminLoginMode)) await createAdmin();
  channelMonitor?.start();
  if (!testMode && channelAlert && channelMonitor) setInterval(() => {
    if (!closing) void channelAlert.dailyTick(channelMonitor.state()).catch(() => {});
  }, 60000).unref();
  if (!testMode && accountSchedule) setInterval(() => { if (!closing) void accountSchedule.tick().catch(() => {}); }, 10000).unref();
  if (!testMode && dailyUsagePublisher) setInterval(() => {
    if (!closing) void dailyUsagePublisher.tick().catch(() => {});
  }, 60000).unref();
  if(!testMode){
    const prepared=require('./prepare-record-directory').prepareRecordDirectory(path.resolve(__dirname,'..'));
    if(prepared){recordTable=makeRecordTable(recordTableDir);groupSettingsService&&(groupSettingsService.onRecordsChanged=publishRecords);syncRecordTable();setInterval(syncRecordTable,60000).unref();}
    else tablePreparationError=true;
  }
  if (!testMode) void feishuReconnect.start().then(publishFeishuState);
  if (!testMode && adminLoginMode) {
    // The initial customer refresh may still be verifying the previous session.
    if (service.refreshing) await service.refreshing.catch(() => {});
    await beginAuthorization().catch(reportLoginError);
  }
  if (testMode) await require('./test-fixture').verifyUI({ app, ui, fixture, registrationService, tokenService:service, userOwnership, memberNames, accountSchedule, channelMonitor,
    openAdminWindow: createAdmin, openPlatformWindow: createLogin, getPlatformWindow: () => login, apiSession, auth, request });
}).catch(error => {
  if (testMode) console.error('fixture startup failed:', error?.stack || error?.message || 'unknown');
  else dialog.showErrorBox('令牌工具启动失败', '无法读取本机操作记录、分组配置或安全存储。请保留应用数据，不要重复创建令牌。');
  app.exit(1);
});
