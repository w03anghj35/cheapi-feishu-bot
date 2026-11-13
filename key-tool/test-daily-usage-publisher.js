'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeDailyUsageStore, validateEvent } = require('./daily-usage-store');
const { DailyUsagePublisher, groupFailure, HOUR_MS } = require('./daily-usage-publisher');
const { beijingDay } = require('./daily-usage');
const { UserOwnership } = require('./user-ownership');
const scope = { owner: 1, groupId: 'oc_fixture_12345678' };
const encryption = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
  encryptString: text => Buffer.from(`sealed:${text}`),
  decryptString: bytes => { const text = bytes.toString(); if (!text.startsWith('sealed:')) throw Error('cipher'); return text.slice(7); } };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-usage-publisher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-11-06T02:00:00Z'), ready = true, collectReady = true, failSend = false, reads = 0;
  const sends = [], patches = [];
  const store = makeDailyUsageStore(dir, encryption);
  const publisher = new DailyUsagePublisher({ store, now: () => now, getScope: () => scope,
    isReady: () => ready, canCollect: () => collectReady, getClient: () => ({
      async sendGroupCard(row) { sends.push(row); if (failSend) throw Error('unknown delivery'); return 'om_fixture_12345678'; },
      async patchGroupCard(row) { patches.push(row); return row.messageId; }
    }), usage: { ownership: { profiles: () => [{ name: '虚构归属', userIds: [7] }] },
      async read(day) { reads++; return { day, checkedAt: new Date(now).toISOString(),
      final: day < beijingDay(now), scope, rows: [{ name: '虚构归属', users: [
        { id: 7, email: 'a@example.invalid', cost: reads } ] }] }; } } });
  return { dir, publisher, store, sends, patches, setNow: value => { now = value; },
    enable: (time = '10:00') => { const current = now; now = current - 60_000;
      try { return publisher.setEnabled(true, time); } finally { now = current; } },
    setReady: value => { ready = value; }, setCollectReady: value => { collectReady = value; },
    setFailSend: value => { failSend = value; }, reads: () => reads };
}
test('paused group publishing still saves hourly history and yesterday without sending to Feishu', async t => {
  const f = fixture(t); f.setReady(false);
  assert.equal(f.publisher.state().enabled, false);
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-05', '2026-11-06'] });
  assert.equal(f.store.state(scope).snapshots['2026-11-05'].source, 'backfill-current-ownership');
  assert.equal(f.store.state(scope).snapshots['2026-11-06'].final, false);
  assert.deepEqual(await f.publisher.historyTick(), { skipped: 'not-due' });
  f.setNow(Date.parse('2026-11-06T03:01:00Z'));
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-06'] });
  assert.equal(f.reads(), 3);
  assert.equal(f.sends.length, 0); assert.equal(f.patches.length, 0);
  assert.equal(f.publisher.state().enabled, false);
  f.setNow(Date.parse('2026-11-06T16:05:00Z'));
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-06', '2026-11-07'] });
  assert.equal(f.store.state(scope).snapshots['2026-11-06'].final, true);
  assert.equal(f.store.state(scope).snapshots['2026-11-07'].final, false);
  assert.equal(f.sends.length, 0);
});
test('scheduled group publish uses a fresh read even after a recent local-only sample', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-05', '2026-11-06'] });
  assert.equal(f.sends.length, 0);
  f.enable();
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.sends.length, 1);
  assert.equal(JSON.stringify(f.sends[0].card).includes('11-05'), true);
});

test('newly assigned account is sampled before the next hour without rewriting fixed history or sending cards', async t => {
  const f = fixture(t); await f.publisher.historyTick();
  const previous = structuredClone(f.store.state(scope).snapshots['2026-11-05']);
  f.publisher.usage.ownership.profiles = () => [{ name: '虚构归属', userIds: [7, 8] }];
  f.publisher.usage.read = async day => ({ day, scope, final: day < '2026-11-06',
    checkedAt: '2026-11-06T02:01:00Z', rows: [{ name: '虚构归属', users: [
      { id: 7, email: 'a@example.invalid', cost: 3 }, { id: 8, email: 'new@example.invalid', cost: 4 } ] }] });
  f.setNow(Date.parse('2026-11-06T02:01:00Z'));
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-06'] });
  assert.deepEqual(f.store.state(scope).snapshots['2026-11-06'].rows[0].users.map(u => u.id), [7, 8]);
  assert.deepEqual(f.store.state(scope).snapshots['2026-11-05'], previous);
  assert.equal(f.sends.length + f.patches.length, 0);
  assert.deepEqual(await f.publisher.historyTick(), { skipped: 'not-due' });
});

