'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_BYTES = 1024 * 1024;
const emptyPolicy = () => ({ enabled: false, ownerOpenId: null, groupId: null,
  platformOwnerId: null, maxQuota: null, maxUserDailyQuota: null, maxGroupDailyQuota: null });
const digest = value => createHash('sha256').update(value).digest('hex');
function amount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 &&
    value <= 999999999999.9999 && /^\d{1,12}(?:\.\d{1,4})?$/.test(String(value));
}
function validatePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' ||
      !(value.ownerOpenId === null || (typeof value.ownerOpenId === 'string' && /^[\w:-]{4,256}$/.test(value.ownerOpenId))) ||
      !(value.groupId === null || (typeof value.groupId === 'string' && /^oc_[\w-]{8,128}$/.test(value.groupId))) ||
      !(value.platformOwnerId === null || (Number.isSafeInteger(value.platformOwnerId) && value.platformOwnerId > 0)) ||
      !(value.maxQuota === null || amount(value.maxQuota)) ||
      !(value.maxUserDailyQuota === null || amount(value.maxUserDailyQuota)) ||
      !(value.maxGroupDailyQuota === null || amount(value.maxGroupDailyQuota)) ||
      (value.enabled && (!value.ownerOpenId || !value.groupId || !value.platformOwnerId || !value.maxQuota)) ||
      (value.maxQuota && value.maxUserDailyQuota && value.maxUserDailyQuota < value.maxQuota) ||
      (value.maxQuota && value.maxGroupDailyQuota && value.maxGroupDailyQuota < value.maxQuota)) throw new Error('invalid policy');
  return { enabled: value.enabled, ownerOpenId: value.ownerOpenId, groupId: value.groupId,
    platformOwnerId: value.platformOwnerId, maxQuota: value.maxQuota, maxUserDailyQuota: value.maxUserDailyQuota, maxGroupDailyQuota: value.maxGroupDailyQuota };
}
function normalizeStoredPolicy(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'platformOwnerId')) {
    // Existing local policies had no durable 2API-account binding. Keep their
    // setup fields but force them off until an administrator explicitly saves
    // a policy tied to the currently authorized platform account.
    return validatePolicy({ ...value, enabled: false, platformOwnerId: null });
  }
  return validatePolicy(value);
}
function makeFeishuPolicyStore(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'feishu-bot-policy.journal');
  let sequence = 0, loaded = false, damaged = false;
  const fail = () => new Error('飞书群机器人配置无法安全读取或保存，功能已关闭；请保留配置文件并检查。');
  function encryption() {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw fail();
  }
  return {
    load() {
      if (loaded || damaged) throw fail();
      try {
        encryption(); loaded = true;
        if (!io.existsSync(file)) return emptyPolicy();
        if (io.statSync(file).size > MAX_BYTES) throw fail();
        const text = io.readFileSync(file, 'utf8');
        if (!text || !text.endsWith('\n')) throw fail();
        let last = emptyPolicy();
        for (const line of text.slice(0, -1).split('\n')) {
          const entry = JSON.parse(line);
          if (typeof entry.payload !== 'string' || digest(entry.payload) !== entry.checksum) throw fail();
          const row = JSON.parse(entry.payload);
          if (row.sequence !== sequence + 1 || typeof row.sealed !== 'string' || !row.sealed) throw fail();
          last = normalizeStoredPolicy(JSON.parse(safeStorage.decryptString(Buffer.from(row.sealed, 'base64'))));
          sequence = row.sequence;
        }
        return last;
      } catch { damaged = true; throw fail(); }
    },
    save(value) {
      if (!loaded || damaged) throw fail();
      const policy = validatePolicy(value);
      let fd;
      try {
        encryption();
        const payload = JSON.stringify({ sequence: sequence + 1,
          sealed: safeStorage.encryptString(JSON.stringify(policy)).toString('base64') });
        const line = Buffer.from(JSON.stringify({ payload, checksum: digest(payload) }) + '\n');
        if ((io.existsSync(file) ? io.statSync(file).size : 0) + line.length > MAX_BYTES) throw fail();
        io.mkdirSync(dir, { recursive: true });
        fd = io.openSync(file, 'a', 0o600);
        let offset = 0;
        while (offset < line.length) {
          const n = io.writeSync(fd, line, offset, line.length - offset);
          if (!Number.isSafeInteger(n) || n <= 0) throw fail();
          offset += n;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined; sequence++;
      } catch { damaged = true; throw fail(); }
      finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { damaged = true; } } }
      return policy;
    }
  };
}
module.exports = { emptyPolicy, validatePolicy, normalizeStoredPolicy, makeFeishuPolicyStore };
