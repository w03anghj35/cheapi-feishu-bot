'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-usage-review-ui-'));
app.setPath('userData', dataRoot);
app.commandLine.appendSwitch('disable-gpu');
process.on('exit', () => {
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  catch { console.warn('隔离用量核对测试目录仍被系统占用。'); }
});
const renderer = fs.readFileSync(path.join(__dirname, 'admin-daily-usage.js'), 'utf8');
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
  <section id="user-ownership"><button id="daily-usage-preview"></button>
  <input id="daily-usage-time" type="time">
  <button id="daily-usage-enable"></button><button id="daily-usage-pause"></button>
  <p id="daily-usage-status"></p><div id="daily-usage-reviews"></div>
  <div id="daily-usage-preview-rows"></div></section>
  <script>
  window.record={name:'虚构归属',phase:'unknown',action:'create',
    at:'2026-11-06T02:00:03Z',attemptedAt:'2026-11-06T02:00:00Z',
    failure:{kind:'api',httpStatus:403,apiCode:230027}};
  window.current={enabled:true,groupRef:'fixture88',cards:[window.record],lastCheckedAt:null};
  window.reviewCalls=[];window.enabledCalls=0;window.savedTime=null;window.cancelNext=true;
  window.confirm=()=>true;
  window.groupAdmin={dailyUsageState:async()=>({ok:true,data:window.current}),
    dailyUsagePreview:async()=>({ok:true,data:{day:'2026-11-06',rows:[{name:'虚构归属',
      users:[{email:'fixture@example.invalid',cost:1}]}]}}),
    dailyUsageReviewAbsent:async input=>{window.reviewCalls.push(input);
      if(window.cancelNext){window.cancelNext=false;return {ok:true,data:{cancelled:true,state:window.current}};}
      window.current={...window.current,enabled:false,cards:[{...window.record,phase:'reviewed-absent'}]};
      return {ok:true,data:{cancelled:false,state:window.current}};},
    dailyUsageEnable:async time=>{window.enabledCalls++;window.savedTime=time;
      window.current={...window.current,enabled:true,dailyTime:time,effectiveDay:'2026-11-07'};
      return {ok:true,data:{state:window.current,scheduled:true}};}};
  </script><script>${renderer}</script>
  <script>window.dispatchEvent(new CustomEvent('admin-view-change',{detail:{view:'user-ownership'}}));</script>
  </body></html>`;

const timer = setTimeout(() => { console.error('daily usage review UI timeout'); app.exit(2); }, 18000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 680, height: 700, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  const run = text => window.webContents.executeJavaScript(text);
  async function until(expression) {
    for (let attempt = 0; attempt < 70; attempt++) {
      if (await run(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(`review UI did not update: ${expression}`);
  }
  await until("document.querySelector('.daily-usage-review button') !== null");
  assert.equal(await run("document.querySelector('.daily-usage-review button').disabled"), true);
  assert.equal(await run("document.getElementById('daily-usage-reviews').textContent.includes('飞书码 230027')"), true);
  await run("document.getElementById('daily-usage-preview').click();void 0");
  await until("document.getElementById('daily-usage-preview-rows').textContent.includes('fixture@example.invalid')");
  await run("document.querySelector('.daily-usage-review input').click();document.querySelector('.daily-usage-review button').click();void 0");
  await until("document.getElementById('daily-usage-status').textContent.includes('已取消人工核对')");
  assert.equal(await run('window.current.enabled'), true);
  await run("document.querySelector('.daily-usage-review input').click();document.querySelector('.daily-usage-review button').click();void 0");
  await until("document.getElementById('daily-usage-status').textContent.includes('已加密记录')");
  const result = await run(`({reviewCalls:window.reviewCalls,enabled:window.current.enabled,
    cardPhase:window.current.cards[0].phase,previewCleared:!document.getElementById('daily-usage-preview-rows').textContent,
    enableDisabled:document.getElementById('daily-usage-enable').disabled,enabledCalls:window.enabledCalls})`);
  assert.equal(result.reviewCalls.length, 2);
  assert.deepEqual(result.reviewCalls[0], { name: '虚构归属', at: '2026-11-06T02:00:03Z', confirmed: true });
  assert.equal(result.enabled, false);
  assert.equal(result.cardPhase, 'reviewed-absent');
  assert.equal(result.previewCleared, true);
  assert.equal(result.enableDisabled, true);
  assert.equal(result.enabledCalls, 0);
  await run("document.getElementById('daily-usage-time').value='09:15';document.getElementById('daily-usage-time').dispatchEvent(new Event('input'));document.getElementById('daily-usage-preview').click();void 0");
  await until("!document.getElementById('daily-usage-enable').disabled");
  await run("document.getElementById('daily-usage-enable').click();void 0");
  await until("document.getElementById('daily-usage-status').textContent.includes('已设定')");
  assert.deepEqual(await run('({time:window.savedTime,calls:window.enabledCalls,enabled:window.current.enabled})'),
    { time: '09:15', calls: 1, enabled: true });
  console.log('Daily usage manual-review UI passed without sending.');
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack || error.message); clearTimeout(timer); app.exit(1); });
