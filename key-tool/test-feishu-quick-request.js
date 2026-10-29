'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FeishuBotWorkflow } = require('./feishu-bot-workflow');
const { requestCard } = require('./feishu-request-cards');
const { makeFixture } = require('./test-fixture');
const { KeyService } = require('./service');
const USER = 'ou_member_12345678', GROUP = 'oc_group_12345678', DM = 'oc_private_12345678';

async function setup() {
  let now = Date.now(), sequence = 0, failCard = false, failDM = false, phase = 'connected';
  let policy = { enabled: true, ownerOpenId: 'ou_owner_12345678', groupId: GROUP, platformOwnerId: 1,
    maxQuota: 20, maxUserDailyQuota: null, maxGroupDailyQuota: null };
  const fixture = makeFixture(), service = new KeyService(fixture), texts = [], cards = [];
  await service.refresh(); await service.saveGroupNames({ owner: 1, items: [{ id: 7, name: '客户分组' }] });
  const workflow = new FeishuBotWorkflow({ service, getPolicy: () => policy, now: () => now,
    connection: { state: () => ({ phase }) }, random: () => `fixture_nonce_${String(++sequence).padStart(16, '0')}`,
    sendText: async payload => { if (failDM && payload.receiveIdType === 'open_id') throw new Error('synthetic private denial'); texts.push(payload); },
    sendCard: async payload => { if (failCard || failDM) throw new Error('synthetic card denial');
      const messageId = `om_card_${++sequence}`; cards.push({ ...payload, messageId }); return { messageId }; }
  });
  const message = (text, extra = {}) => ({ header: { event_id: `event-${++sequence}` },
    sender: { sender_type: 'user', sender_id: { open_id: USER } },
    message: { message_id: `om_text_${sequence}`, chat_id: DM, chat_type: 'p2p', message_type: 'text',
      create_time: String(now), content: JSON.stringify({ text }), mentions: [], ...extra } });
  const dm = (text, extra) => workflow.handle(message(text, extra));
  const start = (text = '发送令牌', extra = {}) => workflow.handle(message(`@bot ${text}`,
    { chat_id: GROUP, chat_type: 'group', mentions: [{ key: '@bot' }], ...extra }));
  const callback = (action, extra = {}, card = cards.at(-1)) => {
    const button = card.card.elements.flatMap(row => row.actions || []).find(b => b.value.action === action);
    assert.ok(button, `missing button: ${action}`);
    return { operator: { open_id: USER }, context: { open_chat_id: DM, open_message_id: card.messageId },
      action: { value: { ...button.value, ...extra } } };
  };
  const click = async (action, extra) => { const result = workflow.handleCard(callback(action, extra)); await workflow.tail; return result; };
  const posts = () => fixture.calls.filter(c => c.method === 'POST').length;
  return { fixture, service, workflow, texts, cards, dm, start, callback, click, posts, message,
    setPolicy: change => { policy = { ...policy, ...change }; }, setPhase: value => { phase = value; },
    advance: ms => { now += ms; }, failCard: value => { failCard = value; }, failDM: value => { failDM = value; } };
}

test('quick flow: sender-bound DM buttons, quota and explicit confirmation; no challenge and only one POST/key delivery', async () => {
  const f = await setup();
  assert.equal((await f.start()).status, 'quick-started');
  assert.equal(f.workflow.codes.size, 0);
  assert.equal(f.cards[0].receiveIdType, 'open_id'); assert.equal(f.cards[0].receiveId, USER);
  assert.equal(f.cards[0].card.config.enable_forward, false);
  assert.equal(JSON.stringify(f.cards[0]).includes('未发布原始分组'), false);
  await f.click('group'); assert.equal(f.posts(), 0);
  await f.click('quota', { quota: '20' }); assert.equal(f.posts(), 0);
  await f.click('confirm'); assert.equal(f.posts(), 1);
  assert.equal(f.service.records[0].body.quota, 20); assert.equal(f.service.records[0].delivery, 'sent');
  const keys = f.texts.filter(p => p.text.includes('sk-fixture-only-not-real'));
  assert.equal(keys.length, 1); assert.equal(keys[0].receiveIdType, 'open_id'); assert.equal(keys[0].receiveId, USER);
  assert.equal(keys[0].text, '令牌已创建。分组：客户分组\n额度：20\n密钥（仅此私聊）：\nhttps://max.cheapi.cc/\nsk-fixture-only-not-real\n请勿转发。若未收到完整密钥，请联系管理员；机器人不会自动重发。');
  assert.equal(f.workflow.sessions.size, 0);
});

