'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ToolError } = require('./service');
const hash = text => createHash('sha256').update(text).digest('hex');
function validateRows(rows) {
  const ids = new Set();
  if (!Array.isArray(rows)) throw new Error('invalid records');
  for (const r of rows) {
    if (!r?.body || typeof r.requestId !== 'string' || ids.has(r.requestId) ||
        !['pending','unknown','success','failed','reviewed'].includes(r.state)) throw new Error('invalid record');
    ids.add(r.requestId);
  }
  return rows;
}
// A flushed append-only snapshot journal avoids rename on filesystems that return
// EXDEV even within one directory. Never copy/truncate the authoritative file.
function makeDiskStore(dir, safeStorage, io = fs) {
  const journal = path.join(dir, 'operations.journal');
  const legacy = path.join(dir, 'operations.json');
  let sequence = 0, loaded = false, damaged = false;
  function save(rows) {
    if (!loaded || damaged) throw new ToolError('STORAGE', '操作记录未就绪或写入失败，请保留文件并重新检查。');
    validateRows(rows);
    const payload = JSON.stringify({ sequence: sequence + 1, rows });
    const line = Buffer.from(JSON.stringify({ payload, checksum: hash(payload) }) + '\n');
    io.mkdirSync(dir, { recursive: true });
    let fd;
    try {
      fd = io.openSync(journal, 'a', 0o600);
      let offset = 0;
      while (offset < line.length) {
        const n = io.writeSync(fd, line, offset, line.length - offset);
        if (n <= 0) throw new Error('short write');
        offset += n;
      }
      io.fsyncSync(fd);
      io.closeSync(fd); fd = undefined;
      sequence++;
    } catch (e) { damaged = true; throw e; }
    finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { damaged = true; } } }
  }
  return {
    load() {
      if (loaded) throw new ToolError('STORAGE', '操作记录不可重复初始化。');
      try {
        let rows = [];
        if (io.existsSync(journal)) {
          const text = io.readFileSync(journal, 'utf8');
          if (!text || !text.endsWith('\n')) throw new Error('incomplete journal');
          for (const line of text.slice(0, -1).split('\n')) {
            const { payload, checksum } = JSON.parse(line);
            if (typeof payload !== 'string' || checksum !== hash(payload)) throw new Error('checksum');
            const next = JSON.parse(payload);
            if (next.sequence !== sequence + 1) throw new Error('sequence');
            rows = validateRows(next.rows); sequence = next.sequence;
          }
          loaded = true;
          return rows;
        }
        if (io.existsSync(legacy)) rows = validateRows(JSON.parse(io.readFileSync(legacy, 'utf8')));
        // An orphaned temp file may represent an uncertain remote operation.
        // Preserve it and its protection; never silently drop or auto-unlock it.
        if (io.existsSync(legacy + '.tmp')) {
          const pending = validateRows(JSON.parse(io.readFileSync(legacy + '.tmp', 'utf8')));
          const merged = new Map(rows.map(r => [r.requestId, r]));
          for (const r of pending) {
            const old = merged.get(r.requestId);
            if (old && (old.owner !== r.owner || old.fingerprint !== r.fingerprint)) throw new Error('conflict');
            merged.set(r.requestId, { ...r, state: 'unknown' });
          }
          rows = [...merged.values()];
        }
        loaded = true;
        save(rows); // First usable journal must be durable before accepting commands.
        return rows;
      } catch { damaged = true; throw new ToolError('STORAGE', '操作记录无法读取或安全保存，已锁定创建。请保留原文件并检查。'); }
    },
    save,
    seal(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new ToolError('STORAGE', '系统加密不可用，已停止创建。');
      return safeStorage.encryptString(JSON.stringify(value)).toString('base64');
    },
    open: value => JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64')))
  };
}
module.exports = { makeDiskStore };
