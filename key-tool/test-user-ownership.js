'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UserOwnership } = require('./user-ownership');
const { makeOwnershipStore } = require('./user-ownership');
const { FeishuBotWorkflow } = require('./feishu-bot-workflow');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OWNER = 'ou_owner_12345678', ALICE = 'ou_alice_12345678', BOB = 'ou_bob_12345678', GROUP = 'oc_group_12345678';
function setup() {
  let records = [], owner = 1, group = GROUP, users = [
    { id: 1, username: '高余额', email: 'high@example.invalid', balance: 10, role: 'user', status: 'active', concurrency: 2 },
    { id: 2, username: '低余额', email: 'low@example.invalid', balance: 1, role: 'user', status: 'active', concurrency: 1 },
    { id: 3, username: '管理员', email: 'admin@example.invalid', balance: 0, role: 'admin', status: 'active' }
  ];
  const request = async (method, route) => {
    if (method !== 'GET') throw new Error('unexpected write');
    if (route === '/auth/me') return { id: owner, role: 'admin' };
    if (route.startsWith('/admin/users?')) return { items: users.map(u => ({ ...u })), total: users.length };
    throw new Error('unexpected route');
  };
  const ownership = new UserOwnership({ request, store: { load: () => records, save: r => { records = structuredClone(r); } },
    getOwner: () => owner, getGroupId: () => group });
  return { ownership, setOwner: v => owner = v, setGroup: v => group = v, setUsers: v => users = v };
}
test('claim, exact assignment, current balances and identity isolation', async () => {
  const f = setup();
  assert.equal(f.ownership.claim(ALICE, '同名'), 'pending');
  assert.equal(f.ownership.claim(BOB, '同名'), 'pending');
  const identities = f.ownership.list();
  assert.equal(identities.length, 2); assert.notEqual(identities[0].identity, identities[1].identity);
  assert.deepEqual((await f.ownership.adminSnapshot()).users.map(u => u.id), [3, 2, 1]);
  await assert.rejects(f.ownership.assign({ identity: identities[0].identity, name: '同名', userIds: [3] }), { code: 'CONFLICT' });
  await f.ownership.assign({ identity: identities[0].identity, name: '同名', userIds: [1, 2] });
  assert.equal(await f.ownership.query(BOB), null);
  assert.deepEqual((await f.ownership.query(ALICE)).users.map(u => u.id), [2, 1]);
  f.setUsers([
    { id: 1, username: '高余额', email: 'high@example.invalid', balance: 0, role: 'user', status: 'active' },
    { id: 2, username: '低余额', email: 'low@example.invalid', balance: 5, role: 'user', status: 'active' }
  ]);
  assert.deepEqual((await f.ownership.query(ALICE)).users.map(u => u.id), [1, 2]);
  f.setGroup('oc_other_12345678'); assert.equal(await f.ownership.query(ALICE), null);
});
test('name-first profile requires explicit administrator identity binding before one-click query', async () => {
  const f = setup();
  const saved = await f.ownership.assignName({ name: '陈梦', userIds: [1, 2] });
  assert.deepEqual(saved.profiles, [{ name: '陈梦', userIds: [1, 2] }]);
  assert.deepEqual(saved.identities, []);
  assert.equal(await f.ownership.query(ALICE), null);
  f.ownership.claim(ALICE, '飞书显示名');
  assert.equal(await f.ownership.query(ALICE), null);
  const identity = f.ownership.list()[0].identity;
  const linked = await f.ownership.link({ identity, profileName: '陈梦' });
  assert.equal(linked.identities[0].state, 'linked');
  assert.equal(linked.identities[0].profileName, '陈梦');
  assert.equal(f.ownership.claim(ALICE, '飞书显示名'), 'linked');
  assert.equal((await f.ownership.query(ALICE)).users[0].id, 2);
  assert.equal(f.ownership.claim(ALICE, '飞书新显示名'), 'linked');
  assert.equal(f.ownership.list()[0].name, '飞书新显示名');
  assert.equal(f.ownership.list()[0].profileName, '陈梦');
  f.ownership.claim(BOB, '另一个显示名');
  assert.equal(await f.ownership.query(BOB), null);
  await assert.rejects(f.ownership.link({ identity: f.ownership.list()[1].identity, profileName: '陈梦' }), { code: 'CONFLICT' });
  f.setGroup('oc_other_12345678');
  assert.equal(await f.ownership.query(ALICE), null);
});
test('name-first update, invalid target and changed users fail safely', async () => {
  const f = setup();
  await f.ownership.assignName({ name: '陈梦', userIds: [1] });
  await f.ownership.assignName({ name: '陈梦', userIds: [2] });
  assert.equal(f.ownership.profiles().length, 1);
  f.ownership.claim(ALICE, '本人');
  await assert.rejects(f.ownership.link({ identity: f.ownership.list()[0].identity, profileName: '陈' }), { code: 'INPUT' });
  await f.ownership.link({ identity: f.ownership.list()[0].identity, profileName: '陈梦' });
  assert.deepEqual((await f.ownership.query(ALICE)).users.map(u => u.id), [2]);
  await assert.rejects(f.ownership.assignName({ name: '非法', userIds: [3] }), { code: 'CONFLICT' });
  await assert.rejects(f.ownership.assignName({ name: '陈梦', userIds: [2, 2] }), { code: 'INPUT' });
  await f.ownership.assignName({ name: '陈梦', userIds: [1] });
  assert.deepEqual((await f.ownership.query(ALICE)).users.map(u => u.id), [1]);
  await f.ownership.assignName({ name: '另一个档案', userIds: [2] });
  await f.ownership.link({ identity: f.ownership.list()[0].identity, profileName: '另一个档案' });
  assert.deepEqual((await f.ownership.query(ALICE)).users.map(u => u.id), [2]);
  f.setUsers([{ id: 1, username: '其他', email: 'other@example.invalid', balance: 1, role: 'user', status: 'active' }]);
  await assert.rejects(f.ownership.query(ALICE), { code: 'SCHEMA' });
});
test('bound one-click query refuses a changed profile during a slow balance read', async () => {
  const f = setup(); await f.ownership.assignName({ name: '陈梦', userIds: [1] });
  f.ownership.claim(ALICE, '飞书成员');
  await f.ownership.link({ identity: f.ownership.list()[0].identity, profileName: '陈梦' });
  const original = f.ownership.users.bind(f.ownership);
  let release; f.ownership.users = () => new Promise(resolve => { release = resolve; });
  const pending = f.ownership.query(ALICE);
  f.ownership.users = original;
  await f.ownership.assignName({ name: '陈梦', userIds: [2] });
  release([{ id: 1, username: '旧用户', email: 'old@example.invalid', balance: 10, role: 'user', status: 'active' }]);
  await assert.rejects(pending, { code: 'POLICY' });
});
test('same display name never auto-links, and a profile cannot be bound to two identities', async () => {
  const f = setup();
  await f.ownership.assignName({ name: '同名', userIds: [1] });
  f.ownership.claim(ALICE, '同名'); f.ownership.claim(BOB, '同名');
  assert.equal(await f.ownership.query(ALICE), null);
  assert.equal(await f.ownership.query(BOB), null);
  await f.ownership.link({ identity: f.ownership.list()[0].identity, profileName: '同名' });
  await assert.rejects(f.ownership.link({ identity: f.ownership.list()[1].identity,
    profileName: '同名' }), { code: 'CONFLICT' });
  assert.deepEqual((await f.ownership.query(ALICE)).users.map(user => user.id), [1]);
  assert.equal(await f.ownership.query(BOB), null);
});
test('incomplete page or missing assigned account fails closed', async () => {
  const f = setup(); f.ownership.claim(ALICE, 'Alice');
  const identity = f.ownership.list()[0].identity;
  await f.ownership.assign({ identity, name: 'Alice', userIds: [1] });
  f.setUsers([{ id: 2, username: '其他', email: 'other@example.invalid', balance: 1, role: 'user', status: 'active' }]);
  await assert.rejects(f.ownership.query(ALICE), { code: 'SCHEMA' });
});
test('revocation during a slow balance read cannot deliver the old assignment', async () => {
  const f = setup(); f.ownership.claim(ALICE, 'Alice');
  const identity = f.ownership.list()[0].identity;
  await f.ownership.assign({ identity, name: 'Alice', userIds: [1] });
  const original = f.ownership.users.bind(f.ownership);
  let release; f.ownership.users = () => new Promise(resolve => { release = resolve; });
  const pending = f.ownership.query(ALICE);
  f.ownership.users = original;
  await f.ownership.assign({ identity, name: 'Alice', userIds: [] });
  release([{ id: 1, username: '旧用户', email: 'old@example.invalid', balance: 10, role: 'user', status: 'active' }]);
  await assert.rejects(pending, { code: 'POLICY' });
});
test('ownership journal is encrypted and damaged content fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-fixture-'));
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${value}`),
    decryptString: value => { const data = value.toString(); if (!data.startsWith('sealed:')) throw new Error('ciphertext'); return data.slice(7); } };
  try {
    const store = makeOwnershipStore(dir, safeStorage); assert.deepEqual(store.load(), []);
    store.save([{ owner: 1, groupId: GROUP, openId: ALICE, name: 'Alice', userIds: [1], state: 'assigned' }]);
    const file = path.join(dir, 'ownership.journal'), raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes(ALICE), false); assert.equal(raw.includes('Alice'), false);
    assert.equal(makeOwnershipStore(dir, safeStorage).load()[0].name, 'Alice');
    fs.appendFileSync(file, '{"sequence":2');
    assert.throws(() => makeOwnershipStore(dir, safeStorage).load(), { code: 'STORAGE' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('name-first profile and legacy assigned row both reload from encrypted journal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-profile-fixture-'));
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${value}`),
    decryptString: value => { const data = value.toString(); if (!data.startsWith('sealed:')) throw new Error('ciphertext'); return data.slice(7); } };
  try {
    const store = makeOwnershipStore(dir, safeStorage); store.load();
    store.save([{ owner: 1, groupId: GROUP, openId: ALICE, name: '旧绑定', userIds: [1], state: 'assigned' },
      { owner: 1, groupId: GROUP, openId: null, name: '新姓名', userIds: [2], state: 'profile' }]);
    const raw = fs.readFileSync(path.join(dir, 'ownership.journal'), 'utf8');
    assert.equal(raw.includes('新姓名') || raw.includes(ALICE), false);
    const rows = makeOwnershipStore(dir, safeStorage).load();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].state, 'assigned'); assert.equal(rows[1].state, 'profile');
    store.save([...rows, { owner: 1, groupId: GROUP, openId: BOB, name: '飞书显示名',
      profileName: '新姓名', userIds: [], state: 'linked' }]);
    assert.equal(makeOwnershipStore(dir, safeStorage).load().at(-1).profileName, '新姓名');
    assert.throws(() => store.save([...rows, { owner: 1, groupId: GROUP, openId: null,
      name: '新姓名', userIds: [], state: 'profile' }]), { code: 'STORAGE' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('ownership journal retains timestamped modification snapshots across reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-history-fixture-'));
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${value}`),
    decryptString: value => { const text = value.toString(); if (!text.startsWith('sealed:')) throw Error('cipher'); return text.slice(7); } };
  try {
    const store = makeOwnershipStore(dir, safeStorage); store.load();
    const profile = userIds => [{ owner: 1, groupId: GROUP, openId: null,
      name: '陈梦', userIds, state: 'profile' }];
    store.save(profile([1])); store.save(profile([1, 2]));
    const reopened = makeOwnershipStore(dir, safeStorage); assert.deepEqual(reopened.load(), profile([1, 2]));
    const history = reopened.history(1, GROUP);
    assert.deepEqual(history.map(row => row.userIds), [[1, 2], [1]]);
    assert.ok(history.every(row => Number.isFinite(Date.parse(row.at))));
    assert.equal(reopened.history(2, GROUP).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('bot reports detected Feishu name, waits for admin link, then one click queries own profile', async () => {
  const f = setup(), sent = [], cards = [];
  let n = 0; const policy = { enabled: true, ownerOpenId: OWNER, groupId: GROUP, platformOwnerId: 1,
    maxQuota: 20, maxUserDailyQuota: null, maxGroupDailyQuota: null };
  const workflow = new FeishuBotWorkflow({ userOwnership: f.ownership, service: { owner: 1, blocked: () => [], customerGroups: () => [] },
    getPolicy: () => policy, connection: { state: () => ({ phase: 'connected' }) },
    sendText: async message => { sent.push(message); }, sendCard: async message => { cards.push(message); return { messageId: `om_${++n}` }; },
    resolveActorName: async () => ({ displayName: 'Alice' }) });
  const event = (openId, group) => ({ sender: { sender_type: 'user', sender_id: { open_id: openId } },
    message: { message_id: `m_${++n}`, create_time: String(Date.now()), chat_id: group ? GROUP : 'oc_private_12345678',
      chat_type: group ? 'group' : 'p2p', message_type: 'text', content: JSON.stringify({ text: group ? '@bot' : '用户查询' }),
      mentions: group ? [{ key: '@bot' }] : [] } });
  await f.ownership.assignName({ name: '陈梦', userIds: [1, 2] });
  assert.equal((await workflow.handle(event(ALICE, false))).status, 'no-session');
  await workflow.handle(event(ALICE, true));
  assert.equal((await workflow.handle(event(ALICE, false))).status, 'ownership-pending');
  assert.ok(sent.at(-1).text.includes('飞书显示名：Alice'));
  assert.equal(sent.some(m => m.text.includes('余额：')), false);
  const nameEvent = (openId, name) => ({ sender: { sender_type: 'user', sender_id: { open_id: openId } },
    message: { message_id: `m_${++n}`, create_time: String(Date.now()), chat_id: 'oc_private_12345678',
      chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: name }) } });
  assert.equal((await workflow.handle(nameEvent(ALICE, '陈梦'))).status, 'no-session');
  assert.equal(sent.some(m => m.text.includes('余额：')), false);
  await f.ownership.link({ identity: f.ownership.list()[0].identity, profileName: '陈梦' });
  await workflow.handle(event(ALICE, true));
  assert.equal((await workflow.handle(event(ALICE, false))).status, 'user-query-delivered');
  const result = sent.at(-1); assert.equal(result.receiveId, ALICE);
  assert.ok(result.text.includes('飞书显示名：Alice'));
  assert.ok(result.text.indexOf('低余额') < result.text.indexOf('高余额'));
  assert.ok(result.text.includes('余额：1'));
  await workflow.handle(event(BOB, true));
  assert.equal((await workflow.handle(event(BOB, false))).status, 'ownership-pending');
  assert.equal(sent.filter(m => m.receiveId === BOB && m.text.includes('余额：')).length, 0);
  assert.equal((await workflow.handle(nameEvent(BOB, '陈梦'))).status, 'no-session');
  assert.equal(sent.filter(m => m.receiveId === BOB && m.text.includes('余额：')).length, 0);
  await f.ownership.assign({ identity: f.ownership.list().find(row => row.name === 'Alice' && row.state === 'pending').identity,
    name: '旧式本人归属', userIds: [1] });
  await workflow.handle(event(BOB, true));
  assert.equal((await workflow.handle(event(BOB, false))).status, 'user-query-delivered');
  assert.equal(sent.at(-1).receiveId, BOB);
  assert.ok(sent.at(-1).text.includes('旧式本人归属'));
  assert.ok(cards.length >= 2);
});
