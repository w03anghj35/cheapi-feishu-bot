'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FeishuReconnect } = require('./feishu-reconnect');
const { FeishuConnection } = require('./feishu-connection');
const record = { appId:'cli_1234567890abcdef', appSecret:'fixture-only-secret', savedAt:'2026-10-31T00:00:00Z' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ initial = record, lease, ensureReady } = {}) {
  let now = 0, id = 0, ready = true;
  const pending = new Map(), clients = [];
  const timers = { setTimeout(fn,ms) { pending.set(++id,{fn,at:now+ms}); return id; }, clearTimeout(id) { pending.delete(id); } };
  const connection = new FeishuConnection({ store:{load:()=>initial,save(){}}, lease, timers,
    now:()=>new Date(now).toISOString(), createClient(options) {
      const c={options,status:'connecting',starts:0,closes:0,start(){this.starts++;},
        close(){this.closes++;this.status='idle';},getConnectionStatus(){return {state:this.status};}};
      clients.push(c); return c;
    }});
  const supervisor = new FeishuReconnect({ connection,timers,now:()=>now,
    ensureReady:ensureReady || (async()=>{if(!ready)throw Object.assign(new Error('fixture authorization'),{code:'AUTH'});}) });
  async function advance(ms) {
    const end=now+ms;
    while(true){const next=[...pending.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;now=next[1].at;pending.delete(next[0]);next[1].fn();await flush();}
    now=end;await flush();
  }
  return {connection,supervisor,clients,pending,advance,now:()=>now,setReady:v=>{ready=v;},
    online:()=>{const c=clients.at(-1);c.status='connected';c.options.onReady();},
    fail:()=>clients.at(-1).options.onError(new Error(record.appSecret))};
}
test('startup connects without a renderer and double start cannot duplicate a client',async()=>{
  const f=fixture();await Promise.all([f.supervisor.start(),f.supervisor.start()]);await flush();
  assert.equal(f.clients.length,1);assert.equal(f.clients[0].starts,1);assert.equal(f.supervisor.state().enabled,true);
  f.supervisor.stop();assert.equal(f.pending.size,0);
});
test('failure retries with bounded exponential backoff and no attempt limit',async()=>{
  const f=fixture();await f.supervisor.start();
  for(const delay of [5000,10000,20000,40000,60000,60000]){
    f.fail();await f.supervisor.tick();const count=f.clients.length;
    assert.equal(f.supervisor.state().nextRetryAt-f.now(),delay);
    await f.advance(delay-1);assert.equal(f.clients.length,count);
    await f.advance(1);assert.equal(f.clients.length,count+1);
  }
  assert.equal(JSON.stringify(f.supervisor.state()).includes(record.appSecret),false);
  f.supervisor.stop();
});
test('45-second stalled handshake closes before replacement; no overlapping sockets',async()=>{
  const f=fixture();await f.supervisor.start();await f.advance(45000);
  assert.equal(f.clients[0].closes,1);assert.equal(f.clients.length,1);
  await f.advance(5000);assert.equal(f.clients.length,2);f.supervisor.stop();
});
test('silent socket loss detected by main-process polling without state reads from UI',async()=>{
  const f=fixture();await f.supervisor.start();f.online();await f.advance(5000);
  f.clients[0].status='idle';await f.advance(5000);assert.equal(f.connection.phase,'reconnecting');
  await f.advance(45000);assert.equal(f.clients[0].closes,1);
  await f.advance(5000);assert.equal(f.clients.length,2);f.supervisor.stop();
});
test('manual stop cancels retry and stale SDK notifications cannot reconnect',async()=>{
  const f=fixture();await f.supervisor.start();const old=f.clients[0];f.fail();await f.supervisor.tick();
  f.supervisor.stop();await f.advance(600000);old.status='connected';old.options.onReady();
  assert.equal(f.clients.length,1);assert.equal(f.connection.state().phase,'disconnected');assert.equal(f.pending.size,0);
  await f.supervisor.start();assert.equal(f.clients.length,2);f.supervisor.stop();
});
test('stop while awaiting authorization never connects after the late result',async()=>{
  let release;const f=fixture({ensureReady:()=>new Promise(r=>{release=r;})});
  const start=f.supervisor.start();await flush();f.supervisor.stop();release();await start;
  assert.equal(f.clients.length,0);assert.equal(f.pending.size,0);
});
test('stop then start during authorization uses a fresh generation',async()=>{
  let release,calls=0;const f=fixture({ensureReady:()=>{calls++;return calls===1?new Promise(r=>{release=r;}):Promise.resolve();}});
  const first=f.supervisor.start();await flush();f.supervisor.stop();const second=f.supervisor.start();release();await Promise.all([first,second]);
  assert.equal(f.clients.length,0);await f.advance(5000);assert.equal(f.clients.length,1);f.supervisor.stop();
});
test('authorization outage backs off then resumes; no client created before authorization',async()=>{
  const f=fixture();f.setReady(false);await f.supervisor.start();assert.equal(f.clients.length,0);
  await f.advance(5000);assert.equal(f.clients.length,0);assert.equal(f.supervisor.state().reason,'auth');
  f.setReady(true);await f.advance(10000);assert.equal(f.clients.length,1);f.supervisor.stop();
});
test('missing credentials and damaged storage do not cause network requests',async()=>{
  const f=fixture({initial:null});await f.supervisor.start();await f.advance(120000);assert.equal(f.clients.length,0);
  assert.equal(f.supervisor.state().reason,'credentials');f.connection.save(record);await f.advance(5000);assert.equal(f.clients.length,1);f.supervisor.stop();
  const broken=new FeishuConnection({store:{load(){throw new Error('fixture');}},createClient(){throw new Error('should not run');}});
  const gate=new FeishuReconnect({connection:broken,ensureReady:async()=>assert.fail(),timers:{setTimeout(){return 1;},clearTimeout(){}}});
  await gate.start();assert.equal(gate.state().reason,'storage');gate.stop();
});
test('uncertain close never creates a second client or releases its lock',async()=>{
  let releases=0;const f=fixture({lease:{acquire(){},release(){releases++;}}});await f.supervisor.start();
  f.clients[0].close=()=>{throw new Error('fixture close');};f.fail();await f.advance(600000);
  assert.equal(f.clients.length,1);assert.equal(releases,0);assert.equal(f.supervisor.state().reason,'stop');f.supervisor.stop();
});
test('another instance lock is never reclaimed; available lock is retried later',async()=>{
  let busy=true;const f=fixture({lease:{acquire(){if(busy)throw new Error('fixture lock');},release(){}}});await f.supervisor.start();
  assert.equal(f.supervisor.state().reason,'lease');assert.equal(f.clients.length,0);
  busy=false;await f.advance(5000);assert.equal(f.clients.length,1);f.supervisor.stop();
});
test('stable online period resets backoff but brief connections do not',async()=>{
  const f=fixture();await f.supervisor.start();f.fail();await f.supervisor.tick();await f.advance(5000);
  f.online();await f.advance(5000);assert.equal(f.supervisor.attempts,2);
  await f.advance(60000);assert.equal(f.supervisor.attempts,0);
  f.fail();await f.supervisor.tick();assert.equal(f.clients.length,3);f.supervisor.stop();
});
