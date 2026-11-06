'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { ToolError } = require('./service');

const validId = id => Number.isSafeInteger(id) && id > 0;
const fail = (code, message) => { throw new ToolError(code, message); };
const checksum = text => createHash('sha256').update(text).digest('hex');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const states = new Set(['scheduled', 'attempting', 'done', 'unknown', 'missed', 'cancelled']);
const MAX_PLANS = 100;
const MAX_FILE = 32 * 1024 * 1024;
const GRACE_MS = 5 * 60_000;

function beijingTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
    fail('INPUT', '请填写完整的北京时间（年、月、日、时、分）。');
  const epoch = Date.parse(value + ':00+08:00');
  const roundtrip = Number.isFinite(epoch) ? new Date(epoch + 8 * 3600_000).toISOString().slice(0, 16) : '';
  if (roundtrip !== value) fail('INPUT', '日期不存在，请检查月份和日期。');
  return epoch;
}
function projectAccount(raw, expectedId) {
  if (!validId(raw?.id) || (expectedId !== undefined && raw.id !== expectedId) ||
      typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200 || /[\x00-\x1f\x7f]/.test(raw.name) ||
      typeof raw.schedulable !== 'boolean') fail('SCHEMA', '平台账号资料缺少准确 ID、名称或调度状态。');
  return { id: raw.id, name: raw.name, platform: typeof raw.platform === 'string' ? raw.platform.slice(0, 50) : '',
    status: typeof raw.status === 'string' ? raw.status.slice(0, 40) : '', schedulable: raw.schedulable };
}
function validatePlans(plans) {
  if (!Array.isArray(plans) || plans.length > MAX_PLANS) fail('STORAGE', '账号计划记录超出范围或已损坏。');
  const ids = new Set();
  for (const plan of plans) {
    if (!exactKeys(plan, ['id', 'owner', 'order', 'steps']) ||
        typeof plan.id !== 'string' || !/^[0-9a-f-]{36}$/.test(plan.id) || ids.has(plan.id) ||
        !validId(plan.owner) || !['open-first', 'close-first'].includes(plan.order) ||
        !Array.isArray(plan.steps) || plan.steps.length !== 2) fail('STORAGE', '账号计划记录已损坏。');
    ids.add(plan.id);
    for (const [index, step] of plan.steps.entries()) {
      if (!exactKeys(step, ['accountId', 'desired', 'at', 'epoch', 'state', 'finishedAt']) ||
          !validId(step.accountId) || typeof step.desired !== 'boolean' ||
          step.desired !== (plan.order === 'open-first' ? index === 0 : index === 1) ||
          !states.has(step.state) || typeof step.at !== 'string' || beijingTime(step.at) !== step.epoch ||
          (step.finishedAt !== null && (typeof step.finishedAt !== 'string' || !Number.isFinite(Date.parse(step.finishedAt)))) ||
          (['scheduled', 'attempting'].includes(step.state) !== (step.finishedAt === null)))
        fail('STORAGE', '账号计划步骤已损坏。');
    }
    if (plan.steps[0].accountId === plan.steps[1].accountId || plan.steps[1].epoch < plan.steps[0].epoch)
      fail('STORAGE', '账号计划顺序已损坏。');
  }
  return plans;
}
function makeAccountScheduleStore(dir, safeStorage, io = fs) {
  const file = path.join(dir, 'account-schedules.journal');
  let sequence = 0, loaded = false, damaged = false;
  const storageError = () => new ToolError('STORAGE', '账号计划无法安全读写，请保留原文件检查。');
  const encryptionReady = () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  return {
    load() {
      if (loaded || damaged) throw storageError();
      try {
        if (!encryptionReady()) throw storageError();
        let plans = [];
        if (io.existsSync(file)) {
          if (io.statSync(file).size > MAX_FILE) throw storageError();
          const content = io.readFileSync(file, 'utf8');
          if (!content || !content.endsWith('\n')) throw storageError();
          for (const line of content.slice(0, -1).split('\n')) {
            const outer = JSON.parse(line);
            if (typeof outer.payload !== 'string' || checksum(outer.payload) !== outer.checksum) throw storageError();
            const record = JSON.parse(outer.payload);
            if (record.sequence !== ++sequence || typeof record.sealed !== 'string' || !record.sealed) throw storageError();
            plans = validatePlans(JSON.parse(safeStorage.decryptString(Buffer.from(record.sealed, 'base64'))));
          }
        }
        loaded = true; return plans;
      } catch { damaged = true; throw storageError(); }
    },
    save(plans) {
      if (!loaded || damaged || !encryptionReady()) throw storageError();
      validatePlans(plans);
      let fd;
      try {
        const sealed = safeStorage.encryptString(JSON.stringify(plans)).toString('base64');
        const payload = JSON.stringify({ sequence: sequence + 1, sealed });
        const bytes = Buffer.from(JSON.stringify({ payload, checksum: checksum(payload) }) + '\n');
        io.mkdirSync(dir, { recursive: true });
        if ((io.existsSync(file) ? io.statSync(file).size : 0) + bytes.length > MAX_FILE) throw storageError();
        fd = io.openSync(file, 'a', 0o600);
        for (let offset = 0; offset < bytes.length;) {
          const n = io.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!Number.isSafeInteger(n) || n <= 0 || n > bytes.length - offset) throw storageError();
          offset += n;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined; sequence++;
      } catch { damaged = true; throw storageError(); }
      finally { if (fd !== undefined) try { io.closeSync(fd); } catch { damaged = true; } }
    }
  };
}

