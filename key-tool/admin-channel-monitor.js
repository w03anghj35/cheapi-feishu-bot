'use strict';
(() => {
  const el = id => document.getElementById(id);
  const labels = { waiting: '等待首次读取', checking: '正在读取', ok: '读取成功',
    'login-required': '待登录', 'login-form-unavailable': '自动登录表单未识别，请手动登录',
    'metric-not-found': '金额未定位，待校准', ambiguous: '金额位置不唯一，待校准',
    'user-browsing': '登录窗口打开中，稍后读取', failed: '页面读取失败', unavailable: '页面不可用' };
  const recovering = new Set(['login-required', 'login-form-unavailable', 'metric-not-found',
    'ambiguous', 'failed', 'unavailable']);
  let rows = [];
  const busy = new Set(), loginBusy = new Set();
  const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  function text(tag, value, cls) {
    const node = document.createElement(tag); node.textContent = value;
    if (cls) node.className = cls;
    return node;
  }
  function cardFor(id) { return el('channel-monitor-rows').querySelector(`[data-channel-id="${id}"]`); }
  async function refreshLoginState(id) {
    const box = cardFor(id)?.querySelector('.auto-login-box');
    if (!box) return;
    let state;
    try {
      const response = await window.groupAdmin.channelLoginState(id);
      state = response.ok ? response.data : { storageError: true };
    } catch { state = { storageError: true }; }
    box.querySelector('.auto-login-status').textContent = state.storageError ?
      '加密配置无法读取，自动登录已停用；请保留原文件检查。' : state.enabled ?
      '已加密保存并启用；会话失效时自动尝试一次。' : state.configured ?
      '自动登录已暂停；重新填写邮箱和密码可再次启用。' : '未配置；仅复用网站登录态。';
    box.closest('details').querySelector('summary').textContent = state.enabled ?
      '名称与自动登录设置 · 已启用' : state.configured ? '名称与自动登录设置 · 已暂停' : '名称与自动登录设置';
    box.querySelector('[data-login-action="save"]').disabled = loginBusy.has(id) || !!state.storageError;
    box.querySelector('[data-login-action="pause"]').disabled = loginBusy.has(id) || !state.enabled;
    box.querySelector('[data-login-action="clear"]').disabled = loginBusy.has(id) || !state.configured;
  }
  function buildLoginControls(channel) {
    const box = document.createElement('fieldset'); box.className = 'auto-login-box';
    const legend = document.createElement('legend'); legend.textContent = '本机加密自动登录（可选）'; box.append(legend);
    box.append(text('p', '仅在这台电脑加密保存。需要验证码或二次验证时停止自动尝试，请您手动登录。', 'hint'));
    const juxiang = channel.id === 'balance-juxiang';
    const emailLabel = document.createElement('label'); emailLabel.textContent = juxiang ? '用户名或电子邮件' : '登录邮箱';
    const email = document.createElement('input'); email.type = juxiang ? 'text' : 'email'; email.autocomplete = 'off'; email.maxLength = 254;
    emailLabel.append(email); box.append(emailLabel);
    const passwordLabel = document.createElement('label'); passwordLabel.textContent = '登录密码';
    const password = document.createElement('input'); password.type = 'password'; password.autocomplete = 'new-password'; password.maxLength = 1024;
    passwordLabel.append(password); box.append(passwordLabel);
    const actions = document.createElement('div'); actions.className = 'channel-buttons';
    for (const [action, caption] of [['save', '加密保存并启用'], ['pause', '暂停自动登录'], ['clear', '清除本机凭据']]) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.loginAction = action; button.textContent = caption;
      button.onclick = async () => {
        if (loginBusy.has(channel.id)) return;
        loginBusy.add(channel.id); button.disabled = true;
        try {
          const method = action === 'save' ? 'channelLoginSave' : action === 'pause' ? 'channelLoginPause' : 'channelLoginClear';
          const response = await window.groupAdmin[method](action === 'save' ?
            { id: channel.id, email: email.value, password: password.value } : channel.id);
          if (!response.ok) throw new Error(response.message);
          email.value = '';
          box.querySelector('.auto-login-notice').textContent = action === 'save' ?
            '已加密保存并启用。若网站窗口仍打开，请先关闭，再点“立即读取”。' :
            action === 'pause' ? '已暂停；加密凭据仍保存在本机。' : '本机凭据已清除。';
        } catch (error) { box.querySelector('.auto-login-notice').textContent = error.message; }
        finally { password.value = ''; loginBusy.delete(channel.id); await refreshLoginState(channel.id); }
      };
      actions.append(button);
    }
    box.append(actions, text('p', '', 'auto-login-status'), text('p', '', 'auto-login-notice'));
    return box;
  }
  function buildCard(channel) {
    const card = document.createElement('article'); card.className = 'channel-monitor-card'; card.dataset.channelId = channel.id;
    const heading = document.createElement('div'); heading.className = 'channel-heading';
    heading.append(text('strong', '', 'channel-name'), text('span', '', 'channel-metric'));
    card.append(heading, text('p', '', 'channel-origin'), text('p', '', 'channel-value'),
      text('p', '', 'channel-value-caption'), text('p', '', 'channel-status'), text('p', '', 'channel-times'));
    const buttons = document.createElement('div'); buttons.className = 'channel-buttons';
    for (const [action, caption] of [['open', '打开登录窗口'], ['check', '立即读取']]) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.action = action; button.textContent = caption;
      button.onclick = async () => {
        if (busy.has(channel.id)) return;
        busy.add(channel.id); button.disabled = true;
        try {
          const response = await window.groupAdmin[action === 'open' ? 'channelMonitorOpen' : 'channelMonitorCheck'](channel.id);
          if (!response.ok) throw new Error(response.message);
          update(response.data);
          el('channel-monitor-notice').textContent = action === 'open' ?
            '已打开对应站点窗口；登录由您亲自完成。' : '已执行一次读取；请查看对应渠道状态。';
        } catch (error) { el('channel-monitor-notice').textContent = error.message; }
        finally { busy.delete(channel.id); button.disabled = false; }
      };
      buttons.append(button);
    }
    card.append(buttons);
    const details = document.createElement('details'); details.className = 'channel-settings';
    details.addEventListener('toggle', () => {
      if (!details.open) for (const input of details.querySelectorAll('.auto-login-box input')) input.value = '';
    });
    const summary = document.createElement('summary'); summary.textContent = '名称与自动登录设置'; details.append(summary);
    const label = document.createElement('label'); label.textContent = '自定义名称';
    const input = document.createElement('input'); input.className = 'channel-name-input'; input.maxLength = 40;
    input.autocomplete = 'off'; input.dataset.dirty = 'false';
    input.addEventListener('input', () => { input.dataset.dirty = 'true'; }); label.append(input); details.append(label);
    const rename = document.createElement('button'); rename.type = 'button'; rename.dataset.action = 'rename'; rename.textContent = '保存名称';
    rename.onclick = async () => {
      if (busy.has(channel.id)) return;
      busy.add(channel.id); rename.disabled = true;
      try {
        const response = await window.groupAdmin.channelMonitorRename({ id: channel.id, name: input.value });
        if (!response.ok) throw new Error(response.message);
        input.dataset.dirty = 'false'; update(response.data);
        el('channel-monitor-notice').textContent = '名称已保存在本机。';
      } catch (error) { el('channel-monitor-notice').textContent = error.message; }
      finally { busy.delete(channel.id); rename.disabled = false; }
    };
    details.append(rename, buildLoginControls(channel)); card.append(details);
    return card;
  }
  function update(next) {
    rows = next;
    const root = el('channel-monitor-rows');
    for (const channel of next) {
      let card = cardFor(channel.id);
      if (!card) { card = buildCard(channel); root.append(card); }
      card.querySelector('.channel-name').textContent = channel.name;
      card.querySelector('.channel-metric').textContent = channel.metric;
      card.querySelector('.channel-origin').textContent = channel.origin + channel.path;
      const input = card.querySelector('.channel-name-input');
      if (input.dataset.dirty !== 'true') input.value = channel.name;
      card.querySelector('.channel-value').textContent = channel.display || '—';
      card.querySelector('.channel-value-caption').textContent = channel.status === 'ok' ?
        `${channel.metric} · 本次` : channel.display ?
        `上次${channel.metric}：${formatTime(channel.successAt)} · 当前未验证` : `${channel.metric} · 尚未取得`;
      card.querySelector('.channel-status').textContent = (labels[channel.status] || '状态未知') +
        (recovering.has(channel.status) ? ' · 将自动复查；登录凭据未启用或需要验证时请人工处理' : '');
      card.querySelector('.channel-times').textContent = `上次检查：${formatTime(channel.checkedAt)} · 下次计划：${channel.nextAt ? formatTime(new Date(channel.nextAt).toISOString()) : '—'}`;
      card.dataset.status = channel.status;
      void refreshLoginState(channel.id);
    }
    el('channel-monitor-notice').textContent = `已配置 ${next.length} 个渠道，五项金额分别显示，不混合相加。异常卡片会按退避间隔自动复查。`;
  }
  async function refresh() {
    try {
      const response = await window.groupAdmin.channelMonitorState();
      if (!response.ok) throw new Error(response.message);
      update(response.data);
    } catch (error) { el('channel-monitor-notice').textContent = error.message; }
  }
  el('channel-monitor-refresh').onclick = refresh;
  window.groupAdmin.channelMonitorOnState(update);
  window.addEventListener('admin-view-change', event => {
    if (event.detail.view === 'channel-monitor') void refresh();
    else {
      for (const input of el('channel-monitor-rows').querySelectorAll('.auto-login-box input')) input.value = '';
      for (const details of el('channel-monitor-rows').querySelectorAll('.channel-settings')) details.open = false;
    }
  });
  void refresh();
})();
