'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-member-name-ui-'));
app.setPath('userData', dataRoot);
app.commandLine.appendSwitch('disable-gpu');
process.on('exit', () => {
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  catch { console.warn('隔离界面临时目录仍被系统占用，可在进程退出后清理。'); }
});
const identity = 'a'.repeat(64);
const renderer = fs.readFileSync(path.join(__dirname, 'admin-user-ownership.js'), 'utf8');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
  <section id="user-ownership">
  <button id="ownership-refresh">读取平台用户与查询申请</button>
  <p id="ownership-notice"></p><p id="ownership-draft-status"></p>
  <select id="ownership-profile"><option value="">新建归属姓名</option></select>
  <input id="ownership-name"><select id="ownership-identity"></select>
  <select id="ownership-link-profile"></select><button id="ownership-link-save"></button>
  <p id="ownership-link-notice"></p><input id="ownership-search">
  <p id="ownership-summary"></p><div id="ownership-users"></div>
  <button id="ownership-save"></button><div id="ownership-change-rows"></div>
  <div id="ownership-query-rows"></div></section>
  <script>window.groupAdmin={onAuth:()=>{},
    userOwnershipList:async()=>({ok:true,data:{users:[],profiles:[],
      identities:[{identity:'${identity}',name:'飞书用户#${'b'.repeat(20)}',state:'pending',
        currentFeishuName:window.fixtureName||undefined}],queries:[],changes:[],
      nameState:{reason:window.fixtureReason||'ready'}}}),
    userOwnershipDraftState:async()=>({ok:true,data:null})};
    window.fixtureName='用户930290';</script>
  <script>${renderer}</script></body></html>`;
const timer = setTimeout(() => { console.error('ownership member name UI timeout'); app.exit(2); }, 15000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 700, height: 650, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  async function waitUntil(expression) {
    for (let index = 0; index < 60; index++) {
      if (await window.webContents.executeJavaScript(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('ownership name state did not render');
  }
  await window.webContents.executeJavaScript("document.getElementById('ownership-refresh').click();void 0");
  await waitUntil("document.getElementById('ownership-notice').textContent.startsWith('已读取')");
  const current = await window.webContents.executeJavaScript(`(() => {
    const select=document.getElementById('ownership-identity');
    select.value='${identity}';select.dispatchEvent(new Event('change'));
    return {label:select.options[1].textContent,identity:select.value,
      note:document.getElementById('ownership-link-notice').textContent}; })()`);
  assert.match(current.label, /用户930290（当前群显示名）/);
  assert.match(current.label, /身份 a{12}/);
  assert.equal(current.identity, identity);
  assert.match(current.note, /显示名相同不能证明是同一人/);
  await window.webContents.executeJavaScript(`window.fixtureName='';window.fixtureReason='permission';
    document.getElementById('ownership-refresh').click();void 0`);
  await waitUntil("document.getElementById('ownership-notice').textContent.includes('查看群成员')");
  const denied = await window.webContents.executeJavaScript(`(() => ({
    label:document.querySelector('#ownership-identity option:nth-child(2)').textContent,
    note:document.getElementById('ownership-notice').textContent}))()`);
  assert.match(denied.label, /飞书姓名未取得/);
  assert.match(denied.note, /身份摘要核对/);
  console.log('Ownership current-name and permission fallback UI passed.');
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack || error.message); clearTimeout(timer); app.exit(1); });
