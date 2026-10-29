'use strict';
const fs = require('node:fs');
const path = require('node:path');
const CODES = new Set(['BUSY','AUTH','INPUT','POLICY','BUDGET','CONFLICT','UNKNOWN','NOT_SENT',
  'NETWORK','HTTP','SCHEMA','API','ROUTE','STORAGE','OPERATION_ERROR']);
const STAGES = new Set(['admission','validation','identity','groups','policy','pending-storage',
  'submission','receipt-storage','unknown']);
const MAX_BYTES = 1024 * 1024;
function failureDiagnostic(requestId, error, stage = 'unknown') {
  return { at: new Date().toISOString(),
    requestId: typeof requestId === 'string' && /^[a-f0-9-]{36}$/.test(requestId) ? requestId : null,
    code: CODES.has(error?.code) ? error.code : 'OPERATION_ERROR',
    stage: STAGES.has(stage) ? stage : 'unknown',
    httpStatus: Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : null };
}
function failureHint(row) {
  if (['UNKNOWN','NOT_SENT'].includes(row.code) || ['submission','receipt-storage','unknown'].includes(row.stage)) {
    return '本次创建未能确认完成。请联系管理员按操作编号核对，不要重复创建。';
  }
  return ({ BUSY: '当前有其他操作正在处理，本次未提交。请稍后重新发起申请。',
    AUTH: '平台授权检查未通过，本次未提交。请联系管理员维护授权。',
    INPUT: '申请参数或所选分组已变化，本次未提交。请联系管理员核对分组。',
    POLICY: '安全策略或连接状态已变化，本次未提交。请联系管理员检查。',
    BUDGET: '申请超过额度限制，本次未提交。请联系管理员检查额度策略。',
    NETWORK: '平台连接超时或失败，本次未提交。请联系管理员检查网络。',
    HTTP: '平台预检查未通过，本次未提交。请联系管理员检查接口状态。',
    SCHEMA: '平台返回格式未通过校验，本次未提交。请联系管理员检查。',
    API: '平台预检查返回拒绝，本次未提交。请联系管理员检查。'
  })[row.code] || '本次申请未完成，请联系管理员按操作编号检查；不会自动重试。';
}
// Independent, bounded telemetry, NEVER a creation/replay ledger. No raw error, body or identity.
function makeFailureLog(dir, io = fs) {
  const file = path.join(dir, 'create-failures.jsonl');
  let rows = [], error = false;
  try {
    if (io.existsSync(file)) {
      if (io.statSync(file).size > MAX_BYTES) throw new Error('size');
      const text = io.readFileSync(file, 'utf8');
      if (text && !text.endsWith('\n')) throw new Error('incomplete');
      for (const line of text.trimEnd().split('\n').filter(Boolean)) {
        const row = JSON.parse(line), safe = failureDiagnostic(row.requestId, row, row.stage);
        if (typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) throw new Error('time');
        rows.push({ ...safe, at: new Date(row.at).toISOString() });
        rows = rows.slice(-20);
      }
    }
  } catch { error = true; }
  return {
    state: () => ({ items: rows.map(r => ({ ...r })), storageError: error }),
    append(input) {
      const row = failureDiagnostic(input.requestId, input, input.stage);
      rows = [...rows, row].slice(-20);
      if (error) return false;
      let fd;
      try {
        io.mkdirSync(dir, { recursive: true });
        const buffer = Buffer.from(JSON.stringify(row) + '\n');
        if ((io.existsSync(file) ? io.statSync(file).size : 0) + buffer.length > MAX_BYTES) throw new Error('size');
        fd = io.openSync(file, 'a', 0o600);
        for (let offset = 0; offset < buffer.length;) {
          const n = io.writeSync(fd, buffer, offset, buffer.length - offset);
          if (!Number.isInteger(n) || n <= 0) throw new Error('short write');
          offset += n;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
        return true;
      } catch { error = true; return false; }
      finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { error = true; } } }
    }
  };
}
module.exports = { failureDiagnostic, failureHint, makeFailureLog };
