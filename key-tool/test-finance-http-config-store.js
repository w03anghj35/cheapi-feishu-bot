'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFinanceHttpConfigStore } = require('./finance-http-config-store');

const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: text => Buffer.from(text, 'utf8'),
  decryptString: bytes => bytes.toString('utf8')
};
const token = 'a'.repeat(64);

test('财务接口配置默认关闭，授权和密钥仅在受控读取中出现', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-http-config-'));
  try {
    const store = makeFinanceHttpConfigStore(dir, safeStorage);
    assert.deepEqual(store.load(), { configured: false, enabled: false, ownerId: null, storageError: false });
    assert.deepEqual(store.configure({ enabled: true, ownerId: 7, token }),
      { configured: true, enabled: true, ownerId: 7, storageError: false });
    assert.equal(JSON.stringify(store.state()).includes(token), false);
    const reopened = makeFinanceHttpConfigStore(dir, safeStorage);
    assert.equal(reopened.load().enabled, true);
    assert.deepEqual(reopened.secret(), { enabled: true, ownerId: 7, token });
    reopened.configure({ enabled: false, ownerId: 7, token });
    assert.equal(makeFinanceHttpConfigStore(dir, safeStorage).load().enabled, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('损坏、截断或不可用的安全存储拒绝启用，不创建空配置覆盖原件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-http-config-'));
  try {
    const store = makeFinanceHttpConfigStore(dir, safeStorage);
    store.load(); store.configure({ enabled: true, ownerId: 7, token });
    const file = path.join(dir, 'finance-http-config.journal');
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, original.subarray(0, original.length - 1));
    const bad = makeFinanceHttpConfigStore(dir, safeStorage);
    assert.throws(() => bad.load(), { code: 'STORAGE' });
    assert.throws(() => bad.configure({ enabled: false, ownerId: 7, token }), { code: 'STORAGE' });
    assert.deepEqual(fs.readFileSync(file), original.subarray(0, original.length - 1));
    assert.throws(() => makeFinanceHttpConfigStore(path.join(dir, 'other'), {
      ...safeStorage, isEncryptionAvailable: () => false
    }).load(), { code: 'STORAGE' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('运行期间配置被外部替换时拒绝沿用内存旧密钥', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-http-config-'));
  try {
    const store = makeFinanceHttpConfigStore(dir, safeStorage);
    store.load(); store.configure({ enabled: true, ownerId: 7, token });
    const file = path.join(dir, 'finance-http-config.journal');
    fs.appendFileSync(file, 'unexpected\n');
    assert.equal(store.state().storageError, true);
    assert.equal(store.state().enabled, false);
    assert.throws(() => store.secret(), { code: 'STORAGE' });
    assert.throws(() => store.configure({ enabled: true, ownerId: 7, token }), { code: 'STORAGE' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
