'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountSchedule, makeAccountScheduleStore, beijingTime, projectAccount } = require('./account-schedule');

const BASE = Date.parse('2026-11-03T16:00:00Z');
function fixture() {
  let now = BASE, owner = 1, saved = [], failPost = false;
  const calls = [], writes = [];
  const accounts = [
    { id: 11, name: '虚构渠道甲', platform: 'openai', status: 'active', schedulable: false, credentials: 'must-not-escape' },
    { id: 12, name: '虚构渠道乙', platform: 'openai', status: 'active', schedulable: true, credentials: 'must-not-escape' }
  ];
  const request = async (method, route, body, context) => {
    calls.push({ method, route });
    if (route === '/auth/me') return { id: owner, role: 'admin' };
    if (method === 'GET' && route.startsWith('/admin/accounts?page=')) return { items: structuredClone(accounts), total: accounts.length };
    if (method === 'GET' && /^\/admin\/accounts\/\d+$/.test(route)) return structuredClone(accounts.find(a => a.id === Number(route.split('/').at(-1))));
    if (method === 'POST' && route.endsWith('/schedulable')) {
      assert.equal(context.owner, owner); assert.equal(context.accountSchedule, true); assert.equal(context.guard(), true);
      assert.deepEqual(Object.keys(body), ['schedulable']);
      const account = accounts.find(a => a.id === Number(route.split('/')[3]));
      writes.push({ id: account.id, desired: body.schedulable, persistedBeforePost: saved[0].steps.some(s => s.state === 'attempting') });
      if (failPost) throw new Error('uncertain network');
      account.schedulable = body.schedulable; return structuredClone(account);
    }
    throw new Error(`unexpected request ${method} ${route}`);
  };
  const store = { load: () => structuredClone(saved), save: rows => { saved = structuredClone(rows); } };
  const schedule = new AccountSchedule({ request, store, getOwner: () => owner, now: () => now });
  return { schedule, request, store, calls, writes, accounts,
    advance: ms => { now += ms; }, setOwner: v => { owner = v; }, failPost: () => { failPost = true; },
    saved: () => structuredClone(saved) };
}
test('Beijing calendar validates month boundaries and nonexistent dates', () => {
  assert.equal(beijingTime('2026-12-01T00:00'), Date.parse('2026-11-30T16:00:00Z'));
  assert.throws(() => beijingTime('2026-11-31T00:00'), { code: 'INPUT' });
  assert.throws(() => beijingTime('2026-13-01T00:00'), { code: 'INPUT' });
  assert.deepEqual(projectAccount({ id: 1, name: 'A', schedulable: false, secret: 'hidden' }),
    { id: 1, name: 'A', platform: '', status: '', schedulable: false });
});
test('open first then close in order across midnight, with durable attempt and readback', async () => {
  const f = fixture();
  const snapshot = await f.schedule.snapshot();
  assert.equal(JSON.stringify(snapshot).includes('must-not-escape'), false);
  await f.schedule.create({ openId: 11, closeId: 12, order: 'open-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:03' });
  f.advance(2 * 60_000); await f.schedule.tick();
  assert.deepEqual(f.writes.map(w => [w.id, w.desired]), [[11, true]]);
  assert.equal(f.writes[0].persistedBeforePost, true);
  assert.deepEqual(f.schedule.state().plans[0].steps.map(s => s.state), ['done', 'scheduled']);
  f.advance(60_000); await f.schedule.tick();
  assert.deepEqual(f.writes.map(w => [w.id, w.desired]), [[11, true], [12, false]]);
  assert.deepEqual(f.schedule.state().plans[0].steps.map(s => s.state), ['done', 'done']);
  await f.schedule.tick(); assert.equal(f.writes.length, 2);
});
test('close first and different-month second step are accepted; conflicting plans rejected', async () => {
  const f = fixture();
  await f.schedule.create({ openId: 11, closeId: 12, order: 'close-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-12-01T00:00' });
  assert.deepEqual(f.schedule.state().plans[0].steps.map(s => [s.accountId, s.desired]), [[12, false], [11, true]]);
  await assert.rejects(f.schedule.create({ openId: 11, closeId: 12, order: 'open-first',
    firstAt: '2026-11-04T00:03', secondAt: '2026-11-04T00:04' }), { code: 'CONFLICT' });
  await assert.rejects(f.schedule.create({ openId: 11, closeId: 11, order: 'open-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:03' }), { code: 'INPUT' });
});
test('close first executes the close request before opening the other account', async () => {
  const f = fixture();
  await f.schedule.create({ openId: 11, closeId: 12, order: 'close-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:02' });
  f.advance(2 * 60_000); await f.schedule.tick();
  assert.deepEqual(f.writes.map(w => [w.id, w.desired]), [[12, false], [11, true]]);
});
test('multiple same-time plans run serially and keep each pair ordered', async () => {
  const f = fixture();
  f.accounts.push(
    { id: 13, name: '虚构渠道丙', platform: 'openai', status: 'active', schedulable: false },
    { id: 14, name: '虚构渠道丁', platform: 'openai', status: 'active', schedulable: true }
  );
  for (const [openId, closeId] of [[11, 12], [13, 14]])
    await f.schedule.create({ openId, closeId, order: 'open-first', firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:02' });
  f.advance(2 * 60_000); await f.schedule.tick();
  assert.equal(f.writes.length, 4);
  for (const [openId, closeId] of [[11, 12], [13, 14]])
    assert.ok(f.writes.findIndex(w => w.id === openId) < f.writes.findIndex(w => w.id === closeId));
  assert.ok(f.schedule.state().plans.every(p => p.steps.every(s => s.state === 'done')));
});
test('uncertain first POST blocks second and never retries; read-only reconcile can unblock', async () => {
  const f = fixture();
  await f.schedule.create({ openId: 11, closeId: 12, order: 'open-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:04' });
  f.failPost(); f.advance(2 * 60_000); await f.schedule.tick();
  assert.deepEqual(f.schedule.state().plans[0].steps.map(s => s.state), ['unknown', 'scheduled']);
  f.advance(2 * 60_000); await f.schedule.tick(); await f.schedule.tick();
  assert.equal(f.writes.length, 1);
  const id = f.schedule.state().plans[0].id;
  await assert.rejects(f.schedule.reconcile(id, 0), { code: 'UNKNOWN' });
  f.accounts[0].schedulable = true;
  await f.schedule.reconcile(id, 0);
  assert.equal(f.schedule.state().plans[0].steps[0].state, 'done');
});
test('missed window cancels later step; cancellation preserves completed history', async () => {
  const f = fixture();
  await f.schedule.create({ openId: 11, closeId: 12, order: 'open-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:03' });
  f.advance(10 * 60_000); await f.schedule.tick();
  assert.deepEqual(f.schedule.state().plans[0].steps.map(s => s.state), ['missed', 'cancelled']);
  assert.equal(f.writes.length, 0);
  const g = fixture();
  await g.schedule.create({ openId: 11, closeId: 12, order: 'open-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:30' });
  g.advance(2 * 60_000); await g.schedule.tick();
  await g.schedule.cancel(g.schedule.state().plans[0].id);
  assert.deepEqual(g.schedule.state().plans[0].steps.map(s => s.state), ['done', 'cancelled']);
});
test('different administrator cannot see or execute another administrator plan', async () => {
  const f = fixture();
  await f.schedule.create({ openId: 11, closeId: 12, order: 'open-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:03' });
  f.setOwner(2); f.advance(2 * 60_000);
  assert.deepEqual(f.schedule.state().plans, []);
  await f.schedule.tick(); assert.equal(f.writes.length, 0);
});
test('duplicate or incomplete account pages never become selectable', async () => {
  const f = fixture(), original = f.schedule.request;
  f.schedule.request = async (method, route, body, context) => {
    if (route === '/admin/accounts?page=1&page_size=100') return { items: Array.from({ length: 100 }, (_, i) =>
      ({ id: i + 1, name: `虚构账号${i + 1}`, schedulable: false })), total: 101 };
    if (route === '/admin/accounts?page=2&page_size=100') return { items: [{ id: 1, name: '重复账号', schedulable: false }], total: 101 };
    return original(method, route, body, context);
  };
  await assert.rejects(f.schedule.snapshot(), { code: 'SCHEMA' });
  assert.equal(f.writes.length, 0);
});
test('missing account detail prevents a scheduled POST', async () => {
  const f = fixture();
  await f.schedule.create({ openId: 11, closeId: 12, order: 'open-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:03' });
  f.accounts.splice(0, 1); f.advance(2 * 60_000);
  await f.schedule.tick(); assert.equal(f.writes.length, 0);
  f.advance(5 * 60_000 + 1); await f.schedule.tick();
  assert.deepEqual(f.schedule.state().plans[0].steps.map(s => s.state), ['missed', 'cancelled']);
});
test('restarting an attempting journal marks unknown without sending another POST', async () => {
  const f = fixture();
  await f.schedule.create({ openId: 11, closeId: 12, order: 'open-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:03' });
  const rows = f.saved(); rows[0].steps[0].state = 'attempting'; f.store.save(rows);
  const reopened = new AccountSchedule({ request: f.request, store: f.store, getOwner: () => 1, now: () => BASE + 2 * 60_000 });
  assert.equal(reopened.state().plans[0].steps[0].state, 'unknown');
  await reopened.tick(); assert.equal(f.writes.length, 0);
});
test('failed durable attempt never sends the platform switch request', async () => {
  const f = fixture();
  await f.schedule.create({ openId: 11, closeId: 12, order: 'open-first',
    firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:03' });
  f.advance(2 * 60_000);
  const save = f.store.save;
  f.store.save = rows => {
    if (rows[0].steps[0].state === 'attempting') throw new Error('disk full');
    save(rows);
  };
  await assert.rejects(f.schedule.tick(), { code: 'STORAGE' });
  assert.equal(f.writes.length, 0);
  assert.equal(f.schedule.state().storageError, true);
});
test('encrypted journal roundtrip and truncated tail fail closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-schedule-fixture-'));
  const crypto = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
    encryptString: value => Buffer.from(`sealed:${value}`),
    decryptString: value => { const str = value.toString(); if (!str.startsWith('sealed:')) throw new Error('cipher'); return str.slice(7); } };
  try {
    const store = makeAccountScheduleStore(dir, crypto); assert.deepEqual(store.load(), []);
    const f = fixture(); await f.schedule.create({ openId: 11, closeId: 12, order: 'open-first',
      firstAt: '2026-11-04T00:02', secondAt: '2026-11-04T00:03' });
    store.save(f.saved());
    const file = path.join(dir, 'account-schedules.journal'), raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('2026-11-04'), false);
    assert.equal(makeAccountScheduleStore(dir, crypto).load()[0].steps[0].accountId, 11);
    fs.appendFileSync(file, '{"payload":');
    assert.throws(() => makeAccountScheduleStore(dir, crypto).load(), { code: 'STORAGE' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
