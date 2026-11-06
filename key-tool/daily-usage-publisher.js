'use strict';
const { beijingDay } = require('./daily-usage');
const { dailyUsageCard, retiredDailyUsageCard } = require('./daily-usage-card');
const { historyCatalog, historyWeek } = require('./daily-usage-history');

const HOUR_MS = 60 * 60_000;
const ROTATE_MS = 10 * 24 * HOUR_MS;
const BACKFILL_BUDGET_MS = 10 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const yesterday = day => new Date(Date.parse(`${day}T00:00:00Z`) - 24 * HOUR_MS).toISOString().slice(0, 10);
class DailyUsagePublisher {
  constructor({ usage, store, getScope, getClient, isReady, now = () => Date.now() }) {
    Object.assign(this, { usage, store, getScope, getClient, isReady, now });
    this.busy = false; this.retryAfter = 0; store.load();
    this.backfill = { phase: 'idle', completed: 0, skipped: 0, total: 0, day: null };
  }
  scope() { const scope = this.getScope(); if (!scope) throw Error('平台管理员与目标群尚未就绪。'); return scope; }
  sameOwnership(fresh) {
    const current = this.usage.ownership?.profiles?.();
    return Array.isArray(current) && JSON.stringify(current) === JSON.stringify(fresh.rows.map(row => ({
      name: row.name, userIds: row.users.map(user => user.id)
    })));
  }
  state() {
    const scope = this.scope(), state = this.store.state(scope);
    return { enabled: state.enabled, days: state.days,
      lastDay: Object.keys(state.snapshots).sort().at(-1) || null,
      cards: Object.entries(state.cards).map(([name, card]) => ({ name, phase: card.phase, at: card.at })),
      lastCheckedAt: Object.values(state.snapshots).sort((a,b) => a.checkedAt.localeCompare(b.checkedAt)).at(-1)?.checkedAt || null };
  }
  historyCatalog() {
    const scope = this.scope();
    const names = this.usage.ownership?.profiles?.().map(row => row.name) || [];
    return historyCatalog(this.store.state(scope), names, beijingDay(this.now()));
  }
  historyWeek(input) {
    const scope = this.scope();
    const names = this.usage.ownership?.profiles?.().map(row => row.name) || [];
    return historyWeek(this.store.state(scope), input || {}, beijingDay(this.now()), names);
  }
  backfillStatus() { return { ...this.backfill }; }
  async backfillCurrentMonth() {
    if (this.busy || this.usage.busy) throw Error('已有每日用量任务，请稍后再补采。');
    const scope = this.scope();
    const today = beijingDay(this.now());
    const month = today.slice(0, 7);
    const first = Date.parse(`${month}-01T00:00:00Z`);
    const end = Date.parse(`${today}T00:00:00Z`);
    const days = [];
    for (let at = first; at < end; at += DAY_MS) days.push(new Date(at).toISOString().slice(0, 10));
    const profiles = this.usage.ownership?.profiles?.();
    if (!Array.isArray(profiles) || !profiles.some(row => row.userIds?.length))
      throw Error('当前没有已保存的归属账号，请先在“用户归属”保存并核对。');
    this.busy = true;
    this.backfill = { phase: 'running', month, completed: 0, skipped: 0, total: days.length, day: null };
    const started = this.now();
    try {
      for (const day of days) {
        this.backfill.day = day;
        if (this.now() - started >= BACKFILL_BUDGET_MS) {
          this.backfill.phase = 'limited'; break;
        }
        if (this.store.state(scope).snapshots[day]?.final) { this.backfill.skipped++; continue; }
        const result = await this.usage.read(day);
        const current = this.scope();
        if (current.owner !== scope.owner || current.groupId !== scope.groupId ||
            result.scope.owner !== scope.owner || result.scope.groupId !== scope.groupId ||
            JSON.stringify(this.usage.ownership.profiles()) !== JSON.stringify(profiles) ||
            !result.final) throw Error('管理员、目标群、归属或日期已变化，本次补采已停止。');
        this.store.append({ type: 'snapshot', scope, day, checkedAt: result.checkedAt,
          final: true, source: 'backfill-current-ownership',
          rows: result.rows.map(row => ({ name: row.name,
            users: row.users.map(user => ({ id: user.id, email: user.email, cost: user.cost })) })) });
        this.backfill.completed++;
      }
      if (this.backfill.phase === 'running') this.backfill.phase = 'done';
      return this.backfillStatus();
    } catch {
      this.backfill.phase = 'failed';
      this.backfill.message = '补采在当前日期停止：平台读取、归属核验或本机加密保存未完成；此前成功日期已保留，可核对后重试。';
      return this.backfillStatus();
    } finally { this.busy = false; }
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Error('开关参数无效。');
    const scope = this.scope();
    const existing = this.store.state(scope);
    if (enabled && Object.values(existing.cards).some(card => ['unknown','attempting'].includes(card.phase)))
      throw Error('有群卡片发送结果待核对，不能重新启用或重复发送。');
    if (enabled && !this.isReady(scope)) throw Error('须先确认同一平台管理员、飞书已连接、目标群已绑定且群策略开启。');
    this.store.append({ type: 'config', scope, enabled, days: 3 });
    return this.state();
  }
  async preview() {
    if (this.busy || this.usage.busy) throw Error('已有每日用量任务，请稍后预览。');
    const scope = this.scope();
    const snapshot = await this.usage.read(beijingDay(this.now()));
    const current = this.scope();
    if (snapshot.scope.owner !== scope.owner || snapshot.scope.groupId !== scope.groupId ||
        current.owner !== scope.owner || current.groupId !== scope.groupId)
      throw Error('授权或目标群已变化，预览已取消。');
    for (const row of snapshot.rows.filter(item => item.users.length)) dailyUsageCard({ name: row.name, checkedAt: snapshot.checkedAt,
      days: [{ day: snapshot.day, final: snapshot.final,
        users: row.users.map(user => ({ id: user.id, email: user.email, cost: user.cost })) }] });
    return { day: snapshot.day, checkedAt: snapshot.checkedAt, rows: snapshot.rows.filter(row => row.users.length).map(row => ({
      name: row.name, users: row.users.map(user => ({ email: user.email, cost: user.cost })) })) };
  }
  async tick() {
    if (this.busy) return { skipped: 'busy' };
    if (this.now() < this.retryAfter) return { skipped: 'backoff' };
    let scope;
    try { scope = this.scope(); } catch { return { skipped: 'scope' }; }
    let state = this.store.state(scope);
    if (!state.enabled || !this.isReady(scope)) return { skipped: 'disabled-or-offline' };
    const today = beijingDay(this.now());
    const unresolved = Object.values(state.cards).filter(card => ['unknown','attempting'].includes(card.phase));
    if (unresolved.length) return { skipped: 'message-result-unknown', count: unresolved.length };
    if (state.snapshots[today] && this.now() - Date.parse(state.snapshots[today].checkedAt) < HOUR_MS)
      return { skipped: 'not-due' };
    this.busy = true;
    try {
      const previous = yesterday(today);
      if (state.snapshots[previous] && !state.snapshots[previous].final) {
        const final = await this.usage.read(previous);
        if (!this.isReady(scope) || !this.store.state(scope).enabled ||
            final.scope.owner !== scope.owner || final.scope.groupId !== scope.groupId) return { skipped: 'scope-changed' };
        this.store.append({ type: 'snapshot', scope, day: previous, checkedAt: final.checkedAt,
          final: true, rows: final.rows.map(row => ({ name: row.name,
            users: row.users.map(user => ({ id: user.id, email: user.email, cost: user.cost })) })) });
      }
      const fresh = await this.usage.read(today);
      if (!this.isReady(scope) || !this.store.state(scope).enabled ||
          fresh.scope.owner !== scope.owner || fresh.scope.groupId !== scope.groupId) return { skipped: 'scope-changed' };
      this.store.append({ type: 'snapshot', scope, day: today, checkedAt: fresh.checkedAt,
        final: false, rows: fresh.rows.map(row => ({ name: row.name,
          users: row.users.map(user => ({ id: user.id, email: user.email, cost: user.cost })) })) });
      state = this.store.state(scope);
      if (!this.store.state(scope).enabled || !this.isReady(scope)) return { skipped: 'scope-changed' };
      const prepared = fresh.rows.filter(profile => profile.users.length).map(profile => {
        const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 24 * HOUR_MS).toISOString().slice(0, 10);
        const days = Object.values(state.snapshots).filter(snapshot => snapshot.day >= cutoff &&
          snapshot.day <= today && snapshot.rows.some(row => row.name === profile.name))
          .sort((a,b) => a.day.localeCompare(b.day))
          .map(snapshot => ({ day: snapshot.day, final: snapshot.final,
            users: snapshot.rows.find(row => row.name === profile.name).users }));
        return { name: profile.name, card: dailyUsageCard({ name: profile.name, days,
          checkedAt: fresh.checkedAt }) };
      });
      let updated = 0, unknown = 0;
      const currentNames = new Set(prepared.map(profile => profile.name));
      for (const [name, previous] of Object.entries(state.cards)) {
        if (currentNames.has(name) || previous.phase !== 'ready') continue;
        if (!this.isReady(scope) || !this.store.state(scope).enabled) return { skipped: 'scope-changed', updated };
        if (this.scope().owner !== scope.owner || this.scope().groupId !== scope.groupId ||
            !this.sameOwnership(fresh)) return { skipped: 'ownership-changed', updated };
        const card = retiredDailyUsageCard(name, fresh.checkedAt);
        const client = this.getClient();
        if (!client) return { skipped: 'offline', updated };
        this.store.append({ type: 'attempt', scope, profile: name, action: 'patch',
          messageId: previous.messageId, at: new Date(this.now()).toISOString(), createdAt: previous.createdAt });
        try {
          await client.patchGroupCard({ messageId: previous.messageId, card });
          this.store.append({ type: 'retired', scope, profile: name, messageId: previous.messageId,
            at: new Date(this.now()).toISOString(), createdAt: previous.createdAt });
          updated++;
        } catch {
          this.store.append({ type: 'unknown', scope, profile: name, messageId: previous.messageId,
            at: new Date(this.now()).toISOString(), createdAt: previous.createdAt });
          unknown++;
        }
      }
      for (const profile of prepared) {
        if (!this.isReady(scope) || !this.store.state(scope).enabled) return { skipped: 'scope-changed', updated };
        if (this.scope().owner !== scope.owner || this.scope().groupId !== scope.groupId ||
            !this.sameOwnership(fresh)) return { skipped: 'ownership-changed', updated };
        const cardState = state.cards[profile.name];
        if (['unknown','attempting'].includes(cardState?.phase)) { unknown++; break; }
        const card = profile.card;
        const client = this.getClient();
        if (!client) return { skipped: 'offline', updated };
        const rotate = !cardState || this.now() - Date.parse(cardState.createdAt) >= ROTATE_MS;
        const createdAt = rotate ? new Date(this.now()).toISOString() : cardState.createdAt;
        this.store.append({ type: 'attempt', scope, profile: profile.name,
          action: rotate ? 'create' : 'patch', messageId: rotate ? null : cardState.messageId,
          at: new Date(this.now()).toISOString(), createdAt });
        try {
          const messageId = rotate ? await client.sendGroupCard({ chatId: scope.groupId, card }) :
            await client.patchGroupCard({ messageId: cardState.messageId, card });
          this.store.append({ type: 'ready', scope, profile: profile.name,
            messageId: rotate ? messageId : cardState.messageId,
            at: new Date(this.now()).toISOString(), createdAt });
          updated++;
        } catch {
          this.store.append({ type: 'unknown', scope, profile: profile.name,
            messageId: rotate ? null : cardState.messageId,
            at: new Date(this.now()).toISOString(), createdAt });
          unknown++;
          break;
        }
      }
      return { updated, unknown };
    } catch (error) {
      this.retryAfter = this.now() + 15 * 60_000;
      throw error;
    } finally { this.busy = false; }
  }
  async publishNow() {
    const scope = this.scope();
    if (!this.isReady(scope) || !this.store.state(scope).enabled) throw Error('每日用量发布未启用或群连接不可用。');
    return this.tick();
  }
}
module.exports = { DailyUsagePublisher, HOUR_MS, ROTATE_MS };
