'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FinanceUsageError, statsRoute, projectStats, readDailyStats,
  currentMonthCoverage } = require('./finance-usage-source');

const NOW = Date.parse('2026-11-12T15:59:00+08:00');

test('single-day route is fixed, bounded by valid platform ID and Beijing date', () => {
  assert.equal(statsRoute(42, '2026-11-12'),
    '/admin/usage/stats?user_id=42&start_date=2026-11-12&end_date=2026-11-12');
  for (const bad of [0, -1, '42', NaN, Infinity, 1.2])
    assert.throws(() => statsRoute(bad, '2026-11-12'), FinanceUsageError);
  for (const bad of ['2026-11-31', '2026-11-1', '2019-12-31', '2101-01-01'])
    assert.throws(() => statsRoute(42, bad), FinanceUsageError);
});

test('orange account cost is distinct from actual revenue and gray standard cost', () => {
  const result = projectStats({ total_actual_cost: 115526.5117,
    total_account_cost: 95183.9747, total_cost: 76920.7405, token: 'must-not-return' });
  assert.deepEqual(result, { revenue: '115526.5117', accountCost: '95183.9747',
    costStatus: 'ready', costBasis: 'platform_account_billed' });
  assert.deepEqual(projectStats({ total_actual_cost: 0, total_account_cost: 0, total_cost: 50 }),
    { revenue: '0', accountCost: '0', costStatus: 'ready', costBasis: 'platform_account_billed' });
});

test('missing orange account cost never falls back to standard cost or zero', () => {
  for (const raw of [{ total_actual_cost: 7, total_cost: 3 },
    { total_actual_cost: 7, total_account_cost: null, total_cost: 3 }])
    assert.deepEqual(projectStats(raw), { revenue: '7', accountCost: null,
      costStatus: 'missing', costBasis: 'platform_account_billed' });
  assert.throws(() => projectStats({ total_cost: 3, total_account_cost: 1 }), FinanceUsageError);
});

test('amount validation rejects negative, malformed and sub-unit values', () => {
  for (const value of [-1, -0.1, NaN, Infinity, '0.000000001', '1e100', true, {}, null])
    assert.throws(() => projectStats({ total_actual_cost: value, total_account_cost: 0 }), FinanceUsageError);
  for (const value of [-1, NaN, Infinity, '0.000000001', true, null])
    if (value !== null) assert.throws(() => projectStats({ total_actual_cost: 1, total_account_cost: value }), FinanceUsageError);
  assert.equal(projectStats({ total_actual_cost: 0.1 + 0.2, total_account_cost: 0 }).revenue, '0.3');
});

test('injected daily reader calls one GET, verifies administrator before and after', async () => {
  let calls = 0, owner = 7;
  const result = await readDailyStats({ userId: 42, day: '2026-11-12', now: () => NOW,
    getOwner: () => owner, request: async (method, route) => {
      assert.equal(method, 'GET'); assert.equal(route, statsRoute(42, '2026-11-12'));
      calls++; return { total_actual_cost: 7.125, total_account_cost: 3.25, total_cost: 1 };
    } });
  assert.equal(calls, 1);
  assert.equal(result.revenue, '7.125');
  assert.equal(result.accountCost, '3.25');
  assert.equal(result.final, false);
  assert.equal(result.platformAdminId, 7);
  owner = null;
  await assert.rejects(readDailyStats({ userId: 42, day: '2026-11-12', now: () => NOW,
    getOwner: () => owner, request: async () => { throw Error('must not fetch'); } }),
  error => error.code === 'AUTH');
});

test('changed owner, future day and crossing Beijing midnight fail closed', async () => {
  let owner = 7, calls = 0;
  await assert.rejects(readDailyStats({ userId: 42, day: '2026-11-12', now: () => NOW,
    getOwner: () => owner, request: async () => { owner = 8; calls++; return { total_actual_cost: 1 }; } }),
  error => error.code === 'AUTH');
  assert.equal(calls, 1);
  calls = 0; owner = 7;
  await assert.rejects(readDailyStats({ userId: 42, day: '2026-11-13', now: () => NOW,
    getOwner: () => owner, request: async () => { calls++; return {}; } }),
  error => error.code === 'INPUT');
  assert.equal(calls, 0);
  let tick = 0;
  await assert.rejects(readDailyStats({ userId: 42, day: '2026-11-12',
    now: () => ++tick === 1 ? Date.parse('2026-11-12T23:59:59+08:00') : Date.parse('2026-11-13T00:00:01+08:00'),
    getOwner: () => owner, request: async () => ({ total_actual_cost: 1 }) }),
  error => error.code === 'CONFLICT');
});

test('month date enumeration is only a plan, never claims full coverage', () => {
  const plan = currentMonthCoverage(Date.parse('2026-02-12T12:00:00+08:00'));
  assert.equal(plan.days.length, 12);
  assert.equal(plan.fromDay, '2026-02-01');
  assert.equal(plan.throughDay, '2026-02-12');
  assert.equal(plan.complete, false);
  assert.equal(plan.status, 'not_collected');
});
