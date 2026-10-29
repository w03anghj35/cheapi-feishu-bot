'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FeishuBotWorkflow } = require('./feishu-bot-workflow');
const { makeFixture } = require('./test-fixture');
const { KeyService } = require('./service');

const OWNER = 'ou_admin_12345678';
const USER = 'ou_member_12345678';
const GROUP = 'oc_12345678';
const policy = (overrides = {}) => ({ enabled: true, ownerOpenId: OWNER, groupId: GROUP, platformOwnerId: 1, maxQuota: 5, maxUserDailyQuota: 10, maxGroupDailyQuota: 20, ...overrides });
let sequence = 0;
function message({ openId = USER, chatId = GROUP, chatType = 'group', text, mention = false, eventId = `event-${++sequence}`, senderType = 'user', at = Date.now() }) {
  return { header: { event_id: eventId }, sender: { sender_type: senderType, sender_id: { open_id: openId } },
    message: { message_id: `message-${eventId}`, chat_id: chatId, chat_type: chatType, message_type: 'text',
      create_time: String(at), content: JSON.stringify({ text }), mentions: mention ? [{ key: '@bot' }] : [] } };
}
async function setup(t, configuredPolicy = policy()) {
  sequence = 0;
  let currentTime = Date.now();
  const fixture = makeFixture(), service = new KeyService(fixture);
  await service.refresh(); await service.saveGroupNames({ owner: 1, items: [{ id: 7, name: '客户分组' }] });
  const sent = [], contexts = [];
  let currentPolicy = configuredPolicy;
  const sendText = async payload => { sent.push(payload); return true; };
  const workflow = new FeishuBotWorkflow({ getPolicy: () => currentPolicy, service, sendText,
    now: () => currentTime, random: () => `challenge_${String(++sequence).padStart(16, '0')}` });
  t.after(() => { currentPolicy = { ...currentPolicy, enabled: false }; workflow.reset(); });
  return { fixture, service, sent, contexts, workflow, setPolicy: value => { currentPolicy = value; },
    setNow: value => { currentTime = value; } };
}
test('only the configured group and mentioned user can start; duplicate events do not create duplicate challenges', async t => {
  const f = await setup(t);
  assert.equal((await f.workflow.handle(message({ chatId: 'oc_other_12345', mention: true, text: '@bot 创建令牌' }))).status, 'group-denied');
  assert.equal((await f.workflow.handle(message({ mention: false, text: '创建令牌' }))).status, 'ignored');
  const request = message({ mention: true, text: '@bot 创建令牌', eventId: 'same-event' });
  assert.equal((await f.workflow.handle(request)).status, 'challenge-issued');
  assert.equal((await f.workflow.handle(request)).status, 'duplicate');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].receiveIdType, 'chat_id');
});
test('challenge is bound to initiator, flow requires group/quota/confirmation, key is sent only in DM once', async t => {
  const f = await setup(t);
  assert.equal((await f.workflow.handle(message({ mention: true, text: '@bot 创建令牌' }))).status, 'challenge-issued');
  const code = f.sent[0].text.match(/\/继续 ([A-Za-z0-9_-]+)/)[1];
  assert.equal((await f.workflow.handle(message({ openId: 'ou_other_12345678', chatType: 'p2p', chatId: 'oc_dm_12345678', text: `/继续 ${code}` }))).status, 'challenge-invalid');
  assert.equal((await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: `/继续 ${code}` }))).status, 'session-started');
  assert.equal((await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '1' }))).status, 'group-selected');
  assert.equal((await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '4' }))).status, 'awaiting-confirmation');
  assert.equal((await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '确认' }))).status, 'created-and-delivered');
  assert.equal(f.service.records.length, 1); assert.equal(f.service.records[0].operator.verified, true);
  assert.equal(f.service.records[0].feishuGroupId, GROUP); assert.equal(f.service.records[0].delivery, 'sent');
  const dms = f.sent.filter(row => row.receiveIdType === 'open_id');
  assert.ok(dms.at(-1).text.includes('sk-fixture-only-not-real'));
  assert.equal(f.sent.filter(row => row.receiveIdType === 'chat_id').some(row => row.text.includes('sk-fixture-only-not-real')), false);
  assert.equal(f.service.records[0].events.filter(event => event.kind === 'feishu-delivery').length, 2);
});
test('disabled/unconfigured policies and malformed quotas fail closed; system messages ignored', async t => {
  const f = await setup(t, { ...policy(), enabled: false });
  assert.equal((await f.workflow.handle(message({ mention: true, text: '@bot 创建令牌' }))).status, 'disabled');
  assert.equal((await f.workflow.handle(message({ mention: true, text: '@bot 创建令牌', senderType: 'bot' }))).status, 'ignored');
});
test('strategy bound to a different 2API account fails closed', async t => {
  const f = await setup(t, policy({ platformOwnerId: 2 }));
  assert.equal(f.workflow.state().platformAccountMatches, false);
  assert.equal((await f.workflow.handle(message({ mention: true, text: '@bot 创建令牌' }))).status, 'disabled');
});
test('reviewed records remain charged against the daily budget; uncertain creation never causes a second POST', async t => {
  const f = await setup(t);
  f.service.records.push({ requestId: 'old-00000000-0000-4000-a000-000000000001', feishuGroupId: GROUP,
    operator: { name: '飞书用户#00000000000000000001', source: 'feishu-open-id', verified: true },
    state: 'reviewed', at: new Date().toISOString(), body: { quota: 19 } });
  const before = f.fixture.calls.filter(call => call.method === 'POST').length;
  assert.equal((await f.workflow.handle(message({ mention: true, text: '@bot 创建令牌' }))).status, 'challenge-issued');
  const code = f.sent[0].text.match(/\/继续 ([A-Za-z0-9_-]+)/)[1];
  await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: `/继续 ${code}` }));
  await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '1' }));
  await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '2' }));
  assert.equal((await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '确认' }))).status, 'budget-exceeded');
  assert.equal(f.fixture.calls.filter(call => call.method === 'POST').length, before);
});

