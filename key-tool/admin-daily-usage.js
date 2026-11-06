'use strict';
(() => {
  const el = id => document.getElementById(id);
  const buttons = ['daily-usage-preview', 'daily-usage-enable', 'daily-usage-pause'].map(el);
  let busy = false, state = null, preview = null;
  const notice = value => { el('daily-usage-status').textContent = value; };
  function controls() {
    buttons[0].disabled = busy;
    buttons[1].disabled = busy || state?.enabled === true || !preview?.rows?.length;
    buttons[2].disabled = busy || state?.enabled !== true;
  }
  function showState(next, message = '') {
    state = next;
    const unknown = next.cards?.filter(card => ['unknown','attempting'].includes(card.phase)) || [];
    notice(message || `${next.enabled ? '群表已启用' : '群表已暂停'} · 最近采样：${next.lastCheckedAt ?
      new Date(next.lastCheckedAt).toLocaleString('zh-CN', { hour12: false }) : '尚无'} · ${unknown.length} 张卡片结果待核对。` +
      (unknown.length ? ' 请先在目标群核对，系统不会重复创建结果不明的卡片。' : ''));
    controls();
  }
  function showPreview(data) {
    preview = data;
    const root = el('daily-usage-preview-rows'); root.replaceChildren();
    for (const profile of data.rows || []) {
      const section = document.createElement('section'); section.className = 'daily-usage-preview-profile';
      const heading = document.createElement('strong'); heading.textContent = profile.name;
      section.append(heading);
      const table = document.createElement('table');
      const head = document.createElement('tr');
      for (const title of ['平台邮箱', '今日用户实付（USD）']) {
        const th = document.createElement('th'); th.textContent = title; head.append(th);
      }
      table.append(head);
      let total = 0;
      for (const user of profile.users) {
        const tr = document.createElement('tr');
        for (const value of [user.email, `$${Number(user.cost).toFixed(4)}`]) {
          const td = document.createElement('td'); td.textContent = value; tr.append(td);
        }
        table.append(tr); total += user.cost;
      }
      const foot = document.createElement('tr');
      for (const value of ['合计', `$${total.toFixed(4)}`]) {
        const td = document.createElement('td'); td.textContent = value; foot.append(td);
      }
      table.append(foot); section.append(table); root.append(section);
    }
    notice(`已只读预览 ${data.rows.length} 个归属档案的 ${data.day} 用户实付用量；群卡片尚未发送。请核对邮箱范围、金额和目标群。`);
    controls();
  }
  async function refresh() {
    try {
      const reply = await window.groupAdmin.dailyUsageState();
      if (!reply.ok) throw Error(reply.message);
      showState(reply.data);
    } catch { notice('每日用量发布状态暂不可读取，请检查管理员授权和本机加密账本。'); }
  }
  buttons[0].onclick = async () => {
    if (busy) return;
    busy = true; controls(); notice('正在只读读取平台用量；不会发送到群。');
    try {
      const reply = await window.groupAdmin.dailyUsagePreview();
      if (!reply.ok) throw Error(reply.message);
      showPreview(reply.data);
    } catch (error) { preview = null; notice(`预览失败：${error.message}`); }
    finally { busy = false; controls(); }
  };
  buttons[1].onclick = async () => {
    if (busy || !preview?.rows?.length || state?.enabled) return;
    if (!confirm(`确认将 ${preview.rows.length} 个归属人的每日用量卡片发布到当前已绑定目标群？卡片逐账号显示邮箱与金额，全群可见；开启后今日约每小时更新同一张卡片。`)) return;
    busy = true; controls(); notice('已确认启用，正在再次核对授权、用量和目标群；请勿重复点击。');
    try {
      const reply = await window.groupAdmin.dailyUsageEnable();
      if (!reply.ok) throw Error(reply.message);
      showState(reply.data.state, reply.data.error ||
        `已启用：本轮更新 ${reply.data.result.updated || 0} 张，结果待核对 ${reply.data.result.unknown || 0} 张。请到目标群核对实际卡片。`);
    } catch (error) { notice(`启用失败：${error.message}`); await refresh(); }
    finally { busy = false; controls(); }
  };
  buttons[2].onclick = async () => {
    if (busy || !state?.enabled) return;
    busy = true; controls();
    try {
      const reply = await window.groupAdmin.dailyUsagePause();
      if (!reply.ok) throw Error(reply.message);
      showState(reply.data, '已暂停后续群发布；已发群卡片不会自动删除。');
    } catch (error) { notice(`暂停失败：${error.message}`); }
    finally { busy = false; controls(); }
  };
  window.addEventListener('admin-view-change', event => {
    if (event.detail.view === 'user-ownership') void refresh();
    else { preview = null; el('daily-usage-preview-rows').replaceChildren(); controls(); }
  });
  controls();
})();
