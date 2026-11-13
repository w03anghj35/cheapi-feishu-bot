'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RechargeQuery, record, summary, amount, auditEntry, auditRequest, TYPES } = require('./recharge-query');

const USERS = [
  { id: 11, username: '虚构收款甲', email: 'first@example.invalid', role: 'user' },
  { id: 12, username: '虚构收款乙', email: 'second@example.invalid', role: 'user' }
];
const history = (id, type, value, extra = {}) => ({
  id, type, value, created_at: '2026-11-10T08:00:00+08:00', ...extra
});
function fixture({ users = USERS, histories = {}, owner = 7, audits = [], auditDetails = {} } = {}) {
  const calls = [];
  let activeOwner = owner;
  const request = async (method, route) => {
    calls.push({ method, route });
    if (method !== 'GET') throw new Error('unexpected write');
    if (route === '/auth/me') return { id: activeOwner, role: 'admin' };
    const usersPage = /^\/admin\/users\?page=(\d+)&page_size=100$/.exec(route);
    if (usersPage) {
      const page = Number(usersPage[1]);
      return { items: structuredClone(users.slice((page - 1) * 100, page * 100)), total: users.length };
    }
    const balancePage = /^\/admin\/users\/(\d+)\/balance-history\?page=(\d+)&page_size=15$/.exec(route);
    if (balancePage) {
      const id = Number(balancePage[1]);
      const page = Number(balancePage[2]);
      const entries = histories[id] ?? [];
      return { items: structuredClone(entries.slice((page - 1) * 15, page * 15)), total: entries.length };
    }
    const auditPage = /^\/admin\/audit-logs\?page=(\d+)&page_size=20&q=%2Fadmin%2Fusers%2F(?:\d+%2Fbalance)?$/.exec(route);
    if (auditPage) {
      const page = Number(auditPage[1]);
      return { items: structuredClone(audits.slice((page - 1) * 20, page * 20)), total: audits.length };
    }
    const auditDetail = /^\/admin\/audit-logs\/(\d+)$/.exec(route);
    if (auditDetail) {
      const id = Number(auditDetail[1]);
      return structuredClone({ ...(audits.find(row => row.id === id) ?? { id }), ...(auditDetails[id] ?? {}) });
    }
    throw new Error(`unexpected route: ${route}`);
  };
  const query = new RechargeQuery({ request, getOwner: () => activeOwner,
    now: () => Date.parse('2026-11-10T01:00:00Z') });
  return { query, calls, setOwner: value => { activeOwner = value; } };
}

test('balance history types stay distinct and unverified actor fields are not trusted', () => {
  assert.equal(TYPES.admin_balance, 'admin-recharge');
  const recipient = USERS[0];
  const admin = record(history(1, 'admin_balance', '9.9999', {
    actor_id: 7, actor_email: 'admin@example.invalid', notes: 'untrusted note' }), recipient);
  assert.deepEqual([admin.kind, admin.amount, admin.recipientId, admin.classification, admin.selfStatus],
    ['admin-recharge', '9.9999', 11, 'operator-unknown', 'unknown']);
  assert.equal(admin.actorId, null);
  assert.equal(admin.actorName, null);
  assert.equal(JSON.stringify(admin).includes('untrusted note'), false);
  assert.deepEqual([
    record(history(2, 'admin_balance', '-2'), recipient).kind,
    record(history(3, 'balance', '10'), recipient).kind,
    record(history(4, 'affiliate_balance', '3'), recipient).kind,
    record(history(5, 'subscription', '4'), recipient).kind,
    record(history(6, 'concurrency', 5), recipient).kind,
    record(history(7, 'admin_concurrency', 5), recipient).amount
  ], ['admin-deduction', 'code-balance', 'affiliate-balance', 'subscription', 'non-monetary', null]);
  const affiliate = record(history(-3, 'affiliate_balance', '0.25'), recipient);
  assert.deepEqual([affiliate.id, affiliate.kind, affiliate.amount], [-3, 'affiliate-balance', '0.25']);
  assert.throws(() => record(history(8, 'unexpected', '1'), recipient), { code: 'SCHEMA' });
});

test('amount validation normalizes platform float tails and scientific notation without hiding true precision', () => {
  for (const [raw, normalized] of [
    ['9.9999', '9.9999'], ['9.99999', '9.99999'],
    [0.30000000000000004, '0.3'], [100000.01 - 100000, '0.01'],
    [1e-7, '0.0000001'], ['1e-7', '0.0000001'],
    [1e-8, '0.00000001'], ['0.00000001', '0.00000001'], ['1e2', '100']
  ]) assert.equal(amount(raw), normalized);
  for (const value of ['0.123456789', '0.000000001', 1e-9, -1e-29, '1e-29',
    ' 9', '01', 'Infinity', '-0.1.2', null, {}, 1e20])
    assert.throws(() => amount(value), { code: 'SCHEMA' });
});

