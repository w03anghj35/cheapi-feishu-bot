'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { quotaUnits } = require('./service');
const { failureDiagnostic, failureHint } = require('./create-diagnostics');
const { requestCard, PAGE_SIZE } = require('./feishu-request-cards');
const { FEATURES, featureById, featureByText, isMenu } = require('./feishu-features');
const { registrationPrompt, advanceRegistration, registrationFormValues } = require('./feishu-registration-flow');
const menuNumber = text => /^[1-9]\d{0,2}$/.test(text) && Number(text) <= FEATURES.length;
const isRequest = text => /^\/?(?:创建令牌|申请令牌|发送令牌|领取令牌)$/.test(text);

const CODE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 10 * 60_000;
const RATE_WINDOW_MS = 5 * 60_000;
const MAX_STARTS_PER_WINDOW = 3;
const MAX_SEEN_EVENTS = 4096;
const MAX_PENDING_CHALLENGES = 512;
const MAX_ACTIVE_SESSIONS = 512;
const MAX_RATE_TRACKED_USERS = 8192;
const clean = (value, max = 80) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function textOf(message) {
  if (message?.message_type !== 'text' || typeof message.content !== 'string' || message.content.length > 8192) return '';
  try {
    const parsed = JSON.parse(message.content);
    if (typeof parsed?.text !== 'string') return '';
    let text = parsed.text;
    for (const mention of message.mentions || []) {
      if (typeof mention?.key === 'string' && mention.key.length <= 100) text = text.split(mention.key).join(' ');
    }
    return clean(text, 500);
  } catch { return ''; }
}

