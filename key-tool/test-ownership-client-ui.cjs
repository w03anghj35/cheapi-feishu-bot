'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ownership-client-ui-'));
console.log(JSON.stringify({purpose:'ownership-client-ui',pid:process.pid,userData:root,stop:'app.exit after fixture'}));
app.setPath('userData',root);app.commandLine.appendSwitch('disable-gpu');
const html=fs.readFileSync(path.join(__dirname,'admin.html'),'utf8');
const start=html.indexOf('<section id="user-ownership"'),end=html.indexOf('<section id="daily-usage"');
assert.ok(start>0&&end>start);
const section=html.slice(start,end).replace(' hidden ',' ');
const css=fs.readFileSync(path.join(__dirname,'style.css'),'utf8')+fs.readFileSync(path.join(__dirname,'admin.css'),'utf8');
const renderer=fs.readFileSync(path.join(__dirname,'admin-user-ownership.js'),'utf8');
const page=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css}</style><body><main>${section}</main><script>
window.fixture={profiles:[{name:'甲',userIds:[1,2]},{name:'乙',userIds:[]}],identities:[],changes:[],queries:[],revision:'r0',
 users:[1,2,3].map(id=>({id,email:'user'+id+'@example.invalid',username:'测试客户'+id,role:'user',status:'active',balance:2}))};
window.fixture.queries=[{identity:'a'.repeat(64),actorName:'已核实飞书管理员',name:'全部归属人',
 kind:'usage-all',status:'found',count:3,at:'2026-11-09T08:00:00Z'}];
window.fixtureCalls=[];window.fixtureConfirm=true;window.confirm=()=>window.fixtureConfirm;
window.fixtureError=false;window.fixtureLinked=null;
window.addEventListener('ownership-view-usage',e=>{window.fixtureLinked=e.detail.name});
const update=()=>{window.fixture.clients=window.fixture.profiles.flatMap(p=>p.userIds.map(id=>({id,name:p.name,email:'user'+id+'@example.invalid',since:'2026-11-09'})));return structuredClone(window.fixture)};
window.groupAdmin={onAuth:()=>{},userOwnershipList:async()=>({ok:true,data:update()}),userOwnershipDraftState:async()=>({ok:true,data:null}),
 userOwnershipDraftSave:async()=>({ok:true,data:null}),userOwnershipClientChange:async input=>{
 if(window.fixtureError)return {ok:false,message:'模拟保存失败'};
 if(input.revision!==window.fixture.revision)return {ok:false,message:'revision conflict'};
 window.fixtureCalls.push(input);const profile=window.fixture.profiles.find(p=>p.name===input.name);
 if(input.action==='add')profile.userIds.push(input.userId);else profile.userIds=profile.userIds.filter(id=>id!==input.userId);
 if(input.action==='move')window.fixture.profiles.find(p=>p.name===input.targetName).userIds.push(input.userId);
 window.fixture.revision='r'+window.fixtureCalls.length;
 return {ok:true,data:{...update(),effectiveDay:'2026-11-09'}};
 }};
</script><script>${renderer}</script></body></html>`;
const timer=setTimeout(()=>{console.error('ownership client UI timeout');app.exit(2)},18000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1040,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
 const run=code=>win.webContents.executeJavaScript(code);
 const wait=async expr=>{for(let i=0;i<70;i++){if(await run(expr))return;await new Promise(r=>setTimeout(r,35));}throw Error('UI wait failed: '+expr);};
 await run("document.getElementById('ownership-refresh').click()");
 await wait("document.querySelectorAll('#ownership-client-rows tr').length===2");
 assert.equal(await run("document.querySelectorAll('#ownership-client-add-user option').length"),4);
 assert.match(await run("document.getElementById('ownership-query-rows').textContent"),/管理员全部用量查询/);
 assert.match(await run("document.getElementById('ownership-query-rows').textContent"),/不代表私聊送达/);
 await run("document.getElementById('ownership-client-search').value='user2';document.getElementById('ownership-client-search').dispatchEvent(new Event('input'))");
 assert.equal(await run("document.querySelectorAll('#ownership-client-rows tr').length"),1);
 assert.match(await run("document.getElementById('ownership-client-rows').textContent"),/user2@example.invalid/);
 await run("document.getElementById('ownership-client-search').value='';document.getElementById('ownership-client-search').dispatchEvent(new Event('input'));document.getElementById('ownership-client-add-owner').value='甲';document.getElementById('ownership-client-add-user').value='3';document.getElementById('ownership-client-add-form').dispatchEvent(new Event('submit',{cancelable:true}))");
 await wait("document.querySelectorAll('#ownership-client-rows tr').length===3");
 assert.equal(await run('window.fixtureCalls.length'),1);
 await run("document.querySelector('#ownership-client-rows tr:last-child select').value='乙';document.querySelector('#ownership-client-rows tr:last-child button').click()");
 await wait("window.fixtureCalls.length===2");
 assert.equal(await run("window.fixture.profiles.find(p=>p.name==='乙').userIds[0]"),3);
 await run("document.querySelector('#ownership-client-rows tr:last-child button:last-child').click()");
 assert.equal(await run('window.fixtureLinked'),'乙');
 await run("window.fixtureConfirm=false;document.querySelector('#ownership-client-rows tr:last-child button:nth-of-type(2)').click()");
 assert.equal(await run('window.fixtureCalls.length'),2);
 await run("window.fixtureConfirm=true;window.fixtureError=true;document.querySelector('#ownership-client-rows tr:last-child button:nth-of-type(2)').click()");
 await wait("document.getElementById('ownership-client-status').textContent.includes('模拟保存失败')");
 assert.equal(await run("document.querySelectorAll('#ownership-client-rows tr').length"),3);
 await run("window.fixtureError=false;document.querySelector('#ownership-client-rows tr:last-child button:nth-of-type(2)').click()");
 await wait("window.fixtureCalls.length===3 && document.querySelectorAll('#ownership-client-rows tr').length===2");
 for(const width of [1040,580]){win.setSize(width,900);assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true);}
 fs.mkdirSync(path.join(__dirname,'..','outputs'),{recursive:true});
 fs.writeFileSync(path.join(__dirname,'..','outputs','ownership-client-table-fixture.png'),(await win.webContents.capturePage()).toPNG());
 console.log('Ownership client table add/move/remove/cancel/failure/usage link and narrow layout passed.');
 clearTimeout(timer);win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack);clearTimeout(timer);app.exit(1)});
