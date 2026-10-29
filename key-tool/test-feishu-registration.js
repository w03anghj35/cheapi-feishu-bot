'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FeishuBotWorkflow } = require('./feishu-bot-workflow');
const { UserRegistrationService } = require('./user-registration-service');
const { makeFixture } = require('./test-fixture');
const { KeyService } = require('./service');
const USER = 'ou_member_12345678', GROUP = 'oc_group_12345678', DM = 'oc_private_12345678';
const PASSWORD = '  Fictional  Password  ';
const FORM_VALUES = { email: 'fictional@example.invalid', password: PASSWORD, username: '测试用户名', concurrency: '50', balance: '0' };
const cardNodes = node => [node, ...['elements', 'actions', 'columns'].flatMap(key => (node[key] || []).flatMap(cardNodes))];
async function setup() {
  let now = Date.now(), n = 0, failCard = false, failDM = false, failPost = false, phase = 'connected';
  let policy = { enabled: true, ownerOpenId: 'ou_owner_12345678', groupId: GROUP, platformOwnerId: 1,
    maxQuota: 20, maxUserDailyQuota: null, maxGroupDailyQuota: null };
  const fixture = makeFixture(), service = new KeyService(fixture), texts = [], cards = [], posts = [], saved = [];
  await service.refresh(); await service.saveGroupNames({ owner: 1, items: [{ id: 7, name: '客户分组' }] });
  const registration = new UserRegistrationService({ getOwner: () => service.owner,
    store: { load: () => [], save: rows => saved.push(structuredClone(rows)) },
    request: async (method, route, body) => {
      if (method === 'GET') return { id: 1, role: 'admin' };
      assert.equal(route, '/admin/users'); posts.push(structuredClone(body));
      assert.equal(workflow.sessions.get(USER).registration.password, undefined);
      if (failPost) throw new Error('fictional-secret-upstream-error');
      return { ...body, id: 100 };
    } });
  const workflow = new FeishuBotWorkflow({ service, registrationService: registration, getPolicy: () => policy,
    now: () => now, connection: { state: () => ({ phase }) }, random: () => `fixture_nonce_${String(++n).padStart(16, '0')}`,
    sendText: async payload => { if (failDM && payload.receiveIdType === 'open_id') throw new Error('fixture dm failure'); texts.push(payload); },
    sendCard: async payload => { if (failCard || failDM) throw new Error('fixture card failure');
      const messageId = `om_card_${++n}`; cards.push({ ...payload, messageId }); return { messageId }; } });
  const message = (text, extra = {}) => ({ header: { event_id: `event-${++n}` },
    sender: { sender_type: 'user', sender_id: { open_id: USER } },
    message: { message_id: `om_text_${n}`, chat_id: DM, chat_type: 'p2p', message_type: 'text', create_time: String(now),
      content: JSON.stringify({ text }), mentions: [], ...extra } });
  const dm = (text, extra) => workflow.handle(message(text, extra));
  const start = (text = '', extra) => workflow.handle(message(`@bot ${text}`,
    { chat_id: GROUP, chat_type: 'group', mentions: [{ key: '@bot' }], ...extra }));
  const callback = (action, extra = {}, card = cards.at(-1)) => {
    const button = cardNodes(card.card).find(b => b.tag === 'button' && b.value?.action === action);
    assert.ok(button, `missing button ${action}`);
    return { operator: { open_id: USER }, context: { open_chat_id: DM, open_message_id: card.messageId },
      action: { value: { ...button.value, ...extra } } };
  };
  const click = async (action, extra) => { const r = workflow.handleCard(callback(action, extra)); await workflow.tail; return r; };
  const form = (values = FORM_VALUES) => {
    const event = callback('register-submit');
    Object.assign(event.action, { tag: 'button', name: 'registration_submit', form_value: values });
    return event;
  };
  const beginLegacy = async () => {
    await start(); await dm('1');
    // Simulate an existing text session; all NEW registrations use the form.
    Object.assign(workflow.sessions.get(USER), { state: 'register-email', registrationInput: 'text' });
  };
  const fill = async (balance = '0') => {
    await start(); await dm('1');
    assert.equal(workflow.handleCard(form({ ...FORM_VALUES, balance })).toast.type, 'info');
    await workflow.tail;
  };
  return { workflow, service, registration, texts, cards, posts, saved, message, dm, start, callback, click, form, beginLegacy, fill, fixture,
    setPolicy: v => { policy = { ...policy, ...v }; }, advance: ms => { now += ms; }, setPhase: v => { phase = v; },
    failCard: v => { failCard = v; }, failDM: v => { failDM = v; }, failPost: v => { failPost = v; } };
}
test('pure mention opens two-feature private menu; no fake third button, no group secrets', async () => {
  const f = await setup(); assert.equal((await f.start()).status, 'menu-started');
  const card = f.cards[0]; assert.equal(card.receiveIdType, 'open_id'); assert.equal(card.receiveId, USER);
  assert.equal(card.card.config.enable_forward, false);
  const buttons = card.card.elements.flatMap(x => x.actions || []).filter(x => x.value.action === 'feature');
  assert.deepEqual(buttons.map(x => x.value.featureId), ['register', 'token']);
  assert.equal(f.posts.length, 0); assert.equal(f.workflow.codes.size, 0);
});
for (const balance of ['0','1','5','10']) test(`private registration balance ${balance}: exact password, one explicit POST, no password echo`, async () => {
  const f = await setup(); await f.fill(balance);
  assert.equal(f.posts.length, 0); const session = f.workflow.sessions.get(USER);
  assert.equal(session.registration.password, PASSWORD);
  const confirmation = f.callback('register-confirm');
  assert.equal(f.workflow.handleCard(confirmation).toast.type, 'info');
  f.workflow.handleCard(confirmation); await f.workflow.tail;
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].password, PASSWORD);
  assert.equal(f.posts[0].balance, Number(balance)); assert.equal(f.posts[0].concurrency, 50); assert.equal(f.posts[0].role, 'user');
  assert.equal(session.registration.password, undefined); assert.equal(f.workflow.sessions.size, 0);
  assert.equal(JSON.stringify(f.saved).includes(PASSWORD), false);
  assert.equal(JSON.stringify(f.texts).includes(PASSWORD), false); assert.equal(JSON.stringify(f.cards).includes(PASSWORD), false);
  const delivered = f.texts.filter(x => x.text.includes('账号已创建。'));
  assert.equal(delivered.length, 1); assert.equal(delivered[0].receiveIdType, 'open_id');
  assert.ok(delivered[0].text.includes('https://max.cheapi.cc/'));
  await f.dm('确认'); assert.equal(f.posts.length, 1);
});
test('blank and invalid password inputs are validated rather than silently ignored or normalized', async () => {
  const f = await setup(); await f.beginLegacy(); await f.dm('fictional@example.invalid');
  for (const invalid of ['', '        ', 'short', 'long\npassword', '中'.repeat(25)]) {
    assert.equal((await f.dm(invalid)).status, 'invalid-registration-input');
    assert.equal(f.workflow.sessions.get(USER).state, 'register-password');
  }
  await f.dm(PASSWORD); assert.equal(f.workflow.sessions.get(USER).registration.password, PASSWORD);
  assert.equal(f.posts.length, 0);
});
test('registration password text is never interpreted as an administrator binding command', async () => {
  const f = await setup(); await f.beginLegacy(); await f.dm('fictional@example.invalid');
  const challenge = f.workflow.startOwnerBinding(), value = '/绑定管理员 ' + challenge.code;
  await f.dm(value); assert.equal(f.workflow.ownerCandidate, null);
  assert.equal(f.workflow.sessions.get(USER).registration.password, value);
});
test('invalid concurrency and balance keep the current step, without mutation', async () => {
  const f = await setup(); await f.beginLegacy(); await f.dm('fictional@example.invalid'); await f.dm(PASSWORD); await f.dm('User');
  for (const value of ['0','51','2.5','-1','NaN','5abc']) assert.equal((await f.dm(value)).status, 'invalid-registration-input');
  await f.dm('1');
  for (const value of ['2','20','-1','1.0']) assert.equal((await f.dm(value)).status, 'invalid-registration-input');
  await f.click('balance', { balance: '5' }); assert.equal(f.workflow.sessions.get(USER).state, 'register-confirm');
  assert.equal(f.posts.length, 0);
});
test('unbound private users, wrong groups, no mention and malformed messages cannot start registration', async () => {
  const f = await setup(); await f.dm('用户注册'); assert.equal(f.workflow.sessions.size, 0);
  assert.equal((await f.start('', { chat_id: 'oc_other_12345678' })).status, 'group-denied');
  assert.equal((await f.start('', { mentions: [] })).status, 'ignored');
  assert.equal((await f.start('', { content: 'invalid json' })).status, 'ignored');
  assert.equal(f.workflow.sessions.size, 0);
});
test('menu-to-token and token alias still use existing token service, not registration', async () => {
  const f = await setup(); await f.start(); const id = f.workflow.sessions.get(USER).requestId;
  await f.click('feature', { featureId: 'token' }); assert.equal(f.workflow.sessions.get(USER).requestId, id);
  await f.click('group'); await f.click('quota', { quota: '5' }); await f.click('confirm');
  assert.equal(f.fixture.calls.filter(x => x.method === 'POST').length, 1); assert.equal(f.posts.length, 0);
  assert.ok(f.texts.at(-1).text.includes('https://max.cheapi.cc/\nsk-fixture-only-not-real'));
});
test('stale card, forged operator, nonce and private chat are rejected', async () => {
  const f = await setup(); await f.start(); const old = f.callback('feature'); await f.dm('1');
  assert.equal(f.workflow.handleCard(old).toast.type, 'warning');
  const good = f.form();
  for (const changed of [{ ...good, operator: { open_id: 'ou_other_12345678' } },
    { ...good, context: { ...good.context, open_chat_id: GROUP } },
    { ...good, action: { value: { ...good.action.value, nonce: 'forged' } } }])
    assert.equal(f.workflow.handleCard(changed).toast.type, 'warning');
  assert.equal((await f.dm('5', { chat_id: 'oc_wrongdm_12345678' })).status, 'private-chat-mismatch');
  assert.equal(f.posts.length, 0);
});
for (const action of ['cancel', 'expiry', 'reset', 'disconnect', 'policy']) test(`${action} clears the registration password and prevents POST`, async () => {
  const f = await setup(); await f.fill(); const session = f.workflow.sessions.get(USER);
  if (action === 'cancel') await f.click('cancel');
  if (action === 'expiry') { f.advance(10 * 60_000 + 1); f.workflow.pruneTransientState(); }
  if (action === 'reset') f.workflow.reset();
  if (action === 'disconnect') { f.setPhase('disconnected'); await f.dm('确认'); }
  if (action === 'policy') { f.setPolicy({ maxQuota: 19 }); await f.dm('确认'); }
  assert.equal(session.registration.password, undefined); assert.equal(f.posts.length, 0);
});
test('queued card revalidates policy before any POST', async () => {
  const f = await setup(); await f.fill(); const callback = f.callback('register-confirm');
  let release; f.workflow.tail = new Promise(r => { release = r; });
  assert.equal(f.workflow.handleCard(callback).toast.type, 'info'); f.setPolicy({ enabled: false }); release();
  await f.workflow.tail; assert.equal(f.posts.length, 0); f.workflow.reset();
});
test('legacy text session remains compatible if card delivery fails, with same request ID and explicit confirmation', async () => {
  const f = await setup(); f.failCard(true); await f.beginLegacy();
  await f.dm('fictional@example.invalid'); await f.dm(PASSWORD); await f.dm('User'); await f.dm('50'); await f.dm('10');
  const id = f.workflow.sessions.get(USER).requestId;
  assert.equal((await f.dm('确认')).status, 'registered-and-delivered');
  assert.equal(f.registration.records[0].requestId, id); assert.equal(f.posts.length, 1); assert.equal(f.cards.length, 0);
});
test('failed registration keeps unknown protection, scrubs password and does not lock token branch', async () => {
  const f = await setup(); f.failPost(true); await f.fill(); const session = f.workflow.sessions.get(USER);
  assert.equal((await f.dm('确认')).status, 'registration-failed');
  assert.equal(f.registration.records[0].state, 'unknown'); assert.equal(session.registration.password, undefined);
  assert.equal(JSON.stringify(f.texts).includes('fictional-secret-upstream-error'), false);
  await f.start(); assert.equal((await f.dm('1')).status, 'feature-unavailable');
  assert.equal((await f.dm('2')).status, 'feature-selected'); assert.equal(f.workflow.sessions.get(USER).state, 'group');
});
test('failed success notification is not retried and never triggers a second create', async () => {
  const f = await setup(); await f.fill(); f.failDM(true);
  assert.equal((await f.dm('确认')).status, 'registered-delivery-unknown');
  assert.equal(f.registration.records[0].state, 'success');
  await f.dm('确认'); assert.equal(f.posts.length, 1);
});
test('legacy authorized conversation upgrades via group menu without losing ID, quota or step', async () => {
  const f = await setup(); await f.start(); const session = f.workflow.sessions.get(USER);
  Object.assign(session, { state: 'confirm', groups: f.service.customerGroups(), selectedGroup: f.service.customerGroups()[0], quota: 5 });
  delete session.quick; delete session.policy; delete session.cardToken; const id = session.requestId;
  await f.start(); assert.equal(session.requestId, id); assert.equal(session.quota, 5); assert.equal(session.state, 'confirm');
  assert.equal(session.quick, true); await f.click('confirm');
  assert.equal(f.service.records[0].requestId, id); assert.equal(f.posts.length, 0);
});

