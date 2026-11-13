'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { ToolError } = require('./service');
const { userConfig, groupRequest } = require('./group-settings-service');

const MAX_USERS = 500;
const MAX_GROUPS = 100;
const MAX_PAIRS = 5000;
const MAX_BATCH_MS = 10 * 60_000;
const PREVIEW_MS = 5 * 60_000;
const fail = (code, message) => { throw new ToolError(code, message); };
const validId = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const stable = value => JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const config = user => ({ allowed_groups: user.allowed_groups,
  restrict_public_groups: user.restrict_public_groups, group_rates: user.group_rates });
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function ids(values, max) {
  if (!Array.isArray(values) || !values.length || values.length > max ||
      values.some(value => !validId(value)) || new Set(values).size !== values.length)
    fail('INPUT', '请准确勾选用户和分组，不能重复或超过本次上限。');
  return values;
}
function thousandths(value, allowZero = true) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const result = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0') || '0');
  return !allowZero && result === 0n ? null : { units: result, precision: fraction.length };
}
function display(units, precision = 0) {
  const whole = units / 1000n, fraction = String(units % 1000n).padStart(3, '0');
  return precision ? `${whole}.${fraction.slice(0, precision)}` : String(whole);
}
function applyDelta(before, delta, direction) {
  const current = thousandths(before);
  if (!current) return null;
  const next = direction === 'add' ? current.units + delta.units : current.units - delta.units;
  if (next < 1n || next > 999999999999n) return null;
  const precision = Math.max(current.precision, delta.precision);
  return { before: display(current.units, current.precision), after: display(next, precision), rate: Number(next) / 1000 };
}
function validateRecords(rows) {
  if (!Array.isArray(rows)) fail('STORAGE', '批量倍率账本损坏，请保留原件。');
  const seen = new Set();
  for (const row of rows) {
    if (!row || row.kind !== 'bulk-group-rates' || !uuid(row.requestId) || !uuid(row.batchId) ||
        seen.has(row.requestId) || !validId(row.owner) || !validId(row.targetId) ||
        !['pending','unknown','success','failed','reviewed'].includes(row.state) ||
        !Number.isFinite(Date.parse(row.at)) || !Array.isArray(row.changes) || !row.changes.length ||
        row.changes.length > MAX_GROUPS || !groupRequest('PUT', `/admin/users/${row.targetId}`, row.before) ||
        !groupRequest('PUT', `/admin/users/${row.targetId}`, row.expected))
      fail('STORAGE', '批量倍率账本损坏，请保留原件。');
    const groupIds = new Set();
    for (const change of row.changes) {
      if (!change || !validId(change.groupId) || groupIds.has(change.groupId) ||
          !thousandths(change.before) || !thousandths(change.after, false))
        fail('STORAGE', '批量倍率账本损坏，请保留原件。');
      groupIds.add(change.groupId);
    }
    seen.add(row.requestId);
  }
  return rows;
}

