'use strict';

// Owns connection intent, not business retries. SDK owns an active socket attempt;
// we only create a replacement after FeishuConnection has closed it safely.
class FeishuReconnect {
  constructor({ connection, ensureReady, timers = globalThis, now = () => Date.now(), pollMs = 5000, stableMs = 60000 }) {
    Object.assign(this, { connection, ensureReady, timers, now, pollMs, stableMs });
    this.enabled = false; this.timer = null; this.inFlight = null; this.version = 0;
    this.attempts = 0; this.nextRetryAt = null; this.onlineSince = null; this.reason = 'manual';
  }
  state() {
    return { enabled: this.enabled, attempts: this.attempts, nextRetryAt: this.nextRetryAt,
      reason: this.reason, checking: this.inFlight !== null };
  }
  clearTimer() { if (this.timer !== null) this.timers.clearTimeout(this.timer); this.timer = null; }
  schedule() {
    if (!this.enabled || this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.tick(); }, this.pollMs);
    this.timer?.unref?.();
  }
  async start() {
    if (!this.enabled) { this.enabled = true; this.version++; this.attempts = 0; this.nextRetryAt = null; this.reason = null; }
    this.clearTimer();
    await this.tick();
    return this.state();
  }
  stop() {
    this.enabled = false; this.version++; this.clearTimer(); this.nextRetryAt = null;
    this.onlineSince = null; this.reason = 'manual'; this.connection.disconnect();
  }
  defer(reason) {
    this.reason = reason;
    if (this.nextRetryAt === null) this.nextRetryAt = this.now() + Math.min(60000, 5000 * 2 ** Math.min(Math.max(0, this.attempts - 1), 4));
  }
  async tick() {
    if (!this.enabled) return;
    if (this.inFlight) return this.inFlight;
    const version = this.version;
    this.inFlight = Promise.resolve().then(async () => {
      if (!this.enabled || version !== this.version) return;
      const c = this.connection.state(); // Detect a silently lost socket without renderer polling.
      if (c.storageError || c.phase === 'stop-error') { this.reason = c.storageError ? 'storage' : 'stop'; this.nextRetryAt = null; return; }
      if (!c.hasCredential) { this.reason = 'credentials'; this.nextRetryAt = null; return; }
      if (c.phase === 'connected') {
        this.reason = null; this.nextRetryAt = null;
        if (this.onlineSince === null) this.onlineSince = this.now();
        if (this.now() - this.onlineSince >= this.stableMs) this.attempts = 0;
        return;
      }
      this.onlineSince = null;
      if (c.active) { this.reason = 'connecting'; return; } // Do not race the SDK's reconnect/deadline.
      if (this.attempts > 0 && this.nextRetryAt === null) this.defer(c.error?.code === 'BUSY' ? 'lease' : 'retry');
      if (this.nextRetryAt !== null && this.now() < this.nextRetryAt) return;
      this.nextRetryAt = null; this.attempts = Math.min(this.attempts + 1, 1000000); this.reason = 'auth';
      try {
        await this.ensureReady();
        if (!this.enabled || version !== this.version) return;
        const latest = this.connection.state();
        if (latest.storageError || latest.phase === 'stop-error' || !latest.hasCredential || latest.active) return;
        this.connection.connect(); this.reason = 'connecting';
      } catch (error) {
        if (this.enabled && version === this.version) this.defer(error?.code === 'BUSY' ? 'lease' : 'auth');
      }
    }).catch(() => { if (this.enabled && version === this.version) this.defer('retry'); })
      .finally(() => { this.inFlight = null; this.schedule(); });
    return this.inFlight;
  }
}
module.exports = { FeishuReconnect };
