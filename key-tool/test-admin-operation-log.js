'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {makeAdminOperationLog}=require('./admin-operation-log');
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-log-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
test('success, progress and failed HTTP operations persist without raw arguments or errors',async t=>{
  const dir=temp(t),log=makeAdminOperationLog(dir);const secret='fictional-private-token-do-not-log';
  const success=await log.run('admin-group-settings-save',async()=>{log.step('storage');return {credential:secret};});
  assert.equal(success.data.credential,secret);assert.ok(success.operationId);
  const failure=await log.run('admin-group-settings-refresh',async()=>{log.step('groups');throw Object.assign(new Error(secret),{code:'HTTP',httpStatus:403,body:secret});});
  assert.equal(failure.failed,true);const restored=makeAdminOperationLog(dir).state();
  assert.equal(restored.items.length,2);assert.equal(restored.items[0].stage,'groups');assert.equal(restored.items[0].httpStatus,403);
  assert.equal(restored.items[1].status,'success');assert.equal(fs.readFileSync(path.join(dir,'admin-operations.jsonl'),'utf8').includes(secret),false);
});
test('running state visible, restart marks incomplete operation as interrupted, late result completes',async t=>{
  const dir=temp(t),log=makeAdminOperationLog(dir);let release;
  const work=log.run('admin-group-settings-save',async()=>{log.step('identity');await new Promise(r=>{release=r;});});
  assert.equal(log.state().items[0].status,'running');assert.equal(makeAdminOperationLog(dir).state().items[0].status,'interrupted');
  release();await work;assert.equal(log.state().items[0].status,'success');
});
test('concurrent operations keep independent stage and ids',async()=>{
  const log=makeAdminOperationLog('',{memory:true});let release;
  const a=log.run('admin-group-settings-save',async()=>{log.step('groups');await new Promise(r=>{release=r;});log.step('storage');throw {code:'STORAGE'};});
  await log.run('admin-login',async()=>{log.step('identity');});release();await a;
  const rows=log.state().items;assert.equal(rows.find(r=>r.action==='admin-login').status,'success');
  assert.equal(rows.find(r=>r.action==='admin-group-settings-save').stage,'storage');assert.equal(new Set(rows.map(r=>r.id)).size,2);
});
test('logging disk failure does not falsify a successful business result',async t=>{
  const dir=temp(t),io={...fs,openSync(){throw new Error('fixture disk');}},log=makeAdminOperationLog(dir,{io});
  const result=await log.run('admin-group-settings-save',async()=>42);assert.equal(result.data,42);assert.equal(result.logWarning,true);
  assert.equal(log.state().items[0].status,'success');
});
test('corrupt log preserves file, rejects raw fields, and bounded memory retains recent entries',async t=>{
  const dir=temp(t),file=path.join(dir,'admin-operations.jsonl');fs.writeFileSync(file,'broken');
  const log=makeAdminOperationLog(dir);assert.equal(log.state().storageError,true);
  for(let i=0;i<510;i++)await log.run('admin-refresh',async()=>{});
  assert.equal(log.state().items.length,500);assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
test('unsupported polling/log reads do not spam logs; unknown error codes sanitized',async()=>{
  const log=makeAdminOperationLog('',{memory:true});await log.run('admin-operation-log',async()=>log.state());
  assert.equal(log.state().items.length,0);await log.run('admin-login',async()=>{throw {code:'fictional-secret',httpStatus:900};});
  assert.equal(log.state().items[0].code,'OPERATION_ERROR');assert.equal(log.state().items[0].httpStatus,null);
});
