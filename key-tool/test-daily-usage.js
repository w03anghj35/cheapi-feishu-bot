'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DailyUsage, dayKey, beijingDay, statsRoute, finiteCost } = require('./daily-usage');

const scope = { owner: 1, groupId: 'oc_fixture_12345678' };
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
