'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KeyService, ToolError } = require('./service');
const { makeFixture } = require('./test-fixture');
const { failureDiagnostic, failureHint, makeFailureLog } = require('./create-diagnostics');
const ID = '11111111-1111-4111-8111-111111111111';
const input = { requestId: ID, groupId: 7, quota: 5, operator: 'fixture operator' };
async function setup() {
  const fixture = makeFixture(), service = new KeyService(fixture), failures = [];
  await service.refresh(); await service.saveGroupNames({ owner: 1, items: [{ id: 7, name: 'fixture group' }] });
  service.onCreateFailure = row => failures.push(row);
  return { fixture, service, failures, posts: () => fixture.calls.filter(c => c.method === 'POST').length };
}
function temporary(t) {
  const parent = path.resolve(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'keytool-diagnostics-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), parent);
    assert.ok(path.basename(dir).startsWith('keytool-diagnostics-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
for (const [name, route, code, status] of [
  ['identity timeout','/auth/me','NETWORK',null], ['identity HTTP','/auth/me','HTTP',403],
  ['group rate limit','/groups/available','HTTP',429], ['group schema','/groups/available','SCHEMA',null]
]) {
  test(`pre-submit ${name} reports exact stage with zero POST and no pending record`, async () => {
    const f = await setup(), request = f.service.request;
    f.service.request = async (...args) => {
      if (args[1] === route) { const e = new ToolError(code, 'synthetic raw sensitive response'); e.httpStatus = status; throw e; }
      return request(...args);
    };
    await assert.rejects(f.service.create(input), e => e.createDiagnostic.code === code);
    assert.equal(f.failures.length, 1); assert.equal(f.posts(), 0); assert.equal(f.service.records.length, 0);
    assert.equal(f.failures[0].stage, route === '/auth/me' ? 'identity' : 'groups');
    assert.equal(f.failures[0].httpStatus, status); assert.match(failureHint(f.failures[0]), /未提交/);
    assert.equal(JSON.stringify(f.failures).includes('sensitive'), false);
  });
}
test('busy and invalid inputs are observable before network; diagnostics callback failure cannot change outcome', async () => {
  const f = await setup(); f.service.busy = true;
  await assert.rejects(f.service.create(input), e => e.createDiagnostic.stage === 'admission');
  f.service.busy = false;
  await assert.rejects(f.service.create({ ...input, quota: 0 }), e => e.createDiagnostic.stage === 'validation');
  assert.equal(f.posts(), 0);
  f.service.onCreateFailure = () => { throw new Error('diagnostic disk failure'); };
  await assert.rejects(f.service.create({ ...input, quota: 0 }), e => e.code === 'INPUT');
  await f.service.create(input); assert.equal(f.posts(), 1);
});
test('pending save failure is NOT_SENT; diagnostic log does not remove unknown protection', async () => {
  const f = await setup(); f.service.store.save = () => { throw new Error('disk'); };
  await assert.rejects(f.service.create(input), e => e.code === 'NOT_SENT');
  assert.equal(f.posts(), 0); assert.equal(f.service.blocked().length, 1);
  assert.equal(f.failures[0].stage, 'pending-storage');
  assert.match(failureHint(f.failures[0]), /不要重复创建/);
});
test('POST timeout remains UNKNOWN and replay is blocked; diagnostics never claim unsubmitted', async () => {
  const f = await setup(); f.fixture.setFail(true);
  await assert.rejects(f.service.create(input), e => e.code === 'UNKNOWN');
  assert.equal(f.posts(), 1); assert.equal(f.failures[0].stage, 'submission');
  assert.doesNotMatch(failureHint(f.failures[0]), /未提交/);
  await assert.rejects(f.service.create(input), e => e.code === 'UNKNOWN'); assert.equal(f.posts(), 1);
});
test('receipt encryption failure is recorded without secret; creation is not retried', async () => {
  const f = await setup(); f.service.store.seal = () => { throw new Error('sk-synthetic-secret'); };
  await assert.rejects(f.service.create(input), e => e.code === 'UNKNOWN');
  assert.equal(f.failures[0].stage, 'receipt-storage'); assert.equal(f.posts(), 1);
  assert.equal(JSON.stringify(f.failures).includes('sk-'), false);
});
test('diagnostic sanitization rejects raw error code, stage, identity, response and invalid HTTP status', () => {
  const row = failureDiagnostic('secret-request', { code: 'sk-secret', httpStatus: '403', message: 'secret', token: 'secret' }, 'secret-stage');
  assert.equal(row.requestId, null); assert.equal(row.code, 'OPERATION_ERROR'); assert.equal(row.stage, 'unknown');
  assert.equal(row.httpStatus, null); assert.equal(JSON.stringify(row).includes('secret'), false);
  assert.doesNotMatch(failureHint(row), /未提交/);
});
test('diagnostics persist independently across reopen, bounded to 20 displayed failures and no secret fields', t => {
  const dir = temporary(t), log = makeFailureLog(dir);
  for (let i = 0; i < 23; i++) assert.equal(log.append({ requestId: ID, code: 'HTTP', stage: 'identity', httpStatus: 403, token: 'sk-secret' }), true);
  const reopened = makeFailureLog(dir).state();
  assert.equal(reopened.items.length, 20); assert.equal(reopened.storageError, false);
  assert.equal(fs.readFileSync(path.join(dir, 'create-failures.jsonl'), 'utf8').includes('secret'), false);
  reopened.items[0].code = 'MUTATED'; assert.equal(log.state().items[0].code, 'HTTP');
  assert.deepEqual(fs.readdirSync(dir), ['create-failures.jsonl']);
});
test('truncated diagnostic file is preserved; memory fallback clearly marked and no overwrite', t => {
  const dir = temporary(t), file = path.join(dir, 'create-failures.jsonl'); fs.writeFileSync(file, '{');
  const log = makeFailureLog(dir); assert.equal(log.append({ code: 'BUSY', stage: 'admission' }), false);
  assert.equal(log.state().storageError, true); assert.equal(log.state().items.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});
for (const fault of ['writeSync','fsyncSync','closeSync']) {
  test(`diagnostic ${fault} error retains memory fallback and prevents further append`, t => {
    const dir = temporary(t), io = Object.create(fs);
    io[fault] = (...args) => { if (fault === 'closeSync') fs.closeSync(...args); throw new Error('fault'); };
    const log = makeFailureLog(dir, io);
    assert.equal(log.append({ code: 'HTTP', stage: 'groups' }), false);
    assert.equal(log.state().storageError, true); assert.equal(log.state().items.length, 1);
    const before = fs.readFileSync(path.join(dir, 'create-failures.jsonl'));
    assert.equal(log.append({ code: 'HTTP', stage: 'groups' }), false);
    assert.equal(fs.readFileSync(path.join(dir, 'create-failures.jsonl')).equals(before), true);
  });
}
test('diagnostic file size cap never truncates old data', t => {
  const dir = temporary(t), file = path.join(dir, 'create-failures.jsonl'); fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
  const log = makeFailureLog(dir); assert.equal(log.state().storageError, true);
  assert.equal(log.append({ code: 'BUSY', stage: 'admission' }), false);
  assert.equal(fs.statSync(file).size, 1024 * 1024 + 1);
});
