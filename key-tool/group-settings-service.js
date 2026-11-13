'use strict';
const { ToolError } = require('./service');
const { customerName, validateCatalog } = require('./group-catalog');
const { createHash } = require('node:crypto');
const fail = (code, message) => { throw new ToolError(code, message); };
const id = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const stable = value => JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
function rate(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/.test(value) || Number(value) < 0.001)
    fail('INPUT', '倍率至少0.001，最多3位小数；留空使用分组默认倍率。');
  return Number(value);
}
function groupRequest(method, route, body) {
  if (method === 'GET') return /^\/admin\/groups\?page=[1-9]\d?&page_size=100$/.test(route)
    || /^\/admin\/users\/[1-9]\d*$/.test(route)
    || /^\/admin\/users\?page=[1-9]\d?&page_size=100&search=[A-Za-z0-9%_.!~*'()-]+$/.test(route);
  if (method !== 'PUT' || !/^\/admin\/users\/[1-9]\d*$/.test(route)) return false;
  if (!exact(body, ['allowed_groups', 'restrict_public_groups', 'group_rates']) ||
      typeof body.restrict_public_groups !== 'boolean' || !Array.isArray(body.allowed_groups) ||
      body.allowed_groups.some(v => !id(v)) || new Set(body.allowed_groups).size !== body.allowed_groups.length ||
      !body.group_rates || typeof body.group_rates !== 'object' || Array.isArray(body.group_rates) ||
      Object.entries(body.group_rates).some(([key, value]) => !/^[1-9]\d*$/.test(key) || !id(Number(key)) ||
        (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)))) return false;
  return id(Number(route.split('/').at(-1)));
}
function userConfig(raw, expectedId) {
  // The platform DTO uses omitempty for empty group_rates and may encode a nil slice as null.
  // Missing identity/access-mode fields are still rejected rather than guessed.
  if (raw && typeof raw === 'object') raw = { ...raw,
    group_rates: raw.group_rates ?? {}, allowed_groups: raw.allowed_groups === null ? [] : raw.allowed_groups };
  if (!raw || !id(raw.id) || (expectedId !== undefined && raw.id !== expectedId) ||
      typeof raw.email !== 'string' || !raw.email || raw.email.length > 254 || /[\x00-\x1f\x7f]/.test(raw.email) ||
      typeof raw.restrict_public_groups !== 'boolean' || !Array.isArray(raw.allowed_groups) ||
      raw.allowed_groups.some(v => !id(v)) || new Set(raw.allowed_groups).size !== raw.allowed_groups.length ||
      !raw.group_rates || typeof raw.group_rates !== 'object' || Array.isArray(raw.group_rates) ||
      !['user','admin'].includes(raw.role) || raw.status !== 'active')
    fail('SCHEMA', '用户不存在、已停用或分组响应不完整；未修改。');
  const rates = {};
  for (const key of Object.keys(raw.group_rates).sort((a,b) => Number(a)-Number(b))) {
    const value = raw.group_rates[key];
    if (!/^[1-9]\d*$/.test(key) || !id(Number(key)) ||
        (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)))
      fail('SCHEMA', '平台倍率响应无效；未修改。');
    if (value !== null) rates[key] = value;
  }
  return { id: raw.id, email: raw.email, username: typeof raw.username === 'string' ? raw.username.slice(0, 100) : '',
    role: raw.role, status: raw.status, allowed_groups: [...raw.allowed_groups].sort((a,b) => a-b),
    restrict_public_groups: raw.restrict_public_groups, group_rates: rates };
}
const config = user => ({ allowed_groups: user.allowed_groups, restrict_public_groups: user.restrict_public_groups, group_rates: user.group_rates });
function validateChanges(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 2000) fail('INPUT', '请选择已发布分组。');
  const seen = new Set();
  for (const row of changes) {
    if (!exact(row, ['groupId','allowed','rate']) || !id(row.groupId) || seen.has(row.groupId) ||
        typeof row.allowed !== 'boolean' || (row.rate !== null && (typeof row.rate !== 'number' || rate(String(row.rate)) !== row.rate)))
      fail('INPUT', '分组或倍率参数无效。');
    seen.add(row.groupId);
  }
  return changes;
}
function ledgerRows(rows) {
  if (!Array.isArray(rows)) fail('STORAGE', '分组设置记录损坏。');
  const seen = new Set();
  for (const r of rows) {
    if (!r || r.kind !== 'group-settings' || !/^[a-f0-9-]{36}$/.test(r.requestId) || seen.has(r.requestId) ||
        !id(r.owner) || !id(r.targetId) || !['pending','unknown','success','failed','reviewed'].includes(r.state) ||
        !Number.isFinite(Date.parse(r.at)) || !exact(r.body, ['userId','changes']) || r.body.userId !== r.targetId ||
        !groupRequest('PUT', `/admin/users/${r.targetId}`, r.before) || !groupRequest('PUT', `/admin/users/${r.targetId}`, r.expected))
      fail('STORAGE', '分组设置记录损坏；请保留原件。');
    validateChanges(r.body.changes); seen.add(r.requestId);
  }
  return rows;
}
class GroupSettingsService {
  constructor({ request, catalog, store, getOwner, onProgress = () => {}, otherBlocked = () => false }) {
    this.request = request; this.catalogStore = catalog; this.store = store; this.getOwner = getOwner;
    this.onProgress = onProgress;
    this.otherBlocked = otherBlocked;
    this.catalog = validateCatalog(catalog.load()); this.records = ledgerRows(store.load());
    this.groups = []; this.owner = null; this.busy = false; this.storageFault = false;
    for (const row of this.records) if (row.state === 'pending') row.state = 'unknown';
  }
  async admin(expected = this.getOwner(), guard = () => true) {
    if (!id(expected) || this.getOwner() !== expected || guard() !== true) fail('POLICY', '管理员身份或当前操作已变化。');
    const me = await this.request('GET', '/auth/me');
    if (me?.id !== expected || me?.role !== 'admin') fail('DENIED', '需要同一平台管理员授权。');
    if (this.getOwner() !== expected || guard() !== true) fail('POLICY', '管理员身份或当前操作已变化。');
    return expected;
  }
  async allPages(route, maxPages = 20) {
    const out = [], seen = new Set(); let total;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.request('GET', route(page));
      if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
          data.items.length > 100 || (total !== undefined && data.total !== total)) fail('SCHEMA', '分页结果变化或不完整，请重新读取。');
      total = data.total;
      if (total > maxPages * 100) fail('LIMIT', '结果超过本次读取上限，请缩小范围或到平台操作。');
      for (const item of data.items) {
        if (!id(item?.id) || seen.has(item.id)) fail('SCHEMA', '分页出现重复或无效ID，请重新读取。');
        seen.add(item.id); out.push(item);
      }
      if (out.length === total) return out;
      if (!data.items.length || out.length > total) fail('SCHEMA', '分页结果不完整，请重新读取。');
    }
    fail('LIMIT', '分页未完成，请到平台检查。');
  }
  async readGroups() {
    const rows = await this.allPages(page => `/admin/groups?page=${page}&page_size=100`);
    return rows.filter(g => g.subscription_type === 'standard' && g.status === 'active').map(g => {
      if (typeof g.name !== 'string' || !g.name || typeof g.is_exclusive !== 'boolean' ||
          typeof g.rate_multiplier !== 'number' || !Number.isFinite(g.rate_multiplier) || g.rate_multiplier < 0)
        fail('SCHEMA', '平台分组响应不完整。');
      return { id: g.id, name: g.name.slice(0, 200), exclusive: g.is_exclusive, rate: g.rate_multiplier,
        platform: typeof g.platform === 'string' ? g.platform.slice(0, 40) : '' };
    });
  }
  projection(groups, owner) {
    const names = new Map(this.catalog.filter(r => r.owner === owner).map(r => [r.groupId, r.name]));
    return groups.filter(g => names.has(g.id)).map(g => ({ id: g.id, name: names.get(g.id), exclusive: g.exclusive, rate: g.rate }));
  }
  async refresh() {
    if (this.busy || this.storageFault) fail('BUSY', '分组设置忙碌或记录异常。');
    this.busy = true;
    try { this.onProgress('identity'); const owner = await this.admin(); this.onProgress('groups'); const groups = await this.readGroups();
      this.onProgress('recheck-identity'); await this.admin(owner);
      this.groups = groups; this.owner = owner; return this.state();
    } finally { this.busy = false; }
  }
  state() {
    const owner = this.getOwner() === this.owner ? this.owner : null;
    return { owner, groups: owner ? this.groups.map(g => ({ ...g,
      displayName: this.catalog.find(r => r.owner === owner && r.groupId === g.id)?.name || '' })) : [],
      blocked: this.records.filter(r => ['pending','unknown'].includes(r.state)).length, storageError: this.storageFault };
  }
  async saveNames(input) {
    if (this.busy || this.storageFault) fail('BUSY', '分组配置暂不可写。');
    this.busy = true;
    try {
      this.onProgress('validation');
      if (!input || input.owner !== this.owner || !id(input.owner) || !Array.isArray(input.items)) fail('INPUT', '请先读取分组。');
      this.onProgress('identity'); const owner = await this.admin(input.owner);
      this.onProgress('groups'); const groups = await this.readGroups(), seen = new Set();
      this.onProgress('validation');
      const rows = input.items.map(r => {
        if (!id(r?.id) || seen.has(r.id) || !groups.some(g => g.id === r.id)) fail('INPUT', '分组列表已变化，请重新读取。');
        let name;try{name=customerName(r.name);}catch{fail('INPUT',`分组 ID ${r.id} 的显示名称最多80个字符，不能含控制字符。`);}
        seen.add(r.id); return { owner, groupId: r.id, name };
      });
      const next = this.catalog.filter(r => r.owner !== owner || !seen.has(r.groupId)).concat(rows.filter(r => r.name));
      const aliases=new Set();for(const row of next.filter(r=>r.owner===owner)){
        if(aliases.has(row.name))fail('INPUT','显示名称重复，请为每个分组设置不同名称；本次未保存。');aliases.add(row.name);
      }
      validateCatalog(next); this.onProgress('recheck-identity'); await this.admin(owner);
      this.onProgress('storage');
      try { this.catalogStore.save(next); } catch { this.storageFault = true; fail('STORAGE', '分组名称未安全保存。'); }
      this.catalog = next; this.groups = groups; return this.state();
    } finally { this.busy = false; }
  }
  async findUser(query, guard) {
    const owner = await this.admin(this.getOwner(), guard);
    if (typeof query !== 'string' || query.length > 254) fail('INPUT', '请输入用户ID或完整邮箱。');
    query = query.trim(); let targetId;
    if (/^[1-9]\d*$/.test(query) && id(Number(query))) targetId = Number(query);
    else if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(query)) {
      const rows = await this.allPages(page => `/admin/users?page=${page}&page_size=100&search=${encodeURIComponent(query)}`, 5);
      const exactRows = rows.filter(r => typeof r.email === 'string' && r.email.toLowerCase() === query.toLowerCase());
      if (exactRows.length !== 1) fail('INPUT', '完整邮箱未唯一匹配，请改用平台用户ID。');
      targetId = exactRows[0].id;
    } else fail('INPUT', '请输入正整数用户ID或完整邮箱，不按模糊姓名选择用户。');
    const user = userConfig(await this.request('GET', `/admin/users/${targetId}`), targetId);
    const groups = this.projection(await this.readGroups(), owner);
    if (!groups.length) fail('INPUT', '请先在本机“分组设置 · 管理员专用”读取分组并命名发布。');
    await this.admin(owner, guard);
    return { owner, user, groups, fingerprint: digest({ user, groups }) };
  }
  save(rows) {
    try { ledgerRows(rows); this.store.save(rows); this.records = rows; }
    catch { this.storageFault = true; fail('STORAGE', '分组设置记录未安全保存，已停止修改；请保留原件。'); }
    try{this.onRecordsChanged?.();}catch{/* Table copy is not the authoritative ledger. */}
  }
  patch(requestId, state) { this.save(this.records.map(r => r.requestId === requestId ? { ...r, state } : r)); }
  async apply({ requestId, preview, changes }, context) {
    if (this.busy || this.storageFault) fail('BUSY', '分组设置忙碌或存储异常。');
    if (this.otherBlocked()) fail('BUSY', '批量倍率调整正在处理或有结果待核对，请先处理。');
    if (this.records.some(r => r.requestId === requestId)) fail('DUPLICATE', '该操作已有记录，不能重复提交。');
    if (this.records.some(r => ['pending','unknown'].includes(r.state))) fail('UNKNOWN', '有分组设置结果待核对，请先在本机处理。');
    if (!/^[a-f0-9-]{36}$/.test(requestId) || !preview || !id(preview.owner) || !id(preview.user?.id)) fail('INPUT', '操作参数无效。');
    validateChanges(changes); this.busy = true; let pending = false, attempted = false;
    try {
      const owner = await this.admin(preview.owner, context.guard);
      const fresh = await this.findUser(String(preview.user.id), context.guard);
      if (fresh.fingerprint !== preview.fingerprint || digest({ user: preview.user, groups: preview.groups }) !== preview.fingerprint)
        fail('CONFLICT', '用户分组、倍率或发布名称已变化，请重新开始并核对。');
      const allowed = new Set(fresh.user.allowed_groups), rates = { ...fresh.user.group_rates };
      for (const change of changes) {
        const group = fresh.groups.find(g => g.id === change.groupId);
        if (!group) fail('DENIED', '只能修改本机已命名发布的分组。');
        if (group.exclusive || fresh.user.restrict_public_groups) {
          change.allowed ? allowed.add(group.id) : allowed.delete(group.id);
        } else if (!change.allowed) fail('INPUT', '此用户公开分组未受限，不能在这里取消单个公开分组。');
        rates[group.id] = change.rate;
      }
      const body = { allowed_groups: [...allowed].sort((a,b) => a-b),
        restrict_public_groups: fresh.user.restrict_public_groups, group_rates: rates };
      const expected = config(userConfig({ ...fresh.user, ...body }));
      await this.admin(owner, context.guard);
      this.save([...this.records, { kind: 'group-settings', requestId, owner, targetId: fresh.user.id, state: 'pending',
        body: { userId: fresh.user.id, changes: structuredClone(changes) }, before: config(fresh.user), expected, at: new Date().toISOString() }]);
      pending = true;
      if (context.guard() !== true || this.getOwner() !== owner || this.otherBlocked()) fail('POLICY', '身份、会话或批量调价状态已变化，未提交。');
      attempted = true;
      await this.request('PUT', `/admin/users/${fresh.user.id}`, body, { owner, guard: context.guard, groupSettings: true });
      const actual = userConfig(await this.request('GET', `/admin/users/${fresh.user.id}`), fresh.user.id);
      if (stable(config(actual)) !== stable(expected)) fail('UNKNOWN', '平台回读不一致，结果待核对。');
      this.patch(requestId, 'success'); return { userId: actual.id, email: actual.email };
    } catch (error) {
      // This endpoint can update multiple settings. Even an HTTP rejection is not proof
      // of an atomic no-op on every server version; after attempting PUT keep protection.
      if (pending && !this.storageFault) this.patch(requestId, !attempted ? 'failed' : 'unknown');
      throw error;
    } finally { this.busy = false; }
  }
  history() {
    return this.records.filter(r => r.owner === this.getOwner()).slice(-100).reverse().map(r => ({
      requestId: r.requestId, targetId: r.targetId, state: r.state, at: r.at, changes: r.body.changes }));
  }
  async review(requestId, manual = false) {
    if (this.busy || this.storageFault) fail('BUSY', '分组设置暂不可核对。');
    this.busy = true;
    try {
      const owner = await this.admin();
      const row = this.records.find(r => r.requestId === requestId && r.owner === owner && ['pending','unknown'].includes(r.state));
      if (!row) fail('INPUT', '没有属于当前管理员的待核对记录。');
      if (manual) this.patch(requestId, 'reviewed');
      else {
        const actual = userConfig(await this.request('GET', `/admin/users/${row.targetId}`), row.targetId);
        await this.admin(owner);
        if (stable(config(actual)) !== stable(row.expected)) fail('UNKNOWN', '当前平台结果与预期不一致，请到平台人工核对；没有重发修改。');
        this.patch(requestId, 'success');
      }
      return this.history();
    } finally { this.busy = false; }
  }
}
module.exports = { GroupSettingsService, groupRequest, userConfig, validateChanges, rate };
