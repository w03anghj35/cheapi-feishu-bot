'use strict';
const { dayKey } = require('./daily-usage');
const { projectSnapshots, membershipPhase, datedIds } = require('./ownership-dates');
const { supplementedUsers } = require('./daily-usage-supplements');

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
  const months = [...new Set([today.slice(0, 7), ...Object.keys(snapshots).map(day => dayKey(day).slice(0, 7)),
    ...Object.keys(state?.supplements || {}).map(day => dayKey(day).slice(0, 7))])].sort().reverse();
  const names = [...new Set([...currentNames, ...Object.values(snapshots).flatMap(snapshot => snapshot.rows.map(row => row.name)),
    ...Object.values(state?.supplements || {}).flatMap(day => Object.keys(day))])]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return { months, weeksByMonth: Object.fromEntries(months.map(month => [month, weeksInMonth(month)])), names, today };
}
function historyWeek(state, { month, weekStart, name }, today, currentNames = [], currentAccounts = [], datedProfiles = []) {
  state = projectSnapshots(state, datedProfiles);
  const datedProfile = datedProfiles.find(profile => profile.name === name);
  dayKey(today);
  const week = weeksInMonth(month).find(row => row.start === weekStart);
  if (!week) throw Error('所选周不属于该月份。');
  const catalog = historyCatalog(state, currentNames, today);
  if (typeof name !== 'string' || !catalog.names.includes(name)) throw Error('归属人无效或没有历史记录。');
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = isoDay(Date.parse(`${week.start}T00:00:00Z`) + index * DAY_MS);
    const snapshot = state.snapshots[day];
    const profile = snapshot?.rows.find(row => row.name === name);
    const extra = supplementedUsers(state, day, name, profile?.users || []);
    return { day, phase: day > today ? 'future' : !profile && extra.supplemented ? 'partial' : !profile ? 'missing' :
      snapshot.final ? 'final' : day < today ? 'pending' : 'ongoing', checkedAt: profile ? snapshot.checkedAt : null,
      source: extra.supplemented ? 'backfill-current-ownership' : profile ? snapshot.source || 'scheduled' : null,
      users: extra.users,
      supplemented: extra.supplemented,
      supplementedIds: extra.supplementedIds,
      ...(extra.checkedAt && (!profile || extra.checkedAt > snapshot.checkedAt) ? { checkedAt: extra.checkedAt } : {}) };
  });
  const users = new Map();
  for (const day of days) for (const user of day.users) {
    const row = users.get(user.id) || { id: user.id, email: user.email, costs: {} };
    row.email = user.email; row.costs[day.day] = user.cost; users.set(user.id, row);
  }
  for (const day of days.filter(d=>d.day<=today)) for (const id of datedIds(datedProfile,day.day) || []) {
    if(!users.has(id))users.set(id,{id,email:datedProfile.membership?.labels?.find(u=>u.id===id)?.email ||
      currentAccounts.find(u=>u.id===id)?.email || `平台用户 ID ${id}（邮箱待同步）`,costs:{}});
  }
  // A saved assignment is enough to show a row in the current week. Amounts
  // remain absent until sampled; this projection never rewrites historical data.
  const currentIds = new Set();
  if (week.start <= today && today <= week.end) for (const account of currentAccounts) {
    currentIds.add(account.id);
    if (!users.has(account.id)) users.set(account.id, {
      id: account.id, email: account.email || `平台用户 ID ${account.id}（邮箱待同步）`, costs: {}
    });
  }
  const rows = [...users.values()].sort((a, b) => a.id - b.id).map(user => {
    const values = days.map(day => Object.hasOwn(user.costs, day.day) ? user.costs[day.day] : null);
    const membership = days.map(day => day.supplementedIds.includes(user.id) ? null :
      membershipPhase(datedProfile, user.id, day.day));
    return { id: user.id, email: user.email, values,
      membership,
      awaitingSample: currentIds.has(user.id) && !Object.hasOwn(user.costs, today),
      currentAssigned: currentIds.has(user.id), hasRecordedUsage: values.some(value => value !== null),
      recordedSubtotal: values.reduce((sum, value) => sum + (value ?? 0), 0),
      complete: values.every((value, index) => (value !== null || membership[index] !== null) && days[index].phase === 'final') };
  });
  const totals = days.map((day, index) => {
    if(day.phase === 'missing' || day.phase === 'future')return null;
    const applicable=rows.filter(row=>!row.membership[index]);
    if(applicable.length && applicable.every(row=>row.values[index]===null))return null;
    return applicable.reduce((sum,row)=>sum+(row.values[index]??0),0);
  });
  const totalsComplete = days.map((day, index) => day.phase === 'final' && rows.every(row => row.values[index] !== null || row.membership[index]));
  return { month, week, name, today, awaitingCount: rows.filter(row => row.awaitingSample).length,
    days: days.map(({ users: _users, supplementedIds: _supplementedIds, ...day }) => day), rows, totals,
    totalsComplete,
    recordedSubtotal: totals.reduce((sum, value) => sum + (value ?? 0), 0),
    complete: days.every(day => day.phase === 'final') && rows.every(row => row.complete) };
}
module.exports = { monthKey, weeksInMonth, historyCatalog, historyWeek };
