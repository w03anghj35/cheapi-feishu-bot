'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeChannelAccessStore, FRESH_MS } = require('./channel-access');
const { CHANNELS } = require('./channel-monitor');
const secretStorage = {
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
  encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString('utf8')
};
const identityA = { botAccountId: 'bot-alpha', senderId: 'member-alpha' };
const identityB = { botAccountId: 'bot-alpha', senderId: 'member-beta' };
const grant = (identity, channelIds, name = '模拟成员') => ({ ...identity, channelIds, name });
function fixture(t, storage = secretStorage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-access-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = () => makeChannelAccessStore(dir, storage);
  const store = make(); store.load(); return { dir, store, make };
}
const snapshots = now => CHANNELS.map((channel, index) => ({ id: channel.id, name: channel.defaultName,
  status: 'ok', value: 100 + index, display: String(100 + index), successAt: new Date(now).toISOString(),
  checkedAt: new Date(now).toISOString() }));

test('two people see only their granted channels and wrong identity cannot query', t => {
  const { store } = fixture(t); const now = Date.now();
  store.grant(grant(identityA, [CHANNELS[0].id]));
  store.grant(grant(identityB, [CHANNELS[1].id]));
  assert.deepEqual(store.query(identityA, snapshots(now), { now }).map(row => row.channelId), [CHANNELS[0].id]);
  assert.deepEqual(store.query(identityB, snapshots(now), { now }).map(row => row.channelId), [CHANNELS[1].id]);
  assert.throws(() => store.query(identityA, snapshots(now), { channelId: CHANNELS[1].id, now }), { code: 'DENIED' });
  assert.throws(() => store.query({ ...identityA, botAccountId: 'other-bot' }, snapshots(now)), { code: 'DENIED' });
  assert.equal(store.state().people.some(row => JSON.stringify(row).includes('member-alpha')), false);
});

test('grant updates and revocation survive restart; old values are never current', t => {
  const { dir, store, make } = fixture(t); const now = Date.now();
  const first = store.grant(grant(identityA, [CHANNELS[0].id]));
  const id = first.people[0].id;
  store.update(id, [CHANNELS[1].id]);
  const old = snapshots(now); old[1].successAt = new Date(now - FRESH_MS - 1).toISOString();
  assert.equal(store.query(identityA, old, { now })[0].value, null);
  assert.equal(store.query(identityA, old, { now })[0].status, 'unavailable');
  store.revoke(id);
  assert.throws(() => store.query(identityA, snapshots(now), { now }), { code: 'DENIED' });
  const reopened = make(); reopened.load();
  assert.equal(reopened.state().people[0].enabled, false);
  assert.throws(() => reopened.query(identityA, snapshots(now), { now }), { code: 'DENIED' });
  reopened.update(id, [CHANNELS[1].id]);
  assert.deepEqual(reopened.query(identityA, snapshots(now), { now }).map(row => row.channelId), [CHANNELS[1].id]);
  const raw = fs.readFileSync(path.join(dir, 'channel-access.journal'), 'utf8');
  assert.equal(raw.includes('member-alpha') || raw.includes('bot-alpha'), false);
});

test('invalid grants do not change state and malformed stored data fails closed', t => {
  const { dir, store, make } = fixture(t);
  for (const bad of [grant(identityA, []), grant(identityA, ['unknown']),
    grant(identityA, [CHANNELS[0].id, CHANNELS[0].id]), grant({ botAccountId: 'x', senderId: 'valid-member' }, [CHANNELS[0].id])])
    assert.throws(() => store.grant(bad), { code: 'INPUT' });
  assert.equal(store.state().people.length, 0);
  store.grant(grant(identityA, [CHANNELS[0].id]));
  fs.appendFileSync(path.join(dir, 'channel-access.journal'), 'corrupt');
  const broken = make(); assert.throws(() => broken.load(), { code: 'STORAGE' });
  assert.throws(() => broken.query(identityA, snapshots(Date.now())), { code: 'STORAGE' });
});

test('unavailable encryption refuses storage and query', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-access-no-encryption-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = makeChannelAccessStore(dir, { ...secretStorage, getSelectedStorageBackend: () => 'basic_text' });
  assert.throws(() => store.load(), { code: 'STORAGE' });
  assert.throws(() => store.query(identityA, snapshots(Date.now())), { code: 'STORAGE' });
});

test('failed current read and untrusted source name are not exposed as fresh data', t => {
  const { store } = fixture(t); const now = Date.now();
  store.grant(grant(identityA, [CHANNELS[0].id]));
  const rows = snapshots(now);
  rows[0].name = '<script>untrusted</script>';
  rows[0].status = 'failed';
  const failed = store.query(identityA, rows, { now })[0];
  assert.equal(failed.name, CHANNELS[0].defaultName);
  assert.equal(failed.value, null);
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.successAt, null);
  rows[0].status = 'ok';
  assert.equal(store.query(identityA, rows, { now })[0].name, CHANNELS[0].defaultName);
});

test('removing the authority file after load cannot silently recreate old grants', t => {
  const { dir, store } = fixture(t);
  store.grant(grant(identityA, [CHANNELS[0].id]));
  fs.unlinkSync(path.join(dir, 'channel-access.journal'));
  assert.throws(() => store.update(store.state().people[0].id, [CHANNELS[1].id]), { code: 'STORAGE' });
  assert.throws(() => store.query(identityA, snapshots(Date.now())), { code: 'STORAGE' });
  assert.equal(fs.existsSync(path.join(dir, 'channel-access.journal')), false);
});

test('authority file replacement is rejected on the next read', t => {
  const { dir, store } = fixture(t);
  store.grant(grant(identityA, [CHANNELS[0].id]));
  const file = path.join(dir, 'channel-access.journal');
  const raw = fs.readFileSync(file);
  fs.writeFileSync(file, raw.toString('utf8').replace('a', 'b'));
  assert.throws(() => store.query(identityA, snapshots(Date.now())), { code: 'STORAGE' });
});

test('queryCurrent rereads grants after monitor work and refuses a revocation', t => {
  const { store } = fixture(t); const now = Date.now();
  const id = store.grant(grant(identityA, [CHANNELS[0].id])).people[0].id;
  assert.throws(() => store.queryCurrent(identityA, () => {
    store.revoke(id); return snapshots(now);
  }, { now }), { code: 'DENIED' });
});
