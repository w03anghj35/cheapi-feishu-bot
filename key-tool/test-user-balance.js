'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UserBalanceQuery, projectUser, summarizeBalances } = require('./user-balance');

const NOW = Date.parse('2026-11-12T03:00:00Z');
const user = (id, balance, extra = {}) => ({ id, balance, username: `虚构用户${id}`,
  email: `user${id}@example.invalid`, role: 'user', status: 'active', ...extra });
function fixture(users = []) {
  let owner = 7, time = NOW, role = 'admin';
  const calls = [];
  const request = async (method, route) => {
    calls.push({ method, route });
    assert.equal(method, 'GET', 'balance query must never write to the platform');
    if (route === '/auth/me') return { id: owner, role };
    const match = /^\/admin\/users\?page=([1-9]\d*)&page_size=100$/.exec(route);
    if (!match) throw Error('unexpected route');
    const page = Number(match[1]);
    return { items: structuredClone(users.slice((page - 1) * 100, page * 100)), total: users.length };
  };
  const query = new UserBalanceQuery({ request, getOwner: () => owner, now: () => time });
  return { query, calls, setOwner: value => { owner = value; }, setRole: value => { role = value; },
    advance: value => { time += value; } };
}

test('positive user balances include disabled users and exclude every administrator without netting negatives', async () => {
  const f = fixture([
    user(1, '0.1'), user(2, '0.2'), user(3, '-50'), user(4, '0'),
    user(5, '8', { status: 'disabled' }), user(6, '2', { status: 'inactive' }),
    user(7, '999', { role: 'admin' }), user(8, '1.00000001', { role: 'admin' }),
    user(9, '-10', { role: 'admin' })
  ]);
  const data = await f.query.query();
  assert.equal(data.complete, true);
  assert.equal(data.unit, 'CNY');
  assert.equal(data.startedAt, new Date(NOW).toISOString());
  assert.equal(data.checkedAt, new Date(NOW).toISOString());
  assert.deepEqual(data.summary, { totalUsers: 9, adminCount: 3, positiveCount: 4,
    zeroCount: 1, negativeCount: 1, positiveTotal: '10.3', negativeTotal: '-50', excludedAdminPositive: '1000.00000001' });
  assert.deepEqual(data.rows.map(row => row.id), [3, 9, 4, 1, 2, 8, 6, 5, 7]);
  assert.deepEqual(data.rows.filter(row => row.included).map(row => row.id), [1, 2, 6, 5]);
  assert.ok(data.rows.every(row => typeof row.balance === 'string'));
  assert.equal(f.calls.filter(call => call.route.startsWith('/admin/users?')).length, 1);
});

test('projection contains only display fields and normalizes eight decimals and float tails', () => {
  const projected = projectUser(user(11, 0.30000000000000004, { password: 'fictional-private',
    notes: 'hidden-note', api_key: 'private-value', token: 'private-token' }));
  assert.deepEqual(Object.keys(projected).sort(), ['balance', 'email', 'id', 'included', 'role', 'status', 'username']);
  assert.equal(projected.balance, '0.3');
  assert.equal(projectUser(user(12, 1e-8)).balance, '0.00000001');
  assert.equal(projectUser(user(13, '10.00000')).balance, '10');
  assert.equal(JSON.stringify(projected).includes('private'), false);
  assert.equal(JSON.stringify(projected).includes('hidden-note'), false);
  const exact = summarizeBalances([
    projectUser(user(1, '999999999999.99999999')),
    projectUser(user(2, '0.00000001'))
  ]);
  assert.equal(exact.positiveTotal, '1000000000000');
});

test('empty directory is a complete zero result, not a missing-data error', async () => {
  const data = await fixture().query.query();
  assert.deepEqual(data.rows, []);
  assert.deepEqual(data.summary, { totalUsers: 0, adminCount: 0, positiveCount: 0,
    zeroCount: 0, negativeCount: 0, positiveTotal: '0', negativeTotal: '0', excludedAdminPositive: '0' });
  assert.equal(data.complete, true);
});

