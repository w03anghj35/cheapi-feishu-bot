'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const checksum = payload => createHash('sha256').update(payload).digest('hex');
function customerName(value) {
  if (typeof value !== 'string' || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('客户名称最多 80 个字符，不能包含控制字符。');
  }
  return value.trim();
}
function validateCatalog(rows) {
  if (!Array.isArray(rows)) throw new Error('invalid catalog');
  const ids = new Set(), names = new Set();
  for (const r of rows) {
    if (!Number.isSafeInteger(r?.owner) || r.owner <= 0 || !Number.isSafeInteger(r.groupId) || r.groupId <= 0 ||
        !customerName(r.name) || customerName(r.name) !== r.name || ids.has(`${r.owner}:${r.groupId}`) ||
        names.has(`${r.owner}:${r.name}`)) throw new Error('invalid or duplicate catalog entry');
    ids.add(`${r.owner}:${r.groupId}`); names.add(`${r.owner}:${r.name}`);
  }
  return rows;
}
// Separate from creation receipts: never rename/copy-overwrite an authoritative file.
// No configured names means no customer-visible groups; damaged files never expose raw groups.
function makeCatalogStore(dir, io = fs) {
  const file = path.join(dir, 'group-catalog.journal');
  let sequence = 0, loaded = false, damaged = false;
  return {
    load() {
      if (loaded) throw new Error('catalog already loaded');
      try {
        let rows = [];
        if (io.existsSync(file)) {
          const text = io.readFileSync(file, 'utf8');
          if (!text || !text.endsWith('\n')) throw new Error('incomplete catalog');
          for (const line of text.slice(0, -1).split('\n')) {
            const envelope = JSON.parse(line);
            if (typeof envelope.payload !== 'string' || checksum(envelope.payload) !== envelope.checksum) throw new Error('checksum');
            const next = JSON.parse(envelope.payload);
            if (next.sequence !== sequence + 1) throw new Error('sequence');
            rows = validateCatalog(next.rows); sequence = next.sequence;
          }
        }
        loaded = true; return rows;
      } catch { damaged = true; throw new Error('分组配置损坏或无法读取，请保留文件并联系管理员。'); }
    },
    save(rows) {
      if (!loaded || damaged) throw new Error('分组配置不可写，请保留文件并联系管理员。');
      validateCatalog(rows);
      const payload = JSON.stringify({ sequence: sequence + 1, rows });
      const buffer = Buffer.from(JSON.stringify({ payload, checksum: checksum(payload) }) + '\n');
      let fd;
      try {
        io.mkdirSync(dir, { recursive: true });
        fd = io.openSync(file, 'a', 0o600);
        for (let offset = 0; offset < buffer.length;) {
          const count = io.writeSync(fd, buffer, offset, buffer.length - offset);
          if (!Number.isSafeInteger(count) || count <= 0 || count > buffer.length - offset) throw new Error('short write');
          offset += count;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined; sequence++;
      } catch { damaged = true; throw new Error('分组配置未安全保存，请保留文件并联系管理员。'); }
      finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { damaged = true; } } }
    }
  };
}
module.exports = { customerName, validateCatalog, makeCatalogStore };
