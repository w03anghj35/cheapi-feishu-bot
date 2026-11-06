'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 20000;
const digest = text => createHash('sha256').update(text).digest('hex');
function validate(row) {
  if (!row || !Number.isSafeInteger(row.owner) || row.owner <= 0 ||
      typeof row.groupId !== 'string' || !/^oc_[\w-]{8,128}$/.test(row.groupId) ||
      typeof row.openId !== 'string' || !/^ou_[\w-]{4,252}$/.test(row.openId) ||
      typeof row.actorName !== 'string' || !row.actorName.trim() || row.actorName.length > 100 ||
      /[\x00-\x1f\x7f]/.test(row.actorName) ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100 ||
      /[\x00-\x1f\x7f]/.test(row.name) ||
      !['found','not-found','error'].includes(row.status) ||
      !Number.isFinite(Date.parse(row.at)) ||
      !Number.isSafeInteger(row.count) || row.count < 0 || row.count > 2000)
    throw new Error('invalid query audit');
  return { owner: row.owner, groupId: row.groupId, openId: row.openId, actorName: row.actorName.trim(),
    name: row.name.trim(), status: row.status, at: row.at, count: row.count };
}
function makeOwnershipQueryAudit(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'query-audit.journal');
  let loaded = false, fault = false, bytes = 0, sequence = 0, rows = [];
  const failure = () => new Error('查询记录无法安全写入，已停止展示结果；请保留原文件检查。');
  const encrypted = () => {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  };
  return {
    load() {
      if (loaded || fault) throw failure(); loaded = true;
      try {
        if (!encrypted()) throw failure();
        if (!io.existsSync(file)) return [];
        bytes = io.statSync(file).size;
        if (!bytes || bytes > MAX_BYTES) throw failure();
        const source = io.readFileSync(file, 'utf8');
        if (!source.endsWith('\n')) throw failure();
        for (const line of source.slice(0, -1).split('\n')) {
          const envelope = JSON.parse(line);
          if (envelope.sequence !== sequence + 1 || typeof envelope.ciphertext !== 'string' ||
              envelope.checksum !== digest(`${envelope.sequence}:${envelope.ciphertext}`)) throw failure();
          const row = validate(JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'))));
          sequence++; rows.push(row);
        }
        if (rows.length > MAX_ROWS) throw failure();
        return rows.map(row => ({ ...row }));
      } catch { fault = true; throw failure(); }
    },
    append(input) {
      if (!loaded || fault || !encrypted()) { fault = true; throw failure(); }
      let fd;
      try {
        const row = validate(input);
        const ciphertext = safeStorage.encryptString(JSON.stringify(row)).toString('base64');
        const envelope = { sequence: sequence + 1, ciphertext,
          checksum: digest(`${sequence + 1}:${ciphertext}`) };
        const chunk = Buffer.from(JSON.stringify(envelope) + '\n');
        if (bytes + chunk.length > MAX_BYTES || rows.length >= MAX_ROWS) throw failure();
        io.mkdirSync(dir, { recursive: true }); fd = io.openSync(file, 'a', 0o600);
        for (let offset = 0; offset < chunk.length;) {
          const n = io.writeSync(fd, chunk, offset, chunk.length - offset);
          if (!Number.isSafeInteger(n) || n <= 0) throw failure();
          offset += n;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
        bytes += chunk.length; sequence++; rows.push(row);
      } catch { fault = true; throw failure(); }
      finally { if (fd !== undefined) try { io.closeSync(fd); } catch { fault = true; } }
    },
    list(owner, groupId, limit = 100) {
      if (!loaded || fault) throw failure();
      return rows.filter(row => row.owner === owner && row.groupId === groupId)
        .slice(-limit).reverse().map(row => ({ ...row }));
    }
  };
}
module.exports = { makeOwnershipQueryAudit };
