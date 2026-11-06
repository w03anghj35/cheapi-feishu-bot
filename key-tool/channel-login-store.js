'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CHANNELS } = require('./channel-monitor');

const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 256 * 1024;
const CHANNEL_IDS = new Set(CHANNELS.map(channel => channel.id));
class ChannelLoginError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function validate(input, channelId = 'spent-aerorelay') {
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const password = input?.password;
  const validAccount = channelId === 'balance-juxiang' ?
    !!email && email.length <= 254 && !/[\s\x00-\x1f\x7f]/.test(email) :
    email.length <= 254 && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(email);
  if (!validAccount ||
      typeof password !== 'string' || !password || password.length > 1024 || /[\x00-\x1f\x7f]/.test(password))
    throw new ChannelLoginError('INPUT', channelId === 'balance-juxiang' ? '请填写有效的用户名或电子邮件及密码。' : '请填写有效的登录邮箱和密码。');
  return { email, password };
}
function makeChannelLoginStore(dir, safeStorage, io = fs, channelId = 'spent-aerorelay') {
  if (!CHANNEL_IDS.has(channelId)) throw new ChannelLoginError('INPUT', '未知渠道。');
  const file = path.join(dir, channelId === 'spent-aerorelay' ? 'aerorelay-login.journal' : `channel-login-${channelId}.journal`);
  let loaded = false, fault = false, sequence = 0, current = null;
  const failure = () => new ChannelLoginError('STORAGE', '渠道自动登录配置无法安全读写；已暂停自动登录，请保留原文件检查。');
  function requireEncryption() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw failure();
  }
  function state() { return { configured: !!current, enabled: !!current?.enabled, storageError: fault }; }
  function append(record) {
    if (!loaded || fault) throw failure();
    let fd;
    try {
      requireEncryption();
      const sealed = safeStorage.encryptString(JSON.stringify(record)).toString('base64');
      const payload = JSON.stringify({ sequence: sequence + 1, sealed });
      const bytes = Buffer.from(JSON.stringify({ payload, checksum: digest(payload) }) + '\n');
      io.mkdirSync(dir, { recursive: true });
      if ((io.existsSync(file) ? io.statSync(file).size : 0) + bytes.length > MAX_BYTES) throw failure();
      fd = io.openSync(file, 'a', 0o600);
      for (let offset = 0; offset < bytes.length;) {
        const n = io.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isSafeInteger(n) || n <= 0 || n > bytes.length - offset) throw failure();
        offset += n;
      }
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      sequence++; current = record;
      return state();
    } catch { fault = true; if (current) current = { ...current, enabled: false }; throw failure(); }
    finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { fault = true; } } }
  }
  return {
    load() {
      if (loaded || fault) throw failure();
      loaded = true;
      try {
        requireEncryption();
        if (!io.existsSync(file)) return state();
        if (io.statSync(file).size > MAX_BYTES) throw failure();
        const text = io.readFileSync(file, 'utf8');
        if (!text || !text.endsWith('\n')) throw failure();
        for (const line of text.slice(0, -1).split('\n')) {
          const envelope = JSON.parse(line);
          if (typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.checksum) throw failure();
          const entry = JSON.parse(envelope.payload);
          if (entry.sequence !== ++sequence || typeof entry.sealed !== 'string' || !entry.sealed) throw failure();
          const record = JSON.parse(safeStorage.decryptString(Buffer.from(entry.sealed, 'base64')));
          const credentials = validate(record, channelId);
          if (typeof record.enabled !== 'boolean') throw failure();
          current = { ...credentials, enabled: record.enabled };
        }
        return state();
      } catch { fault = true; current = null; throw failure(); }
    },
    state,
    credentials() { return !fault && current?.enabled ? { email: current.email, password: current.password } : null; },
    save(input) { return append({ ...validate(input, channelId), enabled: true }); },
    claim() {
      const credentials = this.credentials();
      if (!credentials) return null;
      append({ ...credentials, enabled: false });
      return credentials;
    },
    resume(input) {
      if (!loaded || fault || !current || current.enabled) throw failure();
      const credentials = validate(input, channelId);
      if (credentials.email !== current.email || credentials.password !== current.password) throw failure();
      return append({ ...credentials, enabled: true });
    },
    pause() {
      if (!loaded || fault) throw failure();
      return current?.enabled ? append({ ...current, enabled: false }) : state();
    },
    clear() {
      if (!loaded || fault) throw failure();
      try { if (io.existsSync(file)) io.unlinkSync(file); sequence = 0; current = null; return state(); }
      catch { fault = true; if (current) current = { ...current, enabled: false }; throw failure(); }
    }
  };
}
module.exports = { makeChannelLoginStore, ChannelLoginError, validate };
