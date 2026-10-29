'use strict';
const { ToolError } = require('./service');
const ORIGIN = 'https://max.cheapi.cc';
const authError = () => new ToolError('AUTH', '服务尚未授权或授权已失效，请联系管理员维护。');
class AdminSession {
  constructor({ store, readCandidate, verify, flush, openLogin, onChange = () => {}, now = () => new Date().toISOString() }) {
    Object.assign(this, { store, readCandidate, verify, flush, openLogin, onChange, now });
    this.version = 0; this.verified = false; this.pending = null; this.verifiedAt = null;
    try { this.record = store.load(); this.phase = this.record ? 'saved' : 'required'; }
    catch { this.record = null; this.phase = 'storage-error'; }
  }
  state() {
    return { phase: this.phase, owner: this.record?.owner ?? null,
      savedAt: this.record?.savedAt ?? null, verifiedAt: this.verifiedAt,
      canRecover: this.phase === 'storage-error' && this.store.canRecover?.() === true };
  }
  changed() { this.onChange(this.state()); }
  persist(record) {
    try { this.store.save(record); }
    catch (e) { this.record = null; this.verified = false; this.phase = 'storage-error'; this.version++; this.changed(); throw e; }
  }
  assertCurrent(snapshot) {
    if (!this.verified || snapshot.version !== this.version || snapshot.token !== this.record?.token) throw authError();
  }
  reject(snapshot) {
    // A late 401 from an old request cannot revoke a newer administrator login.
    if (snapshot.version !== this.version || snapshot.token !== this.record?.token) return;
    try { this.persist(null); } catch { return; }
    this.record = null; this.verified = false; this.version++; this.phase = 'expired'; this.changed();
  }
  async ensure() {
    if (this.phase === 'storage-error') throw new ToolError('STORAGE', '本机授权存储异常，已暂停服务，请联系管理员。');
    if (this.phase === 'login') throw authError();
    if (this.verified) return { ...this.record, version: this.version };
    if (this.pending) return this.pending;
    if (this.record === null) throw authError();
    this.pending = this.restore();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async restore() {
    const version = this.version, previous = this.record;
    this.phase = 'checking'; this.changed();
    try {
      const token = previous?.token ?? await this.readCandidate();
      if (typeof token !== 'string' || !token) throw authError();
      const owner = await this.verify(token);
      if (!Number.isSafeInteger(owner) || owner <= 0 || (previous && owner !== previous.owner)) throw authError();
      if (version !== this.version) throw authError();
      if (!previous) {
        await this.flush();
        const record = { token, owner, origin: ORIGIN, savedAt: this.now() };
        this.persist(record); this.record = record;
      }
      this.verified = true; this.verifiedAt = this.now(); this.phase = 'ready'; this.changed();
      return { ...this.record, version: this.version };
    } catch (e) {
      if (this.phase !== 'storage-error' && version === this.version) {
        if (e.code === 'AUTH') { this.persist(null); this.record = null; this.version++; this.phase = 'expired'; }
        else this.phase = 'offline';
        this.changed();
      }
      throw e;
    }
  }
  async begin() {
    if (this.pending) throw new ToolError('BUSY', '正在验证授权，请稍后再打开登录。');
    if (this.phase === 'storage-error') throw new ToolError('STORAGE', '授权存储异常，请先保留记录并检查。');
    if (this.phase !== 'login') {
      this.persist(null); // Revoke before showing a page that can switch accounts.
      this.record = null; this.verified = false; this.verifiedAt = null; this.version++; this.phase = 'login'; this.changed();
    }
    await this.openLogin();
    return this.state();
  }
  recover(confirmed) {
    if (this.pending) throw new ToolError('BUSY', '正在核验授权，请稍后再恢复。');
    if (confirmed !== true || this.phase !== 'storage-error' || this.store.canRecover?.() !== true) {
      throw new ToolError('STORAGE', '此授权不能自动恢复；请保留文件检查，不要删除记录。');
    }
    try { this.store.recover(true); }
    catch { this.changed(); throw new ToolError('STORAGE', '授权恢复未安全完成，仍停止服务，请保留原文件检查。'); }
    this.record = null; this.verified = false; this.verifiedAt = null;
    this.version++; this.phase = 'required'; this.changed();
    return this.state(); // Separate explicit login is required; never opens or reads a browser.
  }
  async finish() {
    if (this.pending) return this.pending;
    if (this.phase !== 'login') throw new ToolError('AUTH', '请先点击登录／重新授权，再完成保存。');
    this.pending = (async () => {
      try {
        const token = await this.readCandidate();
        if (typeof token !== 'string' || !token) throw authError();
        const owner = await this.verify(token);
        if (!Number.isSafeInteger(owner) || owner <= 0) throw authError();
        await this.flush();
        const record = { token, owner, origin: ORIGIN, savedAt: this.now() };
        this.persist(record); this.record = record; this.verified = true; this.verifiedAt = this.now();
        this.version++; this.phase = 'ready'; this.changed();
        return this.state();
      } catch (e) { this.changed(); throw e; }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
}
module.exports = { AdminSession };
