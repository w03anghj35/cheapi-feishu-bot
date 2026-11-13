'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CHANNEL_IDS, FinanceInputError, units, decimal, sourceUnits,
  calculateSupplierBalances, calculateCustomerBalances, calculateFreeCash,
  calculateOperating, calculateMonitoredSuppliers, displayedChannelAmount } = require('./finance-metrics');

const NOW = Date.parse('2026-11-12T04:00:00Z');
const ISO = new Date(NOW).toISOString();
const rows = () => CHANNEL_IDS.map((id, index) => ({ id, name: `合成供应商${index + 1}`,
  status: 'ok', sourceUnit: index < 2 ? 'points' : 'provider_units',
  amountText: index === 0 ? '0.000000000001' : String(index + 1),
  successAt: ISO }));
const factors = () => Object.fromEntries(CHANNEL_IDS.map((id, index) => [id, {
  sourceUnit: index < 2 ? 'points' : 'provider_units', cnyPerUnit: '1.6', effectiveAt: ISO
}]));

test('金额用定点八位/十二位，不用 Number；非规格或超精度拒绝', () => {
  assert.equal(decimal(units('0.1') + units('0.2')), '0.3');
  assert.equal(sourceUnits('1.000000000001'), 1000000000001n);
  for (const value of [0.2, '1e2', '0.123456789', '1,000', 'NaN', '-0.000000001'])
    assert.throws(() => units(value), FinanceInputError);
  assert.throws(() => sourceUnits('-1'));
});

test('五站各自显式倍率折算并在末尾求和，十二位来源精度最后才舍入', () => {
  const result = calculateSupplierBalances(rows(), factors(), { now: NOW });
  assert.equal(result.status, 'ready');
  assert.equal(result.suppliers.length, 5);
  assert.equal(result.suppliers[0].amount, '0.000000000001');
  assert.equal(result.suppliers[0].convertedCny, '0');
  assert.equal(result.suppliers[1].convertedCny, '3.2');
  assert.equal(result.totalCny, '22.4');
  assert.ok(result.suppliers.every(row => row.cnyPerUnit === '1.6' && row.status === 'ok'));
});

test('页面五站原始金额只作为各站独立数值，倍率自定义后输出人民币合计', () => {
  const source = ['15,521.08661469', '999.197934825', '$25,927.09', '$15,479.30', '¥100.25'];
  const input = CHANNEL_IDS.map((id, index) => ({ id, name: `合成${index}`, status: 'ok',
    display: source[index], successAt: ISO }));
  const configured = { storageError: false, factors: CHANNEL_IDS.map(id => ({ id, rate: '1.6', updatedAt: ISO })) };
  const result = calculateMonitoredSuppliers(input, configured, { now: NOW });
  assert.equal(result.status, 'ready');
  assert.equal(result.totalCny, '92843.07927922');
  assert.ok(result.suppliers.every(row => row.sourceUnit === row.channelId && row.convertedCny !== null));
  assert.equal(displayedChannelAmount('总消费 $50'), null);
  configured.factors[0].rate = null;
  assert.equal(calculateMonitoredSuppliers(input, configured, { now: NOW }).totalCny, null);
});

test('缺倍率、单位不匹配、失败或过期站点不使用旧读数，合计为空', () => {
  const missingFactor = factors(); delete missingFactor[CHANNEL_IDS[1]];
  const result = calculateSupplierBalances(rows(), missingFactor, { now: NOW });
  assert.equal(result.totalCny, null);
  assert.equal(result.suppliers[1].convertedCny, null);
  assert.equal(result.suppliers[1].amount, '2');
  assert.equal(result.suppliers[1].status, 'missing');

  const mismatch = factors(); mismatch[CHANNEL_IDS[0]].sourceUnit = 'USD';
  assert.equal(calculateSupplierBalances(rows(), mismatch, { now: NOW }).status, 'missing');
  const zero = factors(); zero[CHANNEL_IDS[0]].cnyPerUnit = '0';
  assert.equal(calculateSupplierBalances(rows(), zero, { now: NOW }).suppliers[0].status, 'invalid');
  const staleRows = rows(); staleRows[2].successAt = new Date(NOW - 3600001).toISOString();
  assert.equal(calculateSupplierBalances(staleRows, factors(), { now: NOW }).suppliers[2].status, 'stale');
  staleRows[2].status = 'failed';
  assert.equal(calculateSupplierBalances(staleRows, factors(), { now: NOW }).suppliers[2].status, 'unavailable');
  const invalidRows = rows(); invalidRows[0].amountText = 'Infinity';
  assert.equal(calculateSupplierBalances(invalidRows, factors(), { now: NOW }).suppliers[0].status, 'invalid');
  assert.throws(() => calculateSupplierBalances([...rows().slice(0, 4), rows()[0]], factors(), { now: NOW }));
});

