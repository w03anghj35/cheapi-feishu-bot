'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AdminSession } = require('./auth-session');
const { makeSessionStore } = require('./session-store');
const { ToolError } = require('./service');
const record = (token = 'fixture-access', owner = 1) => ({ token, owner, origin: 'https://max.cheapi.cc', savedAt: '2026-10-28T10:00:00.000Z' });
function fixture(initial) {
  let saved = initial, candidate = 'fixture-web', verifiedOwner = 1, failure, failSave = false;
  const counts = { read: 0, verify: 0, flush: 0, open: 0, save: 0 }, states = [];
  const options = {
    store: { load: () => saved, save: value => { counts.save++; if (failSave) throw new ToolError('STORAGE', 'fixture storage'); saved = value; } },
    readCandidate: async () => { counts.read++; return candidate; },
    verify: async () => { counts.verify++; if (failure) throw failure; return verifiedOwner; },
    flush: async () => { counts.flush++; }, openLogin: async () => { counts.open++; }, onChange: value => states.push(value)
  };
  return { options, auth: new AdminSession(options), counts, states, saved: () => saved,
    candidate: v => { candidate = v; }, owner: v => { verifiedOwner = v; }, fail: v => { failure = v; }, failSave: () => { failSave = true; } };
}
test('saved session verifies and restores without loading a website', async () => {
  const f = fixture(record()); const credential = await f.auth.ensure();
  assert.equal(credential.owner, 1); assert.equal(f.counts.read, 0); assert.equal(f.counts.verify, 1);
  assert.equal(f.auth.state().phase, 'ready'); assert.equal(JSON.stringify(f.auth.state()).includes('fixture-access'), false);
  await f.auth.ensure(); assert.equal(f.counts.verify, 1);
});
test('first launch migrates only a verified dedicated browser credential', async () => {
  const f = fixture(undefined); await Promise.all([f.auth.ensure(), f.auth.ensure()]);
  assert.equal(f.counts.read, 1); assert.equal(f.counts.verify, 1); assert.equal(f.counts.flush, 1); assert.equal(f.counts.save, 1);
  assert.equal(f.saved().token, 'fixture-web');
  const reopened = new AdminSession(f.options); await reopened.ensure(); assert.equal(f.counts.read, 1);
});
test('a revocation tombstone never falls back to old browser login', async () => {
  const f = fixture(null); await assert.rejects(f.auth.ensure(), { code: 'AUTH' }); assert.equal(f.counts.read, 0);
});
test('missing browser credential is durably recorded as revoked', async () => {
  const f = fixture(undefined); f.candidate(null);
  await assert.rejects(f.auth.ensure(), { code: 'AUTH' }); assert.equal(f.saved(), null);
  await assert.rejects(new AdminSession(f.options).ensure(), { code: 'AUTH' }); assert.equal(f.counts.read, 1);
});
test('401 and account mismatch revoke persisted access rather than migrating stale browser data', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture(record()); if (mismatch) f.owner(2); else f.fail(new ToolError('AUTH', 'fixture 401'));
    await assert.rejects(f.auth.ensure(), { code: 'AUTH' }); assert.equal(f.saved(), null); assert.equal(f.counts.read, 0);
  }
});
test('network failure preserves saved authorization and permits an explicit retry', async () => {
  const f = fixture(record()); f.fail(new ToolError('NETWORK', 'fixture offline'));
  await assert.rejects(f.auth.ensure(), { code: 'NETWORK' }); assert.equal(f.counts.save, 0); assert.equal(f.auth.phase, 'offline');
  f.fail(null); await f.auth.ensure(); assert.equal(f.auth.phase, 'ready'); assert.equal(f.counts.read, 0);
});
test('explicit login revokes before opening, blocks customer requests and saves a different account', async () => {
  const f = fixture(record()); const old = await f.auth.ensure();
  await f.auth.begin(); assert.equal(f.saved(), null); assert.equal(f.auth.state().owner, null);
  await assert.rejects(f.auth.ensure(), { code: 'AUTH' }); assert.throws(() => f.auth.assertCurrent(old), { code: 'AUTH' });
  f.owner(2); await f.auth.finish(); const current = await f.auth.ensure();
  assert.equal(current.owner, 2); assert.equal(f.saved().owner, 2);
  f.auth.reject(old); assert.equal(f.auth.phase, 'ready'); assert.equal(f.saved().owner, 2);
});
test('current 401 clears authorization and does not automatically open login', async () => {
  const f = fixture(record()); const credential = await f.auth.ensure(); f.auth.reject(credential);
  assert.equal(f.auth.phase, 'expired'); assert.equal(f.saved(), null); assert.equal(f.counts.open, 0);
  await assert.rejects(f.auth.ensure(), { code: 'AUTH' });
});
test('failed or incomplete login cannot restore the former credential', async () => {
  const f = fixture(record()); await f.auth.begin(); f.candidate(null);
  await assert.rejects(f.auth.finish(), { code: 'AUTH' }); assert.equal(f.saved(), null); assert.equal(f.auth.phase, 'login');
  f.candidate('fixture-new'); f.fail(new ToolError('NETWORK', 'fixture network'));
  await assert.rejects(f.auth.finish(), { code: 'NETWORK' }); assert.equal(f.saved(), null);
  f.fail(null); await f.auth.finish(); assert.equal(f.auth.phase, 'ready');
});
test('concurrent completion verifies and saves once', async () => {
  const f = fixture(null); await f.auth.begin(); await Promise.all([f.auth.finish(), f.auth.finish()]);
  assert.equal(f.counts.verify, 1); assert.equal(f.counts.save, 2); // revocation + completed login
});
test('login during verification is rejected without switching credentials', async () => {
  const f = fixture(record()); const pending = f.auth.ensure();
  await assert.rejects(f.auth.begin(), { code: 'BUSY' }); await pending; assert.equal(f.counts.open, 0);
});
test('storage failure closes authorization rather than claiming it saved', async () => {
  const f = fixture(null); await f.auth.begin(); f.failSave();
  await assert.rejects(f.auth.finish(), { code: 'STORAGE' }); assert.equal(f.auth.phase, 'storage-error');
  await assert.rejects(f.auth.ensure(), { code: 'STORAGE' }); assert.equal(f.auth.record, null);
});
test('failed revocation does not open an account-switching page', async () => {
  const f = fixture(record()); await f.auth.ensure(); f.failSave();
  await assert.rejects(f.auth.begin(), { code: 'STORAGE' }); assert.equal(f.counts.open, 0); assert.equal(f.auth.phase, 'storage-error');
});
test('corrupt vault disables migration and login until storage is repaired', async () => {
  const f = fixture(undefined); const auth = new AdminSession({ ...f.options, store: { load() { throw new Error('corrupt'); } } });
  await assert.rejects(auth.ensure(), { code: 'STORAGE' }); await assert.rejects(auth.begin(), { code: 'STORAGE' });
  assert.equal(f.counts.read, 0);
});
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-auth-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
// This fake crypto tests storage control flow only. The Electron suite tests actual DPAPI.
const crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from([...value].reverse().join('')),
  decryptString: value => [...value.toString()].reverse().join('') };
