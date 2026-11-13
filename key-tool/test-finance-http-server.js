'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { createFinanceHttpServer } = require('./finance-http-server');
const { CHANNEL_IDS } = require('./finance-metrics');

const NOW = Date.parse('2026-11-12T04:00:00Z');
const TOKEN = randomBytes(32).toString('hex');
const rows = () => CHANNEL_IDS.map((id, index) => ({ id, name: `虚构渠道${index}`,
  status: 'ok', successAt: new Date(NOW - 60_000).toISOString(), display: String(index + 1) }));
const factors = () => ({ storageError: false, factors: CHANNEL_IDS.map(id => ({
  id, rate: '1.6', updatedAt: new Date(NOW - 60_000).toISOString()
})) });
const customers = () => ({ complete: true, unit: 'CNY',
  startedAt: new Date(NOW - 1000).toISOString(), checkedAt: new Date(NOW).toISOString(),
  summary: { totalUsers: 4, adminCount: 1, positiveCount: 2, negativeCount: 1,
    zeroCount: 0, positiveTotal: '0.3', negativeTotal: '-0.05' }, rows: [
    { id: 1, role: 'admin', balance: '999', email: 'private@example.invalid', secret: 'never-send' },
    { id: 2, role: 'user', balance: '0.1' },
    { id: 3, role: 'user', balance: '0.2' },
    { id: 4, role: 'user', balance: '-0.05' }
  ] });

async function fixture(extra = {}) {
  const service = createFinanceHttpServer({ token: TOKEN, getChannelRows: rows,
    getFactorState: factors, now: () => NOW, ...extra });
  const { port } = await service.start();
  return { service, port, url: `http://127.0.0.1:${port}` };
}