test('new registration renders one complete private form with masked password and four balance options', async () => {
  const f = await setup(); await f.start(); await f.click('feature', { featureId: 'register' });
  const card = f.cards.at(-1), nodes = cardNodes(card.card);
  assert.equal(card.receiveIdType, 'open_id'); assert.equal(card.receiveId, USER);
  assert.equal(f.workflow.sessions.get(USER).state, 'register-form');
  assert.equal(nodes.filter(n => n.tag === 'form').length, 1);
  assert.deepEqual(nodes.filter(n => n.tag === 'input').map(n => n.name), ['email', 'password', 'username', 'concurrency']);
  const password = nodes.find(n => n.name === 'password');
  assert.equal(password.input_type, 'password'); assert.equal(password.required, true);
  assert.equal(Object.hasOwn(password, 'default_value'), false);
  const select = nodes.find(n => n.name === 'balance');
  assert.equal(select.required, true); assert.deepEqual(select.options.map(o => o.value), ['0','1','5','10']);
  const submit = nodes.find(n => n.name === 'registration_submit');
  assert.equal(submit.action_type, 'form_submit'); assert.equal(submit.value.action, 'register-submit');
  const names = nodes.filter(n => n.name).map(n => n.name);
  assert.equal(new Set(names).size, names.length); assert.equal(f.posts.length, 0);
});