test('administrator credit totals add exactly and use a strict under-10 boundary', () => {
  const rows = [
    { kind: 'admin-recharge', amount: '9.9999', actorId: 7, recipientId: 11 },
    { kind: 'admin-recharge', amount: '10', actorId: 7, recipientId: 12 },
    { kind: 'admin-recharge', amount: '4', actorId: 7, recipientId: 7 },
    { kind: 'admin-deduction', amount: '-3', actorId: 7, recipientId: 11 },
    { kind: 'code-balance', amount: '5', actorId: null, recipientId: 11 }
  ];
  assert.deepEqual(summary(rows, 7), {
    adminGross: '23.9999', adminCount: 3, selfExcluded: '4', adminNet: '19.9999',
    smallOther: { count: 1, amount: '9.9999' }, smallThreshold: 10,
    selfExclusionReady: true, deductionCount: 1, otherTypeCount: 1
  });
  rows[0].actorId = null;
  const unknown = summary(rows, 7);
  assert.equal(unknown.adminGross, '23.9999');
  assert.equal(unknown.selfExclusionReady, false);
  assert.equal(unknown.selfExcluded, null);
  assert.equal(unknown.adminNet, null);
  assert.equal(unknown.smallOther, null);

  const cents = [
    { kind: 'admin-recharge', amount: '0.1', actorId: 7, recipientId: 11 },
    { kind: 'admin-recharge', amount: '0.2', actorId: 7, recipientId: 12 },
    { kind: 'admin-recharge', amount: '9.99999999', actorId: 7, recipientId: 11 },
    { kind: 'admin-recharge', amount: '10', actorId: 7, recipientId: 12 }
  ];
  assert.equal(summary(cents.slice(0, 2), 7).adminGross, '0.3');
  const exact = summary(cents, 7);
  assert.equal(exact.adminGross, '20.29999999');
  assert.equal(exact.adminNet, '20.29999999');
  assert.deepEqual(exact.smallOther, { count: 3, amount: '10.29999999' });

  const large = summary([
    { kind: 'admin-recharge', amount: '999999999999.99999999', actorId: 7, recipientId: 11 },
    { kind: 'admin-recharge', amount: '0.00000001', actorId: 7, recipientId: 12 }
  ], 7);
  assert.equal(large.adminGross, '1000000000000');
  assert.equal(large.adminNet, '1000000000000');
});

