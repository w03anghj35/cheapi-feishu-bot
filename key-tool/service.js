'use strict';
const { createHash } = require('node:crypto');
const { customerName, validateCatalog } = require('./group-catalog');
const history = require('./operation-history');
const { failureDiagnostic } = require('./create-diagnostics');

class ToolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function positive(value, label) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' ||
      !Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new ToolError('INPUT', `${label}必须是大于 0 的数字，不能留空或设为无限额度。`);
  }
  return Number(value);
}
function normalizeGroups(raw) {
  if (!Array.isArray(raw)) throw new ToolError('SCHEMA', '分组响应格式变化，已停止创建。');
  const seen = new Set();
  return raw.map(g => {
    const id = Number(g.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || typeof g.name !== 'string') {
      throw new ToolError('SCHEMA', '分组数据不完整，请在平台确认。');
    }
    seen.add(id);
    return { id, name: g.name, description: String(g.description || ''),
      platform: String(g.platform || ''), rate: g.rate_multiplier ?? null };
  });
}
function validate(input, groups) {
  if (!input || typeof input !== 'object') throw new ToolError('INPUT', '请填写创建参数。');
  if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) {
    throw new ToolError('INPUT', '操作编号无效，请重新打开工具。');
  }
  const group = groups.find(g => g.id === Number(input.groupId));
  if (!group) throw new ToolError('INPUT', '必须点击选择一个当前可用分组。');
  const quota = positive(input.quota, '额度');
  const label = String(input.name || '飞书令牌').trim();
  if (!label || label.length > 60 || /[\x00-\x1f\x7f]/.test(label)) {
    throw new ToolError('INPUT', '名称需为 1–60 个字符，不能包含控制字符。');
  }
  const body = { name: `${label} [${input.requestId}]`, group_id: group.id, quota };
  if (input.days !== '' && input.days !== null && input.days !== undefined) {
    const days = positive(input.days, '有效天数');
    if (!Number.isSafeInteger(days) || days > 3650) throw new ToolError('INPUT', '有效期需为 1–3650 的整数天。');
    body.expires_in_days = days;
  }
  return body;
}
function keyResult(raw, body) {
  if (!raw || !Number.isSafeInteger(Number(raw.id)) || Number(raw.id) <= 0 ||
      typeof raw.key !== 'string' || !raw.key.trim() || /[\s*•…]/.test(raw.key)) {
    throw new ToolError('UNKNOWN', '平台可能已创建，但未返回完整密钥。请先核对平台，不能重复创建。');
  }
  return { id: Number(raw.id), key: raw.key, name: body.name, groupId: body.group_id,
    quota: body.quota, days: body.expires_in_days ?? null };
}
function quotaUnits(value) {
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/.test(text)) throw new ToolError('INPUT', '飞书额度需为最多 12 位整数及 4 位小数。');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
}
function beijingDay(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time + 8 * 3600_000).toISOString().slice(0, 10) : null;
}
function validateFeishuLimits(input, context, records) {
  const actor = history.verifiedFeishuOperator(context.verifiedActor);
  const groupId = context.feishuGroupId;
  const limits = context.quotaLimits;
  if (typeof groupId !== 'string' || !/^oc_[\w-]{8,128}$/.test(groupId) || !limits ||
      typeof context.guard !== 'function' || context.guard() !== true) {
    throw new ToolError('POLICY', '飞书机器人策略未通过本机校验，未创建令牌。');
  }
  let quota, single, perUser, perGroup;
  try {
    quota = quotaUnits(input.quota); single = quotaUnits(limits.maxQuota);
    perUser = limits.maxUserDailyQuota === null ? null : quotaUnits(limits.maxUserDailyQuota);
    perGroup = limits.maxGroupDailyQuota === null ? null : quotaUnits(limits.maxGroupDailyQuota);
  } catch { throw new ToolError('POLICY', '飞书额度策略无效，未创建令牌。'); }
  if (single <= 0n || (perUser !== null && perUser < single) || (perGroup !== null && perGroup < single) || quota <= 0n || quota > single) {
    throw new ToolError('POLICY', '申请额度超过机器人策略限制，未创建令牌。');
  }
  const today = beijingDay(new Date().toISOString());
  const eligible = records.filter(r => r.feishuGroupId === groupId && r.operator?.source === 'feishu-open-id' &&
    ['pending', 'unknown', 'success', 'reviewed'].includes(r.state) && beijingDay(r.at) === today);
  const sum = rows => rows.reduce((n, row) => n + quotaUnits(row.body?.quota), 0n);
  if ((perGroup !== null && sum(eligible) + quota > perGroup) ||
      (perUser !== null && sum(eligible.filter(r => r.operator.name === actor.name)) + quota > perUser)) {
    throw new ToolError('BUDGET', '已达到个人或全群当日额度上限，未创建令牌。');
  }
  return actor;
}

