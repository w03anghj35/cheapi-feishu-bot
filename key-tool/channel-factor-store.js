'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CHANNELS } = require('./channel-monitor');

const IDS = new Set(CHANNELS.map(channel => channel.id));
const MAX_BYTES = 256 * 1024;
const SCALE = 100000000n;
const MAX_SCALED = 1000000n * SCALE;
const digest = value => createHash('sha256').update(value).digest('hex');

class ChannelFactorError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new ChannelFactorError(code, message); };
const invalidStorage = () => new ChannelFactorError('STORAGE', '渠道倍率记录无法安全读写，请保留原文件核对。');

function normalizeRate(value) {
  if (typeof value !== 'string' || value.length > 17 ||
      !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,8})?$/.test(value))
    fail('INPUT', '倍率须为大于 0 且不超过 1000000 的数值，最多 8 位小数。');
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
  if (scaled <= 0n || scaled > MAX_SCALED)
    fail('INPUT', '倍率须为大于 0 且不超过 1000000 的数值，最多 8 位小数。');
  const normalized = fraction.replace(/0+$/, '');
  return normalized ? `${whole}.${normalized}` : whole;
}

function validateFactors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(id => !IDS.has(id))) throw invalidStorage();
  const next = {};
  for (const [id, item] of Object.entries(value)) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).sort().join('|') !== 'rate|updatedAt' ||
        typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)))
      throw invalidStorage();
    let rate;
    try { rate = normalizeRate(item.rate); } catch { throw invalidStorage(); }
    if (rate !== item.rate) throw invalidStorage();
    next[id] = { rate, updatedAt: item.updatedAt };
  }
  return next;
}

function makeChannelFactorStore(dir, io = fs, now = () => Date.now()) {
  const file = path.join(dir, 'channel-monitor-factors.journal');
  let loaded = false, fault = false, sequence = 0, factors = {};
  let fileIdentity = null, fileSize = 0, fileHash = null;
  function bad() { fault = true; throw invalidStorage(); }
  function assertCurrent() {
    if (!loaded || fault) throw invalidStorage();
    try {
      if (io.existsSync(dir) && io.lstatSync(dir).isSymbolicLink()) bad();
      if (fileIdentity !== null) {
        if (!io.existsSync(file)) bad();
        if (io.lstatSync(file).isSymbolicLink()) bad();
        const stat = io.statSync(file);
        if (stat.ino !== fileIdentity || stat.size !== fileSize || digest(io.readFileSync(file)) !== fileHash) bad();
      } else if (io.existsSync(file)) bad();
    } catch { bad(); }
  }
  function publicState() {
    return { factors: CHANNELS.map(channel => ({ id: channel.id,
      rate: factors[channel.id]?.rate ?? null,
      updatedAt: factors[channel.id]?.updatedAt ?? null })), storageError: false };
  }
  return {
    load() {
      if (loaded || fault) throw invalidStorage();
      loaded = true;
      try {
        if (io.existsSync(dir) && io.lstatSync(dir).isSymbolicLink()) bad();
        if (!io.existsSync(file)) return publicState();
        if (io.lstatSync(file).isSymbolicLink()) bad();
        const stat = io.statSync(file);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) bad();
        const raw = io.readFileSync(file, 'utf8');
        if (!raw.endsWith('\n') || !raw.length) bad();
        for (const line of raw.slice(0, -1).split('\n')) {
          const envelope = JSON.parse(line);
          if (!envelope || Object.keys(envelope).sort().join('|') !== 'checksum|payload' ||
              typeof envelope.payload !== 'string' || envelope.checksum !== digest(envelope.payload)) bad();
          const snapshot = JSON.parse(envelope.payload);
          if (!snapshot || Object.keys(snapshot).sort().join('|') !== 'factors|sequence' ||
              snapshot.sequence !== ++sequence) bad();
          factors = validateFactors(snapshot.factors);
        }
        fileIdentity = stat.ino; fileSize = stat.size; fileHash = digest(raw);
        return publicState();
      } catch { bad(); }
    },
    state() { assertCurrent(); return publicState(); },
    save(input) {
      assertCurrent();
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).sort().join('|') !== 'id|rate' || !IDS.has(input.id))
        fail('INPUT', '请选择已配置渠道并填写有效倍率。');
      const rate = normalizeRate(input.rate);
      const stamp = new Date(now()).toISOString();
      const next = { ...factors, [input.id]: { rate, updatedAt: stamp } };
      const payload = JSON.stringify({ sequence: sequence + 1, factors: next });
      const line = Buffer.from(JSON.stringify({ payload, checksum: digest(payload) }) + '\n');
      let fd;
      try {
        io.mkdirSync(dir, { recursive: true });
        const size = io.existsSync(file) ? io.statSync(file).size : 0;
        if (size + line.length > MAX_BYTES) bad();
        fd = io.openSync(file, 'a', 0o600);
        for (let offset = 0; offset < line.length;) {
          const written = io.writeSync(fd, line, offset, line.length - offset);
          if (!Number.isInteger(written) || written <= 0 || written > line.length - offset) bad();
          offset += written;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
        const stat = io.statSync(file);
        fileIdentity = stat.ino; fileSize = stat.size;
        fileHash = digest(io.readFileSync(file));
        sequence++; factors = next;
        return publicState();
      } catch { bad(); }
      finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { fault = true; } } }
    }
  };
}

module.exports = { makeChannelFactorStore, normalizeRate, ChannelFactorError };