test('real ownership save immediately adds a third weekly row even when stats fails; restart retains email and no fake zero', async t => {
  const f = fixture(t); await f.publisher.historyTick();
  let records = [];
  const ownershipStore = { load: () => structuredClone(records), save: next => { records = structuredClone(next); } };
  const options = { store: ownershipStore, getOwner: () => scope.owner, getGroupId: () => scope.groupId,
    request: async (_method, route) => {
      if (route === '/auth/me') return { id: 1, role: 'admin' };
      if (route.startsWith('/admin/users?')) return { total: 3, items: [7, 8, 9].map(id =>
        ({ id, email: `user${id}@example.invalid`, username: `用户${id}`, role: 'user', status: 'active', balance: 0 })) };
      throw Error('unexpected route');
    } };
  let ownership = new UserOwnership(options);
  await ownership.assignName({ name: '虚构归属', userIds: [7, 8] });
  await ownership.assignName({ name: '虚构归属', userIds: [7, 8, 9] });
  f.publisher.usage.ownership = ownership;
  f.publisher.usage.read = async () => { throw Error('fixture unavailable stats'); };
  assert.deepEqual(await f.publisher.collectToday(), { saved: [], failed: 'today' });
  const input = { month: '2026-11', weekStart: '2026-11-02', name: '虚构归属' };
  let week = f.publisher.historyWeek(input);
  assert.deepEqual(week.rows.map(r => r.id), [7, 8, 9]);
  assert.equal(week.rows[2].email, 'user9@example.invalid');
  assert.equal(week.rows[2].awaitingSample, true);
  assert.equal(week.rows[2].hasRecordedUsage, false);
  assert.deepEqual(week.rows[2].values, Array(7).fill(null));
  ownership = new UserOwnership(options); f.publisher.usage.ownership = ownership;
  assert.equal(f.publisher.historyWeek(input).rows[2].email, 'user9@example.invalid');
  await ownership.assignName({ name: '虚构归属', userIds: [7, 8] });
  assert.deepEqual(f.publisher.historyWeek(input).rows.map(r => r.id), [7, 8]);
  assert.equal(f.sends.length + f.patches.length, 0);
});

