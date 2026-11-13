'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-query-ui-'));
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.on('quit', () => { fs.rmSync(userData, { recursive: true, force: true }); });
const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const start = html.indexOf('<section id="recharge-query"');
const end = html.indexOf('<footer>', start);
assert.ok(start > 0 && end > start);
const section = html.slice(start, end).replace(' hidden ', ' ');
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8') +
  fs.readFileSync(path.join(__dirname, 'admin.css'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, 'admin-recharge-query.js'), 'utf8');
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css}</style><body><main>${section}</main><script>
window.calls=[];
window.groupAdmin={onAuth:()=>{},rechargeOnProgress:callback=>{window.progress=callback},
 rechargeQuery:async input=>{window.calls.push(input);window.progress({scannedUsers:1,totalUsers:1,rows:2});return {ok:true,data:{
 rows:[{id:'r1',at:'2026-11-10T08:00:00+08:00',recipientId:11,recipientEmail:'a@example.invalid',
 recipientName:'<img src=x onerror=alert(1)>',kind:'admin-recharge',classification:'operator-unknown',
 amount:'9.99999',actorId:null,actorName:null,selfStatus:'unknown'},
 {id:'r2',at:'2026-11-10T08:00:01+08:00',recipientId:11,recipientEmail:'a@example.invalid',
 recipientName:'甲',kind:'admin-recharge',classification:'operator-unknown',
 amount:'0.00000001',actorId:null,actorName:null,selfStatus:'unknown'}],
 summary:{adminGross:window.calls.length>1?'1000000000000':'9.99999001',selfExcluded:null,adminNet:null,smallOther:null,smallThreshold:10,selfExclusionReady:false},
 scannedUsers:1,complete:true,operatorAvailable:false,unit:'$',auditRows:[{id:20,at:'2026-11-10T08:00:00+08:00',
 recipientId:11,recipientEmail:'a@example.invalid',recipientName:'甲',actorId:7,actorEmail:'admin@example.invalid',
 operation:'POST /admin/users/11/balance',requestedValue:'9.99999',statusCode:200,requestId:'req-1',selfCandidate:true}],
 auditComplete:false,auditWarning:'部分审计页未返回。'}}}}
};
</script><script>${renderer}</script></body></html>`;
const pagePath = path.join(userData, 'recharge-query-fixture.html');
fs.writeFileSync(pagePath, page);
const timer = setTimeout(() => { console.error('recharge query UI timeout'); app.exit(2); }, 18000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(pagePath);
  const run = code => win.webContents.executeJavaScript(code);
  const wait = async expression => {
    for (let index = 0; index < 70; index++) {
      if (await run(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    throw Error(`UI wait failed: ${expression}`);
  };
  await run("document.getElementById('recharge-query-form').dispatchEvent(new Event('submit',{cancelable:true}))");
  await wait("document.querySelectorAll('#recharge-query-results li').length===2");
  assert.equal(await run('window.calls.length'), 1);
  assert.equal(await run('document.querySelectorAll("#recharge-query-results img").length'), 0);
  assert.match(await run('document.getElementById("recharge-query-results").textContent'), /操作人未提供/);
  assert.match(await run('document.getElementById("recharge-query-results").textContent'), /9\.99999 \$/);
  assert.match(await run('document.getElementById("recharge-query-results").textContent'), /0\.00000001 \$/);
  assert.doesNotMatch(await run('document.getElementById("recharge-query-results").textContent'), /充值 · 0 \$/);
  assert.match(await run('document.getElementById("recharge-query-summary").textContent'), /待确认/);
  assert.match(await run('document.getElementById("recharge-query-summary").textContent'), /9\.99999001 \$/);
  assert.match(await run('document.getElementById("recharge-query-audit-rows").textContent'), /请求值：9.99999（非已入账金额）/);
  assert.match(await run('document.getElementById("recharge-query-audit-status").textContent'), /读取不完整/);
  assert.equal(await run('document.querySelectorAll("#recharge-query-results li").length'), 2);
  await run("document.getElementById('recharge-query-admin-id').value='7';document.getElementById('recharge-query-admin-id').dispatchEvent(new Event('input'))");
  assert.equal(await run('document.querySelectorAll("#recharge-query-results li").length'), 0);
  assert.match(await run('document.getElementById("recharge-query-status").textContent'), /请重新查询/);
  await run("document.getElementById('recharge-query-form').dispatchEvent(new Event('submit',{cancelable:true}))");
  await wait("document.querySelectorAll('#recharge-query-results li').length===2");
  assert.match(await run('document.getElementById("recharge-query-summary").textContent'), /1,000,000,000,000 \$/);
  console.log('Recharge query UI classification, audit separation, XSS escaping and stale-result clearing passed.');
  clearTimeout(timer); win.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack); clearTimeout(timer); app.exit(1); });
