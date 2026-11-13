'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GroupSettingsService, groupRequest, rate } = require('./group-settings-service');
const { makeDiskStore } = require('./disk-store');
const { makeCatalogStore } = require('./group-catalog');
const REQUEST = '11111111-1111-4111-8111-111111111111';
async function setup(options = {}) {
  let owner = 1, role = 'admin', failed = null, changed = false, mismatch = false, calls = [], saved = [], names = [], failStore = false, otherBlocked = false;
  let user = { id: 8, email: 'fixture@example.invalid', username: '虚构用户', role: 'user', status: 'active',
    allowed_groups: [99], restrict_public_groups: false, group_rates: { 99: 1.7 } };
  let groups = [
    { id: 7, name: '原始专属', status: 'active', subscription_type: 'standard', is_exclusive: true, rate_multiplier: 2 },
    { id: 9, name: '原始公开', status: 'active', subscription_type: 'standard', is_exclusive: false, rate_multiplier: 1 },
    { id: 99, name: '未发布', status: 'active', subscription_type: 'standard', is_exclusive: true, rate_multiplier: 4 }
  ];
  const request = async (method, route, body, context) => {
    calls.push({ method, route, body: body && structuredClone(body) });
    if (route === '/auth/me') return { id: owner, role };
    if (route.startsWith('/admin/groups?')) return { items: structuredClone(groups), total: groups.length };
    if (route.startsWith('/admin/users?')) return { items: [structuredClone(user)], total: 1 };
    if (method === 'GET' && route === '/admin/users/8') return structuredClone(user);
    if (method === 'PUT' && route === '/admin/users/8') {
      assert.equal(context.owner, owner); assert.equal(context.guard(), true); assert.equal(context.groupSettings, true);
      assert.equal(saved.at(-1)?.[0]?.state, 'pending');
      if (failed) throw failed;
      if (!mismatch) { user = { ...user, ...body, group_rates: { ...user.group_rates, ...body.group_rates } };
        for (const [k,v] of Object.entries(user.group_rates)) if (v === null) delete user.group_rates[k]; }
      if (changed) owner = 2;
      return { ...user };
    }
    throw new Error('unexpected fixture route');
  };
  const catalog = options.catalog || { load: () => [], save: rows => { names = structuredClone(rows); } };
  const store = options.store || { load: () => [], save: rows => { if (failStore) throw new Error('fixture disk failure'); saved.push(structuredClone(rows)); } };
  const service = new GroupSettingsService({ request, catalog, store, getOwner: () => owner,
    otherBlocked: () => otherBlocked });
  await service.refresh(); await service.saveNames({ owner: 1, items: [{ id: 7, name: '专属别名' }, { id: 9, name: '公开别名' }] });
  const preview = () => service.findUser('8', () => true);
  const apply = async (p, changes = [{ groupId: 7, allowed: true, rate: 0.8 }], guard = () => true) => service.apply({ requestId: REQUEST, preview: p, changes }, { guard });
  return { service, preview, apply, request, calls, saved, getUser: () => user, setUser: v => { user = { ...user, ...v }; },
    setGroups: v => { groups = v; }, groups: () => groups, setOwner: v => { owner = v; }, setRole: v => { role = v; },
    setFail: v => { failed = v; }, mismatch: () => { mismatch = true; }, failStore: () => { failStore = true; }, names: () => names,
    changedAfterPut: () => { changed = true; }, setOtherBlocked: value => { otherBlocked = value; } };
}
test('catalog includes private groups, hides unnamed groups, and never edits platform on publish', async () => {
  const f = await setup(); const p = await f.preview();
  assert.deepEqual(p.groups.map(g => g.name), ['专属别名','公开别名']);
  assert.equal(p.groups[0].exclusive, true); assert.equal(f.service.state().groups.length, 3);
  assert.equal(f.calls.some(c => c.method !== 'GET'), false);
  await assert.rejects(f.service.saveNames({ owner: 1, items: [{ id: 7, name: '相同' }, { id: 9, name: '相同' }] }),{code:'INPUT'});
  await assert.rejects(f.service.saveNames({ owner: 1, items: [{ id: 7, name: 'a'.repeat(81) }] }),{code:'INPUT'});
});
test('one confirmed update grants private group and rate, preserving unrelated rates, access and public mode', async () => {
  const f = await setup(); const p = await f.preview();
  const result = await f.apply(p); assert.equal(result.userId, 8);
  assert.deepEqual(f.getUser().allowed_groups, [7,99]);
  assert.deepEqual(f.getUser().group_rates, { 7: 0.8, 99: 1.7 });
  assert.equal(f.getUser().restrict_public_groups, false);
  assert.equal(f.service.records[0].state, 'success');
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  await assert.rejects(f.apply(p), { code: 'DUPLICATE' });
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
});
test('single-user settings cannot race with a running or unresolved bulk rate change', async () => {
  const f = await setup(); const preview = await f.preview();
  f.setOtherBlocked(true);
  await assert.rejects(f.apply(preview), { code: 'BUSY' });
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
  f.setOtherBlocked(false);
  assert.equal((await f.apply(preview)).userId, 8);
});
test('inherit default uses null, revoke only selected group, restricted public membership preserved', async () => {
  const f = await setup(); f.setUser({ allowed_groups: [7,9,99], restrict_public_groups: true, group_rates: { 7: 0.8,99:1.7 } });
  await f.apply(await f.preview(), [{ groupId: 7, allowed: false, rate: null },{ groupId: 9, allowed: true, rate: 1.25 }]);
  assert.deepEqual(f.getUser().allowed_groups, [9,99]); assert.deepEqual(f.getUser().group_rates, {9:1.25,99:1.7});
  assert.equal(f.getUser().restrict_public_groups, true);
});
test('cannot revoke public group while unrestricted, mutate hidden group or use invalid rate', async () => {
  for (const change of [{groupId:9,allowed:false,rate:1},{groupId:99,allowed:true,rate:1},
    {groupId:7,allowed:true,rate:0},{groupId:7,allowed:true,rate:NaN}]) {
    const f = await setup(); await assert.rejects(f.apply(await f.preview(),[change]));
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, 0);
  }
  for (const value of ['0','-1','Infinity','NaN','1e2','0.0001','1.0001','1x']) assert.throws(() => rate(value));
  for (const value of ['0.001','0.8','1','1.234']) assert.equal(rate(value), Number(value));
});
test('exact email lookup and invalid/missing user are bounded; wrong admin role rejected', async () => {
  const f = await setup(); assert.equal((await f.service.findUser('fixture@example.invalid', () => true)).user.id,8);
  await assert.rejects(f.service.findUser('other@example.invalid', () => true), { code: 'INPUT' });
  await assert.rejects(f.service.findUser('虚构用户', () => true), { code: 'INPUT' });
  f.setRole('user'); await assert.rejects(f.preview(), { code: 'DENIED' });
});
test('server omits empty group_rates and serializes empty allowed_groups as null', async () => {
  const f = await setup(); f.setUser({ allowed_groups: null, group_rates: undefined });
  const preview = await f.preview();
  assert.deepEqual(preview.user.group_rates, {}); assert.deepEqual(preview.user.allowed_groups, []);
});
test('preview detects concurrent rate, access, identity or published-name changes before PUT', async () => {
  for (const change of [{group_rates:{99:2}},{allowed_groups:[7,99]},{email:'changed@example.invalid'}]) {
    const f = await setup(); const p = await f.preview(); f.setUser(change);
    await assert.rejects(f.apply(p), { code:'CONFLICT' }); assert.equal(f.calls.some(c=>c.method==='PUT'),false);
  }
  const f = await setup(); const p = await f.preview();
  await f.service.saveNames({owner:1,items:[{id:7,name:'改名'}]});
  await assert.rejects(f.apply(p),{code:'CONFLICT'});
});
test('pending storage failure prevents PUT; lost reply and mismatched readback stay unknown without retry', async () => {
  const disk = await setup(); const p = await disk.preview(); disk.failStore();
  await assert.rejects(disk.apply(p),{code:'STORAGE'}); assert.equal(disk.calls.some(c=>c.method==='PUT'),false);
  for (const mismatch of [false,true]) {
    const f = await setup(); const p = await f.preview();
    mismatch ? f.mismatch() : f.setFail(new Error('fictional timeout'));
    await assert.rejects(f.apply(p)); assert.equal(f.service.records[0].state,'unknown');
    assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
    await assert.rejects(f.service.review(REQUEST));
    assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
    await f.service.review(REQUEST,true); assert.equal(f.service.records[0].state,'reviewed');
  }
});
test('readback recovery confirms applied uncertain update without PUT replay', async () => {
  const f = await setup(); f.setFail(new Error('fictional timeout')); await assert.rejects(f.apply(await f.preview()));
  f.setUser({allowed_groups:[7,99],group_rates:{7:0.8,99:1.7}});
  await f.service.review(REQUEST); assert.equal(f.service.records[0].state,'success');
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
});
test('HTTP rejection after attempted multi-field update remains unknown even if transport says definitive', async () => {
  const f = await setup(); f.setFail(Object.assign(new Error('fictional partial rejection'),{code:'HTTP',definitive:true}));
  await assert.rejects(f.apply(await f.preview())); assert.equal(f.service.records[0].state,'unknown');
});
test('session or account change, inactive user and extra request body fields denied', async () => {
  const f = await setup(); const p = await f.preview();
  await assert.rejects(f.apply(p,undefined,()=>false),{code:'POLICY'});
  f.setUser({status:'disabled'}); await assert.rejects(f.preview(),{code:'SCHEMA'});
  const body={allowed_groups:[],restrict_public_groups:false,group_rates:{7:0.8}};
  assert.equal(groupRequest('PUT','/admin/users/8',body),true);
  for (const extra of [{role:'admin'},{balance:10},{password:'fictional'}]) assert.equal(groupRequest('PUT','/admin/users/8',{...body,...extra}),false);
  for (const route of ['/admin/users/8/balance','/admin/users/0','/admin/users/8?x=1']) assert.equal(groupRequest('PUT',route,body),false);
  assert.equal(groupRequest('DELETE','/admin/users/8',body),false);
});
test('pagination checks duplicate IDs, incomplete responses and bounded totals', async () => {
  const f = await setup();
  for (const data of [{items:[{id:1},{id:1}],total:2},{items:[],total:1},{items:[],total:3000}]) {
    f.service.request=async()=>data; await assert.rejects(f.service.allPages(()=>'/fixture'));
  }
  let count=0; f.service.request=async()=>({items:[{id:++count}],total:2});
  assert.deepEqual(await f.service.allPages(()=>'/fixture'),[{id:1},{id:2}]);
});
test('real independent journal reopens unknown state and retains unrelated catalogs', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'group-settings-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=await setup(); const p=await f.preview(); f.setFail(new Error('fictional timeout')); await assert.rejects(f.apply(p));
  const store=makeDiskStore(dir,{}); store.load(); store.save(f.service.records);
  const catalog=makeCatalogStore(dir); catalog.load(); catalog.save(f.names());
  const next=new GroupSettingsService({request:f.request,getOwner:()=>1,catalog:makeCatalogStore(dir),store:makeDiskStore(dir,{})});
  assert.equal(next.records[0].state,'unknown'); assert.equal(next.catalog.length,2);
  await assert.rejects(next.apply({requestId:'22222222-2222-4222-8222-222222222222',preview:p,changes:[]},{guard:()=>true}),{code:'UNKNOWN'});
});
module.exports = { setup };
