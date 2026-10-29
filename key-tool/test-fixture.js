'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ToolError } = require('./service');
const { BrowserWindow, ipcMain } = require('electron');
function makeFixture({ admin = false } = {}) {
  const calls = []; let fail = false, authFail = false, rows = [], catalogRows = [];
  return { calls, setFail: v => { fail = v; }, setAuthFail: v => { authFail = v; },
    catalog: { load: () => structuredClone(catalogRows), save: r => { catalogRows = structuredClone(r); } },
    store: { load: () => rows, save: r => { rows = structuredClone(r); }, seal: v => JSON.stringify(v), open: JSON.parse },
    request: async (method, route, body) => {
      calls.push({ method, route, body });
      if (route === '/auth/me') {
        if (authFail) throw new ToolError('AUTH', '服务授权已失效，请联系管理员维护。');
        return { id: 1, ...(admin ? { role: 'admin' } : {}) };
      }
      if (route === '/groups/available') return [
        { id: 7, name: '通用对话 · OpenAI', platform: 'openai', rate_multiplier: 1, description: '用于单元测试的虚构分组，未连接真实平台。' },
        { id: 9, name: '<img src=x onerror=alert(1)>', platform: 'anthropic', rate_multiplier: 1.2, description: '不可信名称必须按纯文本展示。' },
        { id: 11, name: '未发布原始分组', platform: 'internal', description: '客户不可见' } ];
      if (method === 'POST') { if (fail) throw new Error('fixture timeout');
        if (route === '/admin/users') return { ...body, id: 100 };
        return { id: 44, key: 'sk-fixture-only-not-real' }; }
      throw new Error('unexpected request');
    } };
}
async function verifyUI({ app, ui, fixture, registrationService, openAdminWindow, openPlatformWindow, getPlatformWindow, apiSession, auth, request }) {
  const watchdog = setTimeout(() => app.exit(2), 45000);
  const run = text => ui.webContents.executeJavaScript(text);
  const delay = () => new Promise(r => setTimeout(r, 70));
  const wait = async expr => { for (let i = 0; i < 100; i++) { if (await run(expr)) return; await delay(); } throw new Error('UI wait timeout: ' + expr); };
  const errors = [];
  ui.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  ui.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_d, callback) => callback({ cancel: true }));
  try {
    await run('window.confirm=()=>true;void 0');
    await wait('document.getElementById("connection").textContent.includes("已就绪") && !document.getElementById("refresh").disabled');
    assert.equal(await run('document.querySelectorAll(".group").length'), 0);
    assert.equal(await run('typeof window.groupAdmin'), 'undefined');
    const deniedAdmin = await run('window.keyTool.create({requestId:crypto.randomUUID(),groupId:7,quota:1})');
    assert.equal(deniedAdmin.ok, false);
    assert.equal(fixture.calls.filter(c => c.method === 'POST' && c.route === '/keys').length, 0);
    assert.equal(fixture.calls.filter(c => c.route === '/groups/available').length, 1);
    assert.equal(await run('document.querySelectorAll("#login,#forget").length'), 0);
    assert.equal(await run('typeof window.keyTool.login'), 'undefined');
    assert.equal(await run('typeof window.keyTool.forget'), 'undefined');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    const admin = await openAdminWindow();
    const adminRun = text => admin.webContents.executeJavaScript(text);
    const adminWait = async expr => { for (let i = 0; i < 100; i++) { if (await adminRun(expr)) return; await delay(); }
      const status = await adminRun('JSON.stringify({auth:document.getElementById("auth-status").textContent,notice:document.getElementById("admin-notice").textContent,disabled:document.getElementById("admin-save").disabled,rows:document.querySelectorAll("[data-group-id]").length})');
      throw new Error('admin UI wait timeout: ' + expr + ' status: ' + status); };
    await adminWait('document.querySelectorAll("[data-group-id]").length===3 && !document.getElementById("admin-save").disabled');
    assert.equal(await adminRun('typeof window.keyTool'), 'undefined');
    // Exercise registered main-process guards using the actual windows/frames.
    // The private handler map is used only by this isolated test, never production logic.
    const customerEvent = { sender: ui.webContents, senderFrame: ui.webContents.mainFrame };
    const adminEvent = { sender: admin.webContents, senderFrame: admin.webContents.mainFrame };
    for (const name of ['admin-state', 'admin-refresh', 'admin-save-groups', 'admin-auth-state', 'admin-login', 'admin-complete-login',
      'admin-records', 'admin-record', 'admin-secret', 'admin-copy-secret', 'admin-recover-authorization',
      'admin-feishu-save-credentials', 'admin-feishu-state', 'admin-registration-records', 'admin-registration-review']) {
      const denied = await ipcMain._invokeHandlers.get('key-tool:' + name)(customerEvent, { owner: 1, items: [] });
      assert.equal(denied.code, 'DENIED');
      assert.equal((await ipcMain._invokeHandlers.get('key-tool:' + name)({ ...adminEvent,
        senderFrame: { url: admin.webContents.mainFrame.url } }, {})).code, 'DENIED');
    }
    assert.equal((await ipcMain._invokeHandlers.get('key-tool:state')(adminEvent)).code, 'DENIED');
    assert.equal(await adminRun('document.getElementById("bot-app-secret").type'), 'password');
    await adminWait('document.getElementById("registration-rows").textContent.includes("暂无注册记录")');
    assert.equal(await run('typeof window.keyTool.registrationRecords'), 'undefined');
    assert.equal(await adminRun('document.getElementById("admin-recover").hidden'), true);
    assert.equal((await ipcMain._invokeHandlers.get('key-tool:admin-recover-authorization')(adminEvent)).code, 'STORAGE');
    // This fixture injects service requests, bypassing production's auth adapter.
    // First verification invalidates stale owner state; explicitly reload it as the real UI does.
    await auth.ensure();
    await adminRun('document.getElementById("admin-refresh").click()');
    await adminWait('document.querySelectorAll("[data-group-id]").length===3 && !document.getElementById("admin-save").disabled');
    const invalidBot = await adminRun('window.groupAdmin.feishuSaveCredentials({appId:"invalid",appSecret:"fixture-only-secret"})');
    assert.equal(invalidBot.code, 'INPUT');
    // Native confirmation can blur the window. Read/clear the password before confirmation.
    await adminRun('window.confirm=()=>{window.dispatchEvent(new Event("blur"));return true};document.getElementById("bot-app-id").value="cli_1234567890abcdef";document.getElementById("bot-app-secret").value="fixture-only-secret";document.getElementById("bot-credentials-form").dispatchEvent(new Event("submit",{cancelable:true}))');
    await adminWait('document.getElementById("bot-notice").textContent.includes("配置已在业务工具加密保存")');
    assert.equal(await adminRun('document.getElementById("bot-app-secret").value'), '');
    const botSave = await adminRun('window.groupAdmin.feishuState()');
    assert.equal(botSave.ok, true);
    assert.equal(JSON.stringify(botSave).includes('fixture-only-secret'), false);
    assert.equal(botSave.data.connection.hasCredential, true);
    assert.equal(botSave.data.enabled, false);
    await adminRun('window.confirm=()=>false;document.getElementById("bot-app-secret").value="cancelled-fixture";document.getElementById("bot-credentials-form").dispatchEvent(new Event("submit",{cancelable:true}))');
    assert.equal(await adminRun('document.getElementById("bot-app-secret").value'), '');
    assert.equal((await adminRun('window.groupAdmin.feishuState()')).data.connection.savedAt, botSave.data.connection.savedAt);
    await adminRun('document.getElementById("bot-app-secret").value="blur-fixture";window.dispatchEvent(new Event("blur"))');
    assert.equal(await adminRun('document.getElementById("bot-app-secret").value'), '');
    await adminRun('window.confirm=()=>true;void 0');
    assert.equal((await ipcMain._invokeHandlers.get('key-tool:admin-state')({ ...adminEvent,
      senderFrame: { url: admin.webContents.mainFrame.url } })).code, 'DENIED');
    assert.equal(await adminRun('document.querySelectorAll("#catalog-rows img").length'), 0);
    await adminRun('document.getElementById("alias-7").value="客户专享通道";document.getElementById("alias-9").value="<img src=x onerror=alert(1)>";document.getElementById("catalog-form").dispatchEvent(new Event("submit",{cancelable:true}))');
    await adminWait('document.getElementById("admin-notice").textContent.includes("已保存") && !document.getElementById("admin-save").disabled');
    await wait('document.querySelectorAll(".group").length===2');
    // Background authorization status cannot erase a group-name draft or replace its DOM node.
    await adminRun('document.getElementById("alias-7").value="未保存草稿";document.getElementById("alias-7").dispatchEvent(new Event("input"));window.draftNode=document.getElementById("alias-7")');
    admin.webContents.send('key-tool:admin-auth', { phase: 'checking' }); await delay();
    assert.equal(await adminRun('document.getElementById("alias-7")===window.draftNode && window.draftNode.value==="未保存草稿"'), true);
    admin.webContents.send('key-tool:admin-auth', auth.state()); await delay();
    await adminRun('window.confirm=()=>true;document.getElementById("admin-login").click()');
    await adminWait('document.getElementById("auth-status").textContent.includes("等待管理员登录") && !document.getElementById("admin-complete-login").disabled');
    await wait('document.querySelectorAll(".group").length===0');
    assert.equal((await adminRun('window.groupAdmin.authState()')).data.owner, null);
    await adminRun('document.getElementById("admin-complete-login").click()');
    await adminWait('document.getElementById("auth-status").textContent.includes("已验证") && !document.getElementById("admin-save").disabled');
    assert.equal(await adminRun('document.getElementById("alias-7").value'), '客户专享通道');
    assert.equal(JSON.stringify((await adminRun('window.groupAdmin.authState()')).data).includes('fixture-only'), false);
    assert.equal(await run('typeof window.keyTool.login'), 'undefined');
    await wait('document.querySelectorAll(".group").length===2');
    assert.equal(await run('document.getElementById("groups").textContent.includes("通用对话 · OpenAI")'), false);
    assert.equal(await run('document.getElementById("groups").textContent.includes("未发布原始分组")'), false);
    assert.equal(await run('document.querySelector(".group strong").textContent'), '客户专享通道');
    assert.deepEqual((await run('window.keyTool.state()')).data.groups.map(g => Object.keys(g).sort()), [['id','name'], ['id','name']]);
    // A selected group must be cleared immediately when the administrator unpublishes it.
    await run('document.querySelector(".group").click()');
    await adminRun('document.getElementById("alias-7").value="";document.getElementById("catalog-form").dispatchEvent(new Event("submit",{cancelable:true}))');
    await adminWait('document.getElementById("admin-notice").textContent.includes("已保存") && !document.getElementById("admin-save").disabled');
    await wait('document.querySelectorAll(".group").length===1');
    assert.equal(await run('document.getElementById("selected").value'), '请先点击左侧分组');
    assert.equal(await run('document.getElementById("create").disabled'), true);
    await adminRun('document.getElementById("alias-7").value="客户专享通道";document.getElementById("catalog-form").dispatchEvent(new Event("submit",{cancelable:true}))');
    await adminWait('document.getElementById("admin-notice").textContent.includes("已保存") && !document.getElementById("admin-save").disabled');
    await wait('document.querySelectorAll(".group").length===2');
    let adminScreenshotCaptured = false;
    const adminOut = path.join(__dirname, '..', 'outputs'); fs.mkdirSync(adminOut, { recursive: true });
    assert.equal(await adminRun('document.getElementById("publish-count").textContent'), '2 个待发布 · 1 个隐藏');
    try {
      admin.show(); admin.focus(); admin.webContents.invalidate();
      await adminRun('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await new Promise(resolve => setTimeout(resolve, 250));
      fs.writeFileSync(path.join(adminOut, 'key-tool-admin-fixture.png'), (await admin.webContents.capturePage()).toPNG()); adminScreenshotCaptured = true;
    } catch { /* report separately */ }
    admin.setSize(480, 850); await delay();
    assert.equal(await adminRun('document.documentElement.scrollWidth<=innerWidth'), true);
    admin.close();
    assert.equal(await run('document.getElementById("groups").querySelectorAll("img").length'), 0);
    assert.equal(await run('document.getElementById("create").disabled'), true);
    await run('document.querySelector(".group").click()');
    await run('document.getElementById("form").dispatchEvent(new Event("submit",{cancelable:true}))');
    assert.equal(fixture.calls.filter(c => c.method === 'POST' && c.route === '/keys').length, 0);
    await run('document.getElementById("quota").value="5.5";document.getElementById("form").dispatchEvent(new Event("submit",{cancelable:true}))');
    assert.equal(fixture.calls.filter(c => c.method === 'POST' && c.route === '/keys').length, 0);
    await run('document.getElementById("operator").value="模拟客户A <img src=x onerror=alert(1)>"');
    await run('document.getElementById("quota").value="5.5";document.getElementById("form").dispatchEvent(new Event("submit",{cancelable:true}));document.getElementById("form").dispatchEvent(new Event("submit",{cancelable:true}))');
    await wait('!document.getElementById("result").hidden && !document.getElementById("quota").disabled');
    assert.equal(fixture.calls.filter(c => c.method === 'POST' && c.route === '/keys').length, 1);
    assert.equal(await run('document.getElementById("secret").type'), 'password');
    await run('document.getElementById("reveal").click()');
    assert.equal(await run('document.getElementById("secret").type'), 'text');
    await run('document.getElementById("hide-key").click()');
    assert.equal(await run('document.getElementById("secret").type'), 'password');
    const historyAdmin = await openAdminWindow();
    const historyRun = text => historyAdmin.webContents.executeJavaScript(text);
    const historyWait = async expr => { for (let i = 0; i < 100; i++) { if (await historyRun(expr)) return; await delay(); } throw new Error('history UI wait timeout: ' + expr); };
    await historyWait('document.querySelectorAll("[data-record-id]").length===1 && !document.getElementById("history-refresh").disabled');
    assert.equal(await historyRun('document.getElementById("history-rows").textContent.includes("模拟客户A <img src=x onerror=alert(1)>")'), true);
    assert.equal(await historyRun('document.getElementById("history-rows").textContent.includes("额度 5.5") && document.getElementById("history-rows").textContent.includes("Key ID 44")'), true);
    assert.equal(await historyRun('document.querySelectorAll("#history img").length'), 0);
    assert.equal(JSON.stringify((await historyRun('window.groupAdmin.records({})')).data).includes('sk-fixture-only-not-real'), false);
    await historyRun('document.getElementById("history-search").value="不存在的客户";document.getElementById("history-filter").dispatchEvent(new Event("submit",{cancelable:true}))');
    await historyWait('document.getElementById("history-rows").textContent.includes("暂无") && !document.getElementById("history-refresh").disabled');
    await historyRun('document.getElementById("history-search").value="";document.getElementById("history-status").value="failed";document.getElementById("history-filter").dispatchEvent(new Event("submit",{cancelable:true}))');
    await historyWait('document.getElementById("history-summary").textContent.includes("当前筛选 0 条") && !document.getElementById("history-refresh").disabled');
    await historyRun('document.getElementById("history-status").value="";document.getElementById("history-filter").dispatchEvent(new Event("submit",{cancelable:true}))');
    await historyWait('document.querySelectorAll("[data-record-id]").length===1 && !document.getElementById("history-refresh").disabled');
    await historyRun('document.querySelector("[data-record-id]").click()');
    await historyWait('!document.getElementById("history-reveal").disabled');
    assert.equal(await historyRun('document.getElementById("history-key").value'), '');
    assert.equal(await historyRun('document.getElementById("history-fields").textContent.includes("通用对话 · OpenAI") && document.getElementById("history-fields").textContent.includes("客户专享通道") && document.getElementById("history-fields").textContent.includes("未核验")'), true);
    await historyRun('document.getElementById("alias-7").value="记录刷新不得抹掉的草稿";window.confirm=()=>true;void 0');
    historyAdmin.show(); historyAdmin.focus();
    await historyWait('document.hasFocus()');
    await historyRun('document.getElementById("history-reveal").click()');
    await historyWait('document.getElementById("history-key").value.length>0 && !document.getElementById("history-reveal").disabled');
    assert.equal(await historyRun('document.getElementById("history-key").value'), 'sk-fixture-only-not-real');
    assert.equal(await historyRun('document.getElementById("history-events").textContent.includes("本机管理员显示密钥")'), true);
    await historyRun('document.getElementById("history-reveal").click()');
    assert.equal(await historyRun('document.getElementById("history-key").value'), '');
    // A late IPC reply after blur must not put a secret back into the page.
    await historyRun('document.getElementById("history-reveal").click();window.dispatchEvent(new Event("blur"))');
    await historyWait('document.querySelectorAll("#history-events li").length===4 && !document.getElementById("history-reveal").disabled');
    assert.equal(await historyRun('document.getElementById("history-key").value'), '');
    assert.equal(await historyRun('document.getElementById("history-notice").textContent.includes("保持隐藏")'), true);
    await historyWait('!document.getElementById("history-refresh").disabled');
    assert.equal(await historyRun('document.getElementById("alias-7").value'), '记录刷新不得抹掉的草稿');
    let historyScreenshotCaptured = false;
    try {
      historyAdmin.webContents.invalidate();
      await historyRun('document.getElementById("history").scrollIntoView();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await new Promise(resolve => setTimeout(resolve, 250));
      fs.writeFileSync(path.join(adminOut, 'key-tool-admin-history-fixture.png'), (await historyAdmin.webContents.capturePage()).toPNG()); historyScreenshotCaptured = true;
    } catch { /* separately reported, not a substitute for DOM assertions */ }
    historyAdmin.setSize(480, 850); await delay();
    assert.equal(await historyRun('document.documentElement.scrollWidth<=innerWidth'), true);
    await historyRun('document.getElementById("history-close").click()');
    assert.equal(await historyRun('document.getElementById("history-detail").hidden && !document.getElementById("history-key").value'), true);
    historyAdmin.close();
    const denied = await ui.webContents.executeJavaScript(`window.keyTool.create({requestId:crypto.randomUUID(),groupId:7,quota:0})`);
    assert.equal(denied.ok, false);
    const out = path.join(__dirname, '..', 'outputs'); fs.mkdirSync(out, { recursive: true });
    await run('document.getElementById("result").hidden=true;window.scrollTo(0,0)');
    let screenshotCaptured = false;
    try {
      ui.show(); ui.webContents.invalidate(); await delay();
      fs.writeFileSync(path.join(out, 'key-tool-ui-fixture.png'), (await ui.webContents.capturePage()).toPNG());
      screenshotCaptured = true;
    } catch { /* compositor capture is optional; DOM/IPC assertions still required */ }
    ui.setSize(460, 900); await delay();
    assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'), true);
    await run('document.getElementById("another").click()');
    assert.equal(await run('document.getElementById("quota").value'), '');
    const liveAdmin = await openAdminWindow();
    const liveRun = text => liveAdmin.webContents.executeJavaScript(text);
    for (let i = 0; i < 100; i++) { if (await liveRun('document.querySelectorAll("[data-record-id]").length===1')) break; await delay(); }
    assert.equal(await liveRun('document.querySelectorAll("[data-record-id]").length'), 1);
    fixture.setFail(true);
    await run('document.getElementById("quota").value="3";document.getElementById("form").dispatchEvent(new Event("submit",{cancelable:true}))');
    await wait('!document.getElementById("pending").hidden && !document.getElementById("quota").disabled');
    assert.equal(await run('document.getElementById("create").disabled'), true);
    assert.equal(fixture.calls.filter(c => c.method === 'POST' && c.route === '/keys').length, 2);
    for (let i = 0; i < 100; i++) { if (await liveRun('document.querySelectorAll("[data-record-id]").length===2 && document.getElementById("history-rows").textContent.includes("结果待核对")')) break; await delay(); }
    assert.equal(await liveRun('document.querySelectorAll("[data-record-id]").length===2 && document.getElementById("history-rows").textContent.includes("结果待核对")'), true);
    for (let i = 0; i < 100; i++) {
      if (await liveRun('document.querySelectorAll("#bot-failures li").length===1')) break;
      await delay();
    }
    const failures = (await liveRun('window.groupAdmin.feishuState()')).data.createFailures;
    assert.equal(failures.items.length, 1);
    assert.equal(failures.items[0].code, 'UNKNOWN');
    assert.equal(failures.items[0].stage, 'submission');
    assert.equal(failures.storageError, false);
    assert.deepEqual(Object.keys(failures.items[0]).sort(), ['at','code','httpStatus','requestId','stage']);
    assert.equal(await liveRun('document.getElementById("bot-failures").textContent.includes("可能已发送，先核对")'), true);
    assert.equal(await liveRun('document.getElementById("bot-failures").textContent.includes("sk-fixture")'), false);
    assert.equal(fixture.calls.filter(c => c.method === 'POST' && c.route === '/keys').length, 2);
    // Registration uses a separate service/ledger; all identities below are fictional.
    fixture.setFail(false);
    const registrationContext = { verifiedActor: { name: '飞书用户#0123456789abcdef0123', source: 'feishu-open-id', verified: true },
      feishuGroupId: 'oc_fixture_12345678', guard: () => true };
    const registrationInput = () => ({ requestId: require('node:crypto').randomUUID(), email: 'fixture@example.invalid',
      password: 'fictional-password-only', username: '<img src=x onerror=alert(1)>', concurrency: 50, balance: 0 });
    for (let i = 0; i < 21; i++) await registrationService.create(registrationInput(), registrationContext);
    const waitRegistration = async expression => {
      for (let i = 0; i < 100; i++) { if (await liveRun(expression)) return; await delay(); }
      throw new Error('registration UI timeout');
    };
    await waitRegistration('document.getElementById("registration-notice").textContent.includes("共 21 条")');
    assert.equal(await liveRun('document.querySelectorAll("#registration-rows tr").length'), 20);
    assert.equal(await liveRun('document.querySelectorAll("#registration-rows img").length'), 0);
    assert.equal(await liveRun('document.getElementById("registration-rows").textContent.includes("fictional-password-only")'), false);
    assert.equal(await liveRun('document.getElementById("registration-rows").textContent.includes("<img src=x onerror=alert(1)>")'), true);
    await liveRun('document.getElementById("registration-next").click()');
    await waitRegistration('document.getElementById("registration-page").textContent.includes("第 2 / 2 页")');
    assert.equal(await liveRun('document.querySelectorAll("#registration-rows tr").length'), 1);
    await liveRun('document.getElementById("registration-prev").click()');
    await waitRegistration('document.getElementById("registration-page").textContent.includes("第 1 / 2 页")');
    fixture.setFail(true);
    await assert.rejects(registrationService.create(registrationInput(), registrationContext));
    await waitRegistration('document.getElementById("registration-notice").textContent.includes("待核对 1 条")');
    assert.equal(await liveRun('document.querySelectorAll("#registration-rows button").length'), 1);
    assert.equal(fixture.calls.filter(c => c.route === '/admin/users').length, 22);
    assert.equal(registrationService.blocked().length, 1);
    assert.equal((await liveRun('window.groupAdmin.registrationRecords(0)')).code, 'INPUT');
    liveAdmin.setSize(680, 900); await delay();
    assert.equal(await liveRun('document.documentElement.scrollWidth<=innerWidth'), true);
    liveAdmin.close();
    fixture.setAuthFail(true);
    await run('document.getElementById("refresh").click()');
    await wait('!document.getElementById("refresh").disabled && document.getElementById("notice").textContent.includes("管理员")');
    assert.equal(await run('document.getElementById("create").disabled'), true);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(fixture.calls.filter(c => c.method === 'POST' && c.route === '/keys').length, 2);
    apiSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_d, callback) => callback({ cancel: true }));
    assert.equal(await openPlatformWindow(false), false);
    const background = getPlatformWindow();
    assert.equal(background.isVisible(), false);
    await openPlatformWindow(false);
    assert.equal(getPlatformWindow(), background);
    assert.equal(await openPlatformWindow(true), false);
    const retry = getPlatformWindow();
    assert.equal(background.isDestroyed(), true);
    assert.notEqual(retry, background);
    assert.equal(retry.isVisible(), true);
    // Serve a successful page entirely inside the isolated protocol handler.
    // There is still no live HTTP(S), including during explicit retry.
    apiSession.protocol.handle('https', () => new Response('<!doctype html><title>Local authorization fixture</title>'));
    apiSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (details, callback) => callback({ cancel: !details.url.startsWith('https://max.cheapi.cc/') }));
    try {
      assert.equal(await openPlatformWindow(true), true);
      const healthy = getPlatformWindow();
      assert.equal(retry.isDestroyed(), true);
      assert.equal(healthy.isVisible(), true);
      assert.equal(await openPlatformWindow(true), true);
      assert.equal(getPlatformWindow(), healthy);
      healthy.destroy();
    } finally {
      apiSession.protocol.unhandle('https');
      apiSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_d, callback) => callback({ cancel: true }));
    }
    // Exercise the real request adapter with a mocked transport, never the real platform.
    fixture.setAuthFail(false);
    const transport = [], originalFetch = apiSession.fetch;
    const registrationTransport = [];
    let adapterRole = 'admin', adapterStatus = 200;
    apiSession.fetch = async (url, options) => {
      registrationTransport.push({ path: new URL(url).pathname, method: options.method });
      assert.equal(options.headers.Authorization, 'Bearer fixture-only');
      assert.equal(options.credentials, 'omit');
      if (options.method === 'POST') {
        assert.equal(new URL(url).pathname, '/api/v1/admin/users');
        const body = JSON.parse(options.body);
        assert.equal(body.role, 'user'); assert.equal(body.concurrency, 50); assert.equal(body.balance, 10);
        assert.equal(body.password, 'fictional-adapter-password');
        return { ok: adapterStatus === 200, status: adapterStatus, json: async () => ({ code: 0, data: { ...body, id: 101 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1, role: adapterRole } }) };
    };
    try {
      const body = require('./user-registration-service').registrationBody({ requestId: require('node:crypto').randomUUID(),
        email: 'fixture@example.invalid', password: 'fictional-adapter-password', username: 'Fixture', concurrency: 50, balance: 10 });
      const context = { owner: 1, guard: () => true };
      await assert.rejects(request('POST', '/admin/users', { ...body, role: 'admin' }, context), { code: 'INPUT' });
      assert.equal(registrationTransport.length, 0);
      adapterRole = 'user';
      await assert.rejects(request('POST', '/admin/users', body, context), { code: 'DENIED', definitive: true });
      adapterRole = 'admin';
      await assert.rejects(request('POST', '/admin/users', body, { owner: 1, guard: () => false }), { code: 'POLICY', definitive: true });
      assert.equal(registrationTransport.filter(c => c.method === 'POST').length, 0);
      const result = await request('POST', '/admin/users', body, context);
      assert.equal(result.id, 101);
      adapterStatus = 403;
      await assert.rejects(request('POST', '/admin/users', body, context), { code: 'HTTP', definitive: true });
      assert.equal(registrationTransport.filter(c => c.method === 'POST').length, 2);
    } finally { apiSession.fetch = originalFetch; }
    apiSession.fetch = async (url, options) => {
      transport.push({ path: new URL(url).pathname, method: options.method });
      assert.equal(options.headers.Authorization, 'Bearer fixture-only');
      assert.equal(options.credentials, 'omit');
      const denied = options.method === 'POST';
      return { ok: !denied, status: denied ? 401 : 200, json: async () => ({ code: 0, data: url.endsWith('/auth/me') ? { id: 1 } : [] }) };
    };
    try {
      const before = BrowserWindow.getAllWindows().length;
      await request('GET', '/groups/available');
      assert.equal(BrowserWindow.getAllWindows().length, before);
      await assert.rejects(request('GET', '/unapproved-route'), { code: 'ROUTE' });
      await assert.rejects(request('POST', '/keys', { quota: 1 }, { owner: 1 }), { code: 'AUTH', definitive: true });
      assert.equal(auth.phase, 'expired');
      assert.equal(transport.filter(call => call.method === 'POST').length, 1);
      await assert.rejects(request('POST', '/keys', { quota: 1 }, { owner: 1 }), { code: 'AUTH' });
      assert.equal(transport.filter(call => call.method === 'POST').length, 1);
      assert.equal(BrowserWindow.getAllWindows().length, before);
      assert.equal((await run('window.keyTool.state()')).data.connected, false);
    } finally { apiSession.fetch = originalFetch; }
    assert.deepEqual(errors, []);
    const report = { mode: 'real Electron + injected fictional API', realNetworkRequests: 0, realCreationRequests: 0,
      screenshotCaptured, adminScreenshotCaptured, historyScreenshotCaptured, checks: ['group selection','mandatory quota','mandatory self-reported operator','double click single POST','masked result','reveal/hide','unsafe group name escaped',
        'default deny unnamed groups','customer projection has no original metadata','admin edits aliases in isolated window',
        'saving updates customer immediately','unpublishing clears selection','admin narrow layout','customer cannot access admin bridge',
        'registered IPC guards reject cross-window and non-main-frame senders',
        'registration admin IPC denies customer and non-main frame; empty list, 21-row pagination and escaped metadata',
        'registration unknown shows manual review; separate ledger and no password in renderer; narrow layout',
        'real registration adapter enforces exact body, current admin role and policy; no retry on mocked 403',
        'business bot password form survives confirmation blur and clears secrets',
        'cancel and standalone blur clear bot password without saving',
        'invalid bot credentials rejected before policy change; saving does not connect or enable',
        'administrator login and encrypted-save UI flow with fictional credentials','authorization events preserve unsaved aliases',
        'authorization metadata never exposes access token','saved bearer transport does not load browser',
        'admin creation history list search status and detail','operator escaped and explicitly unverified','creation-time group snapshots and quota',
        'history list never decrypts full key','administrator reveal audited and hide empties field','history updates preserve unsaved group draft',
        'history narrow layout and detail close clears key',
        'late reveal response after blur remains hidden','new uncertain creation automatically appears in open history',
        'real request adapter revokes on mocked 401 without popup or POST retry',
        'failure telemetry reaches admin IPC and DOM without secrets or automatic replay',
        'main process validation','narrow layout','next creation clears quota','timeout blocks new creation',
        'automatic group loading','no user login controls or IPC','expired authorization contacts administrator without popup',
        'background session remains hidden','explicit admin retries failed page with a new window',
        'successful platform window is reused without reloading'], passed: true };
    fs.writeFileSync(path.join(out, 'key-tool-ui-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error(e.message); clearTimeout(watchdog); app.exit(1); }
}
module.exports = { makeFixture, verifyUI };
