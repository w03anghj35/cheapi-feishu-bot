'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CHANNELS } = require('./channel-monitor');
const { THRESHOLD, validate, makeAlertStore, createMailer, ChannelAlert } = require('./channel-alert');

const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: value => Buffer.from(value).reverse(),
  decryptString: value => Buffer.from(value).reverse().toString('utf8')
};
const input = { from: 'sender@qq.com', authCode: 'fixture-only-authorization',
  recipients: 'alice@example.invalid\nbob@example.invalid' };
function fixture(t, send, now = () => Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-alert-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = () => new ChannelAlert({ store: makeAlertStore(dir, safeStorage, fs, now), send, now });
  return { dir, make, alert: make() };
}
function reading(value, status = 'ok') {
  return { status, value, display: String(value), checkedAt: '2026-11-04T00:00:00.000Z' };
}
test('validates QQ sender, secret and one to ten distinct recipients', () => {
  assert.equal(THRESHOLD, 2000);
  assert.deepEqual(validate(input).recipients, ['alice@example.invalid', 'bob@example.invalid']);
  for (const bad of [
    { ...input, from: 'sender@example.com' }, { ...input, authCode: 'x\nBcc:bad' },
    { ...input, recipients: 'alice@example.invalid;alice@example.invalid' },
    { ...input, recipients: Array.from({ length: 11 }, (_, i) => `a${i}@example.invalid`).join(',') },
    { ...input, recipients: 'broken-address' }
  ]) assert.throws(() => validate(bad), { code: 'INPUT' });
});
test('custom threshold and Beijing daily time are strict; old settings remain disabled by default', t => {
  assert.deepEqual([validate(input).threshold, validate(input).dailyTime], [2000, null]);
  assert.deepEqual([validate({ ...input, threshold: '345.2500', dailyTime: '09:30' }).threshold,
    validate({ ...input, threshold: '345.2500', dailyTime: '09:30' }).dailyTime], [345.25, '09:30']);
  for (const value of ['0', '-1', '1e3', '0.00001', '1000000000001', 'abc'])
    assert.throws(() => validate({ ...input, threshold: value }), { code: 'INPUT' });
  for (const value of ['24:00', '9:30', '09:60', '09:30:00'])
    assert.throws(() => validate({ ...input, dailyTime: value }), { code: 'INPUT' });
  const f = fixture(t, async () => {});
  f.alert.configure(input);
  assert.equal(f.alert.state().threshold, 2000);
  assert.equal(f.alert.state().dailyTime, null);
  f.alert.configure({ ...input, authCode: '', threshold: '345.25', dailyTime: '09:30' });
  assert.equal(f.alert.state().threshold, 345.25);
  assert.equal(f.alert.state().dailyTime, '09:30');
  assert.equal(f.make().state().dailyTime, '09:30');
});
test('threshold changes rearm confirmed low intervals but preserve uncertain attempts', async t => {
  const sent = [], f = fixture(t, async mail => sent.push(mail));
  f.alert.configure({ ...input, recipients: 'alice@example.invalid', threshold: 100 });
  await f.alert.observed(CHANNELS[0], reading(90));
  assert.equal(sent.length, 1);
  f.alert.configure({ ...input, recipients: 'alice@example.invalid', authCode: '', threshold: 500 });
  await f.alert.observed(CHANNELS[0], reading(400));
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /低于 500/);
  await f.alert.observed(CHANNELS[0], reading(500));
  assert.equal(sent.length, 2);
});
test('daily summary sends each recipient once with five sites, including missing or stale status', async t => {
  const sent = [];
  let now = Date.parse('2026-11-06T01:29:00Z');
  const daily = fixture(t, async mail => sent.push(mail), () => now);
  daily.alert.configure({ ...input, threshold: 500, dailyTime: '09:30' });
  const rows = CHANNELS.map((channel, index) => ({ ...reading(3000 + index), id: channel.id,
    checkedAt: new Date(now).toISOString(), name: `虚构站${index}` }));
  rows[1].status = 'failed'; rows[1].display = 'stale-secret-value';
  rows[2].checkedAt = new Date(now - 2 * 60 * 60_000).toISOString();
  assert.deepEqual(await daily.alert.dailyTick(rows), { skipped: 'not-due' });
  now = Date.parse('2026-11-06T01:30:00Z');
  const result = await daily.alert.dailyTick(rows);
  assert.deepEqual(result, { accepted: 2, uncertain: 0, skipped: 0 });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(mail => mail.to), ['alice@example.invalid', 'bob@example.invalid']);
  for (const mail of sent) {
    assert.match(mail.subject, /每日余额/);
    assert.match(mail.text, /低余额阈值：500/);
    assert.equal(mail.text.includes('stale-secret-value'), false);
    assert.equal((mail.text.match(/本次未取得有效金额/g) || []).length, 2);
    for (const channel of CHANNELS) assert.ok(mail.text.includes(channel.origin + channel.path));
  }
  assert.deepEqual(await daily.alert.dailyTick(rows), { accepted: 0, uncertain: 0, skipped: 2 });
  assert.deepEqual(await daily.make().dailyTick(rows), { accepted: 0, uncertain: 0, skipped: 2 });
  assert.equal(sent.length, 2);
});
test('daily schedule uses Beijing day, does not catch up after grace, and new time does not send retroactively', async t => {
  let now = Date.parse('2026-11-06T15:49:00Z');
  const sent = [], f = fixture(t, async mail => sent.push(mail), () => now);
  f.alert.configure({ ...input, dailyTime: '23:50' });
  const rows = CHANNELS.map(channel => ({ ...reading(2500), id: channel.id, checkedAt: new Date(now).toISOString() }));
  now = Date.parse('2026-11-06T15:50:00Z');
  assert.equal((await f.alert.dailyTick(rows)).accepted, 2);
  now = Date.parse('2026-11-06T16:01:00Z');
  assert.deepEqual(await f.alert.dailyTick(rows), { skipped: 'not-due' });
  now = Date.parse('2026-11-07T15:49:00Z');
  assert.deepEqual(await f.alert.dailyTick(rows), { skipped: 'not-due' });
  now = Date.parse('2026-11-07T16:06:00Z');
  assert.deepEqual(await f.alert.dailyTick(rows), { skipped: 'not-due' });
  assert.equal(sent.length, 2);
  now = Date.parse('2026-11-08T15:50:00Z');
  assert.equal((await f.alert.dailyTick(rows)).accepted, 2);
  assert.equal(sent.length, 4);
  assert.ok(sent.slice(2).every(mail => mail.text.includes('本次未取得有效金额')));
  f.alert.configure({ ...input, authCode: '', dailyTime: '00:00' });
  assert.deepEqual(await f.alert.dailyTick(rows), { skipped: 'not-due' });
});
test('ambiguous daily SMTP outcome is persisted and not resent after restart or repeated tick', async t => {
  let now = Date.parse('2026-11-06T00:59:00Z');
  let attempts = 0;
  const f = fixture(t, async () => { attempts++; throw Error('synthetic SMTP timeout'); }, () => now);
  f.alert.configure({ ...input, recipients: 'alice@example.invalid', dailyTime: '09:00' });
  now = Date.parse('2026-11-06T01:00:00Z');
  const rows = CHANNELS.map(channel => ({ ...reading(2500), id: channel.id, checkedAt: new Date(now).toISOString() }));
  assert.deepEqual(await f.alert.dailyTick(rows), { accepted: 0, uncertain: 1, skipped: 0 });
  assert.equal(attempts, 1);
  assert.equal(f.alert.state().dailyAttention.length, 1);
  assert.deepEqual(await f.make().dailyTick(rows), { accepted: 0, uncertain: 0, skipped: 1 });
  assert.equal(attempts, 1);
  f.alert.pause();
  assert.deepEqual(await f.alert.dailyTick(rows), { skipped: 'disabled' });
});
test('legacy encrypted alert journal loads with 2000 threshold and no daily schedule', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-alert-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = { config: { from: input.from, authCode: input.authCode,
    recipients: ['alice@example.invalid'], enabled: true }, deliveries: {} };
  const sealed = safeStorage.encryptString(JSON.stringify(old)).toString('base64');
  const payload = JSON.stringify({ sequence: 1, sealed });
  const checksum = createHash('sha256').update(payload).digest('hex');
  fs.writeFileSync(path.join(dir, 'channel-alert.journal'), JSON.stringify({ payload, checksum }) + '\n');
  const store = makeAlertStore(dir, safeStorage);
  const state = store.load();
  assert.equal(state.enabled, true);
  assert.equal(state.threshold, 2000);
  assert.equal(state.dailyTime, null);
  assert.deepEqual(state.dailyAttention, []);
  assert.equal(store.config().authCode, input.authCode);
});
test('SMTP adapter uses authenticated 465/TLS and a single visible recipient', async () => {
  let settings, payload, closed = false;
  const send = createMailer({ createTransport(options) {
    settings = options;
    return { async sendMail(mail) { payload = mail; return { accepted: [mail.to] }; }, close() { closed = true; } };
  } });
  await send({ from: input.from, authCode: input.authCode, to: 'alice@example.invalid',
    subject: 'fixture', text: 'fictional notice' });
  assert.equal(settings.host, 'smtp.qq.com');
  assert.equal(settings.port, 465);
  assert.equal(settings.secure, true);
  assert.equal(settings.tls.rejectUnauthorized, true);
  assert.deepEqual(settings.auth, { user: input.from, pass: input.authCode });
  assert.equal(payload.to, 'alice@example.invalid');
  assert.equal(Object.hasOwn(payload, 'bcc'), false);
  assert.equal(closed, true);
});
test('SMTP adapter refuses a resolved response without recipient acceptance', async () => {
  const send = createMailer({ createTransport() {
    return { async sendMail() { return { accepted: [], rejected: ['alice@example.invalid'] }; }, close() {} };
  } });
  await assert.rejects(send({ from: input.from, authCode: input.authCode, to: 'alice@example.invalid',
    subject: 'fixture', text: 'fictional notice' }));
});
test('test mail lists exact URLs and valid amounts without changing alert delivery state', async t => {
  const sent = [], f = fixture(t, async mail => sent.push(mail));
  f.alert.configure(input);
  const rows = CHANNELS.map((channel, index) => ({ ...reading(1000 + index), id: channel.id,
    name: `虚构渠道${index + 1}` }));
  rows[0].status = 'failed'; rows[0].display = 'stale-123';
  const result = await f.alert.sendTest(rows, 'all');
  assert.deepEqual({ ...result, message: undefined }, { requested: 2, accepted: 2,
    uncertain: 0, skipped: 0, message: undefined });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(mail => mail.to), ['alice@example.invalid', 'bob@example.invalid']);
  for (const mail of sent) {
    assert.match(mail.subject, /测试/);
    assert.match(mail.text, /不表示余额已低于 2000/);
    assert.equal(mail.text.includes('stale-123'), false);
    for (const channel of CHANNELS) assert.ok(mail.text.includes(channel.origin + channel.path));
    assert.match(mail.text, /虚构渠道2.*1001/);
    assert.match(mail.text, /本次未取得有效金额/);
  }
  assert.deepEqual(f.alert.state().attention, []);
  await f.alert.observed(CHANNELS[1], reading(1001));
  assert.equal(sent.length, 4);
  assert.ok(sent[2].text.includes(CHANNELS[1].origin + CHANNELS[1].path));
});
test('test mail can target first recipient and refuses no valid balance or wrong scope', async t => {
  const sent = [], f = fixture(t, async mail => sent.push(mail));
  const rows = CHANNELS.map(channel => ({ ...reading(2500), id: channel.id }));
  await assert.rejects(f.alert.sendTest(rows, 'first'), { code: 'CONFIG' });
  f.alert.configure(input);
  assert.throws(() => f.alert.sendTest(rows, 'other'), { code: 'INPUT' });
  assert.throws(() => f.alert.sendTest(rows.map(row => ({ ...row, status: 'failed' }))), { code: 'INPUT' });
  const result = await f.alert.sendTest(rows, 'first');
  assert.equal(result.requested, 1);
  assert.equal(result.accepted, 1);
  assert.deepEqual(sent.map(mail => mail.to), ['alice@example.invalid']);
});
test('ambiguous test SMTP response is reported but never retried automatically', async t => {
  let count = 0;
  const f = fixture(t, async () => { count++; throw new Error('synthetic ambiguous send'); });
  f.alert.configure({ ...input, recipients: 'alice@example.invalid' });
  const rows = CHANNELS.map(channel => ({ ...reading(50), id: channel.id }));
  const result = await f.alert.sendTest(rows);
  assert.equal(result.accepted, 0);
  assert.equal(result.uncertain, 1);
  assert.equal(count, 1);
  assert.equal(f.alert.state().attention.length, 0);
});
test('test send is single-flight and halts later recipients after pause', async t => {
  let started, release;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [], f = fixture(t, async mail => { sent.push(mail.to); started(); await gate; });
  f.alert.configure(input);
  const rows = CHANNELS.map(channel => ({ ...reading(40), id: channel.id }));
  const pending = f.alert.sendTest(rows);
  await began;
  assert.throws(() => f.alert.sendTest(rows), { code: 'BUSY' });
  f.alert.pause(); release();
  const result = await pending;
  assert.equal(result.accepted, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(sent, ['alice@example.invalid']);
});
test('all five channels alert separately below threshold, not on failures or stale values', async t => {
  const sent = [], f = fixture(t, async mail => sent.push(mail));
  f.alert.configure(input);
  for (const channel of CHANNELS) await f.alert.observed(channel, reading(1999.99));
  assert.equal(sent.length, 10);
  assert.deepEqual(new Set(sent.map(mail => mail.to)), new Set(['alice@example.invalid', 'bob@example.invalid']));
  assert.ok(sent.every(mail => !mail.to.includes(',') && mail.subject.includes('【低余额】') &&
    mail.text.includes('低于 2000') && mail.text.includes(CHANNELS.find(channel => mail.text.includes(channel.origin))?.path)));
  for (const channel of CHANNELS) {
    await f.alert.observed(channel, reading(1));
    await f.alert.observed(channel, reading(1, 'failed'));
    await f.alert.observed(channel, { ...reading(1), value: NaN });
  }
  assert.equal(sent.length, 10);
  await f.alert.observed(CHANNELS[0], reading(2000));
  await f.alert.observed(CHANNELS[0], reading(1999));
  assert.equal(sent.length, 12);
  assert.equal(fs.readFileSync(path.join(f.dir, 'channel-alert.journal'), 'utf8').includes(input.authCode), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'channel-alert.journal'), 'utf8').includes(input.recipients.split('\n')[0]), false);
});
test('queued observations for different channels are not lost during slow SMTP', async t => {
  const sent = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async mail => { sent.push(mail.to); if (sent.length === 1) await gate; });
  f.alert.configure({ ...input, recipients: 'alice@example.invalid' });
  const first = f.alert.observed(CHANNELS[0], reading(1));
  const second = f.alert.observed(CHANNELS[1], reading(2));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['alice@example.invalid']);
  release(); await Promise.all([first, second]);
  assert.equal(sent.length, 2);
});
test('clearing while SMTP is in flight does not recreate the removed encrypted file', async t => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async () => { began(); await gate; });
  f.alert.configure({ ...input, recipients: 'alice@example.invalid' });
  const pending = f.alert.observed(CHANNELS[0], reading(1));
  await started;
  f.alert.clear(); release(); await pending;
  assert.equal(fs.existsSync(path.join(f.dir, 'channel-alert.journal')), false);
  assert.equal(f.alert.state().configured, false);
});
test('attempting survives SMTP ambiguity and restart; no automatic retry', async t => {
  let count = 0;
  const f = fixture(t, async () => { count++; throw new Error('SMTP result unknown'); });
  f.alert.configure({ ...input, recipients: 'alice@example.invalid' });
  await f.alert.observed(CHANNELS[0], reading(1));
  assert.equal(count, 1);
  assert.deepEqual(f.alert.state().attention, [{ id: CHANNELS[0].id, email: 'alice@example.invalid' }]);
  const reopened = f.make();
  await reopened.observed(CHANNELS[0], reading(1));
  assert.equal(count, 1);
  await reopened.observed(CHANNELS[0], reading(2000));
  assert.equal(reopened.state().attention.length, 1);
});
test('pause, clear, fresh recipients and storage corruption fail closed', async t => {
  const sent = [], f = fixture(t, async mail => sent.push(mail.to));
  f.alert.configure({ ...input, recipients: 'alice@example.invalid' });
  await f.alert.observed(CHANNELS[0], reading(1));
  f.alert.pause(); await f.alert.observed(CHANNELS[1], reading(1));
  assert.equal(sent.length, 1);
  f.alert.configure({ ...input, recipients: 'alice@example.invalid,bob@example.invalid' });
  await f.alert.observed(CHANNELS[0], reading(1));
  assert.deepEqual(sent, ['alice@example.invalid', 'bob@example.invalid']);
  f.alert.clear();
  assert.equal(fs.existsSync(path.join(f.dir, 'channel-alert.journal')), false);
  assert.equal(f.make().state().configured, false);
  f.alert.configure(input);
  fs.appendFileSync(path.join(f.dir, 'channel-alert.journal'), 'corrupt');
  assert.throws(() => f.make(), { code: 'STORAGE' });
  const noEncryption = makeAlertStore(f.dir, { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' });
  assert.throws(() => noEncryption.load(), { code: 'STORAGE' });
});