for (const alias of ['发送令牌', '/发送令牌', '申请令牌', '创建令牌', '领取令牌']) {
  test(`command alias ${alias} opens current card without a challenge`, async () => {
    const f = await setup(); assert.equal((await f.start(alias)).status, 'quick-started'); assert.equal(f.cards.length, 1);
    assert.equal(f.posts(), 0);
  });
}

test('group and mention required; DM alone cannot acquire group authorization', async () => {
  const f = await setup();
  assert.equal((await f.dm('发送令牌')).status, 'group-entry-required');
  assert.equal((await f.start('发送令牌', { chat_id: 'oc_other_12345678' })).status, 'group-denied');
  assert.equal((await f.start('发送令牌', { mentions: [] })).status, 'ignored');
  assert.equal(f.cards.length, 0); assert.equal(f.posts(), 0);
});

test('first-contact DM denied: sender-bound session survives and resumes without copying a code', async () => {
  const f = await setup(); f.failDM(true);
  assert.equal((await f.start()).status, 'private-chat-required');
  const id = f.workflow.sessions.get(USER).requestId;
  f.failDM(false);
  const other = f.message('发送令牌'); other.sender.sender_id.open_id = 'ou_other_12345678';
  assert.equal((await f.workflow.handle(other)).status, 'group-entry-required');
  assert.equal((await f.dm('发送令牌')).status, 'quick-resumed');
  assert.equal(f.workflow.sessions.get(USER).requestId, id);
  await f.click('group'); await f.dm('2.5'); await f.click('confirm');
  assert.equal(f.posts(), 1); assert.equal(f.service.records[0].body.quota, 2.5);
});

test('card send denied falls back to text and still requires explicit confirmation', async () => {
  const f = await setup(); f.failCard(true);
  assert.equal((await f.start()).status, 'quick-started');
  assert.match(f.texts[0].text, /无需验证码/);
  await f.dm('1'); await f.dm('3.125'); assert.equal(f.posts(), 0);
  assert.equal((await f.dm('确认')).status, 'created-and-delivered'); assert.equal(f.posts(), 1);
  const keys = f.texts.filter(p => p.text.includes('sk-fixture-only-not-real'));
  assert.equal(keys.length, 1); assert.equal(keys[0].receiveIdType, 'open_id'); assert.equal(keys[0].receiveId, USER);
  assert.equal(keys[0].text, '令牌已创建。分组：客户分组\n额度：3.125\n密钥（仅此私聊）：\nhttps://max.cheapi.cc/\nsk-fixture-only-not-real\n请勿转发。若未收到完整密钥，请联系管理员；机器人不会自动重发。');
});

test('confirmation preflight failure gives a safe code and operation reference, no POST or automatic replay', async () => {
  const f = await setup(); await f.start(); await f.click('group'); await f.click('quota');
  const id = f.workflow.sessions.get(USER).requestId, request = f.service.request, diagnostics = [];
  f.service.onCreateFailure = row => diagnostics.push(row);
  f.service.request = async (...args) => {
    if (args[1] === '/auth/me') { const e = new Error('synthetic-secret-never-display'); e.code = 'NETWORK'; throw e; }
    return request(...args);
  };
  await f.click('confirm');
  assert.equal(f.posts(), 0); assert.equal(f.service.records.length, 0); assert.equal(f.workflow.sessions.size, 0);
  assert.match(f.texts.at(-1).text, /未提交/); assert.match(f.texts.at(-1).text, /错误编号：NETWORK/);
  assert.ok(f.texts.at(-1).text.includes(id)); assert.equal(f.texts.at(-1).text.includes('synthetic-secret'), false);
  assert.equal(diagnostics[0].stage, 'identity');
  await f.dm('确认'); assert.equal(f.posts(), 0); assert.equal(diagnostics.length, 1);
});

for (const [quota, status] of [['0', 'quota-out-of-range'], ['20.0001', 'quota-out-of-range'], ['-1', 'invalid-quota'],
  ['NaN', 'invalid-quota'], ['1e2', 'invalid-quota'], ['1.12345', 'invalid-quota'], ['', 'ignored']]) {
  test(`invalid quota ${JSON.stringify(quota)} cannot create`, async () => {
    const f = await setup(); await f.start(); await f.click('group');
    assert.equal((await f.dm(quota)).status, status); assert.equal(f.posts(), 0);
    assert.equal(f.workflow.sessions.get(USER).state, 'quota');
  });
}

