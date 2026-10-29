'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KeyService, ToolError, validate, normalizeGroups, keyResult, validateFeishuLimits } = require('./service');
const { actorFromOpenId } = require('./feishu-bot-workflow');
const groups = [{ id: 7, name: 'Test group', platform: 'openai', rate_multiplier: 1 }];
const input = (overrides = {}) => ({ requestId: '11111111-1111-4111-8111-111111111111', groupId: 7, quota: '5.5', name: 'Test', days: '', ...overrides });
function fixture(options = {}) {
  const calls = []; let saved = options.records || [], owner = 1;
  let catalogRows = options.catalogRows ?? [{ owner: 1, groupId: 7, name: '客户分组' }];
  const catalog = { load: () => structuredClone(catalogRows), save(rows) {
    if (options.failCatalogSave) throw new Error('disk'); catalogRows = structuredClone(rows);
  } };
  const store = {
    load: () => structuredClone(saved),
    save(rows) { if (options.failSave) throw new Error('disk'); saved = structuredClone(rows); },
    seal: value => JSON.stringify(value), open: value => JSON.parse(value)
  };
  const request = async (method, route, body, context) => {
    calls.push({ method, route, body, context });
    if (route === '/auth/me') return { id: owner };
    if (route === '/groups/available') return options.groups ?? groups;
    if (method === 'POST') {
      if (options.post) return options.post(body);
      return { id: 44, key: 'sk-fixture-only-not-real' };
    }
    if (route.startsWith('/keys?')) return { items: options.matches || [] };
    if (route === '/keys/44') return { id: 44, key: 'sk-fixture-only-not-real' };
    throw new Error('unexpected route');
  };
  return { service: new KeyService({ request, store, catalog }), calls, store,
    catalogPersisted: () => structuredClone(catalogRows),
    setOwner: value => { owner = value; }, persisted: () => structuredClone(saved), options };
}
test('groups require unique positive IDs; no invented groups', () => {
  assert.equal(normalizeGroups(groups)[0].id, 7);
  for (const raw of [null, {}, [{ id: 0, name: 'bad' }], [...groups, ...groups]]) assert.throws(() => normalizeGroups(raw));
});
test('quota mandatory, finite, positive; group selection mandatory', () => {
  for (const quota of ['', ' ', 0, '-1', 'NaN', 'Infinity', null, false, []]) assert.throws(() => validate(input({ quota }), groups));
  assert.throws(() => validate(input({ groupId: 99 }), groups));
  assert.throws(() => validate(input({ requestId: '../bad' }), groups));
  assert.equal(validate(input(), groups).quota, 5.5);
});
test('days integer only and quota not multiplied', () => {
  for (const days of ['0', '-1', '1.5', '3651']) assert.throws(() => validate(input({ days }), groups));
  assert.equal(validate(input({ days: 2 }), groups).expires_in_days, 2);
  assert.equal(validate(input(), groups).expires_in_days, undefined);
});
test('cannot create before authenticated refresh', async () => {
  const f = fixture(); await assert.rejects(f.service.create(input()), { code: 'AUTH' }); assert.equal(f.calls.length, 0);
});
test('correct request; duplicate operation returns stored result, no second POST', async () => {
  const f = fixture(); await f.service.refresh();
  const a = await f.service.create(input()); const b = await f.service.create(input()); assert.deepEqual(a, b);
  const posts = f.calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { name: 'Test [11111111-1111-4111-8111-111111111111]', group_id: 7, quota: 5.5 });
  assert.deepEqual(posts[0].context, { owner: 1 });
});
test('same operation different parameters rejected', async () => {
  const f = fixture(); await f.service.refresh(); await f.service.create(input());
  await assert.rejects(f.service.create(input({ quota: 8 })), { code: 'CONFLICT' });
});
test('account switch rejected before POST', async () => {
  const f = fixture(); await f.service.refresh(); f.setOwner(2);
  await assert.rejects(f.service.create(input()), { code: 'AUTH' }); assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});