test('客户余额只计普通用户正数，停用普通用户照计，管理员和负数分别处理', () => {
  const result = calculateCustomerBalances({ currency: 'CNY', complete: true, total: 4, users: [
    { id: 1, role: 'admin', balanceText: '1000000' },
    { id: 2, role: 'user', status: 'active', balanceText: '0.1' },
    { id: 3, role: 'user', status: 'disabled', balanceText: '0.2' },
    { id: 4, role: 'user', status: 'inactive', balanceText: '-0.05' },
  ] });
  assert.equal(result.positiveBalanceCny, '0.3');
  assert.equal(result.negativeBalanceCny, '-0.05');
  assert.equal(result.excludedAdminCount, 1);
  assert.equal(result.positiveCount, 2);
  assert.equal(result.negativeCount, 1);
  assert.throws(() => calculateCustomerBalances({ currency: 'CNY', complete: false, total: 0, users: [] }));
  assert.throws(() => calculateCustomerBalances({ currency: 'USD', complete: true, total: 0, users: [] }));
  assert.throws(() => calculateCustomerBalances({ currency: 'CNY', complete: true, total: 2,
    users: [{ id: 1, role: 'user', balanceText: '1' }, { id: 1, role: 'user', balanceText: '2' }] }));
  assert.throws(() => calculateCustomerBalances({ currency: 'CNY', complete: true, total: 1,
    users: [{ id: 1, role: 'owner', balanceText: '100' }] }));
});

test('自由现金只有现金、五站和客户目录都完整且新鲜才计算', () => {
  const supplierBalances = calculateSupplierBalances(rows(), factors(), { now: NOW });
  const customerBalances = calculateCustomerBalances({ currency: 'CNY', complete: true, total: 2,
    users: [{ id: 1, role: 'user', balanceText: '0.3' },
      { id: 2, role: 'user', balanceText: '-0.05' }] });
  const cash = { amountText: '100', currency: 'CNY', status: 'ok', asOf: ISO };
  const value = calculateFreeCash({ cash, supplierBalances, customerBalances, now: NOW });
  assert.equal(value.valueCny, '122.1');
  assert.equal(value.customerNegativeBalanceCny, '-0.05');
  const uCash = calculateFreeCash({ cash: { amountText: '10', currency: 'U', status: 'ok',
    cnyPerUnit: '6.65', asOf: ISO }, supplierBalances, customerBalances, now: NOW });
  assert.equal(uCash.cashCny, '66.5');
  assert.equal(uCash.valueCny, '88.6');
  const missing = calculateFreeCash({ cash: null, supplierBalances, customerBalances, now: NOW });
  assert.equal(missing.valueCny, null);
  assert.ok(missing.missing.includes('cash_cny'));
  const stale = calculateFreeCash({ cash: { ...cash, asOf: new Date(NOW - 3600001).toISOString() },
    supplierBalances, customerBalances, now: NOW });
  assert.equal(stale.valueCny, null);
  assert.ok(stale.missing.includes('cash_stale'));
});

