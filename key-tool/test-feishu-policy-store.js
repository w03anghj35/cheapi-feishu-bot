'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { emptyPolicy, validatePolicy, makeFeishuPolicyStore } = require('./feishu-policy-store');
const { makeConnectionLease } = require('./feishu-connection-lease');

const valid = { enabled: true, ownerOpenId: 'ou_12345678', groupId: 'oc_12345678', platformOwnerId: 1, maxQuota: 5, maxUserDailyQuota: 10, maxGroupDailyQuota: 50 };
function vault() {
  const values = new Map();
  return { isEncryptionAvailable: () => true,
    encryptString: value => { const key = String(values.size + 1); values.set(key, value); return Buffer.from(key); },
    decryptString: value => values.get(value.toString()) };
}
test('policy defaults off; valid limits persist encrypted and reopen; plaintext never appears', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-policy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const safeStorage = vault(), store = makeFeishuPolicyStore(dir, safeStorage);
  assert.deepEqual(store.load(), emptyPolicy()); store.save(valid);
  const raw = fs.readFileSync(path.join(dir, 'feishu-bot-policy.journal'), 'utf8');
  assert.equal(raw.includes('ou_12345678'), false); assert.equal(raw.includes('oc_12345678'), false);
  assert.deepEqual(makeFeishuPolicyStore(dir, safeStorage).load(), valid);
  const unlimited = { ...valid, maxQuota: 20, maxUserDailyQuota: null, maxGroupDailyQuota: null };
  store.save(unlimited);
  assert.deepEqual(makeFeishuPolicyStore(dir, safeStorage).load(), unlimited);
});
test('missing binding, missing limits, inconsistent or malformed limits fail closed', () => {
  for (const policy of [
    { ...valid, ownerOpenId: null }, { ...valid, groupId: null }, { ...valid, maxQuota: null },
    { ...valid, maxUserDailyQuota: 4 }, { ...valid, maxGroupDailyQuota: 4 },
    { ...valid, maxQuota: 0 }, { ...valid, maxQuota: Infinity }, { ...valid, groupId: 'other' }
  ]) assert.throws(() => validatePolicy(policy));
  assert.equal(validatePolicy({ ...valid, enabled: false, ownerOpenId: null, groupId: null, maxQuota: null,
    maxUserDailyQuota: null, maxGroupDailyQuota: null }).enabled, false);
});
test('explicit null daily limits mean unlimited, while old unbound account policies migrate disabled', () => {
  const unlimited = validatePolicy({ ...valid, maxQuota: 20, maxUserDailyQuota: null, maxGroupDailyQuota: null });
  assert.equal(unlimited.enabled, true);
  assert.equal(unlimited.maxQuota, 20);
  assert.equal(unlimited.maxUserDailyQuota, null);
  assert.equal(unlimited.maxGroupDailyQuota, null);
  const { normalizeStoredPolicy } = require('./feishu-policy-store');
  const { platformOwnerId: _oldAccountBinding, ...legacyRow } = valid;
  const legacy = normalizeStoredPolicy(legacyRow);
  assert.equal(legacy.enabled, false, 'legacy policy without account binding must remain disabled');
  assert.equal(legacy.platformOwnerId, null);
});
test('loading a legacy encrypted journal without account binding migrates it disabled', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-policy-legacy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const safeStorage = vault(); fs.mkdirSync(dir, { recursive: true });
  const { platformOwnerId: _legacyField, ...legacyPolicy } = valid;
  const payload = JSON.stringify({ sequence: 1, sealed: safeStorage.encryptString(JSON.stringify(legacyPolicy)).toString('base64') });
  const checksum = createHash('sha256').update(payload).digest('hex');
  fs.writeFileSync(path.join(dir, 'feishu-bot-policy.journal'), JSON.stringify({ payload, checksum }) + '\n');
  const migrated = makeFeishuPolicyStore(dir, safeStorage).load();
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.platformOwnerId, null);
  assert.equal(migrated.groupId, valid.groupId);
});
test('damaged, truncated, unencrypted and failed-write journals do not fall back', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-policy-bad-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = makeFeishuPolicyStore(dir, vault()); store.load(); store.save(valid);
  fs.appendFileSync(path.join(dir, 'feishu-bot-policy.journal'), '{');
  assert.throws(() => makeFeishuPolicyStore(dir, vault()).load());
  const basic = { ...vault(), getSelectedStorageBackend: () => 'basic_text' };
  assert.throws(() => makeFeishuPolicyStore(path.join(dir, 'basic'), basic).load());
  const brokenIO = { ...fs, openSync() { throw new Error('fixture write failure'); } };
  const failing = makeFeishuPolicyStore(path.join(dir, 'write-fail'), vault(), brokenIO); failing.load();
  assert.throws(() => failing.save(valid));
});
test('connection lease allows one owner and does not automatically remove uncertain lock', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-lease-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'active.lock'), first = makeConnectionLease(file, fs, 12345), second = makeConnectionLease(file, fs, 12346);
  first.acquire(); assert.throws(() => second.acquire());
  first.release(); second.acquire(); second.release();
  fs.writeFileSync(file, '{bad'); assert.throws(() => first.acquire()); assert.equal(fs.existsSync(file), true);
});
