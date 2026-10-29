'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { customerName, validateCatalog, makeCatalogStore } = require('./group-catalog');
const rows = [{ owner: 1, groupId: 7, name: '客户分组' }];
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-catalog-test-'));
  t.after(() => { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); });
  return { dir, file: path.join(dir, 'group-catalog.journal') };
}
test('catalog requires canonical names, unique IDs and names per account', () => {
  assert.equal(customerName('  名称  '), '名称'); assert.equal(customerName('  '), '');
  for (const value of [null, 42, 'a\tb', 'a'.repeat(81)]) assert.throws(() => customerName(value));
  for (const invalid of [null, [null], [{ ...rows[0], owner: 0 }], [{ ...rows[0], groupId: 0 }],
    [{ ...rows[0], name: '' }], [{ ...rows[0], name: ' 有空白 ' }], [...rows, ...rows],
    [...rows, { ...rows[0], groupId: 9 }]]) assert.throws(() => validateCatalog(invalid));
  assert.equal(validateCatalog([...rows, { ...rows[0], owner: 2 }]).length, 2);
});
test('missing file is deny-all; durable aliases and unpublication reopen without rename', t => {
  const f = setup(t), store = makeCatalogStore(f.dir, { ...fs, renameSync() { throw new Error('forbidden rename'); } });
  assert.deepEqual(store.load(), []); assert.equal(fs.existsSync(f.file), false);
  store.save(rows); assert.deepEqual(makeCatalogStore(f.dir).load(), rows);
  store.save([]); assert.deepEqual(makeCatalogStore(f.dir).load(), []);
  assert.throws(() => store.load());
});
test('short writes are completed before publication', t => {
  const f = setup(t); let writes = 0;
  const store = makeCatalogStore(f.dir, { ...fs, writeSync(fd, b, o, n) { writes++; return fs.writeSync(fd, b, o, Math.min(13, n)); } });
  store.load(); store.save(rows); assert.ok(writes > 1); assert.deepEqual(makeCatalogStore(f.dir).load(), rows);
});
test('truncation, checksum, sequence and empty files fail closed without fallback', t => {
  const f = setup(t), store = makeCatalogStore(f.dir); store.load(); store.save(rows);
  const original = fs.readFileSync(f.file, 'utf8');
  const payload = JSON.stringify({ sequence: 9, rows });
  const outOfOrder = JSON.stringify({ payload, checksum: createHash('sha256').update(payload).digest('hex') }) + '\n';
  for (const text of ['', original.slice(0, -1), original.replace('客户分组', '修改名字'), original + '\n', outOfOrder]) {
    fs.writeFileSync(f.file, text); const damaged = makeCatalogStore(f.dir);
    assert.throws(() => damaged.load()); assert.throws(() => damaged.save(rows));
    assert.equal(fs.readFileSync(f.file, 'utf8'), text);
  }
});
test('partial append poisons writer and restart rather than exposing the old configuration', t => {
  const f = setup(t); let fail = false;
  const store = makeCatalogStore(f.dir, { ...fs, writeSync(fd, b, o, n) {
    if (fail) { fs.writeSync(fd, b, o, 8); throw new Error('injected'); }
    return fs.writeSync(fd, b, o, n);
  } });
  store.load(); store.save(rows); fail = true; assert.throws(() => store.save([]));
  const size = fs.statSync(f.file).size; assert.throws(() => store.save([]));
  assert.equal(fs.statSync(f.file).size, size); assert.throws(() => makeCatalogStore(f.dir).load());
});
test('fsync or zero-write failure permanently prevents further appends in this writer', t => {
  const f = setup(t); let syncFail = false;
  const store = makeCatalogStore(f.dir, { ...fs, fsyncSync(fd) { if (syncFail) throw new Error('sync'); fs.fsyncSync(fd); } });
  store.load(); store.save(rows); syncFail = true; assert.throws(() => store.save([]));
  const size = fs.statSync(f.file).size; assert.throws(() => store.save(rows)); assert.equal(fs.statSync(f.file).size, size);
  const zero = makeCatalogStore(f.dir, { ...fs, writeSync: () => 0 }); zero.load(); assert.throws(() => zero.save(rows));
  assert.throws(() => zero.save(rows));
});
