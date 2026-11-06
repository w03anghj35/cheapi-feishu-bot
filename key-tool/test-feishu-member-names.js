'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {FeishuMemberNames,fingerprint}=require('./feishu-member-names');
const history=require('./operation-history');const {FeishuBotWorkflow,actorFromOpenId}=require('./feishu-bot-workflow');
const {KeyService}=require('./service');const {makeFixture}=require('./test-fixture');
const {UserRegistrationService}=require('./user-registration-service');
const GROUP='oc_group_12345678',USER='ou_member_12345678';
const item=(id=USER,name='组织9 · 测试成员')=>({member_id_type:'open_id',member_id:id,name});
const meta={displayName:'组织9 · 测试成员',nameSource:'feishu-chat-members',nameFetchedAt:'2026-10-31T00:00:00Z'};
test('official member pagination maps stable identity to name, caches and does not rewrite old records',async()=>{
  let calls=0,now=0;const client={listGroupMembers:async(_group,token)=>{calls++;return token?{items:[item()],has_more:false}:{items:[item('ou_other_12345','同名')],has_more:true,page_token:'page2'};}};
  const names=new FeishuMemberNames({getScope:()=>({client,groupId:GROUP,appId:'fixture'}),now:()=>now});
  await names.refresh();await names.refresh();assert.equal(calls,2);
  const old={operator:actorFromOpenId(USER),feishuGroupId:GROUP};const decorated=names.decorate(old);
  assert.equal(decorated.operator.displayName,meta.displayName);assert.equal(decorated.operator.nameSource,'feishu-current-member');
  assert.equal(old.operator.displayName,undefined);assert.equal(names.decorate({...old,feishuGroupId:'oc_other_12345678'}).operator.displayName,undefined);
  now=300001;assert.equal(names.lookup(fingerprint(USER),GROUP),null);await names.refresh();assert.equal(calls,4);
});
test('ownership menu projects current group name only for an exact full identity digest',async()=>{
  let scope={client:{listGroupMembers:async()=>({items:[item(USER,'用户930290'),item('ou_other_12345','用户930290')],has_more:false})},
    groupId:GROUP,appId:'fixture'};
  const names=new FeishuMemberNames({getScope:()=>scope});await names.refresh();
  const first=createHash('sha256').update(USER).digest('hex');
  const second=createHash('sha256').update('ou_other_12345').digest('hex');
  const rows=[{identity:first,name:'飞书用户#旧摘要',state:'pending'},
    {identity:second,name:'登记时姓名',state:'linked'},
    {identity:'a'.repeat(64),name:'飞书用户#未知',state:'pending'}];
  const projected=names.decorateOwnershipIdentities(rows,GROUP);
  assert.equal(projected[0].currentFeishuName,'用户930290');
  assert.equal(projected[1].currentFeishuName,'用户930290');
  assert.equal(projected[2].currentFeishuName,undefined);
  assert.equal(rows[0].currentFeishuName,undefined);
  assert.equal(names.decorateOwnershipIdentities(rows,'oc_other_12345678')[0].currentFeishuName,undefined);
  scope={...scope,groupId:'oc_other_12345678'};
  assert.equal(names.decorateOwnershipIdentities(rows,GROUP)[0].currentFeishuName,undefined);
});
test('same names keep distinct identities; rename never changes authorization identity',async()=>{
  const a=history.verifiedFeishuOperator({...actorFromOpenId(USER),...meta}),b=history.verifiedFeishuOperator({...actorFromOpenId('ou_other_12345'),...meta});
  assert.notEqual(a.name,b.name);assert.equal(a.displayName,b.displayName);
  const renamed=history.verifiedFeishuOperator({...a,displayName:'新名字'});assert.equal(renamed.name,a.name);
  for(const change of [{displayName:''},{displayName:'x\ny'},{nameSource:'self-reported'},{nameFetchedAt:'invalid'}])assert.throws(()=>history.verifiedFeishuOperator({...a,...change}));
});
test('missing permission throttles lookup and falls back without logging response or spoofed event names',async()=>{
  let calls=0;const client={listGroupMembers:async()=>{calls++;throw {code:'DENIED',secret:'fixture-only'};}};
  const names=new FeishuMemberNames({getScope:()=>({client,groupId:GROUP,appId:'fixture'})});
  assert.equal(await names.actor(USER,GROUP),null);await names.refresh();assert.equal(calls,1);assert.equal(names.state().reason,'permission');
  assert.equal(JSON.stringify(names.state()).includes('fixture-only'),false);
});
test('timeout is bounded, concurrent callers share request, switched app/group cannot get stale names',async()=>{
  let resolve,calls=0;const client={listGroupMembers:()=>{calls++;return new Promise(r=>{resolve=r;});}};
  let scope={client,groupId:GROUP,appId:'first'};const names=new FeishuMemberNames({getScope:()=>scope,waitMs:5});
  await Promise.all([names.refresh(),names.refresh()]);assert.equal(calls,1);
  scope={...scope,appId:'second'};names.state();resolve({items:[item()],has_more:false});await new Promise(r=>setImmediate(r));
  assert.equal(names.lookup(fingerprint(USER),GROUP),null);
});
test('repeated cursor, wrong id type, malformed payload and duplicate IDs rejected; short pages follow cursor',async()=>{
  for(const data of [{items:[{...item(),member_id_type:'user_id'}],has_more:false},{items:[item(),item()],has_more:false},{items:[],has_more:true,page_token:'same'},{}]){
    const client={listGroupMembers:async()=>data};const names=new FeishuMemberNames({getScope:()=>({client,groupId:GROUP,appId:'fixture'})});await names.refresh();
    assert.equal(names.state().reason,'failed');assert.equal(names.state().count,0);
  }
});
test('token name snapshots searchable, same identity renamed retry does not duplicate or bypass quota',async()=>{
  const fixture=makeFixture(),service=new KeyService(fixture);await service.refresh();await service.saveGroupNames({owner:1,items:[{id:7,name:'fixture group'}]});
  const actor={...actorFromOpenId(USER),...meta},requestId='11111111-1111-4111-8111-111111111111';
  const context={verifiedActor:actor,feishuGroupId:GROUP,quotaLimits:{maxQuota:5,maxUserDailyQuota:5,maxGroupDailyQuota:null},guard:()=>true};
  const input={requestId,groupId:7,quota:5,name:'fixture',operator:actor.name};
  await service.create(input,context);assert.equal(service.adminRecords({search:meta.displayName}).total,1);
  await service.create(input,{...context,quotaLimits:{...context.quotaLimits,maxUserDailyQuota:null},verifiedActor:{...actor,displayName:'新名字'}});
  assert.equal(fixture.calls.filter(c=>c.method==='POST').length,1);assert.equal(service.records[0].operator.displayName,meta.displayName);
  await assert.rejects(service.create({...input,requestId:'22222222-2222-4222-8222-222222222222'}, {...context,verifiedActor:{...actor,displayName:'新名字'}}),{code:'BUDGET'});
});
test('registration name snapshot survives reopen and old 3-field actor remains compatible',async()=>{
  let rows=[];const store={load:()=>structuredClone(rows),save:r=>{rows=structuredClone(r);}};
  const request=async(method,_route,body)=>method==='GET'?{id:1,role:'admin'}:{...body,id:8};
  const service=new UserRegistrationService({store,request,getOwner:()=>1});
  await service.create({requestId:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid',password:'fixture-only-password',username:'测试',concurrency:1,balance:0},
    {verifiedActor:{...actorFromOpenId(USER),...meta},feishuGroupId:GROUP,guard:()=>true});
  const reopened=new UserRegistrationService({store,request,getOwner:()=>1});assert.equal(reopened.adminRecords().items[0].operator,meta.displayName);
  rows[0].operator=actorFromOpenId(USER);assert.doesNotThrow(()=>new UserRegistrationService({store,request,getOwner:()=>1}));
});
test('workflow identity is enriched only by resolver; lookup failure retains verified identity',async()=>{
  const workflow=new FeishuBotWorkflow({resolveActorName:async()=>meta});
  const named=await workflow.namedActor(USER,GROUP);assert.equal(named.name,actorFromOpenId(USER).name);assert.equal(named.displayName,meta.displayName);
  workflow.resolveActorName=async()=>{throw new Error('fixture timeout');};assert.deepEqual(await workflow.namedActor(USER,GROUP),actorFromOpenId(USER));
});
