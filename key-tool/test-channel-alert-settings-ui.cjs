'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-alert-settings-ui-'));
app.setPath('userData', dataRoot);
app.commandLine.appendSwitch('disable-gpu');
process.on('exit', () => {
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  catch { console.warn('隔离设置页临时目录仍被系统占用，进程退出后可清理。'); }
});
const script = fs.readFileSync(path.join(__dirname, 'admin-channel-alert.js'), 'utf8');
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
  <section id="channel-monitor" hidden></section>
  <details class="channel-alert-settings" open>
  <input id="channel-alert-sender"><input id="channel-alert-code" type="password">
  <textarea id="channel-alert-recipients"></textarea>
  <input id="channel-alert-threshold" type="number"><input id="channel-alert-daily-time" type="time">
  <button id="channel-alert-save">保存</button><button id="channel-alert-pause">暂停</button>
  <button id="channel-alert-clear">清除</button><select id="channel-alert-test-scope"><option value="all">全部</option></select>
  <button id="channel-alert-test">测试</button><p id="channel-alert-status"></p></details>
  <script>window.initial={configured:true,enabled:true,recipients:['one@example.invalid'],
    sender:'fixture@qq.com',threshold:2000,dailyTime:null,attention:[],dailyAttention:[],storageError:false};
  window.saved=null;window.groupAdmin={
    channelAlertState:async()=>({ok:true,data:window.initial}),
    channelAlertSave:async input=>{window.saved=input;return {ok:true,data:{...window.initial,
      threshold:Number(input.threshold),dailyTime:input.dailyTime}}},
    channelAlertOnState:cb=>{window.onAlertState=cb}};</script>
  <script>${script}</script></body></html>`;
const timer = setTimeout(() => { console.error('channel alert settings UI timeout'); app.exit(2); }, 15000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 700, height: 650, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  async function waitUntil(expression) {
    for (let index = 0; index < 60; index++) {
      if (await window.webContents.executeJavaScript(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('alert settings UI did not update');
  }
  await waitUntil("document.getElementById('channel-alert-threshold').value==='2000'");
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('channel-alert-threshold').value='750.5';
    document.getElementById('channel-alert-threshold').dispatchEvent(new Event('input'));
    document.getElementById('channel-alert-daily-time').value='08:45';
    document.getElementById('channel-alert-daily-time').dispatchEvent(new Event('input'));
    window.onAlertState({...window.initial,threshold:999,dailyTime:'10:00'});
    return true;
  })()`);
  const preserved = await window.webContents.executeJavaScript(`({threshold:document.getElementById('channel-alert-threshold').value,
    time:document.getElementById('channel-alert-daily-time').value})`);
  assert.deepEqual(preserved, { threshold: '750.5', time: '08:45' });
  await window.webContents.executeJavaScript("document.getElementById('channel-alert-save').click();void 0");
  await waitUntil("document.getElementById('channel-alert-status').textContent.includes('已加密保存并启用')");
  const result = await window.webContents.executeJavaScript(`({saved:window.saved,
    password:document.getElementById('channel-alert-code').value,
    status:document.getElementById('channel-alert-status').textContent})`);
  assert.equal(result.saved.threshold, '750.5');
  assert.equal(result.saved.dailyTime, '08:45');
  assert.equal(result.saved.authCode, '');
  assert.equal(result.password, '');
  assert.match(result.status, /每日汇总/);
  console.log('Custom threshold and daily-time settings UI passed.');
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack || error.message); clearTimeout(timer); app.exit(1); });
