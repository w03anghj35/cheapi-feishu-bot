'use strict';
// Cross-process real safeStorage regression. Only fictional credentials, no network.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { makeFeishuStore } = require('./feishu-store');
const { makeSessionStore } = require('./session-store');
const { AdminSession } = require('./auth-session');
const { makeFeishuPolicyStore, emptyPolicy } = require('./feishu-policy-store');
const runtime = path.resolve(__dirname, '../.runtime');
const arg = key => process.argv.find(value => value.startsWith(key + '='))?.slice(key.length + 1);
const stage = arg('--stage') || 'parent';
const root = arg('--root') || path.join(runtime, 'feishu-context-' + randomUUID());
if (!path.resolve(root).startsWith(runtime + path.sep)) throw new Error('test root outside workspace runtime');
const context = ['wrong','recovered'].includes(stage) ? 'context-b' : stage === 'parent' ? 'orchestrator' : 'context-a';
const userData = path.join(root, context);
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData); app.disableHardwareAcceleration();
const fixture = { appId: 'cli_1234567890abcdef', appSecret: 'cross-process-fixture-secret', savedAt: '2026-10-29T08:00:00.000Z' };
let checkpoint = 'startup';
const authRecord = token => ({ token, owner: 1, origin: 'https://max.cheapi.cc', savedAt: fixture.savedAt });
async function child(phase) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [__filename, '--stage=' + phase, '--root=' + root], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', stderr = '';
    cp.stdout.on('data', b => { output += b; }); cp.stderr.on('data', b => { stderr += b; });
    const timer = setTimeout(() => { cp.kill(); reject(new Error('child timeout')); }, 30000);
    cp.on('error', () => { clearTimeout(timer); reject(new Error('child start failed')); });
    cp.on('exit', code => { clearTimeout(timer);
      console.log(JSON.stringify({ childStage: phase, exitCode: code, diagnostics: stderr.split('\n').filter(line => line.startsWith('SAFE_TEST:')) }));
      if (code !== 0 || output.includes(fixture.appSecret) || stderr.includes(fixture.appSecret)) reject(new Error('child regression failed: ' + phase));
      else resolve();
    });
  });
}
app.whenReady().then(async () => {
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  if (stage === 'parent') {
    for (const phase of ['seed','read','wrong','recovered']) await child(phase);
    const report = { passed: true, electron: process.versions.electron, realNetworkRequests: 0, realCreationRequests: 0,
      testRoot: root, checks: ['same userData credentials decrypt in a different process',
        'same userData administrator session decrypts in a different process', 'different userData cannot decrypt either credential',
        'explicit recovery preserves original encrypted journal and unknown record', 'recovery creates durable revocation without browser fallback',
        'separate explicit login can save new fictional credential', 'new context credential survives process restart'] };
    fs.writeFileSync(path.resolve(__dirname, '../outputs/feishu-context-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); return;
  }
  const business = path.join(userData, 'feishu-business');
  if (stage === 'seed') {
    checkpoint = 'seed-feishu';
    const store = makeFeishuStore(business, safeStorage); assert.equal(store.load(), undefined); store.save(fixture);
    checkpoint = 'seed-auth';
    const auth = makeSessionStore(userData, safeStorage); auth.load(); auth.save(authRecord('old-context-fixture-token'));
    const policy = makeFeishuPolicyStore(business, safeStorage); policy.load(); policy.save(emptyPolicy());
  } else if (stage === 'read') {
    checkpoint = 'read-feishu';
    assert.deepEqual(makeFeishuStore(business, safeStorage).load(), fixture);
    checkpoint = 'read-auth';
    assert.equal(makeSessionStore(userData, safeStorage).load().token, 'old-context-fixture-token');
    assert.deepEqual(makeFeishuPolicyStore(business, safeStorage).load(), emptyPolicy());
  } else if (stage === 'wrong') {
    checkpoint = 'wrong-feishu';
    const other = path.join(root, 'context-a');
    assert.throws(() => makeFeishuStore(path.join(other, 'feishu-business'), safeStorage).load(), { code: 'STORAGE' });
    fs.copyFileSync(path.join(other, 'admin-session.journal'), path.join(userData, 'admin-session.journal'));
    fs.writeFileSync(path.join(userData, 'operations.journal'), 'unknown-fixture-keep');
    let browserReads = 0;
    checkpoint = 'wrong-auth-recovery';
    const auth = new AdminSession({ store: makeSessionStore(userData, safeStorage),
      readCandidate: async () => { browserReads++; return 'new-context-fixture-token'; },
      verify: async () => 1, flush: async () => {}, openLogin: async () => {} });
    assert.equal(auth.state().canRecover, true); auth.recover(true);
    await assert.rejects(auth.ensure(), { code: 'AUTH' }); assert.equal(browserReads, 0);
    assert.equal(makeSessionStore(userData, safeStorage).load(), null);
    const backups = fs.readdirSync(userData).filter(name => name.startsWith('admin-session.preserved-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(userData, backups[0])), fs.readFileSync(path.join(other, 'admin-session.journal')));
    checkpoint = 'wrong-auth-login';
    await auth.begin(); await auth.finish();
  } else if (stage === 'recovered') {
    assert.equal(makeSessionStore(userData, safeStorage).load().token, 'new-context-fixture-token');
    assert.equal(fs.readFileSync(path.join(userData, 'operations.journal'), 'utf8'), 'unknown-fixture-keep');
  } else throw new Error('unrecognized stage');
  console.log(JSON.stringify({ stage, passed: true }));
}).then(() => app.quit(), error => {
  console.error('SAFE_TEST:' + JSON.stringify({ stage, checkpoint, kind: error?.code === 'ERR_ASSERTION' ? 'assertion' : error?.code === 'STORAGE' ? 'storage' : 'runtime',
    location: String(error?.stack || '').split('\n').filter(line => /test-feishu-context-electron\.cjs:\d+/.test(line)).map(line => line.trim()) }));
  app.exit(1);
});
