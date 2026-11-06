'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeDailyUsageStore } = require('./daily-usage-store');
const { DailyUsagePublisher, HOUR_MS } = require('./daily-usage-publisher');
const { beijingDay } = require('./daily-usage');
const scope = { owner: 1, groupId: 'oc_fixture_12345678' };
const encryption = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
  encryptString: text => Buffer.from(`sealed:${text}`),
  decryptString: bytes => { const text = bytes.toString(); if (!text.startsWith('sealed:')) throw Error('cipher'); return text.slice(7); } };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-usage-publisher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-11-06T02:00:00Z'), ready = true, failSend = false, reads = 0;
  const sends = [], patches = [];
  const store = makeDailyUsageStore(dir, encryption);
  const publisher = new DailyUsagePublisher({ store, now: () => now, getScope: () => scope,
    isReady: () => ready, getClient: () => ({
      async sendGroupCard(row) { sends.push(row); if (failSend) throw Error('unknown delivery'); return 'om_fixture_12345678'; },
      async patchGroupCard(row) { patches.push(row); return row.messageId; }
    }), usage: { ownership: { profiles: () => [{ name: '虚构归属', userIds: [7] }] },
      async read(day) { reads++; return { day, checkedAt: new Date(now).toISOString(),
      final: day < beijingDay(now), scope, rows: [{ name: '虚构归属', users: [
        { id: 7, email: 'a@example.invalid', cost: reads } ] }] }; } } });
  return { dir, publisher, store, sends, patches, setNow: value => { now = value; },
    setReady: value => { ready = value; }, setFailSend: value => { failSend = value; }, reads: () => reads };
}
test('disabled by default; explicit enable creates one group card, hourly tick patches same message', async t => {
  const f = fixture(t);
  assert.equal(f.publisher.state().enabled, false);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'disabled-or-offline' });
  f.publisher.setEnabled(true);
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.sends.length, 1);
  assert.equal(f.patches.length, 0);
  assert.equal(f.sends[0].chatId, scope.groupId);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'not-due' });
  f.setNow(Date.parse('2026-11-06T03:01:00Z'));
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.sends.length, 1); assert.equal(f.patches.length, 1);
  assert.equal(f.patches[0].messageId, 'om_fixture_12345678');
  f.publisher.setEnabled(false);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'disabled-or-offline' });
  assert.equal(f.patches.length, 1);
});
test('uncertain group creation survives restart and is never duplicated automatically', async t => {
  const f = fixture(t); f.setFailSend(true); f.publisher.setEnabled(true);
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
test('offline and changed scope do not send or patch', async t => {
  const f = fixture(t); f.setReady(false);
  assert.throws(() => f.publisher.setEnabled(true));
  f.setReady(true); f.publisher.setEnabled(true); f.setReady(false);
  assert.deepEqual(await f.publisher.tick(), { skipped: 'disabled-or-offline' });
  assert.equal(f.sends.length, 0);
});
test('ownership changing after stats read prevents any group disclosure', async t => {
  const f = fixture(t); f.publisher.setEnabled(true);
  f.publisher.usage.ownership.profiles = () => [{ name: '虚构归属', userIds: [99] }];
  assert.deepEqual(await f.publisher.tick(), { skipped: 'ownership-changed', updated: 0 });
  assert.equal(f.sends.length, 0);
  assert.equal(f.patches.length, 0);
});
test('at Beijing midnight yesterday is finalized, current day starts, and old card rotates after ten days', async t => {
  const f = fixture(t); f.publisher.setEnabled(true);
  await f.publisher.tick();
  f.setNow(Date.parse('2026-11-06T16:05:00Z'));
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
  const f = fixture(t); f.publisher.setEnabled(true); await f.publisher.tick();
  f.setNow(Date.parse('2026-11-06T03:01:00Z'));
  f.publisher.usage.ownership.profiles = () => [{ name: '虚构归属', userIds: [] }];
  f.publisher.usage.read = async day => ({ day, checkedAt: '2026-11-06T03:01:00Z',
    final: false, scope, rows: [{ name: '虚构归属', users: [] }] });
  assert.deepEqual(await f.publisher.tick(), { updated: 1, unknown: 0 });
  assert.equal(f.store.state(scope).cards['虚构归属'].phase, 'retired');
  assert.equal(JSON.stringify(f.patches[0].card).includes('a@example.invalid'), false);
  f.setNow(Date.parse('2026-11-06T04:02:00Z'));
  await f.publisher.tick();
  assert.equal(f.patches.length, 1);
});
test('store corruption and plaintext backend fail closed', t => {
  const f = fixture(t); f.publisher.setEnabled(true);
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
