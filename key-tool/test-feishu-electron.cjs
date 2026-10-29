'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');
const { makeFeishuStore } = require('./feishu-store');
function makeFixture() {
  const clients = [];
  return { clients, createClient(options) {
    const client = { options, status: 'connecting', starts: 0, closes: 0,
      start() { this.starts++; return Promise.resolve(); }, close() { this.closes++; this.status = 'idle'; },
      getConnectionStatus() { return { state: this.status, reconnectAttempts: 0 }; }
    }; clients.push(client); return client;
  } };
}
async function verify({ app, window, connection, fixture, dataDir, safeStorage }) {
  const outputDir = path.join(__dirname, '..', 'outputs'); fs.mkdirSync(outputDir, { recursive: true });
  const reportFile = path.join(outputDir, 'feishu-connection-ui-verification.json');
  const checks = []; let screenshotCaptured = false;
  const watchdog = setTimeout(() => app.exit(2), 35000);
  const run = code => window.webContents.executeJavaScript(code);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async expr => { for (let i = 0; i < 100; i++) { if (await run(expr)) return; await sleep(50); } throw new Error('UI wait failed: ' + expr); };
  try {
    await wait('document.getElementById("connection-status").textContent==="等待配置"');
    assert.equal(fixture.clients.length, 0); assert.equal(await run('typeof require'), 'undefined');
    assert.equal(await run('document.getElementById("app-secret").type'), 'password'); checks.push('password input, sandbox, no auto-connect');
    await run('document.getElementById("app-id").value="cli_1234567890abcdef";document.getElementById("app-secret").value="fixture-ui-secret-not-real";document.getElementById("config-form").dispatchEvent(new Event("submit",{cancelable:true}));void 0');
    await wait('document.getElementById("notice").textContent.includes("配置已加密保存") && !document.getElementById("connect").disabled');
    assert.equal(await run('document.getElementById("app-secret").value'), '');
    const stored = makeFeishuStore(dataDir, safeStorage).load(); assert.equal(stored.appSecret, 'fixture-ui-secret-not-real');
    const disk = fs.readFileSync(path.join(dataDir, 'feishu-connection.journal'), 'utf8');
    assert.equal(disk.includes(stored.appSecret), false); assert.equal(disk.includes(stored.appId), false);
    assert.equal(JSON.stringify(await run('window.feishuConnection.state()')).includes(stored.appSecret), false);
    checks.push('actual target-directory DPAPI save, encrypted disk, reopen decrypt, no secret in IPC');
    await run('document.getElementById("app-id").value="cli_1111111111111111";document.getElementById("app-id").dispatchEvent(new Event("input"));void 0');
    await sleep(1300); assert.equal(await run('document.getElementById("app-id").value'), 'cli_1111111111111111');
    assert.equal(await run('document.getElementById("connect").disabled'), true); checks.push('polling preserves drafts and prevents connection using unsaved form');
    await run('document.getElementById("app-id").value="cli_1234567890abcdef";document.getElementById("app-secret").value="fixture-ui-secret-not-real";document.getElementById("config-form").dispatchEvent(new Event("submit",{cancelable:true}));void 0');
    await wait('!document.getElementById("connect").disabled');
    await run('document.getElementById("connect").click();document.getElementById("connect").click();void 0');
    await wait('document.getElementById("connection-status").textContent==="正在连接"');
    assert.equal(fixture.clients.length, 1); assert.equal(fixture.clients[0].starts, 1);
    const client = fixture.clients[0]; client.status = 'connected'; client.options.onReady();
    await wait('document.getElementById("connection-status").textContent==="已连接"'); checks.push('double click single flight; resolved start is not online; confirmed OPEN is online');
    client.options.handlers['im.message.receive_v1']({ message: { content: 'not-retained' } });
    client.options.handlers['card.action.trigger']({ action: { value: 'no-create' } });
    await wait('document.getElementById("message-count").textContent==="1" && document.getElementById("callback-count").textContent==="1"');
    assert.equal(JSON.stringify(connection.state()).includes('not-retained'), false); checks.push('message/card delivery counts with no retained body or creation');
    client.status = 'reconnecting'; client.options.onReconnecting();
    await wait('document.getElementById("connection-status").textContent.includes("重连")');
    client.options.onReconnected(); client.status = 'connected';
    await wait('document.getElementById("connection-status").textContent==="已连接"'); checks.push('reconnect callback race and subsequent status recovery');
    const other = new BrowserWindow({ show: false });
    try {
      const allowed = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
      for (const name of ['state', 'save', 'connect', 'disconnect']) {
        const handler = ipcMain._invokeHandlers.get('feishu-connection:' + name);
        assert.equal(handler({ sender: other.webContents, senderFrame: other.webContents.mainFrame }, {}).code, 'DENIED');
        assert.equal(handler({ ...allowed, senderFrame: { url: window.webContents.mainFrame.url } }, {}).code, 'DENIED');
      }
    } finally { other.destroy(); }
    checks.push('actual registered IPC rejects other window and child-frame impersonation');
    window.showInactive(); await sleep(180);
    try { const screenshot = await window.webContents.capturePage(); if (!screenshot.isEmpty()) { fs.writeFileSync(path.join(outputDir, 'feishu-connection-ui-fixture.png'), screenshot.toPNG()); screenshotCaptured = true; } } catch { /* screenshot is separately reported, never treated as passed */ }
    window.setSize(560, 850); await sleep(150);
    assert.equal(await run('document.documentElement.scrollWidth <= window.innerWidth'), true); checks.push('narrow-window layout has no horizontal overflow');
    await run('document.getElementById("disconnect").click();void 0');
    await wait('document.getElementById("connection-status").textContent==="未连接"');
    client.status = 'connected'; client.options.onReady(); client.options.onError(new Error('synthetic-private'));
    await sleep(1100); assert.equal(await run('document.getElementById("connection-status").textContent'), '未连接'); checks.push('manual stop ignores late callback; no automatic restart');
    const result = { passed: true, verifiedAt: new Date().toISOString(), runtime: process.versions.electron,
      checks, screenshotCaptured, realFeishuRequests: 0, realMessagesSent: 0, realTokensCreated: 0,
      boundary: 'Fake transport in real Electron; actual DPAPI, local disk and UI. Live Feishu credentials, publication and event delivery remain unverified.' };
    fs.writeFileSync(reportFile, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    clearTimeout(watchdog); connection.disconnect(); app.exit(0);
  } catch (error) {
    fs.writeFileSync(reportFile, JSON.stringify({ passed: false, checks, failedStep: error.message, screenshotCaptured }, null, 2));
    console.error('Feishu UI verification failed: ' + error.message); clearTimeout(watchdog); connection.disconnect(); app.exit(1);
  }
}
module.exports = { makeFixture, verify };
