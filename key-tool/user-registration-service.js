'use strict';
const { ToolError } = require('./service');
const { verifiedFeishuOperator } = require('./operation-history');
const BALANCES = Object.freeze([0, 1, 5, 10]);
const CODES = ['INPUT','AUTH','DENIED','POLICY','BUSY','STORAGE','DUPLICATE','UNKNOWN','HTTP','API','NETWORK','SCHEMA','OPERATION_ERROR'];
const fail = (code, message) => { throw new ToolError(code, message); };
function email(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\x00-\x1f\x7f]/.test(value) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))
    fail('INPUT', '账号需填写有效邮箱，最多254个字符。');
  return value;
}
function password(value) {
  // Explicit local policy; do not silently trim, truncate or normalize passwords.
  if (typeof value !== 'string' || !value.trim() || value.length < 8 || Buffer.byteLength(value, 'utf8') > 72 || /[\x00-\x1f\x7f]/.test(value))
    fail('INPUT', '密码至少8个字符、最多72个UTF-8字节，不能含控制字符；空格会原样保留。');
  return value;
}
function username(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 60 || /[\x00-\x1f\x7f]/.test(value))
    fail('INPUT', '用户名需为1–60个字符，不能含控制字符。');
  return value;
}
function concurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) fail('INPUT', '并发数必须是1–50的整数。');
  return value;
}
function balance(value) {
  if (!BALANCES.includes(value)) fail('INPUT', '初始余额只能选择0、1、5、10。');
  return value;
}
function registrationBody(input) {
  if (!input || (input.role !== undefined && input.role !== 'user') ||
      typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) fail('INPUT', '注册参数或操作编号无效。');
  return { email: email(input.email), password: password(input.password), username: username(input.username),
    role: 'user', balance: balance(input.balance), concurrency: concurrency(input.concurrency), rpm_limit: 0,
    notes: `飞书注册 [${input.requestId}]` };
}
function assertRegistrationBody(body) {
  const match = typeof body?.notes === 'string' && body.notes.match(/^飞书注册 \[([a-f0-9-]{36})\]$/);
  if (!match) fail('INPUT', '注册请求未通过本机校验。');
  const checked = registrationBody({ ...body, requestId: match[1] });
  if (Object.keys(body).length !== Object.keys(checked).length ||
      Object.entries(checked).some(([key, value]) => body[key] !== value)) fail('INPUT', '注册请求字段不在允许范围内。');
  return checked;
}
function validateRecords(rows) {
  const keys = ['kind','requestId','owner','state','body','operator','feishuGroupId','at','updatedAt','receipt','errorCode','reviewedAt','reviewedBy'];
  const ids = new Set(), timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  try {
    if (!Array.isArray(rows)) throw new Error();
    for (const row of rows) {
      if (!row || Object.keys(row).some(key => !keys.includes(key)) || row.kind !== 'user-registration' ||
          !['pending','unknown','success','failed','reviewed'].includes(row.state) || ids.has(row.requestId) ||
          !Number.isSafeInteger(row.owner) || row.owner <= 0 || !timestamp(row.at) ||
          (row.updatedAt !== undefined && !timestamp(row.updatedAt)) || !/^oc_[\w-]{8,128}$/.test(row.feishuGroupId) ||
          !row.body || Object.hasOwn(row.body, 'password')) throw new Error();
      // Validate the persisted password-free body against the same exact allowlist.
      assertRegistrationBody({ ...row.body, password: 'validation-only-placeholder' });
      if (row.body.notes !== `飞书注册 [${row.requestId}]`) throw new Error();
      const actor = verifiedFeishuOperator(row.operator);
      if (Object.keys(row.operator).length !== Object.keys(actor).length) throw new Error();
      if (row.errorCode !== undefined && !CODES.includes(row.errorCode)) throw new Error();
      if (row.receipt !== undefined) {
        const r = row.receipt;
        if (!r || Object.keys(r).length !== 6 || !Number.isSafeInteger(r.id) || r.id <= 0 ||
            ['email','username','role','concurrency','balance'].some(key => r[key] !== row.body[key])) throw new Error();
      }
      if (row.state === 'success' && !row.receipt) throw new Error();
      if (row.state === 'reviewed' && (!timestamp(row.reviewedAt) || row.reviewedBy !== row.owner)) throw new Error();
      ids.add(row.requestId);
    }
  } catch { fail('STORAGE', '注册账本格式异常，注册已关闭；请保留原文件核对。'); }
  return rows;
}
class UserRegistrationService {
  constructor({ request, store, getOwner }) {
    this.request = request; this.store = store; this.getOwner = getOwner; this.busy = false; this.storageFault = false;
    this.records = validateRecords(store.load());
    for (const row of this.records) {
      if (row.state === 'pending') row.state = 'unknown';
    }
  }
  blocked() { return this.records.filter(row => ['pending', 'unknown'].includes(row.state)); }
  changed() { try { this.onRecordsChanged?.(); } catch { /* UI is not the ledger. */ } }
  save(rows) {
    try { validateRecords(rows); this.store.save(rows); this.records = rows; this.changed(); }
    catch { this.storageFault = true; fail('STORAGE', '注册记录无法安全保存，已停止注册；请保留原文件核对，勿重复创建。'); }
  }
  patch(id, patch) { this.save(this.records.map(row => row.requestId === id ? { ...row, ...patch, updatedAt: new Date().toISOString() } : row)); }
  adminRecords(page = 1) {
    if (!Number.isSafeInteger(page) || page < 1) fail('INPUT', '页码无效。');
    const sorted = [...this.records].reverse(), pages = Math.max(1, Math.ceil(sorted.length / 20));
    page = Math.min(page, pages);
    return { page, pages, total: sorted.length, blocked: this.blocked().length, storageError: this.storageFault,
      items: sorted.slice((page - 1) * 20, page * 20).map(row => ({ requestId: row.requestId, state: row.state,
        owner: row.owner, at: row.at, updatedAt: row.updatedAt || row.at, operator: row.operator?.name || '',
        email: row.body.email, username: row.body.username, concurrency: row.body.concurrency, balance: row.body.balance,
        role: 'user', userId: row.receipt?.id || null, errorCode: row.errorCode || null, reviewedAt: row.reviewedAt || null })) };
  }
  review(id, confirmed, owner) {
    if (this.busy || this.storageFault) fail('STORAGE', '注册账本忙碌或异常，不能解除保护。');
    const row = this.records.find(r => r.requestId === id);
    if (confirmed !== true || !row || row.owner !== owner || owner !== this.getOwner() || !['pending', 'unknown'].includes(row.state))
      fail('INPUT', '必须由相同平台管理员明确核对待确认操作。');
    this.patch(id, { state: 'reviewed', reviewedAt: new Date().toISOString(), reviewedBy: owner });
  }
  async create(input, context) {
    if (this.busy) fail('BUSY', '正在处理其他注册，请稍后。');
    if (this.storageFault) fail('STORAGE', '注册账本异常，注册已关闭。');
    if (this.records.some(row => row.requestId === input?.requestId)) fail('DUPLICATE', '该注册已有记录，不能重复执行。');
    if (this.blocked().length) fail('UNKNOWN', '有注册结果待管理员核对，暂不接受新注册。');
    const body = registrationBody(input), owner = this.getOwner();
    const actor = verifiedFeishuOperator(context?.verifiedActor);
    const guard = () => Number.isSafeInteger(owner) && owner > 0 && this.getOwner() === owner &&
      context?.guard?.() === true && /^oc_[\w-]{8,128}$/.test(context.feishuGroupId || '');
    this.busy = true;
    let attempted = false, pending = false;
    try {
      if (!guard()) fail('POLICY', '注册授权已变化，未提交。');
      const me = await this.request('GET', '/auth/me');
      if (Number(me?.id) !== owner || me?.role !== 'admin') fail('DENIED', '需要有效的平台管理员授权，未提交注册。');
      if (!guard()) fail('POLICY', '注册授权已变化，未提交。');
      const { password: omitted, ...auditBody } = body;
      this.save([...this.records, { kind: 'user-registration', requestId: input.requestId, owner,
        state: 'pending', body: auditBody, operator: actor, feishuGroupId: context.feishuGroupId, at: new Date().toISOString() }]);
      pending = true;
      if (!guard()) { const e = new ToolError('POLICY', '注册授权已变化，未提交。'); e.definitive = true; throw e; }
      attempted = true;
      const raw = await this.request('POST', '/admin/users', body, { owner, guard });
      if (!raw || !Number.isSafeInteger(Number(raw.id)) || Number(raw.id) <= 0 || raw.email !== body.email || raw.username !== body.username ||
          raw.balance === null || raw.balance === '' || raw.concurrency === null ||
          raw.role !== 'user' || Number(raw.concurrency) !== body.concurrency || Number(raw.balance) !== body.balance)
        fail('UNKNOWN', '平台可能已创建账号，但回执不完整或字段不一致；请联系管理员核对，勿重复注册。');
      const receipt = { id: Number(raw.id), email: body.email, username: body.username, role: 'user', concurrency: body.concurrency, balance: body.balance };
      this.patch(input.requestId, { state: 'success', receipt });
      return receipt;
    } catch (error) {
      const code = CODES.includes(error?.code) ? error.code : 'OPERATION_ERROR';
      if (pending && !this.storageFault) this.patch(input.requestId, { state: !attempted || error?.definitive === true ? 'failed' : 'unknown', errorCode: code });
      // Never propagate third-party messages/bodies; they may echo the submitted password.
      throw new ToolError(code, pending ? '请联系管理员按操作编号核对注册记录；不会自动重复创建。' : '注册未提交，请联系管理员检查参数、授权或存储。');
    } finally { delete body.password; this.busy = false; }
  }
}
module.exports = { UserRegistrationService, BALANCES, email, password, username, concurrency, balance, registrationBody, assertRegistrationBody };
