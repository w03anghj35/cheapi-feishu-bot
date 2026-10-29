'use strict';
const { app, BrowserWindow, ipcMain, session, safeStorage, clipboard, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { KeyService, ToolError } = require('./service');
const { makeDiskStore } = require('./disk-store');
const { UserRegistrationService, assertRegistrationBody } = require('./user-registration-service');
const { makeCatalogStore } = require('./group-catalog');
const { makeSessionStore } = require('./session-store');
const { AdminSession } = require('./auth-session');
const { makeFeishuStore, validateCredentials } = require('./feishu-store');
const { makeFeishuPolicyStore, emptyPolicy, validatePolicy } = require('./feishu-policy-store');
const { FeishuConnection } = require('./feishu-connection');
const { createClient: createFeishuClient } = require('./feishu-sdk');
const { FeishuBotWorkflow } = require('./feishu-bot-workflow');
const { makeConnectionLease } = require('./feishu-connection-lease');
const { makeFailureLog } = require('./create-diagnostics');
const SITE = 'https://max.cheapi.cc';
const dataDir = path.join(app.getPath('appData'), 'CheapiKeyStudio');
app.setPath('userData', dataDir);
const testMode = process.argv.includes('--fixture-test');
const adminLoginMode = process.argv.includes('--admin-login');
const adminGroupsMode = process.argv.includes('--admin-groups');
if (testMode) app.setPath('userData', path.join(__dirname, '..', '.runtime', 'key-tool-fixture'));
if (!app.requestSingleInstanceLock()) app.exit(0);
let ui, adminUI, login, loginReady, apiSession, service, auth, completingLogin, loginLoadFailed = false, copiedKey = '', closing = false;
let feishuConnection, feishuWorkflow, feishuPolicyStore, feishuPolicy = emptyPolicy(), feishuPolicyError = false;
let failureLog, registrationService;
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
  if (adminUI && !adminUI.isDestroyed()) adminUI.webContents.send('key-tool:admin-records-changed');
}
function publishFeishuState() {
  if (adminUI && !adminUI.isDestroyed() && feishuWorkflow) adminUI.webContents.send('key-tool:feishu-state', feishuAdminState());
}
function feishuAdminState() {
  const workflow = feishuWorkflow?.state() || {};
  return { ...workflow, policy: workflow.policy || { enabled: false, platformOwnerId: null, maxQuota: null, maxUserDailyQuota: null, maxGroupDailyQuota: null },
    registration: { available: !!registrationService && !registrationService.storageFault, blocked: registrationService?.blocked().length || 0 },
    storageError: feishuPolicyError, connection: feishuConnection?.state() || null,
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
    title: '管理员 · 客户分组设置', backgroundColor: '#f4f3ee',
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
    const e = new ToolError(response.status === 401 ? 'AUTH' : 'HTTP', response.status === 401
      ? '服务授权已失效，请联系管理员维护。' : `平台返回 HTTP ${response.status}，请联系管理员检查权限、余额及参数。`);
    e.definitive = [400,401,403,404,405,422,429].includes(response.status);
    e.httpStatus = response.status;
    throw e;
  }
  let json;
  try { json = await response.json(); } catch { throw new ToolError('SCHEMA', '平台响应不是有效 JSON，请先核对。'); }
  if (json && Object.hasOwn(json, 'code')) {
    if (json.code !== 0) throw new ToolError('API', '平台拒绝操作，请在平台核对；不会自动重试。');
    return json.data;
  }
  return json;
}
async function request(method, route, body, context = {}) {
  if (!(method === 'POST' && ['/keys', '/admin/users'].includes(route)) && !(method === 'GET' &&
    (['/auth/me','/groups/available'].includes(route) || /^\/keys\?(?:page=1&page_size=100&search=).+$/.test(route) || /^\/keys\/\d+$/.test(route)))) {
    throw new ToolError('ROUTE', '该接口不在工具允许范围内。');
  }
  if (route === '/admin/users') assertRegistrationBody(body);
  const credential = await auth.ensure();
  try {
    if (method === 'POST') {
      // Bind the actual POST credential to the reviewed account, not a previous UI snapshot.
      let me;
      try { me = await fetchPlatform(credential.token, 'GET', '/auth/me'); }
      catch (e) { e.definitive = true; throw e; } // The POST has not been attempted.
      if (Number(me?.id) !== context.owner || Number(me?.id) !== credential.owner) {
        const e = new ToolError('AUTH', '服务账户已变化或授权已失效，请联系管理员。'); e.definitive = true; throw e;
      }
      if (route === '/admin/users' && me?.role !== 'admin') {
        const e = new ToolError('DENIED', '该授权不是平台管理员，未提交注册。'); e.definitive = true; throw e;
      }
      if (route === '/admin/users' && context.guard?.() !== true) {
        const e = new ToolError('POLICY', '注册授权已变化，未提交。'); e.definitive = true; throw e;
      }
    }
    auth.assertCurrent(credential);
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
    try { return { ok: true, data: await action(...args) }; }
    catch (e) { return { ok: false, code: e instanceof ToolError ? e.code : 'STORAGE', definitive: e.definitive === true,
      message: e instanceof ToolError ? e.message : '本机存储或操作失败，请保留记录并核对平台。' }; }
  });
}
app.on('second-instance', (_event, argv) => {
  if (ui) { ui.show(); ui.focus(); }
  if (!testMode && argv.includes('--admin-login')) createAdmin().then(beginAuthorization).catch(reportLoginError);
  if (!testMode && argv.includes('--admin-groups')) createAdmin().catch(() => dialog.showErrorBox('分组设置打开失败', '请重启令牌工具后再试。'));
});
app.on('before-quit', () => {
  closing = true; if (copiedKey && clipboard.readText() === copiedKey) clipboard.clear();
  feishuWorkflow?.reset(); feishuConnection?.disconnect();
});
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
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

  service.onRecordsChanged = publishRecords;
  auth = new AdminSession({ store: testMode ? { load: () => ({ token: 'fixture-only', owner: 1, origin: SITE, savedAt: new Date().toISOString() }), save() {} }
    : makeSessionStore(app.getPath('userData'), safeStorage), readCandidate: testMode ? async () => 'fixture-only' : readPlatformToken,
    verify: testMode ? async () => Number((await fixture.request('GET', '/auth/me')).id)
      : async token => Number((await fetchPlatform(token, 'GET', '/auth/me'))?.id),
    flush: testMode ? async () => {} : flushPlatformSession,
    openLogin: testMode ? async () => {} : async () => { createLogin(true); await ensureSessionReady(); }, onChange: publishAuth });
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
  service.onCreateFailure = row => { failureLog.append(row); publishFeishuState(); };
  feishuWorkflow = new FeishuBotWorkflow({ getPolicy: () => feishuPolicy, service, registrationService, connection: feishuConnection,
    sendText: message => {
      if (!feishuConnection?.client || typeof feishuConnection.client.sendText !== 'function') throw new Error('connection unavailable');
      return feishuConnection.client.sendText(message);
    }, sendCard: message => {
      if (!feishuConnection?.client || typeof feishuConnection.client.sendCard !== 'function') throw new Error('connection unavailable');
      return feishuConnection.client.sendCard(message);
    }, onCandidate: () => publishFeishuState() });
  setInterval(() => feishuWorkflow.pruneTransientState(), 30000).unref();
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
  register('admin-auth-state', () => auth.state(), true);
  register('admin-login', beginAuthorization, true);
  register('admin-recover-authorization', recoverAuthorization, true);
  register('admin-complete-login', completeAuthorization, true);
  register('admin-refresh', async () => { try { await service.refresh(); return service.adminState(); } finally { publishState(); } }, true);
  register('admin-save-groups', async input => { try { return await service.saveGroupNames(input); } finally { publishState(); } }, true);
  register('admin-registration-records', page => { if (!registrationService) throw new ToolError('STORAGE', '注册账本无法读取，注册已关闭；请保留原文件检查。'); return registrationService.adminRecords(page); }, true);
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
  register('admin-records', input => service.adminRecords(input), true);
  register('admin-record', id => service.adminRecord(id), true);
  register('admin-secret', id => service.adminSecret(id), true);
  register('admin-copy-secret', id => copySecret(service.adminSecret(id, 'copy')), true);
  register('admin-feishu-state', () => feishuAdminState(), true);
  register('admin-feishu-save-credentials', async input => {
    await assertFeishuAdmin();
    if (feishuConnection.state().active) throw new ToolError('BUSY', '请先断开飞书连接，再修改配置。');
    let credentials;
    try { credentials = validateCredentials(input); }
    catch { throw new ToolError('INPUT', '请填写有效的飞书 App ID 和 App Secret，仅在本机密码框输入。'); }
    // Changing an application invalidates every identity/group binding, even if
    // writing the new credentials fails. Never transfer policy to a new App ID.
    saveFeishuPolicy(emptyPolicy());
    try { feishuConnection.save(credentials); }
    catch (e) { throw new ToolError(['INPUT','BUSY'].includes(e.code) ? e.code : 'STORAGE', e.message); }
    publishFeishuState(); return feishuAdminState();
  }, true);
  register('admin-feishu-connect', async () => { await assertFeishuAdmin(); const result = feishuConnection.connect(); publishFeishuState(); return feishuAdminState(); }, true);
  register('admin-feishu-disconnect', async () => { await assertFeishuAdmin(); feishuWorkflow.reset(); feishuConnection.disconnect(); publishFeishuState(); return feishuAdminState(); }, true);
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
  if (!testMode && adminLoginMode) {
    // The initial customer refresh may still be verifying the previous session.
    if (service.refreshing) await service.refreshing.catch(() => {});
    await beginAuthorization().catch(reportLoginError);
  }
  if (testMode) await require('./test-fixture').verifyUI({ app, ui, fixture, registrationService,
    openAdminWindow: createAdmin, openPlatformWindow: createLogin, getPlatformWindow: () => login, apiSession, auth, request });
}).catch(() => { dialog.showErrorBox('令牌工具启动失败', '无法读取本机操作记录、分组配置或安全存储。请保留应用数据，不要重复创建令牌。'); app.exit(1); });