test('daily caps may be unlimited while per-token quota remains capped at 20', async t => {
  const f = await setup(t, policy({ maxQuota: 20, maxUserDailyQuota: null, maxGroupDailyQuota: null }));
  f.service.records.push({ requestId: 'old-00000000-0000-4000-a000-000000000001', feishuGroupId: GROUP,
    operator: { name: 'other-member', source: 'feishu-open-id', verified: true },
    state: 'success', at: new Date().toISOString(), body: { quota: 1000000 } });
  assert.equal((await f.workflow.handle(message({ mention: true, text: '@bot 创建令牌' }))).status, 'challenge-issued');
  const code = f.sent[0].text.match(/\/继续 ([A-Za-z0-9_-]+)/)[1];
  await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: `/继续 ${code}` }));
  await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '1' }));
  await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '20' }));
  assert.equal((await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '确认' }))).status, 'created-and-delivered');
  assert.equal(f.service.records.length, 2);
  assert.equal(f.service.records.at(-1).body.quota, 20);
});

test('unlimited daily caps do not remove the single-request ceiling', async t => {
  const f = await setup(t, policy({ maxQuota: 20, maxUserDailyQuota: null, maxGroupDailyQuota: null }));
  await f.workflow.handle(message({ mention: true, text: '@bot 创建令牌' }));
  const code = f.sent[0].text.match(/\/继续 ([A-Za-z0-9_-]+)/)[1];
  await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: `/继续 ${code}` }));
  await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '1' }));
  assert.equal((await f.workflow.handle(message({ chatType: 'p2p', chatId: 'oc_dm_12345678', text: '20.0001' }))).status, 'quota-out-of-range');
  assert.equal(f.fixture.calls.filter(call => call.method === 'POST').length, 0);
});

test('pending group challenges and active private sessions are bounded and expire', async t => {
  const f = await setup(t);
  const startedAt = Date.now();
  for (let i = 0; i < 512; i++) {
    const memberId = `ou_member_${String(i).padStart(8, '0')}`;
    const result = await f.workflow.handle(message({ openId: memberId, eventId: `capacity-${i}`, text: '@bot 创建令牌', mention: true, at: startedAt }));
    assert.equal(result.status, 'challenge-issued');
  }
  assert.equal(f.workflow.codes.size, 512);
  assert.equal((await f.workflow.handle(message({ openId: 'ou_member_00000512', eventId: 'capacity-over', text: '@bot 创建令牌', mention: true, at: startedAt }))).status, 'capacity');
  assert.equal(f.workflow.codes.size, 512);
  const afterExpiry = startedAt + 6 * 60_000;
  f.setNow(afterExpiry);
  assert.equal((await f.workflow.handle(message({ openId: 'ou_member_00000513', eventId: 'capacity-after-expiry', text: '@bot 创建令牌', mention: true, at: afterExpiry }))).status, 'challenge-issued');
  assert.equal(f.workflow.codes.size, 1);

  for (let i = 0; i < 512; i++) f.workflow.sessions.set(`ou_active_${String(i).padStart(8, '0')}`, { groupId: GROUP, expiresAt: afterExpiry + 60_000 });
  const openId = 'ou_member_00000513', code = 'challenge_still_valid_0001';
  f.workflow.codes.set(code, { openId, groupId: GROUP, requestId: '00000000-0000-4000-a000-000000000001', expiresAt: afterExpiry + 60_000, attempts: 0 });
  assert.equal((await f.workflow.handle(message({ openId, chatType: 'p2p', chatId: 'oc_dm_12345678', eventId: 'session-capacity', text: `/继续 ${code}`, at: afterExpiry }))).status, 'capacity');
  assert.equal(f.workflow.codes.has(code), true, 'a temporary capacity limit must not consume the unexpired initiator-bound challenge');
  f.setNow(afterExpiry + 61_000);
  const laterCode = 'challenge_after_expiry_0001';
  f.workflow.codes.set(laterCode, { openId, groupId: GROUP, requestId: '00000000-0000-4000-a000-000000000002', expiresAt: afterExpiry + 10 * 60_000, attempts: 0 });
  assert.equal((await f.workflow.handle(message({ openId, chatType: 'p2p', chatId: 'oc_dm_12345678', eventId: 'session-capacity-expired', text: `/继续 ${laterCode}`, at: afterExpiry + 61_000 }))).status, 'session-started');
  assert.equal(f.workflow.sessions.size, 1);
});

test('repeated commands do not issue multiple live challenges for the same member', async t => {
  const f = await setup(t);
  assert.equal((await f.workflow.handle(message({ eventId: 'member-first', text: '@bot 创建令牌', mention: true }))).status, 'challenge-issued');
  assert.equal((await f.workflow.handle(message({ eventId: 'member-second', text: '@bot 创建令牌', mention: true }))).status, 'challenge-active');
  assert.equal(f.workflow.codes.size, 1);
  assert.equal(f.sent.filter(row => row.receiveIdType === 'chat_id').length, 1);
});
