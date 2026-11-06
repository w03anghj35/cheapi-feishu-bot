'use strict';
const { CHANNELS, INTERVAL_MS, safeName, chooseMetric } = require('./channel-monitor');
const RECOVERY_DELAYS_MS = Object.freeze([2, 5, 10, 15].map(minutes => minutes * 60_000));
function nextDelay(status, attempts) {
  if (status === 'ok') return INTERVAL_MS;
  if (status === 'user-browsing') return 60_000;
  return RECOVERY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RECOVERY_DELAYS_MS.length - 1)];
}
class ChannelMonitorController {
  constructor({ store, host, now = () => Date.now(), timers = globalThis, onChange = () => {}, onResult = () => {} }) {
    Object.assign(this, { store, host, now, timers, onChange, onResult });
    this.names = store.load(); this.running = false; this.timer = null; this.inFlight = null; this.generation = 0;
    this.rows = new Map(CHANNELS.map((channel, index) => [channel.id, {
      id: channel.id, status: 'waiting', checkedAt: null, successAt: null, value: null, display: null,
      nextAt: now() + index * 10000, recoveryAttempts: 0, error: null
    }]));
  }
  channel(id) {
    const channel = CHANNELS.find(item => item.id === id);
    if (!channel) throw new Error('未知渠道。');
    return channel;
  }
  state() {
    return CHANNELS.map(channel => ({ ...this.rows.get(channel.id), name: this.names[channel.id] || channel.defaultName,
      origin: channel.origin, metric: channel.metric, path: channel.path }));
  }
  publish() { try { this.onChange(this.state()); } catch { /* UI cannot own monitoring state. */ } }
  rename(id, name) {
    this.channel(id);
    const next = { ...this.names, [id]: safeName(name) };
    this.names = this.store.save(next);
    this.publish(); return this.state();
  }
  start() { if (this.running) return; this.running = true; this.generation++; this.schedule(1000); }
  stop() { this.running = false; this.generation++; if (this.timer) this.timers.clearTimeout(this.timer); this.timer = null; }
  schedule(delay = 60000) {
    if (!this.running || this.timer) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.tick(); }, delay);
    this.timer?.unref?.();
  }
  async open(id) {
    const channel = this.channel(id);
    await this.host.load(channel, { visible: true });
    return this.state();
  }
  async check(id, userRequested = false) {
    const channel = this.channel(id);
    if (this.inFlight) { if (userRequested) throw new Error('另一渠道正在读取，请稍后。'); return; }
    const row = this.rows.get(id), startedAt = this.now(), generation = this.generation;
    if (!userRequested && row.nextAt > startedAt) return;
    this.inFlight = id; row.status = 'checking'; row.error = null; this.publish();
    try {
      const observation = await this.host.observe(channel, { userRequested });
      if (generation !== this.generation) return this.state();
      const result = observation?.status === 'user-browsing' ? { status: 'user-browsing' } :
        observation?.status === 'login-required' ? { status: 'login-required' } :
        observation?.status === 'login-form-unavailable' ? { status: 'login-form-unavailable' } : chooseMetric(channel, observation);
      row.status = result.status;
      if (result.status === 'ok') {
        row.value = result.value; row.display = result.display; row.successAt = new Date(this.now()).toISOString();
      }
      row.checkedAt = new Date(this.now()).toISOString();
      if (result.status === 'ok') row.recoveryAttempts = 0;
      else if (result.status !== 'user-browsing') row.recoveryAttempts++;
      row.nextAt = this.now() + nextDelay(result.status, row.recoveryAttempts);
      row.error = null;
      if (result.status === 'ok') try { this.onResult(channel, { ...row, name: this.names[channel.id] || channel.defaultName }); } catch { /* Alerting cannot alter the read result. */ }
    } catch {
      if (generation !== this.generation) return this.state();
      row.status = 'failed'; row.error = '页面读取失败；检查网络或登录窗口。';
      row.checkedAt = new Date(this.now()).toISOString(); row.recoveryAttempts++;
      row.nextAt = this.now() + nextDelay(row.status, row.recoveryAttempts);
    } finally { this.inFlight = null; this.publish(); }
    return this.state();
  }
  async tick() {
    if (!this.running) return;
    if (!this.inFlight) {
      const due = CHANNELS.find(channel => this.rows.get(channel.id).nextAt <= this.now());
      if (due) await this.check(due.id);
    }
    this.schedule(1000);
  }
}
module.exports = { ChannelMonitorController, RECOVERY_DELAYS_MS, nextDelay };
