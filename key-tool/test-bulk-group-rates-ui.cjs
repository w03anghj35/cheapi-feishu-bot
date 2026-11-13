'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-group-rates-ui-'));
console.log(JSON.stringify({ fixture: 'bulk-group-rates-ui', pid: process.pid, dataRoot }));
app.setPath('userData', dataRoot);
app.commandLine.appendSwitch('disable-gpu');
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, 'admin.css'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, 'admin-bulk-group-rates.js'), 'utf8');
const users = Array.from({ length: 130 }, (_, index) => {
  const id = index + 1;
  return { id, username: `虚构用户${id}`, email: `user${id}@example.invalid`,
    groups: [{ groupId: 10, allowed: true, rate: id === 1 ? 1.8 : 1.5,
      customRate: id === 1 ? 1.8 : null }, ...(id % 2 === 0 ?
      [{ groupId: 20, allowed: true, rate: 2, customRate: null }] : [])] };
});
const snapshot = { owner: 1, groups: [
  { id: 10, name: '普通测试组', rate: 1, exclusive: false, platform: 'openai' },
  { id: 20, name: '专属测试组', rate: 2, exclusive: true, platform: 'anthropic' }
], users, blocked: false, omittedInactive: 2, checkedAt: '2026-11-11T01:00:00Z' };
const section = `<section id="bulk-group-rates">
  <button id="bulk-rates-refresh" type="button">读取现有分组与倍率</button>
  <p id="bulk-rates-notice"></p>
  <div id="bulk-rates-group-list" class="bulk-rates-group-list"></div>
  <input id="bulk-rates-user-search" type="search" placeholder="搜索用户名、邮箱或ID">
  <button id="bulk-rates-select-all" type="button">全选全部用户</button>
  <button id="bulk-rates-import" type="button">读取文档识别邮箱</button><p id="bulk-rates-import-status"></p>
  <div id="bulk-rates-import-preview" hidden></div><button id="bulk-rates-import-select" type="button">勾选文档中的用户</button><button id="bulk-rates-import-deselect" type="button">取消勾选文档中的用户</button>
  <p id="bulk-rates-selection-summary"></p><div id="bulk-rates-user-list" class="bulk-rates-user-list"></div>
  <select id="bulk-rates-direction"><option value="add">上调</option><option value="subtract">下调</option></select>
  <input id="bulk-rates-amount" type="text" value="0.2"><button id="bulk-rates-preview" type="button">预览</button>
  <div id="bulk-rates-preview-list" class="bulk-rates-preview-list"></div><button id="bulk-rates-commit" type="button">确认调整</button>
  <p id="bulk-rates-result"></p>
  <button id="bulk-rates-records-refresh" type="button">读取最近记录</button>
  <p id="bulk-rates-records-status"></p><div id="bulk-rates-records"></div></section>`;
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css}</style><body><main>${section}</main>
<script>window.fixture=${JSON.stringify(snapshot)};window.readCalls=0;window.previewCalls=[];window.commitCalls=[];
window.fixtureHistory=[{requestId:'11111111-1111-4111-8111-111111111111',batchId:'test-batch',targetId:3,state:'unknown',at:'2026-11-11T01:00:00Z'}];
window.reviewCalls=[];
window.importCalls=0;window.importResponse={entries:[{row:1,email:'user1@example.invalid'},{row:2,email:'USER42@example.invalid'},{row:3,email:'missing@example.invalid'}],rowsRead:3,fileType:'xlsx'};
window.confirmLog=[];window.confirm=message=>{window.confirmLog.push(message);return true};window.groupAdmin={onAuth:fn=>{window.authCallback=fn},
 bulkGroupRatesOnProgress:fn=>{window.progressCallback=fn},
 bulkGroupRatesHistory:async()=>({ok:true,data:structuredClone(window.fixtureHistory)}),
 bulkGroupRatesReview:async input=>{window.reviewCalls.push(input);window.fixtureHistory[0].state='success';return {ok:true,data:structuredClone(window.fixtureHistory)}},
 bulkGroupRatesSnapshot:async()=>{window.readCalls++;return {ok:true,data:structuredClone(window.fixture)}},
 bulkGroupRatesImport:async()=>{window.importCalls++;return {ok:true,data:structuredClone(window.importResponse)}},
 bulkGroupRatesPreview:async input=>{window.previewCalls.push(structuredClone(input));const groups=new Set(input.groupIds),users=new Set(input.userIds);
  const changes=[],skipped=[];for(const user of window.fixture.users)if(users.has(user.id))for(const group of window.fixture.groups)if(groups.has(group.id)){
    const owned=user.groups.find(row=>row.groupId===group.id);if(!owned){skipped.push({userId:user.id,groupId:group.id,reason:'not-allowed'});continue}
    changes.push({userId:user.id,groupId:group.id,before:owned.rate.toFixed(1),after:(owned.rate+(input.direction==='add'?1:-1)*Number(input.amount)).toFixed(1)});
  }return {ok:true,data:{previewId:'preview-'+window.previewCalls.length,changes,skipped,expiresAt:'2026-11-11T02:00:00Z'}}},
 bulkGroupRatesCommit:async input=>{window.commitCalls.push(input);return {ok:true,data:{updated:129,skipped:65,failed:0,unknown:0,stopped:false,results:[]}}}};