test('back, custom amount, edit and cancel do not create', async () => {
  const f = await setup(); await f.start(); await f.click('group'); await f.click('back');
  assert.equal(f.workflow.sessions.get(USER).state, 'group');
  await f.click('group'); await f.click('custom'); assert.match(f.texts.at(-1).text, /直接/);
  await f.dm('3'); await f.click('edit'); assert.equal(f.workflow.sessions.get(USER).state, 'quota');
  await f.dm('4'); await f.click('cancel'); assert.equal(f.workflow.sessions.size, 0); assert.equal(f.posts(), 0);
});

const tamper = {
  operator: e => { e.operator.open_id = 'ou_other_12345678'; },
  chat: e => { e.context.open_chat_id = GROUP; },
  message: e => { e.context.open_message_id += '_wrong'; },
  nonce: e => { e.action.value.nonce += '_wrong'; },
  request: e => { e.action.value.requestId += '_wrong'; },
  namespace: e => { e.action.value.keyTool = 'other'; },
  action: e => { e.action.value.action = 'delete'; },
  malformed: e => { delete e.operator; }
};
for (const [name, change] of Object.entries(tamper)) {
  test(`card rejects wrong ${name}`, async () => {
    const f = await setup(); await f.start(); await f.click('group'); await f.click('quota');
    const event = f.callback('confirm'); change(event);
    assert.equal(f.workflow.handleCard(event).toast.type, 'warning'); await f.workflow.tail;
    assert.equal(f.posts(), 0); assert.equal(f.workflow.sessions.get(USER).state, 'confirm');
  });
}

for (const [name, change] of [['expired', f => f.advance(11 * 60000)], ['policy replaced', f => f.setPolicy({ maxQuota: 10 })],
  ['disabled', f => f.setPolicy({ enabled: false })], ['disconnected', f => f.setPhase('disconnected')],
  ['owner mismatch', f => { f.service.owner = 2; }]]) {
  test(`card fails closed when ${name}`, async () => {
    const f = await setup(); await f.start(); await f.click('group'); await f.click('quota');
    const event = f.callback('confirm'); change(f);
    assert.equal(f.workflow.handleCard(event).toast.type, 'warning'); await f.workflow.tail; assert.equal(f.posts(), 0);
  });
}

test('a stale menu, wrong private chat and duplicate confirms never replay creation', async () => {
  const f = await setup(); await f.start(); const old = f.callback('group');
  await f.click('group'); assert.equal(f.workflow.handleCard(old).toast.type, 'warning');
  await f.click('quota'); const confirm = f.callback('confirm');
  const wrong = structuredClone(confirm); wrong.context.open_chat_id = 'oc_otherdm_12345678';
  assert.equal(f.workflow.handleCard(wrong).toast.type, 'warning');
  assert.equal(f.workflow.handleCard(confirm).toast.type, 'info');
  assert.equal(f.workflow.handleCard(confirm).toast.type, 'info');
  await f.workflow.tail; assert.equal(f.posts(), 1);
  assert.equal(f.workflow.handleCard(confirm).toast.type, 'warning');
  assert.equal(f.texts.filter(p => p.text.includes('sk-fixture-only-not-real')).length, 1);
});

test('callbacks queued before policy change recheck immediately before execution', async () => {
  const f = await setup(); await f.start(); await f.click('group'); await f.click('quota');
  let release; f.workflow.tail = new Promise(resolve => { release = resolve; });
  const event = f.callback('confirm'); assert.equal(f.workflow.handleCard(event).toast.type, 'info');
  f.setPolicy({ enabled: false }); release(); await f.workflow.tail; assert.equal(f.posts(), 0);
});

test('callback toast is synchronous even when remote creation is waiting', async () => {
  const f = await setup(); await f.start(); await f.click('group'); await f.click('quota');
  let release; const original = f.service.create.bind(f.service);
  f.service.create = async (...args) => { await new Promise(resolve => { release = resolve; }); return original(...args); };
  const response = f.workflow.handleCard(f.callback('confirm'));
  assert.equal(typeof response.then, 'undefined'); assert.equal(response.toast.type, 'info');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.posts(), 0);
  release(); await f.workflow.tail; assert.equal(f.posts(), 1);
});

test('unknown POST outcome blocks new starts; no automatic retry or key resend', async () => {
  const f = await setup(); await f.start(); await f.click('group'); await f.click('quota');
  f.fixture.setFail(true); await f.click('confirm'); assert.equal(f.posts(), 1);
  assert.equal(f.service.blocked().length, 1); assert.equal((await f.start()).status, 'business-locked');
  assert.equal(f.posts(), 1); assert.equal(f.texts.some(p => p.text.includes('sk-fixture-only-not-real')), false);
});

