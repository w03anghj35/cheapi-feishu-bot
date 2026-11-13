'use strict';
const { createHash } = require('node:crypto');
const { beijingDay } = require('./daily-usage');
const { dailyUsageCard, retiredDailyUsageCard } = require('./daily-usage-card');
const { historyCatalog, historyWeek } = require('./daily-usage-history');
const { exportRows } = require('./daily-usage-export');
const { projectSnapshots } = require('./ownership-dates');
const { validScope, validDailyTime } = require('./daily-usage-store');

const HOUR_MS = 60 * 60_000;
const ROTATE_MS = 10 * 24 * HOUR_MS;
const BACKFILL_BUDGET_MS = 10 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const DAILY_WINDOW_MS = 15 * 60_000;
const MAX_UNFINISHED_DAYS_PER_TICK = 2;
const UNFINISHED_BUDGET_MS = 120_000;
const yesterday = day => new Date(Date.parse(`${day}T00:00:00Z`) - 24 * HOUR_MS).toISOString().slice(0, 10);
const tomorrow = day => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const publishedToday = (card, day) => card?.phase === 'ready' && Number.isFinite(Date.parse(card.at)) &&
  beijingDay(Date.parse(card.at)) === day;
function dailyDueAt(day, dailyTime) {
  if (!validDailyTime(dailyTime)) return null;
  return Date.parse(`${day}T${dailyTime}:00+08:00`);
}
function groupFailure(error) {
  const status = error?.response?.status;
  const code = error?.feishuCode ?? error?.response?.data?.code;
  const kind = ['local', 'api', 'http', 'timeout', 'network', 'receipt'].includes(error?.groupDeliveryKind) ?
    error.groupDeliveryKind : Number.isSafeInteger(code) && code > 0 ? 'api' :
      Number.isInteger(status) ? 'http' : ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code) ? 'timeout' :
        ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK'].includes(error?.code) ? 'network' : 'unknown';
  return { kind,
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
    ...(Number.isSafeInteger(code) && code >= 0 && code <= 999999999 ? { apiCode: code } : {}) };
}
class DailyUsagePublisher {
  constructor({ usage, store, getScope, getClient, isReady, canCollect = () => true, now = () => Date.now() }) {
    Object.assign(this, { usage, store, getScope, getClient, isReady, canCollect, now });
    this.busy = false; this.retryAfter = 0; store.load();
    this.historyRetryAfter = 0; this.historyAttemptAt = null; this.historyFailure = null;
    this.backfill = { phase: 'idle', completed: 0, skipped: 0, total: 0, day: null };
    this.accountBackfill = { phase: 'idle', completed: 0, skipped: 0, total: 0, day: null };
  }
  scope() { const scope = this.getScope(); if (!scope) throw Error('平台管理员与目标群尚未就绪。'); return scope; }
  sameOwnership(fresh) {
    const current = fresh?.day && this.usage.ownership?.profilesAt ?
      this.usage.ownership.profilesAt(fresh.day) : this.usage.ownership?.profiles?.();
    return Array.isArray(current) && JSON.stringify(current) === JSON.stringify(fresh.rows.map(row => ({
      name: row.name, userIds: row.users.map(user => user.id)
    })));
  }
  state() {
    const scope = this.scope(), state = this.store.state(scope);
    const today = beijingDay(this.now());
    const pendingDays = Object.keys(state.snapshots).filter(day => day < today && !state.snapshots[day].final).sort();
    const manualDays = pendingDays.filter(day => day < yesterday(today) && !this.sameOwnership(state.snapshots[day]));
    return { enabled: state.enabled, days: state.days, dailyTime: state.dailyTime,
      effectiveDay: state.effectiveDay,
      groupRef: createHash('sha256').update(scope.groupId).digest('hex').slice(0, 8),
      collection: { available: this.canCollect(scope), attemptAt: this.historyAttemptAt,
        busy: this.busy || this.usage.busy,
        retryAfter: this.historyRetryAfter > this.now() ? new Date(this.historyRetryAfter).toISOString() : null,
        failure: this.historyFailure, pendingDays, manualDays },
      lastDay: Object.keys(state.snapshots).sort().at(-1) || null,
      cards: Object.entries(state.cards).map(([name, card]) => ({ name, phase: card.phase,
        action: card.action || null, at: card.at, attemptedAt: card.attemptedAt || card.at,
        failure: card.failure || null })),
      lastCheckedAt: Object.values(state.snapshots).sort((a,b) => a.checkedAt.localeCompare(b.checkedAt)).at(-1)?.checkedAt || null };
  }
  reviewCandidate(input) {
    if (this.busy || this.usage.busy) throw Error('已有每日用量任务，稍后再核对。');
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'at,confirmed,name' || input.confirmed !== true ||
        typeof input.name !== 'string' || typeof input.at !== 'string') throw Error('核对参数无效。');
    const scope = this.scope();
    const cards = this.store.state(scope).cards;
    const card = Object.hasOwn(cards, input.name) ? cards[input.name] : null;
    if (!card || !['unknown', 'attempting'].includes(card.phase) || card.action !== 'create' ||
        card.messageId !== null || card.at !== input.at)
      throw Error('这笔首次群卡片记录已变化或不能按未送达核对。');
    return { scope, name: input.name, at: card.at, attemptedAt: card.attemptedAt || card.at };
  }
  reviewAbsent(input) {
    const candidate = this.reviewCandidate(input);
    this.store.append({ type: 'reviewed-absent', scope: candidate.scope, profile: candidate.name,
      originalAt: candidate.at, at: new Date(this.now()).toISOString() });
    return this.state();
  }
  historyCatalog() {
    const scope = this.scope();
    const names = this.usage.ownership?.profiles?.().map(row => row.name) || [];
    const catalog = historyCatalog(this.store.state(scope), names, beijingDay(this.now()));
    catalog.accountsByPerson = Object.fromEntries(names.map(name => [name,
      this.usage.ownership?.profileAccounts?.(name) || []]));
    return catalog;
  }
  async accountOptions(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).join(',') !== 'name' || typeof input.name !== 'string')
      throw Error('请选择有效的归属人。');
    const ownership = this.usage.ownership;
    if (!ownership?.admin || !ownership?.users || !ownership?.profiles)
      throw Error('用户归属目录暂不可读取。');
    const scope = this.scope();
    const verified = await ownership.admin();
    if (verified.owner !== scope.owner || verified.groupId !== scope.groupId)
      throw Error('管理员或目标群已变化，请重新读取。');
    const profiles = ownership.profiles();
    const current = profiles.find(row => row.name === input.name);
    if (!current || !Array.isArray(current.userIds)) throw Error('所选归属人不存在，请重新读取。');
    const users = await ownership.users();
    const after = await ownership.admin();
    if (after.owner !== scope.owner || after.groupId !== scope.groupId ||
        JSON.stringify(ownership.profiles()) !== JSON.stringify(profiles) ||
        this.scope().owner !== scope.owner || this.scope().groupId !== scope.groupId)
      throw Error('管理员、目标群或归属已变化，请重新读取。');
    const directory = new Map(users.filter(user => user.role === 'user').map(user => [user.id, user]));
    if (current.userIds.some(id => !directory.has(id)))
      throw Error('当前归属账号不在平台普通用户目录中，请重新核对。');
    return { name: current.name,
      accounts: current.userIds.map(id => ({ id, email: directory.get(id).email,
        username: directory.get(id).username })) };
  }
  historyWeek(input) {
    const scope = this.scope();
    const profiles = this.usage.ownership?.profiles?.() || [];
    const names = profiles.map(row => row.name);
    const accounts = this.usage.ownership?.profileAccounts?.(input?.name) ||
      profiles.find(row => row.name === input?.name)?.userIds.map(id => ({ id, email: null })) || [];
    return historyWeek(this.store.state(scope), input || {}, beijingDay(this.now()), names, accounts,
      this.usage.ownership?.datedProfiles?.() || []);
  }
  historyExport(input) {
    const scope = this.scope();
    const names = this.usage.ownership?.profiles?.().map(row => row.name) || [];
    return exportRows(this.store.state(scope), input, beijingDay(this.now()), names, this.usage.ownership?.datedProfiles?.() || []);
  }
  async collectToday() { return this.historyTick({ todayOnly: true }); }
  async historyTick({ todayOnly = false } = {}) {
    if (this.busy || this.usage.busy) return { skipped: 'busy' };
    if (this.now() < Math.max(this.retryAfter, this.historyRetryAfter)) return { skipped: 'backoff' };
    let scope;
    try { scope = this.scope(); } catch { return { skipped: 'scope' }; }
    if (!validScope(scope) || !this.canCollect(scope)) return { skipped: 'authorization' };
    let profiles;
    try { profiles = this.usage.ownership?.profiles?.(); }
    catch { return { skipped: 'scope' }; }
    const today = beijingDay(this.now()), previous = yesterday(today);
    if (!Array.isArray(profiles) || (!profiles.some(row => row.userIds?.length) &&
        !this.usage.ownership?.profilesAt?.(previous).some(row => row.userIds?.length))) return { skipped: 'no-users' };
    const state = this.store.state(scope);
    const needsPrevious = !todayOnly && !state.snapshots[previous]?.final;
    const current = state.snapshots[today];
    // Membership changes invalidate today's sample even within the hourly interval.
    // Closed-day snapshots retain their historical assignments and are never invalidated here.
    const needsToday = todayOnly || !current || !this.sameOwnership(current) ||
      this.now() - Date.parse(current.checkedAt) >= HOUR_MS;
    // Only finish dates already present in this scope, never expand into unknown history.
    // A changed assignment needs an explicit review rather than replacing old owners/accounts.
    const unfinishedDays = todayOnly ? [] : Object.keys(state.snapshots).filter(day => day < previous &&
      !state.snapshots[day].final && this.sameOwnership(state.snapshots[day])).sort().slice(0, MAX_UNFINISHED_DAYS_PER_TICK);
    if (!needsPrevious && !needsToday && !unfinishedDays.length) return { skipped: 'not-due' };
    this.busy = true;
    this.historyAttemptAt = new Date(this.now()).toISOString();
    let stage = 'yesterday';
    let unfinishedStartedAt = null;
    const saved = [];
    try {
      for (const day of [needsPrevious ? previous : null, needsToday ? today : null, ...unfinishedDays].filter(Boolean)) {
        const unfinished = day < previous;
        stage = unfinished ? 'unfinished' : day === previous ? 'yesterday' : 'today';
        if (beijingDay(this.now()) !== today) throw Error('day changed');
        if (day < today && this.store.state(scope).snapshots[day]?.final) continue;
        if (unfinished) {
          unfinishedStartedAt ??= this.now();
          if (this.now() - unfinishedStartedAt >= UNFINISHED_BUDGET_MS) break;
          if (!this.sameOwnership(this.store.state(scope).snapshots[day])) throw Error('historical ownership changed');
        }
        const result = await this.usage.read(day);
        const active = this.scope();
        if (!this.canCollect(active) || active.owner !== scope.owner || active.groupId !== scope.groupId ||
            result.scope.owner !== scope.owner || result.scope.groupId !== scope.groupId ||
            result.day !== day || beijingDay(this.now()) !== today ||
            (day < today && result.final !== true) || !this.sameOwnership(result) ||
            JSON.stringify(this.usage.ownership.profiles()) !== JSON.stringify(profiles))
          throw Error('scope changed');
        this.store.append({ type: 'snapshot', scope, day, checkedAt: result.checkedAt,
          final: result.final, ...(day < today ? { source: 'backfill-current-ownership' } : {}),
          rows: result.rows.map(row => ({ name: row.name,
            users: row.users.map(user => ({ id: user.id, email: user.email, cost: user.cost })) })) });
        saved.push(day);
      }
      this.historyFailure = null;
      this.historyRetryAfter = 0;
      return { saved };
    } catch {
      this.historyFailure = stage;
      this.historyRetryAfter = this.now() + 15 * 60_000;
      return { saved, failed: stage };
    } finally { this.busy = false; }
  }
  backfillStatus() { return { ...this.backfill }; }
  accountBackfillStatus() { return { ...this.accountBackfill }; }
  async backfillAccountCurrentMonth(input) {
    if (this.busy || this.usage.busy) throw Error('已有每日用量任务，请稍后再补采。');
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'name,userId' ||
        typeof input.name !== 'string' || !Number.isSafeInteger(input.userId) || input.userId <= 0)
      throw Error('请选择有效的归属人和平台账号。');
    const scope = this.scope();
    if (!validScope(scope) || !this.canCollect(scope)) throw Error('请先恢复平台管理员授权与目标群绑定。');
    const profiles = this.usage.ownership?.profiles?.();
    if (!Array.isArray(profiles) || !profiles.some(row => row.name === input.name && row.userIds.includes(input.userId)))
      throw Error('所选账号已不在当前归属中，请重新读取。');
    if (typeof this.usage.readAccount !== 'function') throw Error('单账号读取不可用。');
    const today = beijingDay(this.now()), month = today.slice(0, 7);
    const first = Date.parse(`${month}-01T00:00:00Z`);
    const end = Date.parse(`${today}T00:00:00Z`);
    const days = [];
    for (let at = first; at < end; at += DAY_MS) days.push(new Date(at).toISOString().slice(0, 10));
    this.busy = true;
    this.accountBackfill = { phase: 'running', month, name: input.name, userId: input.userId,
      completed: 0, skipped: 0, total: days.length, day: null };
    const started = this.now();
    try {
      for (const day of days) {
        this.accountBackfill.day = day;
        if (this.now() - started >= BACKFILL_BUDGET_MS) { this.accountBackfill.phase = 'limited'; break; }
        const state = this.store.state(scope);
        const visible = projectSnapshots({ snapshots: state.snapshots[day] ? { [day]: state.snapshots[day] } : {} },
          this.usage.ownership?.datedProfiles?.() || []).snapshots[day];
        if (visible?.rows.some(row => row.name === input.name &&
            row.users.some(user => user.id === input.userId)) ||
            state.supplements?.[day]?.[input.name]?.[input.userId]) {
          this.accountBackfill.skipped++; continue;
        }
        const otherOwner = visible?.rows.some(row => row.name !== input.name &&
          row.users.some(user => user.id === input.userId)) ||
          Object.entries(state.supplements?.[day] || {}).some(([name, accounts]) =>
            name !== input.name && Object.hasOwn(accounts, input.userId));
        if (otherOwner) {
          this.accountBackfill.phase = 'failed';
          this.accountBackfill.message = '该账号在当前日期已有其他归属的用量记录；为防止重复合计，本次停止，请先人工核对。';
          return this.accountBackfillStatus();
        }
        const result = await this.usage.readAccount(day, input.name, input.userId);
        const current = this.scope();
        if (!this.canCollect(current) || current.owner !== scope.owner || current.groupId !== scope.groupId ||
            result.scope.owner !== scope.owner || result.scope.groupId !== scope.groupId ||
            result.day !== day || result.name !== input.name || result.user.id !== input.userId ||
            beijingDay(this.now()) !== today ||
            JSON.stringify(this.usage.ownership.profiles()) !== JSON.stringify(profiles))
          throw Error('管理员、目标群、归属或日期已变化。');
        this.store.append({ type: 'account-backfill', scope, day, profile: input.name,
          checkedAt: result.checkedAt, user: result.user });
        this.accountBackfill.completed++;
      }
      if (this.accountBackfill.phase === 'running') this.accountBackfill.phase = 'done';
      return this.accountBackfillStatus();
    } catch {
      this.accountBackfill.phase = 'failed';
      this.accountBackfill.message = '单账号补采在当前日期停止；此前成功日期已保留。请核对管理员授权、归属和平台读取后再续采。';
      return this.accountBackfillStatus();
    } finally { this.busy = false; }
  }
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
  setEnabled(enabled, dailyTime) {
    if (typeof enabled !== 'boolean') throw Error('开关参数无效。');
    const scope = this.scope();
    const existing = this.store.state(scope);
    const selectedTime = dailyTime === undefined ? existing.dailyTime : dailyTime;
    if (enabled && !validDailyTime(selectedTime)) throw Error('请先设置北京时间每日发送时间。');
    if (dailyTime !== undefined && !validDailyTime(dailyTime)) throw Error('每日发送时间格式无效。');
    if (enabled && Object.values(existing.cards).some(card => ['unknown','attempting'].includes(card.phase)))
      throw Error('有群卡片发送结果待核对，不能重新启用或重复发送。');
    if (enabled && !this.isReady(scope)) throw Error('须先确认同一平台管理员、飞书已连接、目标群已绑定且群策略开启。');
    const today = beijingDay(this.now());
    const effectiveDay = enabled ? this.now() < dailyDueAt(today, selectedTime) ? today : tomorrow(today) :
      existing.effectiveDay;
    this.store.append({ type: 'config', scope, enabled, days: 3, dailyTime: selectedTime,
      effectiveDay });
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
  async retireAbsentProfiles(scope, state, profiles) {
    const names = new Set(profiles.filter(profile => profile.userIds?.length).map(profile => profile.name));
    const stale = Object.entries(state.cards).filter(([name, card]) => card.phase === 'ready' && !names.has(name));
    if (!stale.length) return null;
    this.busy = true;
    let updated = 0, unknown = 0;
    try {
      for (const [name, previous] of stale) {
        if (!this.isReady(scope) || !this.store.state(scope).enabled ||
            this.scope().owner !== scope.owner || this.scope().groupId !== scope.groupId ||
            JSON.stringify(this.usage.ownership.profiles()) !== JSON.stringify(profiles))
          return { skipped: 'scope-changed', updated };
        const client = this.getClient();
        if (!client) return { skipped: 'offline', updated };
        const at = new Date(this.now()).toISOString();
        this.store.append({ type: 'attempt', scope, profile: name, action: 'patch',
          messageId: previous.messageId, at, createdAt: previous.createdAt });
        try {
          await client.patchGroupCard({ messageId: previous.messageId,
            card: retiredDailyUsageCard(name, at) });
          this.store.append({ type: 'retired', scope, profile: name, messageId: previous.messageId,
            at: new Date(this.now()).toISOString(), createdAt: previous.createdAt });
          updated++;
        } catch (error) {
          this.store.append({ type: 'unknown', scope, profile: name, messageId: previous.messageId,
            at: new Date(this.now()).toISOString(), createdAt: previous.createdAt,
            failure: groupFailure(error) });
          unknown++;
          break;
        }
      }
      return { updated, unknown };
    } finally { this.busy = false; }
  }
  async tick() {
    if (this.busy) return { skipped: 'busy' };
    let scope;
    try { scope = this.scope(); } catch { return { skipped: 'scope' }; }
    let state = this.store.state(scope);
    if (!state.enabled || !this.isReady(scope)) return { skipped: 'disabled-or-offline' };
    const today = beijingDay(this.now());
    const unresolved = Object.values(state.cards).filter(card => ['unknown','attempting'].includes(card.phase));
    if (unresolved.length) return { skipped: 'message-result-unknown', count: unresolved.length };
    let profiles;
    try { profiles = this.usage.ownership?.profiles?.(); }
    catch { return { skipped: 'ownership-unavailable' }; }
    if (!Array.isArray(profiles) || profiles.some(profile => !profile ||
        typeof profile.name !== 'string' || !Array.isArray(profile.userIds)))
      return { skipped: 'ownership-unavailable' };
    const retired = await this.retireAbsentProfiles(scope, state, profiles);
    if (retired) return retired;
    if (this.now() < this.retryAfter) return { skipped: 'backoff' };
    const dueAt = dailyDueAt(today, state.dailyTime);
    if (dueAt === null || !state.effectiveDay) return { skipped: 'daily-time-unset' };
    if (today < state.effectiveDay) return { skipped: 'schedule-not-effective' };
    const scheduledTime = state.dailyTime;
    const scheduledEffectiveDay = state.effectiveDay;
    if (this.now() < dueAt || this.now() >= dueAt + DAILY_WINDOW_MS)
      return { skipped: 'outside-daily-window' };
    const pendingCard = profiles.some(profile => profile.userIds?.length && !publishedToday(state.cards[profile.name], today));
    if (!pendingCard) return { skipped: 'not-due' };
    this.busy = true;
    try {
      const previous = yesterday(today);
      if (!state.snapshots[previous]?.final) {
        const final = await this.usage.read(previous);
        if (!this.isReady(scope) || !this.store.state(scope).enabled ||
            this.store.state(scope).dailyTime !== scheduledTime ||
            this.store.state(scope).effectiveDay !== scheduledEffectiveDay ||
            final.scope.owner !== scope.owner || final.scope.groupId !== scope.groupId) return { skipped: 'scope-changed' };
        this.store.append({ type: 'snapshot', scope, day: previous, checkedAt: final.checkedAt,
          final: true, source: 'backfill-current-ownership', rows: final.rows.map(row => ({ name: row.name,
            users: row.users.map(user => ({ id: user.id, email: user.email, cost: user.cost })) })) });
      }
      const fresh = await this.usage.read(today);
      if (!this.isReady(scope) || !this.store.state(scope).enabled ||
          this.store.state(scope).dailyTime !== scheduledTime ||
          this.store.state(scope).effectiveDay !== scheduledEffectiveDay ||
          fresh.scope.owner !== scope.owner || fresh.scope.groupId !== scope.groupId) return { skipped: 'scope-changed' };
      if (beijingDay(this.now()) !== today) return { skipped: 'day-changed' };
      this.store.append({ type: 'snapshot', scope, day: today, checkedAt: fresh.checkedAt,
        final: false, rows: fresh.rows.map(row => ({ name: row.name,
          users: row.users.map(user => ({ id: user.id, email: user.email, cost: user.cost })) })) });
      state = this.store.state(scope);
      if (!this.store.state(scope).enabled || !this.isReady(scope)) return { skipped: 'scope-changed' };
      if (state.dailyTime !== scheduledTime || state.effectiveDay !== scheduledEffectiveDay)
        return { skipped: 'schedule-changed' };
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
      for (const profile of prepared) {
        if (beijingDay(this.now()) !== today) return { skipped: 'day-changed', updated };
        if (this.now() >= dueAt + DAILY_WINDOW_MS) return { skipped: 'daily-window-expired', updated };
        if (!this.isReady(scope) || !this.store.state(scope).enabled) return { skipped: 'scope-changed', updated };
        if (this.store.state(scope).dailyTime !== scheduledTime ||
            this.store.state(scope).effectiveDay !== scheduledEffectiveDay)
          return { skipped: 'schedule-changed', updated };
        if (this.scope().owner !== scope.owner || this.scope().groupId !== scope.groupId ||
            !this.sameOwnership(fresh)) return { skipped: 'ownership-changed', updated };
        const cardState = state.cards[profile.name];
        if (['unknown','attempting'].includes(cardState?.phase)) { unknown++; break; }
        if (publishedToday(cardState, today)) continue;
        const card = profile.card;
        const client = this.getClient();
        if (!client) return { skipped: 'offline', updated };
        const rotate = !cardState || cardState.phase === 'reviewed-absent' ||
          this.now() - Date.parse(cardState.createdAt) >= ROTATE_MS;
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
        } catch (error) {
          this.store.append({ type: 'unknown', scope, profile: profile.name,
            messageId: rotate ? null : cardState.messageId,
            at: new Date(this.now()).toISOString(), createdAt, failure: groupFailure(error) });
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
module.exports = { DailyUsagePublisher, groupFailure, HOUR_MS, ROTATE_MS };
