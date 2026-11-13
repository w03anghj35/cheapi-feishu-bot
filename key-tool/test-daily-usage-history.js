'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { weeksInMonth, historyCatalog, historyWeek } = require('./daily-usage-history');

const today = '2026-11-06';
const snapshot = (day, rows, final = true) => ({ day, checkedAt: `${day}T12:00:00Z`, final, rows });
const user = (id, cost, email = `u${id}@example.invalid`) => ({ id, email, cost });
const state = { snapshots: {
  '2026-10-31': snapshot('2026-10-31', [{ name: '甲', users: [user(1, 1)] }]),
  '2026-11-02': snapshot('2026-11-02', [
    { name: '甲', users: [user(1, 2), user(2, 3)] },
    { name: '乙', users: [user(1, 2), user(3, 9)] }]),
  '2026-11-03': snapshot('2026-11-03', [{ name: '甲', users: [user(1, 4)] }]),
  '2026-11-06': snapshot('2026-11-06', [{ name: '甲', users: [user(1, 6)] }], false)
} };

test('month selector includes all stored months and cross-month Monday weeks', () => {
  const catalog = historyCatalog(state, ['现任'], today);
  assert.deepEqual(catalog.months, ['2026-11', '2026-10']);
  assert.deepEqual(catalog.names, ['乙', '甲', '现任'].sort((a, b) => a.localeCompare(b, 'zh-CN')));
  assert.deepEqual(weeksInMonth('2026-11')[0], { start: '2026-10-26', end: '2026-11-01' });
  assert.deepEqual(weeksInMonth('2020-01')[0], { start: '2019-12-30', end: '2020-01-05' });
  assert.throws(() => weeksInMonth('2026-13'));
});
test('week table keeps missing, future and ongoing apart from zero', () => {
  const data = historyWeek(state, { month: '2026-11', weekStart: '2026-11-02', name: '甲' }, today);
  assert.deepEqual(data.days.map(day => day.phase), ['final', 'final', 'missing', 'missing', 'ongoing', 'future', 'future']);
  assert.deepEqual(data.rows.map(row => row.values), [[2, 4, null, null, 6, null, null], [3, null, null, null, null, null, null]]);
  assert.deepEqual(data.totals, [5, 4, null, null, 6, null, null]);
  assert.deepEqual(data.totalsComplete, [true, false, false, false, false, false, false]);
  assert.equal(data.recordedSubtotal, 15);
  assert.equal(data.complete, false);
  assert.equal(JSON.stringify(data).includes('u3@example.invalid'), false);
});
test('completed week has a full total, empty person and invalid filter do not leak other rows', () => {
  const complete = { snapshots: {} };
  for (let day = 2; day <= 8; day++) {
    const key = `2026-11-${String(day).padStart(2, '0')}`;
    complete.snapshots[key] = snapshot(key, [{ name: '甲', users: [user(1, day === 2 ? 0 : 1)] },
      { name: '乙', users: [user(3, 100)] }]);
  }
  const result = historyWeek(complete, { month: '2026-11', weekStart: '2026-11-02', name: '甲' }, '2026-11-09');
  assert.equal(result.complete, true); assert.equal(result.recordedSubtotal, 6);
  assert.equal(result.rows[0].values[0], 0);
  assert.equal(JSON.stringify(result).includes('u3@example.invalid'), false);
  const empty = historyWeek(complete, { month: '2026-11', weekStart: '2026-11-09', name: '甲' }, '2026-11-09');
  assert.equal(empty.rows.length, 0); assert.equal(empty.complete, false);
  assert.throws(() => historyWeek(complete, { month: '2026-11', weekStart: '2026-11-16', name: '不存在' }, '2026-11-09'));
  assert.throws(() => historyWeek(complete, { month: '2026-10', weekStart: '2026-11-02', name: '甲' }, '2026-11-09'));
});
test('past unfinished day is pending finalization, not today ongoing or a completed total', () => {
  const data = historyWeek(state, { month: '2026-11', weekStart: '2026-11-02', name: '甲' }, '2026-11-09');
  assert.equal(data.days.find(day => day.day === '2026-11-06').phase, 'pending');
  assert.equal(data.rows[0].values[4], 6);
  assert.equal(data.totalsComplete[4], false);
  assert.equal(data.complete, false);
});

test('current week lists newly assigned accounts immediately with unknown amounts, without changing snapshots', () => {
  const before = structuredClone(state);
  const current = [{ id: 1, email: 'current1@example.invalid' }, { id: 2, email: 'current2@example.invalid' },
    { id: 4, email: 'new@example.invalid' }];
  const data = historyWeek(state, { month: '2026-11', weekStart: '2026-11-02', name: '甲' }, today, ['甲'], current);
  assert.deepEqual(data.rows.map(r => r.id), [1, 2, 4]);
  const added = data.rows.find(r => r.id === 4);
  assert.equal(added.email, 'new@example.invalid');
  assert.deepEqual(added.values, Array(7).fill(null));
  assert.equal(added.awaitingSample, true);
  assert.equal(added.hasRecordedUsage, false);
  assert.equal(data.awaitingCount, 2);
  assert.deepEqual(data.totals, [5, 4, null, null, 6, null, null]);
  assert.deepEqual(state, before);
  const historical = historyWeek(state, { month: '2026-11', weekStart: '2026-11-02', name: '甲' }, '2026-11-09', ['甲'], current);
  assert.deepEqual(historical.rows.map(r => r.id), [1, 2]);
});

test('new person with no samples still lists every assigned account without fabricated zero totals', () => {
  const data = historyWeek({ snapshots: {} }, { month: '2026-11', weekStart: '2026-11-09', name: '新增' },
    '2026-11-09', ['新增'], [{ id: 5, email: 'five@example.invalid' }]);
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].awaitingSample, true);
  assert.deepEqual(data.totals, Array(7).fill(null));
});
test('targeted pre-assignment supplement contributes to current owner history without changing original snapshot', () => {
  const original = { snapshots: { '2026-11-02': snapshot('2026-11-02', [
    { name: '甲', users: [user(1, 4)] }]) }, supplements: { '2026-11-02': { '甲': {
      7: { day: '2026-11-02', profile: '甲', checkedAt: '2026-11-09T08:00:00Z',
        user: user(7, 5) } } } } };
  const before = structuredClone(original.snapshots['2026-11-02']);
  const dated = [{ name: '甲', userIds: [1, 7], membership: { baselineIds: [1],
    changes: [{ day: '2026-11-01', userIds: [1] }, { day: '2026-11-09', userIds: [1, 7] }] } }];
  const result = historyWeek(original, {month:'2026-11',weekStart:'2026-11-02',name:'甲'},
    '2026-11-09', ['甲'], [{id:1,email:'u1@example.invalid'},{id:7,email:'u7@example.invalid'}], dated);
  assert.equal(result.rows.find(row => row.id === 7).values[0], 5);
  assert.equal(result.rows.find(row => row.id === 7).membership[0], null);
  assert.equal(result.totals[0], 9);
  assert.equal(result.days[0].source, 'backfill-current-ownership');
  assert.deepEqual(original.snapshots['2026-11-02'], before);
});
