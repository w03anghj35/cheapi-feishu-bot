'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPlatformError, readPlatformError, publicFailure } = require('./platform-error');
const { failureDiagnostic, failureHint } = require('./create-diagnostics');
const { UserRegistrationService } = require('./user-registration-service');
const { KeyService, ToolError } = require('./service');
const { makeFixture } = require('./test-fixture');
const { randomUUID } = require('node:crypto');
const secret = 'fictional-password-and-sk-private-must-not-escape';
const registration = () => ({ requestId:randomUUID(), email:'synthetic@example.invalid', password:'fictional-password',
  username:'测试用户', concurrency:1, balance:0 });
const actor = { name:'飞书用户#0123456789abcdef0123', source:'feishu-open-id', verified:true };
const context = { verifiedActor:actor, feishuGroupId:'oc_fixture_12345678', guard:()=>true };

test('explicit user duplicate categories become fixed reasons, not raw platform messages', () => {
  for (const [payload, expected] of [
    [{message:`邮箱已存在；${secret}`}, 'EMAIL_EXISTS'], [{msg:'email already exists'}, 'EMAIL_EXISTS'],
    [{error:{message:'用户名已被使用'}}, 'USERNAME_EXISTS'], [{data:{message:'User already exists'}}, 'USER_EXISTS']
  ]) assert.equal(classifyPlatformError('POST','/admin/users',payload), expected);
  assert.equal(classifyPlatformError('POST','/admin/users',{message:`${secret} unavailable`}),null);
  assert.equal(classifyPlatformError('GET','/admin/users',{message:'email already exists'}),null);
  assert.equal(classifyPlatformError('POST','/keys',{message:'email already exists'}),null);
  for(const reason of ['EMAIL_EXISTS','USERNAME_EXISTS','USER_EXISTS'])
    assert.equal(publicFailure('registration',{code:'HTTP',reason,definitive:true,attempted:true}).includes(secret),false);
});
test('token categories and unknown outcomes do not mislabel uncertain creation', () => {
  for (const [message,reason] of [['分组已停用','GROUP_UNAVAILABLE'],['quota exceeds limit','QUOTA_INVALID'],
    ['insufficient balance','INSUFFICIENT_BALANCE']])
    assert.equal(classifyPlatformError('POST','/keys',{message}),reason);
  const uncertain=publicFailure('registration',{code:'UNKNOWN',reason:'EMAIL_EXISTS',attempted:true,definitive:false});
  assert.match(uncertain,/可能已经创建/);assert.doesNotMatch(uncertain,/邮箱已经注册/);
  const rejected=publicFailure('token',{code:'HTTP',definitive:true,attempted:true,httpStatus:409});
  assert.match(rejected,/未成功/);assert.doesNotMatch(rejected,/可能已经/);
});
test('bounded failure body reads JSON, refuses oversized bodies and never emits raw text', async () => {
  const payload={code:400,msg:`邮箱已存在 ${secret}`};
  const response=new Response(JSON.stringify(payload),{status:400,headers:{'content-type':'application/json'}});
  assert.deepEqual(await readPlatformError(response),payload);
  const oversize=new Response('x'.repeat(9000),{status:400});assert.equal(await readPlatformError(oversize),null);
  const declared=new Response('{}',{status:400,headers:{'content-length':'9000'}});assert.equal(await readPlatformError(declared),null);
});
test('definitive duplicate registration is failed, records safe reason, and user sees readable message', async () => {
  let posts=0,rows=[];const store={load:()=>[],save:r=>{rows=structuredClone(r);}};
  const request=async(method,route)=>{
    if(method==='GET')return {id:1,role:'admin'};
    posts++;const error=new ToolError('HTTP',secret);Object.assign(error,{definitive:true,httpStatus:409,reason:'EMAIL_EXISTS'});throw error;
  };
  const service=new UserRegistrationService({request,store,getOwner:()=>1});
  const input=registration();let safe;
  await assert.rejects(service.create(input,context),error=>{safe=error;return error.code==='HTTP'&&error.reason==='EMAIL_EXISTS'&&error.definitive===true&&!error.message.includes(secret);});
  assert.equal(rows[0].state,'failed');assert.equal(rows[0].errorReason,'EMAIL_EXISTS');assert.equal(posts,1);
  assert.equal(JSON.stringify(rows).includes(secret),false);
  assert.match(publicFailure('registration',safe),/邮箱已经注册/);
  await service.create(registration(),{...context,guard:()=>false}).catch(()=>{});
  assert.equal(posts,1);
});
test('ambiguous registration timeout remains unknown and does not repeat the POST', async () => {
  let posts=0;const service=new UserRegistrationService({getOwner:()=>1,store:{load:()=>[],save(){}},request:async method=>{
    if(method==='GET')return {id:1,role:'admin'};
    posts++;throw new Error(`${secret} timeout`);
  }});
  let error;await assert.rejects(service.create(registration(),context),e=>{error=e;return e.code==='UNKNOWN'&&e.attempted===true;});
  assert.match(publicFailure('registration',error),/可能已经创建/);
  assert.equal(service.records[0].state,'unknown');assert.equal(service.records[0].errorReason,undefined);
  await assert.rejects(service.create(registration(),context),{code:'UNKNOWN'});assert.equal(posts,1);
});
test('token explicit rejection maps safely; unknown transport remains protected', async () => {
  const fixture=makeFixture(),service=new KeyService(fixture),failures=[];await service.refresh();
  await service.saveGroupNames({owner:1,items:[{id:7,name:'测试分组'}]});service.onCreateFailure=r=>failures.push(r);
  const request=service.request;
  service.request=async(method,route,...rest)=>{
    if(method==='POST'&&route==='/keys'){
      const e=new ToolError('HTTP',secret);Object.assign(e,{definitive:true,httpStatus:422,reason:'QUOTA_INVALID'});throw e;
    }
    return request(method,route,...rest);
  };
  await assert.rejects(service.create({requestId:randomUUID(),groupId:7,quota:5,operator:'fixture'}),{code:'HTTP'});
  assert.equal(service.records[0].state,'failed');assert.equal(failures[0].reason,'QUOTA_INVALID');
  assert.match(failureHint(failures[0]),/额度不符合/);assert.equal(JSON.stringify(failures).includes(secret),false);
  const sanitized=failureDiagnostic('bad',{code:'HTTP',reason:secret,message:secret},'submission');
  assert.equal(sanitized.reason,null);assert.equal(JSON.stringify(sanitized).includes(secret),false);
});