test('session journal encrypts, reopens and distinguishes missing from revoked', t => {
  const dir = directory(t); const store = makeSessionStore(dir, crypto);
  assert.equal(store.load(), undefined); store.save(record());
  assert.equal(fs.readFileSync(path.join(dir, 'admin-session.journal'), 'utf8').includes('fixture-access'), false);
  const reopened = makeSessionStore(dir, crypto); assert.deepEqual(reopened.load(), record()); reopened.save(null);
  assert.equal(makeSessionStore(dir, crypto).load(), null);
});
test('short writes complete before a session is committed', t => {
  const dir = directory(t); let writes = 0;
  const io = { ...fs, writeSync(fd, bytes, offset, length) { writes++; return fs.writeSync(fd, bytes, offset, Math.min(length, 7)); } };
  const store = makeSessionStore(dir, crypto, io); store.load(); store.save(record());
  assert.ok(writes > 1); assert.deepEqual(makeSessionStore(dir, crypto).load(), record());
});
for (const fault of ['truncated', 'checksum', 'sequence', 'empty', 'decrypt']) test('vault fails closed on ' + fault, t => {
  const dir = directory(t), file = path.join(dir, 'admin-session.journal');
  const store = makeSessionStore(dir, crypto); store.load(); store.save(record()); store.save(null);
  let text = fs.readFileSync(file, 'utf8');
  if (fault === 'truncated') text = text.slice(0, -1);
  if (fault === 'empty') text = '';
  if (fault === 'checksum') text = text.replace(/"checksum":"[a-f0-9]+"/, '"checksum":"bad"');
  if (fault === 'sequence') {
    const rows = text.trim().split('\n').map(JSON.parse); const entry = JSON.parse(rows[1].payload); entry.sequence = 9;
    rows[1].payload = JSON.stringify(entry); rows[1].checksum = createHash('sha256').update(rows[1].payload).digest('hex');
    text = rows.map(JSON.stringify).join('\n') + '\n';
  }
  if (fault === 'decrypt') text = text.split('\n')[0] + '\n';
  fs.writeFileSync(file, text);
  const reopened = makeSessionStore(dir, fault === 'decrypt' ? { ...crypto, decryptString() { throw new Error('wrong user'); } } : crypto);
  assert.throws(() => reopened.load(), { code: 'STORAGE' }); assert.throws(() => reopened.save(null), { code: 'STORAGE' });
});
for (const fault of ['writeSync', 'fsyncSync', 'encryptString']) test('vault locks after ' + fault + ' failure', t => {
  const dir = directory(t); const io = { ...fs }, security = { ...crypto };
  (fault === 'encryptString' ? security : io)[fault] = () => { throw new Error('fixture disk or encryption failure'); };
  const store = makeSessionStore(dir, security, io); store.load();
  assert.throws(() => store.save(record()), { code: 'STORAGE' }); assert.throws(() => store.save(null), { code: 'STORAGE' });
});
test('system encryption unavailable never falls back to plaintext', t => {
  const dir = directory(t); const store = makeSessionStore(dir, { ...crypto, isEncryptionAvailable: () => false });
  assert.throws(() => store.load(), { code: 'STORAGE' }); assert.equal(fs.existsSync(path.join(dir, 'admin-session.journal')), false);
});

