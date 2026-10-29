'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { KeyService, ToolError } = require('./service');
const history = require('./operation-history');
function fixture(rows = []) {
  let saved = structuredClone(rows), failSave = false, postError = null, identity = 1, opens = 0;
  const calls = [], secrets = new Map(); let secretId = 0;
  const store = { load: () => structuredClone(saved), save: rows => { if (failSave) throw new Error('disk'); saved = structuredClone(rows); },
    seal: value => { const id = 'encrypted-fixture-' + (++secretId); secrets.set(id, structuredClone(value)); return id; },
    open: id => { opens++; if (!secrets.has(id)) throw new Error('decrypt'); return structuredClone(secrets.get(id)); } };
  const options = { store, catalog: { load: () => [{ owner: 1, groupId: 7, name: '客户分组' }], save() {} },
    request: async (method, route, body) => {
      calls.push({ method, route, body });
      if (route === '/auth/me') return { id: identity };
      if (route === '/groups/available') return [{ id: 7, name: '原始分组', platform: 'openai', rate_multiplier: 1.2 }];
      if (method === 'POST') { if (postError) throw postError; return { id: 44, key: 'sk-history-fictional-secret' }; }
      if (route.startsWith('/keys?')) return { items: [{ id: 44, name: saved[0].body.name }] };
      if (route === '/keys/44') return { id: 44, key: 'sk-history-fictional-secret' };
      throw new Error('unexpected');
    } };
  return { service: new KeyService(options), options, store, calls, saved: () => structuredClone(saved), opens: () => opens,
    failSave: v => { failSave = v; }, postError: e => { postError = e; }, identity: id => { identity = id; } };
}
const input = (overrides = {}) => ({ requestId: randomUUID(), groupId: 7, quota: '12.5', days: 3, name: '测试令牌', operator: '客户 A / 联系账号', ...overrides });
test('operator is explicitly unverified; invalid or oversized identities are refused', () => {
  assert.deepEqual(history.operator('  客户甲  '), { name: '客户甲', source: 'self-reported', verified: false });
  assert.equal(history.operator(undefined).source, 'unrecorded');
  for (const v of ['', ' ', null, {}, [], 'a\nb', 'a'.repeat(101)]) assert.throws(() => history.operator(v));
});
test('creation saves exact actor, both group names, quota, days and lifecycle without credentials', async () => {
  const f = fixture(); await f.service.refresh(); const i = input(); await f.service.create(i);
  const r = f.saved()[0];
  assert.equal(r.operator.name, i.operator); assert.equal(r.operator.verified, false);
  assert.deepEqual(r.group, { id: 7, originalName: '原始分组', customerName: '客户分组', platform: 'openai', rate: 1.2 });
  assert.equal(r.body.quota, 12.5); assert.equal(r.body.expires_in_days, 3);
  assert.equal(r.receipt.id, 44); assert.equal(r.events.length, 2); assert.ok(r.updatedAt);
  assert.equal(JSON.stringify(r).includes('sk-history'), false);
  const post = f.calls.find(c => c.method === 'POST'); assert.equal(post.body.operator, undefined);
});
test('list and search never decrypt or expose receipts or complete keys', async () => {
  const f = fixture(); await f.service.refresh(); await f.service.create(input());
  for (const search of ['客户 A', '原始分组', '客户分组', '44', '测试令牌', '12.5']) assert.equal(f.service.adminRecords({ search }).total, 1);
  const result = f.service.adminRecords();
  assert.equal(f.opens(), 0); assert.equal(JSON.stringify(result).includes('sk-history'), false);
  assert.equal(result.items[0].result, undefined); assert.equal(result.items[0].fingerprint, undefined);
  assert.equal(f.service.adminRecords({ search: 'nonexistent' }).total, 0);
});
test('detail decrypts legacy metadata but hides full secret and has no network requests', async () => {
  const f = fixture(); await f.service.refresh(); const i = input(); await f.service.create(i);
  delete f.service.records[0].receipt; const before = f.calls.length;
  const r = f.service.adminRecord(i.requestId); assert.equal(r.keyId, 44); assert.equal(r.hasSecret, true);
  assert.equal(JSON.stringify(r).includes('sk-history'), false); assert.equal(f.calls.length, before);
  assert.throws(() => f.service.adminRecord('missing'), { code: 'INPUT' });
});
test('group renaming does not rewrite historical snapshots; duplicate submission is not another record', async () => {
  const f = fixture(); await f.service.refresh(); const i = input(); await f.service.create(i);
  await f.service.saveGroupNames({ owner: 1, items: [{ id: 7, name: '新客户名称' }] });
  await f.service.create(i); assert.equal(f.service.records.length, 1);
  assert.equal(f.service.adminRecords().items[0].group.customerName, '客户分组');
  await assert.rejects(f.service.create({ ...i, operator: '客户 B' }), { code: 'CONFLICT' });
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('manual identity validation is enforced before any network or persistence', async () => {
  const f = fixture(); await f.service.refresh(); const before = f.calls.length;
  await assert.rejects(f.service.create(input({ operator: 'bad\nidentity' })), { code: 'INPUT' });
  assert.equal(f.calls.length, before); assert.equal(f.saved().length, 0);
});
test('reopen retains historical records independently of network, including all locally authorized accounts', async () => {
  const f = fixture(); await f.service.refresh(); await f.service.create(input());
  const old = f.saved(); old.push({ ...old[0], requestId: randomUUID(), owner: 2 });
  f.store.load = () => structuredClone(old);
  const s = new KeyService(f.options); const before = f.calls.length;
  assert.equal(s.adminRecords().total, 2); assert.equal(s.adminRecords().items[0].operator.name, '客户 A / 联系账号');
  assert.equal(f.calls.length, before);
});
test('old records have explicit unknown identity, names and events rather than invented present-day aliases', () => {
  const f = fixture([{ requestId: 'old', owner: 1, body: { name: 'old key', group_id: 7, quota: 5 }, state: 'reviewed' }]);
  const r = f.service.adminRecord('old'); assert.equal(r.operator.source, 'unrecorded'); assert.equal(r.group.customerName, null);
  assert.equal(r.group.originalName, null); assert.deepEqual(r.events, []); assert.equal(r.hasSecret, false);
});
test('status filter and bounded deterministic pagination include all rows', () => {
  const rows = Array.from({ length: 47 }, (_, i) => ({ requestId: String(i).padStart(3, '0'), owner: 1,
    body: { name: `key ${i}`, quota: i + 1 }, state: i % 2 ? 'failed' : 'success', at: '2026-10-28T00:00:00.000Z' }));
  const f = fixture(rows), a = f.service.adminRecords(), b = f.service.adminRecords({ page: 2 }), c = f.service.adminRecords({ page: 3 });
  assert.deepEqual([a.items.length, b.items.length, c.items.length], [20, 20, 7]);
  assert.equal(new Set([...a.items, ...b.items, ...c.items].map(r => r.requestId)).size, 47);
  assert.equal(a.items[0].requestId, '046'); assert.equal(f.service.adminRecords({ status: 'failed' }).total, 23);
  assert.equal(f.service.adminRecords({ page: 100 }).page, 3);
  assert.equal(f.service.adminRecords({ search: 'no-match' }).pages, 1);
});
test('malformed queries cannot cause unbounded pages or coercion', () => {
  const f = fixture();
  for (const v of [null, [], { page: 0 }, { page: 1.5 }, { pageSize: 101 }, { pageSize: 0 }, { search: {} }, { search: 'a'.repeat(201) }, { status: 'deleted' }]) {
    assert.throws(() => f.service.adminRecords(v), { code: 'INPUT' });
  }
});
test('definitive failure records safe code without response bodies or falsely reporting success', async () => {
  const f = fixture(); await f.service.refresh(); const e = new ToolError('HTTP', 'private-password-and-token'); e.definitive = true; f.postError(e);
  await assert.rejects(f.service.create(input()), { code: 'HTTP' });
  const r = f.service.adminRecords({ status: 'failed' }).items[0];
  assert.equal(r.errorCode, 'HTTP'); assert.equal(r.hasSecret, false); assert.equal(JSON.stringify(r).includes('private-password'), false);
});
test('timeout stays unknown through restart, and manual review is not labeled successful', async () => {
  const f = fixture(); await f.service.refresh(); f.postError(new Error('private timeout')); const i = input();
  await assert.rejects(f.service.create(i), { code: 'UNKNOWN' });
  assert.equal(f.service.adminRecords({ status: 'unknown' }).total, 1);
  await f.service.acknowledge(i.requestId, true);
  const r = f.service.adminRecord(i.requestId); assert.equal(r.state, 'reviewed'); assert.equal(r.hasSecret, false);
  assert.equal(r.events.at(-1).kind, 'manual-review');
});
test('read-only reconcile adds timeline and encrypted success receipt, never another POST', async () => {
  const f = fixture(); await f.service.refresh(); f.postError(new Error('timeout')); const i = input();
  await assert.rejects(f.service.create(i)); await f.service.reconcile(i.requestId);
  const r = f.service.adminRecord(i.requestId); assert.equal(r.state, 'success'); assert.equal(r.errorCode, null);
  assert.equal(r.events.at(-1).kind, 'reconcile'); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('show and copy audit are durable before disclosure, have no secret and survive reopen', async () => {
  const f = fixture(); await f.service.refresh(); const i = input(); await f.service.create(i);
  assert.equal(f.service.adminSecret(i.requestId), 'sk-history-fictional-secret');
  assert.equal(f.service.adminSecret(i.requestId, 'copy'), 'sk-history-fictional-secret');
  const reopened = new KeyService(f.options), r = reopened.adminRecord(i.requestId);
  assert.deepEqual(r.events.slice(-2).map(e => e.kind), ['admin-reveal', 'admin-copy']);
  assert.equal(JSON.stringify(f.saved()).includes('sk-history'), false);
});
test('failed audit save and busy state prevent secret disclosure and do not commit access events', async () => {
  const f = fixture(); await f.service.refresh(); const i = input(); await f.service.create(i); f.failSave(true);
  assert.throws(() => f.service.adminSecret(i.requestId));
  assert.equal(f.service.records[0].events.length, 2); assert.equal(f.saved()[0].events.length, 2);
  f.failSave(false); f.service.busy = true;
  assert.throws(() => f.service.adminSecret(i.requestId), { code: 'BUSY' });
  f.service.busy = false; assert.throws(() => f.service.adminSecret(i.requestId, 'delete'), { code: 'INPUT' });
});
test('unknown and reviewed operations cannot reveal a key or trigger network during inspection', async () => {
  const f = fixture([{ requestId: 'old', state: 'unknown', owner: 1, body: { name: 'old', quota: 5 } }]);
  assert.throws(() => f.service.adminSecret('old'), { code: 'INPUT' }); assert.equal(f.calls.length, 0);
});
test('crash-pending rows remain uncertain, and notification failure cannot rewrite durable success', async () => {
  const f = fixture([{ requestId: 'old', state: 'pending', owner: 1, body: { name: 'old', quota: 5 }, submission: 'possible' }]);
  assert.equal(f.service.adminRecord('old').state, 'unknown'); assert.equal(f.service.adminRecord('old').submission, 'possible');
  const g = fixture(); await g.service.refresh(); g.service.onRecordsChanged = () => { throw new Error('window closed'); };
  await g.service.create(input()); assert.equal(g.saved()[0].state, 'success');
});
