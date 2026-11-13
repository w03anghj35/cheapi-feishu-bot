'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BulkGroupRatesService, applyDelta, thousandths } = require('./bulk-group-rates');
const { makeBulkRateStore } = require('./bulk-rate-store');

const group = (id, name, rate, exclusive = false) => ({ id, name, rate_multiplier: rate,
  is_exclusive: exclusive, subscription_type: 'standard', status: 'active' });
const config = (id, email, allowed, rates = {}, status = 'active') => ({ id, email,
  username: `客户${id}`, role: 'user', status, allowed_groups: allowed,
  restrict_public_groups: true, group_rates: rates });
function fixture(options = {}) {
  let owner = 1, role = 'admin', now = Date.parse('2026-11-11T02:00:00Z');
  let groups = [group(7, '示例甲', 0.5, true), group(9, '示例乙', 2), group(11, '未命名但有效', 3)];
  let users = [config(101, 'one@example.invalid', [7,9], { 7: 1.8, 9: 1.2 }),
    config(102, 'two@example.invalid', [9], { 9: 1.6 }),
    config(103, 'three@example.invalid', [7], {})];
  let rows = [], writes = [], failPut = false, mismatch = false, failStore = false,
    otherBlocked = false;
  const calls = [], progress = [];
  const request = async (method, route, body, context) => {
    calls.push({ method, route, body: body && structuredClone(body) });
    if (route === '/auth/me') return { id: owner, role };
    const groupPage = /^\/admin\/groups\?page=(\d+)&page_size=100$/.exec(route);
    if (groupPage) return { items: Number(groupPage[1]) === 1 ? structuredClone(groups) : [], total: groups.length };
    const userPage = /^\/admin\/users\?page=(\d+)&page_size=100$/.exec(route);
    if (userPage) return { items: Number(userPage[1]) === 1 ? structuredClone(users) : [], total: users.length };
    const detail = /^\/admin\/users\/(\d+)$/.exec(route);
    if (detail && method === 'GET') return structuredClone(users.find(user => user.id === Number(detail[1])));
    if (detail && method === 'PUT') {
      assert.equal(context.owner, owner); assert.equal(context.guard(), true);
      assert.equal(context.groupSettings, true); assert.equal(context.bulkRates, true);
      assert.equal(rows.at(-1)?.state, 'pending', 'attempt must persist before PUT');
      writes.push({ id: Number(detail[1]), body: structuredClone(body) });
      if (failPut) throw Error('fixture uncertain PUT');
      if (!mismatch) users = users.map(user => user.id === Number(detail[1]) ? { ...user,
        allowed_groups: body.allowed_groups, restrict_public_groups: body.restrict_public_groups,
        group_rates: body.group_rates } : user);
      return { ok: true };
    }
    throw Error(`unexpected ${method} ${route}`);
  };
  const store = options.store || { load: () => structuredClone(rows),
    save: next => { if (failStore) throw Error('fixture disk full'); rows = structuredClone(next); } };
  const service = new BulkGroupRatesService({ request, store, getOwner: () => owner,
    otherBlocked: () => otherBlocked, onProgress: value => progress.push(value), now: () => now });
  return { service, calls, progress, writes, setOwner: value => { owner = value; },
    setRole: value => { role = value; }, setNow: value => { now = value; },
    setGroups: value => { groups = value; }, setUsers: value => { users = value; },
    getUsers: () => structuredClone(users), getRows: () => structuredClone(rows),
    setFailPut: value => { failPut = value; }, setMismatch: value => { mismatch = value; },
    setFailStore: value => { failStore = value; }, setOtherBlocked: value => { otherBlocked = value; } };
}

test('snapshot is read-only, shows active groups and only explicitly allowed user rates', async () => {
  const f = fixture();
  const data = await f.service.snapshot();
  assert.deepEqual(data.groups.map(row => row.id), [7,9,11]);
  assert.deepEqual(data.users[0].groups, [
    { groupId: 7, allowed: true, rate: 1.8, customRate: 1.8 },
    { groupId: 9, allowed: true, rate: 1.2, customRate: 1.2 } ]);
  assert.deepEqual(data.users[1].groups.map(row => row.groupId), [9]);
  assert.deepEqual(data.users[2].groups, [{ groupId: 7, allowed: true, rate: 0.5, customRate: null }]);
  assert.equal(data.blocked, false);
  assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  assert.equal(f.writes.length, 0); assert.deepEqual(f.getRows(), []);
});

test('failed refresh invalidates the old preview so stale prices cannot be committed', async () => {
  const f = fixture(); await f.service.snapshot();
  const preview = f.service.preview({ userIds:[101], groupIds:[7], direction:'add', amount:'0.2' });
  f.setRole('user');
  await assert.rejects(f.service.snapshot(), { code:'DENIED' });
  f.setRole('admin');
  await assert.rejects(f.service.commit({ previewId:preview.previewId }), { code:'CONFLICT' });
  assert.equal(f.writes.length, 0);
});

