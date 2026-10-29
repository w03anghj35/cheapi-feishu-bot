'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FeishuConnection } = require('./feishu-connection');
const { registerConnectionIPC } = require('./feishu-ipc');
const record = { appId: 'cli_1234567890abcdef', appSecret: 'fixture-only-secret', savedAt: '2026-10-28T08:00:00.000Z' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(initial = record, options = {}) {
  let saved = initial; const clients = []; const pending = new Map(); let timerId = 0;
  const timers = { setTimeout(fn) { pending.set(++timerId, fn); return timerId; }, clearTimeout(id) { pending.delete(id); } };
  const store = { load: () => saved, save: value => { saved = value; } };
  const createClient = options => {
    const client = { options, status: 'connecting', starts: 0, closes: 0,
      start() { this.starts++; }, close() { this.closes++; this.status = 'idle'; },
      getConnectionStatus() { return { state: this.status, reconnectAttempts: 0 }; }
    }; clients.push(client); return client;
  };
  const connection = new FeishuConnection({ store, createClient, timers, ...options });
  return { connection, clients, store, pending, saved: () => saved };
}

test('business card callbacks route synchronously; diagnostic mode and stale connections never route', () => {
  let calls = 0;
  const handlers = { card: () => { calls++; return { toast: { type: 'info', content: 'fixture accepted' } }; } };
  const f = fixture(record, { mode: 'feishu-key-workflow', handlers });
  f.connection.connect(); const old = f.clients[0]; old.status = 'connected'; old.options.onReady();
  const response = old.options.handlers['card.action.trigger']({ fixture: true });
  assert.equal(typeof response.then, 'undefined'); assert.equal(response.toast.type, 'info'); assert.equal(calls, 1);
  f.connection.disconnect(); f.connection.connect();
  assert.equal(old.options.handlers['card.action.trigger']({}).toast.type, 'warning'); assert.equal(calls, 1);
  const diagnostic = fixture(record, { handlers }); diagnostic.connection.connect();
  assert.equal(diagnostic.clients[0].options.handlers['card.action.trigger']({}).toast.type, 'warning');
  assert.equal(calls, 1); f.connection.disconnect(); diagnostic.connection.disconnect();
});

test('business callback exception becomes a sanitized toast, not raw payload/credentials', () => {
  const f = fixture(record, { mode: 'feishu-key-workflow', handlers: { card() { throw new Error(record.appSecret); } } });
  f.connection.connect(); const response = f.clients[0].options.handlers['card.action.trigger']({});
  assert.equal(response.toast.type, 'error'); assert.equal(JSON.stringify(response).includes(record.appSecret), false);
  assert.equal(f.connection.state().counts.diagnostics, 1); f.connection.disconnect();
});
test('opening stored credentials never auto-connects or returns the secret', () => {
  const f = fixture(); assert.equal(f.connection.state().phase, 'disconnected'); assert.equal(f.clients.length, 0);
  assert.equal(JSON.stringify(f.connection.state()).includes(record.appSecret), false);
});
test('empty config blocks connection; save validation can recover without restart', () => {
  const f = fixture(null);
  assert.throws(() => f.connection.connect(), e => e.code === 'CONFIG');
  assert.throws(() => f.connection.save({}), e => e.code === 'INPUT');
  assert.equal(f.connection.save(record).phase, 'disconnected'); assert.equal(f.clients.length, 0);
});
test('save failure locks connection and never uses old or unsaved credentials', () => {
  const f = fixture(); f.store.save = () => { throw new Error(record.appSecret); };
  assert.throws(() => f.connection.save({ ...record, appSecret: 'new' }), e => !e.message.includes(record.appSecret));
  assert.equal(f.connection.state().hasCredential, false); assert.throws(() => f.connection.connect(), e => e.code === 'STORAGE');
  assert.equal(f.clients.length, 0);
});
test('start resolution is not online; double click makes one client', async () => {
  const f = fixture(); f.connection.connect(); f.connection.connect(); await flush();
  assert.equal(f.clients.length, 1); assert.equal(f.clients[0].starts, 1); assert.equal(f.connection.state().phase, 'connecting');
  f.clients[0].status = 'connected'; f.clients[0].options.onReady(); assert.equal(f.connection.state().phase, 'connected'); assert.equal(f.pending.size, 0);
});
test('SDK reconnect callback preceding state update is reconciled on the next read', () => {
  const f = fixture(); f.connection.connect(); const c = f.clients[0]; c.status = 'connected'; c.options.onReady();
  c.status = 'reconnecting'; c.options.onReconnecting(); c.options.onReconnected(); assert.equal(f.connection.state().phase, 'reconnecting');
  c.status = 'connected'; assert.equal(f.connection.state().phase, 'connected'); assert.equal(f.pending.size, 0);
});
test('lost transport is not shown online even without a reconnect callback', () => {
  const f = fixture(); f.connection.connect(); const c = f.clients[0]; c.status = 'connected'; c.options.onReady();
  c.status = 'idle'; assert.equal(f.connection.state().phase, 'reconnecting'); assert.equal(f.pending.size, 1);
});
test('bounded timeout closes once and requires an explicit retry', async () => {
  const f = fixture(); f.connection.connect(); await flush(); [...f.pending.values()][0]();
  assert.equal(f.connection.state().phase, 'failed'); assert.equal(f.clients[0].closes, 1); assert.equal(f.pending.size, 0);
  f.connection.connect(); await flush(); assert.equal(f.clients.length, 2);
});
test('disconnect before deferred start prevents any start or automatic reconnection', async () => {
  const f = fixture(); f.connection.connect(); const c = f.clients[0]; f.connection.disconnect(); await flush();
  assert.equal(c.starts, 0); assert.equal(f.pending.size, 0); c.status = 'connected'; c.options.onReady(); c.options.onReconnecting();
  assert.equal(f.connection.state().phase, 'disconnected'); assert.equal(f.pending.size, 0);
});
test('late callbacks and old events cannot mutate the new session', async () => {
  const f = fixture(); f.connection.connect(); await flush(); const old = f.clients[0]; f.connection.disconnect(); f.connection.connect();
  const current = f.clients[1]; current.status = 'connected'; current.options.onReady();
  old.options.onError(new Error(record.appSecret)); old.options.onReconnecting(); old.options.handlers['im.message.receive_v1']({ secret: record.appSecret });
  assert.equal(f.connection.state().phase, 'connected'); assert.equal(f.connection.state().counts.messages, 0);
});
test('handlers count deliveries, ignore bodies and only return a no-creation card toast', () => {
  const f = fixture(); f.connection.connect(); const c = f.clients[0];
  for (let i = 0; i < 2; i++) c.options.handlers['im.message.receive_v1']({ message: { content: record.appSecret } });
  const result = c.options.handlers['card.action.trigger']({ action: { value: 'create-token' } });
  assert.equal(f.connection.state().counts.messages, 2); assert.equal(f.connection.state().counts.callbacks, 1);
  assert.match(result.toast.content, /未执行任何创建/); assert.equal(JSON.stringify(f.connection.state()).includes(record.appSecret), false);
});
test('terminal SDK errors are sanitized, close connection and allow manual recovery', () => {
  const f = fixture(); f.connection.connect(); f.clients[0].options.onError(new Error(record.appSecret));
  assert.equal(f.connection.state().phase, 'failed'); assert.equal(f.connection.state().active, false);
  assert.equal(JSON.stringify(f.connection.state()).includes(record.appSecret), false); f.connection.connect(); assert.equal(f.clients.length, 2);
});
test('stop failure blocks a new client and ignores stale ready notifications', () => {
  const f = fixture(); f.connection.connect(); const c = f.clients[0]; c.close = () => { throw new Error('close failed'); };
  f.connection.disconnect(); c.status = 'connected'; c.options.onReady(); assert.equal(f.connection.state().phase, 'stop-error');
  assert.throws(() => f.connection.connect(), e => e.code === 'STOP'); assert.equal(f.clients.length, 1);
});
test('editing credentials while active is refused', () => {
  const f = fixture(); f.connection.connect(); assert.throws(() => f.connection.save(record), e => e.code === 'BUSY');
});
test('storage load error disables the bridge without fallback', () => {
  let calls = 0; const connection = new FeishuConnection({ store: { load() { throw new Error('private'); } }, createClient() { calls++; } });
  assert.equal(connection.state().phase, 'storage-error'); assert.throws(() => connection.connect()); assert.equal(calls, 0);
});
test('all IPC handlers reject other windows, child frames and different URLs', () => {
  const f = fixture(); const handlers = new Map(); const url = 'file:///fixture/feishu.html';
  const mainFrame = { url }; const window = { isDestroyed: () => false, webContents: { mainFrame } };
  registerConnectionIPC({ handle: (name, fn) => handlers.set(name, fn) }, () => window, url, f.connection);
  for (const handle of handlers.values()) {
    assert.equal(handle({ sender: {}, senderFrame: mainFrame }, record).code, 'DENIED');
    assert.equal(handle({ sender: window.webContents, senderFrame: { url } }, record).code, 'DENIED');
    mainFrame.url = 'file:///fixture/other.html';
    assert.equal(handle({ sender: window.webContents, senderFrame: mainFrame }, record).code, 'DENIED'); mainFrame.url = url;
  }
  assert.equal(handlers.get('feishu-connection:state')({ sender: window.webContents, senderFrame: mainFrame }).ok, true);
});
