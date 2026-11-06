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
