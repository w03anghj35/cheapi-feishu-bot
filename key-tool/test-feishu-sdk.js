'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const Lark = require('@larksuiteoapi/node-sdk');
const { createClient } = require('./feishu-sdk');
const { FeishuConnection } = require('./feishu-connection');
const record = { appId: 'cli_1234567890abcdef', appSecret: 'fixture-only-not-real', savedAt: '2026-10-28T08:00:00Z' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cardClient() {
  const calls = []; let response = { code: 0, data: { message_id: 'om_fixture_card' } };
  const client = createClient({ ...record, handlers: {}, onDiagnostic() {} }, { ...Lark,
    WSClient: class { getConnectionStatus() { return { state: 'idle' }; } close() {} },
    Client: class { im = { message: { create: async input => { calls.push(input); return response; } } }; }
  });
  const card = { config: { enable_forward: false }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: '选择分组' } }] };
  return { client, calls, card, setResponse: value => { response = value; } };
}

test('SDK sends interactive JSON privately with UUID and authoritative message ID', async () => {
  const f = cardClient();
  const result = await f.client.sendCard({ receiveIdType: 'open_id', receiveId: 'ou_fixture_member', card: f.card });
  assert.deepEqual(result, { messageId: 'om_fixture_card' }); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params, { receive_id_type: 'open_id' });
  assert.equal(f.calls[0].data.receive_id, 'ou_fixture_member'); assert.equal(f.calls[0].data.msg_type, 'interactive');
  assert.deepEqual(JSON.parse(f.calls[0].data.content), f.card);
  assert.match(f.calls[0].data.uuid, /^[a-f0-9-]{36}$/);
});

test('SDK rejects group delivery, forwardable cards, oversized UTF8 and uncertain message IDs', async () => {
  const f = cardClient(), payload = { receiveIdType: 'open_id', receiveId: 'ou_fixture_member', card: f.card };
  await assert.rejects(f.client.sendCard({ ...payload, receiveIdType: 'chat_id' }));
  await assert.rejects(f.client.sendCard({ ...payload, card: { ...f.card, config: { enable_forward: true } } }));
  await assert.rejects(f.client.sendCard({ ...payload, card: { ...f.card, large: '汉'.repeat(10000) } }));
  assert.equal(f.calls.length, 0);
  for (const response of [{ code: 1, msg: 'fixture not disclosed' }, { code: 0, data: {} }, { code: 0, data: { message_id: 7 } }]) {
    f.setResponse(response); await assert.rejects(f.client.sendCard(payload), /card delivery failed/);
  }
});

test('real SDK v2 dispatcher passes operator/context/value to business card handler without transformation', async () => {
  let received;
  const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.error }).register({
    'card.action.trigger': event => { received = event; return { toast: { type: 'info', content: 'fixture accepted' } }; }
  });
  const event = { operator: { open_id: 'ou_fixture_member' }, context: { open_chat_id: 'oc_private_12345678', open_message_id: 'om_fixture_card' },
    action: { value: { keyTool: 'request-v1', action: 'confirm', requestId: 'fixture-id', nonce: 'fixture_nonce_12345678' } } };
  const response = await dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger', event_id: 'fixture-card-v2', app_id: record.appId }, event }, { needCheck: false });
  assert.deepEqual(received.operator, event.operator); assert.deepEqual(received.context, event.context);
  assert.deepEqual(received.action, event.action); assert.equal(response.toast.type, 'info');
});
async function until(check) { for (let i = 0; i < 150; i++) { if (check()) return; await sleep(20); } throw new Error('local SDK lifecycle timeout'); }
test('pinned real SDK connects and reconnects to loopback; dispatcher handles message and card', { timeout: 12000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  let pulls = 0, sockets = 0, dispatcher; const events = [];
  server.on('connection', () => { sockets++; });
  const httpInstance = { request: async input => {
    pulls++; assert.equal(input.method, 'post'); assert.equal(input.url, 'https://open.feishu.cn/callback/ws/endpoint');
    assert.deepEqual(input.data, { AppID: record.appId, AppSecret: record.appSecret });
    return { code: 0, data: { URL: `ws://127.0.0.1:${server.address().port}/?device_id=fixture&service_id=1`, ClientConfig: { PingInterval: 60, ReconnectCount: 2, ReconnectInterval: 0.01, ReconnectNonce: 0 } } };
  } };
  const sdk = { ...Lark,
    WSClient: class extends Lark.WSClient { constructor(options) { super({ ...options, httpInstance }); } },
    EventDispatcher: class extends Lark.EventDispatcher { constructor(options) { super(options); dispatcher = this; } }
  };
  const connection = new FeishuConnection({ store: { load: () => record }, createClient: options => createClient({ ...options,
    onReady: () => { events.push('ready'); options.onReady(); }, onReconnecting: () => { events.push('reconnecting'); options.onReconnecting(); },
    onReconnected: () => { events.push('reconnected'); options.onReconnected(); }
  }, sdk) });
  t.after(async () => { connection.disconnect(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  assert.equal(connection.connect().phase, 'connecting');
  await until(() => connection.state().phase === 'connected'); assert.equal(sockets, 1); assert.deepEqual(events, ['ready']);
  // Real EventDispatcher invocation with synthetic envelopes, not a claim of platform delivery.
  await dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: 'fixture-msg', app_id: record.appId }, event: { message: { content: 'synthetic only' } } }, { needCheck: false });
  const response = await dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger', event_id: 'fixture-card', app_id: record.appId }, event: { action: { value: { action: 'create' } } } }, { needCheck: false });
  assert.equal(connection.state().counts.messages, 1); assert.equal(connection.state().counts.callbacks, 1); assert.match(response.toast.content, /未执行任何创建/);
  for (const socket of server.clients) socket.terminate();
  await until(() => sockets === 2 && connection.state().phase === 'connected');
  assert.ok(events.includes('reconnecting')); assert.ok(events.includes('reconnected')); assert.equal(pulls, 2);
  connection.disconnect(); await sleep(120); assert.equal(connection.state().phase, 'disconnected'); assert.equal(pulls, 2);
});
test('real SDK terminal auth failure is sanitized and does not endlessly retry', { timeout: 5000 }, async t => {
  let pulls = 0;
  const sdk = { ...Lark, WSClient: class extends Lark.WSClient {
    constructor(options) { super({ ...options, httpInstance: { request: async () => { pulls++; return { code: 514, data: {}, msg: record.appSecret }; } } }); }
  } };
  const connection = new FeishuConnection({ store: { load: () => record }, createClient: options => createClient(options, sdk) });
  t.after(() => connection.disconnect()); connection.connect();
  await until(() => connection.state().phase === 'failed');
  assert.equal(pulls, 1); assert.equal(connection.state().active, false); assert.equal(JSON.stringify(connection.state()).includes(record.appSecret), false);
});
test('real SDK retryable internal error is bounded by the controller deadline', { timeout: 5000 }, async t => {
  let pulls = 0;
  const sdk = { ...Lark, WSClient: class extends Lark.WSClient {
    constructor(options) { super({ ...options, httpInstance: { request: async () => { pulls++; return { code: 1000040343, data: {}, msg: 'synthetic internal error' }; } } }); }
  } };
  const connection = new FeishuConnection({ store: { load: () => record }, timeoutMs: 120, createClient: options => createClient(options, sdk) });
  t.after(() => connection.disconnect()); connection.connect();
  await until(() => connection.state().phase === 'failed');
  assert.equal(connection.state().error.code, 'TIMEOUT'); assert.equal(connection.state().active, false);
  const count = pulls; await sleep(150); assert.equal(pulls, count);
});
