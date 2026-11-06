'use strict';

// Only return a fixed category. Never forward a platform error message: it may
// echo the request body, including a registration password or created key.
const REASONS = Object.freeze({
  EMAIL_EXISTS: 'EMAIL_EXISTS', USER_EXISTS: 'USER_EXISTS', USERNAME_EXISTS: 'USERNAME_EXISTS',
  GROUP_UNAVAILABLE: 'GROUP_UNAVAILABLE', QUOTA_INVALID: 'QUOTA_INVALID',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE'
});
const knownReason = value => Object.hasOwn(REASONS, value) ? value : null;
function classifyPlatformError(method, route, payload) {
  if (method !== 'POST' || !['/admin/users', '/keys'].includes(route)) return null;
  const values = typeof payload === 'string' ? [payload] : [payload?.message, payload?.msg,
    payload?.error?.message, payload?.data?.message, payload?.errors?.[0]?.message];
  const messages = values.filter(v => typeof v === 'string' && v.length <= 1000).map(v => v.toLowerCase());
  for (const message of messages) {
    if (route === '/admin/users') {
      if (/(?:邮箱|电子邮件|email|e-mail).{0,32}(?:已存在|已注册|被使用|重复|占用|already exists|already registered|already in use|duplicate|taken)/i.test(message) ||
          /(?:already exists|already registered|duplicate|taken).{0,32}(?:email|e-mail)/i.test(message)) return REASONS.EMAIL_EXISTS;
      if (/(?:用户名|username).{0,32}(?:已存在|被使用|重复|占用|already exists|already in use|duplicate|taken)/i.test(message) ||
          /(?:already exists|duplicate|taken).{0,32}(?:username)/i.test(message)) return REASONS.USERNAME_EXISTS;
      if (/(?:用户|账号|账户|user|account).{0,32}(?:已存在|已注册|重复|already exists|already registered|duplicate)/i.test(message) ||
          /(?:already exists|already registered|duplicate).{0,32}(?:user|account)/i.test(message)) return REASONS.USER_EXISTS;
    } else {
      if (/(?:分组|group).{0,32}(?:不存在|不可用|已停用|无权限|not found|unavailable|disabled|not allowed)/i.test(message)) return REASONS.GROUP_UNAVAILABLE;
      if (/(?:额度|quota).{0,32}(?:超出|过高|无效|不足|exceed|invalid|insufficient)/i.test(message)) return REASONS.QUOTA_INVALID;
      if (/(?:余额|balance|credit).{0,32}(?:不足|insufficient|not enough)/i.test(message) ||
          /(?:insufficient|not enough).{0,32}(?:balance|credit)/i.test(message)) return REASONS.INSUFFICIENT_BALANCE;
    }
  }
  return null;
}
async function readPlatformError(response) {
  const size = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(size) && size > 8192) return null;
  let raw = '';
  try {
    if (response?.body?.getReader) {
      const reader = response.body.getReader(), decoder = new TextDecoder(); let total = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          total += part.value.byteLength; if (total > 8192) return null;
          raw += decoder.decode(part.value, { stream: true });
        }
        raw += decoder.decode();
      } finally { void reader.cancel().catch(() => {}); }
    } else if (typeof response?.json === 'function') {
      const value = await response.json();
      return JSON.stringify(value).length <= 8192 ? value : null;
    } else return null;
    try { return JSON.parse(raw); } catch { return raw.length <= 1000 ? raw : null; }
  } catch { return null; }
}
function publicFailure(kind, { code, reason, definitive, attempted, httpStatus } = {}) {
  const safe = knownReason(reason);
  if (attempted && !definitive) return kind === 'registration'
    ? '注册结果尚未确认。平台可能已经创建账号；请管理员按操作编号核对，暂勿重复注册。'
    : '令牌创建结果尚未确认。平台可能已经创建令牌；请管理员按操作编号核对，暂勿重复申请。';
  if (kind === 'registration') {
    if (safe === REASONS.EMAIL_EXISTS) return '注册未成功：这个邮箱已经注册，请换用未注册的邮箱；如果是您的账号，请直接登录。';
    if (safe === REASONS.USERNAME_EXISTS) return '注册未成功：用户名已被使用，请更换用户名后重新发起。';
    if (safe === REASONS.USER_EXISTS) return '注册未成功：平台提示用户已存在，请确认邮箱或联系管理员核对。';
  } else if (kind === 'token') {
    if (safe === REASONS.GROUP_UNAVAILABLE) return '令牌未创建：所选分组在平台上不可用，请重新选择或联系管理员。';
    if (safe === REASONS.QUOTA_INVALID) return '令牌未创建：填写的额度不符合平台要求，请调整额度。';
    if (safe === REASONS.INSUFFICIENT_BALANCE) return '令牌未创建：管理员账户额度不足，请联系管理员处理。';
  }
  if (code === 'BUSY') return '当前有其他操作正在处理，请稍后再试。';
  if (code === 'AUTH' || code === 'DENIED') return '平台管理员授权不可用，请联系管理员重新授权。';
  if (code === 'DUPLICATE') return '这条申请已有本机记录，请勿重复确认；如未收到结果，请联系管理员核对。';
  if (code === 'UNKNOWN') return '上一笔操作结果待管理员核对，暂不能再次提交；请勿重复申请。';
  if (code === 'INPUT' || code === 'BUDGET') return kind === 'registration' ? '注册资料未通过校验，请检查表单或联系管理员。' : '令牌分组或额度未通过校验，请检查后重试。';
  if (code === 'STORAGE' || code === 'NOT_SENT') return '本机记录未能安全保存，操作未完成；请联系管理员检查，暂勿重复提交。';
  if (!attempted && code === 'NETWORK') return '还未提交创建请求：连接平台失败，请稍后重新发起。';
  if (!attempted && ['HTTP','API','SCHEMA'].includes(code)) return '还未提交创建请求：平台预检查未通过，请联系管理员检查。';
  if (definitive && ['HTTP','API'].includes(code)) return `${kind === 'registration' ? '注册' : '令牌创建'}未成功：平台拒绝了本次请求${Number.isInteger(httpStatus) ? `（HTTP ${httpStatus}）` : ''}，请联系管理员按操作编号核对。`;
  return kind === 'registration' ? '注册未完成，请联系管理员按操作编号核对。' : '令牌创建未完成，请联系管理员按操作编号核对。';
}
module.exports = { REASONS, knownReason, classifyPlatformError, readPlatformError, publicFailure };