test('durable operation log must be saved before POST', async () => {
  const f = fixture({ failSave: true }); await f.service.refresh();
  await assert.rejects(f.service.create(input()), { code: 'NOT_SENT' }); assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

test('pre-send disk failure reports a safe error code without leaking paths or key text', async () => {
  const f = fixture(); await f.service.refresh();
  f.store.save = () => { const e = new Error('private-path sk-private-data'); e.code = 'EXDEV'; throw e; };
  await assert.rejects(f.service.create(input()), e => e.code === 'NOT_SENT' && e.message.includes('EXDEV') && !e.message.includes('private'));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(f.service.blocked().length, 1);
});
test('timeout after remote mutation blocks replay and new operations', async () => {
  const f = fixture({ post: () => { throw new Error('network'); } }); await f.service.refresh();
  await assert.rejects(f.service.create(input()), { code: 'UNKNOWN' });
  await assert.rejects(f.service.create(input()), { code: 'UNKNOWN' });
  await assert.rejects(f.service.create(input({ requestId: '22222222-2222-4222-8222-222222222222' })), { code: 'UNKNOWN' });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  const restarted = fixture({ records: f.persisted() }); await restarted.service.refresh();
  await assert.rejects(restarted.service.create(input()), { code: 'UNKNOWN' });
});
test('persisted pending after crash becomes unknown on restart', () => {
  const f = fixture({ records: [{ state: 'pending', requestId: input().requestId, body: { name: 'pending', quota: 5 }, owner: 1 }] });
  assert.equal(f.service.state().unresolved.length, 1);
});
test('explicit rejection is not automatically retried', async () => {
  const error = new ToolError('HTTP', 'denied'); error.definitive = true;
  const f = fixture({ post: () => { throw error; } }); await f.service.refresh();
  await assert.rejects(f.service.create(input()), { code: 'HTTP' });
  assert.equal(f.persisted()[0].state, 'failed'); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('unknown schema/masked key treated as uncertain, never success', async () => {
  for (const key of ['', 'sk-***', 'sk-•••', null]) assert.throws(() => keyResult({ id: 4, key }, {}));
  const f = fixture({ post: () => ({ id: 4, key: 'sk-***' }) }); await f.service.refresh();
  await assert.rejects(f.service.create(input()), { code: 'UNKNOWN' }); assert.equal(f.service.blocked().length, 1);
});
test('parallel clicks allow one POST', async () => {
  let release;
  const f = fixture({ post: () => new Promise(r => { release = r; }) }); await f.service.refresh();
  const first = f.service.create(input());
  await new Promise(r => setImmediate(r)); await assert.rejects(f.service.create(input()), { code: 'BUSY' });
  release({ id: 44, key: 'sk-fixture-only-not-real' }); await first;
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('reconcile reads only exact unique name and retrieves key', async () => {
  const f = fixture({ post: () => { throw new Error(); } }); await f.service.refresh();
  await assert.rejects(f.service.create(input()));
  f.options.matches = [{ id: 44, name: validate(input(), groups).name }];
  const result = await f.service.reconcile(input().requestId);
  assert.equal(result.id, 44); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.service.blocked().length, 0);
});
test('missing/ambiguous reconciliation retains lock', async () => {
  const f = fixture({ post: () => { throw new Error(); } }); await f.service.refresh(); await assert.rejects(f.service.create(input()));
  await assert.rejects(f.service.reconcile(input().requestId), { code: 'UNKNOWN' }); assert.equal(f.service.blocked().length, 1);
});
test('manual acknowledgement requires original identity and explicit confirmation', async () => {
  const f = fixture({ post: () => { throw new Error(); } }); await f.service.refresh(); await assert.rejects(f.service.create(input()));
  await assert.rejects(f.service.acknowledge(input().requestId, false)); f.setOwner(2);
  await assert.rejects(f.service.acknowledge(input().requestId, true)); f.setOwner(1);
  await f.service.acknowledge(input().requestId, true); assert.equal(f.service.blocked().length, 0);
});
test('persisted successful result can be recovered with same operation only by original account', async () => {
  const f = fixture(); await f.service.refresh(); await f.service.create(input());
  const other = fixture({ records: f.persisted() }); await other.service.refresh();
  assert.equal((await other.service.create(input())).id, 44); assert.equal(other.calls.some(c => c.method === 'POST'), false);
});

test('remote success followed by receipt save failure retains protection', async () => {
  const f = fixture({ post: () => { f.options.failSave = true; return { id: 44, key: 'sk-fixture-only-not-real' }; } });
  await f.service.refresh();
  await assert.rejects(f.service.create(input()), { code: 'UNKNOWN' });
  assert.equal(f.service.blocked().length, 1);
  assert.equal(f.persisted()[0].state, 'pending');
  await assert.rejects(f.service.create(input({ requestId: '22222222-2222-4222-8222-222222222222' })), { code: 'UNKNOWN' });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('failed rejection persistence does not remove the in-memory lock', async () => {
  const error = new ToolError('HTTP', 'denied'); error.definitive = true;
  const f = fixture({ post: () => { f.options.failSave = true; throw error; } });
  await f.service.refresh();
  await assert.rejects(f.service.create(input()), { code: 'UNKNOWN' });
  assert.equal(f.service.blocked().length, 1);
  assert.equal(f.persisted()[0].state, 'pending');
});

test('reconciliation save failure retains unknown state and can safely be retried read-only', async () => {
  const f = fixture({ post: () => { throw new Error(); } }); await f.service.refresh();
  await assert.rejects(f.service.create(input()));
  f.options.matches = [{ id: 44, name: validate(input(), groups).name }];
  f.options.failSave = true;
  await assert.rejects(f.service.reconcile(input().requestId));
  assert.equal(f.service.blocked().length, 1); assert.equal(f.persisted()[0].state, 'unknown');
  f.options.failSave = false;
  assert.equal((await f.service.reconcile(input().requestId)).id, 44);
  assert.equal(f.service.blocked().length, 0);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('manual acknowledgement save failure retains protection until durable retry', async () => {
  const f = fixture({ post: () => { throw new Error(); } }); await f.service.refresh();
  await assert.rejects(f.service.create(input())); f.options.failSave = true;
  await assert.rejects(f.service.acknowledge(input().requestId, true));
  assert.equal(f.service.blocked().length, 1); assert.equal(f.persisted()[0].state, 'unknown');
  f.options.failSave = false; await f.service.acknowledge(input().requestId, true);
  assert.equal(f.service.blocked().length, 0);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('encryption failure never stores a plaintext result or unlocks creation', async () => {
  const f = fixture(); await f.service.refresh();
  f.store.seal = () => { throw new Error('encryption unavailable'); };
  await assert.rejects(f.service.create(input()), { code: 'UNKNOWN' });
  assert.equal(f.service.blocked().length, 1);
  assert.equal(JSON.stringify(f.persisted()).includes('sk-fixture'), false);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

const saveNames = (f, items, owner = 1) => f.service.saveGroupNames({ owner, items });
test('unnamed groups default to hidden, including when no catalog adapter is configured', async () => {
  const f = fixture({ catalogRows: [] }); await f.service.refresh();
  assert.deepEqual(f.service.state().groups, []);
  assert.equal(f.service.adminState().groups[0].name, 'Test group');
  assert.equal(f.service.adminState().groups[0].customerName, '');
  await assert.rejects(f.service.create(input()), { code: 'INPUT' });
  const service = new KeyService({ request: f.service.request, store: f.store }); await service.refresh();
  assert.deepEqual(service.state().groups, []);
  await assert.rejects(service.create(input()), { code: 'INPUT' });
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});

test('publishing trims aliases, projects no raw metadata and still creates using the original ID', async () => {
  const f = fixture({ catalogRows: [] }); await f.service.refresh();
  await saveNames(f, [{ id: 7, name: '  客户专享  ' }]);
  assert.deepEqual(f.service.state().groups, [{ id: 7, name: '客户专享' }]);
  assert.deepEqual(f.catalogPersisted(), [{ owner: 1, groupId: 7, name: '客户专享' }]);
  assert.equal(f.service.adminState().groups[0].name, 'Test group');
  await f.service.create(input());
  assert.equal(f.calls.find(c => c.method === 'POST').body.group_id, 7);
});

test('unpublish blocks new requests but does not repeat or discard a successful receipt', async () => {
  const f = fixture(); await f.service.refresh(); const original = await f.service.create(input());
  await saveNames(f, [{ id: 7, name: '   ' }]);
  assert.deepEqual(f.service.state().groups, []);
  assert.deepEqual(f.catalogPersisted(), []);
  assert.deepEqual(await f.service.create(input()), original);
  await assert.rejects(f.service.create(input({ requestId: '22222222-2222-4222-8222-222222222222' })), { code: 'INPUT' });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('aliases survive service reopen and remain isolated by account', async () => {
  const f = fixture({ catalogRows: [] }); await f.service.refresh();
  await saveNames(f, [{ id: 7, name: '账户一' }]);
  f.setOwner(2); await f.service.refresh(); assert.deepEqual(f.service.state().groups, []);
  await saveNames(f, [{ id: 7, name: '账户二' }], 2);
  assert.deepEqual(f.service.state().groups, [{ id: 7, name: '账户二' }]);
  f.setOwner(1); await f.service.refresh();
  assert.deepEqual(f.service.state().groups, [{ id: 7, name: '账户一' }]);
  const reopened = fixture({ catalogRows: f.catalogPersisted() }); await reopened.service.refresh();
  assert.deepEqual(reopened.service.state().groups, [{ id: 7, name: '账户一' }]);
});

test('save rejects stale account and identity switches before persisting', async () => {
  const f = fixture(); await f.service.refresh(); const original = f.catalogPersisted();
  await assert.rejects(saveNames(f, [{ id: 7, name: 'bad' }], 2), { code: 'INPUT' });
  f.setOwner(2);
  await assert.rejects(saveNames(f, [{ id: 7, name: 'bad' }]), { code: 'AUTH' });
  assert.deepEqual(f.catalogPersisted(), original);
});

test('invalid names and duplicate, unknown or noninteger group IDs never publish', async () => {
  const f = fixture(); await f.service.refresh(); const original = f.catalogPersisted();
  for (const items of [[{ id: 7, name: 'a' }, { id: 7, name: 'b' }], [{ id: 99, name: 'a' }],
    [{ id: '7', name: 'a' }], [{ id: 7.5, name: 'a' }], [{ id: 7, name: null }],
    [{ id: 7, name: 'a\nb' }], [{ id: 7, name: 'a'.repeat(81) }]]) {
    await assert.rejects(saveNames(f, items), { code: 'INPUT' });
    assert.deepEqual(f.catalogPersisted(), original);
  }
  await saveNames(f, [{ id: 7, name: 'a'.repeat(80) }]);
  assert.equal(f.service.state().groups[0].name.length, 80);
});

test('partial saves preserve other mappings; duplicate customer names are rejected atomically', async () => {
  const f = fixture({ groups: [...groups, { id: 9, name: 'raw-nine' }] }); await f.service.refresh();
  await saveNames(f, [{ id: 9, name: '第二分组' }]); const original = f.catalogPersisted();
  assert.equal(f.service.state().groups.length, 2);
  await assert.rejects(saveNames(f, [{ id: 9, name: ' 客户分组 ' }]), { code: 'INPUT' });
  assert.deepEqual(f.catalogPersisted(), original);
  await saveNames(f, [{ id: 9, name: '' }]);
  assert.deepEqual(f.service.state().groups, [{ id: 7, name: '客户分组' }]);
});

test('remote removal hides a group; newly added raw groups are not implicitly published', async () => {
  const f = fixture(); await f.service.refresh();
  f.options.groups = [{ id: 9, name: 'new-raw' }]; await f.service.refresh();
  assert.deepEqual(f.service.state().groups, []);
  await assert.rejects(f.service.create(input()), { code: 'INPUT' });
  await assert.rejects(f.service.create(input({ groupId: 9 })), { code: 'INPUT' });
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});

test('pre-POST availability recheck refuses a remotely removed published group', async () => {
  const f = fixture(); await f.service.refresh(); f.options.groups = [];
  await assert.rejects(f.service.create(input()), { code: 'INPUT' });
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
  assert.deepEqual(f.persisted(), []);
});

test('a manually reviewed Feishu creation remains charged in the single-process safety ledger', () => {
  const row = { feishuGroupId: 'oc_12345678', operator: actorFromOpenId('ou_member_12345678'),
    state: 'reviewed', at: new Date().toISOString(), body: { quota: 6 } };
  assert.throws(() => validateFeishuLimits({ quota: '5' }, {
    verifiedActor: actorFromOpenId('ou_member_12345678'), feishuGroupId: 'oc_12345678',
    quotaLimits: { maxQuota: 5, maxUserDailyQuota: 10, maxGroupDailyQuota: 20 }, guard: () => true
  }, [row]), { code: 'BUDGET' });
});

test('Feishu service permits unlimited daily totals but still enforces the per-token ceiling', () => {
  const actor = actorFromOpenId('ou_member_12345678');
  const context = { verifiedActor: actor, feishuGroupId: 'oc_12345678',
    quotaLimits: { maxQuota: 20, maxUserDailyQuota: null, maxGroupDailyQuota: null }, guard: () => true };
  const largePrior = [{ feishuGroupId: 'oc_12345678', operator: actor, state: 'success', at: new Date().toISOString(), body: { quota: 2000000 } }];
  assert.deepEqual(validateFeishuLimits({ quota: 20 }, context, largePrior), actor);
  assert.throws(() => validateFeishuLimits({ quota: 20.0001 }, context, largePrior), { code: 'POLICY' });
});

test('catalog write failure does not publish and cannot be cleared by refresh or another save', async () => {
  const f = fixture({ failCatalogSave: true }); await f.service.refresh(); const original = f.catalogPersisted();
  await assert.rejects(saveNames(f, [{ id: 7, name: 'never published' }]), { code: 'STORAGE' });
  assert.deepEqual(f.catalogPersisted(), original);
  assert.deepEqual(f.service.state().groups, []);
  assert.equal(f.service.state().connected, false);
  f.options.failCatalogSave = false;
  await assert.rejects(f.service.refresh(), { code: 'STORAGE' });
  await assert.rejects(saveNames(f, [{ id: 7, name: 'bad' }]), { code: 'STORAGE' });
  await assert.rejects(f.service.create(input()), { code: 'AUTH' });
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});

test('refresh calls coalesce and reject create/save while account state is in flight', async () => {
  const f = fixture(); await f.service.refresh();
  const original = f.service.request; let release, identityCalls = 0;
  f.service.request = (method, route, ...args) => route === '/auth/me'
    ? (identityCalls++, new Promise(resolve => { release = resolve; })) : original(method, route, ...args);
  const first = f.service.refresh(), second = f.service.refresh();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.create(input()), { code: 'BUSY' });
  await assert.rejects(saveNames(f, [{ id: 7, name: '' }]), { code: 'BUSY' });
  release({ id: 1 }); assert.deepEqual(await first, await second); assert.equal(identityCalls, 1);
  f.service.request = original; await f.service.refresh(); assert.equal(f.service.busy, false);
});

test('save and create cannot race, and failures release busy state for a valid retry', async () => {
  const f = fixture(); await f.service.refresh();
  const original = f.service.request; let release;
  f.service.request = (method, route, ...args) => route === '/auth/me'
    ? new Promise(resolve => { release = resolve; }) : original(method, route, ...args);
  const saving = saveNames(f, [{ id: 7, name: '新名称' }]);
  await assert.rejects(f.service.create(input()), { code: 'BUSY' });
  await assert.rejects(f.service.refresh(), { code: 'BUSY' });
  release({ id: 1 }); await saving; f.service.request = original;
  await assert.rejects(saveNames(f, [{ id: 99, name: 'bad' }]), { code: 'INPUT' });
  await f.service.create(input()); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
