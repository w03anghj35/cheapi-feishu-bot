'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_BYTES = 4 * 1024 * 1024;
const digest = text => createHash('sha256').update(text).digest('hex');
function validate(scope, draft) {
  if (!Number.isSafeInteger(scope?.owner) || scope.owner <= 0 ||
      typeof scope.groupId !== 'string' || !/^oc_[\w-]{8,128}$/.test(scope.groupId)) throw Error('scope');
  if (draft === null) return null;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) ||
      typeof draft.profile !== 'string' || draft.profile.length > 100 ||
      typeof draft.name !== 'string' || draft.name.length > 100 ||
      typeof draft.search !== 'string' || draft.search.length > 200 ||
      /[\x00-\x1f\x7f]/.test(draft.profile + draft.name + draft.search) ||
      !Array.isArray(draft.userIds) || draft.userIds.length > 2000 ||
      draft.userIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(draft.userIds).size !== draft.userIds.length) throw Error('draft');
  return { profile: draft.profile, name: draft.name, search: draft.search,
    userIds: [...draft.userIds] };
}
function makeOwnershipDraftStore(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'ownership-drafts.journal');
  let loaded = false, fault = false, sequence = 0, bytes = 0;
  const drafts = new Map();
  const failure = () => Error('归属草稿无法安全读写；请保留原文件，暂勿关闭窗口。');
  const encrypted = () => {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  };
  const key = scope => `${scope.owner}:${scope.groupId}`;
  return {
    load() {
      if (loaded || fault) throw failure(); loaded = true;
      try {
        if (!encrypted()) throw failure();
        if (!io.existsSync(file)) return;
        bytes = io.statSync(file).size;
        if (!bytes || bytes > MAX_BYTES) throw failure();
        const source = io.readFileSync(file, 'utf8');
        if (!source.endsWith('\n')) throw failure();
        for (const line of source.slice(0, -1).split('\n')) {
          const row = JSON.parse(line);
          if (row.sequence !== sequence + 1 || typeof row.ciphertext !== 'string' ||
              row.checksum !== digest(`${row.sequence}:${row.ciphertext}`)) throw failure();
          const value = JSON.parse(safeStorage.decryptString(Buffer.from(row.ciphertext, 'base64')));
          const draft = validate(value.scope, value.draft);
          drafts.set(key(value.scope), draft); sequence++;
        }
      } catch { fault = true; throw failure(); }
    },
    state(scope) {
      if (!loaded || fault) throw failure();
      validate(scope, null);
      return structuredClone(drafts.get(key(scope)) || null);
    },
    save(scope, input) {
      if (!loaded || fault || !encrypted()) { fault = true; throw failure(); }
      const draft = validate(scope, input);
      let fd;
      try {
        const ciphertext = safeStorage.encryptString(JSON.stringify({ scope, draft })).toString('base64');
        const envelope = { sequence: sequence + 1, ciphertext,
          checksum: digest(`${sequence + 1}:${ciphertext}`) };
        const chunk = Buffer.from(JSON.stringify(envelope) + '\n');
        if (bytes + chunk.length > MAX_BYTES) throw failure();
        io.mkdirSync(dir, { recursive: true }); fd = io.openSync(file, 'a', 0o600);
        for (let offset = 0; offset < chunk.length;) {
          const n = io.writeSync(fd, chunk, offset, chunk.length - offset);
          if (!Number.isSafeInteger(n) || n <= 0) throw failure();
          offset += n;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
        bytes += chunk.length; sequence++; drafts.set(key(scope), draft);
        return structuredClone(draft);
      } catch { fault = true; throw failure(); }
      finally { if (fd !== undefined) try { io.closeSync(fd); } catch { fault = true; } }
    }
  };
}
module.exports = { makeOwnershipDraftStore };
