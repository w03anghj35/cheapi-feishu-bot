'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CHANNELS } = require('./channel-monitor');
const { makeChannelFactorStore, normalizeRate } = require('./channel-factor-store');

function isolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapi-factor-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('all five channels start without an implicit conversion factor', t => {
  const store = makeChannelFactorStore(isolated(t));
  const state = store.load();
  assert.deepEqual(state.factors.map(row => row.id), CHANNELS.map(row => row.id));
  assert.ok(state.factors.every(row => row.rate === null && row.updatedAt === null));
  assert.equal(state.storageError, false);
});

test('one saved factor does not modify another channel, survives reopen with canonical decimals', t => {
  const dir = isolated(t);
  const first = makeChannelFactorStore(dir, fs, () => Date.parse('2026-11-12T03:00:00Z'));
  first.load();
  const one = first.save({ id: 'points-ip', rate: '1.6000' });
  assert.equal(one.factors[0].rate, '1.6');
  assert.equal(one.factors[1].rate, null);
  const two = first.save({ id: 'spent-ccrouter', rate: '0.00000001' });
  assert.equal(two.factors[0].rate, '1.6');
  assert.equal(two.factors[2].rate, '0.00000001');
  const reopened = makeChannelFactorStore(dir);
  assert.deepEqual(reopened.load(), two);
  const journal = fs.readFileSync(path.join(dir, 'channel-monitor-factors.journal'), 'utf8');
  assert.equal(journal.split('\n').filter(Boolean).length, 2);
  assert.ok(!journal.includes('password') && !journal.includes('cookie'));
});

test('factor range and exact input shape reject zero, negative, exponent, extra fields and unknown channels', t => {
  for (const value of ['', '0', '0.00000000', '-1', '1e3', '01.2', '1.123456789',
    '1000000.00000001', '1000001', 'NaN', 'Infinity', '1,6', 1.6, null])
    assert.throws(() => normalizeRate(value), error => error.code === 'INPUT');
  assert.equal(normalizeRate('1000000.00000000'), '1000000');
  assert.equal(normalizeRate('0.00000001'), '0.00000001');
  const store = makeChannelFactorStore(isolated(t)); store.load();
  for (const input of [{ id: 'unknown', rate: '1.6' },
    { id: 'points-ip', rate: '1.6', injected: 'x' },
    { id: 'points-ip' }, null])
    assert.throws(() => store.save(input), error => error.code === 'INPUT');
  assert.ok(store.state().factors.every(row => row.rate === null));
});

test('truncated, changed or forged factor journal fails closed without replacing original bytes', t => {
  const dir = isolated(t), file = path.join(dir, 'channel-monitor-factors.journal');
  const store = makeChannelFactorStore(dir); store.load(); store.save({ id: 'points-ip', rate: '1.6' });
  const original = fs.readFileSync(file);
  fs.appendFileSync(file, 'truncated');
  const damaged = fs.readFileSync(file);
  assert.throws(() => store.state(), error => error.code === 'STORAGE');
  assert.throws(() => store.save({ id: 'points-ip', rate: '2' }), error => error.code === 'STORAGE');
  assert.throws(() => makeChannelFactorStore(dir).load(), error => error.code === 'STORAGE');
  assert.deepEqual(fs.readFileSync(file), damaged);
  assert.ok(damaged.length > original.length);
});

test('checksum, sequence and snapshot validation catch semantic corruption', t => {
  for (const mutation of [
    text => text.replace('"sequence\\":1', '"sequence\\":3'),
    text => text.replace('"rate\\":\\"1.6\\"', '"rate\\":\\"0\\"'),
    text => text.replace('"checksum":"', '"checksum":"a'),
  ]) {
    const dir = isolated(t), file = path.join(dir, 'channel-monitor-factors.journal');
    const store = makeChannelFactorStore(dir); store.load(); store.save({ id: 'points-ip', rate: '1.6' });
    const source = fs.readFileSync(file, 'utf8');
    const changed = mutation(source);
    assert.notEqual(changed, source);
    fs.writeFileSync(file, changed);
    assert.throws(() => makeChannelFactorStore(dir).load(), error => error.code === 'STORAGE');
  }
});

test('write failure leaves state unavailable rather than reporting a saved factor', t => {
  const dir = isolated(t);
  const fakeIo = { ...fs, writeSync: () => { throw Error('fixture write failure'); } };
  const store = makeChannelFactorStore(dir, fakeIo); store.load();
  assert.throws(() => store.save({ id: 'points-ip', rate: '1.6' }), error => error.code === 'STORAGE');
  assert.throws(() => store.state(), error => error.code === 'STORAGE');
});
