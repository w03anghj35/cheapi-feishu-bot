'use strict';

const { DailyUsage, beijingDay } = require('./daily-usage');
const { dailyUsageCard } = require('./daily-usage-card');

const DAY_MS = 24 * 60 * 60_000;
const previousDay = (today, offset) => new Date(Date.parse(`${today}T00:00:00Z`) - offset * DAY_MS).toISOString().slice(0, 10);

class MemberUsageQuery {
  constructor({ ownership, request, snapshotStore, now = () => Date.now(), throttle = () => new Promise(resolve => setTimeout(resolve, 200)) }) {
    Object.assign(this, { ownership, request, snapshotStore, now, throttle });
    this.busy = false;
  }

  sameBinding(openId, binding) { return this.ownership.sameUsageBinding(openId, binding); }

  async query(openId, guard = () => true) {
    if (this.busy) throw new Error('已有用户用量查询，请稍后再试。');
    this.busy = true;
    let binding = null, audited = false;
    try {
      binding = this.ownership.usageBinding(openId);
      if (!binding) {
        this.ownership.auditUsage(openId, null, 'not-found'); audited = true;
        return { pending: true };
      }
      if (!binding.userIds.length) throw new Error('当前归属档案没有平台账号。');
      if (guard() !== true || !this.sameBinding(openId, binding)) throw new Error('身份或归属已变化。');
      const day = beijingDay(this.now());
      const scopedOwnership = {
        admin: () => this.ownership.admin(),
        profiles: () => [{ name: binding.name, userIds: [...binding.userIds] }],
        users: () => this.ownership.users()
      };
      const usage = new DailyUsage({ ownership: scopedOwnership, request: this.request,
        now: this.now, throttle: this.throttle });
      const fresh = await usage.read(day);
      if (beijingDay(this.now()) !== day) throw new Error('北京日期已变化，请重新查询用量。');
      if (guard() !== true || !this.sameBinding(openId, binding) ||
          fresh.scope.owner !== binding.scope.owner || fresh.scope.groupId !== binding.scope.groupId)
        throw new Error('身份或归属已变化。');
      const current = fresh.rows[0];
      if (!current || current.name !== binding.name ||
          JSON.stringify(current.users.map(user => user.id)) !== JSON.stringify(binding.userIds))
        throw new Error('用户用量归属不一致。');
      const stored = this.snapshotStore.state(binding.scope);
      const days = [previousDay(day, 2), previousDay(day, 1)].map(date => {
        const snapshot = stored.snapshots[date];
        const row = snapshot?.rows?.find(item => item.name === binding.name);
        const valid = snapshot?.final === true && row &&
          binding.userIds.every(id => row.users.some(user => user.id === id));
        return { day: date, final: true, users: valid ? row.users.filter(user => binding.userIds.includes(user.id)) : [] };
      });
      days.push({ day, final: false, users: current.users });
      const card = dailyUsageCard({ name: binding.name, days, checkedAt: fresh.checkedAt, privateView: true });
      if (beijingDay(this.now()) !== day || guard() !== true || !this.sameBinding(openId, binding))
        throw new Error('日期、身份或归属已变化。');
      this.ownership.auditUsage(openId, binding, 'found', binding.userIds.length); audited = true;
      return { binding, card };
    } catch (error) {
      if (!audited) this.ownership.auditUsage(openId, binding, 'error');
      throw error;
    } finally { this.busy = false; }
  }
}

module.exports = { MemberUsageQuery };
