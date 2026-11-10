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
    maxUsers = MAX_USERS, maxDurationMs = 120_000, maxConcurrent = 2, throttle = async () => {} }) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 3)
      throw new Error('每日用量并发上限无效。');
    Object.assign(this, { ownership, request, now, maxProfiles, maxUsers, maxDurationMs, maxConcurrent, throttle });
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
      const currentProfiles = this.ownership.profiles();
      const profiles = this.ownership.profilesAt?.(date) || currentProfiles;
      if (profiles.length > this.maxProfiles) throw new Error('归属档案超过本次读取上限。');
      const ids = [...new Set(profiles.flatMap(row => row.userIds))];
      if (ids.length > this.maxUsers) throw new Error('归属用户超过本次读取上限。');
      const users = await this.ownership.users();
      const byId = new Map(users.filter(user => user.role === 'user').map(user => [user.id, user]));
      if (ids.some(id => !byId.has(id))) throw new Error('有归属用户已不在当前平台列表，本次不发布用量。');
      const costs = new Map();
      let nextIndex = 0, started = 0, failure = null, launchGate = Promise.resolve();
      const timedOut = () => this.now() - startedAt >= this.maxDurationMs;
      const waitLaunch = () => {
        const turn = launchGate.then(async () => {
          if (failure) return;
          if (started > 0) await this.throttle();
          if (timedOut()) throw new Error('每日用量读取超过本次时间上限，未发布不完整结果。');
          started++;
        });
        launchGate = turn.catch(error => { failure ||= error || new Error('每日用量读取失败。'); });
        return turn;
      };
      const worker = async () => {
        try {
          while (!failure && nextIndex < ids.length) {
            const index = nextIndex++;
            if (timedOut()) throw new Error('每日用量读取超过本次时间上限，未发布不完整结果。');
            // Space out request starts even when two slow platform reads overlap.
            await waitLaunch();
            if (failure) return;
            const stats = await this.request('GET', statsRoute(ids[index], date));
            costs.set(ids[index], finiteCost(stats, field));
          }
        } catch (error) { failure ||= error || new Error('每日用量读取失败。'); }
      };
      await Promise.all(Array.from({ length: Math.min(this.maxConcurrent, ids.length) }, () => worker()));
      if (failure) throw failure;
      if (this.now() - startedAt >= this.maxDurationMs)
        throw new Error('每日用量读取超过本次时间上限，未发布不完整结果。');
      const verified = await this.ownership.admin();
      if (verified.owner !== scope.owner || verified.groupId !== scope.groupId ||
          JSON.stringify(this.ownership.profiles()) !== JSON.stringify(currentProfiles) ||
          JSON.stringify(this.ownership.profilesAt?.(date) || this.ownership.profiles()) !== JSON.stringify(profiles))
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
