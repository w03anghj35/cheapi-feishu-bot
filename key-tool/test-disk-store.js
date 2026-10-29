'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeDiskStore } = require('./disk-store');
const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
const row = { requestId: 'fixture-id', body: { name: 'fixture', quota: 5 }, owner: 1, fingerprint: 'fixture', state: 'pending' };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-store-test-'));
  t.after(() => { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); });
  return { dir, journal: path.join(dir, 'operations.journal'), store: makeDiskStore(dir, safeStorage) };
}
test('real files: flushed snapshots reopen at last sequence without any rename', t => {
  const f = setup(t);
  const store = makeDiskStore(f.dir, safeStorage, { ...fs, renameSync() { throw new Error('must not rename'); } });
  assert.deepEqual(store.load(), []); store.save([row]); store.save([{ ...row, state: 'success', result: 'sealed-fixture' }]);
  assert.equal(makeDiskStore(f.dir, safeStorage).load()[0].state, 'success');
  assert.equal(fs.readFileSync(f.journal, 'utf8').split('\n').length, 4);
});
test('orphan legacy tmp is migrated as protected unknown, and original is preserved', t => {
  const f = setup(t), file = path.join(f.dir, 'operations.json.tmp');
  const content = JSON.stringify([{ ...row, state: 'reviewed' }]); fs.writeFileSync(file, content);
  assert.equal(f.store.load()[0].state, 'unknown'); assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.equal(makeDiskStore(f.dir, safeStorage).load()[0].state, 'unknown');
});
test('successful legacy records survive migration; orphan tmp cannot release a lock', t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.dir, 'operations.json'), JSON.stringify([{ ...row, state: 'success', result: 'sealed' }]));
  assert.equal(f.store.load()[0].state, 'success');
});
test('conflicting legacy tmp locks startup instead of silently discarding it', t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.dir, 'operations.json'), JSON.stringify([row]));
  fs.writeFileSync(path.join(f.dir, 'operations.json.tmp'), JSON.stringify([{ ...row, owner: 2 }]));
  assert.throws(() => f.store.load(), { code: 'STORAGE' }); assert.equal(fs.existsSync(f.journal), false);
});
test('truncated or checksum-damaged journal locks startup instead of falling back to old state', t => {
  const f = setup(t); f.store.load(); f.store.save([row]); const text = fs.readFileSync(f.journal, 'utf8');
  for (const bad of [text.slice(0, -2), text.replace('fixture-id', 'tampered-id'), text + '\n']) {
    fs.writeFileSync(f.journal, bad); assert.throws(() => makeDiskStore(f.dir, safeStorage).load(), { code: 'STORAGE' });
  }
});
test('partial write poisons the writer; later calls cannot append after a damaged tail', t => {
  const f = setup(t); let fail = false;
  const io = { ...fs, writeSync(fd, buffer, offset, length) {
    if (!fail) return fs.writeSync(fd, buffer, offset, length);
    fs.writeSync(fd, buffer, offset, 8); throw new Error('injected write failure');
  } };
  const store = makeDiskStore(f.dir, safeStorage, io); store.load(); fail = true;
  assert.throws(() => store.save([row])); const size = fs.statSync(f.journal).size;
  assert.throws(() => store.save([row]), { code: 'STORAGE' }); assert.equal(fs.statSync(f.journal).size, size);
  assert.throws(() => makeDiskStore(f.dir, safeStorage).load(), { code: 'STORAGE' });
});
test('short writes are completed and fsync failure stops subsequent writes', t => {
  const f = setup(t); let fail = false;
  const io = { ...fs, writeSync: (fd, b, o, n) => fs.writeSync(fd, b, o, Math.min(17, n)),
    fsyncSync(fd) { if (fail) throw new Error('sync failure'); fs.fsyncSync(fd); } };
  const store = makeDiskStore(f.dir, safeStorage, io); store.load(); store.save([row]);
  assert.equal(makeDiskStore(f.dir, safeStorage).load()[0].state, 'pending'); fail = true;
  assert.throws(() => store.save([row])); assert.throws(() => store.save([row]), { code: 'STORAGE' });
});
