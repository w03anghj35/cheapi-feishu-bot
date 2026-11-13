'use strict';

// Pure, fail-closed financial projections. Adapters must supply verified, exact
// decimal strings and explicit source units; this module never fetches data.
const SCALE = 100000000n;
const SOURCE_SCALE = 1000000000000n;
const CHANNEL_IDS = Object.freeze([
  'points-ip', 'points-anna', 'spent-ccrouter', 'spent-aerorelay', 'balance-juxiang'
]);
const MONEY = /^(-?)(0|[1-9]\d{0,11})(?:\.(\d{1,8}))?$/;
const SOURCE_MONEY = /^(0|[1-9]\d{0,11})(?:\.(\d{1,12}))?$/;
const ID = /^(?:[1-9]\d{0,15}|[a-z][a-z0-9_-]{0,63})$/i;
const ONE_HOUR_MS = 60 * 60_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class FinanceInputError extends Error {
  constructor(message) { super(message); this.code = 'FINANCE_INPUT'; }
}
const fail = message => { throw new FinanceInputError(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = value => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' && ID.test(value));
function units(value, { nonnegative = false } = {}) {
  if (typeof value !== 'string' || value.length > 32) fail('金额须为最多八位小数的十进制字符串。');
  const match = MONEY.exec(value);
  if (!match) fail('金额格式无效，不能猜测或用浮点数计算。');
  const result = (BigInt(match[2]) * SCALE + BigInt((match[3] || '').padEnd(8, '0'))) *
    (match[1] ? -1n : 1n);
  if (nonnegative && result < 0n) fail('余额或折算倍率不能为负数。');
  return result;
}
function decimal(value) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % SCALE).padStart(8, '0').replace(/0+$/, '');
  return sign + String(absolute / SCALE) + (fraction ? '.' + fraction : '');
}
function sourceUnits(value) {
  if (typeof value !== 'string' || value.length > 36) fail('渠道金额须为最多十二位小数的非负十进制字符串。');
  const match = SOURCE_MONEY.exec(value);
  if (!match) fail('渠道金额格式无效，不能使用旧金额或浮点数补齐。');
  return BigInt(match[1]) * SOURCE_SCALE + BigInt((match[2] || '').padEnd(12, '0'));
}
function sourceDecimal(value) {
  const fraction = String(value % SOURCE_SCALE).padStart(12, '0').replace(/0+$/, '');
  return String(value / SOURCE_SCALE) + (fraction ? '.' + fraction : '');
}
function timestamp(value, now) {
  if (typeof value !== 'string' || value.length > 64 || !/(?:Z|[+-]\d\d:\d\d)$/.test(value))
    fail('时间必须包含时区。');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now) fail('时间无效或来自未来。');
  return parsed;
}
function currentTime(value) {
  const now = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(now) || now <= 0) fail('核对时间无效。');
  return now;
}
function sourceUnit(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value))
    fail('来源单位缺失或无效。');
  return value;
}
function missing(status, reason) { return { status, reason }; }

