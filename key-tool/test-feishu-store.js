'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { makeFeishuStore, validateCredentials } = require('./feishu-store');
const record = { appId: 'cli_1234567890abcdef', appSecret: 'fixture-only-secret', savedAt: '2026-10-28T08:00:00.000Z' };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-store-test-'));
  const key = randomBytes(32);
  const encryption = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
    decryptString(value) { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString('utf8'); }
  };
  t.after(() => { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); fs.rmdirSync(dir); });
  return { dir, encryption, file: path.join(dir, 'feishu-connection.journal') };
}
test('credentials match the pinned SDK App ID grammar and reject invalid secrets', () => {
  assert.deepEqual(validateCredentials({ appId: ' cli_1234567890abcdef ', appSecret: ' fixture ' }), { appId: record.appId, appSecret: 'fixture' });
  for (const input of [null, {}, { ...record, appId: 'cli_abcd' }, { ...record, appId: 'cli_zzzzzzzzzzzzzzzz' }, { ...record, appSecret: '' }, { ...record, appSecret: 'a\nb' }, { ...record, appSecret: 'a'.repeat(513) }]) assert.throws(() => validateCredentials(input), e => e.code === 'INPUT');
});
test('missing is unconfigured; encrypted append and reopen work without rename', t => {
  const { dir, encryption, file } = setup(t);
  const io = { ...fs, renameSync() { throw new Error('must not rename'); } };
  const store = makeFeishuStore(dir, encryption, io); assert.equal(store.load(), undefined);
  store.save(record); const second = { ...record, appSecret: 'another-fixture-secret' }; store.save(second);
  assert.equal(fs.readFileSync(file, 'utf8').includes('fixture'), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes(record.appId), false);
  assert.deepEqual(makeFeishuStore(dir, encryption).load(), second);
});
test('short writes are completed and flushed before commit', t => {
  const { dir, encryption } = setup(t); let flushes = 0;
  const store = makeFeishuStore(dir, encryption, { ...fs, writeSync: (fd, buf, off, len) => fs.writeSync(fd, buf, off, Math.min(7, len)), fsyncSync(fd) { flushes++; fs.fsyncSync(fd); } });
  store.load(); store.save(record); assert.equal(flushes, 1); assert.deepEqual(makeFeishuStore(dir, encryption).load(), record);
});
for (const kind of ['empty', 'truncated', 'checksum', 'sequence', 'decrypt']) test('corrupt configuration fails closed: ' + kind, t => {
  const { dir, encryption, file } = setup(t); const store = makeFeishuStore(dir, encryption); store.load(); store.save(record);
  if (kind === 'decrypt') encryption.decryptString = () => { throw new Error('private payload'); };
  else {
    const text = fs.readFileSync(file, 'utf8'); const row = JSON.parse(text);
    if (kind === 'empty') fs.writeFileSync(file, '');
    if (kind === 'truncated') fs.writeFileSync(file, text.slice(0, -1));
    if (kind === 'checksum') fs.writeFileSync(file, JSON.stringify({ ...row, checksum: 'wrong' }) + '\n');
    if (kind === 'sequence') fs.writeFileSync(file, text + text);
  }
  const reopened = makeFeishuStore(dir, encryption); assert.throws(() => reopened.load(), e => e.code === 'STORAGE' && !e.message.includes('private'));
  assert.throws(() => reopened.save(record), e => e.code === 'STORAGE');
});
for (const kind of ['write', 'zero-write', 'fsync', 'encrypt']) test('uncertain save poisons writer: ' + kind, t => {
  const { dir, encryption } = setup(t); const io = { ...fs };
  const fail = () => { throw new Error('fixture-secret-must-not-escape'); };
  if (kind === 'write') io.writeSync = fail;
  if (kind === 'zero-write') io.writeSync = () => 0;
  if (kind === 'fsync') io.fsyncSync = fail;
  if (kind === 'encrypt') encryption.encryptString = fail;
  const store = makeFeishuStore(dir, encryption, io); store.load();
  assert.throws(() => store.save(record), e => e.code === 'STORAGE' && !e.message.includes('fixture'));
  assert.throws(() => store.save(record), e => e.code === 'STORAGE');
});
test('no encryption or plaintext backend never falls back to plaintext', t => {
  const { dir, encryption, file } = setup(t);
  for (const secure of [{ ...encryption, isEncryptionAvailable: () => false }, { ...encryption, getSelectedStorageBackend: () => 'basic_text' }]) assert.throws(() => makeFeishuStore(dir, secure).load(), e => e.code === 'STORAGE');
  assert.equal(fs.existsSync(file), false);
});
test('invalid input is not committed and does not poison a healthy writer', t => {
  const { dir, encryption } = setup(t); const store = makeFeishuStore(dir, encryption); store.load();
  assert.throws(() => store.save({ ...record, appSecret: '' })); store.save(record);
  assert.deepEqual(makeFeishuStore(dir, encryption).load(), record);
});
