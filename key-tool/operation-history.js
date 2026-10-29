'use strict';
const STATES = ['pending', 'unknown', 'success', 'failed', 'reviewed'];
function invalid(message) { const e = new Error(message); e.code = 'INPUT'; throw e; }
function operator(value) {
  if (value === undefined) return { name: '', source: 'unrecorded', verified: false };
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\x00-\x1f\x7f]/.test(value)) invalid('请填写 1–100 个字符的操作人／客户账号，不能包含控制字符。');
  return { name: value.trim(), source: 'self-reported', verified: false };
}
function verifiedFeishuOperator(value) {
  if (!value || value.source !== 'feishu-open-id' || value.verified !== true ||
      typeof value.name !== 'string' || !/^飞书用户#[a-f0-9]{20}$/.test(value.name)) {
    invalid('飞书操作身份无效，已停止创建。');
  }
  return { name: value.name, source: 'feishu-open-id', verified: true };
}
function event(kind, state, code) {
  return { kind, state, at: new Date().toISOString(), ...(code ? { code } : {}) };
}
function safeCode(e) { return /^[A-Z_0-9]{1,32}$/.test(e?.code || '') ? e.code : 'OPERATION_ERROR'; }
function mask(key) { return typeof key === 'string' && key.length > 8 ? '••••••••' + key.slice(-4) : '••••••••'; }
function project(r) {
  return { requestId: r.requestId, owner: r.owner ?? null, at: r.at || null, updatedAt: r.updatedAt || r.at || null,
    state: r.state, operator: r.operator || { name: '', source: 'unrecorded', verified: false },
    group: r.group || { id: r.body.group_id ?? null, originalName: null, customerName: null, platform: null, rate: null },
    name: r.body.name, quota: r.body.quota ?? null, days: r.body.expires_in_days ?? null,
    keyId: r.receipt?.id ?? null, maskedKey: r.receipt?.maskedKey || (r.result ? '已加密 · 详情查看' : '未取得密钥'),
    submission: r.submission || 'unrecorded', feishuGroupId: r.feishuGroupId || null,
    delivery: r.delivery || null, errorCode: r.errorCode || null, hasSecret: r.state === 'success' && !!r.result,
    events: r.events || [] };
}
function query(records, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('记录查询参数无效。');
  const page = input.page ?? 1, size = input.pageSize ?? 20, status = input.status || '', search = input.search || '';
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1 || size > 100 ||
      typeof search !== 'string' || search.length > 200 || (status && !STATES.includes(status))) invalid('记录查询范围无效。');
  const q = search.trim().toLocaleLowerCase();
  // Do not decrypt credentials or receipts to search. Match recorded metadata only.
  const rows = records.filter(r => (!status || r.state === status) && (!q || [r.requestId, r.owner, r.operator?.name,
    r.body.name, r.body.quota, r.body.group_id, r.group?.originalName, r.group?.customerName, r.receipt?.id]
    .some(v => v != null && String(v).toLocaleLowerCase().includes(q))));
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || b.requestId.localeCompare(a.requestId));
  const pages = Math.max(1, Math.ceil(rows.length / size)), current = Math.min(page, pages);
  const counts = Object.fromEntries(STATES.map(s => [s, rows.filter(r => r.state === s).length]));
  return { page: current, pageSize: size, pages, total: rows.length, counts,
    items: rows.slice((current - 1) * size, current * size).map(project) };
}
module.exports = { operator, verifiedFeishuOperator, event, safeCode, mask, project, query };
