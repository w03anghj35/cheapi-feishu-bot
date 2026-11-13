'use strict';

// A loopback-only adapter for already verified finance projections. The caller
// owns the administrator session and supplies a fresh, independent API secret.
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { calculateMonitoredSuppliers, calculateCustomerBalances } = require('./finance-metrics');

const HOST = '127.0.0.1';
const DEFAULT_CUSTOMER_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_CHANNEL_TIMEOUT_MS = 15_000;
const DEFAULT_CUSTOMER_TIMEOUT_MS = 125_000;
const RESPONSE_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
});

function createFinanceHttpServer({ token, getChannelRows, getFactorState,
  getCustomerSnapshot = null, now = () => Date.now(), port = 0,
  customerCooldownMs = DEFAULT_CUSTOMER_COOLDOWN_MS,
  channelTimeoutMs = DEFAULT_CHANNEL_TIMEOUT_MS,
  customerTimeoutMs = DEFAULT_CUSTOMER_TIMEOUT_MS } = {}) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
    throw new TypeError('财务接口需要独立的 32 字节随机十六进制凭据。');
  if (typeof getChannelRows !== 'function' || typeof getFactorState !== 'function' ||
      getCustomerSnapshot !== null && typeof getCustomerSnapshot !== 'function' ||
      typeof now !== 'function' || !Number.isInteger(port) || port < 0 || port > 65535 ||
      !Number.isSafeInteger(customerCooldownMs) || customerCooldownMs < 1000 ||
      !Number.isSafeInteger(channelTimeoutMs) || channelTimeoutMs < 10 || channelTimeoutMs > 300_000 ||
      !Number.isSafeInteger(customerTimeoutMs) || customerTimeoutMs < 10 || customerTimeoutMs > 300_000)
    throw new TypeError('财务接口配置无效。');

  const expected = Buffer.from(token, 'ascii');
  let channelBusy = false, customerBusy = false, customerNextAt = 0, started = false, closing = false;
  const controllers = new Set(), sockets = new Set();
  let closePromise = null;
  const send = (response, status, body, extra = {}) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { ...RESPONSE_HEADERS, ...extra });
    response.end(JSON.stringify(body));
  };
  const authorized = value => {
    if (typeof value !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(value)) return false;
    const actual = Buffer.from(value.slice(7), 'ascii');
    return timingSafeEqual(expected, actual);
  };
  const headerCount = (request, name) => {
    let count = 0;
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      if (request.rawHeaders[i].toLowerCase() === name) count++;
    return count;
  };
  const finishedAt = () => {
    try {
      const time = now();
      return Number.isSafeInteger(time) && time > 0 ? time : null;
    } catch { return null; }
  };
  // A timed-out provider may ignore AbortSignal. Keep its single-flight lock
  // until it truly settles so a retry cannot start an overlapping full scan.
  const readWithDeadline = (provider, timeoutMs, settled) => {
    const controller = new AbortController();
    controllers.add(controller);
    const source = Promise.resolve().then(() => provider({ signal: controller.signal }));
    const cleanup = () => {
      controllers.delete(controller);
      settled();
    };
    source.then(cleanup, cleanup);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('finance source timeout'));
      }, timeoutMs);
    });
    return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
  };

  const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void (async () => {
      if (closing) { send(response, 503, { error: 'FINANCE_SOURCE_UNAVAILABLE' }); return; }
      const address = server.address();
      if (!address || headerCount(request, 'host') !== 1 ||
          request.headers.host !== `${HOST}:${address.port}` ||
          request.headers.origin !== undefined || request.headers.referer !== undefined) {
        send(response, 403, { error: 'FORBIDDEN' }); return;
      }
      if (headerCount(request, 'authorization') !== 1 || !authorized(request.headers.authorization)) {
        send(response, 401, { error: 'UNAUTHORIZED' }, { 'WWW-Authenticate': 'Bearer' }); return;
      }
      if (request.method !== 'GET') {
        send(response, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' }); return;
      }
      if (request.headers['transfer-encoding'] !== undefined ||
          request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') {
        send(response, 400, { error: 'REQUEST_BODY_NOT_ALLOWED' }); return;
      }
      if (request.url === '/health') {
        send(response, 200, { status: 'ok' }); return;
      }
      if (request.url === '/v1/finance/channel-balances') {
        if (channelBusy) {
          send(response, 429, { error: 'QUERY_RATE_LIMITED' }, { 'Retry-After': '1' }); return;
        }
        channelBusy = true;
        try {
          const [rows, factors] = await readWithDeadline(
            async ({ signal }) => {
              // Check the local factor journal first. If it is damaged, do not
              // start an unnecessary remote read that could outlive this call.
              const factors = await getFactorState({ signal });
              const rows = await getChannelRows({ signal });
              return [rows, factors];
            },
            channelTimeoutMs, () => { channelBusy = false; });
          send(response, 200, calculateMonitoredSuppliers(rows, factors, { now: now() }));
        } catch {
          // Never leak source URLs, stored credentials, names, or amounts in errors.
          send(response, 503, { error: 'FINANCE_SOURCE_UNAVAILABLE' });
        }
        return;
      }
      if (request.url === '/v1/finance/customer-balances' && getCustomerSnapshot) {
        const time = now();
        if (!Number.isSafeInteger(time) || time <= 0) {
          send(response, 503, { error: 'FINANCE_SOURCE_UNAVAILABLE' }); return;
        }
        if (customerBusy || time < customerNextAt) {
          send(response, 429, { error: 'QUERY_RATE_LIMITED' },
            { 'Retry-After': String(Math.max(1, Math.ceil((customerNextAt - time) / 1000))) });
          return;
        }
        customerBusy = true;
        try {
          // This is a complete upstream scan, not a stale cached balance. The
          // provider must already check the current platform administrator.
          const snapshot = await readWithDeadline(getCustomerSnapshot, customerTimeoutMs, () => {
            const time = finishedAt();
            customerNextAt = time === null ? Number.MAX_SAFE_INTEGER :
              Math.min(Number.MAX_SAFE_INTEGER, time + customerCooldownMs);
            customerBusy = false;
          });
          if (!snapshot || snapshot.complete !== true || snapshot.unit !== 'CNY' ||
              !Array.isArray(snapshot.rows) || !snapshot.summary ||
              snapshot.summary.totalUsers !== snapshot.rows.length ||
              typeof snapshot.checkedAt !== 'string' || typeof snapshot.startedAt !== 'string')
            throw new Error('incomplete customer snapshot');
          const checkedAt = Date.parse(snapshot.checkedAt), startedAt = Date.parse(snapshot.startedAt);
          const completedAt = now();
          if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(snapshot.checkedAt) ||
              !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(snapshot.startedAt) ||
              !Number.isSafeInteger(completedAt) || !Number.isFinite(checkedAt) ||
              !Number.isFinite(startedAt) || startedAt > checkedAt ||
              checkedAt - startedAt > 120_000 || checkedAt > completedAt || completedAt - checkedAt > 120_000)
            throw new Error('stale customer snapshot');
          const calculated = calculateCustomerBalances({ currency: 'CNY', complete: true,
            total: snapshot.rows.length, users: snapshot.rows.map(row => ({
              id: row.id, role: row.role, balanceText: row.balance
            })) });
          const summary = snapshot.summary;
          if (summary.adminCount !== calculated.excludedAdminCount ||
              summary.positiveCount !== calculated.positiveCount ||
              summary.negativeCount !== calculated.negativeCount ||
              summary.zeroCount !== calculated.scannedUsers - calculated.excludedAdminCount -
                calculated.positiveCount - calculated.negativeCount ||
              summary.positiveTotal !== calculated.positiveBalanceCny ||
              summary.negativeTotal !== calculated.negativeBalanceCny)
            throw new Error('customer summary does not match rows');
          send(response, 200, { status: 'ready', asOf: snapshot.checkedAt, ...calculated });
        } catch {
          send(response, 503, { error: 'FINANCE_SOURCE_UNAVAILABLE' });
        }
        return;
      }
      send(response, 404, { error: 'NOT_FOUND' });
    })().catch(() => send(response, 503, { error: 'FINANCE_SOURCE_UNAVAILABLE' }));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return {
    async start() {
      if (started || closing || closePromise || customerBusy || channelBusy)
        throw new Error('财务接口已经启动或仍有读取未结束。');
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        try { server.listen(port, HOST); } catch (error) { server.off('error', onError); server.off('listening', onListening); reject(error); }
      });
      started = true;
      return { host: HOST, port: server.address().port };
    },
    async close() {
      if (!started) return;
      if (closePromise) return closePromise;
      closing = true;
      for (const controller of controllers) controller.abort();
      closePromise = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
      }).finally(() => { started = false; });
      return closePromise;
    },
    address() { return started ? { host: HOST, port: server.address().port } : null; }
  };
}

module.exports = { createFinanceHttpServer };
