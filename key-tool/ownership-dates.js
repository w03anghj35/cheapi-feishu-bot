'use strict';
const { dayKey } = require('./daily-usage');
const validIds = ids => Array.isArray(ids) && ids.length <= 2000 &&
  ids.every(id => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length;
function validateMembership(value, currentIds) {
  if (!value || !validIds(value.baselineIds) || !Array.isArray(value.changes) ||
      !value.changes.length || value.changes.length > 5000) throw Error('归属生效记录无效。');
  let previous = '';
  for (const row of value.changes) {
    if (!row || dayKey(row.day) !== row.day || row.day <= previous || !validIds(row.userIds))
      throw Error('归属生效日期或账号列表无效。');
    previous = row.day;
  }
  if (JSON.stringify(value.changes.at(-1).userIds) !== JSON.stringify(currentIds)) throw Error('当前归属与生效记录不一致。');
  if(value.labels !== undefined && (!Array.isArray(value.labels) || value.labels.length>10000 ||
      new Set(value.labels.map(u=>u?.id)).size!==value.labels.length || value.labels.some(u=>!validIds([u?.id]) ||
        typeof u.email!=='string' || !u.email || u.email.length>254 || /[\x00-\x1f\x7f]/.test(u.email))))
    throw Error('历史客户标签无效。');
}
function changeMembership(profile, userIds, day, labels = []) {
  dayKey(day);
  if (profile?.membership && JSON.stringify(profile.userIds) === JSON.stringify(userIds)) return structuredClone(profile.membership);
  const membership = structuredClone(profile?.membership || { baselineIds: profile?.userIds || [], changes: [] });
  membership.labels = [...new Map([...(membership.labels || []), ...(profile?.userLabels || []), ...labels]
    .map(u=>[u.id,{id:u.id,email:u.email}])).values()];
  if (membership.changes.at(-1)?.day > day) throw Error('系统日期早于已保存的归属修改，请先核对时间。');
  if (membership.changes.at(-1)?.day === day) membership.changes.pop();
  membership.changes.push({ day, userIds: [...userIds] });
  validateMembership(membership, userIds); return membership;
}
// Null means there was no dated evidence yet: preserve the existing historical snapshot.
function datedIds(profile, day) {
  dayKey(day);
  const changes = profile?.membership?.changes;
  if (!changes || day < changes[0].day) return null;
  return [...changes.filter(row => row.day <= day).at(-1).userIds];
}
function membershipPhase(profile, id, day) {
  const ids = datedIds(profile, day);
  if (ids === null || ids.includes(id)) return null;
  const knownBefore = profile.membership.baselineIds.includes(id) ||
    profile.membership.changes.some(row => row.day < day && row.userIds.includes(id));
  return knownBefore ? 'removed' : 'unassigned';
}
function membershipStart(profile, id) {
  if (!profile.membership) return null;
  let active = profile.membership.baselineIds.includes(id), start = null;
  for (const change of profile.membership.changes) {
    const next = change.userIds.includes(id);
    if (next && !active) start = change.day;
    if (!next) start = null;
    active = next;
  }
  return start;
}
function projectSnapshots(state, profiles) {
  const byName = new Map(profiles.map(p => [p.name, p]));
  return { ...state, snapshots: Object.fromEntries(Object.entries(state.snapshots || {}).map(([day, snapshot]) =>
    [day, { ...snapshot, rows: snapshot.rows.map(row => {
      const ids = datedIds(byName.get(row.name), day);
      return ids === null ? row : { ...row, users: row.users.filter(user => ids.includes(user.id)) };
    }) }])) };
}
module.exports = { validateMembership, changeMembership, datedIds, membershipPhase, membershipStart, projectSnapshots };
