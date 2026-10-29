'use strict';
const { ConnectionError, validateCredentials } = require('./feishu-store');

// The connection can be used by an explicitly injected, trusted local workflow.
class FeishuConnection {
  constructor({ store, createClient, handlers = {}, mode = 'diagnostics-only', lease = null, now = () => new Date().toISOString(), timers = globalThis, timeoutMs = 45000 }) {
    this.store = store; this.createClient = createClient; this.handlers = handlers; this.mode = mode; this.lease = lease; this.now = now;
    this.timers = timers; this.timeoutMs = timeoutMs;
    this.client = null; this.generation = 0; this.deadline = null; this.record = null;
    this.phase = 'unconfigured'; this.error = null; this.storageError = false;
    this.counts = { messages: 0, callbacks: 0, diagnostics: 0 };
    this.connectedAt = null; this.lastEventAt = null;
    try {
      this.record = store.load() || null;
      if (this.record) this.phase = 'disconnected';
    } catch {
      this.storageError = true; this.phase = 'storage-error';
      this.error = { code: 'STORAGE', message: '无法安全读取飞书配置，连接已禁用；请保留原文件检查。' };
    }
  }
  state() {
    let transport = 'idle', reconnectAttempts = 0;
    if (this.client) {
      try {
        const status = this.client.getConnectionStatus();
        if (['idle', 'connecting', 'connected', 'reconnecting', 'failed'].includes(status.state)) transport = status.state;
        if (Number.isSafeInteger(status.reconnectAttempts) && status.reconnectAttempts >= 0) reconnectAttempts = status.reconnectAttempts;
        // SDK reconnect callbacks can precede its isConnecting=false assignment.
        if (['connecting', 'reconnecting'].includes(this.phase) && transport === 'connected') this.ready(this.generation);
        // A lost socket must not continue to appear online while a callback is delayed.
        if (this.phase === 'connected' && transport !== 'connected') this.reconnecting(this.generation);
      } catch {
        this.fail(this.generation, 'STATUS', '无法确认连接状态，已停止连接；请检查后重试。');
      }
    }
    return {
      phase: this.phase, appId: this.record?.appId || '', savedAt: this.record?.savedAt || null,
      hasCredential: Boolean(this.record), storageError: this.storageError, active: Boolean(this.client),
      connectedAt: this.connectedAt, lastEventAt: this.lastEventAt, counts: { ...this.counts },
      transport, reconnectAttempts, error: this.error ? { ...this.error } : null,
      mode: this.mode
    };
  }
  save(input) {
    if (this.client) throw new ConnectionError('BUSY', '请先断开连接，再修改应用配置。');
    if (this.storageError) throw new ConnectionError('STORAGE', '配置存储异常，已禁止覆盖；请保留文件并检查。');
    const record = { ...validateCredentials(input), savedAt: this.now() };
    try { this.store.save(record); }
    catch {
      this.storageError = true; this.record = null; this.phase = 'storage-error';
      this.error = { code: 'STORAGE', message: '配置没有安全保存，连接已禁用；请检查本机存储。' };
      throw new ConnectionError(this.error.code, this.error.message);
    }
    this.record = record; this.phase = 'disconnected'; this.error = null;
    return this.state();
  }
  clearDeadline() {
    if (this.deadline !== null) this.timers.clearTimeout(this.deadline);
    this.deadline = null;
  }
  armDeadline(generation) {
    this.clearDeadline();
    this.deadline = this.timers.setTimeout(() => {
      this.fail(generation, 'TIMEOUT', '45 秒内未建立连接，已停止本轮尝试。请检查网络、凭据及飞书后台配置，再手动重试。');
    }, this.timeoutMs);
    this.deadline?.unref?.();
  }
  reconnecting(generation) {
    if (generation !== this.generation || !this.client || this.phase === 'stop-error') return;
    if (this.phase !== 'reconnecting') { this.phase = 'reconnecting'; this.armDeadline(generation); }
  }
  ready(generation) {
    if (generation !== this.generation || !this.client || this.phase === 'stop-error') return;
    // start() resolves before the handshake. Only SDK-confirmed OPEN is online.
    try { if (this.client.getConnectionStatus().state !== 'connected') return; }
    catch { return this.fail(generation, 'STATUS', '无法核验连接状态，已停止连接。'); }
    this.clearDeadline(); this.phase = 'connected'; this.error = null; this.connectedAt = this.now();
  }
  fail(generation, code, message) {
    if (generation !== this.generation) return;
    this.disconnect();
    if (this.phase !== 'stop-error') { this.phase = 'failed'; this.error = { code, message }; }
  }
  connect() {
    if (this.storageError) throw new ConnectionError('STORAGE', '配置异常，连接已禁用。');
    if (!this.record) throw new ConnectionError('CONFIG', '请先填写并加密保存 App ID 和 App Secret。');
    if (this.phase === 'stop-error') throw new ConnectionError('STOP', '旧连接未正常停止，请关闭此窗口后重新打开。');
    if (this.client) return this.state();
    try { this.lease?.acquire(); } catch { this.phase = 'failed'; this.error = { code: 'BUSY', message: '飞书连接已在另一窗口运行；请断开另一连接后重试。' }; throw new ConnectionError('BUSY', this.error.message); }
    const generation = ++this.generation;
    this.phase = 'connecting'; this.error = null; this.connectedAt = null; this.lastEventAt = null;
    this.counts = { messages: 0, callbacks: 0, diagnostics: 0 };
    const receive = kind => {
      if (generation !== this.generation || !this.client || this.phase === 'stop-error') return false;
      this.counts[kind]++; this.lastEventAt = this.now(); return true;
    };
    try {
      this.client = this.createClient({
        appId: this.record.appId, appSecret: this.record.appSecret,
        onReady: () => this.ready(generation), onReconnected: () => this.ready(generation),
        onReconnecting: () => this.reconnecting(generation),
        onError: () => this.fail(generation, 'CONNECT', '连接失败，已停止重试。请核对 App ID、App Secret、网络和长连接配置。'),
        onDiagnostic: () => { if (generation === this.generation) this.counts.diagnostics++; },
        handlers: {
          'im.message.receive_v1': event => {
            if (!receive('messages') || typeof this.handlers.message !== 'function') return;
            return Promise.resolve().then(() => this.handlers.message(event)).catch(() => {
              if (generation === this.generation) this.counts.diagnostics++;
              return undefined;
            });
          },
          'card.action.trigger': event => {
            const active = receive('callbacks');
            if (active && this.mode === 'feishu-key-workflow' && typeof this.handlers.card === 'function') {
              try { return this.handlers.card(event); }
              catch { this.counts.diagnostics++; return { toast: { type: 'error', content: '本次操作未确认，请检查私聊提示；不要重复创建。' } }; }
            }
            return { toast: { type: 'warning', content: active ? '当前为连接诊断模式，尚未开放创建令牌，未执行任何创建。' : '此连接已停止，未执行任何创建。' } };
          }
        }
      });
      this.armDeadline(generation);
      // Deferred invocation also catches synchronous failures without leaving a busy promise behind.
      const client = this.client;
      Promise.resolve().then(() => {
        if (generation !== this.generation) return;
        return client.start();
      }).catch(() => this.fail(generation, 'CONNECT', '连接启动失败，已停止本轮尝试；请检查配置后重试。'));
    } catch { this.fail(generation, 'SDK', '飞书组件未能启动，请检查安装后重试。'); }
    return this.state();
  }
  disconnect() {
    ++this.generation; this.clearDeadline();
    if (this.client) {
      try { this.client.close({ force: true }); this.client = null; }
      catch {
        this.phase = 'stop-error'; this.error = { code: 'STOP', message: '连接未正常停止，禁止建立第二条连接；请关闭此窗口后重新打开。' };
        return;
      }
    }
    try { this.lease?.release(); }
    catch {
      this.phase = 'stop-error'; this.error = { code: 'STOP', message: '连接锁状态不确定，禁止建立第二条连接；请保留锁文件并检查。' };
      return;
    }
    this.phase = this.storageError ? 'storage-error' : this.record ? 'disconnected' : 'unconfigured';
    if (!this.storageError) this.error = null;
  }
}
module.exports = { FeishuConnection };
