'use strict';
(() => {
  const views = {
    configuration: ['管理配置', '管理平台授权、飞书连接、管理员与目标群绑定。'],
    'token-groups': ['令牌分组', '配置令牌创建菜单的分组名称。留空不发布，不修改平台原始名称。'],
    'group-settings': ['分组设置', '发布管理员专用的倍率分组，并查看用户分组设置记录。'],
    'token-history': ['令牌记录', '查询创建结果、交付记录和需要核对的操作。'],
    'registration-history': ['注册记录', '查询用户注册结果，处理需要人工核对的注册。'],
    'operation-log': ['操作日志', '按时间、阶段和错误编号检修本机管理操作。'],
    'channel-monitor': ['渠道监控', '每30分钟读取两项积分余额及三项剩余余额，登录状态保存在本机。'],
    'channel-access': ['渠道授权', '预先配置聊天身份可查看的渠道，并预览只读结果。'],
    'user-ownership': ['用户归属', '把平台用户分配给核对过的飞书成员，供其在私聊查询当前余额。'],
    'account-management': ['账号管理', '为两个平台账号安排一次性调度开关，按明确顺序依次执行。'],
    'usage-history': ['用量统计', '按月份、周与归属人查看本机已采集用量，或按日期导出 Excel。'],
    'recharge-query': ['充值查询', '逐笔查询平台充值记录，区分管理员充值、其他来源和待确认的操作人。'],
    'bulk-group-rates': ['批量分组调价', '只读核对已授权分组及各用户当前倍率，预览后按固定数值批量上调或下调。'],
    'user-balance': ['用户余额', '逐个查看平台用户余额，汇总排除管理员后的普通用户正余额。']
  };
  let current = 'configuration';
  const buttons = [...document.querySelectorAll('[data-admin-target]')];
  function show(view, focus = true) {
    if (!Object.hasOwn(views, view)) return;
    const previous = current; current = view;
    // Hide before moving focus; the same DOM stays mounted so drafts and requests survive.
    for (const section of document.querySelectorAll('[data-admin-view]')) {
      section.hidden = section.dataset.adminView !== view;
      section.inert = section.hidden;
    }
    for (const button of buttons) {
      if (button.dataset.adminTarget === view) button.setAttribute('aria-current','page');
      else button.removeAttribute('aria-current');
    }
    document.getElementById('admin-view-title').textContent = views[view][0];
    document.getElementById('admin-view-description').textContent = views[view][1];
    if (previous !== view) {
      document.getElementById('bot-app-secret').value = '';
      window.dispatchEvent(new CustomEvent('admin-view-change', { detail: { view, previous } }));
    }
    if (focus) { document.getElementById('admin-view-title').focus({preventScroll:true}); window.scrollTo(0,0); }
  }
  for (const button of buttons) button.addEventListener('click', () => show(button.dataset.adminTarget));
  window.addEventListener('admin-navigate', event => { if (event.detail?.view === 'usage-history') show('usage-history'); });
  show(current, false);
})();
