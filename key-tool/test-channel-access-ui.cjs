'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-access-ui-'));
app.setPath('userData', dataRoot); app.commandLine.appendSwitch('disable-gpu');
process.on('exit', () => { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {} });
const script = fs.readFileSync(path.join(__dirname, 'admin-channel-access.js'), 'utf8');
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
<section id="channel-access"><button id="channel-access-refresh">刷新</button><p id="channel-access-status"></p>
<form id="channel-access-form"><input id="channel-access-name"><input id="channel-access-bot"><input id="channel-access-sender"><div id="channel-access-options"></div><button id="channel-access-save" type="submit">保存</button></form>
<div id="channel-access-people"></div><div id="channel-access-preview"></div></section>
<script>window.current={people:[],storageError:false,channels:[{id:'a',name:'模拟甲',metric:'积分'},{id:'b',name:'模拟乙',metric:'余额'}]};
window.calls=[];window.groupAdmin={
channelAccessState:async()=>({ok:true,data:window.current}),
channelAccessSave:async input=>{window.calls.push(['save',input]);window.current.people=[{id:'fixture-id',name:input.name,identityHint:'bot / ...sender',channelIds:input.channelIds,enabled:true}];return {ok:true,data:window.current}},
channelAccessUpdate:async input=>{window.calls.push(['update',input]);window.current.people[0].channelIds=input.channelIds;return {ok:true,data:window.current}},
channelAccessRevoke:async id=>{window.calls.push(['revoke',id]);window.current.people[0].enabled=false;return {ok:true,data:window.current}},
channelAccessPreview:async()=>({ok:true,data:[{name:'模拟甲',metric:'积分',status:'ok',display:'120',checkedAt:'2026-11-07'}]})};
window.confirm=()=>true;</script><script>${script}</script></body></html>`;
const timer = setTimeout(() => { console.error('channel access UI timeout'); app.exit(2); }, 15000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 700, height: 650, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  async function waitUntil(expression) {
    for (let index = 0; index < 70; index++) {
      if (await window.webContents.executeJavaScript(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('channel access UI did not update: ' + expression);
  }
  await waitUntil("document.querySelectorAll('#channel-access-options input').length===2");
  await window.webContents.executeJavaScript(`document.getElementById('channel-access-name').value='成员甲';
    document.getElementById('channel-access-bot').value='fixture-bot';
    document.getElementById('channel-access-sender').value='fixture-sender';
    document.querySelector('#channel-access-options input').click();
    document.getElementById('channel-access-save').click();void 0`);
  await waitUntil("document.getElementById('channel-access-status').textContent.includes('加密保存')");
  const saved = await window.webContents.executeJavaScript('window.calls[0]');
  assert.equal(saved[0], 'save'); assert.deepEqual(saved[1].channelIds, ['a']);
  await window.webContents.executeJavaScript("document.querySelector('#channel-access-people button:nth-child(2)').click();void 0");
  await waitUntil("document.getElementById('channel-access-preview').textContent.includes('120')");
  await window.webContents.executeJavaScript("document.querySelector('#channel-access-people .channel-access-options input[value=b]').click();document.querySelector('#channel-access-people button').click();void 0");
  await waitUntil("window.calls.some(row=>row[0]==='update')");
  await window.webContents.executeJavaScript("document.querySelector('#channel-access-people button:last-child').click();void 0");
  await waitUntil("window.calls.some(row=>row[0]==='revoke')");
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('channel-access-people').textContent.includes('已撤销')"), true);
  console.log('Channel access UI save, preview, update and revoke passed.');
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack || error.message); clearTimeout(timer); app.exit(1); });