test('explicit today sampling bypasses the hourly interval but never backfills old days or publishes', async t => {
  const f = fixture(t); await f.publisher.historyTick();
  const old = structuredClone(f.store.state(scope).snapshots['2026-11-05']);
  const reads = f.reads();
  assert.deepEqual(await f.publisher.collectToday(), { saved: ['2026-11-06'] });
  assert.equal(f.reads(), reads + 1);
  assert.deepEqual(f.store.state(scope).snapshots['2026-11-05'], old);
  assert.equal(f.sends.length + f.patches.length, 0);
  f.publisher.historyRetryAfter = Date.parse('2026-11-06T03:00:00Z');
  assert.deepEqual(await f.publisher.collectToday(), { skipped: 'backoff' });
  assert.equal(f.reads(), reads + 1);
});
test('single-account month backfill skips existing dates, preserves full snapshots and never sends cards', async t => {
  const f = fixture(t); await f.publisher.historyTick();
  const old = structuredClone(f.store.state(scope).snapshots['2026-11-05']);
  const calls = [];
  f.publisher.usage.readAccount = async (day, name, userId) => {
    calls.push({ day, name, userId });
    return { day, name, scope, checkedAt: '2026-11-06T02:00:00Z',
      user: { id: userId, email: 'a@example.invalid', cost: Number(day.slice(-2)) } };
  };
  const input = { name: '虚构归属', userId: 7 };
  const result = await f.publisher.backfillAccountCurrentMonth(input);
  assert.equal(result.phase, 'done');
  assert.equal(result.completed, 4); assert.equal(result.skipped, 1);
  assert.deepEqual(calls.map(row => row.day), ['2026-11-01','2026-11-02','2026-11-03','2026-11-04']);
  assert.ok(calls.every(row => row.name === input.name && row.userId === input.userId));
  assert.deepEqual(f.store.state(scope).snapshots['2026-11-05'], old);
  assert.equal(f.store.state(scope).supplements['2026-11-02']['虚构归属'][7].user.cost, 2);
  assert.equal(f.publisher.historyWeek({month:'2026-11',weekStart:'2026-11-02',name:'虚构归属'}).rows[0].values[0], 2);
  assert.equal(f.publisher.historyExport({scope:'person',name:'虚构归属',start:'2026-11-02',end:'2026-11-02'}).rows[0].cost, 2);
  assert.equal(f.sends.length + f.patches.length, 0);
  assert.deepEqual((await f.publisher.backfillAccountCurrentMonth(input)).completed, 0);
  assert.equal(calls.length, 4);
  const reopened = makeDailyUsageStore(f.dir, encryption); reopened.load();
  assert.equal(reopened.state(scope).supplements['2026-11-02']['虚构归属'][7].user.cost, 2);
});
test('single-account backfill rejects other users and preserves completed days after failure', async t => {
  const f = fixture(t); const input = { name: '虚构归属', userId: 7 };
  await assert.rejects(f.publisher.backfillAccountCurrentMonth({ name: '虚构归属', userId: 99 }), /当前归属/);
  let reads = 0;
  f.publisher.usage.readAccount = async (day, name, userId) => {
    reads++;
    if (reads === 2) throw Error('synthetic timeout');
    return { day, name, scope, checkedAt: '2026-11-06T02:00:00Z',
      user: { id: userId, email: 'a@example.invalid', cost: 1 } };
  };
  assert.equal((await f.publisher.backfillAccountCurrentMonth(input)).phase, 'failed');
  assert.equal(f.store.state(scope).supplements['2026-11-01']['虚构归属'][7].user.cost, 1);
  assert.equal(f.store.state(scope).supplements['2026-11-02'], undefined);
  assert.equal(f.sends.length + f.patches.length, 0);
});
test('single-account backfill stops when the account is already attributed to another owner', async t => {
  const f = fixture(t);
  f.store.append({ type:'snapshot', scope, day:'2026-11-01', checkedAt:'2026-11-06T02:00:00Z', final:true,
    rows:[{name:'其他归属',users:[{id:7,email:'a@example.invalid',cost:9}]}] });
  let calls=0;
  f.publisher.usage.readAccount=async()=>{calls++;throw Error('should not read');};
  const result=await f.publisher.backfillAccountCurrentMonth({name:'虚构归属',userId:7});
  assert.equal(result.phase,'failed');
  assert.match(result.message,/其他归属/);
  assert.equal(calls,0);
  assert.equal(f.store.state(scope).supplements?.['2026-11-01'],undefined);
});
test('single-account backfill can supplement a raw old snapshot hidden by a later membership date', async t => {
  const f = fixture(t);
  f.store.append({type:'snapshot',scope,day:'2026-11-01',checkedAt:'2026-11-01T02:00:00Z',final:true,
    rows:[{name:'虚构归属',users:[{id:7,email:'a@example.invalid',cost:1}]}]});
  f.publisher.usage.ownership.datedProfiles = () => [{name:'虚构归属',userIds:[7],membership:{baselineIds:[],
    changes:[{day:'2026-11-01',userIds:[]},{day:'2026-11-06',userIds:[7]}]}}];
  const called=[];
  f.publisher.usage.readAccount=async(day,name,userId)=>{
    called.push(day);return {day,name,scope,checkedAt:'2026-11-06T02:00:00Z',
      user:{id:userId,email:'a@example.invalid',cost:9}};
  };
  const old=structuredClone(f.store.state(scope).snapshots['2026-11-01']);
  const result=await f.publisher.backfillAccountCurrentMonth({name:'虚构归属',userId:7});
  assert.equal(result.phase,'done'); assert.ok(called.includes('2026-11-01'));
  assert.deepEqual(f.store.state(scope).snapshots['2026-11-01'],old);
  assert.equal(f.store.state(scope).supplements['2026-11-01']['虚构归属'][7].user.cost,9);
  const week=f.publisher.historyWeek({month:'2026-11',weekStart:'2026-10-26',name:'虚构归属'});
  assert.equal(week.rows.find(row=>row.id===7).values[6],9);
});
test('single-account month backfill on the first day has no closed dates and makes no request', async t => {
  const f = fixture(t); f.setNow(Date.parse('2026-11-01T02:00:00Z'));
  let reads=0;f.publisher.usage.readAccount=async()=>{reads++;throw Error('unexpected read');};
  const result=await f.publisher.backfillAccountCurrentMonth({name:'虚构归属',userId:7});
  assert.equal(result.phase,'done');assert.equal(result.total,0);assert.equal(reads,0);
  assert.deepEqual(f.store.state(scope).supplements,{});
});
test('account options read current platform labels but return only the selected owner accounts', async t => {
  const f = fixture(t);
  const calls = [];
  f.publisher.usage.ownership = {
    admin: async () => { calls.push('admin'); return scope; },
    profiles: () => [{ name: '虚构归属', userIds: [7, 8] }, { name: '另一归属', userIds: [9] }],
    users: async () => { calls.push('users'); return [7, 8, 9].map(id => ({ id,
      role: 'user', email: `u${id}@example.invalid`, username: `客户${id}`, balance: 1000,
      password: 'fixture-only-not-real' })); },
    profileAccounts: () => [{ id: 7, email: null }, { id: 8, email: null }]
  };
  const before = f.store.state(scope);
  const result = await f.publisher.accountOptions({ name: '虚构归属' });
  assert.deepEqual(calls, ['admin', 'users', 'admin']);
  assert.deepEqual(result, { name: '虚构归属', accounts: [
    { id: 7, email: 'u7@example.invalid', username: '客户7' },
    { id: 8, email: 'u8@example.invalid', username: '客户8' } ] });
  assert.equal(JSON.stringify(result).includes('u9@example.invalid'), false);
  assert.equal(JSON.stringify(result).includes('password'), false);
  assert.deepEqual(f.store.state(scope), before);
  await assert.rejects(f.publisher.accountOptions({ name: '不存在' }), /归属人不存在/);
  await assert.rejects(f.publisher.accountOptions({ name: '虚构归属', userId: 9 }), /归属人/);
});
test('account label lookup fails closed on stale ownership, missing account, or platform failure without affecting history', async t => {
  const f = fixture(t);
  let profiles = [{ name: '虚构归属', userIds: [7] }];
  const ownership = {
    admin: async () => scope,
    profiles: () => structuredClone(profiles),
    users: async () => [{ id: 7, role: 'user', email: 'u7@example.invalid', username: '客户7' }],
    profileAccounts: () => [{ id: 7, email: null }]
  };
  f.publisher.usage.ownership = ownership;
  ownership.users = async () => { profiles = [{ name: '虚构归属', userIds: [8] }];
    return [{ id: 7, role: 'user', email: 'u7@example.invalid', username: '客户7' }]; };
  await assert.rejects(f.publisher.accountOptions({ name: '虚构归属' }), /归属已变化/);
  profiles = [{ name: '虚构归属', userIds: [7] }];
  ownership.users = async () => [{ id: 7, role: 'admin', email: 'a@example.invalid', username: '管理' }];
  await assert.rejects(f.publisher.accountOptions({ name: '虚构归属' }), /普通用户目录/);
  ownership.users = async () => { throw Error('fixture platform offline'); };
  await assert.rejects(f.publisher.accountOptions({ name: '虚构归属' }), /fixture platform offline/);
  assert.equal(f.publisher.historyCatalog().names.includes('虚构归属'), true);
  assert.equal(f.sends.length + f.patches.length, 0);
});

