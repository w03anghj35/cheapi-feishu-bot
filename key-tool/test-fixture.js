'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ToolError } = require('./service');
const { BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const { makeChannelLoginStore } = require('./channel-login-store');
const { makeAlertStore } = require('./channel-alert');
function makeFixture({ admin = false } = {}) {
  const calls = []; let fail = false, authFail = false, rows = [], catalogRows = [], groupWait = null;
  const accounts = [
    { id: 31, name: '虚构渠道甲', platform: 'openai', status: 'active', schedulable: false },
    { id: 32, name: '虚构渠道乙', platform: 'openai', status: 'active', schedulable: true }
  ];
  return { calls, setFail: v => { fail = v; }, setAuthFail: v => { authFail = v; },
    setGroupWait: promise => { groupWait=promise; },
    catalog: { load: () => structuredClone(catalogRows), save: r => { catalogRows = structuredClone(r); } },
    store: { load: () => rows, save: r => { rows = structuredClone(r); }, seal: v => JSON.stringify(v), open: JSON.parse },
    request: async (method, route, body) => {
      calls.push({ method, route, body });
      if(route.startsWith('/admin/groups?')&&groupWait)await groupWait;
      if (route === '/auth/me') {
        if (authFail) throw new ToolError('AUTH', '服务授权已失效，请联系管理员维护。');
        return { id: 1, ...(admin ? { role: 'admin' } : {}) };
      }
      if (route === '/groups/available') return [
        { id: 7, name: '通用对话 · OpenAI', platform: 'openai', rate_multiplier: 1, description: '用于单元测试的虚构分组，未连接真实平台。' },
        { id: 9, name: '<img src=x onerror=alert(1)>', platform: 'anthropic', rate_multiplier: 1.2, description: '不可信名称必须按纯文本展示。' },
        { id: 11, name: '未发布原始分组', platform: 'internal', description: '客户不可见' } ];
      if (route.startsWith('/admin/groups?')) return { items: [
        { id: 7, name: '倍率专属测试分组', platform: 'openai', rate_multiplier: 1, is_exclusive: true, subscription_type: 'standard', status: 'active' },
        { id: 9, name: '<img src=x onerror=alert(1)>', platform: 'anthropic', rate_multiplier: 2, is_exclusive: false, subscription_type: 'standard', status: 'active' }
      ], total: 2 };
      if (method === 'GET' && /^\/admin\/usage\/stats\?user_id=\d+&start_date=\d{4}-\d{2}-\d{2}&end_date=\d{4}-\d{2}-\d{2}$/.test(route))
        return { total_actual_cost: 1.25, total_cost: 2.5, total_requests: 3 };
      if (method === 'GET' && /^\/admin\/accounts\?page=\d+&page_size=100$/.test(route))
        return { items: structuredClone(accounts), total: accounts.length };
      if (method === 'GET' && /^\/admin\/accounts\/\d+$/.test(route)) {
        const account = accounts.find(a => a.id === Number(route.split('/').at(-1)));
        if (!account) throw new ToolError('HTTP', '虚构账号不存在。');
        return structuredClone(account);
      }
      if (method === 'POST' && /^\/admin\/accounts\/\d+\/schedulable$/.test(route)) {
        const account = accounts.find(a => a.id === Number(route.split('/')[3]));
        if (!account || typeof body?.schedulable !== 'boolean') throw new ToolError('INPUT', '虚构开关参数无效。');
        account.schedulable = body.schedulable; return structuredClone(account);
      }
      if (method === 'GET' && /^\/admin\/users\?page=\d+&page_size=100$/.test(route)) return { items: [
        { id: 8, email: 'alice@example.invalid', username: 'Alice', role: 'user', status: 'active', balance: 1, concurrency: 2 },
        { id: 9, email: 'bob@example.invalid', username: 'Bob', role: 'user', status: 'active', balance: 5, concurrency: 1 }
      ], total: 2 };
      if (method === 'POST') { if (fail) throw new Error('fixture timeout');
        if (route === '/admin/users') return { ...body, id: 100 };
        return { id: 44, key: 'sk-fixture-only-not-real' }; }
      throw new Error('unexpected request');
    } };
}
async function verifyUI({ app, ui, fixture, registrationService, tokenService, userOwnership, memberNames, accountSchedule, channelMonitor, dailyUsagePublisher, openAdminWindow, openPlatformWindow, getPlatformWindow, apiSession, auth, request }) {
  const watchdog = setTimeout(() => { console.error('隔离界面测试超过45秒，未完成验收。'); app.exit(2); }, 45000);
  const run = text => ui.webContents.executeJavaScript(text);
  const delay = () => new Promise(r => setTimeout(r, 70));
  const wait = async expr => { for (let i = 0; i < 100; i++) { if (await run(expr)) return; await delay(); } throw new Error('UI wait timeout: ' + expr); };
  const errors = [];
  ui.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  ui.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_d, callback) => callback({ cancel: true }));
  try {
    const loginDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'channel-login-fixture-'));
    try {
      const credential = { email: 'fictional@example.invalid', password: 'fixture-only-secret-not-real' };
      const vault = makeChannelLoginStore(loginDir, safeStorage); vault.load(); vault.save(credential);
      const raw = fs.readFileSync(path.join(loginDir, 'aerorelay-login.journal'), 'utf8');
      assert.equal(raw.includes(credential.email) || raw.includes(credential.password), false);
      const reopened = makeChannelLoginStore(loginDir, safeStorage); reopened.load();
      assert.deepEqual(reopened.claim(), credential);
      const interrupted = makeChannelLoginStore(loginDir, safeStorage); interrupted.load();
      assert.equal(interrupted.state().enabled, false);
      reopened.resume(credential); reopened.clear();
    } finally { fs.rmSync(loginDir, { recursive: true, force: true }); }
    const alertDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'channel-alert-fixture-'));
    try {
      const vault = makeAlertStore(alertDir, safeStorage); vault.load();
      vault.configure({ from: 'fixture@qq.com', authCode: 'fixture-only-smtp-code-not-real',
        recipients: 'one@example.invalid,two@example.invalid' });
      const raw = fs.readFileSync(path.join(alertDir, 'channel-alert.journal'), 'utf8');
      assert.equal(raw.includes('fixture-only-smtp-code-not-real') || raw.includes('one@example.invalid'), false);
      const reopened = makeAlertStore(alertDir, safeStorage); reopened.load();
      assert.equal(reopened.state().enabled, true);
      assert.equal(reopened.state().recipients.length, 2);
      reopened.clear(); assert.equal(fs.existsSync(path.join(alertDir, 'channel-alert.journal')), false);
    } finally { fs.rmSync(alertDir, { recursive: true, force: true }); }
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
    const navigate = view => adminRun(`document.querySelector('[data-admin-target="${view}"]').click()`);
    const adminWait = async expr => { for (let i = 0; i < 100; i++) { if (await adminRun(expr)) return; await delay(); }
      const status = await adminRun('JSON.stringify({auth:document.getElementById("auth-status").textContent,notice:document.getElementById("admin-notice").textContent,disabled:document.getElementById("admin-save").disabled,rows:document.querySelectorAll("[data-group-id]").length,channel:document.querySelector("#aerorelay-auto-login .auto-login-status")?.textContent})');
      throw new Error('admin UI wait timeout: ' + expr + ' status: ' + status); };
    await adminWait('document.querySelectorAll("[data-group-id]").length===3 && !document.getElementById("admin-save").disabled');
    assert.equal(await adminRun('document.getElementById("admin-view-title").textContent'), '管理配置');
    assert.equal(await adminRun('document.querySelectorAll("[data-admin-target]").length'), 11);
    for (const view of ['configuration','token-groups','group-settings','token-history','registration-history','operation-log','channel-monitor','channel-access','user-ownership','account-management','usage-history']) {
      await navigate(view);
      assert.equal(await adminRun(`Array.from(document.querySelectorAll('[data-admin-view]')).every(p=>p.hidden===(p.dataset.adminView!=='${view}')&&p.inert===p.hidden)`), true);
      assert.equal(await adminRun('document.querySelectorAll("[data-admin-target][aria-current=page]").length'), 1);
    }
    await navigate('configuration');
    assert.equal(await adminRun('typeof window.keyTool'), 'undefined');
    // Exercise registered main-process guards using the actual windows/frames.
    // The private handler map is used only by this isolated test, never production logic.
    const customerEvent = { sender: ui.webContents, senderFrame: ui.webContents.mainFrame };
    const adminEvent = { sender: admin.webContents, senderFrame: admin.webContents.mainFrame };
    await adminRun('document.querySelector(".brand").click()');
    await adminWait('location.hash === "#main"');
    assert.equal((await adminRun('window.groupAdmin.authState()')).ok, true,
      'same-file anchor must not disable the admin IPC bridge');
    for (const name of ['admin-state', 'admin-refresh', 'admin-save-groups', 'admin-auth-state', 'admin-login', 'admin-complete-login',
      'admin-records', 'admin-record', 'admin-secret', 'admin-copy-secret', 'admin-recover-authorization',
      'admin-feishu-save-credentials', 'admin-feishu-state', 'admin-registration-records', 'admin-registration-review',
      'admin-group-settings-refresh', 'admin-group-settings-save', 'admin-group-settings-records', 'admin-group-settings-review', 'admin-operation-log', 'admin-record-table-sync','admin-record-table-open',
      'admin-user-ownership-list', 'admin-user-ownership-save', 'admin-user-ownership-save-name',
      'admin-user-ownership-client-change',
      'admin-user-ownership-link',
      'admin-user-ownership-draft-state', 'admin-user-ownership-draft-save',
      'admin-daily-usage-state', 'admin-daily-usage-preview', 'admin-daily-usage-enable',
      'admin-daily-usage-pause', 'admin-daily-usage-now', 'admin-daily-usage-review-absent',
      'admin-daily-usage-history-catalog', 'admin-daily-usage-history-week', 'admin-daily-usage-history-export',
      'admin-daily-usage-collect-today',
      'admin-daily-usage-backfill-status', 'admin-daily-usage-backfill-current-month',
      'admin-account-schedule-snapshot', 'admin-account-schedule-state', 'admin-account-schedule-create',
      'admin-account-schedule-cancel', 'admin-account-schedule-reconcile',
      'admin-channel-monitor-state','admin-channel-monitor-rename','admin-channel-monitor-open','admin-channel-monitor-check',
      'admin-channel-access-state','admin-channel-access-save','admin-channel-access-update','admin-channel-access-revoke','admin-channel-access-preview',
      'admin-channel-alert-state','admin-channel-alert-save','admin-channel-alert-pause','admin-channel-alert-clear','admin-channel-alert-test',
      'admin-channel-login-state','admin-channel-login-save','admin-channel-login-pause','admin-channel-login-clear']) {
      const denied = await ipcMain._invokeHandlers.get('key-tool:' + name)(customerEvent, { owner: 1, items: [] });
      assert.equal(denied.code, 'DENIED');
      assert.equal((await ipcMain._invokeHandlers.get('key-tool:' + name)({ ...adminEvent,
        senderFrame: { url: admin.webContents.mainFrame.url } }, {})).code, 'DENIED');
    }
    assert.equal((await ipcMain._invokeHandlers.get('key-tool:state')(adminEvent)).code, 'DENIED');
    assert.equal(await adminRun('document.getElementById("bot-app-secret").type'), 'password');
    await auth.ensure();
    await adminRun('document.getElementById("admin-refresh").click()');
    await adminWait('document.querySelectorAll("[data-group-id]").length===3 && !document.getElementById("admin-save").disabled');
    await navigate('user-ownership');
    await adminRun('document.getElementById("ownership-refresh").click()');
    await adminWait('document.getElementById("ownership-notice").textContent.includes("已读取") || document.getElementById("ownership-notice").textContent.includes("读取失败") || document.getElementById("ownership-notice").textContent.includes("授权可能")');
    assert.equal(await adminRun('document.getElementById("ownership-notice").textContent'),
      '已读取 2 个平台用户、0 个姓名档案、0 个已登记飞书身份。 飞书未连接或目标群未就绪，暂不能同步当前群显示名；可用私聊身份摘要核对。');
    assert.equal(await adminRun('document.getElementById("ownership-query-rows").textContent'), '暂无查询记录。');
    await adminRun('document.getElementById("ownership-search").value="alice";document.getElementById("ownership-search").dispatchEvent(new Event("input"))');
    assert.equal(await adminRun('document.querySelectorAll("#ownership-users .ownership-user").length'), 1);
    await adminRun('document.getElementById("ownership-name").value="Alice归属";document.getElementById("ownership-name").dispatchEvent(new Event("input"));document.querySelector("#ownership-users input[type=checkbox]").click()');
    await adminWait('document.getElementById("ownership-draft-status").textContent.includes("已加密暂存")');
    assert.deepEqual((await adminRun('window.groupAdmin.userOwnershipDraftState()')).data.userIds, [8]);
    await adminRun('document.getElementById("ownership-refresh").click()');
    await adminWait('document.getElementById("ownership-draft-status").textContent.includes("已恢复上次加密暂存")');
    assert.equal(await adminRun('document.getElementById("ownership-name").value'), 'Alice归属');
    assert.equal(await adminRun('document.querySelector("#ownership-users input[type=checkbox]").checked'), true);
    await adminRun('document.getElementById("ownership-save").click()');
    await adminWait('document.getElementById("ownership-notice").textContent.includes("归属已保存")');
    await adminWait('document.getElementById("ownership-draft-status").textContent.includes("待保存草稿已清除")');
    assert.equal((await adminRun('window.groupAdmin.userOwnershipDraftState()')).data, null);
    assert.equal(userOwnership.profiles().length, 1);
    assert.equal(await userOwnership.query('ou_fixture_member_12345678'), null);
    userOwnership.claim('ou_fixture_member_12345678', '测试成员');
    assert.equal(await userOwnership.query('ou_fixture_member_12345678'), null);
    await adminRun('document.getElementById("ownership-refresh").click()');
    await adminWait('document.querySelectorAll("#ownership-identity option").length===2');
    const identity = userOwnership.list()[0].identity;
    const oldMemberRefresh = memberNames.refresh.bind(memberNames);
    const oldMemberDecorate = memberNames.decorateOwnershipIdentities.bind(memberNames);
    memberNames.refresh = async () => ({ reason: 'ready', count: 1 });
    memberNames.decorateOwnershipIdentities = rows => rows.map(row => row.identity === identity ?
      { ...row, currentFeishuName: '用户930290' } : row);
    await adminRun('document.getElementById("ownership-refresh").click()');
    await adminWait('document.querySelector("#ownership-identity option:nth-child(2)")?.textContent.includes("用户930290（当前群显示名）")');
    assert.equal(await adminRun('document.querySelector("#ownership-identity option:nth-child(2)").textContent.includes("身份 " )'), true);
    await adminRun(`document.getElementById('ownership-identity').value='${identity}';
      document.getElementById('ownership-identity').dispatchEvent(new Event('change'));
      document.getElementById('ownership-link-profile').value='Alice归属';
      document.getElementById('ownership-link-profile').dispatchEvent(new Event('change'));
      document.getElementById('ownership-link-save').click()`);
    await adminWait('document.getElementById("ownership-link-notice").textContent.includes("已绑定")');
    memberNames.refresh = oldMemberRefresh;
    memberNames.decorateOwnershipIdentities = oldMemberDecorate;
    assert.equal(userOwnership.list()[0].state, 'linked');
    assert.deepEqual((await userOwnership.query('ou_fixture_member_12345678')).users.map(u => u.id), [8]);
    assert.equal((await adminRun('window.groupAdmin.dailyUsageState()')).data.enabled, false);
    await adminRun('document.getElementById("daily-usage-preview").click()');
    await adminWait('document.getElementById("daily-usage-status").textContent.includes("已只读预览") || document.getElementById("daily-usage-status").textContent.includes("预览失败")');
    assert.match(await adminRun('document.getElementById("daily-usage-status").textContent'), /已只读预览/);
    assert.equal(await adminRun('document.getElementById("daily-usage-preview-rows").textContent.includes("alice@example.invalid")'), true);
    await adminRun('document.getElementById("daily-usage-time").value="10:00"; document.getElementById("daily-usage-time").dispatchEvent(new Event("input")); document.getElementById("daily-usage-enable").click()');
    await adminWait('document.getElementById("daily-usage-status").textContent.includes("已设定")');
    assert.equal((await adminRun('window.groupAdmin.dailyUsageState()')).data.dailyTime, '10:00');
    assert.match((await adminRun('window.groupAdmin.dailyUsageState()')).data.effectiveDay, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await adminRun('window.groupAdmin.dailyUsageState()')).data.cards.length, 0);
    // Saving the schedule no longer publishes or samples immediately; seed history through its separate read-only path.
    assert.ok((await dailyUsagePublisher.historyTick()).saved.length > 0);
    assert.equal((await adminRun('window.groupAdmin.dailyUsageState()')).data.cards.length, 0);
    await adminRun('document.getElementById("daily-usage-pause").click()');
    await adminWait('document.getElementById("daily-usage-status").textContent.includes("已暂停")');
    const fakeAttempt = '2026-11-06T02:00:00Z', fakeUnknown = '2026-11-06T02:00:03Z';
    const fakeProfile = '虚构未见归属', usageScope = userOwnership.scope();
    dailyUsagePublisher.store.append({ type: 'attempt', scope: usageScope, profile: fakeProfile,
      action: 'create', messageId: null, at: fakeAttempt, createdAt: fakeAttempt });
    dailyUsagePublisher.store.append({ type: 'unknown', scope: usageScope, profile: fakeProfile,
      messageId: null, at: fakeUnknown, createdAt: fakeAttempt });
    await navigate('configuration'); await navigate('user-ownership');
    await adminWait('document.querySelector(".daily-usage-review button") !== null');
    assert.equal(await adminRun('document.querySelector(".daily-usage-review button").disabled'), true);
    assert.equal(await adminRun('document.getElementById("daily-usage-reviews").textContent.includes("旧记录没有留存具体失败码")'), true);
    const originalMessageBox = dialog.showMessageBox;
    try {
      dialog.showMessageBox = async () => ({ response: 0 });
      await adminRun('document.querySelector(".daily-usage-review input[type=checkbox]").click();document.querySelector(".daily-usage-review button").click()');
      await adminWait('document.getElementById("daily-usage-status").textContent.includes("已取消人工核对")');
      assert.equal(dailyUsagePublisher.store.state(usageScope).cards[fakeProfile].phase, 'unknown');
      dialog.showMessageBox = async () => ({ response: 1 });
      await adminRun('document.querySelector(".daily-usage-review input[type=checkbox]").click();document.querySelector(".daily-usage-review button").click()');
      await adminWait('document.getElementById("daily-usage-status").textContent.includes("已加密记录")');
      assert.equal(dailyUsagePublisher.store.state(usageScope).cards[fakeProfile].phase, 'reviewed-absent');
      assert.equal(dailyUsagePublisher.store.state(usageScope).enabled, false);
      assert.equal(await adminRun('document.getElementById("daily-usage-enable").disabled'), true);
    } finally { dialog.showMessageBox = originalMessageBox; }
    const historyCatalogReply = await adminRun('window.groupAdmin.dailyUsageHistoryCatalog()');
    assert.equal(historyCatalogReply.ok, true, JSON.stringify(historyCatalogReply));
    assert.equal(historyCatalogReply.data.names.includes('Alice归属'), true);
    await navigate('usage-history');
    await adminWait('document.getElementById("usage-history-status").textContent.includes("已读取")');
    await adminWait('document.getElementById("usage-history-collection-status").textContent.includes("本机每小时采样")');
    assert.match(await adminRun('document.getElementById("usage-history-collection-status").textContent'), /群卡片未启用，不影响本机采样/);
    assert.equal(await adminRun('document.getElementById("usage-history-export-start").value.length'), 10);
    assert.equal(await adminRun('document.getElementById("usage-history-export-end").value.length'), 10);
    assert.equal(await adminRun('document.querySelectorAll(".usage-history-table tbody tr").length'), 1);
    // The previous navigation may have left an older "已读取" notice while the new week is still rendering.
    await adminWait('document.getElementById("usage-history-table").textContent.includes("alice@example.invalid")');
    assert.equal(await adminRun('document.getElementById("usage-history-table").textContent.includes("alice@example.invalid")'), true);
    await adminRun('window.confirm=()=>true;document.getElementById("usage-history-backfill").click()');
    await adminWait('document.getElementById("usage-history-backfill-status").textContent.includes("完成") || document.getElementById("usage-history-backfill-status").textContent.includes("已停止") || document.getElementById("usage-history-backfill-status").textContent.includes("未开始")');
    assert.match(await adminRun('document.getElementById("usage-history-backfill-status").textContent'), /完成/);
    assert.equal((await adminRun('window.groupAdmin.dailyUsageBackfillStatus()')).data.completed > 0, true);
    assert.equal(await adminRun('document.getElementById("usage-history-table").textContent.includes("回填")'), true);
    const exportPath = path.join(app.getPath('userData'), 'fixture-usage-export.xlsx');
    const originalSaveDialog = dialog.showSaveDialog;
    try {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
      await adminRun(`document.getElementById('usage-history-export-start').value='2026-11-01';
        document.getElementById('usage-history-export-end').value='2026-11-02';
        document.getElementById('usage-history-export-person').click()`);
      await adminWait('document.getElementById("usage-history-export-status").textContent.includes("已导出")');
      const exported = new (require('exceljs').Workbook)();
      await exported.xlsx.readFile(exportPath);
      assert.equal(exported.worksheets.length, 1);
      const usageSheet = exported.getWorksheet('用量明细');
      assert.equal(usageSheet.getCell('A1').value, '归属姓名');
      assert.equal(usageSheet.getCell('C1').value.toISOString().slice(0, 10), '2026-11-01');
      assert.equal(usageSheet.getCell('D1').value.toISOString().slice(0, 10), '2026-11-02');
      assert.equal(usageSheet.getCell('A3').value, 'Alice归属');
      assert.equal(usageSheet.getCell('B4').value, '归属人合计');
      assert.equal(usageSheet.getCell('C4').value, 0, 'recorded empty profile keeps its zero subtotal without inventing account rows');
      const allReply = await adminRun(`window.groupAdmin.dailyUsageHistoryExport({scope:'all',start:'2026-11-01',end:'2026-11-02'})`);
      assert.equal(allReply.ok, true, JSON.stringify(allReply));
      assert.equal(allReply.data.people, 1);
      dialog.showSaveDialog = async () => ({ canceled: true });
      const canceled = await adminRun(`window.groupAdmin.dailyUsageHistoryExport({scope:'all',start:'2026-11-01',end:'2026-11-02'})`);
      assert.equal(canceled.data.canceled, true);
    } finally { dialog.showSaveDialog = originalSaveDialog; fs.rmSync(exportPath, { force: true }); }
    admin.setSize(580, 820); await delay();
    assert.equal(await adminRun('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await adminRun('document.querySelector(".usage-history-table-wrap").getBoundingClientRect().right<=innerWidth'), true);
    const pinnedBefore = await adminRun(`(() => { const wrap=document.querySelector('.usage-history-table-scroll');
      const title=document.querySelector('.usage-history-table-title');
      const table=wrap.querySelector('table'); const first=table.querySelector('tbody th');
      const header=table.querySelector('thead th'); const footer=table.querySelector('tfoot th');
      return {left:wrap.getBoundingClientRect().left,title:title.getBoundingClientRect().left,
        titleText:title.textContent,label:table.getAttribute('aria-labelledby'),titleId:title.id,
        row:first.getBoundingClientRect().left,
        header:header.getBoundingClientRect().left,footer:footer.getBoundingClientRect().left,
        value:table.querySelector('tbody td').getBoundingClientRect().left,max:wrap.scrollWidth-wrap.clientWidth}; })()`);
    assert.ok(pinnedBefore.max > 100);
    assert.equal(pinnedBefore.label, pinnedBefore.titleId);
    assert.match(pinnedBefore.titleText, /Alice归属/);
    await adminRun("document.querySelector('.usage-history-table-scroll').scrollLeft=100;void 0"); await delay();
    const pinnedAfter = await adminRun(`(() => { const wrap=document.querySelector('.usage-history-table-scroll');
      const table=wrap.querySelector('table'); return {scroll:wrap.scrollLeft,
        title:document.querySelector('.usage-history-table-title').getBoundingClientRect().left,
        row:table.querySelector('tbody th').getBoundingClientRect().left,
        header:table.querySelector('thead th').getBoundingClientRect().left,
        footer:table.querySelector('tfoot th').getBoundingClientRect().left,
        value:table.querySelector('tbody td').getBoundingClientRect().left}; })()`);
    assert.ok(pinnedAfter.scroll >= 100);
    for (const key of ['title','row','header','footer']) assert.ok(Math.abs(pinnedAfter[key]-pinnedBefore[key]) <= 1,
      `${key} shifted during horizontal scroll`);
    assert.ok(pinnedAfter.value < pinnedBefore.value-90);
    fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'usage-history-narrow-fixture.png'), (await admin.webContents.capturePage()).toPNG());
    await adminRun("document.getElementById('usage-history-export-start').scrollIntoView();void 0"); await delay();
    assert.equal(await adminRun(`[...document.querySelectorAll('.usage-history-export input,.usage-history-export button')]
      .every(node=>node.getBoundingClientRect().right<=innerWidth)`), true);
    fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'usage-history-export-narrow-fixture.png'), (await admin.webContents.capturePage()).toPNG());
    admin.setSize(1040, 820);
    await navigate('user-ownership');
    await adminRun('document.getElementById("daily-usage-preview").click()');
    await adminWait('document.querySelector(".daily-usage-preview-profile table")!==null');
    admin.setSize(580, 820); await delay();
    assert.equal(await adminRun('document.documentElement.scrollWidth<=innerWidth'), true);
    fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'user-ownership-narrow-fixture.png'), (await admin.webContents.capturePage()).toPNG());
    await adminRun('document.getElementById("daily-usage").scrollIntoView()'); await delay();
    assert.equal(await adminRun('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await adminRun('document.querySelector(".daily-usage-preview-profile table").getBoundingClientRect().right<=innerWidth'), true);
    fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'daily-usage-narrow-fixture.png'), (await admin.webContents.capturePage()).toPNG());
    admin.setSize(1040, 820);
    await navigate('account-management');
    await adminRun('document.getElementById("account-schedule-refresh").click()');
    await adminWait('document.querySelectorAll(".account-schedule-account").length===2 && !document.getElementById("account-schedule-create").disabled');
    const firstAt = new Date(Date.now() + 8 * 3600_000 + 10 * 60_000).toISOString().slice(0, 16);
    const secondAt = new Date(Date.now() + 8 * 3600_000 + 11 * 60_000).toISOString().slice(0, 16);
    await adminRun(`document.getElementById('account-schedule-open').value='31';document.getElementById('account-schedule-close').value='32';document.getElementById('account-schedule-first').value='${firstAt}';document.getElementById('account-schedule-second').value='${secondAt}';document.getElementById('account-schedule-form').dispatchEvent(new Event('submit',{cancelable:true}))`);
    await adminWait('document.getElementById("account-schedule-notice").textContent.includes("计划已保存")');
    assert.equal(accountSchedule.state().plans.length, 1);
    assert.equal(fixture.calls.filter(call => call.route?.endsWith('/schedulable')).length, 0);
    admin.setSize(580, 820); await delay();
    assert.equal(await adminRun('document.documentElement.scrollWidth<=innerWidth'), true);
    fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'account-schedule-narrow-fixture.png'), (await admin.webContents.capturePage()).toPNG());
    await adminRun('document.getElementById("account-schedule-form").scrollIntoView()'); await delay();
    fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'account-schedule-form-fixture.png'), (await admin.webContents.capturePage()).toPNG());
    admin.setSize(1040, 820);
    await adminRun('document.querySelector(".account-schedule-plan>button").click()');
    await adminWait('document.getElementById("account-schedule-notice").textContent.includes("已取消")');
    await navigate('configuration');
    await adminWait('document.getElementById("registration-rows").textContent.includes("暂无注册记录")');
    assert.equal(await run('typeof window.keyTool.registrationRecords'), 'undefined');
    assert.equal(await adminRun('document.getElementById("admin-recover").hidden'), true);
    assert.equal((await ipcMain._invokeHandlers.get('key-tool:admin-recover-authorization')(adminEvent)).code, 'STORAGE');
    // This fixture injects service requests, bypassing production's auth adapter.
    await navigate('group-settings');
    await adminRun('document.getElementById("settings-refresh").click()');
    await adminWait('document.querySelectorAll("[data-settings-group]").length===2 && !document.getElementById("settings-save").disabled');
    assert.equal(await adminRun('document.querySelectorAll("#settings-rows img").length'), 0);
    assert.equal(await adminRun('document.getElementById("settings-rows").textContent.includes("专属分组")'), true);
    assert.equal(await run('typeof window.keyTool.groupSettingsRefresh'), 'undefined');
    await adminRun('document.querySelector("[data-settings-group=\\"7\\"]").value="管理员倍率别名";document.getElementById("settings-form").dispatchEvent(new Event("submit",{cancelable:true}))');
    await adminWait('document.getElementById("settings-notice").textContent.includes("已发布") && !document.getElementById("settings-save").disabled');
    assert.equal((await adminRun('window.groupAdmin.groupSettingsRefresh()')).data.groups.find(g => g.id === 7).displayName, '管理员倍率别名');
    assert.equal((await adminRun('window.groupAdmin.state()')).data.groups.find(g => g.id === 7).customerName, '');
    assert.equal(await adminRun('document.getElementById("settings-save-status").textContent.includes("保存成功")'),true);
    let releaseGroups;fixture.setGroupWait(new Promise(resolve=>{releaseGroups=resolve;}));
    await adminRun('document.getElementById("settings-form").dispatchEvent(new Event("submit",{cancelable:true}))');
    await adminWait('document.getElementById("settings-save").textContent.includes("正在保存")');
    assert.equal(await adminRun('document.getElementById("settings-save-status").textContent.includes("请勿重复")'),true);
    await navigate('operation-log');
    await adminWait('document.getElementById("operation-log-rows").textContent.includes("处理中")');
    releaseGroups();fixture.setGroupWait(null);
    await adminWait('document.getElementById("settings-save-status").textContent.includes("保存成功")');
    await navigate('group-settings');
    await adminRun('document.querySelector("[data-settings-group=\\"9\\"]").value="管理员倍率别名";document.getElementById("settings-form").dispatchEvent(new Event("submit",{cancelable:true}))');
    await adminWait('document.getElementById("settings-save-status").textContent.includes("保存失败") && !document.getElementById("settings-save").disabled');
    assert.equal(await adminRun('document.getElementById("settings-save-status").textContent.includes("名称重复")'),true);
    assert.equal(await adminRun('document.querySelector("[data-settings-group=\\"9\\"]").value'),'管理员倍率别名');
    const logResult=await adminRun('window.groupAdmin.operationLog()');
    assert.equal(logResult.ok,true);assert.ok(logResult.data.items.some(r=>r.action==='admin-group-settings-save'&&r.status==='failure'&&r.code==='INPUT'&&r.stage==='validation'));
    assert.equal(JSON.stringify(logResult.data).includes('管理员倍率别名'),false);
    await navigate('operation-log');
    await adminWait('document.getElementById("operation-log-rows").textContent.includes("INPUT")');
    await adminRun('document.getElementById("operation-log-filter").value="failure";document.getElementById("operation-log-filter").dispatchEvent(new Event("change"))');
    assert.equal(await adminRun('Array.from(document.querySelectorAll(".operation-log-entry")).every(r=>r.dataset.status==="failure")'),true);
    fs.mkdirSync(path.join(__dirname,'..','outputs'),{recursive:true});
    await delay();fs.writeFileSync(path.join(__dirname,'..','outputs','admin-operation-log-fixture.png'),(await admin.webContents.capturePage()).toPNG());
    await navigate('group-settings');
    await adminRun('document.querySelector("[data-settings-group=\\"9\\"]").value=""');
    await adminRun('document.querySelector("[data-settings-group=\\"7\\"]").value="侧栏切换草稿";document.querySelector("[data-settings-group=\\"7\\"]").dispatchEvent(new Event("input"))');
    await navigate('configuration'); await navigate('group-settings');
    assert.equal(await adminRun('document.querySelector("[data-settings-group=\\"7\\"]").value'), '侧栏切换草稿');
    await adminRun('document.getElementById("settings-records-refresh").click()');
    await adminWait('document.getElementById("settings-records").textContent.includes("暂无")');
    admin.setSize(680, 900); await delay();
    assert.equal(await adminRun('document.documentElement.scrollWidth<=innerWidth'), true);
    await adminRun('document.getElementById("group-settings").scrollIntoView()');
    fs.mkdirSync(path.join(__dirname, '..', 'outputs'), { recursive: true });
    await new Promise(resolve => setTimeout(resolve, 120));
    fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'group-settings-admin-fixture.png'), (await admin.webContents.capturePage()).toPNG());
    admin.setSize(1040, 820); await navigate('group-settings'); await delay();
    fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'admin-sidebar-groups.png'), (await admin.webContents.capturePage()).toPNG());
    await navigate('configuration'); await delay();
    fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'admin-sidebar-config.png'), (await admin.webContents.capturePage()).toPNG());
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
    admin.webContents.send('key-tool:feishu-state', { ...botSave.data,
      connection: { ...botSave.data.connection, phase: 'failed', active: false, error: { code: 'TIMEOUT', message: 'fixture stopped' } },
      autoReconnect: { enabled: true, attempts: 2, nextRetryAt: Date.now()+10000, reason: 'retry' } });
    await adminWait('document.getElementById("bot-reconnect-status").textContent.includes("秒后重试")');
    assert.equal(await adminRun('document.getElementById("bot-disconnect").disabled'), false);
    assert.equal(await adminRun('document.getElementById("bot-notice").textContent.includes("自动重试")'), true);
    admin.webContents.send('key-tool:feishu-state', { ...botSave.data, autoReconnect: { enabled: false, reason: 'manual' } });
    await adminWait('document.getElementById("bot-reconnect-status").textContent.includes("已暂停")');
    admin.webContents.send('key-tool:feishu-state', botSave.data);
    await adminRun('window.confirm=()=>false;document.getElementById("bot-app-secret").value="cancelled-fixture";document.getElementById("bot-credentials-form").dispatchEvent(new Event("submit",{cancelable:true}))');
    assert.equal(await adminRun('document.getElementById("bot-app-secret").value'), '');
    assert.equal((await adminRun('window.groupAdmin.feishuState()')).data.connection.savedAt, botSave.data.connection.savedAt);
    await adminRun('document.getElementById("bot-app-secret").value="blur-fixture";window.dispatchEvent(new Event("blur"))');
    assert.equal(await adminRun('document.getElementById("bot-app-secret").value'), '');
    await adminRun('window.confirm=()=>true;void 0');
    await adminRun('document.getElementById("bot-app-secret").value="navigation-fixture-secret"');
    await navigate('token-groups');
    assert.equal(await adminRun('document.getElementById("bot-app-secret").value'), '');
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
    await navigate('configuration');
    await navigate('channel-monitor');
    await adminWait('document.querySelectorAll("[data-channel-id]").length===5');
    await navigate('channel-access');
    await adminWait('document.querySelectorAll("#channel-access-options input[type=checkbox]").length===5');
    assert.equal((await adminRun('window.groupAdmin.channelAccessSave({name:"甲",botAccountId:"x",senderId:"member-a",channelIds:["points-ip"]})')).code, 'INPUT');
    await adminRun(`document.getElementById('channel-access-name').value='模拟甲';
      document.getElementById('channel-access-bot').value='fixture-bot';
      document.getElementById('channel-access-sender').value='fixture-member-a';
      document.querySelector('#channel-access-options input[type=checkbox]').click();
      document.getElementById('channel-access-save').click()`);
    await adminWait('document.getElementById("channel-access-status").textContent.includes("加密保存")');
    assert.equal((await adminRun('window.groupAdmin.channelAccessState()')).data.people.some(row => row.name === '模拟甲'), true);
    assert.equal((await adminRun('window.groupAdmin.channelAccessState()')).data.people.some(row => JSON.stringify(row).includes('fixture-member-a')), false);
    await navigate('channel-monitor');
    assert.equal(await adminRun('document.querySelector(".channel-alert-settings").open'), false);
    assert.equal((await adminRun('window.groupAdmin.channelAlertState()')).data.enabled, false);
    assert.equal((await adminRun('window.groupAdmin.channelAlertSave({from:"wrong@example.invalid",authCode:"x",recipients:"a@example.invalid"})')).code, 'INPUT');
    await adminRun(`document.querySelector('.channel-alert-settings').open=true;
      document.getElementById('channel-alert-sender').value='fixture@qq.com';
      document.getElementById('channel-alert-code').value='fixture-only-code-not-real';
      document.getElementById('channel-alert-recipients').value=['one@example.invalid','two@example.invalid'].join(String.fromCharCode(10));
      document.getElementById('channel-alert-threshold').value='1500';
      document.getElementById('channel-alert-daily-time').value='09:30';
      document.getElementById('channel-alert-save').click()`);
    await adminWait('document.getElementById("channel-alert-status").textContent.includes("已加密保存并启用")');
    assert.equal((await adminRun('window.groupAdmin.channelAlertState()')).data.recipients.length, 2);
    assert.equal((await adminRun('window.groupAdmin.channelAlertState()')).data.threshold, 1500);
    assert.equal((await adminRun('window.groupAdmin.channelAlertState()')).data.dailyTime, '09:30');
    assert.equal(await adminRun('document.getElementById("channel-alert-code").value'), '');
    const alertRow = channelMonitor.rows.get('points-anna');
    Object.assign(alertRow, { status: 'ok', value: 999.5, display: '999.5', checkedAt: new Date().toISOString(),
      nextAt: Date.now() + 3600000 });
    await adminRun('document.getElementById("channel-alert-test-scope").value="all";document.getElementById("channel-alert-test").click()');
    await adminWait('document.getElementById("channel-alert-status").textContent.includes("SMTP 接受 2 封")');
    assert.equal((await adminRun('window.groupAdmin.channelAlertState()')).data.attention.length, 0);
    await adminRun(`document.getElementById('channel-alert-recipients').value='unsaved@example.invalid';
      document.getElementById('channel-alert-recipients').dispatchEvent(new Event('input'))`);
    admin.webContents.send('key-tool:channel-alert-state', (await adminRun('window.groupAdmin.channelAlertState()')).data);
    await delay();
    assert.equal(await adminRun('document.getElementById("channel-alert-recipients").value'), 'unsaved@example.invalid');
    await adminRun(`document.getElementById('channel-alert-threshold').value='1750';
      document.getElementById('channel-alert-threshold').dispatchEvent(new Event('input'))`);
    admin.webContents.send('key-tool:channel-alert-state', (await adminRun('window.groupAdmin.channelAlertState()')).data);
    await delay();
    assert.equal(await adminRun('document.getElementById("channel-alert-threshold").value'), '1750');
    await adminRun('document.getElementById("channel-alert-code").value="fixture-unsaved-not-real";document.querySelector(".channel-alert-settings").open=false');
    await delay();
    assert.equal(await adminRun('document.getElementById("channel-alert-code").value'), '');
    await adminRun('document.getElementById("channel-alert-pause").click()');
    await adminWait('document.getElementById("channel-alert-status").textContent.includes("已暂停")');
    await adminRun('document.getElementById("channel-alert-clear").click()');
    await adminWait('document.getElementById("channel-alert-status").textContent.includes("已清除")');
    assert.equal((await adminRun('window.groupAdmin.channelAlertState()')).data.configured, false);
    assert.equal(await adminRun('document.querySelectorAll("[data-channel-id] input[type=password]").length'),5);
    assert.equal(await adminRun('Array.from(document.querySelectorAll("[data-channel-id] details.channel-settings")).length===5 && Array.from(document.querySelectorAll("[data-channel-id] details.channel-settings")).every(d=>!d.open)'),true);
    assert.equal(await adminRun('document.querySelectorAll("[data-channel-id] .channel-value").length'),5);
    assert.equal(await adminRun('document.getElementById("channel-monitor-rows").textContent.includes("23.239.111.82/dashboard")'),true);
    assert.equal(await adminRun('document.querySelector("[data-channel-id=balance-juxiang] .auto-login-box input[type=text]").type'), 'text');
    assert.equal(await adminRun('document.querySelector("[data-channel-id=balance-juxiang] .channel-origin").textContent'), 'https://173.231.49.42/dashboard/overview');
    await adminRun('document.querySelector("[data-channel-id=points-ip] details").open=true;document.querySelector("[data-channel-id=points-ip] .channel-name-input").value="渠道A积分";document.querySelector("[data-channel-id=points-ip] [data-action=rename]").click()');
    await adminWait('document.querySelector("[data-channel-id=\\"points-ip\\"] .channel-name").textContent.includes("渠道A积分")');
    assert.equal((await adminRun('window.groupAdmin.channelMonitorState()')).data.find(r=>r.id==='points-ip').name,'渠道A积分');
    await adminRun('document.querySelector("[data-channel-id=\\"points-ip\\"] [data-action=check]").click()');
    await adminWait('document.querySelector("[data-channel-id=\\"points-ip\\"] .channel-status").textContent.includes("待登录")');
    assert.equal(await adminRun('document.querySelector("[data-channel-id=\\"points-ip\\"] .channel-status").textContent.includes("将自动复查")'), true);
    assert.equal(await adminRun('document.getElementById("channel-monitor-notice").textContent.includes("五项金额分别显示")'), true);
    assert.equal(await adminRun('document.querySelector("[data-channel-id=\\"points-ip\\"] .channel-value").textContent'), '—');
    for (const channelId of ['points-ip', 'points-anna', 'spent-ccrouter', 'spent-aerorelay', 'balance-juxiang']) {
      const selector = `[data-channel-id=${channelId}]`;
      const accountType = channelId === 'balance-juxiang' ? 'text' : 'email';
      await adminRun(`document.querySelector('${selector} details').open=true;document.querySelector('${selector} .auto-login-box input[type=${accountType}]').value="fictional@example.invalid";document.querySelector('${selector} input[type=password]').value="fixture-only-secret-not-real";document.querySelector('${selector} [data-login-action=save]').click()`);
      await adminWait(`document.querySelector('${selector} .auto-login-status').textContent.includes("已加密保存")`);
      assert.equal(await adminRun(`document.querySelector('${selector} input[type=password]').value`), '');
      assert.equal(JSON.stringify((await adminRun(`window.groupAdmin.channelLoginState('${channelId}')`)).data).includes('fixture-only-secret'), false);
      if (channelId === 'points-ip') assert.equal((await adminRun('window.groupAdmin.channelLoginState("points-anna")')).data.configured, false);
      await adminRun(`document.querySelector('${selector} [data-login-action=pause]').click()`);
      await adminWait(`document.querySelector('${selector} .auto-login-status').textContent.includes("已暂停")`);
      await adminRun(`document.querySelector('${selector} [data-login-action=clear]').click()`);
      await adminWait(`document.querySelector('${selector} .auto-login-status').textContent.includes("未配置")`);
      await adminRun(`document.querySelector('${selector} details').open=false`);
    }
    assert.equal((await adminRun('window.groupAdmin.channelLoginState("unknown-channel")')).code, 'INPUT');
    await adminRun('document.querySelector("[data-channel-id=points-ip] details").open=true;document.querySelector("[data-channel-id=points-ip] input[type=password]").value="fixture-unsaved-not-real";document.querySelector("[data-channel-id=points-ip] details").open=false');
    await delay();
    assert.equal(await adminRun('document.querySelector("[data-channel-id=points-ip] input[type=password]").value'), '');
    const fakeBalances = ['11.125', '22.25', '$33.50', '$44.75', '¥55.25'];
    const channelSnapshot = (await adminRun('window.groupAdmin.channelMonitorState()')).data;
    admin.webContents.send('key-tool:channel-monitor-state', channelSnapshot.map((row, index) => ({
      ...row, status: 'ok', display: fakeBalances[index], successAt: '2026-11-03T08:00:00.000Z'
    })));
    await adminWait('Array.from(document.querySelectorAll("[data-channel-id] .channel-value")).map(e=>e.textContent).join("|")==="11.125|22.25|$33.50|$44.75|¥55.25"');
    assert.equal(await adminRun('Array.from(document.querySelectorAll("[data-channel-id] details.channel-settings")).every(d=>!d.open)'), true);
    admin.setSize(1040,820);await delay();
    await adminRun('document.querySelector("[data-channel-id=points-ip] details.channel-settings").open=true');
    await delay();
    const expandedGeometry = await adminRun(`(() => {
      const card=document.querySelector('[data-channel-id=points-ip]');
      const actions=card.querySelector(':scope > .channel-buttons').getBoundingClientRect();
      const settings=card.querySelector(':scope > details.channel-settings').getBoundingClientRect();
      const next=card.nextElementSibling.getBoundingClientRect();
      return { actionBottom:actions.bottom, settingsTop:settings.top, settingsBottom:settings.bottom,
        nextTop:next.top, cardBottom:card.getBoundingClientRect().bottom };
    })()`);
    assert.ok(expandedGeometry.settingsTop >= expandedGeometry.actionBottom,
      `expanded login settings overlap action buttons: ${JSON.stringify(expandedGeometry)}`);
    assert.ok(expandedGeometry.nextTop >= expandedGeometry.cardBottom,
      `expanded settings overflow next card: ${JSON.stringify(expandedGeometry)}`);
    fs.mkdirSync(path.join(__dirname,'..','outputs'),{recursive:true});
    fs.writeFileSync(path.join(__dirname,'..','outputs','channel-monitor-expanded-desktop-fixture.png'),(await admin.webContents.capturePage()).toPNG());
    await adminRun('document.querySelector("[data-channel-id=points-ip] details.channel-settings").open=false');
    fs.writeFileSync(path.join(__dirname,'..','outputs','channel-monitor-desktop-fixture.png'),(await admin.webContents.capturePage()).toPNG());
    admin.setSize(480,850);await delay();
    assert.equal(await adminRun('document.documentElement.scrollWidth<=innerWidth'),true);
    await adminRun('document.querySelector(".channel-alert-settings").open=true');
    await delay();
    assert.equal(await adminRun('document.documentElement.scrollWidth<=innerWidth'),true);
    await adminRun('document.querySelector(".channel-alert-settings").open=false');
    await adminRun('document.querySelector("[data-channel-id=points-ip] details.channel-settings").open=true');
    await delay();
    const narrowGeometry = await adminRun(`(() => {
      const card=document.querySelector('[data-channel-id=points-ip]');
      const actions=card.querySelector(':scope > .channel-buttons').getBoundingClientRect();
      const settings=card.querySelector(':scope > details.channel-settings').getBoundingClientRect();
      return { actionBottom:actions.bottom, settingsTop:settings.top,
        cardBottom:card.getBoundingClientRect().bottom, settingsBottom:settings.bottom };
    })()`);
    assert.ok(narrowGeometry.settingsTop >= narrowGeometry.actionBottom &&
      narrowGeometry.cardBottom >= narrowGeometry.settingsBottom,
      `narrow expanded settings overlap: ${JSON.stringify(narrowGeometry)}`);
    fs.writeFileSync(path.join(__dirname,'..','outputs','channel-monitor-expanded-narrow-fixture.png'),(await admin.webContents.capturePage()).toPNG());
    await adminRun('document.querySelector("[data-channel-id=points-ip] details.channel-settings").open=false');
    fs.writeFileSync(path.join(__dirname,'..','outputs','channel-monitor-narrow-fixture.png'),(await admin.webContents.capturePage()).toPNG());
    admin.setSize(1040,820);
    await navigate('configuration');
    await adminRun('window.confirm=()=>true;document.getElementById("admin-login").click()');
    await adminWait('document.getElementById("auth-status").textContent.includes("等待管理员登录") && !document.getElementById("admin-complete-login").disabled');
    await wait('document.querySelectorAll(".group").length===0');
    assert.equal((await adminRun('window.groupAdmin.authState()')).data.owner, null);
    await adminRun('document.getElementById("admin-complete-login").click()');
    await adminWait('document.getElementById("auth-status").textContent.includes("已验证") && !document.getElementById("admin-save").disabled');
    assert.equal(await adminRun('document.getElementById("alias-7").value'), '客户专享通道');
    assert.equal(JSON.stringify((await adminRun('window.groupAdmin.authState()')).data).includes('fixture-only'), false);
    assert.equal(await run('typeof window.keyTool.login'), 'undefined');
    await navigate('token-groups');
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
    await historyRun('document.querySelector("[data-admin-target=\\"token-history\\"]").click()');
    const historyWait = async expr => { for (let i = 0; i < 100; i++) { if (await historyRun(expr)) return; await delay(); } throw new Error('history UI wait timeout: ' + expr); };
    await historyWait('document.querySelectorAll("[data-record-id]").length===1 && !document.getElementById("history-refresh").disabled');
    assert.equal(await historyRun('document.getElementById("history-rows").textContent.includes("模拟客户A <img src=x onerror=alert(1)>")'), true);
    assert.equal(await historyRun('document.getElementById("history-rows").textContent.includes("额度 5.5") && document.getElementById("history-rows").textContent.includes("Key ID 44")'), true);
    assert.equal(await historyRun('document.querySelectorAll("#history img").length'), 0);
    assert.equal(JSON.stringify((await historyRun('window.groupAdmin.records({})')).data).includes('sk-fixture-only-not-real'), false);
    const originalActor=tokenService.records[0].operator;
    tokenService.records[0].operator={name:'飞书用户#0123456789abcdef0123',source:'feishu-open-id',verified:true,
      displayName:'组织9 <img src=x onerror=alert(1)>',nameSource:'feishu-chat-members',nameFetchedAt:new Date().toISOString()};
    await historyRun('document.getElementById("history-search").value="组织9";document.getElementById("history-filter").dispatchEvent(new Event("submit",{cancelable:true}))');
    await historyWait('document.getElementById("history-rows").textContent.includes("组织9") && !document.getElementById("history-refresh").disabled');
    assert.equal(await historyRun('document.querySelector("#history-rows strong").textContent'), '组织9 <img src=x onerror=alert(1)>');
    assert.equal(await historyRun('document.querySelectorAll("#history-rows img").length'),0);
    assert.equal(await historyRun('document.getElementById("history-rows").textContent.includes("创建时飞书姓名")'),true);
    tokenService.records[0].operator=originalActor;
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
    await historyRun('document.querySelector("[data-admin-target=\\"group-settings\\"]").click()');
    assert.equal(await historyRun('document.getElementById("history-key").value'), '');
    await historyRun('document.querySelector("[data-admin-target=\\"token-history\\"]").click()');
    await historyRun('document.getElementById("history-reveal").click()');
    await historyWait('document.getElementById("history-key").value.length>0 && !document.getElementById("history-reveal").disabled');
    await historyRun('document.getElementById("history-reveal").click()');
    assert.equal(await historyRun('document.getElementById("history-key").value'), '');
    // A late IPC reply after blur must not put a secret back into the page.
    await historyRun('document.getElementById("history-reveal").click();window.dispatchEvent(new Event("blur"))');
    await historyWait('document.querySelectorAll("#history-events li").length===5 && !document.getElementById("history-reveal").disabled');
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
    await liveRun('document.querySelector("[data-admin-target=\\"token-history\\"]").click()');
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
    assert.deepEqual(Object.keys(failures.items[0]).sort(), ['at','code','httpStatus','reason','requestId','stage']);
    assert.equal(await liveRun('document.getElementById("bot-failures").textContent.includes("可能已发送，先核对")'), true);
    assert.equal(await liveRun('document.getElementById("bot-failures").textContent.includes("sk-fixture")'), false);
    assert.equal(fixture.calls.filter(c => c.method === 'POST' && c.route === '/keys').length, 2);
    // Registration uses a separate service/ledger; all identities below are fictional.
    await liveRun('document.querySelector("[data-admin-target=\\"registration-history\\"]").click()');
    fixture.setFail(false);
    const registrationContext = { verifiedActor: { name: '飞书用户#0123456789abcdef0123', source: 'feishu-open-id', verified: true,
      displayName:'组织9 · 模拟注册者',nameSource:'feishu-chat-members',nameFetchedAt:new Date().toISOString() },
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
    assert.equal(await liveRun('document.getElementById("registration-rows").textContent.includes("组织9 · 模拟注册者")'), true);
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
    // Exercise the real group-settings PUT adapter with a fictional transport before registration checks.
    fixture.setAuthFail(false);
    const savedFetch = apiSession.fetch, groupTransport = [];
    let groupRole = 'admin';
    apiSession.fetch = async (url, options) => {
      groupTransport.push({ route: new URL(url).pathname, method: options.method });
      assert.equal(options.headers.Authorization, 'Bearer fixture-only');
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      return { ok: true, status: 200, json: async () => ({ code: 0, data: options.method === 'PUT' ? {} : { id: 1, role: groupRole } }) };
    };
    try {
      const body = { allowed_groups: [7], restrict_public_groups: false, group_rates: { 7: 0.8 } };
      const context = { owner: 1, groupSettings: true, guard: () => true };
      await assert.rejects(request('PUT', '/admin/users/8', { ...body, balance: 100 }, context), { code: 'ROUTE' });
      await assert.rejects(request('PUT', '/admin/users/8', body, { ...context, guard: () => false }), { code: 'POLICY' });
      await assert.rejects(request('PUT', '/admin/users/8', body, { ...context, owner: 2 }), { code: 'AUTH' });
      // The preceding account mismatch revokes the fixture session; restore through its supported login path.
      await auth.begin(); await auth.finish();
      groupRole = 'user'; await assert.rejects(request('PUT', '/admin/users/8', body, context), { code: 'DENIED' });
      await assert.rejects(request('GET', '/admin/groups?page=1&page_size=100'), { code: 'DENIED' });
      groupRole = 'admin'; await assert.rejects(request('PUT', '/admin/users/8', body, { ...context, groupSettings: false }), { code: 'DENIED' });
      assert.equal(groupTransport.filter(c => c.method === 'PUT').length, 0);
      await request('PUT', '/admin/users/8', body, context);
      assert.equal(groupTransport.filter(c => c.method === 'PUT').length, 1);
    } finally { apiSession.fetch = savedFetch; }
    // Account scheduling uses the site's explicit set-schedulable route; never send a real request in this fixture.
    const accountFetch = apiSession.fetch, accountTransport = [];
    let accountRole = 'admin';
    apiSession.fetch = async (url, options) => {
      const route = new URL(url).pathname; accountTransport.push({ route, method: options.method });
      assert.equal(options.headers.Authorization, 'Bearer fixture-only');
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      if (route === '/api/v1/auth/me') return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 1, role: accountRole } }) };
      if (route === '/api/v1/admin/accounts/31/schedulable') {
        assert.deepEqual(JSON.parse(options.body), { schedulable: true });
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 31, name: '虚构渠道甲', schedulable: true } }) };
      }
      if (route === '/api/v1/admin/accounts/31') return { ok: true, status: 200, json: async () =>
        ({ code: 0, data: { id: 31, name: '虚构渠道甲', schedulable: false } }) };
      if (route === '/api/v1/admin/accounts') return { ok: true, status: 200, json: async () =>
        ({ code: 0, data: { items: [{ id: 31, name: '虚构渠道甲', schedulable: false }], total: 1 } }) };
      throw new Error('unexpected account fixture route');
    };
    try {
      const context = { owner: 1, accountSchedule: true, guard: () => true };
      await assert.rejects(request('POST', '/admin/accounts/31/schedulable', { schedulable: 'true' }, context), { code: 'ROUTE' });
      await assert.rejects(request('POST', '/admin/accounts/31/schedulable', { schedulable: true, extra: 1 }, context), { code: 'ROUTE' });
      await assert.rejects(request('POST', '/admin/accounts/31/schedulable', { schedulable: true }, { ...context, accountSchedule: false }), { code: 'ROUTE' });
      await assert.rejects(request('POST', '/admin/accounts/31/schedulable', { schedulable: true }, { ...context, guard: () => false }), { code: 'POLICY' });
      accountRole = 'user'; await assert.rejects(request('GET', '/admin/accounts?page=1&page_size=100'), { code: 'DENIED' });
      accountRole = 'admin';
      assert.equal((await request('GET', '/admin/accounts?page=1&page_size=100')).total, 1);
      assert.equal((await request('GET', '/admin/accounts/31')).id, 31);
      await request('POST', '/admin/accounts/31/schedulable', { schedulable: true }, context);
      assert.equal(accountTransport.filter(call => call.method === 'POST').length, 1);
    } finally { apiSession.fetch = accountFetch; }
    const usageFetch = apiSession.fetch, usageTransport = [];
    let usageRole = 'admin';
    apiSession.fetch = async (url, options) => {
      const target = new URL(url); usageTransport.push({ path: target.pathname, search: target.search,
        method: options.method });
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer fixture-only');
      if (target.pathname === '/api/v1/auth/me') return { ok: true, status: 200,
        json: async () => ({ code: 0, data: { id: 1, role: usageRole } }) };
      assert.equal(target.pathname, '/api/v1/admin/usage/stats');
      return { ok: true, status: 200,
        json: async () => ({ code: 0, data: { total_actual_cost: 1.25, total_cost: 2.5 } }) };
    };
    try {
      const route = '/admin/usage/stats?user_id=8&start_date=2026-11-06&end_date=2026-11-06';
      await assert.rejects(request('GET', '/admin/usage/stats?user_id=8&start_date=2026-11-06&end_date=2026-11-06&extra=1'), { code: 'ROUTE' });
      usageRole = 'user'; await assert.rejects(request('GET', route), { code: 'DENIED' });
      usageRole = 'admin';
      assert.equal((await request('GET', route)).total_actual_cost, 1.25);
      assert.equal(usageTransport.filter(call => call.path === '/api/v1/admin/usage/stats').length, 1);
      assert.equal(usageTransport.every(call => call.method === 'GET'), true);
    } finally { apiSession.fetch = usageFetch; }
    // Exercise the real request adapter with a mocked transport, never the real platform.
    fixture.setAuthFail(false);
    const transport = [], originalFetch = apiSession.fetch;
    const registrationTransport = [];
    let adapterRole = 'admin', adapterStatus = 200, adapterCode = 0;
    apiSession.fetch = async (url, options) => {
      registrationTransport.push({ path: new URL(url).pathname, method: options.method });
      assert.equal(options.headers.Authorization, 'Bearer fixture-only');
      assert.equal(options.credentials, 'omit');
      if (options.method === 'POST') {
        assert.equal(new URL(url).pathname, '/api/v1/admin/users');
        const body = JSON.parse(options.body);
        assert.equal(body.role, 'user'); assert.equal(body.concurrency, 50); assert.equal(body.balance, 10);
        assert.equal(body.password, 'fictional-adapter-password');
        return { ok: adapterStatus === 200, status: adapterStatus, json: async () => adapterStatus === 409 || adapterCode
          ? { code: adapterCode || 409, message: '邮箱已存在 fictional-adapter-password', data: null }
          : { code: 0, data: { ...body, id: 101 } } };
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
      adapterStatus = 409;
      await assert.rejects(request('POST', '/admin/users', body, context), error =>
        error.code === 'HTTP' && error.reason === 'EMAIL_EXISTS' && error.definitive === true && !error.message.includes('fictional-adapter-password'));
      adapterStatus = 200; adapterCode = 1002;
      await assert.rejects(request('POST', '/admin/users', body, context), error =>
        error.code === 'API' && error.reason === 'EMAIL_EXISTS' && error.definitive === true && !error.message.includes('fictional-adapter-password'));
      adapterStatus = 500; adapterCode = 0;
      await assert.rejects(request('POST', '/admin/users', body, context), error =>
        error.code === 'HTTP' && error.reason === null && error.definitive === false);
      assert.equal(registrationTransport.filter(c => c.method === 'POST').length, 5);
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
      screenshotCaptured, adminScreenshotCaptured, historyScreenshotCaptured, checks: ['channel monitor five visible balances, five collapsed independent encrypted-login forms, optional encrypted email alert and manual test with multiple recipients, passwords clear on save and collapse, isolated login-required fixture',
        'daily usage preview reads fictional actual cost, explicit group-card publish and pause only in isolated fixture, narrow table wraps without overflow',
        'bounded platform duplicate error mapping in real request adapter, no raw password disclosure',
        'Feishu display-name-first token and registration records, name search and plain-text escaping',
        'save feedback next to button, slow pending operation, duplicate-name failure preserves draft, persistent-safe operation log and result filter',
        'reconnect countdown, manual pause and disconnect control while awaiting retry',
        'eleven sidebar destinations with one active view, hidden panels inert, drafts preserved and secrets cleared on navigation',
        'historical usage week table filters by month, week and person, keeps missing days distinct from zero and fits narrow layout',
        'account management list, Beijing month-aware form, one-time plan save/cancel, narrow layout and no real switch POST',
        'real account schedulable adapter enforces fixed route, boolean body, same administrator role and live guard',
        'separate private/public rate catalog, aliases, empty records and escaped names',
        'group-settings IPC rejects customer and foreign frames', 'real rate PUT adapter: exact fields, same administrator, live guard and no unauthorized writes',
        'group selection','mandatory quota','mandatory self-reported operator','double click single POST','masked result','reveal/hide','unsafe group name escaped',
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
  } catch (e) { console.error(e.stack || e.message); clearTimeout(watchdog); app.exit(1); }
}
module.exports = { makeFixture, verifyUI };