test('preview uses decimal arithmetic and skips groups the user does not own', async () => {
  const f = fixture(); await f.service.snapshot();
  const result = f.service.preview({ userIds: [101,102,103], groupIds: [7,9,11], direction: 'add', amount: '0.2' });
  assert.ok(result.previewId);
  assert.deepEqual(result.changes, [
    { userId: 101, groupId: 7, before: '1.8', after: '2.0' },
    { userId: 101, groupId: 9, before: '1.2', after: '1.4' },
    { userId: 102, groupId: 9, before: '1.6', after: '1.8' },
    { userId: 103, groupId: 7, before: '0.5', after: '0.7' }
  ]);
  assert.equal(result.skipped.length, 5);
  assert.ok(result.skipped.every(row => row.reason === 'not-allowed'));
  assert.equal(f.writes.length, 0);
  assert.equal(applyDelta(1.8, thousandths('0.2', false), 'add').after, '2.0');
});
test('preview rejects oversized user-group matrix before building a huge UI list', async () => {
  const f = fixture(); await f.service.snapshot();
  f.service.snapshotData.users = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, groups: [] }));
  f.service.snapshotData.groups = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, rate: 1 }));
  assert.throws(() => f.service.preview({
    userIds: f.service.snapshotData.users.map(row => row.id),
    groupIds: f.service.snapshotData.groups.map(row => row.id),
    direction: 'add', amount: '0.2'
  }), { code: 'LIMIT' });
  assert.equal(f.writes.length, 0);
});

test('commit changes only selected group_rates, never grants a group or changes other fields', async () => {
  const f = fixture(); await f.service.snapshot();
  const preview = f.service.preview({ userIds: [101,102,103], groupIds: [7], direction: 'add', amount: '0.2' });
  const outcome = await f.service.commit({ previewId: preview.previewId });
  assert.equal(outcome.updated, 2); assert.equal(outcome.skipped, 1);
  assert.equal(outcome.unknown, 0); assert.equal(outcome.stopped, false);
  assert.deepEqual(f.writes.map(row => row.id), [101,103]);
  assert.deepEqual(f.writes[0].body, { allowed_groups: [7,9], restrict_public_groups: true,
    group_rates: { 7: 2, 9: 1.2 } });
  assert.deepEqual(f.writes[1].body, { allowed_groups: [7], restrict_public_groups: true,
    group_rates: { 7: 0.7 } });
  assert.equal(f.getRows().every(row => row.state === 'success'), true);
  await assert.rejects(f.service.commit({ previewId: preview.previewId }), { code: 'CONFLICT' });
});

test('subtract never writes an invalid or nonpositive rate', async () => {
  const f = fixture(); await f.service.snapshot();
  const preview = f.service.preview({ userIds: [103], groupIds: [7], direction: 'subtract', amount: '0.5' });
  assert.deepEqual(preview.changes, []);
  assert.deepEqual(preview.skipped, [{ userId: 103, groupId: 7, reason: 'out-of-range' }]);
  assert.equal(preview.previewId, null);
  assert.equal(f.writes.length, 0);
  for (const amount of ['0','-0.2','0.0001','1e3','Infinity'])
    assert.throws(() => f.service.preview({ userIds:[101], groupIds:[7], direction:'add', amount }), { code:'INPUT' });
});

test('changed user or group before commit blocks stale writes', async () => {
  for (const mode of ['user', 'group', 'owner', 'role']) {
    const f = fixture(); await f.service.snapshot();
    const preview = f.service.preview({ userIds: [101], groupIds: [7], direction: 'add', amount: '0.2' });
    if (mode === 'user') f.setUsers(f.getUsers().map(user => user.id === 101 ?
      { ...user, group_rates: { ...user.group_rates, 7: 2 } } : user));
    if (mode === 'group') f.setGroups([group(7, '示例甲', 0.8, true), group(9, '示例乙', 2), group(11, '未命名但有效', 3)]);
    if (mode === 'owner') f.setOwner(2);
    if (mode === 'role') f.setRole('user');
    if (mode === 'user') {
      const result = await f.service.commit({ previewId: preview.previewId });
      assert.equal(result.failed, 1); assert.equal(result.stopped, true);
    } else await assert.rejects(f.service.commit({ previewId: preview.previewId }));
    assert.equal(f.writes.length, 0);
  }
});

test('storage failure before attempted PUT sends nothing', async () => {
  const f = fixture(); await f.service.snapshot();
  const preview = f.service.preview({ userIds: [101], groupIds: [7], direction: 'add', amount: '0.2' });
  f.setFailStore(true);
  const result = await f.service.commit({ previewId: preview.previewId });
  assert.equal(result.updated, 0); assert.equal(result.failed, 1); assert.equal(result.stopped, true);
  assert.equal(f.writes.length, 0); assert.equal(f.service.storageFault, true);
});

