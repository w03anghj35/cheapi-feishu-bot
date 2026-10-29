'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { ToolError } = require('./service');
const checksum = value => createHash('sha256').update(value).digest('hex');
function validate(value) {
  if (value === null) return value;
  if (!value || typeof value.token !== 'string' || !value.token || value.token.length > 32768 ||
      !Number.isSafeInteger(value.owner) || value.owner <= 0 ||
      value.origin !== 'https://max.cheapi.cc' || !Number.isFinite(Date.parse(value.savedAt))) throw new Error('invalid session');
  return value;
}
// Independent of operation receipts. A null entry is a durable revocation, not a missing file.
function makeSessionStore(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'admin-session.journal');
  let loaded = false, damaged = false, sequence = 0;
  let unreadableSnapshot = null;
  const failure = () => new ToolError('STORAGE', '管理员授权未能安全读取或保存，已停止使用；请保留文件并检查本机存储。');
  function encryption() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw failure();
  }
  function writeFlushed(target, bytes, flags) {
    let fd;
    try {
      fd = io.openSync(target, flags, 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        const n = io.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isSafeInteger(n) || n <= 0) throw failure();
        offset += n;
      }
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  function append(sealed) {
    const payload = JSON.stringify({ sequence: sequence + 1, sealed });
    writeFlushed(file, Buffer.from(JSON.stringify({ payload, checksum: checksum(payload) }) + '\n'), 'a');
    sequence++;
  }
  return {
    canRecover() { return damaged && unreadableSnapshot !== null; },
    load() {
      if (loaded || damaged) throw failure();
      try {
        encryption();
        loaded = true;
        if (!io.existsSync(file)) return undefined;
        const original = io.readFileSync(file);
        const text = original.toString('utf8');
        if (!text || !text.endsWith('\n')) throw new Error('incomplete journal');
        let sealed;
        for (const line of text.slice(0, -1).split('\n')) {
          const row = JSON.parse(line);
          if (typeof row.payload !== 'string' || checksum(row.payload) !== row.checksum) throw new Error('checksum');
          const entry = JSON.parse(row.payload);
          if (entry.sequence !== sequence + 1 || !(entry.sealed === null || typeof entry.sealed === 'string')) throw new Error('sequence');
          sequence = entry.sequence; sealed = entry.sealed;
        }
        if (sealed === null) return null;
        if (!sealed || Buffer.from(sealed, 'base64').toString('base64') !== sealed) throw failure();
        let clear;
        try { clear = safeStorage.decryptString(Buffer.from(sealed, 'base64')); }
        catch { unreadableSnapshot = Buffer.from(original); throw failure(); }
        return validate(JSON.parse(clear));
      } catch { damaged = true; throw failure(); }
    },
    // Explicit administrator recovery only: preserve every old byte, then append a
    // durable revocation. Never recover malformed journals or migrate stale login.
    recover(confirmed) {
      if (confirmed !== true || !damaged || unreadableSnapshot === null) throw failure();
      const original = unreadableSnapshot;
      unreadableSnapshot = null; // A failed/uncertain attempt cannot be retried in this writer.
      try {
        encryption();
        const probe = 'admin-session-recovery-probe';
        if (safeStorage.decryptString(safeStorage.encryptString(probe)) !== probe) throw failure();
        if (!io.readFileSync(file).equals(original)) throw failure();
        const backup = path.join(dir, 'admin-session.preserved-' + randomUUID() + '.journal');
        writeFlushed(backup, original, 'wx');
        if (!io.readFileSync(backup).equals(original) || !io.readFileSync(file).equals(original)) throw failure();
        append(null);
        damaged = false;
        return null;
      } catch { damaged = true; throw failure(); }
    },
    save(value) {
      if (!loaded || damaged) throw failure();
      try {
        validate(value);
        encryption();
        const sealed = value === null ? null : safeStorage.encryptString(JSON.stringify(value)).toString('base64');
        io.mkdirSync(dir, { recursive: true });
        append(sealed);
      } catch { damaged = true; throw failure(); }
    }
  };
}
module.exports = { makeSessionStore };
