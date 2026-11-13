'use strict';

const { ToolError } = require('./service');
const { amount } = require('./recharge-query');
const { units, decimal } = require('./finance-metrics');
const validId = value => Number.isSafeInteger(value) && value > 0;
const fail = (code, message) => { throw new ToolError(code, message); };
const text = (value, max, empty = false) => typeof value === 'string' &&
  (empty || value.length > 0) && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

function projectUser(raw) {
  if (!validId(raw?.id) || !text(raw.email, 254) || !text(raw.username, 100, true) ||
      !['user', 'admin'].includes(raw.role) || !['active', 'disabled', 'inactive'].includes(raw.status))
    fail('SCHEMA', '平台用户身份、角色或状态不完整，本次不显示不完整合计。');
  let balance;
  try { balance = amount(raw.balance); units(balance); }
  catch { fail('SCHEMA', `用户 ID ${raw.id} 的余额格式无法核对，本次不显示不完整合计。`); }
  return { id: raw.id, email: raw.email, username: raw.username,
    role: raw.role, status: raw.status, balance,
    included: raw.role === 'user' && units(balance) > 0n };
}

function summarizeBalances(rows) {
  let positiveTotal = 0n, negativeTotal = 0n, excludedAdminPositive = 0n;
  let adminCount = 0, positiveCount = 0, zeroCount = 0, negativeCount = 0;
  for (const row of rows) {
    if (!['user', 'admin'].includes(row.role)) fail('SCHEMA', '用户角色无法核对。');
    const value = units(row.balance);
    if (row.role === 'admin') {
      adminCount++;
      if (value > 0n) excludedAdminPositive += value;
    } else if (value > 0n) { positiveCount++; positiveTotal += value; }
    else if (value < 0n) { negativeCount++; negativeTotal += value; }
    else zeroCount++;
  }
  return { totalUsers: rows.length, adminCount, positiveCount, zeroCount, negativeCount,
    positiveTotal: decimal(positiveTotal), negativeTotal: decimal(negativeTotal),
    excludedAdminPositive: decimal(excludedAdminPositive) };
}

class UserBalanceQuery {
  constructor({ request, getOwner, now = () => Date.now(), maxDurationMs = 120000 }) {
    Object.assign(this, { request, getOwner, now, maxDurationMs });
    this.busy = false;
  }
  async admin(expected) {
    if (!validId(expected) || this.getOwner() !== expected)
      fail('AUTH', '请先完成平台管理员授权。');
    const me = await this.request('GET', '/auth/me');
    if (this.getOwner() !== expected || me?.id !== expected || me?.role !== 'admin')
      fail('DENIED', '管理员授权已变化，未返回用户余额。');
  }
  async query(input = {}) {
    if (this.busy) fail('BUSY', '正在读取用户余额，请等待本次完成。');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
      fail('INPUT', '用户余额只允许读取完整用户列表。');
    this.busy = true;
    const start = this.now(), owner = this.getOwner();
    const check = () => {
      if (this.getOwner() !== owner) fail('AUTH', '管理员身份已变化，未返回用户余额。');
      if (this.now() - start >= this.maxDurationMs)
        fail('LIMIT', '用户余额读取超时，本次不显示不完整合计；请稍后重试。');
    };
    try {
      await this.admin(owner);
      const rows = [], seen = new Set(); let total, complete = false;
      for (let page = 1; page <= 50; page++) {
        check();
        const data = await this.request('GET', `/admin/users?page=${page}&page_size=100`);
        check();
        if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
            data.items.length > 100 || total !== undefined && data.total !== total)
          fail('SCHEMA', '用户目录分页变化或不完整，本次不显示不完整合计。');
        if (data.total > 5000) fail('LIMIT', '用户超过 5000 个，本次不显示不完整合计。');
        total = data.total;
        for (const raw of data.items) {
          const row = projectUser(raw);
          if (seen.has(row.id)) fail('SCHEMA', '用户目录存在重复 ID，本次不显示不完整合计。');
          seen.add(row.id); rows.push(row);
        }
        if (rows.length === total) { complete = true; break; }
        if (data.items.length < 100 || rows.length > total)
          fail('SCHEMA', '用户目录缺页，本次不显示不完整合计。');
      }
      if (!complete) fail('LIMIT', '用户目录超过分页上限。');
      await this.admin(owner);
      check();
      rows.sort((a, b) => {
        const difference = units(a.balance) - units(b.balance);
        return difference < 0n ? -1 : difference > 0n ? 1 : a.id - b.id;
      });
      return { rows, summary: summarizeBalances(rows), startedAt: new Date(start).toISOString(),
        checkedAt: new Date(this.now()).toISOString(), complete: true, unit: 'CNY' };
    } finally { this.busy = false; }
  }
}

module.exports = { UserBalanceQuery, projectUser, summarizeBalances };
