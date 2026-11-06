'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const CHANNELS = Object.freeze([
  Object.freeze({ id: 'points-ip', origin: 'https://23.239.111.82', path: '/dashboard', metric: '积分金额', defaultName: '积分金额', selector: '[data-testid="points-balance"]' }),
  Object.freeze({ id: 'points-anna', origin: 'https://www.annaapi.com', path: '/dashboard', metric: '积分金额', defaultName: '积分金额', selector: '[data-testid="points-balance"]' }),
  Object.freeze({ id: 'spent-ccrouter', origin: 'https://ccrouter.ai', path: '/dashboard', metric: '剩余余额', defaultName: '剩余余额', selector: null }),
  Object.freeze({ id: 'spent-aerorelay', origin: 'https://vip.aerorelay.one', path: '/dashboard', metric: '剩余余额', defaultName: '剩余余额', selector: null }),
  Object.freeze({ id: 'balance-juxiang', origin: 'https://173.231.49.42', path: '/dashboard/overview', metric: '当前剩余余额', defaultName: '巨像分站', selector: null })
]);
const INTERVAL_MS = 30 * 60_000;
const BALANCE_LABEL = /^(?:当前余额(?:\s*\(USD\))?|剩余余额(?:\s*\(USD\))?|Available Balance(?:\s*\(USD\))?|Current Balance(?:\s*\(USD\))?)$/i;
const AERO_BALANCE_LABEL = /^(?:余额|剩余余额|Balance|Available Balance)$/i;
const JUXIANG_BALANCE_LABEL = /^(?:当前余额|可用余额|剩余余额|剩余额度|Current Balance|Available Balance|Credit remaining|Remaining Quota)(?:\s*\(USD\))?$/i;
const JUXIANG_OTHER_LABEL = /^(?:近\s*24\s*小时消耗|历史使用情况|总消耗|充值金额|可用时长|Recent Usage|Total Consumed|Total Usage|Last 24 Hours(?: Usage)?|Available Duration)$/i;
const JUXIANG_CURRENCY = /^(?:[¥$￥€£]|USD\s|US\$\s)/i;
const AMOUNT = /^(?:(?:USD|US\$|积分|Points?)\s*)?([¥$￥€£]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,12})?)\s*(?:积分|points?|USD|元)?$/i;
function safeName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('名称须为1–40个字符，不能包含控制字符。');
  return value.trim();
}
function parseAmount(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  const match = normalized.match(AMOUNT);
  if (!match) return null;
  const numeric = Number(match[1].replace(/[¥$￥€£,\s]/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1e15) return null;
  return { value: numeric, display: normalized };
}
function chooseMetric(channel, observation) {
  if (!channel || !observation || observation.origin !== channel.origin) return { status: 'unavailable' };
  if (observation.path !== channel.path) return { status: observation.login ? 'login-required' : 'unavailable' };
  const candidates = channel.selector ? observation.balanceCandidates : observation.labeledCandidates;
  const parsed = (Array.isArray(candidates) ? candidates : []).map(parseAmount).filter(Boolean);
  if (parsed.length !== 1) return { status: parsed.length ? 'ambiguous' : 'metric-not-found' };
  return { status: 'ok', value: parsed[0].value, display: parsed[0].display };
}
const checksum = payload => createHash('sha256').update(payload).digest('hex');
function makeNameStore(dir, io = fs) {
  const file = path.join(dir, 'channel-monitor-names.journal');
  let sequence = 0, loaded = false, fault = false;
  const ids = new Set(CHANNELS.map(c => c.id));
  function validate(rows) {
    if (!rows || typeof rows !== 'object' || Array.isArray(rows) || Object.keys(rows).some(id => !ids.has(id))) throw new Error('invalid names');
    const result = {};
    for (const [id, value] of Object.entries(rows)) result[id] = safeName(value);
    return result;
  }
  return {
    load() {
      if (loaded || fault) throw new Error('Names already loaded or damaged');
      try {
        let rows = {};
        if (io.existsSync(file)) {
          const raw = io.readFileSync(file, 'utf8');
          if (!raw || !raw.endsWith('\n') || raw.length > 256 * 1024) throw new Error('incomplete names');
          for (const line of raw.slice(0, -1).split('\n')) {
            const envelope = JSON.parse(line);
            if (typeof envelope.payload !== 'string' || checksum(envelope.payload) !== envelope.checksum) throw new Error('checksum');
            const next = JSON.parse(envelope.payload);
            if (next.sequence !== ++sequence) throw new Error('sequence');
            rows = validate(next.names);
          }
        }
        loaded = true; return rows;
      } catch { fault = true; throw new Error('渠道名称记录无法读取，请保留原文件检查。'); }
    },
    save(rows) {
      if (!loaded || fault) throw new Error('渠道名称记录不可写。');
      const names = validate(rows), payload = JSON.stringify({ sequence: sequence + 1, names });
      const bytes = Buffer.from(JSON.stringify({ payload, checksum: checksum(payload) }) + '\n');
      let fd;
      try {
        io.mkdirSync(dir, { recursive: true });
        if ((io.existsSync(file) ? io.statSync(file).size : 0) + bytes.length > 256 * 1024) throw new Error('name journal full');
        fd = io.openSync(file, 'a', 0o600);
        for (let offset = 0; offset < bytes.length;) {
          const n = io.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!Number.isInteger(n) || n <= 0) throw new Error('write');
          offset += n;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined; sequence++;
        return names;
      } catch { fault = true; throw new Error('渠道名称未安全保存，请保留原文件检查。'); }
      finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { fault = true; } } }
    }
  };
}

