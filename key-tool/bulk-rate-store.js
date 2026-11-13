'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_BYTES = 32 * 1024 * 1024;
const digest = text => createHash('sha256').update(text).digest('hex');

function makeBulkRateStore(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'bulk-group-rates.journal');
  let loaded = false, fault = false, sequence = 0, bytes = 0;
  const failure = () => Error('批量倍率操作记录无法安全读写；请保留原件并停止修改。');
  const encrypted = () => {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  };
  return {
    load() {
      if (loaded || fault) throw failure();
      loaded = true;
      try {
        if (!encrypted()) throw failure();
        if (!io.existsSync(file)) return [];
        bytes = io.statSync(file).size;
        if (!bytes || bytes > MAX_BYTES) throw failure();
        const source = io.readFileSync(file, 'utf8');
        if (!source.endsWith('\n')) throw failure();
        let rows = [];
        for (const line of source.slice(0, -1).split('\n')) {
          const item = JSON.parse(line);
          if (item.sequence !== sequence + 1 || typeof item.ciphertext !== 'string' ||
              item.checksum !== digest(`${item.sequence}:${item.ciphertext}`)) throw failure();
          const decoded = safeStorage.decryptString(Buffer.from(item.ciphertext, 'base64'));
          rows = JSON.parse(decoded); sequence++;
          if (!Array.isArray(rows)) throw failure();
        }
        return rows;
      } catch { fault = true; throw failure(); }
    },
    save(rows) {
      if (!loaded || fault || !encrypted() || !Array.isArray(rows)) { fault = true; throw failure(); }
      let fd;
      try {
        const ciphertext = safeStorage.encryptString(JSON.stringify(rows)).toString('base64');
        const envelope = { sequence: sequence + 1, ciphertext,
          checksum: digest(`${sequence + 1}:${ciphertext}`) };
        const chunk = Buffer.from(JSON.stringify(envelope) + '\n');
        if (bytes + chunk.length > MAX_BYTES) throw failure();
        io.mkdirSync(dir, { recursive: true }); fd = io.openSync(file, 'a', 0o600);
        for (let offset = 0; offset < chunk.length;) {
          const written = io.writeSync(fd, chunk, offset, chunk.length - offset);
          if (!Number.isSafeInteger(written) || written <= 0) throw failure();
          offset += written;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
        bytes += chunk.length; sequence++;
      } catch { fault = true; throw failure(); }
      finally { if (fd !== undefined) try { io.closeSync(fd); } catch { fault = true; } }
    }
  };
}
module.exports = { makeBulkRateStore };