const operationInput = () => ({ now: NOW, complete: true, unit: 'platform_usage_unit',
  costBasis: 'platform_account_billed', coverage: { fromDay: '2026-11-01', throughDay: '2026-11-12', complete: true }, marketAssignments: [
    { userId: 11, marketPersonId: '张甲', fromDay: '2026-11-01', toDay: '2026-11-11' },
    { userId: 11, marketPersonId: '李乙', fromDay: '2026-11-12', toDay: null },
  ], platformChannelToSupplier: { 7: 'points-ip' }, records: [
    { id: 1, userId: 11, createdAt: '2026-11-11T15:59:00Z', actualCost: '5', platformCost: '3', channelId: 7, unit: 'platform_usage_unit' },
    { id: 2, userId: 11, createdAt: '2026-11-11T16:10:00Z', actualCost: '7', platformCost: '4', channelId: 7, unit: 'platform_usage_unit' },
    { id: 3, userId: 12, createdAt: '2026-11-12T02:00:00Z', actualCost: '0', platformCost: '0', channelId: null, unit: 'platform_usage_unit' },
  ] });

test('今日/月跨北京时间午夜计算收入、平台成本、毛利率和每个准确维度', () => {
  const result = calculateOperating(operationInput());
  assert.equal(result.today.day, '2026-11-12');
  assert.equal(result.today.total.revenue, '7');
  assert.equal(result.today.total.platformCost, '4');
  assert.equal(result.today.total.grossProfit, '3');
  assert.equal(result.today.total.grossMarginPercent, '42.8571');
  assert.equal(result.month.total.revenue, '12');
  assert.equal(result.month.total.platformCost, '7');
  assert.equal(result.month.byMarketPerson.find(row => row.id === '张甲').revenue, '5');
  assert.equal(result.month.byMarketPerson.find(row => row.id === '李乙').revenue, '7');
  assert.equal(result.today.bySupplier.find(row => row.id === 'unattributed').revenue, '0');
  assert.equal(result.month.byChannel.find(row => row.id === '7').revenue, '12');
  assert.equal(result.today.unattributedRecords, 1);
  assert.equal(result.unit, 'platform_usage_unit');
});

test('缺平台页面成本时只显示已核收入，成本毛利率为空，未归因单列', () => {
  const input = operationInput(); input.records[1].platformCost = null;
  const result = calculateOperating(input);
  assert.equal(result.today.total.revenue, '7');
  assert.equal(result.today.total.platformCost, null);
  assert.equal(result.today.total.grossProfit, null);
  assert.equal(result.today.total.grossMarginPercent, null);
  assert.equal(result.month.byMarketPerson.find(row => row.id === '李乙').status, 'cost_missing');
});

test('零收入不除零，负毛利率保留负号', () => {
  const input = operationInput();
  input.records = [{ id: 1, userId: 11, createdAt: '2026-11-11T16:10:00Z',
    actualCost: '0', platformCost: '1', channelId: 7, unit: 'platform_usage_unit' }];
  assert.equal(calculateOperating(input).today.total.grossMarginPercent, null);
  input.records[0].actualCost = '10'; input.records[0].platformCost = '10.5';
  assert.equal(calculateOperating(input).today.total.grossMarginPercent, '-5.0000');
});

test('重复明细、覆盖不完整、重叠市场归属、无成本口径均拒绝', () => {
  const input = operationInput();
  input.records.push({ ...input.records[0] });
  assert.throws(() => calculateOperating(input), FinanceInputError);
  input.records.pop(); input.complete = false;
  assert.throws(() => calculateOperating(input), FinanceInputError);
  input.complete = true; input.marketAssignments.push({ userId: 11, marketPersonId: '冲突',
    fromDay: '2026-11-12', toDay: null });
  assert.throws(() => calculateOperating(input), FinanceInputError);
  input.marketAssignments.pop(); input.costBasis = 'guessed';
  assert.throws(() => calculateOperating(input), FinanceInputError);
  input.costBasis = 'platform_account_billed'; input.records[0].unit = 'CNY';
  assert.throws(() => calculateOperating(input), FinanceInputError);
  input.records[0].unit = input.unit; input.coverage.fromDay = '2026-11-02';
  assert.throws(() => calculateOperating(input), FinanceInputError);
});
