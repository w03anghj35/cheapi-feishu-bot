'use strict';
const { FEATURES } = require('./feishu-features');
const { registrationPrompt } = require('./feishu-registration-flow');
const { registrationForm } = require('./feishu-registration-card');

const PAGE_SIZE = 10;
const label = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 60);
function requestCard(session, maxQuota) {
  const text = content => ({ tag: 'plain_text', content });
  const button = (content, action, extra = {}, type = 'default') => ({
    tag: 'button', text: text(content), type,
    value: { keyTool: 'request-v1', requestId: session.requestId, nonce: session.cardToken, action, ...extra }
  });
  const row = actions => ({ tag: 'action', actions });
  const div = content => ({ tag: 'div', text: text(content) });
  let title, elements;
  if (session.state === 'menu') {
    title = '请选择功能';
    elements = [div('请选择要办理的业务，也可回复功能编号或名称。账号资料和令牌都不发到群里。'),
      ...FEATURES.map((feature, i) => row([button(`${i + 1}. ${feature.label}`, 'feature', { featureId: feature.id })])),
      row([button('取消', 'cancel')])];
  } else if (session.state === 'register-form') {
    title = '用户注册 · 填写资料';
    elements = [div('在下方卡片内填写，不用逐条发送消息。仅创建普通用户，10分钟内完成。\n密码会遮挡显示；资料仍经飞书处理，请使用全新专用密码。本工具不回显、不记录密码。'),
      registrationForm(session, button), row([button('取消注册', 'cancel')])];
  } else if (session.state.startsWith('register-')) {
    title = '用户注册';
    elements = [div(registrationPrompt(session))];
    if (session.state === 'register-balance') elements.push(row([0, 1, 5, 10].map(balance => button(String(balance), 'balance', { balance: String(balance) }))));
    if (session.state === 'register-confirm') elements.push(row([button('确认注册', 'register-confirm', {}, 'primary')]));
    if (session.state === 'register-confirm' && session.registrationInput === 'card') elements.push(row([button('修改资料（密码需重填）', 'register-edit')]));
    elements.push(row([button('取消', 'cancel')]));
  } else if (session.state === 'group') {
    const pages = Math.max(1, Math.ceil(session.groups.length / PAGE_SIZE));
    const page = Math.min(session.page || 0, pages - 1);
    const first = page * PAGE_SIZE;
    const groups = session.groups.slice(first, first + PAGE_SIZE);
    title = '① 选择分组';
    elements = [div(`请选择您要使用的分组（第 ${page + 1}/${pages} 页）。也可直接回复分组编号。`)];
    for (let i = 0; i < groups.length; i += 2) {
      elements.push(row(groups.slice(i, i + 2).map((group, offset) =>
        button(`${first + i + offset + 1}. ${label(group.name)}`, 'group', { index: first + i + offset }))));
    }
    const nav = [];
    if (page > 0) nav.push(button('上一页', 'page', { page: page - 1 }));
    if (page + 1 < pages) nav.push(button('下一页', 'page', { page: page + 1 }));
    nav.push(button('取消', 'cancel'));
    elements.push(row(nav));
  } else if (session.state === 'quota') {
    title = '② 设置额度';
    elements = [div(`分组：${label(session.selectedGroup.name)}\n请选择额度，或直接在私聊输入金额。必须大于 0，单次最多 ${maxQuota}。`),
      row([1, 5, 10, 20].filter(quota => quota <= maxQuota).map(quota =>
        button(String(quota), 'quota', { quota: String(quota) }))),
      row([button('自定义额度（直接回复金额）', 'custom'), button('重选分组', 'back'), button('取消', 'cancel')])];
    elements = elements.filter(element => element.tag !== 'action' || element.actions.length);
  } else if (session.state === 'confirm') {
    title = '③ 确认创建';
    elements = [div(`分组：${label(session.selectedGroup.name)}\n额度：${session.quota}\n点击“确认创建”后才会创建一次，密钥只发给您，不发到群里。`),
      row([button('确认创建', 'confirm', {}, 'primary'), button('修改额度', 'edit'), button('取消', 'cancel')])];
  } else throw new Error('unsupported card state');
  return { config: { wide_screen_mode: true, enable_forward: false },
    header: { template: 'blue', title: text(title) }, elements };
}

module.exports = { requestCard, PAGE_SIZE };
