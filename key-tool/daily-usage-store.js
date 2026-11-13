'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { dayKey, finiteCost } = require('./daily-usage');
const MAX_BYTES = 32 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const validScope = value => Number.isSafeInteger(value?.owner) && value.owner > 0 &&
  typeof value.groupId === 'string' && /^oc_[\w-]{8,128}$/.test(value.groupId);
const validName = value => typeof value === 'string' && value.trim() === value &&
  value.length >= 1 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
const validMessage = value => typeof value === 'string' && /^om_[\w-]{4,252}$/.test(value);
const validDailyTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const FAILURE_KINDS = new Set(['local', 'api', 'http', 'timeout', 'network', 'receipt', 'unknown']);
function validateFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['kind', 'httpStatus', 'apiCode'].includes(key)) ||
      !FAILURE_KINDS.has(value.kind) ||
      (value.httpStatus !== undefined && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) ||
      (value.apiCode !== undefined && (!Number.isSafeInteger(value.apiCode) || value.apiCode < 0 || value.apiCode > 999999999)))
    throw Error('daily usage failure diagnostic invalid');
  return { kind: value.kind,
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
    ...(value.apiCode === undefined ? {} : { apiCode: value.apiCode }) };
}
function validateEvent(event) {
  if (!event || !validScope(event.scope) || !['config','snapshot','account-backfill','attempt','ready','unknown','retired','reviewed-absent'].includes(event.type))
    throw Error('daily usage event invalid');
  if (event.type === 'config') {
    if (typeof event.enabled !== 'boolean' || event.days !== 3 ||
        (event.dailyTime !== undefined && event.dailyTime !== null && !validDailyTime(event.dailyTime)) ||
        (event.effectiveDay !== undefined && event.effectiveDay !== null &&
          (typeof event.effectiveDay !== 'string' || dayKey(event.effectiveDay) !== event.effectiveDay)))
      throw Error('daily usage config invalid');
    return { type: 'config', scope: event.scope, enabled: event.enabled, days: 3,
      dailyTime: event.dailyTime ?? null, effectiveDay: event.effectiveDay ?? null };
  }
  if (event.type === 'snapshot') {
    dayKey(event.day);
    if (!Number.isFinite(Date.parse(event.checkedAt)) || typeof event.final !== 'boolean' ||
        !Array.isArray(event.rows) || event.rows.length > 30 ||
        (event.source !== undefined && event.source !== 'backfill-current-ownership'))
      throw Error('daily usage snapshot invalid');
    const names = new Set();
    const rows = event.rows.map(row => {
      if (!validName(row.name) || names.has(row.name) || !Array.isArray(row.users) || row.users.length > 30)
        throw Error('daily usage profile invalid');
      names.add(row.name);
      const ids = new Set();
      return { name: row.name, users: row.users.map(user => {
        if (!Number.isSafeInteger(user.id) || user.id <= 0 || ids.has(user.id) ||
            typeof user.email !== 'string' || !user.email || user.email.length > 254 ||
            /[\x00-\x1f\x7f]/.test(user.email)) throw Error('daily usage user invalid');
        ids.add(user.id); finiteCost({ total_actual_cost: user.cost });
        return { id: user.id, email: user.email, cost: user.cost };
      }) };
    });
    return { type: 'snapshot', scope: event.scope, day: event.day,
      checkedAt: event.checkedAt, final: event.final, rows,
      ...(event.source ? { source: event.source } : {}) };
  }
  if (event.type === 'account-backfill') {
    dayKey(event.day);
    if (!validName(event.profile) || !Number.isFinite(Date.parse(event.checkedAt)) ||
        !Number.isSafeInteger(event.user?.id) || event.user.id <= 0 ||
        typeof event.user.email !== 'string' || !event.user.email || event.user.email.length > 254 ||
        /[\x00-\x1f\x7f]/.test(event.user.email)) throw Error('daily usage account backfill invalid');
    finiteCost({ total_actual_cost: event.user.cost });
    return { type: event.type, scope: event.scope, day: event.day, profile: event.profile,
      checkedAt: event.checkedAt, user: { id: event.user.id, email: event.user.email, cost: event.user.cost } };
  }
  if (!validName(event.profile) || !Number.isFinite(Date.parse(event.at)))
    throw Error('daily usage card state invalid');
  if (event.type === 'reviewed-absent') {
    if (typeof event.originalAt !== 'string' || !Number.isFinite(Date.parse(event.originalAt)))
      throw Error('daily usage review target invalid');
    return { type: event.type, scope: event.scope, profile: event.profile,
      originalAt: event.originalAt, at: event.at };
  }
  if (event.createdAt !== undefined && !Number.isFinite(Date.parse(event.createdAt)))
    throw Error('daily usage card creation time invalid');
  if (event.type === 'attempt') {
    if (!['create','patch'].includes(event.action) ||
        (event.action === 'patch' && !validMessage(event.messageId)) ||
        (event.action === 'create' && event.messageId !== null)) throw Error('daily usage attempt invalid');
    return { type: 'attempt', scope: event.scope, profile: event.profile,
      action: event.action, messageId: event.messageId, at: event.at,
      createdAt: event.createdAt || event.at };
  }
  if (['ready','retired'].includes(event.type) && !validMessage(event.messageId)) throw Error('daily usage message ID invalid');
  if (event.type === 'unknown' && event.messageId !== null && !validMessage(event.messageId))
    throw Error('daily usage unknown state invalid');
  return { type: event.type, scope: event.scope, profile: event.profile,
    messageId: event.messageId, at: event.at, createdAt: event.createdAt || event.at,
    ...(event.type === 'unknown' && event.failure !== undefined ? { failure: validateFailure(event.failure) } : {}) };
}
function makeDailyUsageStore(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'daily-usage.journal');
  let loaded = false, fault = false, sequence = 0, bytes = 0;
  const states = new Map();
  const failure = () => Error('每日用量配置或发布账本无法安全读写；已停止群发送，请保留原件。');
  const encrypted = () => {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  };
  const key = scope => `${scope.owner}:${scope.groupId}`;
  function apply(event) {
    const id = key(event.scope);
    const state = states.get(id) || { enabled: false, days: 3, dailyTime: null, effectiveDay: null,
      snapshots: {}, supplements: Object.create(null), cards: {} };
    if (event.type === 'config') { state.enabled = event.enabled; state.days = event.days;
      state.dailyTime = event.dailyTime; state.effectiveDay = event.effectiveDay; }
    else if (event.type === 'snapshot') state.snapshots[event.day] = event;
    else if (event.type === 'account-backfill') {
      state.supplements ||= Object.create(null);
      state.supplements[event.day] ||= Object.create(null);
      state.supplements[event.day][event.profile] ||= Object.create(null);
      state.supplements[event.day][event.profile][event.user.id] = event;
    }
    else if (event.type === 'attempt') state.cards[event.profile] = { phase: 'attempting',
      action: event.action, messageId: event.messageId, at: event.at, createdAt: event.createdAt };
    else if (event.type === 'ready') state.cards[event.profile] = { phase: 'ready', messageId: event.messageId,
      at: event.at, createdAt: event.createdAt };
    else if (event.type === 'retired') state.cards[event.profile] = { phase: 'retired', messageId: event.messageId,
      at: event.at, createdAt: event.createdAt };
    else if (event.type === 'unknown') {
      const previous = state.cards[event.profile];
      state.cards[event.profile] = { phase: 'unknown', action: previous?.phase === 'attempting' ? previous.action : null,
        messageId: event.messageId, at: event.at, attemptedAt: previous?.phase === 'attempting' ? previous.at : event.at,
        createdAt: event.createdAt, failure: event.failure || null };
    } else if (event.type === 'reviewed-absent') {
      const previous = state.cards[event.profile];
      if (!previous || !['unknown', 'attempting'].includes(previous.phase) ||
          previous.action !== 'create' || previous.messageId !== null || previous.at !== event.originalAt)
        throw failure();
      // One durable event both records the human attestation and stops the timer.
      state.enabled = false;
      state.cards[event.profile] = { phase: 'reviewed-absent', action: 'create', messageId: null,
        at: event.at, attemptedAt: previous.attemptedAt || previous.at,
        createdAt: previous.createdAt, failure: previous.failure || null };
    }
    states.set(id, state);
  }
  return {
    load() {
      if (loaded || fault) throw failure(); loaded = true;
      try {
        if (!encrypted()) throw failure();
        if (!io.existsSync(file)) return;
        bytes = io.statSync(file).size;
        if (!bytes || bytes > MAX_BYTES) throw failure();
        const source = io.readFileSync(file, 'utf8');
        if (!source.endsWith('\n')) throw failure();
        for (const line of source.slice(0, -1).split('\n')) {
          const row = JSON.parse(line);
          if (row.sequence !== sequence + 1 || typeof row.ciphertext !== 'string' ||
              row.checksum !== digest(`${row.sequence}:${row.ciphertext}`)) throw failure();
          const event = validateEvent(JSON.parse(safeStorage.decryptString(Buffer.from(row.ciphertext, 'base64'))));
          apply(event); sequence++;
        }
      } catch { fault = true; throw failure(); }
    },
    append(input) {
      if (!loaded || fault || !encrypted()) { fault = true; throw failure(); }
      const event = validateEvent(input);
      let fd;
      try {
        const ciphertext = safeStorage.encryptString(JSON.stringify(event)).toString('base64');
        const envelope = { sequence: sequence + 1, ciphertext,
          checksum: digest(`${sequence + 1}:${ciphertext}`) };
        const chunk = Buffer.from(JSON.stringify(envelope) + '\n');
        if (bytes + chunk.length > MAX_BYTES) throw failure();
        io.mkdirSync(dir, { recursive: true }); fd = io.openSync(file, 'a', 0o600);
        for (let offset = 0; offset < chunk.length;) {
          const n = io.writeSync(fd, chunk, offset, chunk.length - offset);
          if (!Number.isSafeInteger(n) || n <= 0) throw failure();
          offset += n;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
        bytes += chunk.length; sequence++; apply(event);
      } catch { fault = true; throw failure(); }
      finally { if (fd !== undefined) try { io.closeSync(fd); } catch { fault = true; } }
    },
    state(scope) {
      if (!loaded || fault || !validScope(scope)) throw failure();
      return structuredClone(states.get(key(scope)) || { enabled: false, days: 3, dailyTime: null, effectiveDay: null, snapshots: {}, supplements: {}, cards: {} });
    }
  };
}
module.exports = { makeDailyUsageStore, validateEvent, validScope, validDailyTime, MAX_BYTES };
