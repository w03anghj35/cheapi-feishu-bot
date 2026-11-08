'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FeishuBotWorkflow } = require('./feishu-bot-workflow');
const { availableFeatures } = require('./feishu-features');

const GROUP = 'oc_group_12345678', DM = 'oc_private_12345678';
const OWNER = 'ou_owner_12345678', USER = 'ou_member_12345678';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let sequence = 0;
  let policy = { enabled: true, ownerOpenId: OWNER, groupId: GROUP, platformOwnerId: 1,
    maxQuota: 20, maxUserDailyQuota: null, maxGroupDailyQuota: null };
  const cards = [], texts = [], waiting = deferred(), queries = [];
  const memberUsage = { query: async (openId, guard) => { queries.push({ openId, guard }); return waiting.promise; },
    sameBinding: () => true };
  const workflow = new FeishuBotWorkflow({ getPolicy: () => policy,
    service: { owner: 1, blocked: () => [], customerGroups: () => [] },
    getMemberUsageQuery: () => memberUsage,
    sendText: async payload => { texts.push(payload); },
    sendCard: async payload => { const messageId = `om_card_${++sequence}`;
      cards.push({ ...payload, messageId }); return { messageId }; } });
  const event = (openId, text, group = false) => ({
    header: { event_id: `event-${++sequence}` }, sender: { sender_type: 'user', sender_id: { open_id: openId } },
    message: { message_id: `om_${sequence}`, chat_id: group ? GROUP : DM, chat_type: group ? 'group' : 'p2p',
      message_type: 'text', create_time: String(Date.now()), content: JSON.stringify({ text }),
      mentions: group ? [{ key: '@bot' }] : [] }
  });
  const start = openId => workflow.handle(event(openId, '@bot', true));
  const dm = (openId, text) => workflow.handle(event(openId, text));
  const cardAction = (openId, id) => {
    const card = cards.at(-1), button = card.card.elements.flatMap(row => row.actions || [])
      .find(item => item.value?.featureId === id);
    assert.ok(button);
    return { operator: { open_id: openId }, context: { open_chat_id: DM, open_message_id: card.messageId },
      action: { value: button.value } };
  };
  return { workflow, cards, texts, queries, waiting, start, dm, cardAction, memberUsage,
    setPolicy: value => { policy = value; }, policy: () => policy };
}
test('menu feature IDs remain stable while visible numeric choices differ for member and admin', async () => {
  assert.deepEqual(availableFeatures(false).map(item => item.id), ['register', 'token', 'user-query', 'user-usage']);
  assert.deepEqual(availableFeatures(true).map(item => item.id), ['register', 'token', 'group-settings', 'user-query', 'user-usage']);
  const f = fixture();
  await f.start(USER);
  const visible = f.cards.at(-1).card.elements.flatMap(row => row.actions || [])
    .filter(item => item.value?.action === 'feature').map(item => item.value.featureId);
  assert.deepEqual(visible, ['register', 'token', 'user-query', 'user-usage']);
  const original = f.workflow.selectFeature.bind(f.workflow);
  let selected = null;
  f.workflow.selectFeature = async (_openId, _session, _policy, featureId) => {
    selected = featureId; return { status: 'selected' };
  };
  assert.equal((await f.dm(USER, '3')).status, 'selected'); assert.equal(selected, 'user-query');
  assert.equal((await f.dm(USER, '4')).status, 'selected'); assert.equal(selected, 'user-usage');
  assert.equal((await f.dm(USER, '5')).status, 'invalid-feature');
  f.workflow.selectFeature = original;
  await f.start(OWNER);
  const admin = f.cards.at(-1).card.elements.flatMap(row => row.actions || [])
    .filter(item => item.value?.action === 'feature').map(item => item.value.featureId);
  assert.deepEqual(admin, ['register', 'token', 'group-settings', 'user-query', 'user-usage']);
});
test('private usage runs outside global message queue and delivers only to initiating identity once', async () => {
  const f = fixture(); await f.start(USER);
  const button = f.cardAction(USER, 'user-usage');
  const toast = f.workflow.handleCard(button);
  assert.equal(toast.toast.type, 'info');
  await f.workflow.tail;
  assert.equal(f.queries.length, 1);
  assert.ok(f.workflow.memberUsageTask);
  assert.equal((await f.start(OWNER)).status, 'menu-started', 'another member is not blocked by slow stats');
  const before = f.cards.length;
  assert.equal(f.workflow.handleCard(button).toast.type, 'warning');
  f.waiting.resolve({ binding: { name: '本人', userIds: [7], scope: { owner: 1, groupId: GROUP } },
    card: { config: { enable_forward: false }, elements: [] } });
  await f.workflow.memberUsageTask;
  assert.equal(f.cards.length, before + 1);
  assert.equal(f.cards.at(-1).receiveIdType, 'open_id');
  assert.equal(f.cards.at(-1).receiveId, USER);
  assert.equal(f.workflow.memberUsageTask, null);
});
test('policy change or reset during private stats prevents stale disclosure', async () => {
  const f = fixture(); await f.start(USER);
  f.workflow.handleCard(f.cardAction(USER, 'user-usage'));
  await f.workflow.tail;
  const task = f.workflow.memberUsageTask, before = f.cards.length;
  f.setPolicy({ ...f.policy(), enabled: false });
  f.waiting.resolve({ binding: { name: '本人', userIds: [7], scope: { owner: 1, groupId: GROUP } },
    card: { config: { enable_forward: false }, elements: [] } });
  await task;
  assert.equal(f.cards.length, before);
  assert.equal(f.texts.filter(row => row.receiveIdType === 'open_id' && row.text.includes('用量')).length, 0);
});
test('unknown private card receipt is not retried or sent to group', async () => {
  const f = fixture(); await f.start(USER);
  const prior = f.cards.length;
  f.workflow.sendCard = async payload => { f.cards.push(payload); throw Error('lost receipt'); };
  f.workflow.handleCard(f.cardAction(USER, 'user-usage'));
  await f.workflow.tail;
  const task = f.workflow.memberUsageTask;
  f.waiting.resolve({ binding: { name: '本人', userIds: [7], scope: { owner: 1, groupId: GROUP } },
    card: { config: { enable_forward: false }, elements: [] } });
  await task;
  assert.equal(f.cards.length, prior + 1);
  assert.equal(f.cards.at(-1).receiveIdType, 'open_id');
  assert.equal(f.cards.at(-1).receiveId, USER);
});