</script><script>${renderer}</script></body></html>`;

const timeout = setTimeout(() => { console.error('bulk group rates UI timeout'); app.exit(2); }, 25000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1040, height: 850,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) console.error('Renderer: ' + message);
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  const run = code => win.webContents.executeJavaScript(code);
  const wait = async expr => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await run(expr)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error(`UI wait failed: ${expr}`);
  };
  await run("window.dispatchEvent(new CustomEvent('admin-view-change',{detail:{view:'bulk-group-rates'}}))");
  await wait("document.getElementById('bulk-rates-notice').textContent.includes('130 位用户')");
  assert.equal(await run('window.readCalls'), 1);
  assert.equal(await run('window.commitCalls.length'), 0, 'read must never write');
  assert.match(await run("document.getElementById('bulk-rates-notice').textContent"), /另有 2 位停用用户/);
  await wait("document.getElementById('bulk-rates-records').textContent.includes('结果未知')");
  await run("document.querySelector('#bulk-rates-records button').click()");
  await wait("window.reviewCalls.length===1 && document.getElementById('bulk-rates-records').textContent.includes('平台回读一致')");
  assert.deepEqual(await run('window.reviewCalls[0]'), {requestId:'11111111-1111-4111-8111-111111111111'});
  assert.equal(await run('window.commitCalls.length'), 0, 'readback never submits a price update');
  await run("document.getElementById('bulk-rates-refresh').click()");
  await wait("document.getElementById('bulk-rates-notice').textContent.includes('130 位用户')");
  assert.match(await run("document.getElementById('bulk-rates-group-list').textContent"), /普通测试组.*默认 1.0x.*专属测试组.*默认 2.0x/s);
  assert.match(await run("document.querySelector('#bulk-rates-user-list label').textContent"), /普通测试组 1.8x（专属）/);
  assert.match(await run("document.querySelectorAll('#bulk-rates-user-list label')[1].textContent"), /专属测试组 2.0x（默认）/);
  await run("document.getElementById('bulk-rates-import').click()");
  await wait("document.getElementById('bulk-rates-import-status').textContent.includes('精确匹配 2 位')");
  assert.match(await run("document.getElementById('bulk-rates-selection-summary').textContent"), /已勾选 0 位/);
  assert.match(await run("document.getElementById('bulk-rates-import-preview').textContent"), /missing@example.invalid/);
  await run("window.importResponse={entries:[{row:1,email:'user1@example.invalid'}],rowsRead:1,fileType:'png',needsReview:true};document.getElementById('bulk-rates-import').click()");
  await wait("document.getElementById('bulk-rates-import-status').textContent.includes('逐项勾选确认')");
  assert.equal(await run("document.querySelector('#bulk-rates-import-preview input').checked"), false, 'OCR candidates require manual approval');
  assert.equal(await run("document.getElementById('bulk-rates-import-select').disabled"), true);
  await run("document.querySelector('#bulk-rates-import-preview input').click()");
  assert.equal(await run("document.getElementById('bulk-rates-import-select').disabled"), false);
  await run("window.importResponse={entries:[{row:1,email:'user1@example.invalid'},{row:2,email:'USER42@example.invalid'},{row:3,email:'missing@example.invalid'}],rowsRead:3,fileType:'xlsx'};document.getElementById('bulk-rates-import').click()");
  await wait("document.getElementById('bulk-rates-import-status').textContent.includes('精确匹配 2 位')");
  await run("document.getElementById('bulk-rates-import-select').click()");
  assert.match(await run("document.getElementById('bulk-rates-selection-summary').textContent"), /已勾选 2 位/);
  await run("document.getElementById('bulk-rates-select-all').click();document.getElementById('bulk-rates-import-deselect').click()");
  assert.match(await run("document.getElementById('bulk-rates-selection-summary').textContent"), /已勾选 128 位/);
  assert.equal(await run('window.commitCalls.length'), 0, 'import only changes local selections');
  await run("document.getElementById('bulk-rates-select-all').click();document.getElementById('bulk-rates-refresh').click()");
  await wait("document.getElementById('bulk-rates-notice').textContent.includes('保留 130 位勾选')");
  assert.match(await run("document.getElementById('bulk-rates-selection-summary').textContent"), /已勾选 130 位/);
  assert.equal(await run("document.getElementById('bulk-rates-import-preview').hidden"), true, 'refresh clears imported candidates');
  await run("document.querySelector('#bulk-rates-group-list input[value=\"10\"]').click();document.querySelector('#bulk-rates-group-list input[value=\"20\"]').click()");
  assert.match(await run("document.getElementById('bulk-rates-selection-summary').textContent"), /已勾选 130 位/);
  await run("document.getElementById('bulk-rates-user-search').value='user42@';document.getElementById('bulk-rates-user-search').dispatchEvent(new Event('input'))");
  assert.equal(await run("document.querySelectorAll('#bulk-rates-user-list input').length"), 1);
  await run("document.querySelector('#bulk-rates-user-list input[value=\"42\"]').click()");
  assert.match(await run("document.getElementById('bulk-rates-selection-summary').textContent"), /已勾选 129 位/);
  await run("document.getElementById('bulk-rates-preview').click()");
  await wait("document.getElementById('bulk-rates-result').textContent.includes('预览完成')");
  assert.equal(await run('window.commitCalls.length'), 0, 'preview must never write');
  const sent = await run('window.previewCalls[0]');
  assert.equal(sent.userIds.length, 129);
  assert.equal(sent.userIds.includes(42), false);
  assert.deepEqual(sent.groupIds, [10, 20]);
  assert.equal(sent.amount, '0.2');
  assert.equal(sent.direction, 'add');
  assert.match(await run("document.getElementById('bulk-rates-preview-list').textContent"), /1.8x → 2.0x/);
  assert.equal(await run("document.querySelectorAll('#bulk-rates-preview-list li').length"), 200);
  assert.match(await run("document.getElementById('bulk-rates-preview-list').textContent"), /当前展示 200 \/ 258 项/);
  assert.equal(await run("document.getElementById('bulk-rates-commit').disabled"), false);
  fs.mkdirSync(path.join(__dirname, '..', 'outputs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'bulk-group-rates-fixture.png'),
    (await win.webContents.capturePage()).toPNG());
  await run("document.getElementById('bulk-rates-preview-list').scrollIntoView({block:'start'})");
  fs.writeFileSync(path.join(__dirname, '..', 'outputs', 'bulk-group-rates-preview-fixture.png'),
    (await win.webContents.capturePage()).toPNG());
  await run("document.getElementById('bulk-rates-amount').value='0.3';document.getElementById('bulk-rates-amount').dispatchEvent(new Event('input'))");
  assert.equal(await run("document.getElementById('bulk-rates-commit').disabled"), true, 'editing invalidates preview');
  await run("document.getElementById('bulk-rates-amount').value='0.2';document.getElementById('bulk-rates-amount').dispatchEvent(new Event('input'));document.getElementById('bulk-rates-preview').click()");
  await wait("document.getElementById('bulk-rates-commit').disabled===false");
  await run("document.getElementById('bulk-rates-commit').click()");
  await wait("window.commitCalls.length===1");
  assert.deepEqual(await run('window.commitCalls[0]'), { previewId: 'preview-2' });
  assert.match(await run('window.confirmLog.at(-1)'), /仅展开 200 \/ 258 项/);
  assert.equal(await run("document.getElementById('bulk-rates-commit').disabled"), true);
  assert.equal(await run("document.getElementById('bulk-rates-user-list').textContent"), '');
  assert.equal(await run('window.readCalls'), 3, 'a submitted price is not guessed into old snapshot');
  await run("document.getElementById('bulk-rates-refresh').click()");
  await wait("document.getElementById('bulk-rates-notice').textContent.includes('130 位用户')");
  await run("document.getElementById('bulk-rates-user-search').value='';document.getElementById('bulk-rates-user-search').dispatchEvent(new Event('input'));document.querySelector('#bulk-rates-group-list input[value=\"10\"]').click();document.querySelector('#bulk-rates-user-list input[value=\"1\"]').click();document.getElementById('bulk-rates-preview').click()");
  await wait("document.getElementById('bulk-rates-commit').disabled===false");
  await run("window.groupAdmin.bulkGroupRatesSnapshot=async()=>({ok:false,message:'模拟读取失败'});document.getElementById('bulk-rates-refresh').click()");
  await wait("document.getElementById('bulk-rates-notice').textContent.includes('模拟读取失败')");
  assert.equal(await run("document.getElementById('bulk-rates-commit').disabled"), true, 'failed refresh must invalidate old preview');
  assert.equal(await run('window.commitCalls.length'), 1, 'failed refresh must not submit');
  await run("window.fixture.users[0].email='reassigned@example.invalid';window.groupAdmin.bulkGroupRatesSnapshot=async()=>({ok:true,data:structuredClone(window.fixture)});document.getElementById('bulk-rates-refresh').click()");
  await wait("document.getElementById('bulk-rates-notice').textContent.includes('不再匹配已取消')");
  assert.match(await run("document.getElementById('bulk-rates-notice').textContent"), /0 位勾选；1 项不再匹配已取消/);
  assert.match(await run("document.getElementById('bulk-rates-selection-summary').textContent"), /已勾选 0 位/);
  assert.equal(await run('window.commitCalls.length'), 1, 'mismatched identity cannot commit');
  for (const width of [580, 1040]) {
    win.setSize(width, 850);
    assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'), true, `${width}: horizontal overflow`);
  }
  console.log('Bulk rate read/search/select/preview/commit isolation passed.');
  clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack || error.message); clearTimeout(timeout); app.exit(1); });
