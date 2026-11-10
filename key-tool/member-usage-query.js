'use strict';

const { DailyUsage, beijingDay } = require('./daily-usage');
const { dailyUsageCard } = require('./daily-usage-card');
const { projectSnapshots } = require('./ownership-dates');

const DAY_MS = 24 * 60 * 60_000;
const previousDay = (today, offset) => new Date(Date.parse(`${today}T00:00:00Z`) - offset * DAY_MS).toISOString().slice(0, 10);
function privateUsageCard(profile, day, checkedAt, stored) {
  const ids = profile.users.map(user => user.id);
  const days = [previousDay(day, 2), previousDay(day, 1)].map(date => {
    const snapshot = stored.snapshots[date];
    const row = snapshot?.rows?.find(item => item.name === profile.name);
    const valid = snapshot?.final === true && row && ids.every(id => row.users.some(user => user.id === id));
    return { day: date, final: true, users: valid ? row.users.filter(user => ids.includes(user.id)) : [] };
  });
  days.push({ day, final: false, users: profile.users });
  return dailyUsageCard({ name: profile.name, days, checkedAt, privateView: true });
}

class MemberUsageQuery {
  constructor({ ownership, request, snapshotStore, getAdminScope = () => null,
    now = () => Date.now(), throttle = () => new Promise(resolve => setTimeout(resolve, 200)) }) {
    Object.assign(this, { ownership, request, snapshotStore, getAdminScope, now, throttle });
    this.busy = false;
  }

  sameBinding(openId, binding) { return this.ownership.sameUsageBinding(openId, binding); }

  adminScope(openId) {
    const scope = this.getAdminScope(openId);
    if (typeof openId !== 'string' || !/^ou_[\w-]{4,252}$/.test(openId) ||
        !Number.isSafeInteger(scope?.owner) || scope.owner <= 0 ||
        typeof scope.groupId !== 'string' || !/^oc_[\w-]{8,128}$/.test(scope.groupId) || this.ownership.storageFault)
      throw new Error('仅已在后台核实的飞书管理员可查询全部归属用量。');
    return { owner: scope.owner, groupId: scope.groupId };
  }

  sameAdminBinding(openId, binding) {
    try {
      const scope = this.adminScope(openId), current = this.ownership.scope();
      return scope.owner === binding?.scope?.owner && scope.groupId === binding.scope.groupId &&
        current.owner === scope.owner && current.groupId === scope.groupId &&
        binding.day === beijingDay(this.now()) && binding.revision === this.ownership.revision();
    } catch { return false; }
  }

  async queryAll(openId, guard = () => true) {
    if (this.busy) throw new Error('已有用户用量查询，请稍后再试。');
    // The scope comes from the main process' verified bot policy, never card fields or display names.
    const scope = this.adminScope(openId);
    if (guard() !== true) throw new Error('管理员会话已失效。');
    this.busy = true;
    const auditBinding = { scope, actorName: '已核实飞书管理员', name: '全部归属人' };
    let audited = false;
    try {
      const verified = await this.ownership.admin();
      if (verified.owner !== scope.owner || verified.groupId !== scope.groupId) throw new Error('管理员范围已变化。');
      const day = beijingDay(this.now());
      const binding = { scope, day, revision: this.ownership.revision() };
      const check = () => {
        if (guard() !== true || !this.sameAdminBinding(openId, binding)) throw new Error('管理员、日期或归属已变化。');
      };
      check();
      const profiles = this.ownership.profiles();
      if (!profiles.some(row => row.userIds.length)) {
        this.ownership.auditUsage(openId, auditBinding, 'not-found', 0, 'usage-all'); audited = true;
        return { binding, cards: [] };
      }
      const usage = new DailyUsage({ ownership: this.ownership, now: this.now, throttle: this.throttle,
        request: async (...args) => { check(); const result = await this.request(...args); check(); return result; } });
      const fresh = await usage.read(day);
      check();
      if (fresh.scope.owner !== scope.owner || fresh.scope.groupId !== scope.groupId) throw new Error('管理员范围已变化。');
      const stored = projectSnapshots(this.snapshotStore.state(scope), this.ownership.datedProfiles?.() || []);
      // Prepare and validate the complete batch before exposing even its first profile.
      const cards = fresh.rows.filter(row => row.users.length).map(row => ({ name: row.name,
        card: privateUsageCard(row, day, fresh.checkedAt, stored) }));
      const count = new Set(fresh.rows.flatMap(row => row.users.map(user => user.id))).size;
      check();
      this.ownership.auditUsage(openId, auditBinding, 'found', count, 'usage-all'); audited = true;
      return { binding, cards };
    } catch (error) {
      if (!audited) this.ownership.auditUsage(openId, auditBinding, 'error', 0, 'usage-all');
      throw error;
    } finally { this.busy = false; }
  }

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
      const card = privateUsageCard(current, day, fresh.checkedAt, stored);
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
