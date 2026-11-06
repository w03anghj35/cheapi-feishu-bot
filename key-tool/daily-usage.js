'use strict';

const MAX_PROFILES = 30;
const MAX_USERS = 150;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayKey(value) {
  const match = DATE.exec(value);
  if (!match) throw new Error('请选择完整日期（YYYY-MM-DD）。');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2020 || year > 2100 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    throw new Error('日期无效。');
  return value;
}
function beijingDay(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = key => parts.find(row => row.type === key)?.value;
  return dayKey(`${part('year')}-${part('month')}-${part('day')}`);
}
function statsRoute(userId, day) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('平台用户 ID 无效。');
  const date = dayKey(day);
  return `/admin/usage/stats?user_id=${userId}&start_date=${date}&end_date=${date}`;
}
function finiteCost(stats, field = 'total_actual_cost') {
  const value = stats?.[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12)
    throw new Error('平台用量统计缺少可核对的金额。');
  return value;
}
function snapshotStamp(value) {
  return new Date(value).toISOString();
}
class DailyUsage {
  constructor({ ownership, request, now = () => Date.now(), maxProfiles = MAX_PROFILES,
    maxUsers = MAX_USERS, maxDurationMs = 120_000, throttle = async () => {} }) {
    Object.assign(this, { ownership, request, now, maxProfiles, maxUsers, maxDurationMs, throttle });
    this.busy = false;
  }
  async read(day, field = 'total_actual_cost') {
    if (this.busy) throw new Error('已有每日用量读取任务。');
    const date = dayKey(day);
    if (date > beijingDay(this.now())) throw new Error('不能读取未来日期用量。');
    if (!['total_actual_cost', 'total_cost'].includes(field)) throw new Error('用量指标无效。');
    this.busy = true;
    const startedAt = this.now();
    try {
      const scope = await this.ownership.admin();
      const profiles = this.ownership.profiles();
      if (profiles.length > this.maxProfiles) throw new Error('归属档案超过本次读取上限。');
      const ids = [...new Set(profiles.flatMap(row => row.userIds))];
      if (ids.length > this.maxUsers) throw new Error('归属用户超过本次读取上限。');
      const users = await this.ownership.users();
      const byId = new Map(users.filter(user => user.role === 'user').map(user => [user.id, user]));
      if (ids.some(id => !byId.has(id))) throw new Error('有归属用户已不在当前平台列表，本次不发布用量。');
      const costs = new Map();
      for (const id of ids) {
        if (this.now() - startedAt >= this.maxDurationMs)
          throw new Error('每日用量读取超过本次时间上限，未发布不完整结果。');
        const stats = await this.request('GET', statsRoute(id, date));
        costs.set(id, finiteCost(stats, field));
        await this.throttle();
      }
      if (this.now() - startedAt >= this.maxDurationMs)
        throw new Error('每日用量读取超过本次时间上限，未发布不完整结果。');
      const verified = await this.ownership.admin();
      if (verified.owner !== scope.owner || verified.groupId !== scope.groupId ||
          JSON.stringify(this.ownership.profiles()) !== JSON.stringify(profiles))
        throw new Error('管理员、目标群或归属已变化，本次不发布用量。');
      const rows = profiles.map(profile => ({ name: profile.name,
        users: profile.userIds.map(id => ({ id, username: byId.get(id).username,
          email: byId.get(id).email, cost: costs.get(id) })) }));
      return { day: date, field, scope, checkedAt: snapshotStamp(this.now()),
        final: date < beijingDay(this.now()), rows };
    } finally { this.busy = false; }
  }
}
module.exports = { DailyUsage, MAX_PROFILES, MAX_USERS, dayKey, beijingDay, statsRoute, finiteCost };