function calculateSupplierBalances(rows, factors, { now = Date.now(), maxAgeMs = ONE_HOUR_MS } = {}) {
  const at = currentTime(now);
  if (!Array.isArray(rows) || rows.length !== CHANNEL_IDS.length || !object(factors) ||
      !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) fail('必须提供五个渠道及有效核对时效。');
  const byId = new Map();
  for (const row of rows) {
    if (!object(row) || !CHANNEL_IDS.includes(row.id) || byId.has(row.id))
      fail('渠道编号未知或重复，拒绝不完整汇总。');
    byId.set(row.id, row);
  }
  if (Object.keys(factors).some(id => !CHANNEL_IDS.includes(id))) fail('折算配置含未知渠道。');
  const suppliers = [], reasons = [];
  let total = 0n;
  for (const id of CHANNEL_IDS) {
    const row = byId.get(id);
    const result = { channelId: id, supplierId: id, name: typeof row.name === 'string' ? row.name.slice(0, 40) : id,
      sourceUnit: null, amount: null, cnyPerUnit: null, convertedCny: null,
      status: 'missing', reason: null, successAt: row.successAt ?? null };
    try {
      if (row.status !== 'ok') throw missing('unavailable', '渠道本次未成功读取');
      const successAt = timestamp(row.successAt, at);
      if (at - successAt > maxAgeMs) throw missing('stale', '渠道余额已过期');
      const unit = sourceUnit(row.sourceUnit);
      const value = sourceUnits(row.amountText);
      result.sourceUnit = unit;
      result.amount = sourceDecimal(value);
      const factor = factors[id];
      if (!object(factor) || factor.sourceUnit !== unit) throw missing('missing', '缺少该渠道单位匹配的人民币折算倍率');
      const rate = units(factor.cnyPerUnit, { nonnegative: true });
      if (rate === 0n) throw missing('invalid', '人民币折算倍率须大于零');
      timestamp(factor.effectiveAt, at);
      result.cnyPerUnit = decimal(rate);
      const converted = value * rate;
      result.convertedCny = decimal((converted + SOURCE_SCALE / 2n) / SOURCE_SCALE);
      result.status = 'ok';
      total += units(result.convertedCny);
    } catch (error) {
      const detail = error instanceof FinanceInputError ? missing('invalid', error.message) : error;
      if (!detail || !['unavailable', 'stale', 'missing', 'invalid'].includes(detail.status)) throw error;
      result.status = detail.status;
      result.reason = detail.reason;
      reasons.push({ channelId: id, code: detail.status });
    }
    suppliers.push(result);
  }
  return { suppliers, totalCny: reasons.length ? null : decimal(total),
    status: reasons.length ? 'missing' : 'ready', missing: reasons, asOf: new Date(at).toISOString() };
}

function displayedChannelAmount(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = /^(?:(?:USD|US\$|积分|Points?)\s*)?[¥$￥€£]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,12})?)\s*(?:积分|points?|USD|元)?$/i.exec(value.trim());
  if (!match) return null;
  return match[1].replace(/,/g, '');
}

function calculateMonitoredSuppliers(channelRows, factorState, options = {}) {
  if (!object(factorState) || factorState.storageError || !Array.isArray(factorState.factors) ||
      factorState.factors.length !== CHANNEL_IDS.length) fail('渠道倍率配置无法安全核对。');
  const factors = {};
  const seen = new Set();
  for (const row of factorState.factors) {
    if (!object(row) || !CHANNEL_IDS.includes(row.id) || seen.has(row.id)) fail('渠道倍率配置编号重复或未知。');
    seen.add(row.id);
    if (row.rate !== null) {
      if (typeof row.rate !== 'string' || typeof row.updatedAt !== 'string') fail('渠道倍率配置不完整。');
      factors[row.id] = { sourceUnit: row.id, cnyPerUnit: row.rate, effectiveAt: row.updatedAt };
    }
  }
  if (!Array.isArray(channelRows)) fail('渠道读数不可用。');
  return calculateSupplierBalances(channelRows.map(row => ({
    id: row.id, name: row.name, status: row.status, successAt: row.successAt,
    sourceUnit: row.id, amountText: displayedChannelAmount(row.display)
  })), factors, options);
}

function calculateCustomerBalances(input) {
  if (!object(input) || input.currency !== 'CNY' || input.complete !== true ||
      !Array.isArray(input.users) || input.users.length > 5000 ||
      !Number.isSafeInteger(input.total) || input.total !== input.users.length)
    fail('客户目录或人民币口径不完整。');
  const seen = new Set();
  let positive = 0n, negative = 0n, positiveCount = 0, negativeCount = 0, excludedAdminCount = 0;
  for (const row of input.users) {
    if (!object(row) || !validId(row.id) || seen.has(row.id) || !['user', 'admin'].includes(row.role))
      fail('客户目录用户编号或角色无法核对。');
    seen.add(row.id);
    if (row.role !== 'user') { excludedAdminCount++; continue; }
    const balance = units(row.balanceText);
    if (balance > 0n) { positive += balance; positiveCount++; }
    if (balance < 0n) { negative += balance; negativeCount++; }
  }
  return { currency: 'CNY', positiveBalanceCny: decimal(positive), negativeBalanceCny: decimal(negative),
    positiveCount, negativeCount, excludedAdminCount, scannedUsers: seen.size, complete: true };
}

