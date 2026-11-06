'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CHANNELS } = require('./channel-monitor');
const { beijingDay, dayKey } = require('./daily-usage');

const IDS = new Set(CHANNELS.map(c => c.id));
const THRESHOLD = 2000;
const DAILY_GRACE_MS = 15 * 60_000;
const DAILY_FRESH_MS = 60 * 60_000;
const MAX_FILE = 2 * 1024 * 1024;
const emailPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;
const timeBeijing = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const snapshotLine = (channel, row) => {
  const name = typeof row?.name === 'string' && row.name.trim() ? row.name.trim() : channel.defaultName;
  const heading = `${name}｜${channel.origin}${channel.path}｜${channel.metric}`;
  return row?.status === 'ok' && Number.isFinite(row.value) && row.value >= 0 &&
    typeof row.display === 'string' && Number.isFinite(Date.parse(row.checkedAt))
    ? `${heading}：${row.display}（读取于 ${timeBeijing(row.checkedAt)} 北京时间）`
    : `${heading}：本次未取得有效金额，请在管理窗口核对。`;
};
const digest = value => createHash('sha256').update(value).digest('hex');
class AlertError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new AlertError(code, message); };
function thresholdValue(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d{0,12})(?:\.\d{1,4})?$/.test(text) ||
      !Number.isFinite(Number(text)) || Number(text) <= 0 || Number(text) > 1e12)
    fail('INPUT', '低余额阈值须为大于 0、最多 4 位小数的有效金额。');
  return Number(text);
}
function dailyTimeValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
    fail('INPUT', '每日提醒时间须为北京时间 HH:mm，留空表示不启用。');
  return value;
}
function validate(input) {
  const from = typeof input?.from === 'string' ? input.from.trim().toLowerCase() : '';
  const secret = input?.authCode;
  const recipients = typeof input?.recipients === 'string' ? input.recipients.split(/[;,\s]+/).filter(Boolean).map(v => v.toLowerCase()) : [];
  if (!emailPattern.test(from) || from.length > 254 || !from.endsWith('@qq.com') ||
      typeof secret !== 'string' || !secret || secret.length > 256 || /[\r\n\x00-\x1f\x7f]/.test(secret) ||
      recipients.length < 1 || recipients.length > 10 || new Set(recipients).size !== recipients.length ||
      recipients.some(v => v.length > 254 || !emailPattern.test(v)))
    fail('INPUT', '请填写 QQ 发件邮箱、SMTP 授权码及 1–10 个不重复的收件邮箱。');
  return { from, authCode: secret, recipients,
    threshold: thresholdValue(input?.threshold === undefined ? THRESHOLD : input.threshold),
    dailyTime: dailyTimeValue(input?.dailyTime) };
}
function makeAlertStore(dir, safeStorage, io = fs, now = () => Date.now()) {
  const file = path.join(dir, 'channel-alert.journal');
  let loaded = false, fault = false, sequence = 0, data = { config: null, deliveries: {}, dailyDeliveries: {} };
  const failure = () => new AlertError('STORAGE', '邮件提醒配置无法安全读写；已暂停提醒，请保留原文件检查。');
  const encrypted = () => {
    try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  };
  function validateData(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !value.deliveries || typeof value.deliveries !== 'object' || Array.isArray(value.deliveries)) throw failure();
    const config = value.config === null ? null : { ...validate({ ...value.config, recipients: value.config?.recipients?.join(',') }), enabled: value.config?.enabled === true,
      dailyActivationAt: value.config?.dailyTime ? value.config?.dailyActivationAt : null };
    if (config?.dailyTime && (typeof config.dailyActivationAt !== 'string' ||
        !Number.isFinite(Date.parse(config.dailyActivationAt)))) throw failure();
    for (const [id, rows] of Object.entries(value.deliveries)) {
      if (!IDS.has(id) || !rows || typeof rows !== 'object' || Array.isArray(rows)) throw failure();
      for (const [email, status] of Object.entries(rows))
        if (!emailPattern.test(email) || !['armed', 'attempting', 'sent'].includes(status)) throw failure();
    }
    const dailyDeliveries = value.dailyDeliveries === undefined ? {} : value.dailyDeliveries;
    if (!dailyDeliveries || typeof dailyDeliveries !== 'object' || Array.isArray(dailyDeliveries)) throw failure();
    for (const [email, row] of Object.entries(dailyDeliveries)) {
      if (!emailPattern.test(email) || !row || !['attempting', 'sent'].includes(row.status)) throw failure();
      dayKey(row.day);
    }
    return { config, deliveries: value.deliveries, dailyDeliveries };
  }
  function state() {
    return { configured: !!data.config, enabled: data.config?.enabled === true,
      recipients: data.config?.recipients || [], sender: data.config?.from || '',
      threshold: data.config?.threshold ?? THRESHOLD, dailyTime: data.config?.dailyTime ?? null,
      storageError: fault, attention: Object.entries(data.deliveries).flatMap(([id, rows]) =>
        Object.entries(rows).filter(([, status]) => status === 'attempting').map(([email]) => ({ id, email }))),
      dailyAttention: Object.entries(data.dailyDeliveries).filter(([, row]) => row.status === 'attempting')
        .map(([email, row]) => ({ email, day: row.day })) };
  }
  function save(next) {
    if (!loaded || fault) throw failure();
    if (!encrypted()) { fault = true; throw failure(); }
    let fd;
    try {
      const clean = validateData(next);
      const sealed = safeStorage.encryptString(JSON.stringify(clean)).toString('base64');
      const payload = JSON.stringify({ sequence: sequence + 1, sealed });
      const bytes = Buffer.from(JSON.stringify({ payload, checksum: digest(payload) }) + '\n');
      io.mkdirSync(dir, { recursive: true });
      if ((io.existsSync(file) ? io.statSync(file).size : 0) + bytes.length > MAX_FILE) throw failure();
      fd = io.openSync(file, 'a', 0o600);
      for (let offset = 0; offset < bytes.length;) {
        const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0) throw failure();
        offset += written;
      }
      io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      sequence++; data = clean; return state();
    } catch { fault = true; throw failure(); }
    finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { fault = true; } } }
  }
  return {
    load() {
      if (loaded || fault) throw failure(); loaded = true;
      try {
        if (!encrypted()) throw failure();
        if (!io.existsSync(file)) return state();
        if (io.statSync(file).size > MAX_FILE) throw failure();
        const raw = io.readFileSync(file, 'utf8');
        if (!raw || !raw.endsWith('\n')) throw failure();
        for (const line of raw.slice(0, -1).split('\n')) {
          const row = JSON.parse(line);
          if (typeof row.payload !== 'string' || digest(row.payload) !== row.checksum) throw failure();
          const record = JSON.parse(row.payload);
          if (record.sequence !== ++sequence || typeof record.sealed !== 'string') throw failure();
          data = validateData(JSON.parse(safeStorage.decryptString(Buffer.from(record.sealed, 'base64'))));
        }
        return state();
      } catch { fault = true; throw failure(); }
    },
    state,
    config() { return !fault && data.config?.enabled ? structuredClone(data.config) : null; },
    configure(input) {
      const previous = data.config;
      const from = typeof input?.from === 'string' ? input.from.trim().toLowerCase() : '';
      const config = { ...validate({ ...input,
        authCode: input?.authCode || (previous?.from === from ? previous.authCode : input?.authCode),
        threshold: input?.threshold === undefined ? previous?.threshold ?? THRESHOLD : input.threshold,
        dailyTime: input?.dailyTime === undefined ? previous?.dailyTime ?? null : input.dailyTime }), enabled: true };
      config.dailyActivationAt = config.dailyTime ?
        previous?.enabled && previous.dailyTime === config.dailyTime ? previous.dailyActivationAt : new Date(now()).toISOString() : null;
      const deliveries = previous?.threshold !== config.threshold ?
        Object.fromEntries(Object.entries(data.deliveries).map(([id, rows]) => [id,
          Object.fromEntries(Object.entries(rows).map(([email, status]) => [email, status === 'sent' ? 'armed' : status]))])) :
        data.deliveries;
      return save({ config, deliveries, dailyDeliveries: data.dailyDeliveries });
    },
    pause() { return data.config ? save({ config: { ...data.config, enabled: false }, deliveries: data.deliveries,
      dailyDeliveries: data.dailyDeliveries }) : state(); },
    clear() {
      if (!loaded || fault) throw failure();
      if (!encrypted()) { fault = true; throw failure(); }
      try {
        if (io.existsSync(file)) io.unlinkSync(file);
        data = { config: null, deliveries: {}, dailyDeliveries: {} }; sequence = 0;
        return state();
      } catch { fault = true; throw failure(); }
    },
    delivery(id, email) { return data.deliveries[id]?.[email] || 'armed'; },
    mark(id, email, status) {
      if (!IDS.has(id) || !emailPattern.test(email) || !['armed', 'attempting', 'sent'].includes(status)) fail('INPUT', '邮件状态无效。');
      return save({ config: data.config, deliveries: { ...data.deliveries, [id]: { ...data.deliveries[id], [email]: status } },
        dailyDeliveries: data.dailyDeliveries });
    },
    dailyDelivery(email) { return data.dailyDeliveries[email] || null; },
    markDaily(email, day, status) {
      if (!data.config?.enabled || !emailPattern.test(email) || !['attempting', 'sent'].includes(status)) fail('INPUT', '每日提醒状态无效。');
      dayKey(day);
      return save({ config: data.config, deliveries: data.deliveries,
        dailyDeliveries: { ...data.dailyDeliveries, [email]: { day, status } } });
    }
  };
}
function createMailer(nodemailer = require('nodemailer')) {
  return async ({ from, authCode, to, subject, text }) => {
    const transport = nodemailer.createTransport({ host: 'smtp.qq.com', port: 465, secure: true,
      auth: { user: from, pass: authCode }, tls: { rejectUnauthorized: true },
      connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 15000 });
    try {
      const result = await transport.sendMail({ from, to, subject, text });
      if (!Array.isArray(result?.accepted) || !result.accepted.some(address =>
        typeof address === 'string' && address.toLowerCase() === to.toLowerCase()))
        throw new Error('SMTP recipient acceptance not confirmed');
    }
    finally { transport.close(); }
  };
}
class ChannelAlert {
  constructor({ store, send = createMailer(), onChange = () => {}, now = () => Date.now() }) {
    Object.assign(this, { store, send, onChange, now }); this.pending = Promise.resolve(); this.testBusy = false; store.load();
  }
  state() { return this.store.state(); }
  publish() { try { this.onChange(this.state()); } catch { /* UI cannot alter delivery outcome. */ } }
  configure(input) { const result = this.store.configure(input); this.publish(); return result; }
  pause() { const result = this.store.pause(); this.publish(); return result; }
  clear() { const result = this.store.clear(); this.publish(); return result; }
  dailyTick(rows) {
    const task = this.pending.then(() => this.processDaily(rows));
    this.pending = task.catch(() => {});
    return task.finally(() => this.publish());
  }
  async processDaily(rows) {
    const config = this.store.config();
    if (!config?.dailyTime) return { skipped: 'disabled' };
    const now = this.now();
    const day = beijingDay(now);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const clock = `${parts.find(item => item.type === 'hour')?.value}:${parts.find(item => item.type === 'minute')?.value}`;
    const scheduled = Date.parse(`${day}T${config.dailyTime}:00+08:00`);
    if (clock < config.dailyTime || now - scheduled >= DAILY_GRACE_MS ||
        Date.parse(config.dailyActivationAt) > scheduled) return { skipped: 'not-due' };
    if (!Array.isArray(rows) || rows.length !== CHANNELS.length) return { skipped: 'snapshot-unavailable' };
    const byId = new Map(rows.map(row => [row?.id, row]));
    if (byId.size !== CHANNELS.length || CHANNELS.some(channel => !byId.has(channel.id)))
      return { skipped: 'snapshot-unavailable' };
    const text = `每日渠道余额汇总｜${day}｜北京时间 ${config.dailyTime}\n` +
      `低余额阈值：${config.threshold}（每站按原单位独立比较）\n\n` +
      CHANNELS.map(channel => {
        const row = byId.get(channel.id);
        const recent = row?.status === 'ok' && Number.isFinite(row.value) && row.value >= 0 &&
          Number.isFinite(Date.parse(row.checkedAt)) &&
          now - Date.parse(row.checkedAt) >= 0 && now - Date.parse(row.checkedAt) <= DAILY_FRESH_MS;
        return snapshotLine(channel, recent ? row : { ...row, status: 'unavailable' });
      }).join('\n') + '\n\n本邮件是每天一次的余额概览；未取得/过期读数不会用旧金额替代。';
    let accepted = 0, uncertain = 0, skipped = 0;
    for (const to of config.recipients) {
      const current = this.store.config();
      if (!current || current.from !== config.from || current.authCode !== config.authCode ||
          current.threshold !== config.threshold || current.dailyTime !== config.dailyTime ||
          current.dailyActivationAt !== config.dailyActivationAt ||
          current.recipients.join('\0') !== config.recipients.join('\0')) break;
      const previous = this.store.dailyDelivery(to);
      if (previous?.day === day) { skipped++; continue; }
      this.store.markDaily(to, day, 'attempting');
      try {
        await this.send({ from: config.from, authCode: config.authCode, to,
          subject: `【每日余额】${day} 五个渠道汇总`, text });
        const latest = this.store.config();
        if (latest?.from === config.from && latest.authCode === config.authCode &&
            latest.threshold === config.threshold && latest.dailyTime === config.dailyTime &&
            latest.dailyActivationAt === config.dailyActivationAt && latest.recipients.includes(to))
          this.store.markDaily(to, day, 'sent');
        accepted++;
      } catch { uncertain++; }
      this.publish();
    }
    this.publish();
    return { accepted, uncertain, skipped };
  }
  sendTest(rows, scope = 'all') {
    if (this.testBusy) fail('BUSY', '测试邮件正在发送，请等待结果，不要重复提交。');
    if (scope !== 'all' && scope !== 'first') fail('INPUT', '测试收件范围无效。');
    if (!Array.isArray(rows) || rows.length !== CHANNELS.length) fail('INPUT', '渠道金额快照不可用。');
    const byId = new Map(rows.map(row => [row?.id, row]));
    if (byId.size !== CHANNELS.length || CHANNELS.some(channel => !byId.has(channel.id)))
      fail('INPUT', '渠道金额快照不完整。');
    if (!CHANNELS.some(channel => {
      const row = byId.get(channel.id);
      return row?.status === 'ok' && Number.isFinite(row.value) && row.value >= 0 &&
        typeof row.display === 'string' && Number.isFinite(Date.parse(row.checkedAt));
    })) fail('INPUT', '当前没有成功读取的金额；请先读取渠道，再发送测试邮件。');
    this.testBusy = true;
    const task = this.pending.then(async () => {
      const config = this.store.config();
      if (!config) fail('CONFIG', '请先加密保存并启用邮件提醒。');
      const recipients = scope === 'first' ? config.recipients.slice(0, 1) : config.recipients;
      const text = `这是一封手动触发的测试邮件，不表示余额已低于 ${config.threshold}。\n` +
        `发送时间：${timeBeijing(Date.now())} 北京时间\n\n` +
        CHANNELS.map(channel => snapshotLine(channel, byId.get(channel.id))).join('\n') +
        '\n\n低余额正式提醒会单独写明触发渠道的网址和本次金额；失败读取不会触发。';
      let accepted = 0, uncertain = 0;
      for (const to of recipients) {
        const current = this.store.config();
        if (!current || current.from !== config.from || current.authCode !== config.authCode ||
            current.threshold !== config.threshold ||
            current.recipients.join('\0') !== config.recipients.join('\0')) break;
        try {
          await this.send({ from: config.from, authCode: config.authCode, to,
            subject: '【测试】渠道余额监控', text });
          accepted++;
        } catch { uncertain++; /* SMTP might already have accepted the message. No automatic retry. */ }
      }
      const skipped = recipients.length - accepted - uncertain;
      return { requested: recipients.length, accepted, uncertain, skipped,
        message: uncertain ? '部分测试邮件结果不明，请先核对 QQ 发件箱与收件箱，不要立即重发。' :
          skipped ? '配置在发送期间改变，后续收件人未发送；请核对已发送邮件。' :
            'SMTP 服务端已接受测试邮件；请在收件箱核对内容，最终投递仍以实际收到为准。' };
    });
    this.pending = task.catch(() => {});
    return task.finally(() => { this.testBusy = false; });
  }
  observed(channel, row) {
    if (!IDS.has(channel?.id) || row?.status !== 'ok' || !Number.isFinite(row.value) || row.value < 0) return Promise.resolve();
    const task = this.pending.then(() => this.process(channel, row));
    this.pending = task.catch(() => {});
    return task;
  }
  async process(channel, row) {
    const config = this.store.config(); if (!config) return;
    try {
      if (row.value >= config.threshold) {
        for (const email of config.recipients) if (this.store.delivery(channel.id, email) === 'sent') this.store.mark(channel.id, email, 'armed');
        return;
      }
      for (const email of config.recipients) {
        const current = this.store.config();
        if (!current || current.from !== config.from || current.authCode !== config.authCode ||
            current.threshold !== config.threshold ||
            current.recipients.join('\0') !== config.recipients.join('\0')) break;
        if (this.store.delivery(channel.id, email) !== 'armed') continue;
        this.store.mark(channel.id, email, 'attempting');
        try {
          await this.send({ from: config.from, authCode: config.authCode, to: email,
            subject: `【低余额】${row.name || channel.defaultName} ${row.display}`,
            text: `${row.name || channel.defaultName}（${channel.origin}${channel.path}）当前${channel.metric}为 ${row.display}，低于 ${config.threshold}（按该站原单位）。检查时间：${timeBeijing(row.checkedAt)} 北京时间。请登录管理工具核对。` });
          if (this.store.config()?.recipients.includes(email)) this.store.mark(channel.id, email, 'sent');
        } catch { /* Attempt may have reached SMTP; never retry automatically. */ }
        this.publish();
      }
    } finally { this.publish(); }
  }
}
module.exports = { THRESHOLD, validate, makeAlertStore, createMailer, ChannelAlert, AlertError,
  thresholdValue, dailyTimeValue, DAILY_GRACE_MS, DAILY_FRESH_MS };