function operationId(chatId, messageId) {
  const hex = createHash('sha256').update(`feishu-key-create\0${chatId}\0${messageId}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function actorFromOpenId(openId) {
  if (typeof openId !== 'string' || !/^[\w:-]{4,256}$/.test(openId)) return null;
  const pseudonym = createHash('sha256').update(openId).digest('hex').slice(0, 20);
  return { name: `飞书用户#${pseudonym}`, source: 'feishu-open-id', verified: true };
}

class FeishuBotWorkflow {
  constructor({ getPolicy, service, registrationService = null, sendText, sendCard = null, connection = null, now = () => Date.now(), random = () => randomBytes(12).toString('base64url'), onCandidate = () => {} }) {
    this.getPolicy = getPolicy;
    this.service = service;
    this.registrationService = registrationService;
    this.sendText = sendText;
    this.sendCard = sendCard;
    this.queuedCards = 0;
    this.connection = connection;
    this.now = now;
    this.random = random;
    this.onCandidate = onCandidate;
    this.codes = new Map();
    this.sessions = new Map();
    this.starts = new Map();
    this.seen = new Map();
    this.ownerChallenge = null;
    this.ownerCandidate = null;
    this.groupChallenge = null;
    this.groupCandidate = null;
    this.lastCapacityNoticeAt = 0;
    this.tail = Promise.resolve();
  }

  policy() {
    const p = this.getPolicy?.();
    if (this.connection && this.connection.state?.().phase !== 'connected') return null;
    if (!p || p.enabled !== true || typeof p.ownerOpenId !== 'string' || !/^[\w:-]{4,256}$/.test(p.ownerOpenId) ||
        typeof p.groupId !== 'string' || !/^oc_[\w-]{8,128}$/.test(p.groupId) ||
        !Number.isSafeInteger(p.platformOwnerId) || p.platformOwnerId <= 0 || this.service?.owner !== p.platformOwnerId ||
        !Number.isFinite(p.maxQuota) || p.maxQuota <= 0 ||
        !(p.maxUserDailyQuota === null || (Number.isFinite(p.maxUserDailyQuota) && p.maxUserDailyQuota > 0)) ||
        !(p.maxGroupDailyQuota === null || (Number.isFinite(p.maxGroupDailyQuota) && p.maxGroupDailyQuota > 0))) return null;
    return p;
  }

  startOwnerBinding() {
    const code = this.random();
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) throw new Error('invalid challenge');
    this.ownerChallenge = { code, expiresAt: this.now() + CODE_TTL_MS };
    this.ownerCandidate = null;
    return { code, expiresAt: this.ownerChallenge.expiresAt };
  }

  startGroupBinding() {
    const policy = this.getPolicy?.();
    if (!policy?.ownerOpenId || !/^[\w:-]{4,256}$/.test(policy.ownerOpenId)) throw new Error('owner not bound');
    const code = this.random();
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) throw new Error('invalid challenge');
    this.groupChallenge = { code, ownerOpenId: policy.ownerOpenId, expiresAt: this.now() + CODE_TTL_MS };
    this.groupCandidate = null;
    return { code, expiresAt: this.groupChallenge.expiresAt };
  }

  confirmOwnerCandidate() {
    if (!this.ownerCandidate || this.ownerCandidate.expiresAt <= this.now()) { this.ownerCandidate = null; throw new Error('candidate expired'); }
    const result = this.ownerCandidate.openId;
    this.ownerCandidate = null;
    return result;
  }

  confirmGroupCandidate() {
    if (!this.groupCandidate || this.groupCandidate.expiresAt <= this.now()) { this.groupCandidate = null; throw new Error('candidate expired'); }
    const result = this.groupCandidate.groupId;
    this.groupCandidate = null;
    return result;
  }

  state() {
    const p = this.getPolicy?.() || {};
    const platformAccountId = Number.isSafeInteger(this.service?.owner) && this.service.owner > 0 ? this.service.owner : null;
    const platformAccountMatches = platformAccountId !== null && platformAccountId === p.platformOwnerId;
    const candidate = c => c && c.expiresAt > this.now() ? { label: c.label, expiresAt: c.expiresAt } : null;
    return { enabled: this.policy() !== null, configuredEnabled: p.enabled === true, platformAccountId, platformAccountMatches,
      ownerBound: Boolean(p.ownerOpenId),
      ownerLabel: p.ownerOpenId ? actorFromOpenId(p.ownerOpenId)?.name || '已绑定' : null,
      groupBound: Boolean(p.groupId), groupLabel: p.groupId ? `群组已绑定 · ${createHash('sha256').update(p.groupId).digest('hex').slice(0, 8)}` : null,
      policy: { enabled: p.enabled === true, platformOwnerId: p.platformOwnerId ?? null, maxQuota: p.maxQuota ?? null,
        maxUserDailyQuota: p.maxUserDailyQuota ?? null, maxGroupDailyQuota: p.maxGroupDailyQuota ?? null },
      ownerCandidate: candidate(this.ownerCandidate),
      groupCandidate: this.groupCandidate && this.groupCandidate.expiresAt > this.now()
        ? { ...candidate(this.groupCandidate), groupId: this.groupCandidate.groupId } : null,
      connection: this.connection?.state?.() || null };
  }

  setBindingChallenge(code) {
    if (!/^[A-F0-9]{16}$/.test(code)) throw new Error('invalid challenge');
    this.groupChallenge = { code, ownerOpenId: this.getPolicy?.()?.ownerOpenId, expiresAt: this.now() + CODE_TTL_MS };
    this.groupCandidate = null;
  }

  discardSession(openId) {
    const session = this.sessions.get(openId);
    if (session?.registration) delete session.registration.password;
    this.sessions.delete(openId);
  }

  upgradeSession(session, policy) {
    if (!session || session.groupId !== policy.groupId || (session.quick && session.policy !== policy)) return null;
    if (!session.quick) {
      const cardToken = this.random();
      if (typeof cardToken !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(cardToken)) return null;
      Object.assign(session, { quick: true, policy, cardToken, page: 0 });
    }
    return session;
  }

  reset() { this.codes.clear(); for (const openId of this.sessions.keys()) this.discardSession(openId); this.starts.clear(); this.ownerChallenge = null; this.ownerCandidate = null; this.groupChallenge = null; this.groupCandidate = null; }

  handle(event) {
    const run = this.tail.then(() => this.handleMessage(event));
    this.tail = run.catch(() => {});
    return run;
  }

  remember(id) {
    if (!id || this.seen.has(id)) return false;
    const now = this.now();
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
    if (this.seen.size >= MAX_SEEN_EVENTS) this.seen.delete(this.seen.keys().next().value);
    this.seen.set(id, now + SESSION_TTL_MS);
    return true;
  }

  pruneTransientState() {
    const now = this.now();
    for (const [code, pending] of this.codes) if (!pending || pending.expiresAt <= now) this.codes.delete(code);
    for (const [openId, session] of this.sessions) if (!session || session.expiresAt <= now) this.discardSession(openId);
    // starts is ordered by each identity's last attempt; expire only its old prefix.
    while (this.starts.size) {
      const [openId, times] = this.starts.entries().next().value;
      if (times.at(-1) + RATE_WINDOW_MS > now) break;
      this.starts.delete(openId);
    }
    if (this.ownerChallenge?.expiresAt <= now) this.ownerChallenge = null;
    if (this.ownerCandidate?.expiresAt <= now) this.ownerCandidate = null;
    if (this.groupChallenge?.expiresAt <= now) this.groupChallenge = null;
    if (this.groupCandidate?.expiresAt <= now) this.groupCandidate = null;
  }

  rateAllowed(openId) {
    const now = this.now();
    const times = (this.starts.get(openId) || []).filter(t => t + RATE_WINDOW_MS > now);
    if (times.length >= MAX_STARTS_PER_WINDOW) {
      this.starts.delete(openId); this.starts.set(openId, times); return false;
    }
    if (!this.starts.has(openId) && this.starts.size >= MAX_RATE_TRACKED_USERS) return false;
    times.push(now); this.starts.delete(openId); this.starts.set(openId, times);
    return true;
  }

  async capacityNotice(chatId) {
    const now = this.now();
    if (now - this.lastCapacityNoticeAt < 60_000) return;
    this.lastCapacityNoticeAt = now;
    await this.send('chat_id', chatId, '当前申请人数较多，请稍后再试；本次未创建令牌。');
  }

  async send(type, id, text) {
    if (!this.sendText || typeof id !== 'string' || !id) return false;
    try { await this.sendText({ receiveIdType: type, receiveId: id, text }); return true; }
    catch { return false; }
  }

  async promptQuick(openId, session, policy) {
    // Invalidate old controls before sending; an uncertain card delivery cannot enable its buttons.
    session.cardMessageId = null;
    try {
      const sent = await this.sendCard({ receiveIdType: 'open_id', receiveId: openId, card: requestCard(session, policy.maxQuota) });
      if (this.sessions.get(openId) !== session || this.policy() !== policy) return false;
      if (typeof sent?.messageId === 'string' && sent.messageId && sent.messageId.length <= 256) {
        session.cardMessageId = sent.messageId;
        return true;
      }
    } catch { /* Card permissions/schema/network may fail; use the same authorized text session. */ }
    if (this.sessions.get(openId) !== session || this.policy() !== policy) return false;
    let text;
    if (session.state === 'menu') {
      text = '请选择功能：\n' + FEATURES.map((feature, i) => `${i + 1}. ${feature.label}`).join('\n') + '\n回复功能编号或名称，或发送“取消”。';
    } else if (session.state.startsWith('register-')) {
      text = registrationPrompt(session);
    } else if (session.state === 'group') {
      const first = (session.page || 0) * PAGE_SIZE;
      text = '请选择分组编号（无需验证码）：\n' + session.groups.slice(first, first + PAGE_SIZE)
        .map((group, i) => `${first + i + 1}. ${clean(group.name, 60)}`).join('\n') + '\n可发送“上一页”“下一页”或“取消”。';
    } else if (session.state === 'quota') {
      text = `已选择「${clean(session.selectedGroup.name, 60)}」。请直接回复额度（大于 0，最多 ${policy.maxQuota}），或发送“重选分组”“取消”。`;
    } else {
      text = `请核对：分组「${clean(session.selectedGroup.name, 60)}」，额度 ${session.quota}。回复“确认”才创建，或回复“修改额度”“取消”。`;
    }
    return this.send('open_id', openId, text);
  }

  async startMenu(event, openId, policy) {
    const chatId = event.message.chat_id;
    if (!this.rateAllowed(openId)) {
      await this.send('chat_id', chatId, '操作较频繁，请稍后再试；已有业务可在机器人私聊继续。');
      return { status: 'rate-limited' };
    }
    let session = this.sessions.get(openId);
    if (session && !this.upgradeSession(session, policy)) {
      this.discardSession(openId); session = null;
    }
    if (!session) {
      if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
        await this.capacityNotice(chatId); return { status: 'capacity' };
      }
      const cardToken = this.random();
      if (typeof cardToken !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(cardToken)) return { status: 'random-error' };
      session = { quick: true, policy, cardToken, state: 'menu', groupId: policy.groupId,
        requestId: operationId(chatId, event.message.message_id), expiresAt: this.now() + SESSION_TTL_MS };
      this.sessions.set(openId, session);
    }
    // Repeated mentions resume an unfinished request instead of silently discarding it.
    const sent = await this.promptQuick(openId, session, policy);
    await this.send('chat_id', chatId, sent
      ? '已将功能菜单或您未完成的业务发到机器人私聊，请打开私聊继续；不要在群里填写密码或密钥。'
      : '请先打开机器人头像 → 发消息／开启单聊，再在私聊发送“菜单”。本次群授权 10 分钟内有效；不要在群里填写密码或密钥。');
    return { status: sent ? 'menu-started' : 'private-chat-required' };
  }

  async selectFeature(openId, session, policy, featureId) {
    const feature = featureById(featureId);
    if (!feature || session.state !== 'menu') return { status: 'invalid-feature' };
    if (feature.id === 'register') {
      if (!this.registrationService || this.registrationService.storageFault || this.registrationService.blocked().length) {
        await this.send('open_id', openId, '用户注册暂不可用或有结果待管理员核对，请勿发送密码；令牌创建不受此注册保护影响。');
        return { status: 'feature-unavailable', featureId: feature.id };
      }
      Object.assign(session, { featureId: feature.id, state: 'register-form', registrationInput: 'card', registration: {} });
      await this.promptQuick(openId, session, policy);
      return { status: 'feature-selected', featureId: feature.id };
    }
    if (feature.id !== 'token') return { status: 'feature-unavailable', featureId: feature.id };
    if (this.service.blocked().length) {
      await this.send('open_id', openId, '当前有一笔令牌结果待管理员核对，暂不接受新申请；不会自动重复创建。');
      return { status: 'business-locked' };
    }
    const groups = this.service.customerGroups();
    if (!groups.length) {
      await this.send('open_id', openId, '当前没有管理员发布的分组，请联系管理员；可发送“菜单”继续查看功能。');
      return { status: 'no-groups' };
    }
    Object.assign(session, { groups, page: 0, state: 'group', featureId: feature.id });
    await this.promptQuick(openId, session, policy);
    return { status: 'feature-selected', featureId: feature.id };
  }

  async startQuick(event, openId, policy) {
    const chatId = event.message.chat_id;
    if (!this.rateAllowed(openId)) {
      await this.send('chat_id', chatId, '申请较频繁，请稍后再试；若已有申请，请打开机器人私聊继续。');
      return { status: 'rate-limited' };
    }
    if (this.service.blocked().length) {
      await this.send('chat_id', chatId, '当前有一笔令牌结果待管理员核对，暂不接受新申请；不会自动重复创建。');
      return { status: 'business-locked' };
    }
    let session = this.sessions.get(openId);
    if (session && !this.upgradeSession(session, policy)) { this.discardSession(openId); session = null; }
    if (!session) {
      if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
        await this.capacityNotice(chatId); return { status: 'capacity' };
      }
      const groups = this.service.customerGroups();
      if (!groups.length) { await this.send('chat_id', chatId, '当前没有管理员发布的分组，请联系管理员。'); return { status: 'no-groups' }; }
      const cardToken = this.random();
      if (typeof cardToken !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(cardToken)) return { status: 'random-error' };
      session = { quick: true, policy, cardToken, groups, page: 0, state: 'group', groupId: policy.groupId,
        requestId: operationId(chatId, event.message.message_id), expiresAt: this.now() + SESSION_TTL_MS };
      this.sessions.set(openId, session);
    }
    if (session.state === 'menu') return this.selectFeature(openId, session, policy, 'token');
    const sent = await this.promptQuick(openId, session, policy);
    await this.send('chat_id', chatId, sent
      ? '已把分组和额度选择发到您的机器人私聊，点机器人头像即可打开；无需复制验证码，密钥不会发到群里。'
      : '请点机器人头像 → 发消息／开启单聊，在私聊发送“发送令牌”即可选择分组和额度，无需复制验证码。申请 10 分钟内有效。');
    // Keep the sender-bound group authorization if first-contact external-user DM is unavailable.
    return { status: sent ? 'quick-started' : 'private-chat-required' };
  }

  cardContext(event) {
    const openId = event?.operator?.open_id;
    const chatId = event?.context?.open_chat_id;
    const messageId = event?.context?.open_message_id;
    const value = event?.action?.value;
    const policy = this.policy();
    const session = this.sessions.get(openId);
    if (!policy || !session?.quick || session.policy !== policy || session.groupId !== policy.groupId ||
        session.expiresAt <= this.now() || !actorFromOpenId(openId) ||
        typeof chatId !== 'string' || !/^oc_[\w-]{8,128}$/.test(chatId) || chatId === policy.groupId ||
        (session.privateChatId && session.privateChatId !== chatId) ||
        !session.cardMessageId || session.cardMessageId !== messageId ||
        value?.keyTool !== 'request-v1' || value.requestId !== session.requestId || value.nonce !== session.cardToken ||
        !['group', 'quota', 'confirm', 'cancel', 'back', 'edit', 'page', 'custom', 'feature', 'balance', 'register-confirm', 'register-submit', 'register-edit'].includes(value.action) ||
        (value.action === 'register-submit' && (session.state !== 'register-form' || session.featureId !== 'register')) ||
        (value.action === 'register-edit' && (session.state !== 'register-confirm' || session.registrationInput !== 'card')) ||
        (value.action === 'feature' && (session.state !== 'menu' || !featureById(value.featureId)))) return null;
    return { openId, chatId, policy, session, value };
  }

  handleCard(event) {
    // Acknowledge synchronously: never hold Feishu's callback open while creating a remote key.
    const context = this.cardContext(event);
    if (!context) return { toast: { type: 'warning', content: '此按钮不属于您的当前申请或已过期。请从群里 @机器人继续当前业务。' } };
    if (this.queuedCards >= MAX_ACTIVE_SESSIONS) return { toast: { type: 'warning', content: '当前操作较多，请稍后查看私聊。' } };
    let registration;
    if (context.value.action === 'register-submit') {
      if (event.action.tag !== 'button' || event.action.name !== 'registration_submit')
        return { toast: { type: 'error', content: '请使用注册表单中的“下一步：核对信息”按钮。' } };
      try { registration = registrationFormValues(event.action.form_value); }
      catch (error) { return { toast: { type: 'error', content: error.message } }; }
    }
    // Queue only validated data, not the SDK event or unrelated form fields. Its secret
    // reference is cleared even if policy changes, the session expires, or a send fails.
    const queuedEvent = { operator: { open_id: context.openId },
      context: { open_chat_id: context.chatId, open_message_id: context.session.cardMessageId },
      action: { value: Object.fromEntries(['keyTool', 'requestId', 'nonce', 'action', 'featureId', 'balance', 'index', 'quota', 'page']
        .filter(key => Object.hasOwn(context.value, key)).map(key => [key, context.value[key]])) } };
    this.queuedCards++;
    const run = this.tail.then(() => this.handleCardAction(queuedEvent, registration));
    this.tail = run.catch(async () => {
      // An unexpected error never triggers a second create or an automatic key resend.
      await this.send('open_id', queuedEvent.operator.open_id, '操作未能确认，请联系管理员检查记录，不要重复创建。');
    }).finally(() => { if (registration) delete registration.password; registration = null; this.queuedCards--; });
    return { toast: { type: 'info', content: '已收到，请查看机器人私聊。' } };
  }

  async handleCardAction(event, registration = null) {
    this.pruneTransientState();
    const context = this.cardContext(event);
    if (!context) return { status: 'invalid-card' };
    const { openId, chatId, session, value, policy } = context;
    session.privateChatId = chatId;
    const message = { message: { chat_id: chatId } };
    if (value.action === 'cancel') return this.handleP2P(message, openId, '取消');
    if (value.action === 'feature') return this.selectFeature(openId, session, policy, value.featureId);
    if (value.action === 'register-submit' && registration && session.state === 'register-form') {
      session.registration = { ...registration };
      session.state = 'register-confirm';
      await this.promptQuick(openId, session, policy);
      return { status: 'registration-awaiting-confirmation' };
    }
    if (value.action === 'register-edit' && session.state === 'register-confirm') {
      delete session.registration.password;
      session.state = 'register-form';
      await this.promptQuick(openId, session, policy);
      return { status: 'registration-editing' };
    }
    if (value.action === 'balance' && session.state === 'register-balance' && typeof value.balance === 'string') return this.handleP2P(message, openId, value.balance);
    if (value.action === 'register-confirm' && session.state === 'register-confirm') return this.handleP2P(message, openId, '确认');
    if (value.action === 'group' && session.state === 'group' && Number.isSafeInteger(value.index) && value.index >= 0 && value.index < session.groups.length)
      return this.handleP2P(message, openId, String(value.index + 1));
    if (value.action === 'quota' && session.state === 'quota' && typeof value.quota === 'string') return this.handleP2P(message, openId, value.quota);
    if (value.action === 'confirm' && session.state === 'confirm') return this.handleP2P(message, openId, '确认');
    if (value.action === 'back' && session.state === 'quota') return this.handleP2P(message, openId, '重选分组');
    if (value.action === 'edit' && session.state === 'confirm') return this.handleP2P(message, openId, '修改额度');
    if (value.action === 'page' && session.state === 'group' && Number.isSafeInteger(value.page) && value.page >= 0 && value.page < Math.ceil(session.groups.length / PAGE_SIZE)) {
      session.page = value.page;
      await this.promptQuick(openId, session, policy); return { status: 'page-changed' };
    }
    if (value.action === 'custom' && session.state === 'quota') {
      await this.send('open_id', openId, `请直接在本私聊回复金额（例如 2.5），必须大于 0 且最多 ${policy.maxQuota}。`);
      return { status: 'custom-quota' };
    }
    return { status: 'invalid-card-action' };
  }

  async handleMessage(event) {
    this.pruneTransientState();
    const message = event?.message;
    const sender = event?.sender;
    const openId = sender?.sender_id?.open_id;
    const messageId = message?.message_id;
    if (sender?.sender_type !== 'user' || !actorFromOpenId(openId) || typeof messageId !== 'string' || !messageId || messageId.length > 256) return { status: 'ignored' };
    const timestamp = Number(message.create_time);
    if (!Number.isFinite(timestamp) || Math.abs(timestamp - this.now()) > CODE_TTL_MS) return { status: 'stale' };
    const eventId = event?.header?.event_id;
    const dedupId = typeof eventId === 'string' && eventId.length <= 256 ? eventId : `${message.chat_id}:${messageId}`;
    if (!this.remember(dedupId)) return { status: 'duplicate' };
    const text = textOf(message);
    // A valid text containing only the bot mention is the new menu entry point.
    // Non-text/malformed events must not acquire authorization merely by carrying mentions.
    let validText = false;
    if (message.message_type === 'text' && typeof message.content === 'string' && message.content.length <= 8192) {
      try { validText = typeof JSON.parse(message.content)?.text === 'string'; } catch { /* ignore malformed input */ }
    }
    const registrationText = validText && message.chat_type === 'p2p' && this.sessions.get(openId)?.featureId === 'register';
    if (!text && !registrationText && !(validText && message.chat_type === 'group' && message.mentions?.length)) return { status: 'ignored' };

    if (message.chat_type === 'group') return this.handleGroup(event, openId, text);
    if (message.chat_type === 'p2p') return this.handleP2P(event, openId, text, JSON.parse(message.content).text);
    return { status: 'ignored' };
  }

  async handleGroup(event, openId, text) {
    const message = event.message;
    const chatId = message.chat_id;
    if (typeof chatId !== 'string' || !/^oc_[\w-]{8,128}$/.test(chatId) || !(message.mentions || []).length) return { status: 'ignored' };
    if (this.groupChallenge && this.groupChallenge.expiresAt > this.now() && this.groupChallenge.ownerOpenId === openId &&
        text === `/绑定机器人 ${this.groupChallenge.code}`) {
      this.groupCandidate = { groupId: chatId, label: actorFromOpenId(openId).name, expiresAt: this.now() + CODE_TTL_MS };
      this.groupChallenge = null;
      this.onCandidate({ type: 'group', ...this.groupCandidate });
      return { status: 'binding-candidate' };
    }
    const policy = this.policy();
    if (!policy || chatId !== policy.groupId) {
      return { status: policy ? 'group-denied' : 'disabled' };
    }
    if (!isRequest(text)) return this.startMenu(event, openId, policy);
    if (typeof this.sendCard === 'function') return this.startQuick(event, openId, policy);
    const prior = this.sessions.get(openId);
    if (prior && prior.expiresAt > this.now()) return { status: 'session-active' };
    if ([...this.codes.values()].some(pending => pending.openId === openId && pending.groupId === chatId)) {
      return { status: 'challenge-active' };
    }
    if (this.codes.size >= MAX_PENDING_CHALLENGES) {
      await this.capacityNotice(chatId);
      return { status: 'capacity' };
    }
    if (!this.rateAllowed(openId)) return { status: 'rate-limited' };
    if (this.service.blocked().length) {
      await this.send('chat_id', chatId, '当前有一笔令牌结果待管理员核对，暂不接受新申请；不会自动重复创建。');
      return { status: 'business-locked' };
    }
    const code = this.random();
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return { status: 'random-error' };
    this.codes.set(code, { openId, groupId: chatId, requestId: operationId(chatId, message.message_id), expiresAt: this.now() + CODE_TTL_MS, attempts: 0 });
    const sent = await this.send('chat_id', chatId, `已发起私聊申请流程。请打开机器人私聊，发送：/继续 ${code}\n验证码仅绑定发起人，5 分钟有效；本群不会显示额度或令牌密钥。`);
    if (!sent) this.codes.delete(code);
    return { status: sent ? 'challenge-issued' : 'challenge-delivery-failed' };
  }

  async handleRegistration(openId, session, policy, raw) {
    if (session.state === 'register-form') {
      if (raw === '重新显示表单') await this.promptQuick(openId, session, policy);
      else await this.send('open_id', openId, registrationPrompt(session));
      return { status: 'registration-form-required' };
    }
    if (session.state !== 'register-confirm') {
      try { advanceRegistration(session, raw); }
      catch (error) {
        // Only validators from our module can reach this branch; no input echo.
        await this.send('open_id', openId, error.message);
        return { status: 'invalid-registration-input' };
      }
      await this.promptQuick(openId, session, policy);
      return { status: session.state === 'register-confirm' ? 'registration-awaiting-confirmation' : 'registration-step' };
    }
    if (raw !== '确认') { await this.send('open_id', openId, '请点击“确认注册”或回复“确认”，也可发送“取消”。'); return { status: 'registration-awaiting-confirmation' }; }
    // Remove the password from the conversation before awaiting external services.
    const input = { ...session.registration, requestId: session.requestId };
    delete session.registration.password;
    session.cardMessageId = null;
    try {
      const result = await this.registrationService.create(input, {
        verifiedActor: actorFromOpenId(openId), feishuGroupId: session.groupId,
        guard: () => this.policy() === policy && this.sessions.get(openId) === session && session.expiresAt > this.now()
      });
      const sent = await this.send('open_id', openId, '账号已创建。\n网址：https://max.cheapi.cc/\n账号：' + result.email + '\n用户名：' + result.username + '\n角色：普通用户\n并发数：' + result.concurrency + '\n初始余额：' + result.balance + '\n密码为您刚设置的密码，不再回显。');
      return { status: sent ? 'registered-and-delivered' : 'registered-delivery-unknown' };
    } catch (error) {
      const code = ['INPUT','AUTH','DENIED','POLICY','BUSY','STORAGE','DUPLICATE','UNKNOWN','HTTP','API','NETWORK','SCHEMA','OPERATION_ERROR'].includes(error?.code) ? error.code : 'OPERATION_ERROR';
      await this.send('open_id', openId, '注册结果未能确认，请联系管理员核对；不要重复申请。\n错误编号：' + code + '\n操作编号：' + session.requestId);
      return { status: 'registration-failed', code };
    } finally { delete input.password; this.discardSession(openId); }
  }

  async handleP2P(event, openId, text, raw = text) {
    const message = event.message;
    const chatId = message.chat_id;
    if (typeof chatId !== 'string' || !/^oc_[\w-]{8,128}$/.test(chatId)) return { status: 'ignored' };
    const ownerMatch = text.match(/^\/绑定管理员 ([A-Za-z0-9_-]{16,64})$/);
    if (this.sessions.get(openId)?.featureId !== 'register' && ownerMatch && this.ownerChallenge && this.ownerChallenge.expiresAt > this.now() && ownerMatch[1] === this.ownerChallenge.code) {
      this.ownerCandidate = { openId, label: actorFromOpenId(openId).name, expiresAt: this.now() + CODE_TTL_MS };
      this.ownerChallenge = null;
      this.onCandidate({ type: 'owner', label: this.ownerCandidate.label, expiresAt: this.ownerCandidate.expiresAt });
      return { status: 'owner-candidate' };
    }
    const policy = this.policy();
    if (!policy) { this.discardSession(openId); return { status: 'disabled' }; }
    const quick = this.sessions.get(openId);
    if (quick && (quick.expiresAt <= this.now() || quick.groupId !== policy.groupId)) { this.discardSession(openId); return { status: 'no-session' }; }
    if (quick?.quick && quick.policy !== policy) { this.discardSession(openId); return { status: 'policy-changed' }; }
    if (quick?.featureId === 'register') {
      if (quick.privateChatId && quick.privateChatId !== chatId) return { status: 'private-chat-mismatch' };
      quick.privateChatId = chatId;
      if (raw === '取消') { this.discardSession(openId); await this.send('open_id', openId, '注册已取消，未创建账号。'); return { status: 'cancelled' }; }
      return this.handleRegistration(openId, quick, policy, raw);
    }
    if (isMenu(text) || (quick?.state === 'menu' && (featureByText(text) || menuNumber(text)))) {
      if (!quick?.quick || quick.groupId !== policy.groupId || quick.expiresAt <= this.now()) {
        this.discardSession(openId);
        await this.send('open_id', openId, '请先在指定群 @机器人，再回到本私聊发送“菜单”。');
        return { status: 'group-entry-required' };
      }
      if (quick.privateChatId && quick.privateChatId !== chatId) return { status: 'private-chat-mismatch' };
      quick.privateChatId = chatId;
      if (quick.state !== 'menu') {
        await this.send('open_id', openId, '您有尚未完成的业务，请先继续或发送“取消”；回到群里重新 @机器人后可选择其他功能。');
        return { status: 'session-active' };
      }
      if (isMenu(text)) {
        const sent = await this.promptQuick(openId, quick, policy);
        return { status: sent ? 'menu-resumed' : 'private-prompt-failed' };
      }
      const feature = featureByText(text) || FEATURES[Number(text) - 1];
      return this.selectFeature(openId, quick, policy, feature.id);
    }
    if (isRequest(text) && typeof this.sendCard === 'function') {
      if (!quick || quick.groupId !== policy.groupId || quick.expiresAt <= this.now()) {
        this.discardSession(openId);
        await this.send('open_id', openId, '请先在指定群 @机器人发送“发送令牌”，然后回到本私聊选择分组和额度；无需验证码。');
        return { status: 'group-entry-required' };
      }
      if (!quick.quick) {
        // Upgrade an already authorized legacy conversation without replacing its operation ID.
        const cardToken = this.random();
        if (typeof cardToken !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(cardToken)) return { status: 'random-error' };
        Object.assign(quick, { quick: true, policy, cardToken, page: 0 });
      }
      if (quick.privateChatId && quick.privateChatId !== chatId) return { status: 'private-chat-mismatch' };
      quick.privateChatId = chatId;
      if (quick.state === 'menu') return this.selectFeature(openId, quick, policy, 'token');
      const sent = await this.promptQuick(openId, quick, policy);
      return { status: sent ? 'quick-resumed' : 'private-prompt-failed' };
    }
    const match = text.match(/^\/继续 ([A-Za-z0-9_-]{16,64})$/);
    if (!this.sessions.has(openId) && match) {
      const pending = this.codes.get(match[1]);
      if (!pending || pending.expiresAt <= this.now() || pending.openId !== openId || pending.groupId !== policy.groupId) {
        await this.send('open_id', openId, '验证码无效、已过期或属于其他发起人。请回到指定群重新 @机器人申请。');
        return { status: 'challenge-invalid' };
      }
      if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
        await this.send('open_id', openId, '当前申请较多，请稍后在本私聊中重发同一验证码；验证码仍绑定您本人且有效期为 5 分钟。');
        return { status: 'capacity' };
      }
      const groups = this.service.customerGroups();
      this.codes.delete(match[1]);
      if (!groups.length) {
        await this.send('open_id', openId, '当前没有管理员发布的可选分组，请联系管理员。');
        return { status: 'no-groups' };
      }
      this.sessions.set(openId, { groupId: pending.groupId, requestId: pending.requestId, groups, state: 'group', expiresAt: this.now() + SESSION_TTL_MS });
      const list = groups.map((g, i) => `${i + 1}. ${clean(g.name, 60)}`).join('\n');
      if (!await this.send('open_id', openId, `已验证您从指定群发起申请。请选择分组编号：\n${list}\n流程 10 分钟内有效；额度和密钥仅在私聊中处理。`)) {
        this.discardSession(openId); return { status: 'private-prompt-failed' };
      }
      return { status: 'session-started' };
    }

    const session = this.sessions.get(openId);
    if (!session || session.expiresAt <= this.now() || session.groupId !== policy.groupId) {
      this.discardSession(openId);
      if (featureByText(text)) await this.send('open_id', openId, '请先在指定群 @机器人，再回到本私聊选择功能。');
      return { status: 'no-session' };
    }
    if (text === '取消') { this.discardSession(openId); await this.send('open_id', openId, '申请已取消，未创建账号或令牌。'); return { status: 'cancelled' }; }
    if (session.state === 'menu') {
      await this.send('open_id', openId, '请选择菜单中的功能编号或名称，或发送“取消”。请勿发送密码。');
      return { status: 'invalid-feature' };
    }
    if (session.quick) {
      if (session.privateChatId && session.privateChatId !== chatId) return { status: 'private-chat-mismatch' };
      session.privateChatId = chatId;
      if ((text === '重选分组' && session.state === 'quota') || (text === '修改额度' && session.state === 'confirm')) {
        session.state = text === '重选分组' ? 'group' : 'quota';
        delete session.quota;
        if (session.state === 'group') delete session.selectedGroup;
        await this.promptQuick(openId, session, policy); return { status: 'step-changed' };
      }
      if (session.state === 'group' && ['上一页', '下一页'].includes(text)) {
        session.page = Math.max(0, Math.min(Math.ceil(session.groups.length / PAGE_SIZE) - 1, (session.page || 0) + (text === '下一页' ? 1 : -1)));
        await this.promptQuick(openId, session, policy); return { status: 'page-changed' };
      }
    }
    if (session.state === 'group') {
      const index = Number(text);
      if (!Number.isSafeInteger(index) || index < 1 || index > session.groups.length) {
        await this.send('open_id', openId, '请输入列表中的分组编号，或发送“取消”。'); return { status: 'invalid-group' };
      }
      const selected = session.groups[index - 1];
      session.selectedGroup = { id: selected.id, name: selected.name };
      session.state = 'quota';
      if (session.quick) { await this.promptQuick(openId, session, policy); return { status: 'group-selected' }; }
      if (!await this.send('open_id', openId, `已选择「${clean(selected.name, 60)}」。请输入必填额度（大于 0，最多 ${policy.maxQuota}）；发送“取消”可退出。`)) {
        this.discardSession(openId); return { status: 'private-prompt-failed' };
      }
      return { status: 'group-selected' };
    }
    if (session.state === 'quota') {
      if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/.test(text)) {
        await this.send('open_id', openId, '额度格式无效，请输入正数额度，不能超过管理员设置上限。'); return { status: 'invalid-quota' };
      }
      const quota = Number(text);
      if (!Number.isFinite(quota) || quota <= 0 || quota > policy.maxQuota) {
        await this.send('open_id', openId, `额度必须大于 0 且不超过 ${policy.maxQuota}。`); return { status: 'quota-out-of-range' };
      }
      session.quota = quota;
      session.state = 'confirm';
      if (session.quick) { await this.promptQuick(openId, session, policy); return { status: 'awaiting-confirmation' }; }
      if (!await this.send('open_id', openId, `请核对：分组「${clean(session.selectedGroup.name, 60)}」，额度 ${quota}。回复“确认”才会创建；回复“取消”不创建。`)) {
        this.discardSession(openId); return { status: 'private-prompt-failed' };
      }
      return { status: 'awaiting-confirmation' };
    }
    if (session.state !== 'confirm') return { status: 'ignored' };
    if (text !== '确认') { await this.send('open_id', openId, '请回复“确认”执行一次创建，或回复“取消”。'); return { status: 'awaiting-confirmation' }; }
    if (this.service.records.some(r => r.requestId === session.requestId)) {
      this.discardSession(openId);
      await this.send('open_id', openId, '这条群申请已存在创建记录，不会再次创建或重发密钥。如未收到结果，请联系管理员核对本机记录。');
      return { status: 'already-recorded' };
    }
    const actor = actorFromOpenId(openId);
    if (!actor) { this.discardSession(openId); return { status: 'invalid-identity' }; }
    const day = value => new Date(value + 8 * 3600_000).toISOString().slice(0, 10);
    const today = day(this.now());
    const rows = this.service.records.filter(r => r.operator?.source === 'feishu-open-id' &&
      r.feishuGroupId === session.groupId && ['pending', 'unknown', 'success', 'reviewed'].includes(r.state) &&
      Number.isFinite(Date.parse(r.at)) && day(Date.parse(r.at)) === today);
    let quota;
    try {
      const sum = records => records.reduce((n, r) => n + quotaUnits(r.body?.quota), 0n);
      quota = quotaUnits(session.quota);
      if (quota > quotaUnits(policy.maxQuota) ||
          (policy.maxGroupDailyQuota !== null && sum(rows) + quota > quotaUnits(policy.maxGroupDailyQuota)) ||
          (policy.maxUserDailyQuota !== null && sum(rows.filter(r => r.operator.name === actor.name)) + quota > quotaUnits(policy.maxUserDailyQuota))) throw new Error('budget');
    } catch {
      this.discardSession(openId);
      await this.send('open_id', openId, '申请超过单次额度上限，或本机额度记录无法安全核对；未创建令牌。请联系管理员。');
      return { status: 'budget-exceeded' };
    }
    if (this.getPolicy() !== policy) { this.discardSession(openId); return { status: 'policy-changed' }; }
    let result;
    try {
      result = await this.service.create({ requestId: session.requestId, groupId: session.selectedGroup.id,
        quota: session.quota, name: '飞书令牌', operator: actor.name }, { verifiedActor: actor, feishuGroupId: session.groupId,
          quotaLimits: { maxQuota: policy.maxQuota, maxUserDailyQuota: policy.maxUserDailyQuota, maxGroupDailyQuota: policy.maxGroupDailyQuota },
          guard: () => this.getPolicy() === policy && (!this.connection || this.connection.state?.().phase === 'connected') });
    } catch (error) {
      this.discardSession(openId);
      const diagnostic = failureDiagnostic(session.requestId, error?.createDiagnostic || error, error?.createDiagnostic?.stage);
      const message = `${failureHint(diagnostic)}\n错误编号：${diagnostic.code}\n操作编号：${session.requestId}`;
      await this.send('open_id', openId, message);
      return { status: 'create-failed', code: diagnostic.code };
    }
    try { this.service.recordExternalDelivery(session.requestId, 'pending'); }
    catch {
      this.discardSession(openId);
      await this.send('open_id', openId, '令牌创建回执已保存，但安全交付状态无法记录。为避免重复泄露，请联系管理员通过审计记录处理。');
      return { status: 'delivery-log-failed' };
    }
    const delivered = await this.send('open_id', openId, `令牌已创建。分组：${clean(session.selectedGroup.name, 60)}\n额度：${result.quota}\n密钥（仅此私聊）：\nhttps://max.cheapi.cc/\n${result.key}\n请勿转发。若未收到完整密钥，请联系管理员；机器人不会自动重发。`);
    this.discardSession(openId);
    try { this.service.recordExternalDelivery(session.requestId, delivered ? 'sent' : 'unknown'); } catch { /* durable pending means never auto-resend */ }
    return { status: delivered ? 'created-and-delivered' : 'created-delivery-unknown' };
  }
}

module.exports = { FeishuBotWorkflow, actorFromOpenId, operationId, textOf };
