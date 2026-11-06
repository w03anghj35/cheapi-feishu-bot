'use strict';
(() => {
  const el = id => document.getElementById(id);
  const controls = ['channel-alert-save', 'channel-alert-pause', 'channel-alert-clear', 'channel-alert-test'].map(el);
  let busy = false, last = null, senderDirty = false, recipientsDirty = false, thresholdDirty = false, timeDirty = false;
  function show(state, message = '') {
    last = state;
    if (!senderDirty) el('channel-alert-sender').value = state.sender || '';
    if (!recipientsDirty) el('channel-alert-recipients').value = (state.recipients || []).join('\n');
    if (!thresholdDirty) el('channel-alert-threshold').value = String(state.threshold ?? 2000);
    if (!timeDirty) el('channel-alert-daily-time').value = state.dailyTime || '';
    el('channel-alert-status').textContent = message || (state.storageError ?
      '加密配置读取失败，提醒已停止；请保留原文件检查。' : state.enabled ?
      `已启用：${state.recipients.length} 个收件人，五站各自低于 ${state.threshold} 时提醒；每日汇总${state.dailyTime ? `北京时间 ${state.dailyTime}` : '未启用'}。` :
      state.configured ? '提醒已暂停；重新输入授权码并保存可启用。' : '未配置，当前不会发邮件。');
    if (state.attention?.length) el('channel-alert-status').textContent +=
      ` ${state.attention.length} 笔发送结果不明，已停止自动重试；请先查收件箱和发件箱。`;
    if (state.dailyAttention?.length) el('channel-alert-status').textContent +=
      ` ${state.dailyAttention.length} 笔每日汇总结果不明，当天不会自动重发；请核对发件箱和收件箱。`;
    controls[0].disabled = busy || !!state.storageError;
    controls[1].disabled = busy || !state.enabled;
    controls[2].disabled = busy || !state.configured;
    controls[3].disabled = busy || !state.enabled;
  }
  async function refresh() {
    try {
      const response = await window.groupAdmin.channelAlertState();
      if (!response.ok) throw new Error(response.message);
      show(response.data);
    } catch (error) { el('channel-alert-status').textContent = error.message; }
  }
  async function action(kind) {
    if (busy) return;
    if (kind === 'test' && !window.confirm('确认发送一次测试邮件？邮件会列出当前已读取的渠道金额，不会改变正式提醒状态。')) return;
    busy = true; controls.forEach(button => { button.disabled = true; });
    try {
      const input = kind === 'save' ? { from: el('channel-alert-sender').value,
        authCode: el('channel-alert-code').value,
        recipients: el('channel-alert-recipients').value,
        threshold: el('channel-alert-threshold').value,
        dailyTime: el('channel-alert-daily-time').value } : undefined;
      const method = { save: 'channelAlertSave', pause: 'channelAlertPause', clear: 'channelAlertClear', test: 'channelAlertTest' }[kind];
      const response = await window.groupAdmin[method](kind === 'test' ? el('channel-alert-test-scope').value : input);
      if (!response.ok) throw new Error(response.message);
      if (kind === 'test') {
        const result = response.data;
        el('channel-alert-status').textContent =
          `测试邮件：拟发送 ${result.requested} 封，SMTP 接受 ${result.accepted} 封，结果不明 ${result.uncertain} 封，未尝试 ${result.skipped} 封。${result.message}`;
        return;
      }
      senderDirty = false; recipientsDirty = false; thresholdDirty = false; timeDirty = false;
      show(response.data, kind === 'save' ? '已加密保存并启用；低余额在新成功读取时判断，每日汇总按所填北京时间到点发送。保存本身不发信。' :
        kind === 'pause' ? '已暂停低余额邮件提醒。' : '提醒配置已清除。');
    } catch (error) { el('channel-alert-status').textContent = error.message; }
    finally { el('channel-alert-code').value = ''; busy = false; if (last) show(last, el('channel-alert-status').textContent); }
  }
  el('channel-alert-save').onclick = () => void action('save');
  el('channel-alert-pause').onclick = () => void action('pause');
  el('channel-alert-clear').onclick = () => void action('clear');
  el('channel-alert-test').onclick = () => void action('test');
  el('channel-alert-sender').addEventListener('input', () => { senderDirty = true; });
  el('channel-alert-recipients').addEventListener('input', () => { recipientsDirty = true; });
  el('channel-alert-threshold').addEventListener('input', () => { thresholdDirty = true; });
  el('channel-alert-daily-time').addEventListener('input', () => { timeDirty = true; });
  document.querySelector('.channel-alert-settings').addEventListener('toggle', event => {
    if (!event.currentTarget.open) el('channel-alert-code').value = '';
  });
  window.groupAdmin.channelAlertOnState(state => show(state));
  window.addEventListener('admin-view-change', event => {
    if (event.detail.view === 'channel-monitor') void refresh();
    else el('channel-alert-code').value = '';
  });
  void refresh();
})();
