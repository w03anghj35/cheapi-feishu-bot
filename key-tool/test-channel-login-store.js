'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { makeChannelLoginStore } = require('./channel-login-store');
const { CHANNELS } = require('./channel-monitor');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-login-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32);
  const encryption = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, data, cipher.getAuthTag()]); },
    decryptString(value) { const iv = value.subarray(0, 12), data = value.subarray(12, -16), tag = value.subarray(-16);
      const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'); }
  };
  return { dir, encryption, file: path.join(dir, 'aerorelay-login.journal') };
}
const fixture = { email: 'fictional@example.invalid', password: 'fixture-only-secret-not-real' };
test('opt-in credential is encrypted, restartable, pausable and clearable', t => {
  const { dir, encryption, file } = setup(t);
  const store = makeChannelLoginStore(dir, encryption);
  assert.deepEqual(store.load(), { configured: false, enabled: false, storageError: false });
  store.save(fixture);
  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(disk.includes(fixture.email) || disk.includes(fixture.password), false);
  assert.deepEqual(store.credentials(), fixture);
  const reopened = makeChannelLoginStore(dir, encryption); reopened.load();
  assert.deepEqual(reopened.credentials(), fixture);
  assert.deepEqual(reopened.claim(), fixture);
  assert.equal(reopened.credentials(), null);
  const interrupted = makeChannelLoginStore(dir, encryption); interrupted.load();
  assert.equal(interrupted.state().enabled, false);
  reopened.resume(fixture);
  assert.deepEqual(reopened.credentials(), fixture);
  assert.deepEqual(reopened.pause(), { configured: true, enabled: false, storageError: false });
  assert.equal(reopened.credentials(), null);
  const again = makeChannelLoginStore(dir, encryption); again.load();
  assert.equal(again.state().enabled, false);
  again.clear(); assert.equal(fs.existsSync(file), false);
  assert.deepEqual(makeChannelLoginStore(dir, encryption).load(), { configured: false, enabled: false, storageError: false });
});
test('invalid, corrupt, plaintext backend and failed write never enable automatic login', t => {
  const { dir, encryption, file } = setup(t);
  const store = makeChannelLoginStore(dir, encryption); store.load();
  for (const input of [null, {}, { ...fixture, email: 'not-email' }, { ...fixture, password: '' }])
    assert.throws(() => store.save(input), error => error.code === 'INPUT');
  assert.equal(store.credentials(), null);
  store.save(fixture); fs.appendFileSync(file, 'truncated');
  const corrupt = makeChannelLoginStore(dir, encryption);
  assert.throws(() => corrupt.load(), error => error.code === 'STORAGE' && !error.message.includes(fixture.password));
  assert.equal(corrupt.credentials(), null);
  const insecure = makeChannelLoginStore(path.join(dir, 'insecure'), { ...encryption, isEncryptionAvailable: () => false });
  assert.throws(() => insecure.load(), error => error.code === 'STORAGE');
  const basic = makeChannelLoginStore(path.join(dir, 'basic'), { ...encryption, getSelectedStorageBackend: () => 'basic_text' });
  assert.throws(() => basic.load(), error => error.code === 'STORAGE');
});
test('write error pauses in memory and never returns raw secret in error', t => {
  const { dir, encryption } = setup(t);
  const io = { ...fs, writeSync() { throw new Error(fixture.password); } };
  const store = makeChannelLoginStore(dir, encryption, io); store.load();
  assert.throws(() => store.save(fixture), error => error.code === 'STORAGE' && !error.message.includes(fixture.password));
  assert.equal(store.credentials(), null);
});
test('five channel vaults are isolated and preserve the existing AeroRelay filename', t => {
  const { dir, encryption } = setup(t);
  const stores = new Map(CHANNELS.map(c => [c.id, makeChannelLoginStore(dir, encryption, fs, c.id)]));
  for (const store of stores.values()) store.load();
  for (const channel of CHANNELS) {
    const store = stores.get(channel.id);
    store.save({ ...fixture, password: `fixture-only-${channel.id}` });
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'aerorelay-login.journal', 'channel-login-balance-juxiang.journal',
    'channel-login-points-anna.journal', 'channel-login-points-ip.journal',
    'channel-login-spent-ccrouter.journal'
  ]);
  stores.get('points-ip').clear();
  for (const channel of CHANNELS.slice(1)) {
    const reopened = makeChannelLoginStore(dir, encryption, fs, channel.id);
    assert.equal(reopened.load().enabled, true);
    assert.equal(reopened.credentials().password, `fixture-only-${channel.id}`);
  }
  assert.throws(() => makeChannelLoginStore(dir, encryption, fs, '../unsafe'), error => error.code === 'INPUT');
});
test('Juxiang accepts a username or email while other channels keep email-only validation', t => {
  const { dir, encryption } = setup(t);
  const juxiang = makeChannelLoginStore(dir, encryption, fs, 'balance-juxiang'); juxiang.load();
  juxiang.save({ email: 'fictional_username', password: fixture.password });
  assert.equal(makeChannelLoginStore(dir, encryption, fs, 'balance-juxiang').load().enabled, true);
  assert.equal(juxiang.credentials().email, 'fictional_username');
  for(const email of ['', 'bad name', 'bad\nname'])
    assert.throws(() => juxiang.save({email,password:fixture.password}), error => error.code === 'INPUT');
  const anna = makeChannelLoginStore(dir, encryption, fs, 'points-anna'); anna.load();
  assert.throws(() => anna.save({ email: 'fictional_username', password: fixture.password }), error => error.code === 'INPUT');
});
