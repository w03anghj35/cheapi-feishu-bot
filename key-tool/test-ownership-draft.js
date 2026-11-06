'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeOwnershipDraftStore } = require('./ownership-draft');
const scope = { owner: 1, groupId: 'oc_group_12345678' };
const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi',
  encryptString: value => Buffer.from(`sealed:${value}`),
  decryptString: value => { const text = value.toString(); if (!text.startsWith('sealed:')) throw Error('cipher'); return text.slice(7); } };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-draft-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: makeOwnershipDraftStore(dir, safeStorage) };
}
test('encrypted draft preserves name, search and checked IDs across reopen, then clears', t => {
  const f = fixture(t); f.store.load();
  const draft = { profile: '', name: '陈梦', search: '用户', userIds: [8, 3, 19] };
  assert.deepEqual(f.store.save(scope, draft), draft);
  const raw = fs.readFileSync(path.join(f.dir, 'ownership-drafts.journal'), 'utf8');
  assert.equal(raw.includes('陈梦') || raw.includes('用户'), false);
  const reopened = makeOwnershipDraftStore(f.dir, safeStorage); reopened.load();
  assert.deepEqual(reopened.state(scope), draft);
  assert.equal(reopened.state({ owner: 2, groupId: scope.groupId }), null);
  reopened.save(scope, null);
  assert.equal(makeLoaded(f.dir).state(scope), null);
});
function makeLoaded(dir) { const store = makeOwnershipDraftStore(dir, safeStorage); store.load(); return store; }
test('invalid, truncated and nonencrypted drafts fail closed without overwriting', t => {
  const f = fixture(t); f.store.load();
  assert.throws(() => f.store.save(scope, { profile: '', name: 'x', search: '', userIds: [1, 1] }));
  f.store.save(scope, { profile: '', name: 'x', search: '', userIds: [1] });
  const file = path.join(f.dir, 'ownership-drafts.journal');
  fs.appendFileSync(file, 'partial');
  assert.throws(() => makeLoaded(f.dir));
  const bad = makeOwnershipDraftStore(f.dir, { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' });
  assert.throws(() => bad.load());
});