test('invalid form fields return a safe toast without discarding the form, storing secrets or creating', async () => {
  const f = await setup(); await f.start(); await f.dm('1');
  const session = f.workflow.sessions.get(USER), originalCard = session.cardMessageId;
  const invalid = [null, [], {}, { ...FORM_VALUES, role: 'admin' }, { ...FORM_VALUES, email: 'bad' },
    { ...FORM_VALUES, email: 'a\0@b.example' }, { ...FORM_VALUES, password: '' },
    { ...FORM_VALUES, password: '        ' }, { ...FORM_VALUES, password: '中'.repeat(25) },
    { ...FORM_VALUES, password: { value: PASSWORD } }, { ...FORM_VALUES, username: '' },
    { ...FORM_VALUES, concurrency: '51' }, { ...FORM_VALUES, concurrency: '0' },
    { ...FORM_VALUES, concurrency: '2.5' }, { ...FORM_VALUES, concurrency: '01' },
    { ...FORM_VALUES, concurrency: 5 }, { ...FORM_VALUES, balance: '' },
    { ...FORM_VALUES, balance: '20' }, { ...FORM_VALUES, balance: 0 }];
  for (const values of invalid) {
    const result = f.workflow.handleCard(f.form(values));
    assert.equal(result.toast.type, 'error'); assert.equal(JSON.stringify(result).includes(PASSWORD), false);
    assert.equal(session.state, 'register-form'); assert.equal(session.cardMessageId, originalCard);
    assert.equal(session.registration.password, undefined);
  }
  assert.equal(f.posts.length, 0); assert.equal(f.saved.length, 0); assert.equal(f.workflow.queuedCards, 0);
});

