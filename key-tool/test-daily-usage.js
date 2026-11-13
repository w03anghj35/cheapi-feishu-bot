'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DailyUsage, dayKey, beijingDay, statsRoute, finiteCost } = require('./daily-usage');

const scope = { owner: 1, groupId: 'oc_fixture_12345678' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function waitFor(check) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('异步请求未进入预期阶段。');
}
function fixture(now = Date.parse('2026-11-05T04:00:00Z')) {
  let profiles = [{ name: '陈梦', userIds: [9, 2] }, { name: '李胜', userIds: [3] }];
  let owner = { ...scope }, response = { total_actual_cost: 1.25, total_cost: 2.5 };
  const calls = [];
  const ownership = { admin: async () => ({ ...owner }), profiles: () => structuredClone(profiles),
    users: async () => [2, 3, 9].map(id => ({ id, role: 'user', username: `U${id}`,
      email: `u${id}@example.invalid` })) };
  const service = new DailyUsage({ ownership, now: () => now,
    request: async (method, route) => { calls.push({ method, route }); return typeof response === 'function' ? response() : response; } });
  return { service, calls, setProfiles: next => { profiles = next; },
    setOwner: next => { owner = next; }, setResponse: next => { response = next; } };
}
test('Beijing calendar is strict and a day is queried by identical start/end date', () => {
  assert.equal(beijingDay(Date.parse('2026-11-22T15:59:59Z')), '2026-11-22');
  assert.equal(beijingDay(Date.parse('2026-11-22T16:00:00Z')), '2026-11-23');
  assert.equal(statsRoute(9, '2026-11-23'), '/admin/usage/stats?user_id=9&start_date=2026-11-23&end_date=2026-11-23');
  for (const invalid of ['2026-02-30', '2026-11-5', '2026-13-01', '2026-11-23&user_id=1'])
    assert.throws(() => dayKey(invalid));
  assert.throws(() => statsRoute(-1, '2026-11-23'));
});
test('read-only daily stats query covers each distinct assigned user once', async () => {
  const f = fixture();
  const result = await f.service.read('2026-11-05');
  assert.equal(result.day, '2026-11-05');
  assert.equal(result.final, false);
  assert.deepEqual(result.rows.map(row => row.users.map(user => user.id)), [[9, 2], [3]]);
  assert.deepEqual(f.calls.map(call => call.route), [9, 2, 3].map(id => statsRoute(id, '2026-11-05')));
  assert.ok(f.calls.every(call => call.method === 'GET'));
  assert.equal((await f.service.read('2026-11-04')).final, true);
});
test('single-account historical read queries only the selected assigned user and rechecks scope', async () => {
  const f = fixture();
  const result = await f.service.readAccount('2026-11-04', '陈梦', 9);
  assert.deepEqual(result.user, { id: 9, email: 'u9@example.invalid', cost: 1.25 });
  assert.deepEqual(f.calls, [{ method: 'GET', route: statsRoute(9, '2026-11-04') }]);
  await assert.rejects(f.service.readAccount('2026-11-05', '陈梦', 9), /已结束/);
  await assert.rejects(f.service.readAccount('2026-11-04', '陈梦', 3), /不属于/);
  f.setResponse(() => { f.setProfiles([{ name: '陈梦', userIds: [2] }]); return { total_actual_cost: 4 }; });
  await assert.rejects(f.service.readAccount('2026-11-04', '陈梦', 9), /变化/);
  assert.equal(f.service.busy, false);
});
test('at most two reads overlap and out-of-order amounts retain their user mapping', async () => {
  const f = fixture();
  f.setProfiles([{ name: '陈梦', userIds: [9, 2] }, { name: '李胜', userIds: [2, 3] }]);
  const pending = new Map();
  const started = [];
  let active = 0, peak = 0;
  f.service.request = async (method, route) => {
    assert.equal(method, 'GET');
    const id = Number(new URLSearchParams(route.split('?')[1]).get('user_id'));
    const result = deferred();
    pending.set(id, result);
    started.push(id);
    peak = Math.max(peak, ++active);
    try { return await result.promise; } finally { active--; }
  };
  const read = f.service.read('2026-11-05');
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, [9, 2]);
  assert.equal(peak, 2);
  pending.get(2).resolve({ total_actual_cost: 2 });
  await waitFor(() => started.length === 3);
  assert.deepEqual(started, [9, 2, 3]);
  pending.get(3).resolve({ total_actual_cost: 3 });
  pending.get(9).resolve({ total_actual_cost: 9 });
  const result = await read;
  assert.equal(peak, 2);
  assert.deepEqual(result.rows.map(row => row.users.map(user => user.cost)), [[9, 2], [2, 3]]);
  assert.equal(f.service.busy, false);
});
test('failed read drains in-flight work before releasing busy lock or assigning another user', async () => {
  const f = fixture();
  const pending = new Map(), started = [];
  f.service.request = async (_method, route) => {
    const id = Number(new URLSearchParams(route.split('?')[1]).get('user_id'));
    const result = deferred(); pending.set(id, result); started.push(id);
    return result.promise;
  };
  const rejection = assert.rejects(f.service.read('2026-11-05'), /平台暂不可用/);
  await waitFor(() => started.length === 2);
  pending.get(9).reject(new Error('平台暂不可用'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [9, 2]);
  assert.equal(f.service.busy, true);
  await assert.rejects(f.service.read('2026-11-05'), /已有每日用量读取任务/);
  pending.get(2).resolve({ total_actual_cost: 2 });
  await rejection;
  assert.deepEqual(started, [9, 2]);
  assert.equal(f.service.busy, false);
});
test('request starts are spaced even while another read remains in flight', async () => {
  const f = fixture();
  const pending = new Map(), started = [], gates = [];
  f.service.throttle = () => { const gate = deferred(); gates.push(gate); return gate.promise; };
  f.service.request = async (_method, route) => {
    const id = Number(new URLSearchParams(route.split('?')[1]).get('user_id'));
    const result = deferred(); pending.set(id, result); started.push(id);
    return result.promise;
  };
  const read = f.service.read('2026-11-05');
  await waitFor(() => gates.length === 1);
  assert.deepEqual(started, [9]);
  gates[0].resolve();
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, [9, 2]);
  pending.get(9).resolve({ total_actual_cost: 9 });
  await waitFor(() => gates.length === 2);
  assert.deepEqual(started, [9, 2]);
  gates[1].resolve();
  await waitFor(() => started.length === 3);
  pending.get(2).resolve({ total_actual_cost: 2 });
  pending.get(3).resolve({ total_actual_cost: 3 });
  await read;
  assert.deepEqual(started, [9, 2, 3]);
});
test('elapsed total budget rejects after in-flight reads settle without launching another request', async () => {
  let clock = Date.parse('2026-11-05T04:00:00Z');
  const f = fixture(clock), pending = new Map(), started = [];
  f.service.now = () => clock;
  f.service.maxDurationMs = 500;
  f.service.request = async (_method, route) => {
    const id = Number(new URLSearchParams(route.split('?')[1]).get('user_id'));
    const result = deferred(); pending.set(id, result); started.push(id);
    return result.promise;
  };
  const rejection = assert.rejects(f.service.read('2026-11-05'), /时间上限/);
  await waitFor(() => started.length === 2);
  clock += 500;
  pending.get(9).resolve({ total_actual_cost: 9 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [9, 2]);
  assert.equal(f.service.busy, true);
  pending.get(2).resolve({ total_actual_cost: 2 });
  await rejection;
  assert.equal(f.service.busy, false);
  assert.deepEqual(started, [9, 2]);
});
test('missing statistics, future date or changed ownership fail without partial result', async () => {
  const f = fixture();
  await assert.rejects(f.service.read('2026-11-06'));
  f.setResponse({ total_cost: 3 });
  await assert.rejects(f.service.read('2026-11-05'), /缺少/);
  f.setResponse({ total_actual_cost: 3 });
  f.setProfiles([{ name: '陈梦', userIds: [999] }]);
  await assert.rejects(f.service.read('2026-11-05'), /不在当前平台列表/);
  f.setProfiles([{ name: '陈梦', userIds: [2] }]);
  f.setResponse(() => { f.setOwner({ owner: 2, groupId: scope.groupId });
    return { total_actual_cost: 3 }; });
  await assert.rejects(f.service.read('2026-11-05'), /变化/);
});
test('stats amounts must be finite nonnegative and not silently default to zero', () => {
  assert.equal(finiteCost({ total_actual_cost: 0 }), 0);
  for (const value of [undefined, null, '0', -1, Infinity, NaN])
    assert.throws(() => finiteCost({ total_actual_cost: value }));
});
test('time budget stops long scans without publishing a partial table', async () => {
  let clock = Date.parse('2026-11-05T04:00:00Z');
  const f = fixture(clock);
  f.service.now = () => clock;
  f.service.maxDurationMs = 500;
  f.service.throttle = async () => { clock += 300; };
  await assert.rejects(f.service.read('2026-11-05'), /时间上限/);
  assert.equal(f.service.busy, false);
  assert.equal(f.calls.length, 2);
});