test('uncertain PUT or readback stops later users and never retries automatically', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture(); await f.service.snapshot();
    const preview = f.service.preview({ userIds: [101,103], groupIds: [7], direction: 'add', amount: '0.2' });
    if (mismatch) f.setMismatch(true); else f.setFailPut(true);
    const result = await f.service.commit({ previewId: preview.previewId });
    assert.equal(result.updated, 0); assert.equal(result.unknown, 1); assert.equal(result.stopped, true);
    assert.deepEqual(f.writes.map(row => row.id), [101]);
    assert.equal(f.getRows()[0].state, 'unknown');
    await assert.rejects(f.service.commit({ previewId: preview.previewId }), { code: 'UNKNOWN' });
    assert.equal(f.writes.length, 1);
  }
});

test('other group-settings in flight or unknown blocks this batch', async () => {
  const f = fixture(); await f.service.snapshot();
  const preview = f.service.preview({ userIds: [101], groupIds: [7], direction: 'add', amount: '0.2' });
  f.setOtherBlocked(true);
  await assert.rejects(f.service.commit({ previewId: preview.previewId }), { code: 'UNKNOWN' });
  assert.equal(f.writes.length, 0);
});

test('explicitly unlisted public group is skipped even when public access is unrestricted', async () => {
  const f = fixture();
  f.setUsers(f.getUsers().map(user => user.id === 101 ? { ...user,
    allowed_groups: [7], restrict_public_groups: false, group_rates: { 7: 1.8, 9: 1.2 } } : user));
  await f.service.snapshot();
  const preview = f.service.preview({ userIds: [101], groupIds: [9], direction: 'add', amount: '0.2' });
  assert.equal(preview.previewId, null);
  assert.deepEqual(preview.skipped, [{ userId: 101, groupId: 9, reason: 'not-allowed' }]);
  assert.equal(f.writes.length, 0);
});

test('readback review can close an unknown record but cannot guess a mismatch or manually unlock', async () => {
  const f = fixture(); await f.service.snapshot();
  const preview = f.service.preview({ userIds: [101], groupIds: [7], direction: 'add', amount: '0.2' });
  f.setFailPut(true);
  const result = await f.service.commit({ previewId: preview.previewId });
  const requestId = result.results[0].requestId;
  assert.equal(f.service.blocked(), true);
  assert.deepEqual(Object.keys(f.service.history()[0]).sort(), ['at','batchId','requestId','state','targetId']);
  await assert.rejects(f.service.review(requestId), { code: 'UNKNOWN' });
  assert.equal(f.service.blocked(), true);
  f.setUsers(f.getUsers().map(user => user.id === 101 ? { ...user,
    group_rates: { ...user.group_rates, 7: 2 } } : user));
  const history = await f.service.review(requestId);
  assert.equal(history[0].state, 'success');
  assert.equal(f.service.blocked(), false);
  assert.equal(f.writes.length, 1);
});

test('encrypted append journal reopens and rejects damage without exposing settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-rates-test-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const safe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
    encryptString: value => Buffer.from('sealed:' + value),
    decryptString: value => { const text = value.toString(); if (!text.startsWith('sealed:')) throw Error('bad cipher');
      return text.slice(7); } };
  const store = makeBulkRateStore(dir, safe);
  assert.deepEqual(store.load(), []);
  const row = { kind:'bulk-group-rates', batchId:'11111111-1111-4111-8111-111111111111',
    requestId:'22222222-2222-4222-8222-222222222222', owner:1, targetId:101, state:'pending',
    at:'2026-11-11T02:00:00Z', changes:[{groupId:7,before:'1.8',after:'2.0'}],
    before:{allowed_groups:[7],restrict_public_groups:true,group_rates:{7:1.8}},
    expected:{allowed_groups:[7],restrict_public_groups:true,group_rates:{7:2}} };
  store.save([row]);
  const file = path.join(dir, 'bulk-group-rates.journal');
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('allowed_groups') || raw.includes('group_rates'), false);
  const reopened = makeBulkRateStore(dir, safe);
  assert.deepEqual(reopened.load(), [row]);
  const resumed = new BulkGroupRatesService({ store: makeBulkRateStore(dir, safe),
    request: async () => { throw Error('not called during constructor'); }, getOwner: () => 1 });
  assert.equal(resumed.records[0].state, 'unknown');
  assert.equal(resumed.blocked(), true);
  fs.appendFileSync(file, 'broken');
  assert.throws(() => makeBulkRateStore(dir, safe).load(), /无法安全读写/);
  assert.throws(() => makeBulkRateStore(path.join(dir,'plaintext'), {
    ...safe, getSelectedStorageBackend: () => 'basic_text' }).load(), /无法安全读写/);
});
