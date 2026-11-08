'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ToolError } = require('./service');

const validId = value => Number.isSafeInteger(value) && value > 0;
const validOpenId = value => typeof value === 'string' && /^ou_[\w-]{4,252}$/.test(value);
const validGroupId = value => typeof value === 'string' && /^oc_[\w-]{8,128}$/.test(value);
const fail = (code, message) => { throw new ToolError(code, message); };
const fingerprint = value => createHash('sha256').update(value).digest('hex');
function label(value) {
  if (typeof value !== 'string' || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) fail('INPUT', '姓名无效。');
  return value.trim();
}
const nameKey = value => value.trim().toLocaleLowerCase('zh-CN');
function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length > 5000) fail('STORAGE', '用户归属配置损坏。');
  const seen = new Set(), profiles = new Set();
  for (const row of rows) {
    const profile = row?.state === 'profile';
    if (!validId(row?.owner) || !validGroupId(row.groupId) ||
        (profile ? row.openId !== null : !validOpenId(row.openId)) ||
        typeof row.name !== 'string' || !row.name || label(row.name) !== row.name ||
        !Array.isArray(row.userIds) || row.userIds.length > 2000 || row.userIds.some(id => !validId(id)) ||
        new Set(row.userIds).size !== row.userIds.length || !['pending','assigned','profile','linked'].includes(row.state) ||
        (['pending','linked'].includes(row.state) && row.userIds.length) ||
        (row.state === 'linked' && (typeof row.profileName !== 'string' ||
          !row.profileName || label(row.profileName) !== row.profileName)) ||
        (row.state !== 'linked' && row.profileName !== undefined))
      fail('STORAGE', '用户归属配置损坏，请保留原件。');
    if (profile) {
      const key = `${row.owner}:${row.groupId}:${nameKey(row.name)}`;
      if (profiles.has(key)) fail('STORAGE', '用户归属配置损坏，请保留原件。');
      profiles.add(key);
    } else {
      const key = `${row.owner}:${row.groupId}:${row.openId}`;
      if (seen.has(key)) fail('STORAGE', '用户归属配置损坏，请保留原件。');
      seen.add(key);
    }
  }
  const links = new Set();
  for (const row of rows.filter(item => item.state === 'linked')) {
    const key = `${row.owner}:${row.groupId}:${nameKey(row.profileName)}`;
    if (!profiles.has(key) || links.has(key)) fail('STORAGE', '飞书身份与姓名档案绑定不一致，请保留原件。');
    links.add(key);
  }
  return rows;
}
function makeOwnershipStore(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'ownership.journal');
  let sequence = 0, loaded = false, damaged = false, history = [];
  function changes(previous, next, at) {
    const old = new Map(previous.map(row => [`${row.owner}:${row.groupId}:${row.openId === null ? 'profile:' + nameKey(row.name) : row.openId}`, row]));
    return next.filter(row => {
      const key = `${row.owner}:${row.groupId}:${row.openId === null ? 'profile:' + nameKey(row.name) : row.openId}`;
      const prior = old.get(key);
      return !prior || prior.name !== row.name || prior.state !== row.state ||
        prior.profileName !== row.profileName ||
        JSON.stringify(prior.userIds) !== JSON.stringify(row.userIds);
    }).map(row => ({ owner: row.owner, groupId: row.groupId, name: row.name,
      profileName: row.profileName || null,
      identity: row.openId === null ? null : fingerprint(row.openId),
      state: row.state, userIds: [...row.userIds], at }));
  }
  return {
    load() {
      if (loaded) fail('STORAGE', '用户归属配置已初始化。');
      try {
        let rows = [];
        if (io.existsSync(file)) {
          const content = io.readFileSync(file, 'utf8');
          if (!content.endsWith('\n')) throw new Error('partial');
          for (const line of content.slice(0, -1).split('\n')) {
            const entry = JSON.parse(line);
            if (entry.sequence !== sequence + 1 || typeof entry.ciphertext !== 'string') throw new Error('sequence');
            const payload = JSON.parse(safeStorage.decryptString(Buffer.from(entry.ciphertext, 'base64')));
            const next = validateRows(Array.isArray(payload) ? payload : payload?.rows);
            const at = Array.isArray(payload) ? null : payload?.at;
            if (at !== null && (typeof at !== 'string' || !Number.isFinite(Date.parse(at)))) throw Error('timestamp');
            history.push(...changes(rows, next, at)); rows = next; sequence = entry.sequence;
          }
        }
        this.currentRows = structuredClone(rows);
        loaded = true; return rows;
      } catch { damaged = true; fail('STORAGE', '用户归属配置无法解密或读取，请保留原件。'); }
    },
    save(rows) {
      if (!loaded || damaged || !safeStorage.isEncryptionAvailable()) fail('STORAGE', '用户归属配置不可写。');
      validateRows(rows);
      let fd;
      try {
        const at = new Date().toISOString();
        const ciphertext = safeStorage.encryptString(JSON.stringify({ rows, at })).toString('base64');
        const line = Buffer.from(JSON.stringify({ sequence: sequence + 1, ciphertext }) + '\n');
        io.mkdirSync(dir, { recursive: true }); fd = io.openSync(file, 'a', 0o600);
        for (let offset = 0; offset < line.length;) {
          const n = io.writeSync(fd, line, offset, line.length - offset);
          if (!Number.isSafeInteger(n) || n <= 0) throw new Error('short write');
          offset += n;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined; sequence++;
        history.push(...changes(this.currentRows || [], rows, at)); this.currentRows = structuredClone(rows);
      } catch { damaged = true; fail('STORAGE', '用户归属配置未安全保存，请保留原件。'); }
      finally { if (fd !== undefined) try { io.closeSync(fd); } catch { damaged = true; } }
    },
    history(owner, groupId, limit = 100) {
      if (!loaded || damaged) fail('STORAGE', '用户归属修改记录不可读取。');
      return history.filter(row => row.owner === owner && row.groupId === groupId)
        .slice(-limit).reverse().map(row => ({ ...row, userIds: [...row.userIds] }));
    }
  };
}
function publicUser(raw) {
  const balance = raw?.balance;
  const validBalance = (typeof balance === 'number' && Number.isFinite(balance)) ||
    (typeof balance === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(balance) && Number.isFinite(Number(balance)));
  if (!validId(raw?.id) || typeof raw.email !== 'string' || !raw.email || raw.email.length > 254 || /[\x00-\x1f\x7f]/.test(raw.email) ||
      typeof raw.username !== 'string' || raw.username.length > 100 || /[\x00-\x1f\x7f]/.test(raw.username) ||
      !['active','disabled','inactive'].includes(raw.status) || !['user','admin'].includes(raw.role) ||
      !validBalance)
    fail('SCHEMA', '平台用户资料不完整，本次未展示余额。');
  return { id: raw.id, email: raw.email, username: raw.username, balance: Number(balance),
    status: raw.status, role: raw.role, concurrency: Number.isSafeInteger(raw.concurrency) ? raw.concurrency : null };
}
class UserOwnership {
  constructor({ request, store, audit = null, getOwner, getGroupId }) {
    Object.assign(this, { request, store, audit, getOwner, getGroupId });
    this.rows = validateRows(store.load()); this.busy = false; this.storageFault = false;
    if (audit) audit.load();
  }
  scope() {
    const owner = this.getOwner(), groupId = this.getGroupId();
    if (!validId(owner) || !validGroupId(groupId)) fail('POLICY', '请先确认平台管理员和飞书目标群绑定。');
    return { owner, groupId };
  }
  async admin() {
    const scope = this.scope();
    const me = await this.request('GET', '/auth/me');
    if (me?.id !== scope.owner || me?.role !== 'admin' || this.getOwner() !== scope.owner || this.getGroupId() !== scope.groupId)
      fail('DENIED', '管理员授权或目标群已变化。');
    return scope;
  }
  async users() {
    const out = [], seen = new Set(); let total;
    for (let page = 1; page <= 50; page++) {
      const data = await this.request('GET', `/admin/users?page=${page}&page_size=100`);
      if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
          data.items.length > 100 || (total !== undefined && data.total !== total) || data.total > 5000)
        fail('SCHEMA', '平台分页变化或超出5000条上限，请到平台核对。');
      total = data.total;
      for (const raw of data.items) {
        const user = publicUser(raw);
        if (seen.has(user.id)) fail('SCHEMA', '平台分页出现重复用户。');
        seen.add(user.id); out.push(user);
      }
      if (out.length === total) return out;
      if (!data.items.length || out.length > total) fail('SCHEMA', '平台分页不完整。');
    }
    fail('LIMIT', '平台用户超过本次读取上限。');
  }
  list() {
    const scope = this.scope();
    return this.rows.filter(r => r.owner === scope.owner && r.groupId === scope.groupId && r.state !== 'profile')
      .map(r => ({ identity: fingerprint(r.openId), name: r.name, state: r.state,
        profileName: r.profileName || null, userIds: [...r.userIds] }));
  }
  profiles() {
    const scope = this.scope();
    return this.rows.filter(r => r.owner === scope.owner && r.groupId === scope.groupId && r.state === 'profile')
      .map(r => ({ name: r.name, userIds: [...r.userIds] }));
  }
  queryHistory() {
    const scope = this.scope();
    if (!this.audit) return [];
    return this.audit.list(scope.owner, scope.groupId).map(row => ({
      identity: fingerprint(row.openId), actorName: row.actorName, name: row.name, kind: row.kind || 'balance', status: row.status,
      at: row.at, count: row.count
    }));
  }
  usageBinding(openId) {
    if (this.storageFault) fail('STORAGE', '用户归属存储异常，本次不展示用量。');
    if (!validOpenId(openId)) fail('INPUT', '飞书身份无效。');
    const scope = this.scope();
    const row = this.rows.find(item => item.owner === scope.owner && item.groupId === scope.groupId && item.openId === openId);
    if (!row || !['assigned', 'linked'].includes(row.state)) return null;
    const profile = row.state === 'linked' ? this.rows.find(item => item.owner === scope.owner &&
      item.groupId === scope.groupId && item.state === 'profile' && nameKey(item.name) === nameKey(row.profileName)) : null;
    if (row.state === 'linked' && !profile) fail('STORAGE', '绑定的姓名档案不存在，请保留原件。');
    return { scope, name: profile?.name || row.name, actorName: row.name,
      userIds: [...(profile || row).userIds] };
  }
  sameUsageBinding(openId, expected) {
    if (!expected || !Array.isArray(expected.userIds)) return false;
    const current = this.usageBinding(openId);
    return !!current && current.scope.owner === expected.scope?.owner &&
      current.scope.groupId === expected.scope?.groupId && current.name === expected.name &&
      JSON.stringify(current.userIds) === JSON.stringify(expected.userIds);
  }
  auditUsage(openId, binding, status, count = 0) {
    if (!validOpenId(openId) || !['found', 'not-found', 'error'].includes(status) ||
        !Number.isSafeInteger(count) || count < 0 || count > 2000) fail('INPUT', '用量查询审计参数无效。');
    if (!this.audit || this.storageFault) fail('STORAGE', '用量查询记录暂不可写入，本次不展示资料。');
    const scope = binding?.scope || this.scope();
    const current = this.rows.find(row => row.owner === scope.owner && row.groupId === scope.groupId && row.openId === openId);
    const actorName = binding?.actorName || current?.name || `飞书用户#${fingerprint(openId).slice(0, 12)}`;
    try {
      this.audit.append({ ...scope, openId, actorName, name: binding?.name || '未绑定归属',
        kind: 'usage', status, count, at: new Date().toISOString() });
    } catch { this.storageFault = true; fail('STORAGE', '用量查询记录未安全保存，本次不展示资料；请保留原件。'); }
  }
  changeHistory() {
    const scope = this.scope();
    return this.store.history?.(scope.owner, scope.groupId) || [];
  }
  claim(openId, name) {
    const scope = this.scope();
    if (!validOpenId(openId)) fail('INPUT', '飞书身份无效。');
    const displayName = label(name) || `飞书用户#${fingerprint(openId).slice(0, 12)}`;
    const index = this.rows.findIndex(r => r.owner === scope.owner && r.groupId === scope.groupId && r.openId === openId);
    if (index >= 0) {
      const current = this.rows[index];
      if (['pending','linked'].includes(current.state) && current.name !== displayName &&
          !displayName.startsWith('飞书用户#')) {
        const next = this.rows.map((row, at) => at === index ? { ...row, name: displayName } : row);
        try { this.store.save(next); this.rows = next; }
        catch { this.storageFault = true; fail('STORAGE', '飞书显示名未安全更新，请保留原件。'); }
      }
      return current.state;
    }
    const next = [...this.rows, { ...scope, openId, name: displayName, userIds: [], state: 'pending' }];
    try { this.store.save(next); this.rows = next; } catch { this.storageFault = true; fail('STORAGE', '查询申请未安全保存。'); }
    return 'pending';
  }
  async adminSnapshot() {
    if (this.storageFault || this.busy) fail('BUSY', '用户归属暂不可读取。');
    this.busy = true;
    try { const scope = await this.admin(), users = await this.users(), current = await this.admin();
      if (current.owner !== scope.owner || current.groupId !== scope.groupId) fail('POLICY', '管理员或目标群已变化。');
      return { users: users.sort((a,b) => a.balance-b.balance || a.id-b.id),
        identities: this.list(), profiles: this.profiles(), queries: this.queryHistory(), changes: this.changeHistory() };
    } finally { this.busy = false; }
  }
  async assignName({ name, userIds }) {
    if (this.storageFault || this.busy) fail('BUSY', '用户归属暂不可保存。');
    const title = label(name);
    if (!title || !Array.isArray(userIds) || userIds.length > 2000 ||
        userIds.some(id => !validId(id)) || new Set(userIds).size !== userIds.length)
      fail('INPUT', '请填写归属姓名并勾选有效的平台用户。');
    this.busy = true;
    try {
      const scope = await this.admin();
      const users = await this.users(), available = new Set(users.filter(u => u.role === 'user').map(u => u.id));
      if (userIds.some(id => !available.has(id))) fail('CONFLICT', '勾选用户已变化，请重新读取。');
      const current = await this.admin();
      if (current.owner !== scope.owner || current.groupId !== scope.groupId) fail('POLICY', '管理员或目标群已变化。');
      const key = nameKey(title);
      const existing = this.rows.find(r => r.state === 'profile' && r.owner === scope.owner &&
        r.groupId === scope.groupId && nameKey(r.name) === key);
      const next = existing ? this.rows.map(r => r === existing ? { ...r, userIds: [...userIds] } : r) :
        [...this.rows, { ...scope, openId: null, name: title, userIds: [...userIds], state: 'profile' }];
      if (next.length > 5000) fail('LIMIT', '归属档案已达上限。');
      try { this.store.save(next); this.rows = next; } catch { this.storageFault = true; fail('STORAGE', '归属未安全保存，请保留原件。'); }
      return { profiles: this.profiles(), identities: this.list(), changes: this.changeHistory() };
    } finally { this.busy = false; }
  }
  async link({ identity, profileName }) {
    if (this.storageFault || this.busy) fail('BUSY', '飞书身份绑定暂不可保存。');
    if (typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity))
      fail('INPUT', '请选择已登记的飞书身份。');
    const title = label(profileName);
    if (!title) fail('INPUT', '请选择已保存的归属档案。');
    this.busy = true;
    try {
      const scope = await this.admin();
      const person = this.rows.find(row => row.owner === scope.owner && row.groupId === scope.groupId &&
        row.openId !== null && fingerprint(row.openId) === identity);
      if (!person || !['pending','linked'].includes(person.state))
        fail('INPUT', '该成员尚未登记，或已有旧式身份归属；请先核对。');
      const profile = this.rows.find(row => row.owner === scope.owner && row.groupId === scope.groupId &&
        row.state === 'profile' && nameKey(row.name) === nameKey(title));
      if (!profile) fail('INPUT', '归属档案不存在，请先按姓名保存平台用户。');
      if (this.rows.some(row => row !== person && row.owner === scope.owner && row.groupId === scope.groupId &&
          row.state === 'linked' && nameKey(row.profileName) === nameKey(profile.name)))
        fail('CONFLICT', '该姓名档案已绑定另一位飞书成员，请先核对身份。');
      const verified = await this.admin();
      if (verified.owner !== scope.owner || verified.groupId !== scope.groupId || !this.rows.includes(person) ||
          !this.rows.includes(profile)) fail('POLICY', '管理员、目标群或归属档案已变化。');
      const next = this.rows.map(row => row === person ? { ...row, state: 'linked',
        profileName: profile.name, userIds: [] } : row);
      try { this.store.save(next); this.rows = next; }
      catch { this.storageFault = true; fail('STORAGE', '飞书身份绑定未安全保存，请保留原件。'); }
      return { identities: this.list(), profiles: this.profiles(), changes: this.changeHistory() };
    } finally { this.busy = false; }
  }
  async assign({ identity, name, userIds }) {
    if (this.storageFault || this.busy) fail('BUSY', '用户归属暂不可保存。');
    if (typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity) || !Array.isArray(userIds) ||
        userIds.length > 2000 || userIds.some(id => !validId(id)) || new Set(userIds).size !== userIds.length)
      fail('INPUT', '请勾选有效的平台用户。');
    this.busy = true;
    try {
      const scope = await this.admin();
      const row = this.rows.find(r => r.owner === scope.owner && r.groupId === scope.groupId &&
        validOpenId(r.openId) && fingerprint(r.openId) === identity);
      if (!row) fail('INPUT', '该飞书成员尚未发起查询，请让其从指定群进入菜单。');
      const title = label(name); if (!title) fail('INPUT', '请填写归属姓名。');
      const users = await this.users(), available = new Set(users.filter(u => u.role === 'user').map(u => u.id));
      if (userIds.some(id => !available.has(id))) fail('CONFLICT', '勾选用户已变化，请重新读取。');
      const current = await this.admin();
      if (current.owner !== scope.owner || current.groupId !== scope.groupId) fail('POLICY', '管理员或目标群已变化。');
      const next = this.rows.map(r => r === row ? { ...r, name: title, userIds: [...userIds], state: 'assigned' } : r);
      try { this.store.save(next); this.rows = next; } catch { this.storageFault = true; fail('STORAGE', '归属未安全保存，请保留原件。'); }
      return { identities: this.list() };
    } finally { this.busy = false; }
  }
  async query(openId) {
    if (this.storageFault) fail('STORAGE', '用户归属存储异常，本次不展示资料。');
    const scope = this.scope();
    const row = this.rows.find(r => r.owner === scope.owner && r.groupId === scope.groupId && r.openId === openId);
    if (!row || !['assigned','linked'].includes(row.state)) return null;
    const profile = row.state === 'linked' ? this.rows.find(r => r.owner === scope.owner &&
      r.groupId === scope.groupId && r.state === 'profile' && nameKey(r.name) === nameKey(row.profileName)) : null;
    const title = profile?.name || row.name;
    let status = 'error', count = 0;
    try {
      if (row.state === 'linked' && !profile) fail('STORAGE', '绑定的姓名档案不存在，请保留原件。');
      const users = await this.users();
      if (this.getOwner() !== scope.owner || this.getGroupId() !== scope.groupId ||
          !this.rows.includes(row) || (profile && !this.rows.includes(profile)) ||
          (profile && (row.state !== 'linked' || nameKey(row.profileName) !== nameKey(profile.name))) || this.storageFault)
        fail('POLICY', '归属已变化，本次不展示资料。');
      const byId = new Map(users.map(u => [u.id, u]));
      const selected = (profile || row).userIds.map(id => byId.get(id));
      if (selected.some(u => !u || u.role !== 'user'))
        fail('SCHEMA', '有已归属用户不在当前平台普通用户列表，余额未展示。');
      status = 'found'; count = selected.length;
      return { name: title, users: selected.sort((a,b) => a.balance-b.balance || a.id-b.id) };
    } finally {
      if (this.audit) {
        try { this.audit.append({ ...scope, openId, actorName: row.name,
          name: title, status, count, at: new Date().toISOString() }); }
        catch { this.storageFault = true; fail('STORAGE', '查询记录未安全保存，本次不展示资料；请保留原件。'); }
      }
    }
  }
}
module.exports = { UserOwnership, makeOwnershipStore, publicUser, validOpenId };
