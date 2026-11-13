'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let busy = false;
  let current = null;
  const names = { enable: '启用本机接口', pause: '暂停接口', rotate: '轮换访问密钥', copyToken: '复制访问密钥' };

  function render(state, note = '') {
    current = state;
    const error = state?.storageError;
    $('finance-api-status').textContent = note || (state?.storageError ?
      '加密配置无法安全读取，接口保持关闭；请保留原文件检查。' :
      state?.listening ? `本机接口运行中：http://127.0.0.1:${state.port} · 仅授权的本机程序可读取。` :
      state?.lastError === 'LISTEN_FAILED' ? '接口未启动：本机端口被占用或监听失败。' :
      state?.enabled ? '接口已配置但未运行；请核对平台管理员授权后重新启用。' :
      '接口尚未启用，不会监听本机端口。');
    $('finance-api-enable').disabled = busy || !!error || !!state?.listening;
    $('finance-api-pause').disabled = busy || (!state?.enabled && !state?.listening);
    $('finance-api-rotate').disabled = busy || !!state?.storageError || !state?.configured;
    $('finance-api-copy-token').disabled = busy || !!state?.storageError || !state?.listening;
  }

  async function refresh() {
    try {
      const reply = await window.groupAdmin.financeApiState();
      if (!reply.ok) throw new Error(reply.message);
      render(reply.data);
    } catch { render({ storageError: true, listening: false, enabled: false }); }
  }

  async function act(kind) {
    if (busy) return;
    if (kind === 'rotate' && !confirm('轮换后旧访问密钥立即失效。确定继续吗？')) return;
    busy = true;
    render(current || { storageError: true, listening: false, enabled: false }, '正在处理本机接口…');
    try {
      const reply = await window.groupAdmin[`financeApi${kind[0].toUpperCase()}${kind.slice(1)}`]();
      if (!reply.ok) throw new Error(reply.message || `${names[kind]}未完成`);
      if (kind === 'copyToken') {
        await refresh();
        render(current, '访问密钥已复制到本机剪贴板，60 秒后自动清除。请通过安全渠道交接，不要贴进聊天。');
      } else render(reply.data, kind === 'enable' ? '本机只读接口已启用。' :
        kind === 'pause' ? '本机只读接口已暂停。' : '访问密钥已轮换，旧密钥立即失效。');
    } catch (error) {
      await refresh();
      render(current, `${names[kind]}失败：${error.message}`);
    } finally { busy = false; render(current, $('finance-api-status').textContent); }
  }
  for (const [kind, id] of [['enable', 'finance-api-enable'], ['pause', 'finance-api-pause'],
    ['rotate', 'finance-api-rotate'], ['copyToken', 'finance-api-copy-token']]) {
    $(id).addEventListener('click', () => { void act(kind); });
  }
  window.addEventListener('admin-view-change', event => {
    if (event.detail?.view === 'channel-monitor') void refresh();
  });
  void refresh();
})();
