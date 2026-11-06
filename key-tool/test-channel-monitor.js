'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const {CHANNELS,INTERVAL_MS,safeName,parseAmount,chooseMetric,makeNameStore,observationScript}=require('./channel-monitor');
const {ChannelMonitorController,RECOVERY_DELAYS_MS}=require('./channel-monitor-controller');const {allowed,createChannelHost,aeroLoginScript,channelLoginScript,
  aeroDashboardNavigationScript,aeroPublicLoginRouteScript}=require('./channel-monitor-host');
function fakeDOM(channel,{label='总消费',value='$123.45',login=false,home=false}={}){
  const leaf=(text)=>({children:[],textContent:text,getClientRects:()=>[{}],querySelectorAll:()=>[]});
  const labelNode=leaf(label),amountNode=leaf(value),container={children:[labelNode,amountNode],querySelectorAll:()=>[labelNode,amountNode],parentElement:null};
  labelNode.parentElement=container;labelNode.nextElementSibling=amountNode;amountNode.parentElement=container;
  const balance={children:[],textContent:value,getAttribute:key=>key==='title'?value:null,getClientRects:()=>[{}]};
  const document={querySelector:selector=>login&&selector==='input[type="password"]'?{}:
    home&&selector==='#page-home'?{getClientRects:()=>[{}]}:null,
    querySelectorAll:selector=>selector==='input[type="password"]'?(login?[{getClientRects:()=>[{}]}]:[]):
      selector==='body *'?[labelNode,amountNode]:selector==='[data-testid="points-balance"]'&&channel.selector?[balance]:[]};
  const location={origin:channel.origin,pathname:channel.path};
  return vm.runInNewContext(observationScript(channel),{document,location});
}
test('exact five fixed HTTPS destinations and labels; no arbitrary origins or URLs',()=>{
  assert.deepEqual(CHANNELS.map(c=>c.origin+c.path),['https://23.239.111.82/dashboard','https://www.annaapi.com/dashboard','https://ccrouter.ai/dashboard','https://vip.aerorelay.one/dashboard','https://173.231.49.42/dashboard/overview']);
  assert.deepEqual(CHANNELS.map(c=>c.metric),['积分金额','积分金额','剩余余额','剩余余额','当前剩余余额']);
  for(const c of CHANNELS){assert.equal(allowed(c,c.origin+c.path),true);assert.equal(allowed(c,'http://'+new URL(c.origin).host+c.path),false);assert.equal(allowed(c,c.origin+'.evil.test'+c.path),false);}
});
test('names are local editable data, validated and durable without credentials',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'channel-names-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=makeNameStore(dir);assert.deepEqual(store.load(),{});
  store.save({'points-ip':'积分 A','points-anna':'积分 A'});
  assert.equal(makeNameStore(dir).load()['points-ip'],'积分 A');
  for(const value of ['', 'x'.repeat(41),'hello\nworld'])assert.throws(()=>safeName(value));
  const file=path.join(dir,'channel-monitor-names.journal');assert.equal(fs.readFileSync(file,'utf8').includes('password'),false);
  fs.appendFileSync(file,'corrupt');assert.throws(()=>makeNameStore(dir).load());
});
test('amount extraction uses only exact points selector or a single nearby spend label',()=>{
  for(const c of CHANNELS){const result=chooseMetric(c,fakeDOM(c,{label:c.id==='spent-ccrouter'?'当前余额 (USD)':c.id==='spent-aerorelay'?'余额':c.id==='balance-juxiang'?'当前余额':'总消费'}));assert.equal(result.status,'ok');assert.equal(result.value,123.45);}
  assert.equal(chooseMetric(CHANNELS[2],{...fakeDOM(CHANNELS[2]),labeledCandidates:['$3','$4']}).status,'ambiguous');
  assert.equal(chooseMetric(CHANNELS[0],{...fakeDOM(CHANNELS[0]),origin:'https://fake.example'}).status,'unavailable');
  assert.equal(chooseMetric(CHANNELS[0],{...fakeDOM(CHANNELS[0]),path:'/auth',login:true}).status,'login-required');
  assert.equal(chooseMetric(CHANNELS[3],fakeDOM(CHANNELS[3],{label:'套餐价格'})).status,'metric-not-found');
  assert.equal(chooseMetric(CHANNELS[3],fakeDOM(CHANNELS[3],{label:'今日消费'})).status,'metric-not-found');
  assert.equal(fakeDOM(CHANNELS[3],{home:true}).login,true);
  for(const value of ['-1','$1e3','1/1000','', 'Infinity'])assert.equal(parseAmount(value),null);
});
test('display amount is not read from unrelated page text or secret fields',()=>{
  const c=CHANNELS[0];const result=fakeDOM(c,{value:'$1,234.50',login:true});
  assert.equal(result.login,true);assert.deepEqual(Array.from(result.balanceCandidates),['$1,234.50']);
  assert.equal(JSON.stringify(result).includes('password'),false);
});
test('points dashboards expose full 8-decimal title while visible text rounds to 2 decimals',()=>{
  for(const c of CHANNELS.slice(0,2)){
    const observation=fakeDOM(c,{value:'16,680.13343482'});
    assert.deepEqual(Array.from(observation.balanceCandidates),['16,680.13343482']);
    assert.equal(chooseMetric(c,observation).value,16680.13343482);
  }
  assert.equal(parseAmount('16,680.123456789012').display,'16,680.123456789012');
  assert.equal(parseAmount('16,680.1234567890123'),null);
});
test('CC Router selects remaining balance next to 当前余额 on dashboard, never usage total',()=>{
  const c=CHANNELS[2], observation=fakeDOM(c,{label:'当前余额 (USD)',value:'$17.1234'});
  assert.deepEqual(Array.from(observation.labeledCandidates),['$17.1234']);
  assert.equal(chooseMetric(c,observation).value,17.1234);
  assert.equal(chooseMetric(c,fakeDOM(c,{label:'总消费',value:'$99.99'})).status,'metric-not-found');
  assert.equal(chooseMetric(c,{...observation,path:'/usage'}).status,'unavailable');
  assert.equal(chooseMetric(c,{...observation,path:'/dashboard-fake'}).status,'unavailable');
});
test('AeroRelay selects dashboard balance and never today spend or old usage path',()=>{
  const c=CHANNELS[3],observation=fakeDOM(c,{label:'余额',value:'$14,725.72'});
  assert.deepEqual(Array.from(observation.labeledCandidates),['$14,725.72']);
  assert.equal(chooseMetric(c,observation).value,14725.72);
  assert.equal(chooseMetric(c,fakeDOM(c,{label:'今日消费',value:'$5682.6771'})).status,'metric-not-found');
  assert.equal(chooseMetric(c,{...observation,path:'/usage'}).status,'unavailable');
});
test('Juxiang accepts only the current remaining balance near an explicit label',()=>{
  const c=CHANNELS[4];
  assert.deepEqual(Array.from(fakeDOM(c,{label:'当前余额',value:'$82.50'}).labeledCandidates),['$82.50']);
  assert.equal(chooseMetric(c,fakeDOM(c,{label:'可用余额',value:'¥13.25'})).value,13.25);
  assert.equal(chooseMetric(c,fakeDOM(c,{label:'剩余额度',value:'$5.75'})).value,5.75);
  for(const label of ['总消费','累计消费','充值金额','今日消费','余额'])
    assert.equal(chooseMetric(c,fakeDOM(c,{label,value:'$999'})).status,'metric-not-found');
  assert.equal(chooseMetric(c,{...fakeDOM(c,{label:'当前余额'}),path:'/sign-in',login:true}).status,'login-required');
});
test('Juxiang overview reads the balance after status, never nearby consumption or missing balance', () => {
  const channel = CHANNELS[4];
  const leaf = value => ({ children: [], textContent: value, getClientRects: () => [{}] });
  function observe(values) {
    const leaves = values.map(leaf);
    const card = { children: leaves, parentElement: null, querySelectorAll: () => leaves };
    for (const node of leaves) node.parentElement = card;
    const document = { querySelectorAll: selector => selector === 'body *' ? leaves : [] };
    return vm.runInNewContext(observationScript(channel), { document,
      location: { origin: channel.origin, pathname: channel.path } });
  }
  const liveShape = observe(['近 24 小时消耗', '$1,858.76', '历史使用情况', '$1,950.19',
    '剩余额度', '正常', '$6,429.81', '近 24 小时消耗', '$1,858.76', '可用时长', '~3 天']);
  assert.deepEqual(Array.from(liveShape.labeledCandidates), ['$6,429.81']);
  assert.equal(chooseMetric(channel, liveShape).value, 6429.81);
  const missing = observe(['剩余额度', '正常', '近 24 小时消耗', '$1,858.76']);
  assert.equal(chooseMetric(channel, missing).status, 'metric-not-found');
  const wrongPath = { ...liveShape, path: '/dashboard' };
  assert.equal(chooseMetric(channel, wrongPath).status, 'unavailable');
});
function fixture(){let now=0,loads=0,opens=0,observations=0,mode='ok';const tasks=new Map();let id=0;
  const timers={setTimeout(fn,ms){tasks.set(++id,{fn,at:now+ms});return id;},clearTimeout(key){tasks.delete(key);}};
  const host={load:async()=>{opens++;},observe:async(channel)=>{observations++;if(mode==='error')throw new Error('secret never shown');
    if(mode==='login')return {status:'login-required'};if(mode==='browsing')return {status:'user-browsing'};
    return {origin:channel.origin,path:channel.path,login:false,balanceCandidates:['1.25'],labeledCandidates:['$2.50']};},closeAll(){}};
  const store={load:()=>({}),save:rows=>structuredClone(rows)};
  const monitor=new ChannelMonitorController({store,host,now:()=>now,timers});
  const advance=async ms=>{const end=now+ms;for(let i=0;i<500;i++){const next=[...tasks.entries()].filter(([,task])=>task.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;tasks.delete(next[0]);await next[1].fn();await new Promise(r=>setImmediate(r));}now=end;};
  return {monitor,host,advance,counts:()=>({observations,opens}),setMode:v=>{mode=v;},now:()=>now};
}
test('startup checks each destination once, then never refreshes before half an hour',async()=>{
  const f=fixture();f.monitor.start();await f.advance(45000);
  assert.equal(f.counts().observations,5);assert.deepEqual(f.monitor.state().map(r=>r.status),['ok','ok','ok','ok','ok']);
  await f.advance(INTERVAL_MS-50000);assert.equal(f.counts().observations,5);
  f.monitor.stop();
});
test('login required, stale values and browsing window remain explicit, no password retries',async()=>{
  const f=fixture();f.monitor.start();await f.advance(35000);f.setMode('error');
  await f.monitor.check('points-ip',true);let row=f.monitor.state()[0];assert.equal(row.status,'failed');assert.equal(row.display,'1.25');
  f.setMode('login');await f.monitor.check('points-ip',true);row=f.monitor.state()[0];assert.equal(row.status,'login-required');assert.equal(row.display,'1.25');
  f.setMode('browsing');await f.monitor.check('points-ip',true);assert.equal(f.monitor.state()[0].status,'user-browsing');
  f.monitor.stop();
});
test('missing amount and transient failures recover with bounded backoff, then reset to half-hour', async () => {
  let now = 0, mode = 'missing', reads = 0;
  const tasks = new Map(); let id = 0;
  const timers = { setTimeout(fn, ms) { tasks.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout(key) { tasks.delete(key); } };
  const host = { async observe(channel) {
    reads++;
    if (mode === 'failed') throw Error('synthetic network failure');
    if (mode === 'login') return { status: 'login-required' };
    return { origin: channel.origin, path: channel.path, login: false,
      balanceCandidates: mode === 'missing' ? [] : ['123.25'],
      labeledCandidates: mode === 'missing' ? [] : ['$123.25'] };
  } };
  const monitor = new ChannelMonitorController({ store: { load: () => ({}) }, host, now: () => now, timers });
  await monitor.check('points-ip', true);
  let row = monitor.state()[0];
  assert.equal(row.status, 'metric-not-found'); assert.equal(row.nextAt, RECOVERY_DELAYS_MS[0]);
  now = row.nextAt; await monitor.check('points-ip');
  row = monitor.state()[0]; assert.equal(row.recoveryAttempts, 2);
  assert.equal(row.nextAt - now, RECOVERY_DELAYS_MS[1]);
  mode = 'failed'; now = row.nextAt; await monitor.check('points-ip');
  row = monitor.state()[0]; assert.equal(row.status, 'failed');
  assert.equal(row.nextAt - now, RECOVERY_DELAYS_MS[2]);
  mode = 'login'; now = row.nextAt; await monitor.check('points-ip');
  row = monitor.state()[0]; assert.equal(row.status, 'login-required');
  assert.equal(row.nextAt - now, RECOVERY_DELAYS_MS[3]);
  mode = 'ok'; now = row.nextAt; await monitor.check('points-ip');
  row = monitor.state()[0]; assert.equal(row.status, 'ok');
  assert.equal(row.recoveryAttempts, 0); assert.equal(row.nextAt - now, INTERVAL_MS);
  assert.equal(reads, 5);
});
test('background timer automatically revisits a failed channel before the normal half-hour interval', async () => {
  const f = fixture(); f.setMode('login'); f.monitor.start();
  await f.advance(45_000);
  assert.equal(f.counts().observations, 5);
  assert.ok(f.monitor.state().every(row => row.status === 'login-required'));
  f.setMode('ok'); await f.advance(2 * 60_000 + 15_000);
  assert.ok(f.monitor.state().every(row => row.status === 'ok'));
  assert.equal(f.counts().observations, 10);
  f.monitor.stop();
});
test('custom names do not trigger network, explicit open and refresh are bounded',async()=>{
  const f=fixture();f.monitor.rename('points-ip','自定义积分');assert.equal(f.counts().observations,0);
  assert.equal(f.monitor.state()[0].name,'自定义积分');assert.throws(()=>f.monitor.rename('invalid','x'));
  await f.monitor.open('points-ip');assert.equal(f.counts().opens,1);
  await f.monitor.check('points-ip',true);assert.equal(f.counts().observations,1);
  f.monitor.stop();
});
test('browser host uses five separate persistent sessions, no Node access and blocks cross-origin navigation',async()=>{
  const partitions=[],windows=[];let closing=false;
  class Window {
    constructor(options){this.options=options;this.events=new Map();this.visible=false;this.destroyed=false;this.current='';
      this.webContents={events:new Map(),setWindowOpenHandler:handler=>{this.popupHandler=handler;},
        on:(name,handler)=>this.webContents.events.set(name,handler),getURL:()=>this.current,
        executeJavaScript:async()=>({origin:CHANNELS[0].origin,path:'/dashboard',balanceCandidates:['1']})};windows.push(this);}
    setMenuBarVisibility(){}on(name,handler){this.events.set(name,handler);}isDestroyed(){return this.destroyed;}
    isVisible(){return this.visible;}show(){this.visible=true;}focus(){}hide(){this.visible=false;}
    destroy(){this.destroyed=true;this.events.get('closed')?.();}
    async loadURL(url){this.current=url;}
  }
  const host=createChannelHost({isClosing:()=>closing,BrowserWindowImpl:Window,
    sessionImpl:{fromPartition(partition){partitions.push(partition);return {setPermissionRequestHandler(handler){assert.equal(handler.length,3);}};}}});
  for(const channel of CHANNELS)await host.load(channel,{visible:true});
  assert.equal(new Set(partitions).size,5);assert.ok(partitions.every(value=>value.startsWith('persist:channel-monitor-')));
  assert.equal(windows.every(w=>w.options.webPreferences.nodeIntegration===false&&w.options.webPreferences.contextIsolation===true&&w.options.webPreferences.sandbox===true),true);
  for(let i=0;i<windows.length;i++){
    const w=windows[i],channel=CHANNELS[i];assert.deepEqual(w.popupHandler(),{action:'deny'});
    let stopped=false;w.webContents.events.get('will-navigate')({preventDefault(){stopped=true;}},channel.origin+'/dashboard');assert.equal(stopped,false);
    w.webContents.events.get('will-navigate')({preventDefault(){stopped=true;}},'https://other.example/login');assert.equal(stopped,true);
    let prevented=false;w.events.get('close')({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(w.isVisible(),false);
  }
  const cc=windows[2];cc.current='https://ccrouter.ai/usage';
  await host.observe(CHANNELS[2],{userRequested:true});
  assert.equal(cc.current,'https://ccrouter.ai/dashboard');
  closing=true;host.closeAll();assert.equal(windows.every(w=>w.destroyed),true);
});
test('AeroRelay transient home screen does not declare login before a settled dashboard',async()=>{
  let reads=0;const windows=[];
  class Window{
    constructor(){this.current='';this.visible=false;this.destroyed=false;this.webContents={setWindowOpenHandler(){},on(){},getURL:()=>this.current,
      executeJavaScript:async()=>++reads<=2?{origin:CHANNELS[3].origin,path:'/dashboard',login:true,labeledCandidates:[]}:
        {origin:CHANNELS[3].origin,path:'/dashboard',login:false,labeledCandidates:['$7.25']}};windows.push(this);}
    setMenuBarVisibility(){}on(){}isDestroyed(){return this.destroyed;}isVisible(){return this.visible;}
    async loadURL(url){this.current=url;}destroy(){this.destroyed=true;}
  }
  const host=createChannelHost({BrowserWindowImpl:Window,sessionImpl:{fromPartition(){return {setPermissionRequestHandler(){}};}}});
  const result=await host.observe(CHANNELS[3],{userRequested:true});
  assert.equal(reads,4);assert.equal(result.login,false);assert.deepEqual(result.labeledCandidates,['$7.25']);host.closeAll();
});
test('AeroRelay auto login fills only the verified same-origin form and returns no secret',()=>{
  const channel=CHANNELS[3], credentials={email:'fictional@example.invalid',password:'fixture-only-secret-not-real'};
  const form={getAttribute:()=> 'handleLogin(event)',dataset:{},querySelectorAll:()=>[button]}, email={type:'email',form,value:'',getClientRects:()=>[{}],dispatchEvent(){}},
    password={type:'password',form,value:'',getClientRects:()=>[{}],dispatchEvent(){}},
    button={type:'submit',form,disabled:false,getAttribute:()=>null,getClientRects:()=>[{}],click(){this.clicked=true;}};
  const nodes={'#login-email':email,'#login-password':password,'#login-submit-btn':button};
  const document={querySelector:key=>nodes[key],querySelectorAll:()=>[]};
  const script=aeroLoginScript(channel,credentials), Event=class{};
  const HTMLInputElement=class{set value(v){this._value=v;}get value(){return this._value;}};
  const ctx=origin=>({location:{origin,protocol:'https:',pathname:'/dashboard'},document,window:{handleLogin(){}},Event,HTMLInputElement});
  assert.equal(vm.runInNewContext(script,ctx(channel.origin)),true);
  assert.equal(button.clicked,true);assert.equal(password.value,'');
  button.clicked=false;
  assert.equal(vm.runInNewContext(script,ctx('https://other.example')),false);
  assert.equal(button.clicked,false);
  assert.equal(vm.runInNewContext(script,{...ctx(channel.origin),location:{origin:channel.origin,protocol:'https:',pathname:'/other'}}),false);
  document.querySelectorAll=()=>[{type:'checkbox',getClientRects:()=>[{}]}];
  assert.equal(vm.runInNewContext(script,ctx(channel.origin)),false);
  assert.equal(button.clicked,false);
});
test('all five channel login scripts require their own path and form, and reject visible verification', () => {
  const credentials = { email: 'fictional@example.invalid', password: 'fixture-only-secret-not-real' };
  for (const channel of CHANNELS) {
    const points = channel.id.startsWith('points-'), aero = channel.id === 'spent-aerorelay', juxiang = channel.id === 'balance-juxiang';
    class HTMLInputElement { set value(v) { this._value = v; } get value() { return this._value || ''; } }
    let submitted = 0, verification = false;
    const form = { dataset: { step: points ? 'credentials' : undefined },
      getAttribute: () => aero ? 'handleLogin(event)' : null, querySelectorAll: () => [button] };
    const email = Object.assign(new HTMLInputElement(), { type: juxiang ? 'text' : 'email', form, getClientRects: () => [{}], dispatchEvent() {} });
    const password = Object.assign(new HTMLInputElement(), { type: 'password', form, getClientRects: () => [{}], dispatchEvent() {} });
    const button = { form, disabled: false, getAttribute: () => null, getClientRects: () => [{}],
      click() { submitted++; assert.equal(email.value, credentials.email); assert.equal(password.value, credentials.password); } };
    const selectors = points ? { '#auth-email': email, '#auth-password': password } : aero ?
      { '#login-email': email, '#login-password': password } : juxiang ?
      { 'input[name="username"]': email, 'input[name="password"]': password } : { '#email': email, '#password': password };
    const document = { querySelector: selector => selectors[selector], querySelectorAll: () => verification ?
      [{ type: 'checkbox', getClientRects: () => [{}] }] : [] };
    const path = points ? '/auth' : aero ? '/dashboard' : juxiang ? '/sign-in' : '/login';
    const context = pathname => ({ location: { origin: channel.origin, protocol: 'https:', pathname },
      document, window: { handleLogin() {} }, Event: class {}, HTMLInputElement });
    assert.equal(vm.runInNewContext(channelLoginScript(channel, null), context(path)), true);
    assert.equal(vm.runInNewContext(channelLoginScript(channel, credentials), context(path)), true);
    assert.equal(submitted, 1);
    assert.equal(vm.runInNewContext(channelLoginScript(channel, credentials), context('/other')), false);
    verification = true;
    assert.equal(vm.runInNewContext(channelLoginScript(channel, credentials), context(path)), false);
    assert.equal(submitted, 1);
  }
});
test('AeroRelay hidden session attempts once, pauses on failure, and never submits other channels',async()=>{
  const channel=CHANNELS[3], credentials={email:'fictional@example.invalid',password:'fixture-only-secret-not-real'};
  let submissions=0, pauses=0, success=false, enabled=true;
  class Window {
    constructor(){this.current='';this.visible=false;this.destroyed=false;this.reads=0;
      this.webContents={setWindowOpenHandler(){},on(){},getURL:()=>this.current,executeJavaScript:async script=>{
        if(script.includes('loginVisible:'))return {origin:channel.origin,path:success?'/admin/':'/dashboard',appReady:success,loginVisible:!success};
        if(script.includes('if (!false) return true'))return true;
        if(script.includes('if (!true) return true')){submissions++;return true;}
        this.reads++;return this.reads<=3||!success?{origin:channel.origin,path:'/dashboard',login:true,labeledCandidates:[]}:
          {origin:channel.origin,path:'/dashboard',login:false,labeledCandidates:['$7.25']};
      }};}
    setMenuBarVisibility(){}on(){}isDestroyed(){return this.destroyed;}isVisible(){return this.visible;}
    async loadURL(url){this.current=url;}destroy(){this.destroyed=true;}
  }
  const host=createChannelHost({BrowserWindowImpl:Window,sessionImpl:{fromPartition(){return {setPermissionRequestHandler(){}};}},
    autoLogin:{available:()=>enabled,claim:()=>{if(!enabled)return null;enabled=false;pauses++;return credentials;},resume(){enabled=true;}},wait:async()=>{}});
  assert.equal((await host.observe(channel)).status,'login-required');
  assert.equal(submissions,1);assert.equal(pauses,1);
  assert.equal((await host.observe(channel)).status,'login-required');assert.equal(submissions,1);
  host.cancelAutoLogin(); success=true;pauses=0;enabled=true;host.windows.get(channel.id).reads=0;
  const result=await host.observe(channel);assert.equal(result.login,false);assert.equal(submissions,1);assert.equal(pauses,0);assert.equal(enabled,true);
  host.closeAll();
});
test('unverified AeroRelay form never submits credentials or pauses a still usable configuration',async()=>{
  const channel=CHANNELS[3];let attempts=0,claims=0,resumes=0;
  class Window {
    constructor(){this.current='';this.webContents={setWindowOpenHandler(){},on(){},getURL:()=>this.current,
      executeJavaScript:async script=>{if(script.includes('if (!false) return true')){attempts++;return false;}
        return {origin:channel.origin,path:channel.path,login:true,labeledCandidates:[]};}};}
    setMenuBarVisibility(){}on(){}isDestroyed(){return false;}isVisible(){return false;}
    async loadURL(url){this.current=url;}destroy(){}
  }
  const host=createChannelHost({BrowserWindowImpl:Window,sessionImpl:{fromPartition(){return {setPermissionRequestHandler(){}};}},
    autoLogin:{available:()=>true,claim:()=>{claims++;return {email:'fictional@example.invalid',password:'fixture-only-secret-not-real'};},resume(){resumes++;}},wait:async()=>{}});
  assert.equal((await host.observe(channel)).status,'login-form-unavailable');
  assert.equal(attempts,1);assert.equal(claims,0);assert.equal(resumes,0);
  assert.equal((await host.observe(channel)).status,'login-form-unavailable');assert.equal(attempts,2);assert.equal(claims,0);
  host.closeAll();
});
test('a transient missing login form is checked again on recovery without consuming credentials', async () => {
  const channel = CHANNELS[0]; let probes = 0, claims = 0, ready = false;
  class Window {
    constructor() { this.current = ''; this.webContents = { setWindowOpenHandler() {}, on() {},
      getURL: () => this.current, executeJavaScript: async script => {
        if (script.includes('if (!false) return true')) { probes++; return ready; }
        if (script.includes('if (!true) return true')) throw Error('credentials must not be submitted');
        return { origin: channel.origin, path: '/auth', login: true, balanceCandidates: [] };
      } }; }
    setMenuBarVisibility() {} on() {} isDestroyed() { return false; } isVisible() { return false; }
    async loadURL(url) { this.current = url; } destroy() {}
  }
  const host = createChannelHost({ BrowserWindowImpl: Window,
    sessionImpl: { fromPartition() { return { setPermissionRequestHandler() {} }; } },
    autoLogin: { available: () => true, claim: () => { claims++; return null; } }, wait: async () => {} });
  assert.equal((await host.observe(channel)).status, 'login-form-unavailable');
  ready = true;
  assert.equal((await host.observe(channel)).status, 'login-required');
  assert.equal(probes, 2); assert.equal(claims, 1);
  host.closeAll();
});
test('AeroRelay manual login recovers from an earlier transient form error without reloading the authenticated page',async()=>{
  const channel=CHANNELS[3];let mode='public-home', loads=0, claims=0;
  class Window {
    constructor(){this.current='';this.webContents={setWindowOpenHandler(){},on(){},getURL:()=>this.current,
      executeJavaScript:async script=>{
        if(script.includes('if (!false) return true'))return false;
        if(mode==='public-home')return {origin:channel.origin,path:channel.path,login:true,labeledCandidates:[]};
        return {origin:channel.origin,path:channel.path,login:false,labeledCandidates:['$7.25']};
      }};}
    setMenuBarVisibility(){}on(){}isDestroyed(){return false;}isVisible(){return false;}
    async loadURL(url){loads++;this.current=url;if(mode==='dashboard')mode='public-home';}destroy(){}
  }
  const host=createChannelHost({BrowserWindowImpl:Window,sessionImpl:{fromPartition(){return {setPermissionRequestHandler(){}};}},
    autoLogin:{available:()=>true,claim:()=>{claims++;return {email:'fictional@example.invalid',password:'fixture-only-secret-not-real'};},resume(){}},wait:async()=>{}});
  assert.equal((await host.observe(channel)).status,'login-form-unavailable');
  assert.equal(loads,1);assert.equal(claims,0);
  mode='dashboard';
  const result=await host.observe(channel,{userRequested:true});
  assert.equal(loads,1);assert.deepEqual(result.labeledCandidates,['$7.25']);
  host.closeAll();
});
test('AeroRelay slow public-home transition never consumes saved credentials if dashboard settles',async()=>{
  const channel=CHANNELS[3];let reads=0,claims=0;
  class Window {
    constructor(){this.current='';this.webContents={setWindowOpenHandler(){},on(){},getURL:()=>this.current,
      executeJavaScript:async()=>++reads<=7?{origin:channel.origin,path:channel.path,login:true,labeledCandidates:[]}:
        {origin:channel.origin,path:channel.path,login:false,labeledCandidates:['$7.25']}};}
    setMenuBarVisibility(){}on(){}isDestroyed(){return false;}isVisible(){return false;}
    async loadURL(url){this.current=url;}destroy(){}
  }
  const host=createChannelHost({BrowserWindowImpl:Window,sessionImpl:{fromPartition(){return {setPermissionRequestHandler(){}};}},
    autoLogin:{available:()=>true,claim(){claims++;return null;}},wait:async()=>{}});
  const result=await host.observe(channel);
  assert.deepEqual(result.labeledCandidates,['$7.25']);assert.equal(reads,9);assert.equal(claims,0);
  host.closeAll();
});
test('AeroRelay authenticated usage page uses same-app dashboard navigation, not direct document reload', async () => {
  const channel = CHANNELS[3]; let loads = 0, clicks = 0, claims = 0;
  class Window {
    constructor() { this.current = channel.origin + '/usage';
      this.webContents = { setWindowOpenHandler() {}, on() {}, getURL: () => this.current,
        executeJavaScript: async script => {
          if (script.includes('AERO_DASHBOARD_NAV')) { clicks++; this.current = channel.origin + '/dashboard'; return true; }
          return { origin: channel.origin, path: new URL(this.current).pathname,
            login: false, labeledCandidates: this.current.endsWith('/dashboard') ? ['$7.25'] : [] };
        } }; }
    setMenuBarVisibility() {} on() {} isDestroyed() { return false; } isVisible() { return false; }
    async loadURL(url) { loads++; this.current = url; } destroy() {}
  }
  const host = createChannelHost({ BrowserWindowImpl: Window,
    sessionImpl: { fromPartition() { return { setPermissionRequestHandler() {} }; } },
    autoLogin: { available: () => true, claim: () => { claims++; return null; } }, wait: async () => {} });
  const result = await host.observe(channel, { userRequested: true });
  assert.deepEqual(result.labeledCandidates, ['$7.25']);
  assert.equal(clicks, 1); assert.equal(loads, 0); assert.equal(claims, 0);
  host.closeAll();
});
test('AeroRelay public home activates its normal login view before claiming credentials', async () => {
  const channel = CHANNELS[3]; let routeOpens = 0, claims = 0, submits = 0, loginVisible = false;
  class Window {
    constructor() { this.current = channel.origin + '/dashboard';
      this.webContents = { setWindowOpenHandler() {}, on() {}, getURL: () => this.current,
        executeJavaScript: async script => {
          if (script.includes('AERO_PUBLIC_LOGIN_ROUTE')) { routeOpens++; loginVisible = true; return true; }
          if (script.includes('if (!false) return true')) return loginVisible;
          if (script.includes('if (!true) return true')) { submits++; return true; }
          if (script.includes('loginVisible:')) return { origin: channel.origin, path: '/dashboard', loginVisible: false };
          return { origin: channel.origin, path: '/dashboard', login: !loginVisible,
            labeledCandidates: loginVisible ? ['$7.25'] : [] };
        } }; }
    setMenuBarVisibility() {} on() {} isDestroyed() { return false; } isVisible() { return false; }
    async loadURL(url) { this.current = url; } destroy() {}
  }
  const host = createChannelHost({ BrowserWindowImpl: Window,
    sessionImpl: { fromPartition() { return { setPermissionRequestHandler() {} }; } },
    autoLogin: { available: () => true, claim: () => { claims++; return null; } }, wait: async () => {} });
  await host.observe(channel);
  assert.equal(routeOpens, 1); assert.equal(claims, 1); assert.equal(submits, 0);
  host.closeAll();
});
test('AeroRelay route scripts refuse foreign origin, marketing dashboard link and unrelated home', () => {
  const channel = CHANNELS[3]; let routeCalls = 0, clicks = 0;
  const link = { href: channel.origin + '/dashboard', getClientRects: () => [{}], click() { clicks++; } };
  const home = { getClientRects: () => [{}], classList: { contains: name => name === 'active' } };
  const form = { getAttribute: () => 'handleLogin(event)' };
  const logo = { href: channel.origin + '/dashboard', getClientRects: () => [{}], click() { throw new Error('logo must not be clicked'); } };
  const document = { querySelector: selector => ({ '#app': {}, '#page-home': home, '#page-login': {}, '#login-form': form })[selector],
    querySelectorAll: selector => selector === 'nav a[href]' ? [link] : [logo, link] };
  const context = (origin, pathname) => ({ location: { origin, href: origin + pathname, pathname }, document,
    window: { navigateTo(page) { assert.equal(page, 'login'); routeCalls++; } }, URL });
  assert.equal(vm.runInNewContext(aeroDashboardNavigationScript(channel), context(channel.origin, '/usage')), true);
  assert.equal(clicks, 1);
  assert.equal(vm.runInNewContext(aeroDashboardNavigationScript(channel), context('https://other.example', '/usage')), false);
  document.querySelector = () => null;
  assert.equal(vm.runInNewContext(aeroDashboardNavigationScript(channel), context(channel.origin, '/usage')), false);
  document.querySelector = selector => ({ '#page-home': home, '#page-login': {}, '#login-form': form })[selector];
  assert.equal(vm.runInNewContext(aeroPublicLoginRouteScript(channel), context(channel.origin, '/dashboard')), true);
  assert.equal(routeCalls, 1);
  assert.equal(vm.runInNewContext(aeroPublicLoginRouteScript(channel), context('https://other.example', '/dashboard')), false);
  assert.equal(vm.runInNewContext(aeroPublicLoginRouteScript(channel), context(channel.origin, '/other')), false);
  assert.equal(routeCalls, 1);
});
test('AeroRelay login reaches the dashboard through its application, without direct dashboard reload', async () => {
  const channel = CHANNELS[3], credentials = { email: 'fictional@example.invalid', password: 'fixture-only-secret-not-real' };
  let loginView = false, appReady = false, dashboardReady = false, claims = 0, resumes = 0, directLoads = 0, navClicks = 0;
  class Window {
    constructor() { this.current = channel.origin + '/dashboard';
      this.webContents = { setWindowOpenHandler() {}, on() {}, getURL: () => this.current,
        executeJavaScript: async script => {
          if (script.includes('AERO_PUBLIC_LOGIN_ROUTE')) { loginView = true; return true; }
          if (script.includes('AERO_DASHBOARD_NAV')) {
            if (!appReady) return false;
            navClicks++; this.current = channel.origin + '/dashboard'; dashboardReady = true; return true;
          }
          if (script.includes('if (!false) return true')) return loginView;
          if (script.includes('if (!true) return true')) { appReady = true; this.current = channel.origin + '/admin/'; return true; }
          if (script.includes('loginVisible:')) return { origin: channel.origin, path: '/home', appReady: true,
            dashboardNavVisible: true, loginVisible: false };
          return { origin: channel.origin, path: new URL(this.current).pathname, login: !dashboardReady,
            labeledCandidates: dashboardReady ? ['$7.25'] : [] };
        } }; }
    setMenuBarVisibility() {} on() {} isDestroyed() { return false; } isVisible() { return false; }
    async loadURL(url) { directLoads++; this.current = url; } destroy() {}
  }
  const host = createChannelHost({ BrowserWindowImpl: Window,
    sessionImpl: { fromPartition() { return { setPermissionRequestHandler() {} }; } },
    autoLogin: { available: () => true, claim: () => { claims++; return credentials; },
      resume: () => { resumes++; } }, wait: async () => {} });
  const result = await host.observe(channel);
  assert.deepEqual(result.labeledCandidates, ['$7.25']);
  assert.equal(directLoads, 0); assert.equal(navClicks, 1);
  assert.equal(claims, 1); assert.equal(resumes, 1);
  host.closeAll();
});
test('another channel never reports automatic login success from one or changing balance sample', async () => {
  const channel = CHANNELS[2]; let claims = 0, resumes = 0, submitted = 0, afterReads = 0;
  class Window {
    constructor() { this.current = ''; this.reloaded = false; this.webContents = { setWindowOpenHandler() {}, on() {},
      getURL: () => this.current, executeJavaScript: async script => {
        if (script.includes('loginVisible:')) return { origin: channel.origin, path: '/dashboard', loginVisible: false };
        if (script.includes('if (!false) return true')) return true;
        if (script.includes('if (!true) return true')) { submitted++; return true; }
        if (!this.reloaded) return { origin: channel.origin, path: channel.path, login: true, labeledCandidates: [] };
        return { origin: channel.origin, path: channel.path, login: false,
          labeledCandidates: [afterReads++ % 2 ? '$2' : '$1'] };
      } }; }
    setMenuBarVisibility() {} on() {} isDestroyed() { return false; } isVisible() { return false; }
    async loadURL(url) { if (this.current) this.reloaded = true; this.current = url; } destroy() {}
  }
  const host = createChannelHost({ BrowserWindowImpl: Window,
    sessionImpl: { fromPartition() { return { setPermissionRequestHandler() {} }; } },
    autoLogin: { available: () => true,
      claim: () => { claims++; return { email: 'fictional@example.invalid', password: 'fixture-only-secret-not-real' }; },
      resume: () => { resumes++; } }, wait: async () => {} });
  assert.equal((await host.observe(channel)).status, 'login-required');
  assert.equal(claims, 1); assert.equal(submitted, 1); assert.equal(resumes, 0);
  host.closeAll();
});
