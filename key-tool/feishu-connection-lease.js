'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function makeConnectionLease(file, io = fs, pid = process.pid) {
  let token = null;
  const error = () => new Error('飞书连接正在其他窗口运行，或本机连接锁需要管理员检查。');
  function acquire() {
    if (token) return true;
    io.mkdirSync(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = randomUUID();
      let fd;
      try {
        fd = io.openSync(file, 'wx', 0o600);
        const bytes = Buffer.from(JSON.stringify({ pid, token: candidate }) + '\n');
        let offset = 0;
        while (offset < bytes.length) {
          const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!Number.isSafeInteger(written) || written <= 0) throw error();
          offset += written;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined; token = candidate;
        return true;
      } catch (cause) {
        if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
        if (cause?.code !== 'EEXIST') throw error();
      }
      let current;
      try { current = JSON.parse(io.readFileSync(file, 'utf8')); } catch { throw error(); }
      if (!Number.isSafeInteger(current?.pid) || current.pid <= 0 || typeof current.token !== 'string' || !/^[0-9a-f-]{36}$/.test(current.token)) throw error();
      // Never reclaim a stale-looking lock automatically. PID reuse, partial exits,
      // and filesystem races make automatic deletion unsafe for a live socket.
      throw error();
    }
    throw error();
  }
  function release() {
    if (!token) return;
    try {
      const current = JSON.parse(io.readFileSync(file, 'utf8'));
      if (current.pid === pid && current.token === token) io.unlinkSync(file);
      token = null;
    } catch (cause) {
      // Keep ownership latched if durable state is uncertain.
      throw error();
    }
  }
  return { acquire, release, held: () => token !== null };
}
module.exports = { makeConnectionLease };
