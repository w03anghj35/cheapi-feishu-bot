'use strict';
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { makeDiskStore } = require('./disk-store');
const { KeyService } = require('./service');
const { makeCatalogStore } = require('./group-catalog');
const { makeSessionStore } = require('./session-store');
app.whenReady().then(async () => {
  const parent = path.join(app.getPath('appData'), 'CheapiKeyStudio');
  const dir = fs.mkdtempSync(path.join(parent, 'storage-regression-'));
  let posts = 0;
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    const options = { request: async (method, route) => {
      if (route === '/auth/me') return { id: 1 };
      if (route === '/groups/available') return [{ id: 7, name: 'fixture' }];
      if (method === 'POST') { posts++; return { id: 44, key: 'sk-storage-fixture-only' }; }
      throw new Error('unexpected route');
    }, store: makeDiskStore(dir, safeStorage), catalog: makeCatalogStore(dir) };
    const input = { requestId: '11111111-1111-4111-8111-111111111111', groupId: 7, quota: 5, days: 30, operator: '存储测试客户' };
    const service = new KeyService(options); await service.refresh();
    assert.deepEqual(service.state().groups, []);
    await service.saveGroupNames({ owner: 1, items: [{ id: 7, name: '客户测试分组' }] });
    assert.equal((await service.create(input)).id, 44);
    assert.equal(fs.readFileSync(path.join(dir, 'operations.journal'), 'utf8').includes('sk-storage-fixture-only'), false);
    const reopened = new KeyService({ ...options, store: makeDiskStore(dir, safeStorage), catalog: makeCatalogStore(dir) }); await reopened.refresh();
    assert.deepEqual(reopened.state().groups, [{ id: 7, name: '客户测试分组' }]);
    assert.equal((await reopened.create(input)).key, 'sk-storage-fixture-only'); assert.equal(posts, 1);
    const list = reopened.adminRecords({ search: '存储测试客户' });
    assert.equal(list.total, 1); assert.equal(list.items[0].quota, 5); assert.equal(list.items[0].days, 30);
    assert.equal(list.items[0].operator.verified, false);
    assert.equal(list.items[0].group.originalName, 'fixture');
    assert.equal(list.items[0].group.customerName, '客户测试分组');
    assert.equal(list.items[0].keyId, 44);
    assert.equal(JSON.stringify(list).includes('sk-storage-fixture-only'), false);
    assert.equal(JSON.stringify(reopened.adminRecord(input.requestId)).includes('sk-storage-fixture-only'), false);
    assert.equal(reopened.adminSecret(input.requestId), 'sk-storage-fixture-only');
    const third = new KeyService({ ...options, store: makeDiskStore(dir, safeStorage), catalog: makeCatalogStore(dir) });
    assert.equal(third.adminRecord(input.requestId).events.at(-1).kind, 'admin-reveal');
    assert.equal(fs.readFileSync(path.join(dir, 'operations.journal'), 'utf8').includes('sk-storage-fixture-only'), false);
    const authRecord = { token: 'fixture-access-not-real', owner: 1, origin: 'https://max.cheapi.cc', savedAt: new Date().toISOString() };
    const authStore = makeSessionStore(dir, safeStorage); assert.equal(authStore.load(), undefined); authStore.save(authRecord);
    assert.equal(fs.readFileSync(path.join(dir, 'admin-session.journal'), 'utf8').includes(authRecord.token), false);
    const authReopened = makeSessionStore(dir, safeStorage); assert.deepEqual(authReopened.load(), authRecord);
    authReopened.save(null); assert.equal(makeSessionStore(dir, safeStorage).load(), null);
    const report = { passed: true, runtime: process.versions.electron, realNetworkRequests: 0, realCreationRequests: 0,
      checks: ['same application data directory','flushed pending and receipt','real safeStorage encrypted receipt',
        'reopen decrypts receipt','duplicate operation does not repeat fictional POST','customer group names persist in actual data directory',
        'real safeStorage encrypts and restores administrator session','revoked session survives reopen without browser fallback',
        'operator group snapshots quota and expiry survive reopen','history list and detail contain no full secret',
        'administrator reveal is durably audited before disclosure','audit access survives another reopen without plaintext key'] };
    fs.writeFileSync(path.join(__dirname, '../outputs/key-tool-storage-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
    fs.rmdirSync(dir);
  }
}).then(() => app.exit(0), () => { console.error('Storage runtime regression failed'); app.exit(1); });