test('form callback requires the actual submit component, not input callbacks or missing name', async () => {
  const f = await setup(); await f.start(); await f.dm('1');
  for (const patch of [{ tag: 'input' }, { name: 'forged' }, { tag: undefined }, { name: undefined }]) {
    const event = f.form(); Object.assign(event.action, patch);
    assert.equal(f.workflow.handleCard(event).toast.type, 'error');
  }
  assert.equal(f.posts.length, 0); assert.equal(f.workflow.sessions.get(USER).state, 'register-form');
});

test('form submit only advances to confirmation; double submit and double confirm create once', async () => {
  const f = await setup(); await f.start(); await f.dm('1');
  const event = f.form({ ...FORM_VALUES, concurrency: '1', balance: '10' });
  f.workflow.handleCard(event); f.workflow.handleCard(event); await f.workflow.tail;
  assert.equal(f.posts.length, 0); assert.equal(f.workflow.sessions.get(USER).state, 'register-confirm');
  assert.equal(f.workflow.handleCard(event).toast.type, 'warning');
  const confirm = f.callback('register-confirm');
  f.workflow.handleCard(confirm); f.workflow.handleCard(confirm); await f.workflow.tail;
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].concurrency, 1); assert.equal(f.posts[0].balance, 10);
  assert.equal(JSON.stringify(f.cards).includes(PASSWORD), false);
  assert.equal(JSON.stringify(f.saved).includes(PASSWORD), false);
});

