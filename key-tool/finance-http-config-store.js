'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_BYTES = 256 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');

class FinanceHttpConfigError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const storageError = () => new FinanceHttpConfigError('STORAGE', '财务只读接口配置无法安全读取；接口已关闭，请保留原文件检查。');
function valid(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).sort().join('|') !== 'enabled|ownerId|token' ||
      typeof record.enabled !== 'boolean' ||
      !Number.isSafeInteger(record.ownerId) || record.ownerId <= 0 ||
      typeof record.token !== 'string' || !/^[a-f0-9]{64}$/.test(record.token)) throw storageError();
  return record;
}

function makeFinanceHttpConfigStore(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'finance-http-config.journal');
  let loaded = false, fault = false, sequence = 0, current = null;
  let fileIdentity = null, fileSize = 0, fileHash = null;
  function encryption() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw storageError();
  }
  function assertCurrent() {
    if (!loaded || fault) throw storageError();
    try {
      if (io.existsSync(dir) && io.lstatSync(dir).isSymbolicLink()) throw storageError();
      if (fileIdentity === null) {
        if (io.existsSync(file)) throw storageError();
      } else {
        if (!io.existsSync(file) || io.lstatSync(file).isSymbolicLink()) throw storageError();
        const stat = io.statSync(file);
        if (!stat.isFile() || stat.ino !== fileIdentity || stat.size !== fileSize ||
            digest(io.readFileSync(file)) !== fileHash) throw storageError();
      }
    } catch { fault = true; throw storageError(); }
  }
  function state() { try { assertCurrent(); } catch { /* Display closed state; never disclose the prior token. */ }
    return { configured: !!current, enabled: !fault && current?.enabled === true,
    ownerId: current?.ownerId ?? null, storageError: fault }; }
  function append(record) {
    if (!loaded || fault) throw storageError();
    let fd;
    try {
      assertCurrent();
      encryption();
      const clean = valid(record);
      const sealed = safeStorage.encryptString(JSON.stringify(clean)).toString('base64');
      const payload = JSON.stringify({ sequence: sequence + 1, sealed });
      const bytes = Buffer.from(JSON.stringify({ payload, checksum: digest(payload) }) + '\n');
      io.mkdirSync(dir, { recursive: true });
      if (io.existsSync(dir) && io.lstatSync(dir).isSymbolicLink() ||
          io.existsSync(file) && (io.lstatSync(file).isSymbolicLink() || !io.statSync(file).isFile()) ||
          (io.existsSync(file) ? io.statSync(file).size : 0) + bytes.length > MAX_BYTES) throw storageError();
      fd = io.openSync(file, 'a', 0o600);
      for (let offset = 0; offset < bytes.length;) {
        const count = io.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) throw storageError();
        offset += count;
      }
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      const stat = io.statSync(file);
      fileIdentity = stat.ino; fileSize = stat.size; fileHash = digest(io.readFileSync(file));
      sequence++; current = clean;
      return state();
    } catch { fault = true; throw storageError(); }
    finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { fault = true; } } }
  }
  return {
    load() {
      if (loaded || fault) throw storageError();
      loaded = true;
      try {
        encryption();
        if (io.existsSync(dir) && io.lstatSync(dir).isSymbolicLink()) throw storageError();
        if (!io.existsSync(file)) return state();
        if (io.lstatSync(file).isSymbolicLink() || !io.statSync(file).isFile() ||
            io.statSync(file).size <= 0 || io.statSync(file).size > MAX_BYTES) throw storageError();
        const text = io.readFileSync(file, 'utf8');
        if (!text.endsWith('\n')) throw storageError();
        for (const line of text.slice(0, -1).split('\n')) {
          const envelope = JSON.parse(line);
          if (!envelope || Object.keys(envelope).sort().join('|') !== 'checksum|payload' ||
              typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.checksum) throw storageError();
          const value = JSON.parse(envelope.payload);
          if (!value || Object.keys(value).sort().join('|') !== 'sealed|sequence' ||
              value.sequence !== ++sequence || typeof value.sealed !== 'string') throw storageError();
          current = valid(JSON.parse(safeStorage.decryptString(Buffer.from(value.sealed, 'base64'))));
        }
        const stat = io.statSync(file);
        fileIdentity = stat.ino; fileSize = stat.size; fileHash = digest(text);
        return state();
      } catch { fault = true; current = null; throw storageError(); }
    },
    state,
    secret() { assertCurrent(); return current ? { ...current } : null; },
    configure(record) { return append(record); }
  };
}

module.exports = { makeFinanceHttpConfigStore, FinanceHttpConfigError };
