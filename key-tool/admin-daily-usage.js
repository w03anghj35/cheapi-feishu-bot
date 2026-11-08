'use strict';
(() => {
  const el = id => document.getElementById(id);
  const buttons = ['daily-usage-preview', 'daily-usage-enable', 'daily-usage-pause'].map(el);
  const timeInput = el('daily-usage-time');
  const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  let busy = false, state = null, preview = null;
  const notice = value => { el('daily-usage-status').textContent = value; };
  const beijingTime = value => new Date(value).toLocaleString('zh-CN',
    { timeZone: 'Asia/Shanghai', hour12: false });
  const failureNames = { local: '本机卡片预检未通过', api: '飞书 API 拒绝', http: 'HTTP 请求失败',
    timeout: '网络或服务端超时', network: '网络连接失败', receipt: '回执缺少可确认的消息 ID',
    unknown: '失败阶段未能确认' };
  function controls() {
    buttons[0].disabled = busy;
    buttons[1].disabled = busy || !preview?.rows?.length || !validTime(timeInput.value);
    buttons[2].disabled = busy || state?.enabled !== true;
    for (const button of el('daily-usage-reviews').querySelectorAll('button'))
      button.disabled = busy || !button.parentElement.querySelector('input[type=checkbox]')?.checked;
  }
  function renderReviews(next) {
    const root = el('daily-usage-reviews'); root.replaceChildren();
    for (const card of (next.cards || []).filter(item => ['unknown', 'attempting', 'reviewed-absent'].includes(item.phase))) {
      const section = document.createElement('section'); section.className = 'daily-usage-review';
      const title = document.createElement('strong');
      title.textContent = `${card.name} · ${card.phase === 'reviewed-absent' ? '人工记录未见' : '发送结果待核对'}`;
      const detail = document.createElement('p');
      detail.textContent = `目标群摘要 ${next.groupRef || '—'} · 首次尝试 ${beijingTime(card.attemptedAt || card.at)}（北京时间）。`;
      section.append(title, detail);
      if (card.failure) {
        const diagnostic = document.createElement('p');
        diagnostic.textContent = `脱敏诊断：${failureNames[card.failure.kind] || '未分类'}` +
          (card.failure.httpStatus ? ` · HTTP ${card.failure.httpStatus}` : '') +
          (card.failure.apiCode !== undefined ? ` · 飞书码 ${card.failure.apiCode}` : '') + '。';
        section.append(diagnostic);
      } else if (card.phase !== 'reviewed-absent') {
        const diagnostic = document.createElement('p'); diagnostic.textContent = '这笔旧记录没有留存具体失败码。';
        section.append(diagnostic);
      }
      if (card.phase === 'reviewed-absent') {
        const note = document.createElement('p');
        note.textContent = '已加密记录人工核对，群发布保持暂停。若要再次发布，须重新预览并明确确认。';
        section.append(note);
      } else if (card.action !== 'create') {
        const note = document.createElement('p');
        note.textContent = '这不是首次创建结果，不能按“未见卡片”解除；请单独核对原消息。';
        section.append(note);
      } else {
        const label = document.createElement('label');
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        label.append(checkbox, document.createTextNode(' 我已在原绑定群按时间和归属姓名核对，确认没有这张卡片；理解以后重发可能重复公开邮箱与金额。'));
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = '记录未见并暂停（不发送）'; button.disabled = true;
        checkbox.addEventListener('change', () => { button.disabled = busy || !checkbox.checked; });
        button.addEventListener('click', async () => {
          if (busy || !checkbox.checked) return;
          busy = true; controls(); notice('正在再次核对管理员、目标群和原发送记录；不会向群发消息。');
          try {
            const reply = await window.groupAdmin.dailyUsageReviewAbsent({ name: card.name, at: card.at, confirmed: true });
            if (!reply.ok) throw Error(reply.message);
            if (reply.data.cancelled) showState(reply.data.state, '已取消人工核对；原结果不明保护仍在。');
            else {
              preview = null; el('daily-usage-preview-rows').replaceChildren();
              showState(reply.data.state, '已加密记录“原群未见卡片”并暂停发布；没有发送消息。请重新预览后再决定是否发布。');
            }
          } catch (error) {
            const message = `核对未完成：${error.message}`;
            await refresh(); notice(message);
          }
          finally { busy = false; controls(); }
        });
        section.append(label, button);
      }
      root.append(section);
    }
  }
  function showState(next, message = '') {
    state = next;
    if (timeInput.dataset.dirty !== 'true') timeInput.value = next.dailyTime || '';
    renderReviews(next);
    const unknown = next.cards?.filter(card => ['unknown','attempting'].includes(card.phase)) || [];
    notice(message || `${next.enabled && next.dailyTime ? `定时群表已启用 · 每日 ${next.dailyTime} 北京时间 · 最早 ${next.effectiveDay || '待确认'} 生效` :
      next.enabled ? '旧版群表尚未设置每日时间，自动群发布已暂停' : '群表未启用'} · 本机历史按小时独立采样 · 最近采样：${next.lastCheckedAt ?
      new Date(next.lastCheckedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚无'} · ${unknown.length} 张卡片结果待核对。` +
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
    const selectedTime = timeInput.value;
    if (busy || !preview?.rows?.length || !validTime(selectedTime)) return;
    if (!confirm(`确认设定每天北京时间 ${selectedTime} 更新 ${preview.rows.length} 个归属人的每日用量群卡片？卡片逐账号显示邮箱与金额，全群可见。当前操作不立即发送；若今日所选时刻尚未到，今日起生效，否则次日起生效。错过时段不补发。`)) return;
    busy = true; controls(); notice('正在再次核对授权、用量和目标群并保存每日时间；当前操作不立即发群。');
    try {
      const reply = await window.groupAdmin.dailyUsageEnable(selectedTime);
      if (!reply.ok) throw Error(reply.message);
      timeInput.dataset.dirty = 'false';
      showState(reply.data.state,
        `已设定北京时间每日 ${selectedTime} 更新群卡片，最早从 ${reply.data.state.effectiveDay} 生效；当前操作没有发群。到达设定时间后请到原目标群核对实际卡片。`);
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
  timeInput.addEventListener('input', () => { timeInput.dataset.dirty = 'true'; controls(); });
  controls();
})();
