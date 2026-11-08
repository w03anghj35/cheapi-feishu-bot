'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { ownerAbsent, recoverStaleLease } = require('./feishu-lease-recovery');
const { makeConnectionLease } = require('./feishu-connection-lease');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'feishu-connection.lock') };
}
function stale(file) {
  const child = spawnSync(process.execPath, ['-e',
    "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,token:require('node:crypto').randomUUID()}))", file],
  { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(child.status, 0);
  return fs.readFileSync(file);
}
test('only a definite absent PID permits recovery; live, EPERM and invalid IDs stay protected', () => {
  assert.equal(ownerAbsent(process.pid), false);
  for (const pid of [0, -1, 1.5, '123', 2147483648]) assert.equal(ownerAbsent(pid), false);
  assert.equal(ownerAbsent(123, () => { throw { code: 'ESRCH' }; }), true);
  for (const code of ['EPERM', 'EINVAL', 'UNKNOWN'])
    assert.equal(ownerAbsent(123, () => { throw { code }; }), false);
});
test('live owners and malformed locks do not start recovery helpers', t => {
  const { file } = temp(t); let helpers = 0;
  const options = { platform: 'win32', run: () => { helpers++; throw new Error('must not run'); } };
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: randomUUID() }));
  assert.equal(recoverStaleLease(file, options), false);
  fs.writeFileSync(file, '{partial'); assert.equal(recoverStaleLease(file, options), false);
  assert.equal(helpers, 0);
});
test('helper timeout, denial and ambiguous output cannot authorize acquiring a second connection', t => {
  const { file } = temp(t); fs.writeFileSync(file, JSON.stringify({ pid: 123, token: randomUUID() }));
  const probe = () => { throw { code: 'ESRCH' }; };
  for (const result of [{ status: 1, stdout: 'protected' }, { error: { code: 'ETIMEDOUT' } }, { status: 0, stdout: 'unknown' }])
    assert.equal(recoverStaleLease(file, { platform: 'win32', probe, run: () => result }), false);
  assert.equal(fs.existsSync(file), true);
});
test('Windows recovery archives an exited process lease then new owner acquires; live contender stays blocked', { skip: process.platform !== 'win32' }, t => {
  const { dir, file } = temp(t), oldBytes = stale(file);
  const first = makeConnectionLease(file), second = makeConnectionLease(file);
  assert.equal(first.acquire(), true);
  const archive = fs.readdirSync(dir).filter(name => name.endsWith('.bak'));
  assert.equal(archive.length, 1); assert.deepEqual(fs.readFileSync(path.join(dir, archive[0])), oldBytes);
  assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
  assert.throws(() => second.acquire()); first.release(); second.acquire(); second.release();
});
test('native recheck refuses a live PID even if the first probe wrongly says absent', { skip: process.platform !== 'win32' }, t => {
  const { dir, file } = temp(t);
  const bytes = JSON.stringify({ pid: process.pid, token: randomUUID() }); fs.writeFileSync(file, bytes);
  assert.equal(recoverStaleLease(file, { probe: () => { throw { code: 'ESRCH' }; } }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(dir), ['feishu-connection.lock']);
});
test('replacement between preliminary probe and native open is protected', { skip: process.platform !== 'win32' }, t => {
  const { file } = temp(t); stale(file);
  const replacement = JSON.stringify({ pid: process.pid, token: randomUUID() });
  assert.equal(recoverStaleLease(file, { run: (...args) => {
    fs.writeFileSync(file, replacement); return spawnSync(...args);
  } }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), replacement);
});
test('native exclusive file handle prevents two recovery processes from removing a replacement live lock', { skip: process.platform !== 'win32' }, async t => {
  const { file } = temp(t); stale(file);
  const leaseModule = require.resolve('./feishu-connection-lease');
  const script = "const {makeConnectionLease}=require(process.argv[1]);const lease=makeConnectionLease(process.argv[2]);try{lease.acquire();console.log('acquired');process.stdin.resume();process.stdin.once('data',()=>{lease.release();process.exit(0)});}catch{console.log('blocked');process.exit(0)}";
  const children = [0, 1].map(() => spawn(process.execPath, ['-e', script, leaseModule, file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  const exits = children.map(child => once(child, 'exit'));
  const replies = await Promise.all(children.map(child => new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(new Error('child timeout')), 25000);
    child.stdout.on('data', bytes => { out += bytes; if (out.includes('\n')) { clearTimeout(timer); resolve(out.trim()); } });
    child.on('error', e => { clearTimeout(timer); reject(e); });
  })));
  try { assert.deepEqual([...replies].sort(), ['acquired', 'blocked']); }
  finally { children.forEach((child, i) => { if (replies[i] === 'acquired') child.stdin.end('release'); }); await Promise.all(exits); }
  assert.equal(fs.existsSync(file), false);
});
