'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeOwnershipQueryAudit } = require('./ownership-query-audit');
const { UserOwnership } = require('./user-ownership');

const GROUP = 'oc_group_12345678', ACTOR = 'ou_actor_12345678';
const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
  encryptString: value => Buffer.from(`sealed:${value}`),
  decryptString: value => { const text = value.toString(); if (!text.startsWith('sealed:')) throw Error('cipher'); return text.slice(7); } };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-query-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, audit: makeOwnershipQueryAudit(dir, safeStorage) };
}
test('query audit is encrypted, append-only and survives reopen', t => {
  const f = fixture(t); f.audit.load();
  f.audit.append({ owner: 1, groupId: GROUP, openId: ACTOR, actorName: '登记人', name: '陈梦',
    status: 'found', count: 2, at: new Date().toISOString() });
  const raw = fs.readFileSync(path.join(f.dir, 'query-audit.journal'), 'utf8');
  assert.equal(raw.includes(ACTOR) || raw.includes('陈梦'), false);
  const reopened = makeOwnershipQueryAudit(f.dir, safeStorage); reopened.load();
  assert.equal(reopened.list(1, GROUP).length, 1);
  assert.equal(reopened.list(1, GROUP)[0].kind, 'balance', 'older audit rows remain balance queries');
  assert.equal(reopened.list(2, GROUP).length, 0);
  reopened.append({ owner: 1, groupId: GROUP, openId: ACTOR, actorName: '登记人', name: '不存在',
    status: 'not-found', count: 0, at: new Date().toISOString() });
  assert.deepEqual(reopened.list(1, GROUP).map(row => row.status), ['not-found', 'found']);
  fs.appendFileSync(path.join(f.dir, 'query-audit.journal'), 'partial');
  assert.throws(() => makeOwnershipQueryAudit(f.dir, safeStorage).load());
});
test('usage query audit is encrypted and distinguished from balance queries', t => {
  const f = fixture(t); f.audit.load();
  f.audit.append({ owner: 1, groupId: GROUP, openId: ACTOR, actorName: '登记人', name: '陈梦',
    kind: 'usage', status: 'found', count: 2, at: new Date().toISOString() });
  const raw = fs.readFileSync(path.join(f.dir, 'query-audit.journal'), 'utf8');
  assert.equal(raw.includes(ACTOR) || raw.includes('陈梦') || raw.includes('usage'), false);
  const reopened = makeOwnershipQueryAudit(f.dir, safeStorage); reopened.load();
  assert.equal(reopened.list(1, GROUP)[0].kind, 'usage');
});
test('administrator all-profile usage audit survives reopen separately from member usage', t => {
  const f = fixture(t); f.audit.load();
  f.audit.append({ owner:1,groupId:GROUP,openId:ACTOR,actorName:'已核实飞书管理员',name:'全部归属人',
    kind:'usage-all',status:'found',count:5,at:new Date().toISOString() });
  const raw=fs.readFileSync(path.join(f.dir,'query-audit.journal'),'utf8');
  assert.equal(raw.includes('usage-all')||raw.includes('全部归属人'),false);
  const reopened=makeOwnershipQueryAudit(f.dir,safeStorage);reopened.load();
  assert.equal(reopened.list(1,GROUP)[0].kind,'usage-all');
  assert.equal(reopened.list(2,GROUP).length,0);
});
test('query result is withheld when audit append fails', async t => {
  const f = fixture(t); f.audit.load();
  let rows = [];
  const users = [{ id: 1, username: '客户', email: 'client@example.invalid',
    role: 'user', status: 'active', balance: 3 }];
  const service = new UserOwnership({ audit: { load() {}, append() { throw Error('disk'); }, list: () => [] },
    store: { load: () => rows, save: next => { rows = structuredClone(next); } },
    getOwner: () => 1, getGroupId: () => GROUP,
    request: async (_method, route) => route === '/auth/me' ? { id: 1, role: 'admin' } :
      { items: users, total: users.length } });
  await service.assignName({ name: '陈梦', userIds: [1] });
  service.claim(ACTOR, '成员');
  await service.link({ identity: service.list()[0].identity, profileName: '陈梦' });
  await assert.rejects(service.query(ACTOR), { code: 'STORAGE' });
  assert.equal(service.storageFault, true);
});
test('one-click bound lookup writes an auditable identity and profile before returning data', async t => {
  const f = fixture(t);
  let rows = [];
  const users = [{ id: 1, username: '客户', email: 'client@example.invalid',
    role: 'user', status: 'active', balance: 3 }];
  const service = new UserOwnership({ audit: f.audit,
    store: { load: () => rows, save: next => { rows = structuredClone(next); } },
    getOwner: () => 1, getGroupId: () => GROUP,
    request: async (_method, route) => route === '/auth/me' ? { id: 1, role: 'admin' } :
      { items: users, total: users.length } });
  await service.assignName({ name: '陈梦', userIds: [1] });
  service.claim(ACTOR, '飞书显示名');
  assert.equal(await service.query(ACTOR), null);
  assert.equal(f.audit.list(1, GROUP).length, 0);
  await service.link({ identity: service.list()[0].identity, profileName: '陈梦' });
  assert.deepEqual((await service.query(ACTOR)).users.map(user => user.id), [1]);
  const records = f.audit.list(1, GROUP);
  assert.equal(records.length, 1);
  assert.equal(records[0].openId, ACTOR);
  assert.equal(records[0].actorName, '飞书显示名');
  assert.equal(records[0].name, '陈梦');
  assert.equal(records[0].status, 'found');
  assert.equal(records[0].count, 1);
});
test('unavailable encryption refuses audit load', t => {
  const f = fixture(t);
  const bad = makeOwnershipQueryAudit(f.dir, { ...safeStorage,
    getSelectedStorageBackend: () => 'basic_text' });
  assert.throws(() => bad.load());
});
