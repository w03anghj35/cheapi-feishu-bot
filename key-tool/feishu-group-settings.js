'use strict';
const { rate } = require('./group-settings-service');
const SIZE = 5;
const label = v => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100);
const pageGroups = s => s.groupPreview.groups.slice(s.settingsPage * SIZE, (s.settingsPage + 1) * SIZE);
function accountValue(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length !== 1 ||
      typeof values.account !== 'string' || values.account.length > 254 || /[\x00-\x1f\x7f]/.test(values.account))
    throw new Error('请在用户账号输入框填写完整邮箱或用户ID。');
  const account = values.account.trim();
  if (!(/^[1-9]\d*$/.test(account) && Number.isSafeInteger(Number(account))) &&
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(account))
    throw new Error('请输入完整邮箱或正整数用户ID，不使用模糊昵称。');
  return account;
}
function initialDraft(preview) {
  return preview.groups.map(g => ({ groupId: g.id,
    allowed: !g.exclusive && !preview.user.restrict_public_groups || preview.user.allowed_groups.includes(g.id),
    rate: preview.user.group_rates[g.id] ?? null }));
}
function formValues(session, values) {
  const groups = pageGroups(session), keys = groups.flatMap(g => [`rate_${g.id}`,
    ...(g.exclusive || session.groupPreview.user.restrict_public_groups ? [`allow_${g.id}`] : [])]);
  if (!values || typeof values !== 'object' || Array.isArray(values) ||
      Object.keys(values).some(k => !keys.includes(k)) || keys.some(k => !k.startsWith('rate_') && !Object.hasOwn(values,k)))
    throw new Error('表单字段不完整或含额外字段，请使用当前分组卡片。');
  return groups.map(g => {
    const raw = values[`rate_${g.id}`] ?? '';
    if (typeof raw !== 'string') throw new Error('倍率必须是数字文本，留空恢复默认。');
    const allowed = g.exclusive || session.groupPreview.user.restrict_public_groups ? values[`allow_${g.id}`] : 'yes';
    if (!['yes','no'].includes(allowed)) throw new Error('请明确选择是否允许使用该分组。');
    return { groupId: g.id, allowed: allowed === 'yes', rate: raw.trim() === '' ? null : rate(raw.trim()) };
  });
}
function prompt(s) {
  if (s.state === 'settings-user') return '请在下方输入框填写用户账号（完整邮箱或用户ID），点击“查询用户分组”后填写倍率。不需要将账号另发一条聊天消息。';
  if (s.state === 'settings-form') return `正在设置用户 ID ${s.groupPreview.user.id}（${label(s.groupPreview.user.email)}）。请填写最新分组卡片；留空倍率恢复默认。可发送“重新显示表单”或“取消”。`;
  if (s.state === 'settings-confirm') {
    const lines = s.settingsDraft.map(d => {
      const g = s.groupPreview.groups.find(g => g.id === d.groupId);
      return `${label(g.name)}：${d.allowed ? '允许' : '不允许'} · ${d.rate === null ? `默认 ${g.rate}x` : `${d.rate}x`}`;
    });
    return `请核对目标用户：ID ${s.groupPreview.user.id}\n邮箱：${label(s.groupPreview.user.email)}\n用户名：${label(s.groupPreview.user.username)}\n${lines.join('\n')}\n仅修改以上分组，其他配置保留。确认后才提交；增加分组勾选会授予该用户使用权限。`;
  }
  throw new Error('invalid group settings state');
}
function elements(session, button) {
  const text = content => ({ tag: 'plain_text', content });
  const div = content => ({ tag: 'div', text: text(content) });
  const row = actions => ({ tag: 'action', actions });
  if (session.state === 'settings-user') return [div(prompt(session)), {
    tag: 'form', name: 'group_settings_account_form', elements: [
      { tag: 'input', name: 'account', required: true, input_type: 'text', max_length: 254,
        label: text('用户账号'), label_position: 'top', placeholder: text('填写完整邮箱或用户ID'),
        ...(session.settingsAccount ? { default_value: session.settingsAccount } : {}),
        fallback: { tag: 'fallback_text', text: text('请升级飞书后使用账号表单；也可在本私聊输入完整邮箱或用户ID。') } },
      { ...button('查询用户分组', 'settings-user-submit', {}, 'primary'), name: 'group_settings_account_submit', action_type: 'form_submit' }
    ]
  }, row([button('取消', 'cancel')])];
  if (session.state === 'settings-confirm') {
    // Bounded pages keep large catalogs below the card payload limit.
    const lines = prompt(session).split('\n');
    const header = lines.slice(0,3).join('\n');
    const changes = lines.slice(3,-1);
    const first = (session.confirmPage || 0) * 10;
    return [div(`${header}\n第 ${Math.floor(first/10)+1}/${Math.ceil(changes.length/10)} 页\n${changes.slice(first,first+10).join('\n')}\n${lines.at(-1)}`),
      row([...(first > 0 ? [button('上一页核对', 'settings-confirm-page', { page: session.confirmPage - 1 })] : []),
        ...(first+10 < changes.length ? [button('下一页核对', 'settings-confirm-page', { page: (session.confirmPage || 0) + 1 })] : [])]),
      row([button('确认保存', 'settings-confirm', {}, 'primary'), button('修改', 'settings-edit'), button('取消', 'cancel')])].filter(e => e.tag !== 'action' || e.actions.length);
  }
  const groups = pageGroups(session), pages = Math.ceil(session.groupPreview.groups.length / SIZE);
  const fallback = { tag: 'fallback_text', text: text('分组倍率表单无法显示，请更新飞书客户端后重新发起；本次没有保存任何修改。') };
  const form = { tag: 'form', name: 'group_settings_form', fallback, elements: [] };
  const columns = (left, right) => ({ tag: 'column_set', flex_mode: 'stretch', background_style: 'default', columns: [
    { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: left },
    { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: right }
  ] });
  for (const g of groups) {
    const draft = session.settingsDraft.find(d => d.groupId === g.id);
    form.elements.push(columns([div(`${label(g.name)}\n${g.exclusive ? '专属分组' : '公开分组'} · 默认 ${g.rate}x`)], [{
      tag: 'input', name: `rate_${g.id}`, label: text('专属倍率'), label_position: 'top',
      input_type: 'text', width: 'fill', max_length: 13, placeholder: text('留空恢复默认倍率'), fallback,
      ...(draft.rate !== null ? { default_value: String(draft.rate) } : {})
    }]));
    if (g.exclusive || session.groupPreview.user.restrict_public_groups) form.elements.push(columns([div('分组使用权限')], [{ tag: 'select_static',
      name: `allow_${g.id}`, required: true, placeholder: text('是否允许使用'), initial_option: draft.allowed ? 'yes' : 'no',
      options: [{ text: text('允许使用'), value: 'yes' }, { text: text('不允许使用'), value: 'no' }] }]));
  }
  form.elements.push({ ...button(session.settingsPage + 1 < pages ? '保存本页，下一页' : '下一步：核对全部设置', 'settings-submit', {}, 'primary'),
    name: 'group_settings_submit', action_type: 'form_submit' });
  return [div(`${prompt(session)}\n在分组右侧填写倍率，至少0.001，最多3位小数。公开分组原本全部开放时保持开放。\n第 ${session.settingsPage+1}/${pages} 页，已填写其他页会保留。`), form,
    row([...(session.settingsPage > 0 ? [button('返回上一页（当前页未提交不保存）', 'settings-prev')] : []), button('取消', 'cancel')])];
}
module.exports = { SIZE, initialDraft, formValues, accountValue, prompt, elements };
