'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

class ConnectionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const digest = value => createHash('sha256').update(value).digest('hex');
function validateCredentials(input) {
  const appId = typeof input?.appId === 'string' ? input.appId.trim() : '';
  const appSecret = typeof input?.appSecret === 'string' ? input.appSecret.trim() : '';
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) throw new ConnectionError('INPUT', '请填写有效的飞书 App ID（cli_ 开头，后接 16 位十六进制字符）。');
  if (!appSecret || appSecret.length > 512 || /[\s\x00-\x1f\x7f]/.test(appSecret)) {
    throw new ConnectionError('INPUT', '请填写有效的 App Secret，不要填写机器人 Webhook 地址。');
  }
  return { appId, appSecret };
}
function validateRecord(input) {
  const credentials = validateCredentials(input);
  if (!Number.isFinite(Date.parse(input.savedAt))) throw new Error('invalid timestamp');
  return { ...credentials, savedAt: input.savedAt };
}

// Dedicated, single-writer encrypted journal. Never shares the administrator's platform session.
function makeFeishuStore(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'feishu-connection.journal');
  const maxBytes = 4 * 1024 * 1024;
  let loaded = false, damaged = false, sequence = 0;
  const failure = () => new ConnectionError('STORAGE', '飞书配置未能安全读取或保存。已停止连接，请保留配置文件并检查存储；不要删除文件绕过检查。');
  function requireEncryption() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw failure();
  }
  return {
    load() {
      if (loaded || damaged) throw failure();
      loaded = true;
      try {
        requireEncryption();
        if (!io.existsSync(file)) return undefined;
        if (io.statSync(file).size > maxBytes) throw failure();
        const text = io.readFileSync(file, 'utf8');
        if (!text || !text.endsWith('\n')) throw failure();
        let sealed;
        for (const line of text.slice(0, -1).split('\n')) {
          const row = JSON.parse(line);
          if (typeof row.payload !== 'string' || digest(row.payload) !== row.checksum) throw failure();
          const entry = JSON.parse(row.payload);
          if (entry.sequence !== sequence + 1 || typeof entry.sealed !== 'string' || !entry.sealed) throw failure();
          sequence = entry.sequence; sealed = entry.sealed;
        }
        return validateRecord(JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64'))));
      } catch { damaged = true; throw failure(); }
    },
    save(input) {
      if (!loaded || damaged) throw failure();
      const record = validateRecord(input);
      let fd;
      try {
        requireEncryption();
        const sealed = safeStorage.encryptString(JSON.stringify(record)).toString('base64');
        const payload = JSON.stringify({ sequence: sequence + 1, sealed });
        const line = Buffer.from(JSON.stringify({ payload, checksum: digest(payload) }) + '\n');
        io.mkdirSync(dir, { recursive: true });
        if ((io.existsSync(file) ? io.statSync(file).size : 0) + line.length > maxBytes) throw failure();
        fd = io.openSync(file, 'a', 0o600);
        let offset = 0;
        while (offset < line.length) {
          const written = io.writeSync(fd, line, offset, line.length - offset);
          if (!Number.isSafeInteger(written) || written <= 0) throw failure();
          offset += written;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined; sequence++;
      } catch { damaged = true; throw failure(); }
      finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { damaged = true; } } }
    }
  };
}
module.exports = { makeFeishuStore, validateCredentials, ConnectionError };