test('edit form keeps validated nonsecret fields, clears password and rejects the previous confirmation', async () => {
  const f = await setup(); await f.fill('5'); const session = f.workflow.sessions.get(USER);
  const old = f.callback('register-confirm'), id = session.requestId;
  await f.click('register-edit'); assert.equal(session.requestId, id); assert.equal(session.state, 'register-form');
  assert.equal(session.registration.password, undefined);
  const nodes = cardNodes(f.cards.at(-1).card);
  assert.equal(nodes.find(n => n.name === 'email').default_value, FORM_VALUES.email);
  assert.equal(nodes.find(n => n.name === 'balance').initial_option, '5');
  assert.equal(Object.hasOwn(nodes.find(n => n.name === 'password'), 'default_value'), false);
  assert.equal(JSON.stringify(f.cards).includes(PASSWORD), false);
  assert.equal(f.workflow.handleCard(old).toast.type, 'warning');
  await f.dm('确认'); assert.equal(f.posts.length, 0);
  f.workflow.handleCard(f.form({ ...FORM_VALUES, username: '修改后的名字', balance: '1' })); await f.workflow.tail;
  await f.click('register-confirm'); assert.equal(f.posts.length, 1); assert.equal(f.posts[0].username, '修改后的名字');
});

test('new form never silently consumes a chat password or falls back to collecting it as text', async () => {
  const f = await setup(); f.failCard(true); await f.start(); await f.dm('1');
  const session = f.workflow.sessions.get(USER), id = session.requestId;
  assert.equal(session.state, 'register-form'); assert.match(f.texts.at(-1).text, /不要把密码发送到聊天框/);
  assert.equal((await f.dm(PASSWORD)).status, 'registration-form-required');
  assert.deepEqual(session.registration, {}); assert.equal(JSON.stringify(f.texts).includes(PASSWORD), false);
  f.failCard(false); await f.dm('重新显示表单'); assert.equal(session.requestId, id);
  assert.ok(cardNodes(f.cards.at(-1).card).find(n => n.tag === 'form'));
  await f.click('cancel'); assert.equal(f.workflow.sessions.size, 0); assert.equal(f.posts.length, 0);
});

for (const change of ['policy', 'expiry', 'reset', 'disconnect']) test(`queued form rechecks ${change} and does not save submitted secrets`, async () => {
  const f = await setup(); await f.start(); await f.dm('1'); const session = f.workflow.sessions.get(USER);
  let release; f.workflow.tail = new Promise(resolve => { release = resolve; });
  f.workflow.handleCard(f.form());
  if (change === 'policy') f.setPolicy({ enabled: false });
  if (change === 'expiry') f.advance(10 * 60_000 + 1);
  if (change === 'reset') f.workflow.reset();
  if (change === 'disconnect') f.setPhase('disconnected');
  release(); await f.workflow.tail;
  assert.equal(session.registration.password, undefined); assert.equal(f.posts.length, 0);
  assert.equal(f.workflow.queuedCards, 0); assert.equal(f.saved.length, 0);
});

test('queued form uses a validated snapshot and clears the queue-owned password reference', async () => {
  const f = await setup(); await f.start(); await f.dm('1');
  let release, queueData; f.workflow.tail = new Promise(resolve => { release = resolve; });
  const original = f.workflow.handleCardAction.bind(f.workflow);
  f.workflow.handleCardAction = (event, data) => { queueData = data; return original(event, data); };
  const values = { ...FORM_VALUES }, event = f.form(values);
  f.workflow.handleCard(event); values.password = 'changed-after-submit'; values.balance = '10';
  release(); await f.workflow.tail;
  assert.equal(queueData.password, undefined);
  const session = f.workflow.sessions.get(USER);
  assert.equal(session.registration.password, PASSWORD); assert.equal(session.registration.balance, 0);
  assert.equal(f.posts.length, 0); f.workflow.reset();
});

test('failure while displaying confirmation still scrubs the queue-owned password', async () => {
  const f = await setup(); await f.start(); await f.dm('1'); let queueData;
  const original = f.workflow.handleCardAction.bind(f.workflow);
  f.workflow.handleCardAction = (event, data) => { queueData = data; return original(event, data); };
  f.workflow.promptQuick = async () => { throw new Error('fixture-failure'); };
  f.workflow.handleCard(f.form()); await f.workflow.tail;
  assert.equal(queueData.password, undefined); assert.equal(f.posts.length, 0);
  assert.equal(JSON.stringify(f.texts).includes(PASSWORD), false); f.workflow.reset();
});