function request(port, path, { method = 'GET', authorization = `Bearer ${TOKEN}`,
  headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { ...(authorization === null ? {} : { Authorization: authorization }), ...headers } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: JSON.parse(data), text: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('本机只读接口输出五站折算结果，缺倍率和旧读数绝不伪造总余额', async () => {
  let sourceRows = rows(), sourceFactors = factors();
  const f = await fixture({ getChannelRows: () => sourceRows, getFactorState: () => sourceFactors });
  try {
    assert.deepEqual(f.service.address(), { host: '127.0.0.1', port: f.port });
    assert.deepEqual((await request(f.port, '/health')).body, { status: 'ok' });
    let response = await request(f.port, '/v1/finance/channel-balances');
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.body.totalCny, '24');
    assert.equal(response.body.suppliers.length, 5);
    sourceFactors.factors[0].rate = null;
    response = await request(f.port, '/v1/finance/channel-balances');
    assert.equal(response.body.status, 'missing');
    assert.equal(response.body.totalCny, null);
    sourceFactors = factors();
    sourceRows[1].successAt = new Date(NOW - 3600001).toISOString();
    response = await request(f.port, '/v1/finance/channel-balances');
    assert.equal(response.body.suppliers[1].status, 'stale');
    assert.equal(response.body.totalCny, null);
    sourceRows[1].status = 'failed';
    response = await request(f.port, '/v1/finance/channel-balances');
    assert.equal(response.body.suppliers[1].status, 'unavailable');
  } finally { await f.service.close(); }
  assert.equal(f.service.address(), null);
});

test('凭据、Host、Origin、写方法、请求体和查询参数都不能越过边界', async () => {
  const f = await fixture();
  try {
    for (const authorization of [null, 'Bearer ' + '0'.repeat(64), `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      const response = await request(f.port, '/v1/finance/channel-balances', { authorization });
      assert.equal(response.status, 401);
      assert.equal(response.text.includes(TOKEN), false);
    }
    assert.equal((await request(f.port, '/v1/finance/channel-balances', {
      headers: { Authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] }
    })).status, 401);
    assert.equal((await request(f.port, '/v1/finance/channel-balances', {
      headers: { Host: `localhost:${f.port}` }
    })).status, 403);
    assert.equal((await request(f.port, '/v1/finance/channel-balances', {
      headers: { Origin: 'https://example.invalid' }
    })).status, 403);
    assert.equal((await request(f.port, '/v1/finance/channel-balances', {
      headers: { Referer: 'https://example.invalid' }
    })).status, 403);
    assert.equal((await request(f.port, '/v1/finance/channel-balances', { method: 'POST' })).status, 405);
    assert.equal((await request(f.port, '/v1/finance/channel-balances', {
      method: 'GET', headers: { 'Content-Length': '1' }, body: 'x'
    })).status, 400);
    assert.equal((await request(f.port, `/v1/finance/channel-balances?token=${TOKEN}`)).status, 404);
    assert.equal((await request(f.port, '/v1/finance/customer-balances')).status, 404);
  } finally { await f.service.close(); }
});

test('客户余额只返回完整汇总，管理员及邮箱不泄露；全目录查询单飞且冷却', async () => {
  let clock = NOW, calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture({ now: () => clock, getCustomerSnapshot: async () => {
    calls++; await pending; return customers();
  }, customerCooldownMs: 1000 });
  try {
    const first = request(f.port, '/v1/finance/customer-balances');
    await new Promise(resolve => setImmediate(resolve));
    const concurrent = await request(f.port, '/v1/finance/customer-balances');
    assert.equal(concurrent.status, 429);
    assert.equal(calls, 1);
    release();
    const result = await first;
    assert.equal(result.status, 200);
    assert.equal(result.body.positiveBalanceCny, '0.3');
    assert.equal(result.body.negativeBalanceCny, '-0.05');
    assert.equal(result.body.excludedAdminCount, 1);
    assert.equal(result.text.includes('private@example.invalid'), false);
    assert.equal(result.text.includes('never-send'), false);
    assert.equal((await request(f.port, '/v1/finance/customer-balances')).status, 429);
    clock += 1000;
    assert.equal((await request(f.port, '/v1/finance/customer-balances')).status, 200);
    assert.equal(calls, 2);
  } finally { release(); await f.service.close(); }
});

test('损坏配置、缺页和来源异常只给固定错误，不输出部分金额', async () => {
  let reads = 0;
  const f = await fixture({ getChannelRows: () => { reads++; return rows(); },
    getFactorState: () => { throw new Error('private file path'); },
    getCustomerSnapshot: () => ({ ...customers(), complete: false }), customerCooldownMs: 1000 });
  try {
    const channel = await request(f.port, '/v1/finance/channel-balances');
    assert.equal(channel.status, 503);
    assert.deepEqual(channel.body, { error: 'FINANCE_SOURCE_UNAVAILABLE' });
    const customer = await request(f.port, '/v1/finance/customer-balances');
    assert.equal(customer.status, 503);
    assert.deepEqual(customer.body, { error: 'FINANCE_SOURCE_UNAVAILABLE' });
    assert.equal(channel.text.includes('999'), false);
    assert.equal(channel.text.includes('private file path'), false);
    assert.equal(reads, 0);
  } finally { await f.service.close(); }
});

test('客户目录即使完整，返回过期或未来核对时间也不发布', async () => {
  let snapshot = customers(), clock = NOW;
  const f = await fixture({ getCustomerSnapshot: () => snapshot, now: () => clock,
    customerCooldownMs: 1000 });
  try {
    snapshot.checkedAt = new Date(NOW - 120001).toISOString();
    assert.equal((await request(f.port, '/v1/finance/customer-balances')).status, 503);
    clock += 1000;
    snapshot = customers(); snapshot.checkedAt = new Date(NOW + 2000).toISOString();
    assert.equal((await request(f.port, '/v1/finance/customer-balances')).status, 503);
  } finally { await f.service.close(); }
});

test('客户目录汇总与逐行数值不一致时不发布财务余额', async () => {
  let snapshot = customers(), clock = NOW;
  const f = await fixture({ getCustomerSnapshot: () => snapshot, now: () => clock,
    customerCooldownMs: 1000 });
  try {
    snapshot.summary.positiveTotal = '999';
    assert.equal((await request(f.port, '/v1/finance/customer-balances')).status, 503);
    clock += 1000;
    snapshot = customers(); snapshot.startedAt = new Date(NOW - 121000).toISOString();
    assert.equal((await request(f.port, '/v1/finance/customer-balances')).status, 503);
  } finally { await f.service.close(); }
});

test('慢渠道读取超时后保持单飞，关闭服务不等待未响应上游', async () => {
  let calls = 0, resolveSource;
  const pending = new Promise(resolve => { resolveSource = resolve; });
  const f = await fixture({ channelTimeoutMs: 20, getChannelRows: () => { calls++; return pending; } });
  try {
    const first = await request(f.port, '/v1/finance/channel-balances');
    assert.equal(first.status, 503);
    const second = await request(f.port, '/v1/finance/channel-balances');
    assert.equal(second.status, 429);
    assert.equal(calls, 1);
    await Promise.race([f.service.close(), new Promise((_, reject) =>
      setTimeout(() => reject(new Error('close timed out')), 300))]);
    assert.equal(f.service.address(), null);
  } finally { resolveSource(rows()); await f.service.close(); }
});

test('慢客户目录超时后不重叠读取，关闭时向提供者发出取消信号', async () => {
  let calls = 0, resolveSource, signal;
  const pending = new Promise(resolve => { resolveSource = resolve; });
  const f = await fixture({ customerTimeoutMs: 20, customerCooldownMs: 1000,
    getCustomerSnapshot: ({ signal: sourceSignal }) => {
      calls++; signal = sourceSignal; return pending;
    } });
  try {
    assert.equal((await request(f.port, '/v1/finance/customer-balances')).status, 503);
    assert.equal(signal.aborted, true);
    assert.equal((await request(f.port, '/v1/finance/customer-balances')).status, 429);
    assert.equal(calls, 1);
    await Promise.race([f.service.close(), new Promise((_, reject) =>
      setTimeout(() => reject(new Error('close timed out')), 300))]);
  } finally { resolveSource(customers()); await f.service.close(); }
});

test('无效凭据或配置拒绝启动，已占端口不能旁路绑定', async () => {
  assert.throws(() => createFinanceHttpServer({ token: 'short', getChannelRows: rows, getFactorState: factors }));
  const first = await fixture();
  const second = createFinanceHttpServer({ token: TOKEN, getChannelRows: rows, getFactorState: factors,
    port: first.port });
  try { await assert.rejects(second.start(), { code: 'EADDRINUSE' }); }
  finally { await first.service.close(); }
});
