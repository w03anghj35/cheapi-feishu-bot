'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-history-sticky-ui-'));
console.log(JSON.stringify({ fixture: 'usage-history-sticky-ui', pid: process.pid, dataRoot }));
app.setPath('userData', dataRoot);
app.commandLine.appendSwitch('disable-gpu');
process.on('exit', () => {
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  catch { console.warn('Electron 测试临时目录仍被系统占用，进程退出后再清理。'); }
});

const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, 'admin.css'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, 'admin-usage-history.js'), 'utf8');
const days = Array.from({ length: 7 }, (_, index) => ({
  day: `2026-11-${String(index + 2).padStart(2, '0')}`, phase: 'final', checkedAt: '2026-11-09T00:00:00Z' }));
const sample = { name: '虚构归属', week: { start: '2026-11-02', end: '2026-11-08' }, days,
  rows: [{ id: 1, email: 'fixture@example.invalid', values: [1, 2, 3, 4, 5, 6, 7],
    recordedSubtotal: 28, complete: true }], totals: [1, 2, 3, 4, 5, 6, 7],
  totalsComplete: Array(7).fill(true), recordedSubtotal: 28, complete: true };
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css}</style>
  <body><main><section id="usage-history">
  <select id="usage-history-month"></select><select id="usage-history-week"></select>
  <select id="usage-history-person"></select><button id="usage-history-refresh"></button>
  <input id="usage-history-export-start" type="date"><input id="usage-history-export-end" type="date">
  <button id="usage-history-export-person"></button><button id="usage-history-export-all"></button>
  <p id="usage-history-export-status"></p>
  <p id="usage-history-collection-status"></p>
  <button id="usage-history-collect-today"></button><p id="usage-history-today-status"></p>
  <button id="usage-history-backfill"></button><p id="usage-history-backfill-status"></p>
  <p id="usage-history-status"></p><div id="usage-history-table" class="usage-history-table-wrap"></div>
  </section></main><script>
  window.fixtureWeek=${JSON.stringify(sample)};
  window.fixtureStamp='2026-11-06T00:00:00Z'; window.fixtureIntervals=[]; window.fixturePending=[];
  window.fixtureCollected=0;
  window.setInterval=(callback,ms)=>{window.fixtureIntervals.push({callback,ms});return window.fixtureIntervals.length};
  window.groupAdmin={dailyUsageHistoryCatalog:async()=>({ok:true,data:{months:['2026-11'],
    weeksByMonth:{'2026-11':[{start:'2026-11-02',end:'2026-11-08'}]},
    names:['虚构归属'],today:'2026-11-09'}}),
    onOwnershipChanged:callback=>{window.fixtureOwnershipChanged=callback},
    dailyUsageHistoryWeek:async()=>({ok:true,data:window.fixtureWeek}),
    dailyUsageState:async()=>({ok:true,data:{enabled:false,lastDay:'2026-11-06',lastCheckedAt:window.fixtureStamp,collection:{available:true,pendingDays:window.fixturePending}}}),
    dailyUsageCollectToday:async()=>{window.fixtureCollected++;return {ok:true,data:{saved:['2026-11-09']}}},
    dailyUsageBackfillStatus:async()=>({ok:true,data:{phase:'idle'}})};
  </script><script>${renderer}</script>
  <script>window.dispatchEvent(new CustomEvent('admin-view-change',{detail:{view:'usage-history'}}));</script></body></html>`;

const timer = setTimeout(() => { console.error('sticky table UI timeout'); app.exit(2); }, 15000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 580, height: 700, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await window.webContents.executeJavaScript("!!document.querySelector('.usage-history-table-scroll table')")) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(await window.webContents.executeJavaScript("!!document.querySelector('.usage-history-table-scroll table')"), true);
  for (const width of [580, 1040]) {
    window.setSize(width, 700);
    const positions = await window.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector('.usage-history-table-wrap');
      const scroll = wrap.querySelector('.usage-history-table-scroll');
      const title = wrap.querySelector('.usage-history-table-title');
      const table = scroll.querySelector('table');
      scroll.scrollLeft = 0;
      const first = () => ({ title: title.getBoundingClientRect().left,
        header: table.querySelector('thead th').getBoundingClientRect().left,
        user: table.querySelector('tbody th').getBoundingClientRect().left,
        total: table.querySelector('tfoot th').getBoundingClientRect().left,
        amount: table.querySelector('tbody td').getBoundingClientRect().left });
      const before = first(); scroll.scrollLeft = 100; const after = first();
      return { before, after, scroll: scroll.scrollLeft, max: scroll.scrollWidth - scroll.clientWidth,
        outerRight: wrap.getBoundingClientRect().right, viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        titleText: title.textContent, label: table.getAttribute('aria-labelledby'), titleId: title.id,
        sticky: getComputedStyle(table.querySelector('tbody th')).position,
        background: getComputedStyle(table.querySelector('tbody th')).backgroundColor };
    })()`);
    assert.ok(positions.max > 100 && positions.scroll >= 99, `${width}: expected horizontal scroll`);
    assert.ok(positions.outerRight <= positions.viewportWidth && positions.documentWidth <= positions.viewportWidth,
      `${width}: page-wide horizontal overflow`);
    assert.match(positions.titleText, /虚构归属 · 2026-11-02 至 2026-11-08/);
    assert.equal(positions.label, positions.titleId);
    assert.equal(positions.sticky, 'sticky');
    assert.notEqual(positions.background, 'rgba(0, 0, 0, 0)');
    for (const key of ['title', 'header', 'user', 'total'])
      assert.ok(Math.abs(positions.before[key] - positions.after[key]) < 1, `${width}: ${key} moved`);
    assert.ok(positions.after.amount < positions.before.amount - 90, `${width}: amount did not move`);
  }
  await window.webContents.executeJavaScript(`(() => {
    window.fixtureWeek.rows[0].values[0]=99;
    window.fixtureStamp='2026-11-06T01:00:00Z';
    window.fixtureIntervals.find(row=>row.ms===60000).callback();
  })()`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await window.webContents.executeJavaScript("document.querySelector('.usage-history-table tbody td')?.textContent.includes('99.0000')")) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('.usage-history-table tbody td')?.textContent.includes('99.0000')"), true);
  // A recovered old day must refresh even if the newest snapshot timestamp has not changed.
  await window.webContents.executeJavaScript(`(() => {
    window.fixturePending=['2026-11-07'];
    window.fixtureWeek.days[5].phase='pending';
    window.fixtureWeek.totalsComplete[5]=false;
    window.fixtureWeek.complete=false;
    window.fixtureIntervals.find(row=>row.ms===60000).callback();
  })()`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await window.webContents.executeJavaScript("document.querySelector('.usage-history-table thead')?.textContent.includes('11-07 待补齐')")) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('.usage-history-table thead')?.textContent.includes('11-07 待补齐')"), true);
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('usage-history-collection-status').textContent.includes('待补齐历史日期：2026-11-07')"), true);
  await window.webContents.executeJavaScript(`(() => {
    window.fixturePending=[]; window.fixtureWeek.days[5].phase='final';
    window.fixtureIntervals.find(row=>row.ms===60000).callback();
  })()`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await window.webContents.executeJavaScript("document.querySelector('.usage-history-table thead')?.textContent.includes('11-07 已固定')")) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('.usage-history-table thead')?.textContent.includes('11-07 已固定')"), true);
  await window.webContents.executeJavaScript(`(() => {
    window.fixtureWeek={...window.fixtureWeek,rows:[],totals:Array(7).fill(null),
      totalsComplete:Array(7).fill(false),recordedSubtotal:0,complete:false};
    document.getElementById('usage-history-refresh').click();
  })()`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await window.webContents.executeJavaScript("document.querySelector('.usage-history-table tbody')?.textContent.includes('暂无已采集')")) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const empty = await window.webContents.executeJavaScript(`(() => {
    const title=document.querySelector('.usage-history-table-title');
    const table=document.querySelector('.usage-history-table');
    return {message:table.querySelector('tbody').textContent,
      labelled:table.getAttribute('aria-labelledby')===title.id,
      noCaption:table.querySelector('caption')===null};
  })()`);
  assert.match(empty.message, /暂无已采集/);
  assert.equal(empty.labelled, true);
  assert.equal(empty.noCaption, true);
  await window.webContents.executeJavaScript(`(() => {
    window.fixtureWeek={...window.fixtureWeek,today:'2026-11-09',awaitingCount:1,
      week:{start:'2026-11-09',end:'2026-11-15'},
      days:Array.from({length:7},(_,i)=>({day:'2026-11-'+String(9+i).padStart(2,'0'),phase:i?'future':'ongoing'})),
      rows:[1,2,3].map(id=>({id,email:'user'+id+'@example.invalid',values:id===3?Array(7).fill(null):[0,...Array(6).fill(null)],
        hasRecordedUsage:id!==3,awaitingSample:id===3,complete:false,recordedSubtotal:0}))};
    window.fixtureOwnershipChanged();
  })()`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await window.webContents.executeJavaScript("document.querySelectorAll('.usage-history-table tbody tr').length===3")) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.usage-history-table tbody tr').length"), 3);
  const pendingRow = await window.webContents.executeJavaScript("document.querySelector('.usage-history-table tbody tr:last-child').textContent");
  assert.match(pendingRow, /user3@example.invalid/); assert.match(pendingRow, /待采样/);
  assert.match(pendingRow, /尚无记录/); assert.equal(pendingRow.includes('$0.0000'), false);
  assert.match(await window.webContents.executeJavaScript("document.getElementById('usage-history-status').textContent"), /1 个当前归属账号今日待采样/);
  await window.webContents.executeJavaScript("document.getElementById('usage-history-collect-today').click()");
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await window.webContents.executeJavaScript("!document.getElementById('usage-history-collect-today').disabled")) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(await window.webContents.executeJavaScript('window.fixtureCollected'), 1);
  assert.match(await window.webContents.executeJavaScript("document.getElementById('usage-history-today-status').textContent"), /今日用量已采样并保存/);
  await window.webContents.executeJavaScript(`window.groupAdmin.dailyUsageCollectToday=async()=>({ok:true,data:{skipped:'backoff'}});document.getElementById('usage-history-collect-today').click()`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await window.webContents.executeJavaScript("!document.getElementById('usage-history-collect-today').disabled")) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.match(await window.webContents.executeJavaScript("document.getElementById('usage-history-today-status').textContent"), /等待退避重试/);
  console.log('Fixed title and account column passed at 580px and 1040px.');
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack || error.message); clearTimeout(timer); app.exit(1); });