test('private key delivery failure is recorded unknown and never auto-resent', async () => {
  const f = await setup(); await f.start(); await f.click('group'); await f.click('quota');
  const confirm = f.callback('confirm'); f.failDM(true);
  f.workflow.handleCard(confirm); await f.workflow.tail;
  assert.equal(f.posts(), 1); assert.equal(f.service.records[0].delivery, 'unknown');
  f.failDM(false); f.workflow.handleCard(confirm); await f.workflow.tail;
  await f.dm('确认'); assert.equal(f.posts(), 1);
  assert.equal(f.texts.some(p => p.text.includes('sk-fixture-only-not-real')), false);
});

test('unpublished or removed group cannot be created, even from an earlier menu', async () => {
  const f = await setup(); await f.start();
  await f.click('group', { index: 11 }); assert.equal(f.workflow.sessions.get(USER).state, 'group');
  await f.click('group'); await f.click('quota');
  await f.service.saveGroupNames({ owner: 1, items: [{ id: 7, name: '' }] });
  assert.deepEqual(f.service.customerGroups(), []);
  await f.click('confirm');
  assert.equal(f.posts(), 0);
});

test('same group request ID already recorded never replays even with a reconstructed transient session', async () => {
  const f = await setup(); await f.start(); await f.click('group'); await f.click('quota');
  const session = { ...f.workflow.sessions.get(USER) };
  await f.click('confirm'); f.workflow.sessions.set(USER, session);
  assert.equal((await f.dm('确认')).status, 'already-recorded'); assert.equal(f.posts(), 1);
});

test('session cap and identity rate limit apply to the simplified flow', async () => {
  const f = await setup();
  for (let i = 0; i < 512; i++) f.workflow.sessions.set(`ou_pending_${i}`, { expiresAt: Date.now() + 60000 });
  assert.equal((await f.start()).status, 'capacity'); assert.equal(f.cards.length, 0);
  f.workflow.sessions.clear(); await f.start(); await f.start();
  assert.equal((await f.start()).status, 'rate-limited'); assert.equal(f.posts(), 0);
});

test('card queue cap refuses without enqueuing another operation', async () => {
  const f = await setup(); await f.start(); f.workflow.queuedCards = 512;
  assert.equal(f.workflow.handleCard(f.callback('group')).toast.type, 'warning');
  assert.equal(f.workflow.queuedCards, 512); assert.equal(f.posts(), 0);
});

test('legacy session upgrades to cards without changing operation ID or losing the chosen quota', async () => {
  const f = await setup(); await f.start(); await f.click('group'); await f.dm('2.5');
  const session = f.workflow.sessions.get(USER), id = session.requestId;
  delete session.quick; delete session.policy; delete session.cardToken;
  assert.equal((await f.dm('发送令牌')).status, 'quick-resumed');
  assert.equal(session.requestId, id); assert.equal(session.quota, 2.5);
  assert.match(session.cardToken, /^[A-Za-z0-9_-]{16,64}$/);
  await f.click('confirm'); assert.equal(f.posts(), 1);
});

test('card group pagination and quota presets are bounded and names are plain text', () => {
  const session = { state: 'group', page: 1, groups: Array.from({ length: 22 }, (_, i) => ({ id: i + 1, name: '<b>分组</b>' + i })),
    requestId: 'fixture-operation', cardToken: 'fixture_nonce_12345678' };
  const card = requestCard(session, 20), buttons = card.elements.flatMap(row => row.actions || []);
  assert.equal(buttons.filter(b => b.value.action === 'group').length, 10);
  assert.equal(buttons[0].value.index, 10); assert.equal(buttons[0].text.tag, 'plain_text');
  assert.deepEqual(buttons.filter(b => b.value.action === 'page').map(b => b.value.page), [0, 2]);
  session.state = 'quota'; session.selectedGroup = session.groups[0];
  assert.deepEqual(requestCard(session, 5).elements.flatMap(row => row.actions || [])
    .filter(b => b.value.action === 'quota').map(b => b.value.quota), ['1', '5']);
  assert.equal(requestCard(session, 0.5).elements.some(row => row.tag === 'action' && !row.actions.length), false);
});

test('pagination callbacks select from the original server-side group list', async () => {
  const f = await setup();
  f.service.customerGroups = () => Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `客户分组${i + 1}` }));
  await f.start(); await f.click('page');
  assert.equal(f.workflow.sessions.get(USER).page, 1);
  await f.click('group'); assert.equal(f.workflow.sessions.get(USER).selectedGroup.id, 11);
  assert.equal(f.posts(), 0);
});
