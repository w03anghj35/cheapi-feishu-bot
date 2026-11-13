'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GroupUsage, dates, usageRoute, scaledCost } = require('./group-usage');

const NOW = Date.parse('2026-11-11T04:00:00Z');
const USERS = [
  { id: 11, email: 'one@example.invalid', role: 'user' },
  { id: 12, email: 'two@example.invalid', role: 'user' }
];
const groups = [ { id: 3, name: '分组三' }, { id: 4, name: '分组四' } ];
const usage = (id, userId, groupId, value, at) => ({ id, user_id: userId, group_id: groupId,
  group: groupId === null ? null : groups.find(group => group.id === groupId) || { id: groupId, name: '旧分组' },
  actual_cost: value, created_at: at });
function fixture({ logs = [], users = USERS, access = { 11: [3, 4], 12: [4] },
  profiles = [{ name: '甲', userIds: [11, 12] }], byDay = null } = {}) {
  let owner = 7, groupId = 'oc_fixture_12345678';
  const calls = [];
  const ownership = {
    admin: async () => ({ owner, groupId }),
    profiles: () => structuredClone(profiles),
    datedProfiles: () => structuredClone(profiles),
    profilesAt: day => structuredClone(byDay?.[day] || profiles),
    users: async () => structuredClone(users)
  };
  const request = async (method, route) => {
    calls.push({ method, route });
    assert.equal(method, 'GET');
    const groupPage = /^\/admin\/groups\?page=(\d+)&page_size=100$/.exec(route);
    if (groupPage) {
      const page = Number(groupPage[1]);
      return { total: groups.length, items: structuredClone(groups.slice((page - 1) * 100, page * 100)) };
    }
    const userDetail = /^\/admin\/users\/([1-9]\d*)$/.exec(route);
    if (userDetail) {
      const userId = Number(userDetail[1]);
      return { id: userId, allowed_groups: Object.hasOwn(access, userId) ? access[userId] : [], restrict_public_groups: true };
    }
    const usagePage = /^\/admin\/usage\?user_id=([1-9]\d*)&page=(\d+)&page_size=100&start_date=(\d{4}-\d{2}-\d{2})&end_date=(\d{4}-\d{2}-\d{2})&timezone=Asia%2FShanghai&sort_by=created_at&sort_order=desc&exact_total=true$/.exec(route);
    if (usagePage) {
      const [, userId, page, start, end] = usagePage;
      const selected = logs.filter(row => row.user_id === Number(userId) &&
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
          .format(new Date(row.created_at)) >= start &&
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
          .format(new Date(row.created_at)) <= end);
      return { total: selected.length, items: structuredClone(selected.slice((Number(page) - 1) * 100, Number(page) * 100)) };
    }
    throw Error('unexpected route');
  };
  const query = new GroupUsage({ request, ownership, now: () => NOW });
  return { query, calls, setOwner: value => { owner = value; }, setGroup: value => { groupId = value; } };
}

test('route and date limits are fixed and reject unknown ranges', () => {
  assert.match(usageRoute(11, 1, '2026-11-09', '2026-11-11'), /timezone=Asia%2FShanghai/);
  assert.equal(dates('2026-11-09', '2026-11-15').length, 7);
  assert.equal(dates('2026-11-01', '2026-12-01').length, 31);
  assert.throws(() => dates('2026-11-01', '2026-12-02'));
  assert.throws(() => dates('2026-11-12', '2026-11-11'));
  assert.throws(() => usageRoute(0, 1, '2026-11-09', '2026-11-11'));
  assert.throws(() => scaledCost(-1));
});

test('actual cost is grouped by Beijing day, user ID and historical platform group ID', async () => {
  const f = fixture({ logs: [
    usage(1, 11, 3, 0.1, '2026-11-10T23:50:00+08:00'),
    usage(2, 11, 3, 0.2, '2026-11-10T16:10:00Z'),
    usage(3, 11, 4, 1.00000001, '2026-11-10T15:00:00+08:00'),
    usage(4, 12, null, 2, '2026-11-10T08:00:00+08:00')
  ] });
  const data = await f.query.query({ start: '2026-11-10', end: '2026-11-11', name: '甲' });
  assert.equal(data.complete, true);
  assert.equal(data.records, 4);
  assert.deepEqual(data.groups.map(group => String(group.id)), ['3', '4', 'ungrouped']);
  const alice = data.rows.find(row => row.id === 11);
  assert.deepEqual(alice.allowedGroups.map(group => group.id), [3, 4]);
  assert.deepEqual(alice.values, [ { '3': '0.1', '4': '1.00000001' }, { '3': '0.2', '4': '0' } ]);
  const bob = data.rows.find(row => row.id === 12);
  assert.deepEqual(bob.values, [ { '4': '0', ungrouped: '2' }, { '4': '0', ungrouped: '0' } ]);
  assert.equal(f.calls.some(call => call.method !== 'GET'), false);
});

