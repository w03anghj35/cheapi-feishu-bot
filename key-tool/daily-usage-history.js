'use strict';
const { dayKey } = require('./daily-usage');

const DAY_MS = 24 * 60 * 60_000;
const dateOf = day => Date.parse(`${dayKey(day)}T00:00:00Z`);
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
function monthKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) throw Error('月份无效。');
  dayKey(`${value}-01`);
  return value;
}
function weeksInMonth(month) {
  monthKey(month);
  const first = dateOf(`${month}-01`);
  const firstMonday = first - ((new Date(first).getUTCDay() + 6) % 7) * DAY_MS;
  const nextMonth = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
  const weeks = [];
  for (let start = firstMonday; start < nextMonth; start += 7 * DAY_MS)
    weeks.push({ start: isoDay(start), end: isoDay(start + 6 * DAY_MS) });
  return weeks;
}
function historyCatalog(state, currentNames, today) {
  dayKey(today);
  const snapshots = state?.snapshots || {};
  const months = [...new Set([today.slice(0, 7), ...Object.keys(snapshots).map(day => dayKey(day).slice(0, 7))])].sort().reverse();
  const names = [...new Set([...currentNames, ...Object.values(snapshots).flatMap(snapshot => snapshot.rows.map(row => row.name))])]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return { months, weeksByMonth: Object.fromEntries(months.map(month => [month, weeksInMonth(month)])), names, today };
}
function historyWeek(state, { month, weekStart, name }, today, currentNames = []) {
  dayKey(today);
  const week = weeksInMonth(month).find(row => row.start === weekStart);
  if (!week) throw Error('所选周不属于该月份。');
  const catalog = historyCatalog(state, currentNames, today);
  if (typeof name !== 'string' || !catalog.names.includes(name)) throw Error('归属人无效或没有历史记录。');
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = isoDay(Date.parse(`${week.start}T00:00:00Z`) + index * DAY_MS);
    const snapshot = state.snapshots[day];
    const profile = snapshot?.rows.find(row => row.name === name);
    return { day, phase: day > today ? 'future' : !profile ? 'missing' :
      snapshot.final ? 'final' : 'ongoing', checkedAt: profile ? snapshot.checkedAt : null,
      source: profile ? snapshot.source || 'scheduled' : null,
      users: profile?.users || [] };
  });
  const users = new Map();
  for (const day of days) for (const user of day.users) {
    const row = users.get(user.id) || { id: user.id, email: user.email, costs: {} };
    row.email = user.email; row.costs[day.day] = user.cost; users.set(user.id, row);
  }
  const rows = [...users.values()].sort((a, b) => a.id - b.id).map(user => {
    const values = days.map(day => Object.hasOwn(user.costs, day.day) ? user.costs[day.day] : null);
    return { id: user.id, email: user.email, values,
      recordedSubtotal: values.reduce((sum, value) => sum + (value ?? 0), 0),
      complete: values.every((value, index) => value !== null && days[index].phase === 'final') };
  });
  const totals = days.map((day, index) => day.phase === 'missing' || day.phase === 'future' ? null :
    rows.reduce((sum, row) => sum + (row.values[index] ?? 0), 0));
  const totalsComplete = days.map((day, index) => day.phase === 'final' && rows.every(row => row.values[index] !== null));
  return { month, week, name, days: days.map(({ users: _users, ...day }) => day), rows, totals,
    totalsComplete,
    recordedSubtotal: totals.reduce((sum, value) => sum + (value ?? 0), 0),
    complete: days.every(day => day.phase === 'final') && rows.every(row => row.complete) };
}
module.exports = { monthKey, weeksInMonth, historyCatalog, historyWeek };