const changedContext = { isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from('new-context:' + value),
  decryptString(value) { const text = value.toString(); if (!text.startsWith('new-context:')) throw new Error('private decrypt detail'); return text.slice(12); } };
function unreadable(t, io = fs, encryption = changedContext) {
  const dir = directory(t), file = path.join(dir, 'admin-session.journal');
  const old = makeSessionStore(dir, crypto); old.load(); old.save(record());
  const original = fs.readFileSync(file, 'utf8');
  const store = makeSessionStore(dir, encryption, io);
  return { dir, file, original, store };
}
test('explicit recovery preserves old bytes and backup, appends revocation and requires a separate login', async t => {
  const f = unreadable(t); let reads = 0, opens = 0;
  const operations = path.join(f.dir, 'operations.journal'); fs.writeFileSync(operations, 'unknown-operation-preserved');
  const auth = new AdminSession({ store: f.store, readCandidate: async () => { reads++; return 'new-fixture'; },
    verify: async () => 1, flush: async () => {}, openLogin: async () => { opens++; } });
  assert.equal(auth.state().canRecover, true);
  assert.throws(() => auth.recover(false), { code: 'STORAGE' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  auth.recover(true);
  assert.equal(auth.phase, 'required'); assert.equal(auth.record, null);
  assert.equal(auth.state().canRecover, false); assert.equal(opens, 0);
  await assert.rejects(auth.ensure(), { code: 'AUTH' }); assert.equal(reads, 0);
  assert.ok(fs.readFileSync(f.file, 'utf8').startsWith(f.original));
  const backups = fs.readdirSync(f.dir).filter(name => name.startsWith('admin-session.preserved-'));
  assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(f.dir, backups[0]), 'utf8'), f.original);
  assert.equal(fs.readFileSync(operations, 'utf8'), 'unknown-operation-preserved');
  assert.equal(makeSessionStore(f.dir, changedContext).load(), null);
  assert.throws(() => auth.recover(true), { code: 'STORAGE' });
  await auth.begin(); await auth.finish(); assert.equal(auth.phase, 'ready');
  assert.equal(makeSessionStore(f.dir, changedContext).load().token, 'new-fixture');
});
for (const kind of ['checksum','truncated','sequence','schema','base64']) test('recovery never bypasses invalid journal: ' + kind, t => {
  const f = unreadable(t);
  if (kind === 'truncated') fs.writeFileSync(f.file, f.original.slice(0, -1));
  else if (kind === 'checksum') fs.writeFileSync(f.file, f.original.replace(/"checksum":"[a-f0-9]+"/, '"checksum":"wrong"'));
  else {
    const row = JSON.parse(f.original), entry = JSON.parse(row.payload);
    if (kind === 'sequence') entry.sequence = 5;
    if (kind === 'base64') entry.sealed = '!invalid!';
    if (kind === 'schema') entry.sealed = changedContext.encryptString('{"invalid":true}').toString('base64');
    row.payload = JSON.stringify(entry); row.checksum = createHash('sha256').update(row.payload).digest('hex');
    fs.writeFileSync(f.file, JSON.stringify(row) + '\n');
  }
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.store.load(), { code: 'STORAGE' }); assert.equal(f.store.canRecover(), false);
  assert.throws(() => f.store.recover(true), { code: 'STORAGE' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
for (const kind of ['backup-write','backup-fsync','backup-close','append-write','append-fsync','append-close','changed-file','encryption']) test('recovery uncertainty stays closed and cannot retry: ' + kind, t => {
  let writes = 0, flushes = 0, closes = 0;
  const io = { ...fs,
    writeSync(...args) { writes++; if ((kind === 'backup-write' && writes === 1) || (kind === 'append-write' && writes === 2)) throw new Error('private'); return fs.writeSync(...args); },
    fsyncSync(fd) { flushes++; if ((kind === 'backup-fsync' && flushes === 1) || (kind === 'append-fsync' && flushes === 2)) throw new Error('private'); fs.fsyncSync(fd); },
    closeSync(fd) { closes++; if ((kind === 'backup-close' && closes === 1) || (kind === 'append-close' && closes === 2)) throw new Error('private'); fs.closeSync(fd); }
  };
  const encryption = { ...changedContext };
  const f = unreadable(t, io, encryption); assert.throws(() => f.store.load());
  if (kind === 'changed-file') fs.appendFileSync(f.file, f.original);
  if (kind === 'encryption') encryption.isEncryptionAvailable = () => false;
  assert.throws(() => f.store.recover(true), e => e.code === 'STORAGE' && !e.message.includes('private'));
  assert.throws(() => f.store.save(record()), { code: 'STORAGE' });
  assert.throws(() => f.store.recover(true), { code: 'STORAGE' });
  assert.equal(f.store.canRecover(), false);
  if (!['append-write','append-fsync','append-close','changed-file'].includes(kind)) assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});