class BulkGroupRatesService {
  constructor({ request, store, getOwner, otherBlocked = () => false,
    onProgress = () => {}, now = () => Date.now(), throttle = async () => {} }) {
    Object.assign(this, { request, store, getOwner, otherBlocked, onProgress, now, throttle });
    this.records = validateRecords(store.load());
    for (const row of this.records) if (row.state === 'pending') row.state = 'unknown';
    this.busy = false; this.storageFault = false; this.snapshotData = null; this.previewData = null;
  }
  blocked() { return this.storageFault || this.busy || this.otherBlocked() ||
    this.records.some(row => ['pending','unknown'].includes(row.state)); }
  async admin(expected = this.getOwner()) {
    if (!validId(expected) || this.getOwner() !== expected) fail('POLICY', '管理员身份已变化，请重新读取。');
    const me = await this.request('GET', '/auth/me');
    if (me?.id !== expected || me?.role !== 'admin' || this.getOwner() !== expected)
      fail('DENIED', '需要同一平台管理员授权。');
    return expected;
  }
  async pages(route, maxPages, maxTotal) {
    const out = [], seen = new Set(); let total;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.request('GET', route(page));
      if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
          data.total > maxTotal || data.items.length > 100 || total !== undefined && data.total !== total)
        fail('SCHEMA', '平台分页结果变化或不完整，本次未接受部分目录。');
      total = data.total;
      for (const item of data.items) {
        if (!validId(item?.id) || seen.has(item.id)) fail('SCHEMA', '平台目录出现重复或无效 ID。');
        seen.add(item.id); out.push(item);
      }
      if (out.length === total) return out;
      if (!data.items.length || out.length > total) fail('SCHEMA', '平台分页不完整，本次未接受部分目录。');
    }
    fail('LIMIT', '平台目录超过本次读取上限，请缩小范围后再操作。');
  }
  async groups() {
    const rows = await this.pages(page => `/admin/groups?page=${page}&page_size=100`, 20, 2000);
    return rows.filter(row => row.status === 'active' && row.subscription_type === 'standard').map(row => {
      if (typeof row.name !== 'string' || !row.name || typeof row.rate_multiplier !== 'number' ||
          !Number.isFinite(row.rate_multiplier) || row.rate_multiplier < 0 ||
          typeof row.is_exclusive !== 'boolean') fail('SCHEMA', '平台分组名称或倍率不完整。');
      return { id: row.id, name: row.name.slice(0, 200), rate: row.rate_multiplier,
        exclusive: row.is_exclusive, platform: typeof row.platform === 'string' ? row.platform.slice(0, 40) : '' };
    });
  }
  async snapshot() {
    if (this.busy) fail('BUSY', '正在读取或处理批量倍率。');
    this.snapshotData = null; this.previewData = null;
    this.busy = true;
    try {
      const owner = await this.admin();
      const groups = await this.groups();
      const directory = await this.pages(page => `/admin/users?page=${page}&page_size=100`, 50, 5000);
      const candidates = directory.filter(row => row.role === 'user' && row.status === 'active');
      if (candidates.length > MAX_USERS) fail('LIMIT', `活跃客户超过 ${MAX_USERS} 位，本次不展示不完整名单。`);
      const users = [], details = new Map();
      for (let index = 0; index < candidates.length; index++) {
        if (index > 0) await this.throttle();
        const candidate = candidates[index];
        const user = userConfig(await this.request('GET', `/admin/users/${candidate.id}`), candidate.id);
        if (user.role !== 'user' || user.email !== candidate.email || user.status !== 'active')
          fail('SCHEMA', '平台用户目录与详情不一致，请重新读取。');
        details.set(user.id, user);
        const owned = new Set(user.allowed_groups);
        users.push({ id: user.id, email: user.email, username: user.username,
          groups: groups.filter(group => owned.has(group.id)).map(group => ({ groupId: group.id, allowed: true,
            rate: user.group_rates[group.id] ?? group.rate,
            customRate: user.group_rates[group.id] ?? null })) });
        this.onProgress({ stage: 'users', completed: index + 1, total: candidates.length });
      }
      await this.admin(owner);
      // The list has to remain stable across a long sequence of detail requests.
      const fresh = await this.pages(page => `/admin/users?page=${page}&page_size=100`, 50, 5000);
      const current = fresh.filter(row => row.role === 'user' && row.status === 'active');
      if (stable(current.map(row => [row.id, row.email]).sort((a,b) => a[0]-b[0])) !==
          stable(candidates.map(row => [row.id, row.email]).sort((a,b) => a[0]-b[0])))
        fail('CONFLICT', '读取期间平台用户目录已变化，请重新读取。');
      const checkedAt = new Date(this.now()).toISOString();
      this.snapshotData = { owner, groups, users, details, checkedAt, at: this.now() };
      this.previewData = null;
      return { owner, groups, users, checkedAt,
        blocked: this.storageFault || this.otherBlocked() ||
          this.records.some(row => ['pending','unknown'].includes(row.state)),
        omittedInactive: directory.filter(row => row.role === 'user' && row.status !== 'active').length };
    } finally { this.busy = false; }
  }
  preview(input) {
    if (this.busy) fail('BUSY', '正在读取或处理批量倍率。');
    const source = this.snapshotData;
    if (!source || this.getOwner() !== source.owner || this.now() - source.at > 10 * 60_000)
      fail('CONFLICT', '用户目录已过期，请重新读取。');
    if (!exact(input, ['userIds','groupIds','direction','amount']) ||
        !['add','subtract'].includes(input.direction)) fail('INPUT', '请先选择加减方向、用户和分组。');
    const userIds = ids(input.userIds, MAX_USERS), groupIds = ids(input.groupIds, MAX_GROUPS);
    if (userIds.length * groupIds.length > MAX_PAIRS)
      fail('LIMIT', `本次用户与分组组合超过 ${MAX_PAIRS} 项，请缩小选择后分批预览。`);
    const delta = thousandths(input.amount, false);
    if (!delta) fail('INPUT', '调整值须为正数，最多三位小数。');
    const byGroup = new Map(source.groups.map(row => [row.id, row]));
    const byUser = new Map(source.users.map(row => [row.id, row]));
    if (groupIds.some(groupId => !byGroup.has(groupId)) || userIds.some(userId => !byUser.has(userId)))
      fail('CONFLICT', '分组或用户已不在已读取目录中，请刷新。');
    const changes = [], skipped = [];
    for (const userId of userIds) {
      const user = byUser.get(userId), owned = new Map(user.groups.map(row => [row.groupId, row]));
      for (const groupId of groupIds) {
        const group = byGroup.get(groupId), current = owned.get(groupId);
        if (!current) { skipped.push({ userId, groupId, reason: 'not-allowed' }); continue; }
        const change = applyDelta(current.rate, delta, input.direction);
        if (!change) { skipped.push({ userId, groupId, reason: 'out-of-range' }); continue; }
        changes.push({ userId, groupId, before: change.before, after: change.after });
      }
    }
    const previewId = changes.length ? randomUUID() : null;
    const expiresAt = new Date(this.now() + PREVIEW_MS).toISOString();
    this.previewData = previewId ? { previewId, owner: source.owner, groups: source.groups,
      users: source.users, details: source.details, changes, skipped, expiresAt: Date.parse(expiresAt) } : null;
    return { previewId, changes, skipped, expiresAt };
  }
  save(rows) {
    try { validateRecords(rows); this.store.save(rows); this.records = rows; }
    catch { this.storageFault = true; fail('STORAGE', '批量倍率记录未安全保存，已停止修改，请保留原件。'); }
  }
  patch(requestId, state) { this.save(this.records.map(row => row.requestId === requestId ? { ...row, state } : row)); }
  async commit(input) {
    if (this.busy || this.storageFault) fail('BUSY', '批量倍率正在处理或存储异常。');
    if (this.records.some(row => ['pending','unknown'].includes(row.state)) || this.otherBlocked())
      fail('UNKNOWN', '已有分组设置结果待核对或其他倍率操作正在进行。');
    if (!exact(input, ['previewId']) || !uuid(input.previewId) ||
        this.previewData?.previewId !== input.previewId || this.now() >= this.previewData.expiresAt)
      fail('CONFLICT', '预览已过期或已提交，请重新读取并预览。');
    const preview = this.previewData; this.previewData = null; this.busy = true;
    const result = { updated: 0, skipped: preview.skipped.length, failed: 0, unknown: 0,
      stopped: false, results: [] };
    try {
      const owner = await this.admin(preview.owner);
      const freshGroups = await this.groups();
      if (digest(freshGroups) !== digest(preview.groups)) fail('CONFLICT', '分组目录或默认倍率已变化，请重新预览。');
      const started = this.now();
      const byUser = new Map(preview.users.map(row => [row.id, row]));
      const perUser = new Map();
      for (const change of preview.changes) {
        const rows = perUser.get(change.userId) || []; rows.push(change); perUser.set(change.userId, rows);
      }
      for (const [targetId, changes] of perUser) {
        if (this.now() - started >= MAX_BATCH_MS) {
          result.stopped = true; result.results.push({ userId: targetId, status: 'time-limit' }); break;
        }
        let requestId = null, pending = false, attempted = false;
        try {
          if (this.otherBlocked() || this.records.some(row => ['pending','unknown'].includes(row.state)))
            fail('UNKNOWN', '有其他分组设置或结果不明记录，已停止后续修改。');
          await this.admin(owner);
          const current = userConfig(await this.request('GET', `/admin/users/${targetId}`), targetId);
          if (current.role !== 'user' || digest(current) !== digest(preview.details.get(targetId)) ||
              this.getOwner() !== owner) fail('CONFLICT', '用户倍率或授权已变化，已停止后续修改。');
          const rates = { ...current.group_rates };
          for (const change of changes) {
            if (!current.allowed_groups.includes(change.groupId))
              fail('CONFLICT', '目标分组已不再授权给用户，已停止后续修改。');
            rates[change.groupId] = Number(change.after);
          }
          const body = { allowed_groups: [...current.allowed_groups],
            restrict_public_groups: current.restrict_public_groups, group_rates: rates };
          if (!groupRequest('PUT', `/admin/users/${targetId}`, body))
            fail('INPUT', '倍率更新参数未通过平台白名单校验。');
          const expected = config(userConfig({ ...current, ...body }, targetId));
          await this.admin(owner);
          requestId = randomUUID();
          this.save([...this.records, { kind: 'bulk-group-rates', batchId: input.previewId,
            requestId, owner, targetId, state: 'pending', at: new Date(this.now()).toISOString(),
            changes: changes.map(row => ({ groupId: row.groupId, before: row.before, after: row.after })),
            before: config(current), expected }]);
          pending = true;
          if (this.otherBlocked() || this.getOwner() !== owner)
            fail('POLICY', '身份或其他倍率操作已变化，未发送当前更新。');
          attempted = true;
          await this.request('PUT', `/admin/users/${targetId}`, body,
            { owner, guard: () => !this.otherBlocked() && this.getOwner() === owner,
              groupSettings: true, bulkRates: true });
          const actual = userConfig(await this.request('GET', `/admin/users/${targetId}`), targetId);
          if (stable(config(actual)) !== stable(expected)) fail('UNKNOWN', '平台回读不一致，结果待核对。');
          this.patch(requestId, 'success');
          result.updated++; result.results.push({ userId: targetId, status: 'success', groupIds: changes.map(row => row.groupId) });
          this.onProgress({ stage: 'updated', completed: result.updated, total: perUser.size });
        } catch (error) {
          if (pending && !this.storageFault) this.patch(requestId, attempted ? 'unknown' : 'failed');
          if (attempted) result.unknown++; else result.failed++;
          result.stopped = true;
          result.results.push({ userId: targetId, status: attempted ? 'unknown' : 'failed',
            code: error instanceof ToolError ? error.code : 'OPERATION_ERROR', requestId });
          break;
        }
      }
      return result;
    } finally { this.busy = false; }
  }
  history() {
    return this.records.filter(row => row.owner === this.getOwner()).slice(-100).reverse().map(row => ({
      requestId: row.requestId, batchId: row.batchId, targetId: row.targetId,
      state: row.state, at: row.at }));
  }
  async review(requestId) {
    if (this.busy || this.storageFault) fail('BUSY', '批量倍率记录正在处理或存储异常。');
    this.busy = true;
    try {
      const owner = await this.admin();
      const row = this.records.find(item => item.requestId === requestId && item.owner === owner &&
        ['pending','unknown'].includes(item.state));
      if (!row) fail('INPUT', '没有属于当前管理员的待核对记录。');
      const current = userConfig(await this.request('GET', `/admin/users/${row.targetId}`), row.targetId);
      await this.admin(owner);
      if (stable(config(current)) !== stable(row.expected))
        fail('UNKNOWN', '平台当前倍率与预期不一致，未自动重试；请在平台人工核对。');
      this.patch(requestId, 'success');
      return this.history();
    } finally { this.busy = false; }
  }
}
module.exports = { BulkGroupRatesService, thousandths, applyDelta, validateRecords };
