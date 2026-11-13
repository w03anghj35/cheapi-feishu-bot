'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFinanceHttpController } = require('./finance-http-controller');
const { CHANNEL_IDS } = require('./finance-metrics');

function fixture() {
  let record = null, opened = [], tokenNo = 0;
  const store = {
    state: () => ({ configured: !!record, enabled: !!record?.enabled,
      ownerId: record?.ownerId ?? null, storageError: false }),
    secret: () => record && { ...record },
    configure: next => { record = { ...next }; return store.state(); }
  };
  const controller = makeFinanceHttpController({ store,
    assertOwner: async id => { if (id !== 7) throw Object.assign(new Error('wrong owner'), { code: 'AUTH' }); },
    getChannelRows: () => [], getFactorState: () => ({}), getCustomerSnapshot: () => ({}),
    randomToken: () => String(++tokenNo).padStart(64, 'a'),
    serverFactory: ({ token }) => {
      const instance = { token, open: false,
        address() { return this.open ? { host: '127.0.0.1', port: 5191 } : null; },
        async start() { this.open = true; }, async close() { this.open = false; } };
      opened.push(instance); return instance;
    } });
  return { controller, store, opened };
}

test('只读接口需显式启用，重开复用加密密钥，暂停与轮换立即停止旧实例', async () => {
  const f = fixture();
  assert.equal(f.controller.state().listening, false);
  await assert.rejects(f.controller.enable(8), { code: 'AUTH' });
  assert.equal(f.opened.length, 0);
  await f.controller.enable(7);
  const first = f.opened[0].token;
  assert.equal(f.controller.state().listening, true);
  assert.equal(JSON.stringify(f.controller.state()).includes(first), false);
  assert.equal(f.controller.secretForCopy(7), first);
  await f.controller.pause();
  assert.equal(f.opened[0].open, false);
  assert.equal(f.store.state().enabled, false);
  await f.controller.enable(7);
  assert.equal(f.opened[1].token, first);
  await f.controller.rotate(7);
  assert.equal(f.opened[1].open, false);
  assert.notEqual(f.opened[2].token, first);
  await f.controller.close();
  assert.equal(f.opened[2].open, false);
});

test('密钥绑定管理员，旧管理员或损坏配置不允许继续读取', async () => {
  const f = fixture();
  await f.controller.enable(7);
  await assert.rejects(f.controller.rotate(8), { code: 'AUTH' });
  assert.throws(() => f.controller.secretForCopy(8), { code: 'DENIED' });
  await f.controller.close();
});

test('控制器真实启动仅回环 HTTP，并返回与管理员折算相同的结果', async () => {
  let record = null;
  const store = { state: () => ({ configured: !!record, enabled: !!record?.enabled,
    ownerId: record?.ownerId ?? null, storageError: false }),
  secret: () => record && { ...record }, configure: next => { record = { ...next }; } };
  const stamp = new Date(Date.now() - 1000).toISOString();
  const controller = makeFinanceHttpController({ store, port: 0,
    assertOwner: async id => { assert.equal(id, 7); },
    getChannelRows: () => CHANNEL_IDS.map((id, index) => ({ id, name: `虚构站点${index}`,
      status: 'ok', display: String(index + 1), successAt: stamp })),
    getFactorState: () => ({ storageError: false, factors: CHANNEL_IDS.map(id => ({
      id, rate: '1.6', updatedAt: stamp })) }),
    getCustomerSnapshot: () => ({ complete: true, unit: 'CNY', rows: [],
      summary: { totalUsers: 0, adminCount: 0, positiveCount: 0, negativeCount: 0,
        zeroCount: 0, positiveTotal: '0', negativeTotal: '0' },
      startedAt: stamp, checkedAt: new Date().toISOString() }) });
  try {
    const running = await controller.enable(7);
    assert.equal(running.host, '127.0.0.1');
    assert.ok(running.port > 0);
    const reply = await fetch(`http://127.0.0.1:${running.port}/v1/finance/channel-balances`, {
      headers: { Authorization: `Bearer ${record.token}` } });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).totalCny, '24');
    await controller.pause();
    await assert.rejects(fetch(`http://127.0.0.1:${running.port}/health`, {
      headers: { Authorization: `Bearer ${record.token}` } }));
  } finally { await controller.close(); }
});