// An injected API + durable store: reusable by a future authenticated Feishu adapter.
// Never expose this privileged service as an unauthenticated HTTP endpoint.
class KeyService {
  constructor({ request, store, catalog }) {
    this.request = request; this.store = store; this.groups = []; this.owner = null; this.busy = false;
    this.catalogStore = catalog || { load: () => [], save() { throw new Error('catalog not configured'); } };
    this.catalog = validateCatalog(this.catalogStore.load());
    this.records = store.load();
    for (const r of this.records) if (r.state === 'pending') r.state = 'unknown';
  }
  blocked() { return this.records.filter(r => ['pending', 'unknown'].includes(r.state)); }
  changed() {
    // UI notification failure must not change an already durable business outcome.
    try { this.onRecordsChanged?.(); } catch { /* next explicit refresh reads the authoritative records */ }
  }
  commit(record, patch) {
    // Keep the in-memory protection until its replacement is safely on disk.
    patch = { ...patch, updatedAt: new Date().toISOString() };
    this.store.save(this.records.map(r => r === record ? { ...r, ...patch } : r));
    Object.assign(record, patch);
    this.changed();
  }
  adminRecords(input) {
    try { return history.query(this.records, input); } catch (e) { throw new ToolError('INPUT', e.message); }
  }
  findRecord(id) {
    const r = typeof id === 'string' && this.records.find(r => r.requestId === id);
    if (!r) throw new ToolError('INPUT', '找不到此操作记录。');
    return r;
  }
  adminRecord(id) {
    const r = this.findRecord(id), detail = history.project(r);
    if (r.state === 'success' && r.result) {
      const value = this.store.open(r.result);
      detail.keyId = value.id; detail.maskedKey = history.mask(value.key);
    }
    return detail;
  }
  adminSecret(id, action = 'reveal') {
    if (this.busy) throw new ToolError('BUSY', '正在处理其他操作，请稍后查看密钥。');
    if (!['reveal', 'copy'].includes(action)) throw new ToolError('INPUT', '密钥操作无效。');
    const r = this.findRecord(id);
    if (r.state !== 'success' || !r.result) throw new ToolError('INPUT', '此操作没有已安全保存的成功密钥。');
    const value = this.store.open(r.result);
    // Persist local-admin access before disclosing the secret. Never include it in audit metadata.
    this.commit(r, { events: [...(r.events || []), history.event('admin-' + action, r.state)] });
    return value.key;
  }
  customerGroups() {
    const names = new Map(this.catalog.filter(r => r.owner === this.owner).map(r => [r.groupId, r.name]));
    return this.groups.filter(g => names.has(g.id)).map(g => ({ id: g.id, name: names.get(g.id) }));
  }
  state() { return { groups: this.customerGroups(), connected: this.owner !== null,
    unresolved: this.blocked().map(r => ({ requestId: r.requestId, name: r.body.name, quota: r.body.quota })) }; }
  adminState() {
    const names = new Map(this.catalog.filter(r => r.owner === this.owner).map(r => [r.groupId, r.name]));
    return { owner: this.owner, connected: this.owner !== null, groups: this.groups.map(g => ({ ...g, customerName: names.get(g.id) || '' })) };
  }
  async saveGroupNames(input) {
    if (this.catalogFailed) throw new ToolError('STORAGE', '分组配置写入失败，请重启检查。');
    if (this.busy) throw new ToolError('BUSY', '正在处理其他操作，请稍后保存分组。');
    if (!this.owner || input?.owner !== this.owner || !Array.isArray(input.items)) throw new ToolError('INPUT', '分组账户已变化，请重新读取。');
    const owner = this.owner;
    this.busy = true;
    try {
      if (await this.identity() !== owner) throw new ToolError('AUTH', '服务账户已变化，请重新读取分组。');
      const groups = normalizeGroups(await this.request('GET', '/groups/available'));
      const ids = new Set(), updates = new Map();
      for (const item of input.items) {
        if (!Number.isSafeInteger(item?.id) || ids.has(item.id) || !groups.some(g => g.id === item.id)) {
          throw new ToolError('INPUT', '包含重复或已不可用分组，请重新读取。');
        }
        let name;
        try { name = customerName(item.name); } catch (e) { throw new ToolError('INPUT', e.message); }
        ids.add(item.id); updates.set(item.id, name);
      }
      const next = this.catalog.filter(r => r.owner !== owner || !updates.has(r.groupId));
      for (const [groupId, name] of updates) if (name) next.push({ owner, groupId, name });
      try { validateCatalog(next); } catch { throw new ToolError('INPUT', '客户显示名称不能重复，请为每个分组设置不同名称。'); }
      try { this.catalogStore.save(next); } catch {
        // A failed fsync may leave an uncertain durable snapshot. Hide everything until restart/repair.
        this.catalogFailed = true; this.owner = null; this.groups = [];
        throw new ToolError('STORAGE', '分组配置未安全保存，客户创建已暂停；请保留配置并重启检查。');
      }
      this.catalog = next; this.groups = groups;
      return this.adminState();
    } finally { this.busy = false; }
  }
  async identity() {
    const me = await this.request('GET', '/auth/me');
    const id = Number(me?.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ToolError('AUTH', '服务尚未授权，请联系管理员。');
    return id;
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    if (this.busy) throw new ToolError('BUSY', '正在创建，请稍后再刷新。');
    if (this.catalogFailed) throw new ToolError('STORAGE', '分组配置写入失败，客户创建已暂停；请保留配置并重启检查。');
    this.busy = true;
    this.owner = null; this.groups = [];
    this.refreshing = Promise.resolve().then(async () => {
      const owner = await this.identity();
      const groups = normalizeGroups(await this.request('GET', '/groups/available'));
      this.groups = groups; this.owner = owner;
      return this.state();
    });
    try { return await this.refreshing; } finally { this.busy = false; this.refreshing = null; }
  }
  async create(input, context = {}) {
    let stage = 'admission';
    try { return await this.createAttempt(input, context, next => { stage = next; }); }
    catch (e) {
      const diagnostic = failureDiagnostic(input?.requestId, e, stage);
      try { e.createDiagnostic = diagnostic; } catch { /* telemetry must not replace the business error */ }
      try { this.onCreateFailure?.(diagnostic); } catch { /* diagnostics are not the authoritative operation ledger */ }
      throw e;
    }
  }
  async createAttempt(input, context, trace) {
    if (this.busy) throw new ToolError('BUSY', '已有创建正在执行，请勿重复点击。');
    if (!this.owner) throw new ToolError('AUTH', '服务未就绪，请刷新分组或联系管理员。');
    trace('validation');
    const body = validate(input, this.groups);
    let actor;
    try { actor = context.verifiedActor ? validateFeishuLimits(input, context, this.records) : history.operator(input.operator); }
    catch (e) { if (e instanceof ToolError) throw e; throw new ToolError('INPUT', e.message); }
    const owner = this.owner;
    const fingerprint = createHash('sha256').update(JSON.stringify({ owner, body })).digest('hex');
    const prior = this.records.find(r => r.requestId === input.requestId);
    if (prior) {
      if (prior.operator && JSON.stringify(prior.operator) !== JSON.stringify(actor)) throw new ToolError('CONFLICT', '同一操作编号不能更换操作人。');
      if (prior.fingerprint !== fingerprint) throw new ToolError('CONFLICT', '同一操作编号不能更换参数。');
      if (prior.state !== 'success') throw new ToolError('UNKNOWN', '此操作已有记录，请先核对，不会再次发送。');
    }
    if (!prior && this.blocked().length) throw new ToolError('UNKNOWN', '有创建结果待核对，已暂停新创建。');
    if (!prior && !this.customerGroups().some(g => g.id === body.group_id)) throw new ToolError('INPUT', '所选分组尚未命名发布，不能创建令牌。');
    this.busy = true;
    let record, submitted = false;
    try {
      trace('identity');
      if (await this.identity() !== owner) throw new ToolError('AUTH', '服务账户已变化，请联系管理员并重新读取分组。');
      if (prior) return this.store.open(prior.result);
      trace('groups');
      const groups = normalizeGroups(await this.request('GET', '/groups/available'));
      if (!groups.some(g => g.id === body.group_id) || !this.customerGroups().some(g => g.id === body.group_id)) {
        throw new ToolError('INPUT', '所选分组已不可用或未发布，请刷新。');
      }
      trace('policy');
      if (context.verifiedActor && context.guard() !== true) throw new ToolError('POLICY', '飞书机器人策略已变化，未创建令牌。');
      const group = groups.find(g => g.id === body.group_id);
      record = { requestId: input.requestId, owner, fingerprint, body, state: 'pending', at: new Date().toISOString(),
        operator: actor, group: { id: group.id, originalName: group.name, customerName: this.customerGroups().find(g => g.id === group.id)?.name || null,
          platform: group.platform, rate: group.rate },
        ...(context.verifiedActor ? { feishuGroupId: context.feishuGroupId, delivery: 'not-sent' } : {}),
        submission: 'possible', events: [history.event('create', 'pending')] };
      this.records.push(record);
      trace('pending-storage');
      this.store.save(this.records); // Must succeed BEFORE a non-idempotent POST.
      this.changed();
      let raw;
      submitted = true;
      trace('submission');
      try { raw = await this.request('POST', '/keys', body, { owner }); }
      catch (e) {
        const state = e.definitive ? 'failed' : 'unknown';
        this.commit(record, { state, submission: 'attempted', errorCode: history.safeCode(e),
          events: [...record.events, history.event('create-result', state, history.safeCode(e))] });
        throw e.definitive ? e : new ToolError('UNKNOWN', '创建结果未知，可能已成功。请先核对，工具不会自动重试。');
      }
      const result = keyResult(raw, body);
      trace('receipt-storage');
      this.commit(record, { result: this.store.seal(result), state: 'success', submission: 'attempted',
        receipt: { id: result.id, maskedKey: history.mask(result.key) }, events: [...record.events, history.event('create-result', 'success')] });
      return result;
    } catch (e) {
      if (record && record.state !== 'failed') {
        record.state = 'unknown';
        record.updatedAt = new Date().toISOString();
        record.submission = submitted ? 'attempted' : 'not-sent';
        record.errorCode = history.safeCode(e);
        record.events = [...(record.events || []), history.event('create-error', 'unknown', history.safeCode(e))];
        try { this.store.save(this.records); } catch { /* durable pending still prevents replay on restart */ }
        this.changed();
        if (!submitted) {
          const code = /^[A-Z_0-9]{1,32}$/.test(e.code || '') ? `（${e.code}）` : '';
          throw new ToolError('NOT_SENT', `创建请求未发送：本机操作记录保存失败${code}。请保留记录并检查存储；不会自动重试。`);
        }
        throw new ToolError('UNKNOWN', '创建回执未安全保存或不完整，请先核对平台，禁止重复提交。');
      }
      throw e;
    } finally { this.busy = false; }
  }
  recordExternalDelivery(requestId, state) {
    if (!['pending', 'sent', 'unknown'].includes(state)) throw new ToolError('INPUT', '外部交付状态无效。');
    const record = this.findRecord(requestId);
    if (record.state !== 'success' || !record.result) throw new ToolError('INPUT', '没有可安全交付的已保存成功回执。');
    this.commit(record, { delivery: state, events: [...(record.events || []), history.event('feishu-delivery', state)] });
    return true;
  }
  async reconcile(requestId) {
    if (this.busy) throw new ToolError('BUSY', '正在处理其他操作。');
    const record = this.blocked().find(r => r.requestId === requestId);
    if (!record) throw new ToolError('INPUT', '没有这个待核对操作。');
    this.busy = true;
    try {
      if (await this.identity() !== record.owner) throw new ToolError('AUTH', '请登录原创建账户进行核对。');
      const raw = await this.request('GET', '/keys?page=1&page_size=100&search=' + encodeURIComponent(record.body.name));
      if (!Array.isArray(raw?.items)) throw new ToolError('SCHEMA', '查询响应变化，请在平台人工核对。');
      const matches = raw.items.filter(k => k.name === record.body.name);
      if (matches.length !== 1) throw new ToolError('UNKNOWN', '未找到唯一记录，请在平台人工核对，暂不解除创建保护。');
      const item = matches[0];
      const result = keyResult(await this.request('GET', '/keys/' + positive(item.id, 'Key ID')), record.body);
      this.commit(record, { result: this.store.seal(result), state: 'success', errorCode: null,
        receipt: { id: result.id, maskedKey: history.mask(result.key) }, events: [...(record.events || []), history.event('reconcile', 'success')] });
      return result;
    } finally { this.busy = false; }
  }
  async acknowledge(requestId, confirmed) {
    if (!confirmed || this.busy) throw new ToolError('INPUT', '请先在平台人工核对并确认。');
    const r = this.blocked().find(r => r.requestId === requestId);
    this.busy = true;
    try {
      if (!r || await this.identity() !== r.owner) throw new ToolError('AUTH', '请使用原创建账户核对。');
      this.commit(r, { state: 'reviewed', events: [...(r.events || []), history.event('manual-review', 'reviewed')] }); return this.state();
    } finally { this.busy = false; }
  }
}
module.exports = { KeyService, ToolError, validate, normalizeGroups, keyResult, quotaUnits, validateFeishuLimits };