// Runs in an untrusted page with no Node/preload access. Return only the minimum
// metric candidates, never cookies, storage, page HTML, or unrelated text.
function observationScript(channel) {
  return `(() => {
    const visible = el => !!(el && el.getClientRects().length);
    const clean = el => (el?.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const amount = /^[\\s]*(?:(?:USD|US\\$|积分|Points?)\\s*)?[¥$￥€£]?\\s*(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,12})?\\s*(?:积分|points?|USD|元)?[\\s]*$/i;
    const login = /(?:^|\\/)(?:auth|login|sign-in)(?:\\/|$)/i.test(location.pathname) ||
      [...document.querySelectorAll('input[type="password"]')].some(visible) ||
      (${JSON.stringify(channel.id)} === 'spent-aerorelay' && visible(document.querySelector('#page-home')));
    const selected = ${JSON.stringify(channel.selector)};
    const balanceCandidates = selected ? [...document.querySelectorAll(selected)].filter(visible)
      .map(el => (el.getAttribute('title') || clean(el))).filter(v => amount.test(v)) : [];
    const labeledCandidates = [];
    if (!selected) for (const el of document.querySelectorAll('body *')) {
      const labelPattern = ${JSON.stringify(channel.id)} === 'spent-ccrouter' ? ${BALANCE_LABEL.toString()} :
        ${JSON.stringify(channel.id)} === 'balance-juxiang' ? ${JUXIANG_BALANCE_LABEL.toString()} :
        ${AERO_BALANCE_LABEL.toString()};
      if (el.children.length || !visible(el) || !labelPattern.test(clean(el))) continue;
      // Remaining-balance dashboards must use an exact label and adjacent
      // amount; cumulative spend or another monetary card is not a fallback.
      if (${JSON.stringify(channel.id)} === 'spent-ccrouter') {
        const actual = clean(el.nextElementSibling);
        if (visible(el.nextElementSibling) && amount.test(actual)) { labeledCandidates.push(actual); continue; }
      }
      if (${JSON.stringify(channel.id)} === 'balance-juxiang') {
        let box = el.parentElement;
        for (let depth = 0; box && depth < 5; depth++, box = box.parentElement) {
          const leaves = [...box.querySelectorAll('*')].filter(node => !node.children.length && visible(node));
          const labelAt = leaves.indexOf(el);
          if (labelAt < 0) continue;
          for (const next of leaves.slice(labelAt + 1, labelAt + 5)) {
            const value = clean(next);
            if (${JUXIANG_OTHER_LABEL.toString()}.test(value) || ${JUXIANG_BALANCE_LABEL.toString()}.test(value)) break;
            if (${JUXIANG_CURRENCY.toString()}.test(value) && amount.test(value)) {
              labeledCandidates.push(value); break;
            }
          }
          if (labeledCandidates.length) break;
        }
        continue;
      }
      let box = el.parentElement;
      for (let depth = 0; box && depth < 3; depth++, box = box.parentElement) {
        const values = [...box.querySelectorAll('*')].filter(node => !node.children.length && visible(node))
          .map(clean).filter(v => amount.test(v));
        if (values.length === 1) { labeledCandidates.push(values[0]); break; }
      }
    }
    return { origin: location.origin, path: location.pathname, login,
      balanceCandidates: [...new Set(balanceCandidates)].slice(0, 3),
      labeledCandidates: [...new Set(labeledCandidates)].slice(0, 3) };
  })()`;
}

module.exports = { CHANNELS, INTERVAL_MS, safeName, parseAmount, chooseMetric, makeNameStore, observationScript };