test('today-only read failure or assignment change preserves the last snapshot and backoff', async t => {
  for (const mode of ['failure','changed']) {
    const f = fixture(t); await f.publisher.historyTick();
    const old = structuredClone(f.store.state(scope));
    const read = f.publisher.usage.read.bind(f.publisher.usage);
    f.publisher.usage.read = async day => {
      if (mode === 'failure') throw Error('fixture timeout');
      const result = await read(day);
      f.publisher.usage.ownership.profiles = () => [{ name: '虚构归属', userIds: [99] }];
      return result;
    };
    assert.deepEqual(await f.publisher.collectToday(), { saved: [], failed: 'today' });
    assert.deepEqual(f.store.state(scope), old);
    assert.deepEqual(await f.publisher.collectToday(), { skipped: 'backoff' });
    assert.equal(f.sends.length + f.patches.length, 0);
  }
});
test('reopening after a skipped day finalizes recorded old days without any group delivery', async t => {
  const f = fixture(t);
  await f.publisher.historyTick();
  const original = f.store.state(scope).snapshots['2026-11-06'];
  f.setNow(Date.parse('2026-11-09T02:00:00Z'));
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-08', '2026-11-09', '2026-11-06'] });
  const next = f.store.state(scope);
  assert.equal(original.final, false);
  assert.equal(next.snapshots['2026-11-06'].final, true);
  assert.equal(next.snapshots['2026-11-06'].source, 'backfill-current-ownership');
  assert.equal(next.snapshots['2026-11-07'], undefined, 'do not expand into never-recorded history');
  assert.equal(next.snapshots['2026-11-09'].final, false);
  assert.deepEqual(await f.publisher.historyTick(), { skipped: 'not-due' });
  assert.equal(f.sends.length + f.patches.length, 0);
});
test('old-day recovery is bounded, continues next tick, and preserves failed day until a full read', async t => {
  const f = fixture(t);
  for (const day of ['2026-11-01','2026-11-02','2026-11-03']) {
    f.store.append({ type: 'snapshot', scope, day, checkedAt: day + 'T02:00:00Z', final: false,
      rows: [{ name: '虚构归属', users: [{ id: 7, email: 'a@example.invalid', cost: 1 }] }] });
  }
  f.setNow(Date.parse('2026-11-09T02:00:00Z'));
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-08','2026-11-09','2026-11-01','2026-11-02'] });
  assert.deepEqual(f.publisher.state().collection.pendingDays, ['2026-11-03']);
  const originalRead = f.publisher.usage.read.bind(f.publisher.usage);
  f.publisher.usage.read = async () => { throw Error('synthetic timeout'); };
  assert.deepEqual(await f.publisher.historyTick(), { saved: [], failed: 'unfinished' });
  assert.equal(f.store.state(scope).snapshots['2026-11-03'].final, false);
  assert.deepEqual(await f.publisher.historyTick(), { skipped: 'backoff' });
  f.setNow(Date.parse('2026-11-09T02:16:00Z'));
  f.publisher.usage.read = originalRead;
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-03'] });
  assert.deepEqual(f.publisher.state().collection.pendingDays, []);
  assert.equal(f.sends.length + f.patches.length, 0);
});
test('old-day recovery does not replace historical assignments with changed current ownership', async t => {
  const f = fixture(t); await f.publisher.historyTick();
  f.setNow(Date.parse('2026-11-09T02:00:00Z'));
  const previous = f.store.state(scope).snapshots['2026-11-06'];
  f.publisher.usage.ownership.profiles = () => [{ name: '新归属', userIds: [99] }];
  const originalRead = f.publisher.usage.read.bind(f.publisher.usage);
  f.publisher.usage.read = async day => ({ ...(await originalRead(day)), rows: [
    { name: '新归属', users: [{ id: 99, email: 'other@example.invalid', cost: 1 }] }] });
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-08','2026-11-09'] });
  assert.deepEqual(f.store.state(scope).snapshots['2026-11-06'], previous);
  assert.deepEqual(f.publisher.state().collection.manualDays, ['2026-11-06']);
  assert.equal(f.sends.length + f.patches.length, 0);
});
test('old-day recovery works across a month boundary and still preserves unknown group deliveries', async t => {
  const f = fixture(t);
  f.setFailSend(true); f.enable(); await f.publisher.tick();
  const cardBefore = f.store.state(scope).cards['虚构归属'];
  f.setNow(Date.parse('2026-12-01T02:00:00Z'));
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-30','2026-12-01','2026-11-06'] });
  assert.equal(f.store.state(scope).snapshots['2026-11-06'].final, true);
  assert.deepEqual(f.store.state(scope).cards['虚构归属'], cardBefore);
  assert.equal(f.sends.length, 1); assert.equal(f.patches.length, 0);
});
test('old-day recovery yields when its dispatch budget is spent and resumes with the remaining day', async t => {
  const f = fixture(t);
  for (const day of ['2026-11-01','2026-11-02']) {
    f.store.append({ type: 'snapshot', scope, day, checkedAt: day + 'T02:00:00Z', final: false,
      rows: [{ name: '虚构归属', users: [{ id: 7, email: 'a@example.invalid', cost: 1 }] }] });
  }
  f.setNow(Date.parse('2026-11-09T02:00:00Z'));
  const read = f.publisher.usage.read.bind(f.publisher.usage);
  f.publisher.usage.read = async day => {
    if (day === '2026-11-01') f.setNow(Date.parse('2026-11-09T02:02:00Z'));
    return read(day);
  };
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-08','2026-11-09','2026-11-01'] });
  assert.equal(f.store.state(scope).snapshots['2026-11-02'].final, false);
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-02'] });
});
test('an unfinished response or ownership change cannot mark an old day finalized', async t => {
  for (const mode of ['unfinished', 'ownership']) {
    const f = fixture(t); await f.publisher.historyTick();
    f.setNow(Date.parse('2026-11-09T02:00:00Z'));
    const originalRead = f.publisher.usage.read.bind(f.publisher.usage);
    f.publisher.usage.read = async day => {
      const result = await originalRead(day);
      if (day === '2026-11-06') {
        if (mode === 'unfinished') result.final = false;
        else f.publisher.usage.ownership.profiles = () => [{ name: '虚构归属', userIds: [99] }];
      }
      return result;
    };
    assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-08','2026-11-09'], failed: 'unfinished' });
    assert.equal(f.store.state(scope).snapshots['2026-11-06'].final, false);
    assert.equal(f.sends.length + f.patches.length, 0);
  }
});
test('legacy enabled config without daily time stops automatic group posts but not local sampling', async t => {
  const f = fixture(t);
  f.store.append({ type: 'config', scope, enabled: true, days: 3 });
  assert.equal(f.publisher.state().dailyTime, null);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'daily-time-unset' });
  assert.equal(f.sends.length, 0);
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-05', '2026-11-06'] });
  assert.equal(f.sends.length, 0);
  assert.throws(() => f.publisher.setEnabled(true), /每日发送时间/);
  const reopened = makeDailyUsageStore(f.dir, encryption); reopened.load();
  assert.equal(reopened.state(scope).enabled, true);
  assert.equal(reopened.state(scope).dailyTime, null);
  for (const time of ['24:00', '9:00', '10:60', '10:00Z'])
    assert.throws(() => f.publisher.setEnabled(true, time), /时间/);
  assert.throws(() => validateEvent({ type: 'config', scope, enabled: true, days: 3,
    dailyTime: '10:00', effectiveDay: '2026-02-30' }));
});
test('daily publish skips before time, once per Beijing day, and never catches up after window', async t => {
  const f = fixture(t);
  f.setNow(Date.parse('2026-11-06T01:59:00Z'));
  f.publisher.setEnabled(true, '10:00');
  assert.deepEqual(await f.publisher.tick(), { skipped: 'outside-daily-window' });
  assert.equal(f.sends.length, 0);
  f.setNow(Date.parse('2026-11-06T02:00:00Z'));
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  f.setNow(Date.parse('2026-11-06T02:10:00Z'));
  assert.deepEqual(await f.publisher.tick(), { skipped: 'not-due' });
  f.publisher.setEnabled(true, '10:10');
  assert.deepEqual(await f.publisher.tick(), { skipped: 'schedule-not-effective' });
  assert.equal(f.sends.length, 1); assert.equal(f.patches.length, 0);
  const reopened = makeDailyUsageStore(f.dir, encryption); reopened.load();
  assert.equal(reopened.state(scope).dailyTime, '10:10');
  f.setNow(Date.parse('2026-11-06T02:25:00Z'));
  assert.deepEqual(await f.publisher.tick(), { skipped: 'schedule-not-effective' });
  assert.equal(f.sends.length, 1); assert.equal(f.patches.length, 0);
  f.setNow(Date.parse('2026-11-07T02:10:00Z'));
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.sends.length, 1); assert.equal(f.patches.length, 1);
});
test('Beijing midnight schedule uses the new local day and closes after fifteen minutes', async t => {
  const f = fixture(t);
  f.setNow(Date.parse('2026-11-06T15:59:59Z'));
  f.publisher.setEnabled(true, '00:00');
  assert.deepEqual(await f.publisher.tick(), { skipped: 'schedule-not-effective' });
  f.setNow(Date.parse('2026-11-06T16:00:00Z'));
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.store.state(scope).snapshots['2026-11-07'].final, false);
  f.setNow(Date.parse('2026-11-06T16:15:00Z'));
  assert.deepEqual(await f.publisher.tick(), { skipped: 'outside-daily-window' });
  assert.equal(f.sends.length, 1);
});
test('saving the same time during a slow read defers activation and prevents old batch sending', async t => {
  const f = fixture(t);
  f.enable();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const original = f.publisher.usage.read.bind(f.publisher.usage);
  f.publisher.usage.read = async day => {
    if (day === '2026-11-06') {
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return original(day);
  };
  const running = f.publisher.tick();
  await started;
  assert.equal(f.publisher.setEnabled(true, '10:00').effectiveDay, '2026-11-07');
  release();
  assert.deepEqual(await running, { skipped: 'scope-changed' });
  assert.equal(f.sends.length, 0);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'schedule-not-effective' });
});
test('local collection waits for authorization and does not fabricate an empty day', async t => {
  const f = fixture(t);
  f.setCollectReady(false);
  assert.deepEqual(await f.publisher.historyTick(), { skipped: 'authorization' });
  f.setCollectReady(true);
  f.publisher.usage.ownership.profiles = () => [{ name: '虚构归属', userIds: [] }];
  assert.deepEqual(await f.publisher.historyTick(), { skipped: 'no-users' });
  assert.equal(Object.keys(f.store.state(scope).snapshots).length, 0);
  assert.equal(f.reads(), 0);
});
test('partial local collection preserves the good day and backs off before retrying', async t => {
  const f = fixture(t), original = f.publisher.usage.read.bind(f.publisher.usage);
  let fail = true;
  f.publisher.usage.read = async day => {
    if (day === '2026-11-06' && fail) { fail = false; throw Error('synthetic read failure'); }
    return original(day);
  };
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-05'], failed: 'today' });
  assert.equal(f.store.state(scope).snapshots['2026-11-06'], undefined);
  assert.deepEqual(await f.publisher.historyTick(), { skipped: 'backoff' });
  f.setNow(Date.parse('2026-11-06T02:16:00Z'));
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-06'] });
  assert.equal(f.publisher.state().collection.failure, null);
  assert.equal(f.sends.length, 0);
});
test('unknown group message blocks group retry but not independent local collection', async t => {
  const f = fixture(t); f.setFailSend(true); f.enable();
  assert.deepEqual(await f.publisher.tick(), { updated: 0, unknown: 1 });
  f.setNow(Date.parse('2026-11-06T03:01:00Z'));
  assert.deepEqual(await f.publisher.tick(), { skipped: 'message-result-unknown', count: 1 });
  assert.deepEqual(await f.publisher.historyTick(), { saved: ['2026-11-06'] });
  assert.equal(f.store.state(scope).snapshots['2026-11-05'].source, 'backfill-current-ownership');
  assert.equal(f.sends.length, 1);
  assert.equal(f.store.state(scope).cards['虚构归属'].phase, 'unknown');
});
test('uncertain retirement stops later group cards instead of continuing the daily batch', async t => {
  const f = fixture(t);
  f.enable();
  f.store.append({ type: 'ready', scope, profile: '已移除归属', messageId: 'om_retired_fixture',
    at: '2026-11-05T02:00:00Z', createdAt: '2026-11-05T02:00:00Z' });
  f.publisher.getClient = () => ({
    async patchGroupCard() { throw Error('uncertain patch'); },
    async sendGroupCard() { throw Error('must not create after unknown'); }
  });
  assert.deepEqual(await f.publisher.tick(), { updated: 0, unknown: 1 });
  assert.equal(f.store.state(scope).cards['已移除归属'].phase, 'unknown');
  assert.equal(f.store.state(scope).cards['虚构归属'], undefined);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'message-result-unknown', count: 1 });
});
test('disabled by default; daily time creates one group card and next day patches same message', async t => {
  const f = fixture(t);
  assert.equal(f.publisher.state().enabled, false);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'disabled-or-offline' });
  f.enable();
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.sends.length, 1);
  assert.equal(f.patches.length, 0);
  assert.equal(f.sends[0].chatId, scope.groupId);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'not-due' });
  f.setNow(Date.parse('2026-11-07T02:00:00Z'));
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.sends.length, 1); assert.equal(f.patches.length, 1);
  assert.equal(f.patches[0].messageId, 'om_fixture_12345678');
  f.publisher.setEnabled(false);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'disabled-or-offline' });
  assert.equal(f.patches.length, 1);
});
test('uncertain group creation survives restart and is never duplicated automatically', async t => {
  const f = fixture(t); f.setFailSend(true); f.enable();
  assert.deepEqual(await f.publisher.tick(), { updated: 0, unknown: 1 });
  assert.equal(f.sends.length, 1);
  const raw = fs.readFileSync(path.join(f.dir, 'daily-usage.journal'), 'utf8');
  assert.equal(raw.includes('a@example.invalid') || raw.includes(scope.groupId), false);
  const store = makeDailyUsageStore(f.dir, encryption); store.load();
  assert.equal(store.state(scope).cards['虚构归属'].phase, 'unknown');
  f.setNow(Date.parse('2026-11-06T03:01:00Z'));
  assert.deepEqual(await f.publisher.tick(), { skipped: 'message-result-unknown', count: 1 });
  assert.equal(f.sends.length, 1);
});
test('manual absent review is one durable pause, never a send or automatic retry', async t => {
  const f = fixture(t); f.setFailSend(true); f.enable();
  assert.deepEqual(await f.publisher.tick(), { updated: 0, unknown: 1 });
  const card = f.publisher.state().cards.find(row => row.phase === 'unknown');
  assert.equal(card.action, 'create');
  const input = { name: card.name, at: card.at, confirmed: true };
  assert.throws(() => f.publisher.reviewAbsent({ ...input, confirmed: false }), /核对参数/);
  assert.throws(() => f.publisher.reviewAbsent({ ...input, at: '2026-11-01T00:00:00Z' }), /已变化/);
  const before = fs.readFileSync(path.join(f.dir, 'daily-usage.journal'), 'utf8').trimEnd().split('\n').length;
  const reviewed = f.publisher.reviewAbsent(input);
  const after = fs.readFileSync(path.join(f.dir, 'daily-usage.journal'), 'utf8').trimEnd().split('\n').length;
  assert.equal(after, before + 1);
  assert.equal(reviewed.enabled, false);
  assert.equal(reviewed.cards.find(row => row.name === card.name).phase, 'reviewed-absent');
  assert.deepEqual(await f.publisher.tick(), { skipped: 'disabled-or-offline' });
  assert.equal(f.sends.length, 1);
  assert.throws(() => f.publisher.reviewAbsent(input), /已变化/);
  const reopened = makeDailyUsageStore(f.dir, encryption); reopened.load();
  assert.equal(reopened.state(scope).enabled, false);
  assert.equal(reopened.state(scope).cards[card.name].phase, 'reviewed-absent');
  f.setFailSend(false); f.publisher.setEnabled(true, '10:00');
  assert.deepEqual(await f.publisher.tick(), { skipped: 'schedule-not-effective' });
  f.setNow(Date.parse('2026-11-07T02:00:00Z'));
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.sends.length, 2); assert.equal(f.patches.length, 0);
});
test('patch uncertainty and another group cannot use first-create absence review', async t => {
  const f = fixture(t); f.enable(); await f.publisher.tick();
  f.setNow(Date.parse('2026-11-06T03:01:00Z'));
  const existing = f.store.state(scope).cards['虚构归属'];
  f.store.append({ type: 'attempt', scope, profile: '虚构归属', action: 'patch',
    messageId: existing.messageId, at: new Date(Date.parse('2026-11-06T03:01:00Z')).toISOString(), createdAt: existing.createdAt });
  f.store.append({ type: 'unknown', scope, profile: '虚构归属', messageId: existing.messageId,
    at: '2026-11-06T03:01:03Z', createdAt: existing.createdAt });
  assert.throws(() => f.publisher.reviewAbsent({ name: '虚构归属', at: '2026-11-06T03:01:03Z', confirmed: true }), /不能按未送达核对/);
  assert.equal(f.store.state(scope).enabled, true);
  assert.equal(f.store.state({ owner: 2, groupId: 'oc_other_12345678' }).cards['虚构归属'], undefined);
  assert.equal(f.sends.length, 1);
});
test('review never unlocks another unresolved card and an interrupted first create needs explicit review', async t => {
  const f = fixture(t), at = '2026-11-06T02:00:00Z';
  f.publisher.setEnabled(true, '10:00');
  for (const name of ['虚构归属', '另一份归属'])
    f.store.append({ type: 'attempt', scope, profile: name, action: 'create', messageId: null, at, createdAt: at });
  const reviewed = f.publisher.reviewAbsent({ name: '虚构归属', at, confirmed: true });
  assert.equal(reviewed.enabled, false);
  assert.equal(f.store.state(scope).cards['另一份归属'].phase, 'attempting');
  assert.throws(() => f.publisher.setEnabled(true, '10:00'), /待核对/);
  assert.equal(f.sends.length, 0);
  const reopened = makeDailyUsageStore(f.dir, encryption); reopened.load();
  assert.equal(reopened.state(scope).enabled, false);
  assert.equal(reopened.state(scope).cards['另一份归属'].phase, 'attempting');
});
test('legacy first-create unknown without diagnostic replays and remains reviewable', t => {
  const f = fixture(t), at = '2026-11-06T02:00:00Z', unknownAt = '2026-11-06T02:00:05Z';
  f.publisher.setEnabled(true, '10:00');
  f.store.append({ type: 'attempt', scope, profile: '虚构归属', action: 'create', messageId: null, at });
  f.store.append({ type: 'unknown', scope, profile: '虚构归属', messageId: null, at: unknownAt });
  const reopened = makeDailyUsageStore(f.dir, encryption); reopened.load();
  const restarted = new DailyUsagePublisher({ store: { load() {}, state: reopened.state.bind(reopened),
    append: reopened.append.bind(reopened) }, now: () => Date.parse('2026-11-06T03:00:00Z'),
    getScope: () => scope, isReady: () => false, getClient: () => null,
    usage: { busy: false, ownership: { profiles: () => [] } } });
  const card = restarted.state().cards.find(row => row.name === '虚构归属');
  assert.equal(card.action, 'create'); assert.equal(card.failure, null);
  assert.equal(card.attemptedAt, at);
  assert.equal(restarted.reviewAbsent({ name: card.name, at: card.at, confirmed: true }).enabled, false);
});
test('failure classification stores only bounded codes, never raw API response or secrets', async t => {
  const error = Object.assign(Error('sk-fictional-secret'), { response: { status: 403,
    data: { code: 230027, msg: 'sk-fictional-secret', token: 'sk-fictional-secret' } } });
  assert.deepEqual(groupFailure(error), { kind: 'api', httpStatus: 403, apiCode: 230027 });
  assert.deepEqual(groupFailure({ code: 'ETIMEDOUT', message: 'secret' }), { kind: 'timeout' });
  assert.deepEqual(groupFailure({ groupDeliveryKind: 'receipt', feishuCode: 0, message: 'secret' }),
    { kind: 'receipt', apiCode: 0 });
  assert.throws(() => validateEvent({ type: 'unknown', scope, profile: '虚构归属', messageId: null,
    at: '2026-11-06T02:00:00Z', failure: { kind: 'api', message: 'secret' } }), /diagnostic invalid/);
  const f = fixture(t); f.enable();
  f.publisher.getClient = () => ({ async sendGroupCard() { throw error; } });
  assert.deepEqual(await f.publisher.tick(), { updated: 0, unknown: 1 });
  const card = f.publisher.state().cards.find(row => row.phase === 'unknown');
  assert.deepEqual(card.failure, { kind: 'api', httpStatus: 403, apiCode: 230027 });
  assert.equal(JSON.stringify(f.store.state(scope)).includes('sk-fictional-secret'), false);
  const reopened = makeDailyUsageStore(f.dir, encryption); reopened.load();
  assert.deepEqual(reopened.state(scope).cards['虚构归属'].failure, card.failure);
});
test('offline and changed scope do not send or patch', async t => {
  const f = fixture(t); f.setReady(false);
  assert.throws(() => f.publisher.setEnabled(true, '10:00'));
  f.setReady(true); f.publisher.setEnabled(true, '10:00'); f.setReady(false);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'disabled-or-offline' });
  assert.equal(f.sends.length, 0);
});
test('ownership changing after stats read prevents any group disclosure', async t => {
  const f = fixture(t); f.enable();
  f.publisher.usage.ownership.profiles = () => [{ name: '虚构归属', userIds: [99] }];
  assert.deepEqual(await f.publisher.tick(), { skipped: 'ownership-changed', updated: 0 });
  assert.equal(f.sends.length, 0);
  assert.equal(f.patches.length, 0);
});
test('at Beijing midnight yesterday is finalized, current day starts, and old card rotates after ten days', async t => {
  const f = fixture(t); f.enable();
  await f.publisher.tick();
  f.setNow(Date.parse('2026-11-07T02:00:00Z'));
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.store.state(scope).snapshots['2026-11-06'].final, true);
  assert.equal(f.store.state(scope).snapshots['2026-11-07'].final, false);
  assert.equal(f.patches.length, 1);
  const cardText = JSON.stringify(f.patches[0].card);
  assert.ok(cardText.includes('11-06') && cardText.includes('11-07 *'));
  f.setNow(Date.parse('2026-11-17T02:00:00Z'));
  await f.publisher.tick();
  assert.equal(f.sends.length, 2);
  const rotated = JSON.stringify(f.sends[1].card);
  assert.equal(rotated.includes('11-06'), false);
  assert.ok(rotated.includes('11-17'));
});
test('removed or emptied ownership retires the existing group card without exposing old email', async t => {
  const f = fixture(t); f.enable(); await f.publisher.tick();
  f.setNow(Date.parse('2026-11-06T02:30:00Z'));
  f.publisher.usage.ownership.profiles = () => [{ name: '虚构归属', userIds: [] }];
  const beforeReads = f.reads();
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.reads(), beforeReads);
  assert.equal(f.store.state(scope).cards['虚构归属'].phase, 'retired');
  assert.equal(JSON.stringify(f.patches[0].card).includes('a@example.invalid'), false);
  f.setNow(Date.parse('2026-11-06T03:02:00Z'));
  await f.publisher.tick();
  assert.equal(f.patches.length, 1);
});
test('unavailable ownership never retires a group card on a guessed empty profile list', async t => {
  const f = fixture(t); f.enable(); await f.publisher.tick();
  f.setNow(Date.parse('2026-11-06T02:30:00Z'));
  f.publisher.usage.ownership.profiles = () => null;
  assert.deepEqual(await f.publisher.tick(), { skipped: 'ownership-unavailable' });
  assert.equal(f.store.state(scope).cards['虚构归属'].phase, 'ready');
  assert.equal(f.patches.length, 0);
});
test('store corruption and plaintext backend fail closed', t => {
  const f = fixture(t); f.publisher.setEnabled(true, '10:00');
  fs.appendFileSync(path.join(f.dir, 'daily-usage.journal'), 'partial');
  assert.throws(() => makeDailyUsageStore(f.dir, encryption).load());
  assert.throws(() => makeDailyUsageStore(f.dir, { ...encryption,
    getSelectedStorageBackend: () => 'basic_text' }).load());
  assert.equal(HOUR_MS, 3600000);
});
test('manual current-month backfill persists closed days without sending a group card; repeat skips final snapshots', async t => {
  const f = fixture(t);
  const result = await f.publisher.backfillCurrentMonth();
  assert.equal(result.phase, 'done');
  assert.equal(result.completed, 5);
  assert.equal(result.total, 5);
  assert.equal(f.sends.length, 0); assert.equal(f.patches.length, 0);
  const saved = f.store.state(scope).snapshots;
  assert.equal(saved['2026-11-01'].source, 'backfill-current-ownership');
  assert.equal(saved['2026-11-05'].final, true);
  assert.equal(saved['2026-11-06'], undefined);
  const repeated = await f.publisher.backfillCurrentMonth();
  assert.equal(repeated.completed, 0); assert.equal(repeated.skipped, 5);
  assert.equal(f.reads(), 5);
});
test('failed backfill keeps successful days and retries only the missing day', async t => {
  const f = fixture(t);
  const original = f.publisher.usage.read.bind(f.publisher.usage);
  let failOnce = true;
  f.publisher.usage.read = async day => {
    if (day === '2026-11-03' && failOnce) { failOnce = false; throw Error('synthetic network failure'); }
    return original(day);
  };
  const failed = await f.publisher.backfillCurrentMonth();
  assert.equal(failed.phase, 'failed'); assert.equal(failed.completed, 2);
  assert.equal(f.store.state(scope).snapshots['2026-11-03'], undefined);
  assert.equal(f.store.state(scope).snapshots['2026-11-02'].final, true);
  const resumed = await f.publisher.backfillCurrentMonth();
  assert.equal(resumed.phase, 'done'); assert.equal(resumed.skipped, 2);
  assert.equal(resumed.completed, 3);
  assert.equal(f.sends.length, 0);
});
test('empty current ownership cannot create a misleading historical zero snapshot', async t => {
  const f = fixture(t);
  f.publisher.usage.ownership.profiles = () => [{ name: '虚构归属', userIds: [] }];
  await assert.rejects(f.publisher.backfillCurrentMonth(), /没有已保存的归属账号/);
  assert.equal(Object.keys(f.store.state(scope).snapshots).length, 0);
});
test('ownership change during a historical read stops before saving that day', async t => {
  const f = fixture(t);
  const original = f.publisher.usage.read.bind(f.publisher.usage);
  f.publisher.usage.read = async day => {
    const result = await original(day);
    f.publisher.usage.ownership.profiles = () => [{ name: '虚构归属', userIds: [99] }];
    return result;
  };
  const result = await f.publisher.backfillCurrentMonth();
  assert.equal(result.phase, 'failed');
  assert.equal(result.completed, 0);
  assert.equal(Object.keys(f.store.state(scope).snapshots).length, 0);
  assert.equal(f.sends.length, 0);
});
