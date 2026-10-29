'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UserRegistrationService, registrationBody, assertRegistrationBody } = require('./user-registration-service');
const { makeDiskStore } = require('./disk-store');
const input = change => ({ requestId: randomUUID(), email: 'fictional@example.invalid', username: '测试用户',
  password: '  Fictional  Password  ', concurrency: 50, balance: 0, ...change });
const context = change => ({ verifiedActor: { name: '飞书用户#0123456789abcdef0123', source: 'feishu-open-id', verified: true },
  feishuGroupId: 'oc_fixture_12345678', guard: () => true, ...change });
function setup(options = {}) {
  let rows = structuredClone(options.rows || []), owner = 1, saves = 0;
  const calls = [], order = [];
  const store = options.store || { load: () => structuredClone(rows), save: value => {
    order.push('save'); if (++saves === options.failSave) throw new Error('fictional storage failure');
    rows = structuredClone(value);
  } };
  const request = async (method, route, body, ctx) => {
    calls.push({ method, route, body: body && structuredClone(body) }); order.push(method);
    if (method === 'GET') return options.me ? options.me() : { id: owner, role: 'admin' };
    if (options.post) return options.post(body, ctx);
    return { ...body, id: 99, ignoredSecret: 'do-not-persist-response' };
  };
  const service = new UserRegistrationService({ request, store, getOwner: () => owner });
  return { service, calls, order, rows: () => rows, owner: v => { owner = v; }, posts: () => calls.filter(x => x.method === 'POST') };
}
for (const balance of [0, 1, 5, 10]) for (const concurrency of [1, 50]) {
  test(`registration balance ${balance}, concurrency ${concurrency}: durable pending, one POST and no secret in audit`, async () => {
    const f = setup(), data = input({ balance, concurrency });
    const result = await f.service.create(data, context());
    assert.deepEqual(f.order, ['GET', 'save', 'POST', 'save']);
    assert.equal(result.id, 99); assert.equal(f.posts().length, 1);
    assert.equal(f.posts()[0].body.password, data.password);
    assert.equal(f.posts()[0].body.role, 'user'); assert.equal(f.posts()[0].body.rpm_limit, 0);
    assert.equal(JSON.stringify(f.rows()).includes(data.password), false);
    assert.equal(JSON.stringify(f.rows()).includes('ignoredSecret'), false);
    assert.equal(f.service.adminRecords().items[0].balance, balance);
    assert.equal(f.service.records[0].state, 'success');
    await assert.rejects(f.service.create(data, context()), { code: 'DUPLICATE' });
  });
}
test('reject invalid role, numeric boundaries, control characters and non-exact adapter bodies', () => {
  for (const change of [{ role: 'admin' }, { concurrency: 0 }, { concurrency: 51 }, { concurrency: 1.5 },
    { concurrency: NaN }, { concurrency: '5' }, { balance: 2 }, { balance: '1' }, { balance: null },
    { email: 'not-an-email' }, { email: 'a\u0000@example.invalid' }, { username: 'a\n' }, { username: '' },
    { password: '1234567' }, { password: '        ' }, { password: 'a'.repeat(73) }, { password: '中'.repeat(25) },
    { password: 'password\n' }, { requestId: 'bad' }]) assert.throws(() => registrationBody(input(change)), { code: 'INPUT' });
  const body = registrationBody(input({ password: '中'.repeat(24) }));
  assert.deepEqual(assertRegistrationBody(body), body);
  for (const change of [{ role: 'admin' }, { rpm_limit: 1 }, { extra: true }, { notes: 'x' }])
    assert.throws(() => assertRegistrationBody({ ...body, ...change }), { code: 'INPUT' });
});
test('preflight requires admin, same owner and stable policy, without POST or audit mutation', async () => {
  for (const me of [() => ({ id: 1, role: 'user' }), () => ({ id: 2, role: 'admin' })]) {
    const f = setup({ me }); await assert.rejects(f.service.create(input(), context()), { code: 'DENIED' });
    assert.equal(f.posts().length, 0); assert.equal(f.service.records.length, 0);
  }
  const f = setup(); let guardCalls = 0;
  await assert.rejects(f.service.create(input(), context({ guard: () => ++guardCalls === 1 })), { code: 'POLICY' });
  assert.equal(f.posts().length, 0);
});
test('pending save failure stops before POST; success save failure retains pending and locks creation', async () => {
  for (const failSave of [1, 2]) {
    const f = setup({ failSave });
    await assert.rejects(f.service.create(input(), context()), { code: 'STORAGE' });
    assert.equal(f.posts().length, failSave - 1); assert.equal(f.service.storageFault, true);
    if (failSave === 2) assert.equal(f.service.records[0].state, 'pending');
    await assert.rejects(f.service.create(input(), context()), { code: 'STORAGE' });
  }
});
test('timeout or ambiguous receipt locks registration; errors and response secrets never escape', async () => {
  for (const post of [() => { throw new Error('fictional-password-upstream'); }, () => ({ id: 99 }),
    body => ({ ...body, id: 99, role: 'admin' }), body => ({ ...body, id: 99, concurrency: 51 })]) {
    const f = setup({ post }), data = input();
    await assert.rejects(f.service.create(data, context()), e => !e.message.includes('fictional-password-upstream'));
    assert.equal(f.service.records[0].state, 'unknown');
    assert.equal(JSON.stringify(f.rows()).includes('fictional-password-upstream'), false);
    await assert.rejects(f.service.create(input(), context()), { code: 'UNKNOWN' }); assert.equal(f.posts().length, 1);
    assert.throws(() => f.service.review(data.requestId, false, 1), { code: 'INPUT' });
    assert.throws(() => f.service.review(data.requestId, true, 2), { code: 'INPUT' });
    f.service.review(data.requestId, true, 1);
    assert.equal(f.service.records[0].state, 'reviewed');
    await assert.rejects(f.service.create(data, context()), { code: 'DUPLICATE' });
  }
});
test('definitive rejection does not retry; failed review persistence cannot release unknown lock', async () => {
  const f = setup({ post: () => { throw Object.assign(new Error('fictional-secret'), { code: 'HTTP', definitive: true }); } });
  await assert.rejects(f.service.create(input(), context()), { code: 'HTTP' });
  assert.equal(f.service.records[0].state, 'failed'); assert.equal(f.posts().length, 1);
  const g = setup({ failSave: 3, post: () => { throw new Error('timeout'); } }), data = input();
  await assert.rejects(g.service.create(data, context()));
  assert.throws(() => g.service.review(data.requestId, true, 1), { code: 'STORAGE' });
  assert.equal(g.service.records[0].state, 'unknown'); assert.equal(g.service.blocked().length, 1);
});
test('concurrent create and changing owner during preflight stop before duplicate mutation', async () => {
  let resolve; const f = setup({ me: () => new Promise(r => { resolve = r; }) });
  const first = f.service.create(input(), context());
  await assert.rejects(f.service.create(input(), context()), { code: 'BUSY' });
  f.owner(2); resolve({ id: 1, role: 'admin' });
  await assert.rejects(first, { code: 'POLICY' }); assert.equal(f.posts().length, 0);
});
test('strict ledger validation rejects malformed and secret-bearing historical records', async () => {
  const f = setup(); await f.service.create(input(), context()); const good = f.rows()[0];
  for (const rows of [{}, [{ ...good, state: 'other' }], [good, good], [{ ...good, password: 'forbidden' }],
    [{ ...good, body: { ...good.body, password: 'forbidden' } }], [{ ...good, body: { ...good.body, role: 'admin' } }],
    [{ ...good, receipt: { ...good.receipt, secret: 'forbidden' } }]])
    assert.throws(() => setup({ rows }), { code: 'STORAGE' });
});
test('real isolated journal reloads success and pending-as-unknown; disk contains no password', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registration-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeDiskStore(dir, {}), f = setup({ store }), data = input();
  await f.service.create(data, context());
  const file = path.join(dir, 'operations.journal');
  assert.equal(fs.readFileSync(file, 'utf8').includes(data.password), false);
  const pending = { ...f.service.records[0], requestId: randomUUID(), state: 'pending' };
  pending.body = { ...pending.body, notes: `飞书注册 [${pending.requestId}]` }; delete pending.receipt;
  store.save([...f.service.records, pending]);
  const restored = setup({ store: makeDiskStore(dir, {}) });
  assert.equal(restored.service.records[0].state, 'success'); assert.equal(restored.service.records[1].state, 'unknown');
  await assert.rejects(restored.service.create(input(), context()), { code: 'UNKNOWN' });
  assert.equal(restored.posts().length, 0);
});
test('admin paging is bounded and never returns a password', async () => {
  const f = setup(); for (let i = 0; i < 21; i++) await f.service.create(input(), context());
  assert.equal(f.service.adminRecords().items.length, 20);
  assert.equal(f.service.adminRecords(2).items.length, 1);
  assert.equal(f.service.adminRecords(99).page, 2);
  assert.throws(() => f.service.adminRecords(0), { code: 'INPUT' });
  assert.equal(JSON.stringify(f.service.adminRecords()).includes('password'), false);
});
