'use strict';

const { randomBytes } = require('node:crypto');
const { createFinanceHttpServer } = require('./finance-http-server');

const PORT = 5191;
class FinanceHttpControlError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new FinanceHttpControlError(code, message); };

function makeFinanceHttpController({ store, assertOwner, getChannelRows, getFactorState,
  getCustomerSnapshot, serverFactory = createFinanceHttpServer, randomToken = () => randomBytes(32).toString('hex'),
  port = PORT }) {
  if (!store || typeof assertOwner !== 'function' || typeof getChannelRows !== 'function' ||
      typeof getFactorState !== 'function' || typeof getCustomerSnapshot !== 'function' ||
      typeof serverFactory !== 'function' || typeof randomToken !== 'function')
    throw new TypeError('财务接口控制器配置无效。');
  let server = null, busy = false, lastError = null;
  const live = () => !!server?.address();
  const state = () => ({ ...store.state(), listening: live(), host: '127.0.0.1',
    port: live() ? server.address().port : null, lastError });
  async function guarded(ownerId) {
    await assertOwner(ownerId);
  }
  async function start(ownerId, { rotate = false, resume = false } = {}) {
    if (busy) fail('BUSY', '财务只读接口正在切换，请稍后重试。');
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) fail('AUTH', '请先完成平台管理员授权。');
    busy = true;
    try {
      await guarded(ownerId);
      const previous = store.secret();
      if (previous && previous.ownerId !== ownerId && !rotate)
        fail('DENIED', '接口密钥属于另一管理员；请核对身份后轮换密钥。');
      if (live() && !rotate) return state();
      if (server) { await server.close(); server = null; }
      const token = resume && previous?.enabled && previous.ownerId === ownerId ? previous.token :
        !rotate && previous?.ownerId === ownerId ? previous.token : randomToken();
      if (!/^[a-f0-9]{64}$/.test(token)) fail('STORAGE', '接口密钥生成失败，未开启监听。');
      const next = { ownerId, token, enabled: true };
      // Persist the new secret before listening so a failed write never leaves an
      // undocumented live endpoint. A port conflict leaves the secret recoverable.
      if (!resume || !previous?.enabled || previous.ownerId !== ownerId) store.configure(next);
      const sourceGuard = async () => {
        const saved = store.secret();
        if (!saved?.enabled || saved.ownerId !== ownerId || saved.token !== token)
          fail('DENIED', '财务接口授权状态已变化。');
        await guarded(ownerId);
      };
      const candidate = serverFactory({ token, port,
        getChannelRows: async () => { await sourceGuard(); return getChannelRows(); },
        getFactorState: async () => { await sourceGuard(); return getFactorState(); },
        getCustomerSnapshot: async () => { await sourceGuard(); return getCustomerSnapshot(); } });
      try { await candidate.start(); server = candidate; lastError = null; }
      catch { await candidate.close().catch(() => {}); lastError = 'LISTEN_FAILED';
        fail('CONNECT', '本机财务接口端口不可用；未改为对外监听，请检查本机端口。'); }
      return state();
    } finally { busy = false; }
  }
  async function pause() {
    if (busy) fail('BUSY', '财务只读接口正在切换，请稍后重试。');
    busy = true;
    try {
      let storageFailure = false;
      try { const previous = store.secret(); if (previous?.enabled) store.configure({ ...previous, enabled: false }); }
      catch { storageFailure = true; }
      if (server) { await server.close(); server = null; }
      lastError = storageFailure ? 'STORAGE' : null;
      if (storageFailure) fail('STORAGE', '接口已停止，但配置未能安全保存；请保留原文件检查。');
      return state();
    } finally { busy = false; }
  }
  async function close() {
    if (server) { const current = server; server = null; await current.close(); }
  }
  function secretForCopy(ownerId) {
    if (!live()) fail('CONNECT', '财务只读接口未运行，不能复制访问密钥。');
    const current = store.secret();
    if (!current?.enabled || current.ownerId !== ownerId) fail('DENIED', '管理员身份与接口密钥不一致。');
    return current.token;
  }
  return { state, enable: ownerId => start(ownerId), rotate: ownerId => start(ownerId, { rotate: true }),
    resume: ownerId => start(ownerId, { resume: true }), pause, close, secretForCopy };
}

module.exports = { makeFinanceHttpController, FinanceHttpControlError, PORT };
