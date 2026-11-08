'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { CHANNELS, parseAmount } = require('./channel-monitor');

const CHANNEL_IDS = new Set(CHANNELS.map(channel => channel.id));
const MAX_FILE = 1024 * 1024;
const MAX_PEOPLE = 100;
const MAX_ID_LENGTH = 256;
const FRESH_MS = 60 * 60 * 1000;
const digest = text => createHash('sha256').update(text).digest('hex');
class AccessError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new AccessError(code, message); };
const validId = value => typeof value === 'string' && value.length <= MAX_ID_LENGTH &&
  /^[^\s\x00-\x1f\x7f"'\\<>]{3,}$/u.test(value);
const validName = value => typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 60 &&
  !/[\x00-\x1f\x7f]/.test(value);
const identityKey = (botAccountId, senderId) => JSON.stringify([botAccountId, senderId]);
const hint = value => value.length <= 12 ? `${value.slice(0, 2)}…${value.slice(-2)}` : `${value.slice(0, 4)}…${value.slice(-4)}`;
const publicRecord = row => ({ id: row.id, name: row.name, identityHint: `${hint(row.botAccountId)} / ${hint(row.senderId)}`,
  channelIds: [...row.channelIds], enabled: row.enabled, updatedAt: row.updatedAt });

function validateGrant(input) {
  if (!validId(input?.botAccountId) || !validId(input?.senderId) || !validName(input?.name) ||
      !Array.isArray(input?.channelIds) || input.channelIds.length < 1 || input.channelIds.length > CHANNELS.length ||
      new Set(input.channelIds).size !== input.channelIds.length || input.channelIds.some(id => !CHANNEL_IDS.has(id)))
    fail('INPUT', '请填写准确的机器人账号标识、成员标识、名称，并选择至少一个有效渠道。');
  return { botAccountId: input.botAccountId, senderId: input.senderId, name: input.name.trim(),
    channelIds: [...input.channelIds] };
}
function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_PEOPLE) throw new Error('rows');
  const identities = new Set(), ids = new Set();
  for (const row of rows) {
    validateGrant(row);
    if (typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.id) ||
        typeof row.enabled !== 'boolean' || typeof row.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(row.updatedAt))) throw new Error('row');
    const key = identityKey(row.botAccountId, row.senderId);
    if (identities.has(key) || ids.has(row.id)) throw new Error('duplicate');
    identities.add(key); ids.add(row.id);
  }
  return rows;
}
function sanitizeSnapshot(channel, snapshot, now) {
  const checked = Date.parse(snapshot?.checkedAt);
  const successful = Date.parse(snapshot?.successAt);
  const parsed = parseAmount(snapshot?.display);
  const fresh = snapshot?.status === 'ok' && Number.isFinite(snapshot.value) && snapshot.value >= 0 &&
    parsed && parsed.value === snapshot.value &&
    typeof snapshot.display === 'string' && !/[\x00-\x1f\x7f]/.test(snapshot.display) &&
    typeof snapshot.successAt === 'string' && Number.isFinite(successful) &&
    typeof snapshot.checkedAt === 'string' && Number.isFinite(checked) &&
    Number.isFinite(now) && checked >= successful && now - checked >= 0 &&
    now - successful >= 0 && now - successful <= FRESH_MS;
  return { channelId: channel.id, name: channel.defaultName, metric: channel.metric,
    status: fresh ? 'ok' : 'unavailable', value: fresh ? snapshot.value : null,
    display: fresh ? parsed.display : null,
    checkedAt: fresh ? snapshot.checkedAt : null, successAt: fresh ? snapshot.successAt : null };
}
function selectSnapshots(rows, identity, snapshots, { channelId = null, now = Date.now() } = {}) {
  if (!validId(identity?.botAccountId) || !validId(identity?.senderId)) fail('DENIED', '未绑定的聊天身份。');
  const row = rows.find(item => item.enabled && item.botAccountId === identity.botAccountId && item.senderId === identity.senderId);
  if (!row) fail('DENIED', '此聊天身份尚未获得渠道查看权限。');
  if (channelId && !row.channelIds.includes(channelId)) fail('DENIED', '此渠道未授权。');
  if (channelId && !CHANNEL_IDS.has(channelId)) fail('DENIED', '此渠道未授权。');
  if (!Array.isArray(snapshots)) fail('STORAGE', '监控快照不可用。');
  const byId = new Map(snapshots.map(item => [item?.id, item]));
  return CHANNELS.filter(channel => row.channelIds.includes(channel.id) && (!channelId || channelId === channel.id))
    .map(channel => sanitizeSnapshot(channel, byId.get(channel.id), now));
}
function makeChannelAccessStore(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'channel-access.journal');
  let loaded = false, fault = false, sequence = 0, rows = [];
  let fileIdentity = null, fileSize = 0;
  let fileChecksum = null;
  const failure = () => new AccessError('STORAGE', '渠道授权无法安全读写，已停止查询；请保留原文件检查。');
  const encrypted = () => {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  };
  const state = () => ({ people: rows.map(publicRecord), storageError: fault });
  function assertCurrent() {
    if (!loaded || fault) throw failure();
    try {
      if (fileIdentity && (!io.existsSync(file) || io.statSync(file).ino !== fileIdentity ||
          io.statSync(file).size !== fileSize || digest(io.readFileSync(file)) !== fileChecksum)) throw failure();
      if (!fileIdentity && io.existsSync(file)) throw failure();
    } catch { fault = true; throw failure(); }
  }
  function save(next) {
    assertCurrent();
    if (!encrypted()) { fault = true; throw failure(); }
    let fd;
    try {
      validateRows(next);
      const sealed = safeStorage.encryptString(JSON.stringify(next)).toString('base64');
      const payload = JSON.stringify({ sequence: sequence + 1, sealed });
      const line = Buffer.from(JSON.stringify({ payload, checksum: digest(payload) }) + '\n');
      io.mkdirSync(dir, { recursive: true });
      if ((io.existsSync(file) ? io.statSync(file).size : 0) + line.length > MAX_FILE) throw failure();
      fd = io.openSync(file, 'a', 0o600);
      for (let offset = 0; offset < line.length;) {
        const n = io.writeSync(fd, line, offset, line.length - offset);
        if (!Number.isInteger(n) || n <= 0) throw failure();
        offset += n;
      }
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      fileIdentity = io.statSync(file).ino; fileSize = io.statSync(file).size;
      fileChecksum = digest(io.readFileSync(file));
      sequence++; rows = structuredClone(next); return state();
    } catch { fault = true; throw failure(); }
    finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { fault = true; } } }
  }
  return {
    load() {
      if (loaded || fault) throw failure(); loaded = true;
      try {
        if (!encrypted()) throw failure();
        if (!io.existsSync(file)) return state();
        const raw = io.readFileSync(file, 'utf8');
        if (!raw || raw.length > MAX_FILE || !raw.endsWith('\n')) throw failure();
        fileIdentity = io.statSync(file).ino; fileSize = io.statSync(file).size;
        fileChecksum = digest(raw);
        for (const line of raw.slice(0, -1).split('\n')) {
          const record = JSON.parse(line);
          if (typeof record.payload !== 'string' || record.checksum !== digest(record.payload)) throw failure();
          const payload = JSON.parse(record.payload);
          if (payload.sequence !== ++sequence || typeof payload.sealed !== 'string') throw failure();
          rows = validateRows(JSON.parse(safeStorage.decryptString(Buffer.from(payload.sealed, 'base64'))));
        }
        return state();
      } catch { fault = true; throw failure(); }
    },
    state,
    grant(input) {
      if (!loaded || fault) throw failure();
      const grant = validateGrant(input);
      const index = rows.findIndex(row => identityKey(row.botAccountId, row.senderId) === identityKey(grant.botAccountId, grant.senderId));
      if (index < 0 && rows.length >= MAX_PEOPLE) fail('INPUT', '最多管理 100 位成员。');
      const next = structuredClone(rows);
      const record = { id: index < 0 ? randomUUID() : next[index].id, ...grant, enabled: true, updatedAt: new Date().toISOString() };
      if (index < 0) next.push(record); else next[index] = record;
      return save(next);
    },
    revoke(id) {
      if (!loaded || fault) throw failure();
      const index = rows.findIndex(row => row.id === id);
      if (index < 0) fail('INPUT', '没有找到此授权。');
      const next = structuredClone(rows);
      next[index].enabled = false; next[index].updatedAt = new Date().toISOString();
      return save(next);
    },
    update(id, channelIds) {
      if (!loaded || fault) throw failure();
      const index = rows.findIndex(row => row.id === id);
      if (index < 0) fail('INPUT', '没有找到此授权。');
      const next = structuredClone(rows);
      const grant = validateGrant({ ...next[index], channelIds });
      next[index] = { ...next[index], ...grant, enabled: true, updatedAt: new Date().toISOString() };
      return save(next);
    },
    preview(id, snapshots, options) {
      assertCurrent();
      const row = rows.find(item => item.id === id && item.enabled);
      if (!row) fail('DENIED', '此授权未启用。');
      return selectSnapshots(rows, { botAccountId: row.botAccountId, senderId: row.senderId }, snapshots, options);
    },
    previewCurrent(id, getSnapshots, options) {
      assertCurrent();
      const row = rows.find(item => item.id === id && item.enabled);
      if (!row) fail('DENIED', '此授权未启用。');
      return this.queryCurrent({ botAccountId: row.botAccountId, senderId: row.senderId }, getSnapshots, options);
    },
    query(identity, snapshots, { channelId = null, now = Date.now() } = {}) {
      assertCurrent();
      return selectSnapshots(rows, identity, snapshots, { channelId, now });
    },
    queryCurrent(identity, getSnapshots, options) {
      assertCurrent();
      const first = selectSnapshots(rows, identity, getSnapshots(), options);
      assertCurrent();
      const second = selectSnapshots(rows, identity, getSnapshots(), options);
      if (JSON.stringify(first) !== JSON.stringify(second)) fail('BUSY', '监控状态正在变化，请稍后查询。');
      return second;
    }
  };
}
module.exports = { makeChannelAccessStore, AccessError, validateGrant, FRESH_MS };