test('query reads selected user only and reports operator and self-credit as unresolved', async () => {
  const f = fixture({ histories: {
    11: [history('credit-1', 'admin_balance', '8.5', {
      used_at: '2026-11-10T09:00:00+08:00', actor_email: 'admin@example.invalid' }),
      history('code-1', 'balance', '20')],
    12: [history('other-1', 'admin_balance', '12')]
  } });
  const result = await f.query.query({ userId: 11, adminUserId: 11 });
  assert.equal(result.complete, true);
  assert.equal(result.operatorAvailable, false);
  assert.equal(result.scannedUsers, 1);
  assert.deepEqual(result.rows.map(row => row.id), ['credit-1', 'code-1']);
  assert.equal(result.rows[0].actorId, null);
  assert.equal(result.rows[0].classification, 'operator-unknown');
  assert.equal(result.summary.adminNet, null);
  assert.equal(result.summary.selfExcluded, null);
  assert.equal(result.summary.smallOther, null);
  assert.equal(result.auditComplete, true);
  assert.deepEqual(result.auditRows, []);
  assert.equal(f.calls.filter(call => call.route.includes('/audit-logs')).length, 1);
  assert.equal(f.calls.some(call => call.route.includes('/users/12/balance-history')), false);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('query retrieves every page once and never returns a partial total on duplicate or incomplete history', async () => {
  const records = Array.from({ length: 16 }, (_, index) => history(index + 1, 'admin_balance', '1'));
  const complete = fixture({ users: [USERS[0]], histories: { 11: records } });
  const result = await complete.query.query({ adminUserId: 7 });
  assert.equal(result.rows.length, 16);
  assert.equal(result.summary.adminGross, '16');
  assert.equal(complete.calls.filter(call => call.route.includes('/balance-history')).length, 2);

  for (const variant of ['duplicate', 'short', 'failed']) {
    const f = fixture({ users: [USERS[0]], histories: { 11: records } });
    const original = f.query.request;
    f.query.request = async (method, route) => {
      if (route.includes('balance-history?page=2')) {
        if (variant === 'failed') throw new Error('network failure');
        if (variant === 'duplicate') return { items: [history(1, 'admin_balance', '1')], total: 16 };
        return { items: [], total: 16 };
      }
      return original(method, route);
    };
    await assert.rejects(f.query.query({ userId: 11 }), variant === 'failed' ? /network failure/ : { code: 'SCHEMA' });
    assert.equal(f.query.busy, false);
  }
});

test('a genuinely overprecise later record prevents a misleading all-user total', async () => {
  const f = fixture({ histories: {
    11: [history(1, 'admin_balance', '1')],
    12: [history(2, 'admin_balance', '0.123456789', { notes: 'private note' })]
  } });
  await assert.rejects(f.query.query(), error => {
    assert.equal(error.code, 'SCHEMA');
    assert.match(error.message, /用户 ID 12 的第 1 页第 1 条/);
    assert.doesNotMatch(error.message, /0\.123456789|private note/);
    return true;
  });
  assert.equal(f.query.busy, false);
  assert.equal(f.calls.some(call => call.route.includes('/users/12/balance-history')), true);
  assert.equal(f.calls.some(call => call.route.includes('/audit-logs')), false);
});

test('changed administrator or malformed directory rejects the whole query without leaking rows', async () => {
  const f = fixture({ users: [USERS[0]], histories: { 11: [history(1, 'admin_balance', '3')] } });
  const original = f.query.request;
  f.query.request = async (method, route) => {
    const result = await original(method, route);
    if (route.includes('/balance-history')) f.setOwner(8);
    return result;
  };
  await assert.rejects(f.query.query({ userId: 11 }), { code: 'AUTH' });
  assert.equal(f.query.busy, false);
  await assert.rejects(f.query.query({ userId: 11, actorEmail: 'admin@example.invalid' }), { code: 'INPUT' });

  const duplicate = fixture({ users: [USERS[0], { ...USERS[0] }] });
  await assert.rejects(duplicate.query.query(), { code: 'SCHEMA' });
});

test('audit candidate shows actor and request separately without confirming a ledger actor or self exclusion', async () => {
  const log = { id: 301, path: '/api/v1/admin/users/11/balance', method: 'POST',
    created_at: '2026-11-10T08:00:01+08:00', actor_user_id: 11,
    actor_email: 'operator@example.invalid', status_code: 200, request_id: 'request_301' };
  const f = fixture({ users: [USERS[0]], histories: { 11: [history('ledger-301', 'admin_balance', '8.5')] },
    audits: [log], auditDetails: { 301: { id: 301, request_body: JSON.stringify({
      balance: 8.5, operation: 'add', notes: 'private note', password: 'fictional-private-password'
    }) } } });
  const result = await f.query.query({ userId: 11, adminUserId: 11 });
  assert.equal(result.auditComplete, true);
  assert.equal(result.auditWarning, null);
  assert.equal(result.auditRows.length, 1);
  assert.deepEqual([result.auditRows[0].recipientId, result.auditRows[0].actorId,
    result.auditRows[0].selfCandidate, result.auditRows[0].operation,
    result.auditRows[0].requestedValue], [11, 11, true, 'add', '8.5']);
  assert.equal(result.rows[0].actorId, null);
  assert.equal(result.rows[0].classification, 'operator-unknown');
  assert.equal(result.summary.selfExcluded, null);
  assert.equal(result.summary.adminNet, null);
  assert.equal(result.operatorAvailable, false);
  assert.equal(JSON.stringify(result).includes('fictional-private-password'), false);
  assert.equal(JSON.stringify(result).includes('private note'), false);
  assert.ok(f.calls.some(call => call.route ===
    '/admin/audit-logs?page=1&page_size=20&q=%2Fadmin%2Fusers%2F11%2Fbalance'));
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('audit projection rejects unrelated routes and does not expose malformed or redacted request bodies', () => {
  const userById = new Map(USERS.map(row => [row.id, row]));
  const base = { id: 1, path: '/api/v1/admin/users/11/balance', method: 'POST',
    actor_email: 'bad\noperator@example.invalid', actor_user_id: 7, status_code: 500 };
  assert.equal(auditEntry({ ...base, method: 'GET' }, userById, 11), null);
  assert.equal(auditEntry({ ...base, path: '/api/v1/admin/users/11/balance-extra' }, userById, 11), null);
  assert.equal(auditEntry({ ...base, path: '/api/v1/admin/users/12/balance' }, userById, 11), null);
  const projected = auditEntry(base, userById, 11);
  assert.equal(projected.actorEmail, null);
  assert.equal(projected.statusCode, 500);
  assert.equal(projected.selfCandidate, false);
  assert.equal(projected.requestedValue, null);
  assert.deepEqual(auditRequest('{"operation":"add","balance":"[REDACTED]","secret":"hidden"}'),
    { operation: 'add', requestedValue: null });
  assert.deepEqual(auditRequest('{"operation":"add"'), { operation: null, requestedValue: null });
  assert.deepEqual(auditRequest('x'.repeat(2049)), { operation: null, requestedValue: null });
  assert.deepEqual(auditRequest({ operation: 'add', balance: 10 }), { operation: null, requestedValue: null });
});

test('duplicate audit pages and the 200-log cap flag candidates as incomplete without changing ledger totals', async () => {
  const logs = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, method: 'GET', path: '/other' }));
  logs[0] = { id: 1, method: 'POST', path: '/api/v1/admin/users/11/balance', actor_user_id: 7 };
  const duplicate = fixture({ users: [USERS[0]], histories: { 11: [history(1, 'admin_balance', '6')] },
    audits: [...logs, { ...logs[0] }] });
  const result = await duplicate.query.query({ userId: 11, adminUserId: 7 });
  assert.equal(result.auditComplete, false);
  assert.match(result.auditWarning, /重复/);
  assert.equal(result.auditRows.length, 1);
  assert.equal(result.rows[0].actorId, null);
  assert.equal(result.summary.adminGross, '6');
  assert.equal(result.summary.adminNet, null);

  const many = fixture({ users: [USERS[0]], histories: { 11: [history(2, 'admin_balance', '2')] },
    audits: Array.from({ length: 201 }, (_, index) => ({ id: index + 1, method: 'GET', path: '/other' })) });
  const capped = await many.query.query({ userId: 11 });
  assert.equal(capped.auditComplete, false);
  assert.match(capped.auditWarning, /200/);
  assert.equal(capped.rows.length, 1);
  assert.equal(capped.auditRows.length, 0);
  assert.equal(many.calls.filter(call => call.route.startsWith('/admin/audit-logs?')).length, 10);
});

test('audit permission or detail failure leaves ledger visible but never marks the actor as confirmed', async () => {
  const candidate = { id: 51, method: 'POST', path: '/admin/users/11/balance', actor_user_id: 7 };
  const make = () => fixture({ users: [USERS[0]], histories: { 11: [history(1, 'admin_balance', '5')] },
    audits: [candidate] });
  const unavailable = make();
  const original = unavailable.query.request;
  unavailable.query.request = async (method, route) => {
    if (route.startsWith('/admin/audit-logs'))
      throw Object.assign(new Error('forbidden audit'), { code: 'DENIED' });
    return original(method, route);
  };
  const fallback = await unavailable.query.query({ userId: 11, adminUserId: 7 });
  assert.equal(fallback.complete, true);
  assert.equal(fallback.auditComplete, false);
  assert.match(fallback.auditWarning, /暂不可读取/);
  assert.equal(fallback.rows.length, 1);
  assert.equal(fallback.rows[0].actorId, null);
  assert.equal(fallback.summary.adminNet, null);

  const detailFailure = make();
  const detailRequest = detailFailure.query.request;
  detailFailure.query.request = async (method, route) => {
    if (route === '/admin/audit-logs/51') throw new Error('detail forbidden');
    return detailRequest(method, route);
  };
  const partial = await detailFailure.query.query({ userId: 11, adminUserId: 7 });
  assert.equal(partial.auditComplete, false);
  assert.match(partial.auditWarning, /详情无法读取/);
  assert.equal(partial.auditRows[0].actorId, 7);
  assert.equal(partial.auditRows[0].requestedValue, null);
  assert.equal(partial.rows[0].actorId, null);
  assert.equal(partial.summary.adminNet, null);
});

test('mismatched audit detail never contributes its request value to another candidate', async () => {
  const candidate = { id: 51, method: 'POST', path: '/api/v1/admin/users/11/balance',
    actor_user_id: 7, request_id: 'request_51' };
  const mismatches = [
    { id: 52 },
    { method: 'GET' },
    { path: '/api/v1/admin/users/12/balance' },
    { actor_user_id: 12 },
    { request_id: 'request_elsewhere' }
  ];
  for (const changed of mismatches) {
    const f = fixture({ users: USERS, histories: { 11: [history(1, 'admin_balance', '8.5')] },
      audits: [candidate], auditDetails: { 51: { ...changed,
        request_body: JSON.stringify({ operation: 'add', balance: 999, password: 'fictional-private-password' }) } } });
    const result = await f.query.query({ userId: 11, adminUserId: 7 });
    assert.equal(result.complete, true);
    assert.equal(result.auditComplete, false);
    assert.match(result.auditWarning, /详情无法读取/);
    assert.equal(result.auditRows.length, 1);
    assert.equal(result.auditRows[0].operation, null);
    assert.equal(result.auditRows[0].requestedValue, null);
    assert.equal(result.rows[0].actorId, null);
    assert.equal(result.summary.adminNet, null);
    assert.equal(JSON.stringify(result).includes('fictional-private-password'), false);
  }
});
