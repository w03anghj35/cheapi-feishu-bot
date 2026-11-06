'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {FeishuBotWorkflow}=require('./feishu-bot-workflow');
const {GroupSettingsService}=require('./group-settings-service');
const {formValues,accountValue}=require('./feishu-group-settings');
const OWNER='ou_owner_12345678', OTHER='ou_other_12345678', GROUP='oc_group_12345678', DM='oc_private_12345678';
const nodes=n=>[n,...['elements','actions','columns'].flatMap(k=>(n[k]||[]).flatMap(nodes))];
async function setup(count=2) {
  let n=0,now=Date.now(),phase='connected', failSend=false;
  let policy={enabled:true,ownerOpenId:OWNER,groupId:GROUP,platformOwnerId:1,maxQuota:20,maxUserDailyQuota:null,maxGroupDailyQuota:null};
  let user={id:8,email:'fixture@example.invalid',username:'虚构',role:'user',status:'active',allowed_groups:[],restrict_public_groups:false,group_rates:{}};
  const groups=Array.from({length:count},(_,i)=>({id:i+1,name:`原始${i}`,status:'active',subscription_type:'standard',is_exclusive:true,rate_multiplier:1}));
  const puts=[], cards=[],texts=[];
  const service={owner:1,blocked:()=>[],customerGroups:()=>[]};
  const settings=new GroupSettingsService({getOwner:()=>service.owner,catalog:{load:()=>[],save(){}},store:{load:()=>[],save(){}},
    request:async(method,route,body)=>{
      if(route==='/auth/me')return {id:service.owner,role:'admin'};
      if(route.startsWith('/admin/groups?'))return {items:groups,total:groups.length};
      if(method==='GET'&&route==='/admin/users/8')return structuredClone(user);
      if(method==='PUT'){puts.push(body);user={...user,...body};return user;}
      throw new Error('fixture route');
    }});
  await settings.refresh();await settings.saveNames({owner:1,items:groups.map(g=>({id:g.id,name:`别名${g.id}`}))});
  const workflow=new FeishuBotWorkflow({service,groupSettingsService:settings,getPolicy:()=>policy,now:()=>now,connection:{state:()=>({phase})},
    random:()=>`fixture_nonce_${String(++n).padStart(16,'0')}`,
    sendText:async p=>{texts.push(p);},sendCard:async p=>{if(failSend)throw new Error('fixture failure');const messageId=`om_${++n}`;cards.push({...p,messageId});return {messageId};}});
  const message=(text,actor=OWNER,group=false)=>({sender:{sender_type:'user',sender_id:{open_id:actor}},message:{message_id:`m_${++n}`,create_time:String(now),chat_id:group?GROUP:DM,chat_type:group?'group':'p2p',message_type:'text',content:JSON.stringify({text}),mentions:group?[{key:'@bot'}]:[]}});
  const dm=(text,actor)=>workflow.handle(message(text,actor));
  const start=actor=>workflow.handle(message('@bot',actor,true));
  const event=(action,extra={},actor=OWNER)=>{const card=cards.at(-1);const b=nodes(card.card).find(b=>b.value?.action===action);assert.ok(b);
    return {operator:{open_id:actor},context:{open_chat_id:DM,open_message_id:card.messageId},action:{value:{...b.value,...extra}}};};
  const click=async(action,extra)=>{const result=workflow.handleCard(event(action,extra));await workflow.tail;return result;};
  const submit=async values=>{const e=event('settings-submit');Object.assign(e.action,{tag:'button',name:'group_settings_submit',form_value:values});const r=workflow.handleCard(e);await workflow.tail;return r;};
  const accountEvent=values=>{const e=event('settings-user-submit');Object.assign(e.action,{tag:'button',name:'group_settings_account_submit',form_value:values});return e;};
  const account=async values=>{const r=workflow.handleCard(accountEvent(values));await workflow.tail;return r;};
  return {workflow,settings,service,puts,cards,texts,dm,start,event,click,submit,account,accountEvent,
    setPolicy:v=>{policy={...policy,...v};},advance:ms=>{now+=ms;},disconnect:()=>{phase='disconnected';},failSend:()=>{failSend=true;}};
}
test('admin menu includes settings; ordinary users cannot see, type or forge it',async()=>{
  const f=await setup();await f.start(OTHER);
  assert.deepEqual(nodes(f.cards.at(-1).card).filter(n=>n.value?.action==='feature').map(n=>n.value.featureId),['register','token','user-query']);
  assert.equal((await f.dm('分组设置',OTHER)).status,'admin-required');
  const forged=f.event('feature',{featureId:'group-settings'},OTHER);assert.equal(f.workflow.handleCard(forged).toast.type,'warning');
  await f.start(OWNER);assert.ok(JSON.stringify(f.cards.at(-1)).includes('分组设置'));assert.equal(f.puts.length,0);
});
test('admin target, paged forms, confirmation and duplicate click write once; no success before readback',async()=>{
  const f=await setup(6);await f.start();await f.click('feature',{featureId:'group-settings'});await f.account({account:'8'});
  assert.equal(f.puts.length,0);assert.equal(f.workflow.sessions.get(OWNER).state,'settings-form');
  const values=Object.fromEntries(Array.from({length:5},(_,i)=>[[`allow_${i+1}`,'yes'],[`rate_${i+1}`,'0.8']]).flat());
  await f.submit(values);assert.equal(f.workflow.sessions.get(OWNER).settingsPage,1);
  await f.submit({allow_6:'no',rate_6:''});assert.equal(f.workflow.sessions.get(OWNER).state,'settings-confirm');
  assert.equal(f.puts.length,0);assert.equal((await f.dm('确认')).status,'settings-form-required');
  const e=f.event('settings-confirm');f.workflow.handleCard(e);f.workflow.handleCard(e);await f.workflow.tail;
  assert.equal(f.puts.length,1);assert.ok(f.texts.some(t=>t.text.includes('设置成功。')&&t.receiveId===OWNER));
  assert.equal(f.workflow.sessions.has(OWNER),false);
});
test('wrong sender/chat/nonce, stale card, invalid rate and extra fields rejected',async()=>{
  const f=await setup();await f.start();await f.dm('3');await f.dm('8');const good=f.event('settings-submit');
  for(const e of [{...good,operator:{open_id:OTHER}},{...good,context:{...good.context,open_chat_id:GROUP}},
    {...good,action:{value:{...good.action.value,nonce:'wrong'}}}])assert.equal(f.workflow.handleCard(e).toast.type,'warning');
  assert.equal((await f.submit({allow_1:'yes',rate_1:'NaN',allow_2:'yes',rate_2:'1'})).toast.type,'error');
  assert.equal((await f.submit({allow_1:'yes',rate_1:'1',allow_2:'yes',rate_2:'1',balance:'100'})).toast.type,'error');
  await f.submit({allow_1:'yes',rate_1:'1',allow_2:'yes',rate_2:'1'});assert.equal(f.workflow.handleCard(good).toast.type,'warning');assert.equal(f.puts.length,0);
});
test('cancel, expiry, administrator rebound and disconnect prevent updates',async()=>{
  for(const mode of ['cancel','expiry','rebind','disconnect']){
    const f=await setup();await f.start();await f.dm('3');await f.dm('8');await f.submit({allow_1:'yes',rate_1:'1',allow_2:'no',rate_2:''});
    const e=f.event('settings-confirm');
    if(mode==='cancel')await f.dm('取消');else if(mode==='expiry')f.advance(11*60000);else if(mode==='rebind')f.setPolicy({ownerOpenId:OTHER});else f.disconnect();
    assert.equal(f.workflow.handleCard(e).toast.type,'warning');await f.workflow.tail;assert.equal(f.puts.length,0);
  }
});
test('card delivery failure cannot authorize a textual confirmation',async()=>{
  const f=await setup();await f.start();await f.dm('3');await f.dm('8');f.failSend();await f.submit({allow_1:'yes',rate_1:'1',allow_2:'no',rate_2:''});
  await f.dm('确认');assert.equal(f.puts.length,0);
});
test('form optional blank rates restore defaults but permission fields must be explicit',()=>{
  const session={settingsPage:0,groupPreview:{user:{restrict_public_groups:false},groups:[{id:7,exclusive:true}]}};
  assert.deepEqual(formValues(session,{allow_7:'no'}),[{groupId:7,allowed:false,rate:null}]);
  assert.throws(()=>formValues(session,{rate_7:'1'}));
});
test('account card provides a required input and form submit; no separate chat message needed',async()=>{
  const f=await setup();await f.start();await f.dm('3');
  const all=nodes(f.cards.at(-1).card),input=all.find(n=>n.tag==='input'&&n.name==='account');
  assert.equal(input.required,true);assert.equal(input.label.content,'用户账号');
  assert.equal(all.find(n=>n.value?.action==='settings-user-submit').action_type,'form_submit');
  const old=f.accountEvent({account:'8'});
  assert.equal((await f.account({account:' 8 '})).toast.type,'info');
  assert.equal(f.workflow.sessions.get(OWNER).groupPreview.user.id,8);
  assert.ok(nodes(f.cards.at(-1).card).some(n=>n.tag==='input'&&n.name==='rate_1'));
  assert.equal(f.workflow.handleCard(old).toast.type,'warning');assert.equal(f.puts.length,0);
});
test('account form rejects empty, extra, malformed, wrong sender and forged form metadata',async()=>{
  const f=await setup();await f.start();await f.dm('3');
  for(const values of [{account:''},{account:'nickname'},{account:'0'},{account:'8\n'},{account:'8',role:'admin'},{}])
    assert.equal((await f.account(values)).toast.type,'error');
  const event=f.accountEvent({account:'8'});event.action.name='wrong';assert.equal(f.workflow.handleCard(event).toast.type,'error');
  const spoof=f.accountEvent({account:'8'});spoof.operator.open_id=OTHER;assert.equal(f.workflow.handleCard(spoof).toast.type,'warning');
  assert.equal(f.workflow.sessions.get(OWNER).state,'settings-user');assert.equal(f.puts.length,0);
  assert.equal(accountValue({account:'fixture@example.invalid'}),'fixture@example.invalid');
});
test('redisplaying account form never attempts to look up the command as a user',async()=>{
  const f=await setup();await f.start();await f.dm('3');const count=f.cards.length;
  await f.dm('重新显示表单');assert.equal(f.cards.length,count+1);assert.equal(f.workflow.sessions.get(OWNER).state,'settings-user');
  assert.equal(f.puts.length,0);
});