test('complete no-log days show zero while non-membership and future days remain blank', async () => {
  const byDay = {
    '2026-11-10': [{ name: '甲', userIds: [11] }],
    '2026-11-11': [{ name: '甲', userIds: [12] }]
  };
  const f = fixture({ logs: [], byDay });
  const data = await f.query.query({ start: '2026-11-10', end: '2026-11-12', name: '甲' });
  assert.deepEqual(data.days.map(day => day.phase), ['final', 'ongoing', 'future']);
  assert.deepEqual(data.rows.find(row => row.id === 11).values, [{ '3': '0', '4': '0' }, null, null]);
  assert.deepEqual(data.rows.find(row => row.id === 12).values, [null, { '4': '0' }, null]);
});

test('duplicate page, changed total, bad group and owner change reject partial results', async () => {
  const logs = Array.from({ length: 101 }, (_, index) =>
    usage(index + 1, 11, 3, 0.1, '2026-11-10T08:00:00+08:00'));
  for (const variant of ['duplicate', 'total', 'badgroup', 'owner']) {
    const f = fixture({ logs, users: [USERS[0]], profiles: [{ name: '甲', userIds: [11] }] });
    const original = f.query.request;
    f.query.request = async (method, route) => {
      const result = await original(method, route);
      if (route.includes('/admin/usage?') && route.includes('page=2')) {
        if (variant === 'duplicate') return { total: 101, items: [logs[0]] };
        if (variant === 'total') return { total: 102, items: [logs[100]] };
        if (variant === 'badgroup') return { total: 101, items: [{ ...logs[100], group_id: -1 }] };
        if (variant === 'owner') f.setOwner(8);
      }
      return result;
    };
    await assert.rejects(f.query.query({ start: '2026-11-10', end: '2026-11-10' }));
    assert.equal(f.query.busy, false);
  }
});

test('unknown current access remains null but actual historical usage stays visible', async () => {
  const f = fixture({ logs: [usage(1, 11, 3, 4, '2026-11-10T08:00:00+08:00')] });
  const original = f.query.request;
  f.query.request = async (method, route) => {
    if (route === '/admin/users/11') throw Error('detail unavailable');
    return original(method, route);
  };
  const result = await f.query.query({ start: '2026-11-10', end: '2026-11-10' });
  assert.equal(result.accessComplete, false);
  assert.equal(result.rows.find(row => row.id === 11).allowedGroups, null);
  assert.equal(result.rows.find(row => row.id === 11).values[0]['3'], '4');
});

test('null allowed_groups means platform default nonexclusive groups, not an empty explicit grant', async () => {
  const f = fixture({ access: { 11: null, 12: [] } });
  const result = await f.query.query({ start: '2026-11-10', end: '2026-11-10' });
  assert.equal(result.rows.find(row => row.id === 11).accessMode, 'all-nonexclusive');
  assert.deepEqual(result.rows.find(row => row.id === 11).allowedGroups, []);
  assert.equal(result.rows.find(row => row.id === 12).accessMode, 'explicit');
});

test('usage from before this owner held the account is not exposed in its group columns', async () => {
  const byDay = {
    '2026-11-09': [{ name: '乙', userIds: [11] }, { name: '甲', userIds: [] }],
    '2026-11-10': [{ name: '乙', userIds: [] }, { name: '甲', userIds: [11] }]
  };
  const f = fixture({ byDay, profiles: [{ name: '甲', userIds: [11] }, { name: '乙', userIds: [] }],
    access: { 11: [] }, logs: [
      usage(1, 11, 3, 500, '2026-11-09T12:00:00+08:00'),
      usage(2, 11, 4, 2, '2026-11-10T12:00:00+08:00')
    ] });
  const result = await f.query.query({ start: '2026-11-09', end: '2026-11-10', name: '甲' });
  assert.deepEqual(result.groups.map(group => group.id), [4]);
  assert.deepEqual(result.rows[0].values, [null, { '4': '2' }]);
});