class AccountSchedule {
  constructor({ request, store, getOwner, now = () => Date.now(), onChange = () => {} }) {
    Object.assign(this, { request, store, getOwner, now, onChange });
    this.plans = validatePlans(store.load()); this.busy = false; this.storageFault = false;
    // An attempted POST with no durable readback remains uncertain after a crash.
    if (this.plans.some(p => p.steps.some(s => s.state === 'attempting'))) {
      this.commit(this.plans.map(p => ({ ...p, steps: p.steps.map(s => s.state === 'attempting' ?
        { ...s, state: 'unknown', finishedAt: new Date(now()).toISOString() } : s) })));
    }
  }
  commit(next) {
    if (this.storageFault) fail('STORAGE', '账号计划存储异常，已停止执行。');
    try { this.store.save(next); this.plans = next; try { this.onChange(this.state()); } catch {} }
    catch { this.storageFault = true; fail('STORAGE', '账号计划未能持久保存，已停止执行并保留原件。'); }
  }
  update(planId, stepIndex, changes) {
    const next = this.plans.map(p => p.id === planId ? { ...p, steps: p.steps.map((s, i) => i === stepIndex ? { ...s, ...changes } : s) } : p);
    this.commit(next);
  }
  async admin(expected = this.getOwner()) {
    if (!validId(expected) || this.getOwner() !== expected) fail('AUTH', '平台管理员身份尚未就绪或已变化。');
    const me = await this.request('GET', '/auth/me');
    if (me?.id !== expected || me?.role !== 'admin' || this.getOwner() !== expected)
      fail('DENIED', '需要同一平台管理员授权。');
    return expected;
  }
  async accounts() {
    const all = [], seen = new Set(); let total;
    for (let page = 1; page <= 50; page++) {
      const data = await this.request('GET', `/admin/accounts?page=${page}&page_size=100`);
      if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
          data.total > 5000 || data.items.length > 100 || (total !== undefined && data.total !== total))
        fail('SCHEMA', '平台账号分页变化或超过本次读取上限。');
      total = data.total;
      for (const raw of data.items) {
        const account = projectAccount(raw);
        if (seen.has(account.id)) fail('SCHEMA', '平台账号分页出现重复 ID。');
        seen.add(account.id); all.push(account);
      }
      if (all.length === total) return all;
      if (!data.items.length || all.length > total) fail('SCHEMA', '平台账号分页不完整。');
    }
    fail('LIMIT', '平台账号数量超过本次读取上限。');
  }
  state() {
    const owner = this.getOwner();
    return { owner: validId(owner) ? owner : null, storageError: this.storageFault,
      plans: this.plans.filter(p => p.owner === owner).map(p => structuredClone(p)) };
  }
  async snapshot() {
    const owner = await this.admin();
    const accounts = await this.accounts(); await this.admin(owner);
    return { ...this.state(), accounts };
  }
  async create(input) {
    if (this.busy || this.storageFault) fail('BUSY', '账号计划暂不可保存。');
    this.busy = true;
    try {
      const owner = await this.admin();
      if (!input || !['open-first', 'close-first'].includes(input.order) || !validId(input.openId) ||
          !validId(input.closeId) || input.openId === input.closeId) fail('INPUT', '请选择两个不同的平台账号和执行顺序。');
      const first = beijingTime(input.firstAt), second = beijingTime(input.secondAt), now = this.now();
      if (first < now + 60_000 || second < first || second > now + 2 * 365 * 86400_000)
        fail('INPUT', '首次执行须至少在1分钟后，第二步不得早于第一步，计划最多提前两年。');
      const accounts = await this.accounts();
      if (!accounts.some(a => a.id === input.openId) || !accounts.some(a => a.id === input.closeId))
        fail('CONFLICT', '所选账号已不在当前平台列表，请重新读取。');
      const steps = input.order === 'open-first' ?
        [{ accountId: input.openId, desired: true }, { accountId: input.closeId, desired: false }] :
        [{ accountId: input.closeId, desired: false }, { accountId: input.openId, desired: true }];
      const dates = [input.firstAt, input.secondAt], epochs = [first, second];
      for (const existing of this.plans.filter(p => p.owner === owner)) {
        for (const old of existing.steps.filter(s => s.state === 'scheduled' || s.state === 'attempting' || s.state === 'unknown'))
          for (const [i, step] of steps.entries())
            if (old.accountId === step.accountId && Math.abs(old.epoch - epochs[i]) < GRACE_MS)
              fail('CONFLICT', '同一账号附近已有未完成计划，请错开至少5分钟或先处理原计划。');
      }
      await this.admin(owner);
      if (this.plans.length >= MAX_PLANS) fail('LIMIT', '本机计划记录已达到上限。');
      const plan = { id: randomUUID(), owner, order: input.order, steps: steps.map((s, i) =>
        ({ ...s, at: dates[i], epoch: epochs[i], state: 'scheduled', finishedAt: null })) };
      this.commit([...this.plans, plan]);
      return this.state();
    } finally { this.busy = false; }
  }
  async cancel(planId) {
    if (this.busy || this.storageFault) fail('BUSY', '账号计划正在处理。');
    this.busy = true;
    try {
      const owner = await this.admin();
      const plan = this.plans.find(p => p.id === planId && p.owner === owner);
      if (!plan || !plan.steps.some(s => s.state === 'scheduled')) fail('INPUT', '没有可取消的待执行步骤。');
      this.commit(this.plans.map(p => p === plan ? { ...p, steps: p.steps.map(s => s.state === 'scheduled' ?
        { ...s, state: 'cancelled', finishedAt: new Date(this.now()).toISOString() } : s) } : p));
      return this.state();
    } finally { this.busy = false; }
  }
  async reconcile(planId, index) {
    if (this.busy || this.storageFault) fail('BUSY', '账号计划正在处理。');
    this.busy = true;
    try {
      const owner = await this.admin();
      const plan = this.plans.find(p => p.id === planId && p.owner === owner);
      const step = plan?.steps[index];
      if (!step || !Number.isInteger(index) || index < 0 || index > 1 || step.state !== 'unknown')
        fail('INPUT', '没有可回读的结果不明步骤。');
      const current = projectAccount(await this.request('GET', `/admin/accounts/${step.accountId}`), step.accountId);
      await this.admin(owner);
      if (current.schedulable !== step.desired) fail('UNKNOWN', '当前平台开关与目标不一致；原请求结果仍待人工核对，未重发。');
      this.update(plan.id, index, { state: 'done', finishedAt: new Date(this.now()).toISOString() });
      return this.state();
    } finally { this.busy = false; }
  }
  async tick() {
    if (this.busy || this.storageFault || !validId(this.getOwner())) return;
    this.busy = true;
    try {
      const owner = this.getOwner();
      for (let handled = 0; handled < 10; handled++) {
        const now = this.now();
        const candidates = this.plans.filter(p => p.owner === owner).flatMap(p => p.steps.map((s, i) => ({ plan: p, step: s, index: i })))
        .filter(({ plan, step, index }) => step.state === 'scheduled' && step.epoch <= now &&
          (index === 0 || plan.steps[0].state === 'done'))
        .sort((a,b) => a.step.epoch - b.step.epoch || a.plan.id.localeCompare(b.plan.id) || a.index - b.index);
        const next = candidates[0]; if (!next) return;
        const { plan, step, index } = next;
        if (now - step.epoch > GRACE_MS) {
          const finishedAt = new Date(now).toISOString();
          this.commit(this.plans.map(p => p.id !== plan.id ? p : { ...p, steps: p.steps.map((s, i) =>
            i === index ? { ...s, state: 'missed', finishedAt } :
            index === 0 && i === 1 && s.state === 'scheduled' ? { ...s, state: 'cancelled', finishedAt } : s) }));
          continue;
        }
        let current;
        try {
          await this.admin(owner);
          current = projectAccount(await this.request('GET', `/admin/accounts/${step.accountId}`), step.accountId);
        } catch { return; } // Wait within the grace window for an administrator session; then mark missed.
        if (this.getOwner() !== owner) return;
        if (current.schedulable === step.desired) {
          this.update(plan.id, index, { state: 'done', finishedAt: new Date(this.now()).toISOString() }); continue;
        }
        // Persist attempting before POST; a crash or uncertain reply cannot cause another POST.
        this.update(plan.id, index, { state: 'attempting' });
        const guard = () => !this.storageFault && this.getOwner() === owner &&
          this.plans.find(p => p.id === plan.id)?.steps[index]?.state === 'attempting';
        try {
          await this.request('POST', `/admin/accounts/${step.accountId}/schedulable`, { schedulable: step.desired },
            { owner, guard, accountSchedule: true });
          const actual = projectAccount(await this.request('GET', `/admin/accounts/${step.accountId}`), step.accountId);
          if (actual.schedulable !== step.desired) fail('UNKNOWN', '平台回读状态与目标不一致。');
          this.update(plan.id, index, { state: 'done', finishedAt: new Date(this.now()).toISOString() });
        } catch {
          if (!this.storageFault) this.update(plan.id, index, { state: 'unknown', finishedAt: new Date(this.now()).toISOString() });
        }
      }
    } finally { this.busy = false; }
  }
}
module.exports = { AccountSchedule, makeAccountScheduleStore, beijingTime, projectAccount };
