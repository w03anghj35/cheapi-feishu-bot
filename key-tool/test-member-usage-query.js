'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UserOwnership } = require('./user-ownership');
const { MemberUsageQuery } = require('./member-usage-query');
const { validateFormStructure } = require('./feishu-card-validation');

const GROUP = 'oc_group_12345678', OTHER_GROUP = 'oc_group_other1234';
const ACTOR = 'ou_actor_12345678', OTHER = 'ou_other_12345678', ADMIN = 'ou_admin_12345678';
const NOW = Date.parse('2026-11-07T09:00:00Z');
const day = '2026-11-07';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function waitForStats(f) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (f.calls.some(row => row.route.startsWith('/admin/usage/stats?'))) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('expected usage read was not started');
}
function fixture() {
  let groupId = GROUP, owner = 1, now = NOW, adminId = ADMIN, role = 'admin', users = [
    { id: 7, username: '本人A', email: 'a@example.invalid', role: 'user', status: 'active', balance: 0 },
    { id: 8, username: '本人B', email: 'b@example.invalid', role: 'user', status: 'active', balance: 0 },
    { id: 9, username: '其他人', email: 'other@example.invalid', role: 'user', status: 'active', balance: 0 }
  ];
  const calls = [], audits = [];
  let stats = async id => ({ total_actual_cost: id });
  const request = async (method, route) => {
    calls.push({ method, route });
    if (method !== 'GET') throw Error('unexpected mutation');
    if (route === '/auth/me') return { id: owner, role };
    if (route.startsWith('/admin/users?')) return { items: users, total: users.length };
    if (route.startsWith('/admin/usage/stats?')) return stats(Number(new URLSearchParams(route.split('?')[1]).get('user_id')));
    throw Error('unexpected route');
  };
  const ownership = new UserOwnership({ request,
    store: { load: () => [], save() {} },
    audit: { load() {}, list: () => audits, append: row => audits.push(row) },
    getOwner: () => owner, getGroupId: () => groupId, now: () => now });
  const snapshotStore = { state: () => ({ snapshots: {
    '2026-11-05': { final: true, rows: [{ name: '本人', users: [
      { id: 7, email: 'a@example.invalid', cost: 1 }, { id: 8, email: 'b@example.invalid', cost: 2 }] }] },
    '2026-11-06': { final: false, rows: [{ name: '本人', users: [
      { id: 7, email: 'a@example.invalid', cost: 500 }, { id: 8, email: 'b@example.invalid', cost: 500 }] },
      { name: '其他', users: [{ id: 9, email: 'other@example.invalid', cost: 99 }] }] }
  } }) };
  const service = new MemberUsageQuery({ ownership, request, snapshotStore, now: () => now, throttle: async () => {},
    getAdminScope: openId => openId === adminId ? { owner, groupId } : null });
  return { service, ownership, calls, audits, setStats: fn => { stats = fn; },
    setGroup: value => { groupId = value; }, setOwner: value => { owner = value; }, setNow: value => { now = value; },
    setUsers: value => { users = value; }, setAdmin: value => { adminId = value; }, setRole: value => { role = value; } };
}
async function bind(f) {
  await f.ownership.assignName({ name: '本人', userIds: [7, 8] });
  await f.ownership.assignName({ name: '其他', userIds: [9] });
  f.ownership.claim(ACTOR, '飞书成员');
  await f.ownership.link({ identity: f.ownership.list()[0].identity, profileName: '本人' });
  f.calls.length = 0;
}
test('private usage reads only current bound account IDs and marks missing historical day, never another profile', async () => {
  const f = fixture(); await bind(f);
  const result = await f.service.query(ACTOR);
  assert.equal(result.pending, undefined);
  assert.deepEqual(f.calls.filter(row => row.route.startsWith('/admin/usage/stats?')).map(row =>
    Number(new URLSearchParams(row.route.split('?')[1]).get('user_id'))).sort(), [7, 8]);
  const content = JSON.stringify(result.card);
  assert.equal(content.includes('other@example.invalid'), false);
  assert.equal(content.includes('11-07 *'), true);
  assert.equal(content.includes('11-05'), true);
  assert.equal(content.includes('11-06'), true);
  assert.equal(content.includes('—'), true);
  assert.equal(content.includes('$1.0000'), true);
  assert.equal(content.includes('$500.0000'), false, 'unfinished yesterday must not appear as a final total');
  assert.equal(content.includes('本次仅私聊'), true);
  assert.equal(result.card.config.enable_forward, false);
  assert.equal(f.audits.at(-1).kind, 'usage');
  assert.equal(f.audits.at(-1).status, 'found');
});
test('unbound identity is audited and receives no usage data', async () => {
  const f = fixture(); await bind(f);
  assert.deepEqual(await f.service.query(OTHER), { pending: true });
  assert.equal(f.calls.filter(row => row.route.startsWith('/admin/usage/stats?')).length, 0);
  assert.equal(f.audits.at(-1).kind, 'usage');
  assert.equal(f.audits.at(-1).status, 'not-found');
});
test('revocation, group change or audit failure withhold private usage', async () => {
  const f = fixture(); await bind(f);
  const gate = deferred(); f.setStats(async () => gate.promise);
  const read = f.service.query(ACTOR);
  await waitForStats(f);
  f.setGroup(OTHER_GROUP);
  gate.resolve({ total_actual_cost: 1 });
  await assert.rejects(read);
  assert.equal(f.audits.at(-1).status, 'error');
  f.setGroup(GROUP);
  f.ownership.audit.append = () => { throw Error('disk'); };
  await assert.rejects(f.service.query(ACTOR), { code: 'STORAGE' });
  assert.equal(f.ownership.storageFault, true);
});
test('incomplete stats fail as a whole and allow a later fresh read, without creating partial card', async () => {
  const f = fixture(); await bind(f);
  f.setStats(async id => id === 7 ? { total_actual_cost: 7 } : { total_cost: 8 });
  await assert.rejects(f.service.query(ACTOR), /缺少/);
  assert.equal(f.audits.at(-1).status, 'error');
  f.setStats(async id => ({ total_actual_cost: id }));
  assert.ok((await f.service.query(ACTOR)).card);
});
test('crossing Beijing midnight during a slow read withholds the stale today card', async () => {
  const f = fixture(); await bind(f);
  f.setNow(Date.parse('2026-11-07T15:59:30Z'));
  const gate = deferred(); f.setStats(async () => gate.promise);
  const read = f.service.query(ACTOR);
  await waitForStats(f);
  f.setNow(Date.parse('2026-11-07T16:00:01Z'));
  gate.resolve({ total_actual_cost: 1 });
  await assert.rejects(read, /日期已变化/);
  assert.equal(f.audits.at(-1).status, 'error');
});
test('verified admin queries all profiles without a personal binding, with distinct audit and no ledger writes', async () => {
  const f = fixture(); await bind(f);
  assert.equal(f.ownership.usageBinding(ADMIN), null);
  const result = await f.service.queryAll(ADMIN);
  assert.equal(result.cards.length, 2);
  assert.equal(f.service.sameAdminBinding(ADMIN, result.binding), true);
  assert.deepEqual(f.calls.filter(row => row.route.startsWith('/admin/usage/stats?')).map(row =>
    Number(new URLSearchParams(row.route.split('?')[1]).get('user_id'))).sort(), [7,8,9]);
  assert.ok(JSON.stringify(result.cards[0].card).includes('a@example.invalid'));
  assert.equal(JSON.stringify(result.cards[0].card).includes('other@example.invalid'), false);
  assert.ok(JSON.stringify(result.cards[1].card).includes('other@example.invalid'));
  assert.equal(JSON.stringify(result.cards).includes('$500.0000'), false);
  assert.equal(f.audits.at(-1).kind, 'usage-all');
  assert.equal(f.audits.at(-1).count, 3);
  assert.ok(result.cards.every(row => row.card.config.enable_forward === false));
  for (const row of result.cards) assert.equal(validateFormStructure(row.card), row.card);
  assert.ok(f.calls.every(row => row.method === 'GET'));
});
test('ordinary/unbound member cannot invoke all-profile query, regardless of personal binding', async () => {
  const f = fixture(); await bind(f);
  for (const actor of [ACTOR,OTHER]) await assert.rejects(f.service.queryAll(actor), /管理员/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.audits.length, 0);
  f.setRole('user');
  await assert.rejects(f.service.queryAll(ADMIN));
  assert.equal(f.calls.some(row => row.route.startsWith('/admin/usage/stats?')), false);
});
test('all-profile query rejects administrator revocation, scope/ownership changes and midnight before disclosure', async () => {
  for (const mode of ['admin','group','ownership','midnight','guard']) {
    const f = fixture(); await bind(f);
    let allowed = true;
    const gate = deferred(); f.setStats(async () => gate.promise);
    const read = f.service.queryAll(ADMIN, () => allowed);
    await waitForStats(f);
    if (mode === 'admin') f.setAdmin(OTHER);
    else if (mode === 'group') f.setGroup(OTHER_GROUP);
    else if (mode === 'ownership') f.ownership.rows.find(row => row.state === 'profile').userIds = [7];
    else if (mode === 'midnight') f.setNow(Date.parse('2026-11-07T16:00:01Z'));
    else allowed = false;
    gate.resolve({ total_actual_cost: 1 });
    await assert.rejects(read);
    assert.equal(f.service.busy, false);
    assert.equal(f.audits.at(-1).kind, 'usage-all');
    assert.equal(f.audits.at(-1).status, 'error');
  }
});
test('admin all-profile query returns no partial cards on read/audit failure and rejects overlap', async () => {
  const f = fixture(); await bind(f);
  const gate = deferred(); f.setStats(async () => gate.promise);
  const read = f.service.queryAll(ADMIN);
  await waitForStats(f);
  await assert.rejects(f.service.query(ACTOR), /已有/);
  await assert.rejects(f.service.queryAll(ADMIN), /已有/);
  gate.resolve({ total_cost: 1 });
  await assert.rejects(read, /缺少/);
  f.setStats(async id => ({ total_actual_cost: id }));
  f.ownership.audit.append = () => { throw Error('synthetic disk failure'); };
  await assert.rejects(f.service.queryAll(ADMIN), { code: 'STORAGE' });
});
test('an admin all-profile result is invalid after ownership changes before a later card', async () => {
  const f = fixture(); await bind(f);
  const result = await f.service.queryAll(ADMIN);
  f.ownership.rows.find(row => row.state === 'profile').userIds = [7];
  assert.equal(f.service.sameAdminBinding(ADMIN, result.binding), false);
});
test('admin all-profile query with no accounts is audited and does not invent amounts', async () => {
  const f = fixture();
  const result = await f.service.queryAll(ADMIN);
  assert.deepEqual(result.cards, []);
  assert.equal(f.audits.at(-1).status, 'not-found');
  assert.equal(f.calls.some(row => row.route.startsWith('/admin/usage/stats?')), false);
});
test('shared platform account is read once and remains on each assigned owner card', async () => {
  const f=fixture();await bind(f);
  await f.ownership.assignName({name:'共享归属',userIds:[7]});f.calls.length=0;
  const result=await f.service.queryAll(ADMIN);
  assert.equal(result.cards.length,3);
  assert.equal(f.calls.filter(row=>row.route.startsWith('/admin/usage/stats?')).length,3);
  assert.equal(f.audits.at(-1).count,3);
});
test('all-profile lookup denies missing verified admin callback and excessive profiles before stats', async () => {
  const f=fixture();await bind(f);
  f.service.getAdminScope=()=>null;
  await assert.rejects(f.service.queryAll(ADMIN),/管理员/);
  f.service.getAdminScope=()=>({owner:1,groupId:GROUP});
  f.ownership.profiles=()=>Array.from({length:31},(_,i)=>({name:'虚构'+i,userIds:[7]}));
  f.ownership.profilesAt=()=>f.ownership.profiles();
  await assert.rejects(f.service.queryAll(ADMIN),/上限/);
  assert.equal(f.calls.some(row=>row.route.startsWith('/admin/usage/stats?')),false);
});