test('query reads all pages and uses exact decimal comparison when sorting equal and close balances', async () => {
  const entries = Array.from({ length: 101 }, (_, index) => user(index + 1, '0.00000001'));
  entries[0].balance = '9.99999999'; entries[1].balance = '10';
  const f = fixture(entries);
  const data = await f.query.query();
  assert.equal(data.rows.length, 101);
  assert.equal(data.summary.positiveTotal, '20.00000098');
  assert.deepEqual(data.rows.slice(-2).map(row => row.id), [1, 2]);
  assert.equal(f.calls.filter(call => call.route.startsWith('/admin/users?')).length, 2);
});

test('duplicate, drifting, short or failing pages never return a partial total', async () => {
  const entries = Array.from({ length: 101 }, (_, index) => user(index + 1, '1'));
  for (const kind of ['duplicate', 'total-change', 'empty', 'failure']) {
    const f = fixture(entries), original = f.query.request;
    f.query.request = async (method, route) => {
      if (route.includes('users?page=2')) {
        if (kind === 'duplicate') return { total: 101, items: [entries[0]] };
        if (kind === 'total-change') return { total: 102, items: [entries[100]] };
        if (kind === 'empty') return { total: 101, items: [] };
        throw Error('fictional network failure');
      }
      return original(method, route);
    };
    await assert.rejects(f.query.query());
    assert.equal(f.query.busy, false);
  }
  const short = fixture(entries), shortRequest = short.query.request;
  short.query.request = async (method, route) => route.includes('users?page=1') ?
    { total: 101, items: entries.slice(0, 50) } : shortRequest(method, route);
  await assert.rejects(short.query.query(), { code: 'SCHEMA' });
  assert.equal(short.query.busy, false);
});

test('unknown role and malformed balance fail closed even for an administrator', async () => {
  for (const invalid of [user(1, '1', { role: 'superadmin' }), user(1, null),
    user(1, Infinity), user(1, '0.123456789'), user(1, 1e-29),
    user(1, 'bad', { role: 'admin' }), user(1, '1', { status: 'unexpected' })]) {
    assert.throws(() => projectUser(invalid), { code: 'SCHEMA' });
    await assert.rejects(fixture([invalid]).query.query(), { code: 'SCHEMA' });
  }
});

test('administrator change or role loss during pagination suppresses old account data', async () => {
  for (const kind of ['owner', 'role']) {
    const f = fixture([user(1, '8')]), original = f.query.request;
    f.query.request = async (method, route) => {
      const result = await original(method, route);
      if (route.startsWith('/admin/users?')) {
        if (kind === 'owner') f.setOwner(9); else f.setRole('user');
      }
      return result;
    };
    await assert.rejects(f.query.query());
    assert.equal(f.query.busy, false);
  }
});

test('invalid input and ordinary-user authorization never start reading platform users', async () => {
  for (const input of [null, [], 'all', { role: 'user' }, { excludeAdmins: false }, { userId: 1 }]) {
    const f = fixture([user(1, '1')]);
    await assert.rejects(f.query.query(input), { code: 'INPUT' });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture([user(1, '1')]); f.setRole('user');
  await assert.rejects(f.query.query());
  assert.equal(f.calls.some(call => call.route.startsWith('/admin/users?')), false);
});

test('busy guard avoids overlapping full scans and is released after completion', async () => {
  const f = fixture([user(1, '2')]), original = f.query.request;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.query.request = async (method, route) => { if (route.startsWith('/admin/users?')) await pending; return original(method, route); };
  const first = f.query.query();
  await assert.rejects(f.query.query(), { code: 'BUSY' });
  release();
  assert.equal((await first).summary.positiveTotal, '2');
  assert.equal(f.query.busy, false);
});

test('page limits and elapsed time reject incomplete queries without retries', async () => {
  const oversized = fixture(), original = oversized.query.request;
  oversized.query.request = async (method, route) => route.startsWith('/admin/users?') ?
    { total: 5001, items: [] } : original(method, route);
  await assert.rejects(oversized.query.query());
  const timed = fixture([user(1, '1')]), timedRequest = timed.query.request;
  timed.query.request = async (method, route) => {
    const data = await timedRequest(method, route);
    if (route.startsWith('/admin/users?')) timed.advance(120001);
    return data;
  };
  await assert.rejects(timed.query.query());
  assert.equal(timed.calls.filter(call => call.route.startsWith('/admin/users?')).length, 1);
  assert.equal(timed.query.busy, false);
});
