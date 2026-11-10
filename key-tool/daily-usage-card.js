'use strict';

const { dayKey, finiteCost, beijingDay } = require('./daily-usage');
const MAX_CARD_BYTES = 28_000;
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
const cost = value => `$${finiteCost({ total_actual_cost: value }).toFixed(4)}`;
function dailyUsageCard({ name, days, checkedAt, windows = 3, privateView = false }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100 ||
      !Array.isArray(days) || !days.length || ![3, 7].includes(windows) || typeof privateView !== 'boolean' ||
      !Number.isFinite(Date.parse(checkedAt))) throw new Error('用量表输入不完整。');
  const ordered = [...days].sort((a, b) => a.day.localeCompare(b.day)).slice(-windows);
  const ids = new Set();
  for (const day of ordered) {
    dayKey(day.day);
    if (ids.has(day.day) || !Array.isArray(day.users)) throw new Error('用量日期重复或数据损坏。');
    ids.add(day.day);
    const onDay = new Set();
    for (const user of day.users) {
      if (!Number.isSafeInteger(user.id) || user.id <= 0 ||
          typeof user.email !== 'string' || !user.email || user.email.length > 254 ||
          /[\x00-\x1f\x7f]/.test(user.email) || onDay.has(user.id))
        throw new Error('用量账号标识无效。');
      finiteCost({ total_actual_cost: user.cost });
      onDay.add(user.id);
    }
  }
  // Current ownership is authoritative. Removed accounts must disappear from the public card.
  const users = new Map(ordered.at(-1).users.map(user => [user.id, user.email]));
  if (users.size > 30) throw new Error('单张飞书用量卡片超过30个账号；请拆分归属档案。');
  const plain = value => ({ tag: 'plain_text', content: clean(value) });
  const div = value => ({ tag: 'div', text: plain(value) });
  const row = values => ({ tag: 'column_set', flex_mode: 'stretch', background_style: 'default',
    columns: values.map((value, index) => ({ tag: 'column', width: 'weighted',
      weight: index === 0 ? 3 : 1, elements: [div(value)] })) });
  const currentDay = beijingDay(Date.parse(checkedAt));
  const headers = ['平台账号', ...ordered.map(day => `${day.day.slice(5)}${day.final ? '' : day.day < currentDay ? ' 待补齐' : ' *'}`)];
  const elements = [div(`归属：${name.trim()} · 用户实付（USD）`),
    div(`更新：${new Date(checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 北京时间 · * 今日进行中；历史待补齐日金额仅为已记录小计。`),
    row(headers)];
  let total = Array(ordered.length).fill(0);
  for (const [id, email] of users) {
    const values = ordered.map((day, index) => {
      const entry = day.users.find(user => user.id === id);
      if (!entry) return '—';
      total[index] += entry.cost;
      return cost(entry.cost);
    });
    elements.push(row([email, ...values]));
  }
  elements.push(row(['合计', ...total.map((amount, i) =>
    [...users.keys()].every(id => ordered[i].users.some(user => user.id === id)) ? cost(amount) : '—')]));
  elements.push(div(privateView ? '“—”表示该日未记录完整账号或尚未固定，不代表用量为 0。本次仅私聊发送给发起查询的本人。' :
    '“—”表示该日未记录完整账号，不代表用量为 0。仅发送到已绑定目标群；群成员均可看到邮箱与金额。'));
  const card = { config: { wide_screen_mode: true, enable_forward: false, update_multi: true },
    header: { template: 'blue', title: plain(`${name.trim()} · ${privateView ? '用户用量' : '每日用量'}`) }, elements };
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_CARD_BYTES)
    throw new Error('飞书用量卡片超过安全大小限制，本次不发送不完整表格。');
  return card;
}
function retiredDailyUsageCard(name, checkedAt) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100 ||
      !Number.isFinite(Date.parse(checkedAt))) throw new Error('停用卡片输入无效。');
  const plain = content => ({ tag: 'plain_text', content });
  return { config: { wide_screen_mode: true, enable_forward: false, update_multi: true },
    header: { template: 'blue', title: plain(`${clean(name)} · 每日用量已停止`) },
    elements: [{ tag: 'div', text: plain('此归属档案已被移除或不再包含平台账号。本卡片不再显示原邮箱与金额；请以管理员当前归属配置为准。') }] };
}
module.exports = { dailyUsageCard, retiredDailyUsageCard, MAX_CARD_BYTES };
