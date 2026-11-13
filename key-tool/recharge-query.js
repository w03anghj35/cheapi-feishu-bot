'use strict';
const { ToolError } = require('./service');
const fail = (code, message) => { throw new ToolError(code, message); };
const id = value => Number.isSafeInteger(value) && value > 0;
const TYPES = Object.freeze({
  admin_balance: 'admin-recharge', balance: 'code-balance',
  affiliate_balance: 'affiliate-balance', subscription: 'subscription',
  concurrency: 'non-monetary', admin_concurrency: 'non-monetary'
});
const moneyType = type => !['concurrency', 'admin_concurrency'].includes(type);
const UNIT = 100000000n; // The platform balance column uses eight decimal places.
function formatScaled(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = String(absolute / UNIT);
  const fraction = String(absolute % UNIT).padStart(8, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
function amount(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      typeof value === 'number' && !Number.isFinite(value))
    fail('SCHEMA', '充值金额格式无法核对；本次不展示不完整流水。');
  const text = String(value);
  const match = /^(-?)(0|[1-9]\d{0,19})(?:\.(\d{1,30}))?(?:[eE]([+-]?\d{1,2}))?$/.exec(text);
  if (!match) fail('SCHEMA', '充值金额格式无法核对；本次不展示不完整流水。');
  const digits = match[2] + (match[3] || '');
  const position = match[2].length + Number(match[4] || 0);
  if (position < -30 || position > 30) fail('SCHEMA', '充值金额超出安全核对范围。');
  const whole = position <= 0 ? '0' : position >= digits.length ?
    digits + '0'.repeat(position - digits.length) : digits.slice(0, position);
  const fraction = position <= 0 ? '0'.repeat(-position) + digits :
    position >= digits.length ? '' : digits.slice(position);
  const cleanWhole = whole.replace(/^0+(?=\d)/, '');
  if (cleanWhole.length > 12 || fraction.length > 38)
    fail('SCHEMA', '充值金额超出安全核对范围。');
  const base = BigInt(cleanWhole) * UNIT + BigInt((fraction.slice(0, 8) || '').padEnd(8, '0'));
  let rounded = base;
  if (fraction.length > 8 && /[1-9]/.test(fraction.slice(8))) {
    if (fraction[8] >= '5') rounded += 1n;
    const shift = 10n ** BigInt(fraction.length - 8);
    const exact = BigInt(cleanWhole + fraction);
    if (rounded === 0n && exact !== 0n)
      fail('SCHEMA', '充值金额小于平台最小精度，不能当作零；本次不展示不完整流水。');
    const difference = exact > rounded * shift ? exact - rounded * shift : rounded * shift - exact;
    const numeric = Number(text);
    // A numeric JSON value may be the subtraction of two much larger balances.
    // Bound its tolerated tail to less than half of one eight-decimal unit.
    const ulp = 2 ** (Math.floor(Math.log2(Math.max(1, Math.abs(numeric)))) - 52);
    const tolerance = typeof value === 'number' ? 2.5e-9 : Math.min(2.5e-9, 16 * ulp);
    if (!Number.isFinite(numeric) || Math.abs(numeric) > 1e7 ||
        Number(difference) / 10 ** fraction.length > tolerance)
      fail('SCHEMA', '充值金额超过平台八位小数且无法确认为浮点尾差；本次不展示不完整流水。');
  }
  return formatScaled(match[1] === '-' ? -rounded : rounded);
}
function scaled(value) {
  const normalized = amount(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  const units = BigInt(match[2]) * UNIT + BigInt((match[3] || '').padEnd(8, '0'));
  return match[1] === '-' ? -units : units;
}
function record(raw, recipient) {
  const validId = id(raw?.id) ||
    raw?.type === 'affiliate_balance' && Number.isSafeInteger(raw.id) && raw.id < 0 ||
    typeof raw?.id === 'string' && (/^[1-9]\d{0,15}$/.test(raw.id) ||
      /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(raw.id) ||
      raw.type === 'affiliate_balance' && /^-[1-9]\d{0,15}$/.test(raw.id));
  if (!raw || !validId ||
      typeof raw.type !== 'string' || raw.type.length > 64 || !Object.hasOwn(TYPES, raw.type))
    fail('SCHEMA', '充值流水类型或编号无法核对。');
  const amountText = moneyType(raw.type) ? amount(raw.value) : null;
  const atRaw = raw.used_at || raw.created_at;
  if (atRaw !== undefined && atRaw !== null && (typeof atRaw !== 'string' || !Number.isFinite(Date.parse(atRaw))))
    fail('SCHEMA', '充值流水时间无法核对。');
  return { id: raw.id, at: atRaw || null, recipientId: recipient.id,
    recipientEmail: recipient.email, recipientName: recipient.username,
    kind: raw.type === 'admin_balance' && scaled(amountText) < 0n ? 'admin-deduction' : TYPES[raw.type],
    amount: amountText, actorId: null, actorName: null,
    classification: raw.type === 'admin_balance' && scaled(amountText) > 0n ? 'operator-unknown' : 'not-admin-credit',
    selfStatus: 'unknown' };
}
function user(raw) {
  if (!id(raw?.id) || typeof raw.email !== 'string' || !raw.email || raw.email.length > 254 ||
      /[\x00-\x1f\x7f]/.test(raw.email)) fail('SCHEMA', '平台用户目录不完整。');
  return { id: raw.id, email: raw.email, username: typeof raw.username === 'string' &&
    raw.username.length <= 100 && !/[\x00-\x1f\x7f]/.test(raw.username) ? raw.username : '' };
}
function summary(rows, adminUserId) {
  const credits = rows.filter(r => r.kind === 'admin-recharge' && scaled(r.amount) > 0n);
  const sum = selected => formatScaled(selected.reduce((total, row) => total + scaled(row.amount), 0n));
  const attributable = id(adminUserId) && credits.every(r => id(r.actorId));
  const self = attributable ? credits.filter(r => r.actorId === adminUserId && r.recipientId === adminUserId) : [];
  const others = attributable ? credits.filter(r => !self.includes(r)) : [];
  const small = others.filter(r => scaled(r.amount) < 10n * UNIT);
  return { adminGross: sum(credits), adminCount: credits.length,
    selfExcluded: attributable ? sum(self) : null,
    adminNet: attributable ? sum(others) : null,
    smallOther: attributable ? { count: small.length, amount: sum(small) } : null,
    smallThreshold: 10, selfExclusionReady: Boolean(attributable),
    deductionCount: rows.filter(r => r.kind === 'admin-deduction').length,
    otherTypeCount: rows.filter(r => !['admin-recharge','admin-deduction'].includes(r.kind)).length };
}
function auditEntry(raw, userById, selectedUserId) {
  const target = /^\/(?:api\/v1\/)?admin\/users\/([1-9]\d*)\/balance$/.exec(raw?.path);
  if (raw?.method !== 'POST' || !target || !id(raw?.id)) return null;
  const recipientId = Number(target[1]);
  if (!id(recipientId) || selectedUserId && recipientId !== selectedUserId) return null;
  const at = typeof raw.created_at === 'string' && Number.isFinite(Date.parse(raw.created_at)) ? raw.created_at : null;
  const actorId = id(raw.actor_user_id) ? raw.actor_user_id : null;
  const actorEmail = typeof raw.actor_email === 'string' && raw.actor_email.length <= 254 &&
    !/[\x00-\x1f\x7f]/.test(raw.actor_email) ? raw.actor_email : null;
  const targetUser = userById.get(recipientId);
  return { id: raw.id, at, recipientId, recipientEmail: targetUser?.email || null,
    recipientName: targetUser?.username || null, actorId, actorEmail,
    requestId: typeof raw.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.request_id) ? raw.request_id : null,
    statusCode: Number.isInteger(raw.status_code) && raw.status_code >= 100 && raw.status_code <= 599 ? raw.status_code : null,
    operation: null, requestedValue: null,
    selfCandidate: actorId !== null && actorId === recipientId && Number.isInteger(raw.status_code) &&
      raw.status_code >= 200 && raw.status_code < 300 };
}
function auditRequest(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return { operation: null, requestedValue: null };
  let body;
  try { body = JSON.parse(raw); } catch { return { operation: null, requestedValue: null }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { operation: null, requestedValue: null };
  const operation = typeof body.operation === 'string' && /^[a-z_-]{1,32}$/i.test(body.operation) ? body.operation : null;
  let requestedValue = null;
  try { if (body.balance !== undefined) requestedValue = amount(body.balance); } catch { /* Sanitized or truncated body: no value. */ }
  return { operation, requestedValue };
}
class RechargeQuery {
  constructor({ request, getOwner, onProgress = () => {}, now = () => Date.now() }) {
    Object.assign(this, { request, getOwner, onProgress, now });
    this.busy = false;
  }
  async admin(expected = this.getOwner()) {
    if (!id(expected) || this.getOwner() !== expected) fail('AUTH', '请先完成平台管理员授权。');
    const me = await this.request('GET', '/auth/me');
    if (me?.id !== expected || me.role !== 'admin' || this.getOwner() !== expected)
      fail('DENIED', '管理员授权已变化。');
    return expected;
  }
  async users() {
    const all = [], seen = new Set(); let total;
    for (let page = 1; page <= 50; page++) {
      const data = await this.request('GET', `/admin/users?page=${page}&page_size=100`);
      if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
          data.total > 5000 || data.items.length > 100 || total !== undefined && total !== data.total)
        fail('SCHEMA', '用户目录分页变化或超过上限；本次不生成部分统计。');
      total = data.total;
      for (const item of data.items) {
        const normalized = user(item);
        if (seen.has(normalized.id)) fail('SCHEMA', '用户目录出现重复 ID。');
        seen.add(normalized.id); all.push(normalized);
      }
      if (all.length === total) return all;
      if (!data.items.length || all.length > total) fail('SCHEMA', '用户目录分页不完整。');
    }
    fail('LIMIT', '用户目录超出本次查询上限。');
  }
  async history(recipient, totalRows) {
    const all = [], seen = new Set(); let total;
    for (let page = 1; page <= 40; page++) {
      const data = await this.request('GET', `/admin/users/${recipient.id}/balance-history?page=${page}&page_size=15`);
      if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
          data.items.length > 15 || total !== undefined && total !== data.total || data.total > 600 ||
          totalRows + data.total > 3000) fail('LIMIT', '充值记录超出完整读取上限；请按用户 ID 缩小范围。');
      total = data.total;
      for (let index = 0; index < data.items.length; index++) {
        let row;
        try { row = record(data.items[index], recipient); }
        catch (error) {
          if (error?.code !== 'SCHEMA') throw error;
          fail('SCHEMA', `用户 ID ${recipient.id} 的第 ${page} 页第 ${index + 1} 条充值记录无法核对：${error.message}`);
        }
        if (seen.has(String(row.id))) fail('SCHEMA', '充值记录分页出现重复编号。');
        seen.add(String(row.id)); all.push(row);
      }
      if (all.length === total) return all;
      if (!data.items.length || all.length > total) fail('SCHEMA', '充值记录分页不完整，请稍后重查。');
    }
    fail('LIMIT', '单个用户的充值记录超出40页，请缩小查询范围。');
  }
  async audit(selected, users, started) {
    const selectedUserId = selected.length === 1 ? selected[0].id : null;
    const q = `%2Fadmin%2Fusers%2F${selectedUserId ? `${selectedUserId}%2Fbalance` : ''}`;
    const userById = new Map(users.map(row => [row.id, row]));
    const rows = [], seen = new Set();
    let total, complete = false;
    for (let page = 1; page <= 10; page++) {
      if (this.now() - started >= 5 * 60_000)
        return { rows, complete: false, warning: '查询达到 5 分钟上限，操作日志尚未读完。' };
      const data = await this.request('GET', `/admin/audit-logs?page=${page}&page_size=20&q=${q}`);
      if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
          data.items.length > 20 || total !== undefined && total !== data.total)
        return { rows, complete: false, warning: '操作日志分页变化或格式不完整，请在平台原页核对。' };
      total = data.total;
      for (const raw of data.items) {
        if (!id(raw?.id) || seen.has(raw.id))
          return { rows, complete: false, warning: '操作日志分页出现重复或无效编号，请在平台原页核对。' };
        seen.add(raw.id);
        const row = auditEntry(raw, userById, selectedUserId);
        if (row) rows.push(row);
      }
      if (seen.size === total) { complete = true; break; }
      if (!data.items.length || seen.size > total)
        return { rows, complete: false, warning: '操作日志未完整返回，请在平台原页核对。' };
    }
    let detailMissing = false;
    for (const row of rows) {
      if (this.now() - started >= 5 * 60_000) {
        detailMissing = true;
        break;
      }
      try {
        const detail = await this.request('GET', `/admin/audit-logs/${row.id}`);
        const verified = auditEntry(detail, userById, selectedUserId);
        if (!verified || verified.id !== row.id || verified.recipientId !== row.recipientId ||
            verified.actorId !== row.actorId || verified.requestId !== row.requestId) {
          detailMissing = true; continue;
        }
        Object.assign(row, auditRequest(detail.request_body));
      } catch (error) {
        if (error?.code === 'AUTH' || this.getOwner() == null) throw error;
        detailMissing = true;
      }
    }
    return { rows, complete: complete && !detailMissing,
      warning: !complete ? '操作日志超过最近 200 条读取上限，仅展示已读候选；请缩小到收款用户 ID。' :
        detailMissing ? '部分操作日志详情无法读取，请在平台原页核对请求值。' : null };
  }
  async query(input = {}) {
    if (this.busy) fail('BUSY', '已有充值查询正在进行，请等待结果。');
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['userId','adminUserId'].includes(key)) ||
        input.userId != null && !id(input.userId) || input.adminUserId != null && !id(input.adminUserId))
      fail('INPUT', '请使用准确的平台用户 ID 查询。');
    this.busy = true;
    try {
      const owner = await this.admin();
      const users = await this.users();
      const selected = input.userId == null ? users : users.filter(row => row.id === input.userId);
      if (!selected.length) fail('INPUT', '未找到所选平台用户 ID。');
      if (selected.length > 200) fail('LIMIT', '用户超过200个，请指定平台用户 ID 缩小范围。');
      const rows = [], started = this.now();
      for (let index = 0; index < selected.length; index++) {
        if (this.now() - started >= 5 * 60_000) fail('LIMIT', '查询超过5分钟，未生成部分统计；请缩小范围。');
        rows.push(...await this.history(selected[index], rows.length));
        if (this.getOwner() !== owner) fail('AUTH', '管理员身份已变化，未展示结果。');
        this.onProgress({ scannedUsers: index + 1, totalUsers: selected.length, rows: rows.length });
      }
      let audit;
      try { audit = await this.audit(selected, users, started); }
      catch (error) {
        if (error?.code === 'AUTH' || this.getOwner() !== owner) throw error;
        audit = { rows: [], complete: false, warning: '操作日志暂不可读取；请在平台原页核对。' };
      }
      await this.admin(owner);
      rows.sort((a, b) => (b.at ? Date.parse(b.at) : -Infinity) - (a.at ? Date.parse(a.at) : -Infinity)
        || a.recipientId - b.recipientId || String(a.id).localeCompare(String(b.id)));
      return { rows, summary: summary(rows, input.adminUserId), scannedUsers: selected.length,
        complete: true, operatorAvailable: false, unit: '$',
        auditRows: audit.rows, auditComplete: audit.complete, auditWarning: audit.warning,
        adminUserId: input.adminUserId ?? null, at: new Date(this.now()).toISOString() };
    } finally { this.busy = false; }
  }
}
module.exports = { RechargeQuery, record, summary, amount, auditEntry, auditRequest, TYPES };
