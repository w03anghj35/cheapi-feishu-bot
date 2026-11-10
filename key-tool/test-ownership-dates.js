'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UserOwnership, makeOwnershipStore } = require('./user-ownership');
const { DailyUsage } = require('./daily-usage');
const { historyWeek } = require('./daily-usage-history');
const { exportRows } = require('./daily-usage-export');
const { projectSnapshots, validateMembership } = require('./ownership-dates');
const scope = { owner: 1, groupId: 'oc_fixture_12345678' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-dates-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const safe = { isEncryptionAvailable:()=>true, encryptString:v=>Buffer.from('sealed:'+v),
    decryptString:b=>{assert.ok(b.toString().startsWith('sealed:'));return b.toString().slice(7);} };
  const store=makeOwnershipStore(dir,safe);
  let now=Date.parse('2026-11-09T02:00:00Z'), owner=1, writes=0;
  const request=async(method,route)=>{
    assert.equal(method,'GET');
    if(route==='/auth/me')return {id:owner,role:'admin'};
    if(route.startsWith('/admin/users?'))return {items:[1,2,3].map(id=>({id,email:`u${id}@example.invalid`,username:`U${id}`,role:'user',status:'active',balance:1})),total:3};
    if(route.startsWith('/admin/usage/stats?')){writes++;return {total_actual_cost:2};}
    throw Error('unexpected request');
  };
  const options={request,store,getOwner:()=>owner,getGroupId:()=>scope.groupId,now:()=>now};
  const ownership=new UserOwnership(options);
  return {ownership,request,dir,safe,options,setDay:day=>{now=Date.parse(day+'T02:00:00Z');},setOwner:v=>owner=v,
    mutate:input=>ownership.changeClient({...input,revision:ownership.revision()}),reads:()=>writes};
}
const snap=(day,ids)=>({day,final:true,checkedAt:day+'T15:00:00Z',rows:[{name:'甲',users:ids.map(id=>({id,email:`u${id}@example.invalid`,cost:id}))},{name:'乙',users:[]}]});
test('add/remove/move dates survive encrypted reopen, historical table and export exclude removed day only',async t=>{
  const f=fixture(t),o=f.ownership;
  await o.assignName({name:'甲',userIds:[1,2]}); await o.assignName({name:'乙',userIds:[]});
  f.setDay('2026-11-10'); await f.mutate({action:'remove',name:'甲',userId:1});
  assert.deepEqual(o.profilesAt('2026-11-09')[0].userIds,[1,2]);
  assert.deepEqual(o.profilesAt('2026-11-10')[0].userIds,[2]);
  const state={snapshots:{'2026-11-09':snap('2026-11-09',[1,2]),'2026-11-10':snap('2026-11-10',[1,2])}};
  const original=structuredClone(state);
  const week=historyWeek(state,{month:'2026-11',weekStart:'2026-11-09',name:'甲'},'2026-11-10',['甲','乙'],o.profileAccounts('甲'),o.datedProfiles());
  assert.deepEqual(week.rows[0].values,[1,null,null,null,null,null,null]);
  assert.equal(week.rows[0].membership[1],'removed'); assert.equal(week.totals[1],2);
  const exported=exportRows(projectSnapshots(state,o.datedProfiles()),{scope:'person',name:'甲',start:'2026-11-09',end:'2026-11-10'},'2026-11-10',['甲']);
  assert.equal(exported.rows.filter(r=>r.id===1).length,1);assert.equal(exported.rows.find(r=>r.id===1).day,'2026-11-09');
  assert.deepEqual(state,original);
  f.setDay('2026-11-11'); await f.mutate({action:'move',name:'甲',targetName:'乙',userId:2});
  assert.deepEqual(o.profilesAt('2026-11-10').map(r=>r.userIds),[[2],[]]);
  assert.deepEqual(o.profilesAt('2026-11-11').map(r=>r.userIds),[[],[2]]);
  f.setDay('2026-11-12'); await f.mutate({action:'add',name:'甲',userId:1});
  assert.deepEqual(o.profilesAt('2026-11-11')[0].userIds,[]);
  assert.deepEqual(o.profilesAt('2026-11-12')[0].userIds,[1]);
  const reopened=new UserOwnership({...f.options,store:makeOwnershipStore(f.dir,f.safe)});
  assert.deepEqual(reopened.datedProfiles(),o.datedProfiles());
  assert.equal(fs.readFileSync(path.join(f.dir,'ownership.journal'),'utf8').includes('example.invalid'),false);
});
test('deleting last user leaves previous-day collection intact and today empty',async t=>{
  const f=fixture(t);await f.ownership.assignName({name:'甲',userIds:[1]});f.setDay('2026-11-10');
  await f.mutate({action:'remove',name:'甲',userId:1});
  const usage=new DailyUsage({ownership:f.ownership,request:f.request,now:()=>Date.parse('2026-11-10T03:00:00Z')});
  assert.deepEqual((await usage.read('2026-11-09')).rows[0].users.map(u=>u.id),[1]);
  assert.deepEqual((await usage.read('2026-11-10')).rows[0].users,[]);
  assert.equal(f.reads(),1);
});
test('stale revision, duplicate moves, cross-owner and failed save cannot partially transfer',async t=>{
  const f=fixture(t);await f.ownership.assignName({name:'甲',userIds:[1,2]});await f.ownership.assignName({name:'乙',userIds:[2]});
  const revision=f.ownership.revision();await f.mutate({action:'remove',name:'甲',userId:1});
  await assert.rejects(f.ownership.changeClient({action:'remove',name:'甲',userId:2,revision}),{code:'CONFLICT'});
  await assert.rejects(f.mutate({action:'move',name:'甲',targetName:'乙',userId:2}),{code:'CONFLICT'});
  f.setOwner(2); await assert.rejects(f.mutate({action:'remove',name:'甲',userId:2}));f.setOwner(1);
  await f.ownership.assignName({name:'乙',userIds:[]});
  const before=f.ownership.datedProfiles();f.ownership.store.save=()=>{throw Error('fixture full disk');};
  await assert.rejects(f.mutate({action:'move',name:'甲',targetName:'乙',userId:2}),{code:'STORAGE'});
  assert.deepEqual(f.ownership.datedProfiles(),before);
});
test('legacy rows have unknown baseline dates, dates cannot go backwards, invalid membership fails closed',async t=>{
  const f=fixture(t);f.ownership.rows=[{...scope,openId:null,name:'旧档案',state:'profile',userIds:[1]}];
  await f.mutate({action:'remove',name:'旧档案',userId:1});
  assert.deepEqual(f.ownership.profilesAt('2026-11-08')[0].userIds,[1]);
  f.setDay('2026-11-08');await assert.rejects(f.mutate({action:'add',name:'旧档案',userId:2}),/系统日期/);
  assert.throws(()=>validateMembership({baselineIds:[1],changes:[{day:'2026-02-30',userIds:[]}]},[]));
});
test('Beijing cross-month deletion and same-day re-add use the final membership for that natural day',async t=>{
  const f=fixture(t);f.setDay('2026-11-30');await f.ownership.assignName({name:'甲',userIds:[1]});
  f.setDay('2026-12-01');await f.mutate({action:'remove',name:'甲',userId:1});
  assert.deepEqual(f.ownership.profilesAt('2026-11-30')[0].userIds,[1]);
  assert.deepEqual(f.ownership.profilesAt('2026-12-01')[0].userIds,[]);
  await f.mutate({action:'add',name:'甲',userId:1});
  assert.deepEqual(f.ownership.profilesAt('2026-12-01')[0].userIds,[1]);
  assert.equal(f.ownership.datedProfiles()[0].membership.changes.length,2);
  assert.deepEqual(f.ownership.profilesAt('2026-11-29')[0].userIds,[]);
});
test('unsampled customer remains in prior date roster after deletion, no zero cost or total is invented',async t=>{
  const f=fixture(t);await f.ownership.assignName({name:'甲',userIds:[1]});
  f.setDay('2026-11-10');await f.mutate({action:'remove',name:'甲',userId:1});
  const state={snapshots:{}};
  const week=historyWeek(state,{month:'2026-11',weekStart:'2026-11-09',name:'甲'},'2026-11-10',['甲'],[],f.ownership.datedProfiles());
  assert.equal(week.rows.length,1);assert.equal(week.rows[0].email,'u1@example.invalid');
  assert.equal(week.rows[0].membership[0],null);assert.equal(week.rows[0].membership[1],'removed');
  assert.deepEqual(week.rows[0].values,Array(7).fill(null));assert.deepEqual(week.totals,Array(7).fill(null));
  const exported=exportRows(state,{scope:'person',name:'甲',start:'2026-11-09',end:'2026-11-10'},'2026-11-10',['甲'],f.ownership.datedProfiles());
  assert.equal(exported.rows[0].id,1);assert.equal(exported.rows[0].cost,null);assert.equal(exported.rows[0].dailyTotal,null);
  assert.equal(exported.rows[1].id,null);
});
