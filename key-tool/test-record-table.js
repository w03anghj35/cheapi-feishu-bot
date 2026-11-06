'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {buildRows,csv,makeRecordTable,HEADERS}=require('./record-table');
function source(){return {tokens:[{requestId:'token-fixture',at:'2026-10-30T16:00:00.123Z',owner:1,state:'success',operator:{name:'飞书用户#0123456789abcdef0123',source:'feishu-open-id'},body:{name:'fixture',group_id:7,quota:5},receipt:{id:9},result:'fictional-secret-encrypted'}],
 registrations:[{requestId:'registration-fixture',at:'2026-10-31T00:00:00Z',owner:1,state:'unknown',body:{email:'fixture@example.invalid',username:'=1+1',password:'fictional-password',balance:0,concurrency:1}}],
 settings:[{requestId:'settings-fixture',at:'2026-10-31T01:00:00Z',owner:1,targetId:8,state:'success',body:{changes:[{groupId:7,rate:0.8,allowed:true},{groupId:9,rate:null,allowed:false}]}}]};}
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'record-table-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('white-list table includes all operations, status, zero and Beijing time without credentials',()=>{
 const rows=buildRows(source());assert.equal(rows.length,4);assert.equal(rows[0][1],'2026-10-31 00:00:00.123');assert.equal(rows[1][9],0);assert.equal(rows[3][11],'默认倍率');
 assert.equal(rows.every(r=>r.length===HEADERS.length),true);const output=csv(rows);assert.equal(output.charCodeAt(0),0xfeff);
 assert.ok(output.includes("'=1+1"));assert.equal(output.includes('fictional-password'),false);assert.equal(output.includes('fictional-secret'),false);
});
test('initial and changed states append trace once; reopen and repeat remain idempotent',t=>{
 const dir=temp(t),s=source(),table=makeRecordTable(dir);assert.equal(table.sync(s).error,null);
 const trace=path.join(dir,'变化轨迹.jsonl');assert.equal(fs.readFileSync(trace,'utf8').trim().split('\n').length,4);
 table.sync(s);assert.equal(fs.readFileSync(trace,'utf8').trim().split('\n').length,4);
 s.registrations[0].state='success';table.sync(s);assert.equal(fs.readFileSync(trace,'utf8').trim().split('\n').length,5);
 const reopened=makeRecordTable(dir);reopened.sync(s);assert.equal(fs.readFileSync(trace,'utf8').trim().split('\n').length,5);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'创建记录.json'),'utf8')).rows.length,4);
});
test('CSV locked preserves old CSV and resumes without duplicate history',t=>{
 const dir=temp(t),s=source();makeRecordTable(dir).sync(s);const file=path.join(dir,'创建记录.csv'),before=fs.readFileSync(file,'utf8');
 let locked=true;const io={...fs,renameSync(from,to){if(locked&&to===file)throw new Error('fixture lock');return fs.renameSync(from,to);}};
 s.tokens[0].state='unknown';const table=makeRecordTable(dir,{io});assert.ok(table.sync(s).error);assert.equal(fs.readFileSync(file,'utf8'),before);
 locked=false;assert.equal(table.sync(s).error,null);assert.notEqual(fs.readFileSync(file,'utf8'),before);
 assert.equal(fs.readdirSync(dir).some(n=>n.endsWith('.tmp')),false);
 assert.equal(fs.readFileSync(path.join(dir,'变化轨迹.jsonl'),'utf8').trim().split('\n').length,5);
});
test('missing source and disappearing records never erase the previous table',t=>{
 const dir=temp(t),table=makeRecordTable(dir),s=source();table.sync(s);const before=fs.readFileSync(path.join(dir,'创建记录.csv'),'utf8');
 assert.ok(table.sync({}).error);s.tokens=[];assert.ok(table.sync(s).error);assert.equal(fs.readFileSync(path.join(dir,'创建记录.csv'),'utf8'),before);
});
test('corrupt trace is preserved and export refuses silent recovery',t=>{
 const dir=temp(t);fs.writeFileSync(path.join(dir,'变化轨迹.jsonl'),'broken');const table=makeRecordTable(dir);assert.ok(table.sync(source()).error);
 assert.equal(fs.readFileSync(path.join(dir,'变化轨迹.jsonl'),'utf8'),'broken');assert.equal(fs.existsSync(path.join(dir,'创建记录.csv')),false);
});
test('CSV quotes commas and multiline text; formula prefixes never execute',()=>{
 const s=source();for(const value of ['@SUM(1,2)',' -1+2','+cmd','line\n"quoted",name']){
 s.registrations[0].body.username=value;const output=csv(buildRows(s));if(value.startsWith('line'))assert.ok(output.includes('""quoted""'));else assert.ok(output.includes("'"+value));}
});
test('Windows native directory initialization handles Chinese paths and inherited foreign PSModulePath',{skip:process.platform!=='win32'},t=>{
 const dir=temp(t),root=path.join(dir,'中文项目');fs.mkdirSync(root);
 const prior=process.env.PSModulePath;process.env.PSModulePath='Z:\\fictional-foreign-modules';
 try{assert.equal(require('./prepare-record-directory').prepareRecordDirectory(root),true);assert.equal(fs.existsSync(path.join(root,'本机数据')),true);
   assert.equal(require('./prepare-record-directory').prepareRecordDirectory(root),true);
 }finally{if(prior===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=prior;}
});