function calculateFreeCash({ cash, supplierBalances, customerBalances, now = Date.now(), maxCashAgeMs = ONE_HOUR_MS }) {
  const at = currentTime(now), missingFields = [];
  let cashUnits = null;
  if (!object(cash) || cash.status !== 'ok' || !['CNY', 'U'].includes(cash.currency)) missingFields.push('cash_cny');
  else {
    try {
      const rawCash = units(cash.amountText, { nonnegative: true });
      if (cash.currency === 'U') {
        const factor = units(cash.cnyPerUnit, { nonnegative: true });
        if (factor === 0n) fail('财务 U 余额折算倍率须大于零。');
        cashUnits = (rawCash * factor + SCALE / 2n) / SCALE;
      } else {
        if (cash.cnyPerUnit !== undefined && cash.cnyPerUnit !== null) fail('人民币现金不能重复折算。');
        cashUnits = rawCash;
      }
      if (at - timestamp(cash.asOf, at) > maxCashAgeMs) { cashUnits = null; missingFields.push('cash_stale'); }
    } catch { missingFields.push('cash_invalid'); }
  }
  if (!object(supplierBalances) || supplierBalances.status !== 'ready' || supplierBalances.totalCny === null)
    missingFields.push('supplier_prepaid');
  if (!object(customerBalances) || customerBalances.complete !== true || customerBalances.currency !== 'CNY')
    missingFields.push('customer_positive_balance');
  if (missingFields.length) return { status: 'missing_inputs', valueCny: null, currency: 'CNY',
    cashCny: cashUnits === null ? null : decimal(cashUnits),
    supplierPrepaidCny: supplierBalances?.totalCny ?? null,
    customerPositiveBalanceCny: customerBalances?.positiveBalanceCny ?? null,
    customerNegativeBalanceCny: customerBalances?.negativeBalanceCny ?? null,
    missing: missingFields, asOf: new Date(at).toISOString() };
  const supplier = units(supplierBalances.totalCny, { nonnegative: true });
  const customer = units(customerBalances.positiveBalanceCny, { nonnegative: true });
  return { status: 'ready', valueCny: decimal(cashUnits + supplier - customer), currency: 'CNY',
    cashCny: decimal(cashUnits), supplierPrepaidCny: decimal(supplier),
    customerPositiveBalanceCny: decimal(customer),
    customerNegativeBalanceCny: customerBalances.negativeBalanceCny,
    missing: [], asOf: new Date(at).toISOString() };
}

