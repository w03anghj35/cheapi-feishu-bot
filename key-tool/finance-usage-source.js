'use strict';

// Fixed, injectable read adapter for the platform usage summary. The caller
// supplies the existing administrator-checked request function. No HTTP or
// financial result is persisted here.
const { dayKey, beijingDay } = require('./daily-usage');
const { amount } = require('./recharge-query');

class FinanceUsageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new FinanceUsageError(code, message); };
const validId = value => Number.isSafeInteger(value) && value > 0;

function nonnegativeMoney(value, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      typeof value === 'number' && !Number.isFinite(value))
    fail('SCHEMA', `${label}不是可核对的金额，本次不返回部分结果。`);
  let normalized;
  try { normalized = amount(value); }
  catch { fail('SCHEMA', `${label}精度无法核对，本次不返回部分结果。`); }
  if (normalized.startsWith('-')) fail('SCHEMA', `${label}不能为负数，本次不返回部分结果。`);
  return normalized;
}

function statsRoute(userId, day) {
  if (!validId(userId)) fail('INPUT', '请选择准确的平台普通用户编号。');
  let date;
  try { date = dayKey(day); }
  catch { fail('INPUT', '请选择有效的北京时间自然日。'); }
  return `/admin/usage/stats?user_id=${userId}&start_date=${date}&end_date=${date}`;
}

function projectStats(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      !Object.hasOwn(raw, 'total_actual_cost'))
    fail('SCHEMA', '平台统计缺少用户实付，本次不返回不完整收入。');
  const revenue = nonnegativeMoney(raw.total_actual_cost, '用户实付');
  // Orange cost under the platform's total consumption card. total_cost is a
  // separate standard-cost field, never a fallback for missing account cost.
  const hasCost = Object.hasOwn(raw, 'total_account_cost') && raw.total_account_cost !== null;
  const accountCost = hasCost ? nonnegativeMoney(raw.total_account_cost, '平台账号成本') : null;
  return { revenue, accountCost, costStatus: hasCost ? 'ready' : 'missing',
    costBasis: 'platform_account_billed' };
}

async function readDailyStats({ userId, day, request, getOwner, now = () => Date.now() } = {}) {
  const route = statsRoute(userId, day);
  if (typeof request !== 'function' || typeof getOwner !== 'function' || typeof now !== 'function')
    fail('INPUT', '缺少经管理员授权的只读请求或身份核对函数。');
  const owner = getOwner();
  if (!validId(owner)) fail('AUTH', '平台管理员身份尚未核实。');
  const started = now();
  if (!Number.isSafeInteger(started) || started <= 0 || day > beijingDay(started))
    fail('INPUT', '不能查询未来的北京时间自然日。');
  // Exactly one fixed GET. The injected request must enforce the platform
  // Bearer, admin role and original main-process route allowlist.
  const projected = projectStats(await request('GET', route));
  if (getOwner() !== owner) fail('AUTH', '读取期间平台管理员已变化，本次不返回旧结果。');
  const checked = now();
  if (!Number.isSafeInteger(checked) || checked <= 0 || beijingDay(checked) !== beijingDay(started))
    fail('CONFLICT', '读取跨越北京时间午夜，请重新查询。');
  return { userId, day, ...projected, final: day < beijingDay(checked),
    unit: 'platform_usage_unit', platformAdminId: owner,
    checkedAt: new Date(checked).toISOString() };
}

function currentMonthCoverage(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now <= 0) fail('INPUT', '月份核对时间无效。');
  const throughDay = beijingDay(now), fromDay = throughDay.slice(0, 8) + '01';
  const year = Number(throughDay.slice(0, 4)), month = Number(throughDay.slice(5, 7));
  const count = Number(throughDay.slice(8, 10));
  const days = Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(year, month - 1, index + 1)).toISOString().slice(0, 10));
  // Enumerating days is not evidence that any account/day was actually read.
  return { fromDay, throughDay, days, complete: false, status: 'not_collected' };
}

module.exports = { FinanceUsageError, statsRoute, projectStats, readDailyStats, currentMonthCoverage };