function beijingDay(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function validDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) fail('归属生效日期无效。');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('归属生效日期无效。');
  return value;
}
function marketFor(userId, day, assignments) {
  const applicable = assignments.filter(row => row.userId === userId && validDay(row.fromDay) <= day &&
    (row.toDay === null || validDay(row.toDay) >= day));
  if (applicable.length > 1) fail('同一日期客户存在多个市场人员归属。');
  return applicable.length ? applicable[0].marketPersonId : 'unattributed';
}
function marginPercent(profit, revenue) {
  if (revenue === 0n) return null;
  const scaled = profit * 1000000n / revenue; // Percent to four decimal places, truncated toward zero.
  const absolute = scaled < 0n ? -scaled : scaled;
  const whole = absolute / 10000n;
  const frac = String(absolute % 10000n).padStart(4, '0');
  return `${scaled < 0n ? '-' : ''}${whole}.${frac}`;
}
function aggregate(rows, missingCost) {
  const revenue = rows.reduce((sum, row) => sum + row.revenue, 0n);
  if (missingCost || rows.some(row => row.cost === null))
    return { revenue: decimal(revenue), platformCost: null, grossProfit: null,
      grossMarginPercent: null, status: 'cost_missing' };
  const cost = rows.reduce((sum, row) => sum + row.cost, 0n);
  const profit = revenue - cost;
  return { revenue: decimal(revenue), platformCost: decimal(cost),
    grossProfit: decimal(profit), grossMarginPercent: marginPercent(profit, revenue), status: 'ready' };
}
function calculateOperating(input) {
  if (!object(input) || input.complete !== true || !Array.isArray(input.records) || input.records.length > 100000 ||
      !Array.isArray(input.marketAssignments) || !object(input.platformChannelToSupplier) ||
      typeof input.unit !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(input.unit) ||
      input.costBasis !== 'platform_account_billed' || !object(input.coverage) ||
      input.coverage.complete !== true)
    fail('经营明细覆盖不完整。');
  const at = currentTime(input.now ?? Date.now());
  const today = beijingDay(at), month = today.slice(0, 7);
  if (validDay(input.coverage.fromDay) > `${month}-01` || validDay(input.coverage.throughDay) < today)
    fail('经营明细没有覆盖整个本月至当前北京时间日期。');
  for (const assignment of input.marketAssignments) {
    if (!object(assignment) || !validId(assignment.userId) ||
        typeof assignment.marketPersonId !== 'string' || !assignment.marketPersonId ||
        assignment.marketPersonId.length > 100 || /[\x00-\x1f\x7f]/.test(assignment.marketPersonId) ||
        validDay(assignment.fromDay) > (assignment.toDay === null ? '9999-12-31' : validDay(assignment.toDay)))
      fail('市场人员归属映射无效。');
  }
  for (const [channelId, supplierId] of Object.entries(input.platformChannelToSupplier)) {
    if (!validId(channelId) || !CHANNEL_IDS.includes(supplierId)) fail('渠道到供应商的映射无效。');
  }
  const seen = new Set(), rows = [];
  for (const raw of input.records) {
    if (!object(raw) || !validId(raw.id) || seen.has(raw.id) || !validId(raw.userId) ||
        raw.unit !== input.unit || !(raw.channelId === null || raw.channelId === undefined || validId(raw.channelId)))
      fail('经营明细编号、客户、渠道或单位无法核对。');
    seen.add(raw.id);
    const moment = timestamp(raw.createdAt, at), day = beijingDay(moment);
    if (day.slice(0, 7) !== month) continue;
    const revenue = units(raw.actualCost, { nonnegative: true });
    const cost = raw.platformCost === null || raw.platformCost === undefined ? null :
      units(raw.platformCost, { nonnegative: true });
    const customerId = String(raw.userId);
    const marketPersonId = marketFor(raw.userId, day, input.marketAssignments);
    const channelId = raw.channelId === null || raw.channelId === undefined ? 'unattributed' : String(raw.channelId);
    let supplierId = 'unattributed';
    if (channelId !== 'unattributed' && Object.hasOwn(input.platformChannelToSupplier, channelId)) {
      const value = input.platformChannelToSupplier[channelId];
      supplierId = value;
    }
    rows.push({ day, revenue, cost, customerId, marketPersonId, channelId, supplierId });
  }
  const period = selected => {
    const selectedRows = rows.filter(selected);
    const by = field => {
      const buckets = new Map();
      for (const row of selectedRows) {
        const key = row[field];
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
      }
      return [...buckets].map(([id, values]) => ({ id, ...aggregate(values, false) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    };
    return { total: aggregate(selectedRows, false), byCustomer: by('customerId'),
      byMarketPerson: by('marketPersonId'), byChannel: by('channelId'), bySupplier: by('supplierId'),
      records: selectedRows.length, unattributedRecords: selectedRows.filter(row =>
        row.marketPersonId === 'unattributed' || row.supplierId === 'unattributed').length };
  };
  return { today: { day: today, ...period(row => row.day === today) },
    month: { month, ...period(() => true) }, unit: input.unit, complete: true,
    asOf: new Date(at).toISOString(), costBasis: input.costBasis,
    coverage: { ...input.coverage } };
}

const exportsForFinance = { FinanceInputError, CHANNEL_IDS, units, decimal, sourceUnits, sourceDecimal, displayedChannelAmount,
  calculateMonitoredSuppliers, calculateSupplierBalances,
  calculateCustomerBalances, calculateFreeCash, calculateOperating };
if (typeof module !== 'undefined' && module.exports) module.exports = exportsForFinance;
else if (typeof window !== 'undefined') window.financeMetrics = exportsForFinance;
