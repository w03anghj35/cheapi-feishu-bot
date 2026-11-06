'use strict';
(() => {
  const el = id => document.getElementById(id);
  let accounts = [], plans = [], owner = null, busy = false, generation = 0;
  const status = { scheduled: '等待执行', attempting: '正在执行／回读', done: '已完成',
    unknown: '结果不明 · 暂停后续', missed: '已错过执行窗口', cancelled: '已取消' };
  const notice = (message, kind = 'info') => { el('account-schedule-notice').textContent = message; el('account-schedule-notice').dataset.kind = kind; };
  const accountName = id => accounts.find(a => a.id === id)?.name || `账号 ID ${id}`;
  const button = (title, action) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = title; node.addEventListener('click', action); return node; };
  function controls() {
    el('account-schedule-refresh').disabled = busy;
    el('account-schedule-create').disabled = busy || !owner || accounts.length < 2;
  }
  function renderAccounts() {
    const query = el('account-schedule-search').value.trim().toLocaleLowerCase();
    const visible = accounts.filter(a => !query || [String(a.id), a.name, a.platform].some(v => v.toLocaleLowerCase().includes(query)));
    const root = el('account-schedule-accounts'); root.replaceChildren();
    if (!visible.length) { root.textContent = accounts.length ? '没有匹配的账号。' : '尚未读取平台账号。'; return; }
    for (const account of visible) {
      const row = document.createElement('div'); row.className = 'account-schedule-account';
      const name = document.createElement('strong'); name.textContent = account.name;
      const detail = document.createElement('span'); detail.textContent = `ID ${account.id} · ${account.platform || '平台未标注'} · ${account.status || '状态未标注'}`;
      const state = document.createElement('span'); state.className = 'account-schedule-badge';
      state.dataset.enabled = String(account.schedulable); state.textContent = account.schedulable ? '调度已打开' : '调度已关闭';
      row.append(name, detail, state); root.append(row);
    }
  }
  function renderChoices() {
    for (const [elementId, wanted] of [['account-schedule-open', 'open'], ['account-schedule-close', 'close']]) {
      const select = el(elementId), previous = select.value; select.replaceChildren();
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = `请选择要${wanted === 'open' ? '打开' : '关闭'}的账号`;
      select.append(empty);
      for (const account of accounts) {
        const option = document.createElement('option'); option.value = String(account.id);
        option.textContent = `${account.name} · ID ${account.id} · ${account.schedulable ? '当前开' : '当前关'}`;
        select.append(option);
      }
      if (accounts.some(a => String(a.id) === previous)) select.value = previous;
    }
  }
  function renderPlans() {
    const root = el('account-schedule-plans'); root.replaceChildren();
    if (!plans.length) { root.textContent = '还没有保存计划。'; return; }
    const ordered = [...plans].sort((a,b) => a.steps[0].epoch - b.steps[0].epoch);
    for (const plan of ordered) {
      const card = document.createElement('section'); card.className = 'account-schedule-plan';
      const heading = document.createElement('strong'); heading.textContent = `${plan.order === 'open-first' ? '先开后关' : '先关后开'} · 计划 ${plan.id.slice(0, 8)}`;
      const list = document.createElement('ol');
      plan.steps.forEach((step, index) => {
        const item = document.createElement('li');
        const detail = document.createElement('span');
        const state = index === 1 && step.state === 'scheduled' && plan.steps[0].state === 'unknown' ?
          '等待第一步核对' : status[step.state] || '待核对';
        detail.textContent = `${step.at.replace('T', ' ')}（北京时间） · ${step.desired ? '打开' : '关闭'} ${accountName(step.accountId)} · ${state}`;
        item.append(detail);
        if (step.state === 'unknown') item.append(button('只读回查状态', () => act('reconcile', { id: plan.id, index })));
        list.append(item);
      });
      card.append(heading, list);
      if (plan.steps.some(s => s.state === 'scheduled')) card.append(button('取消剩余未执行步骤', () => act('cancel', plan.id)));
      root.append(card);
    }
  }
  async function refresh() {
    if (busy) return;
    busy = true; controls(); notice('正在读取平台账号和本机计划…', 'busy');
    const revision = generation;
    try {
      const reply = await window.groupAdmin.accountScheduleSnapshot();
      if (!reply.ok) throw new Error(reply.message);
      if (revision !== generation) return;
      accounts = reply.data.accounts; plans = reply.data.plans; owner = reply.data.owner;
      renderAccounts(); renderChoices(); renderPlans();
      notice(`已读取 ${accounts.length} 个账号、${plans.length} 条计划。当前状态仅以本次平台读取为准。`, 'success');
    } catch (error) { notice(`读取失败：${error.message}`, 'error'); }
    finally { busy = false; controls(); }
  }
  async function act(kind, input) {
    if (busy) return;
    busy = true; controls(); notice(kind === 'create' ? '正在核对并保存计划…' : '正在处理计划…', 'busy');
    try {
      const method = kind === 'create' ? 'accountScheduleCreate' : kind === 'cancel' ? 'accountScheduleCancel' : 'accountScheduleReconcile';
      const reply = await window.groupAdmin[method](input);
      if (!reply.ok) throw new Error(reply.message);
      plans = reply.data.plans; owner = reply.data.owner;
      renderPlans();
      notice(kind === 'create' ? '计划已保存，程序将按北京时间依次执行。' :
        kind === 'cancel' ? '未执行步骤已取消；已完成或结果不明的操作仍保留记录。' : '平台回读与目标一致，未重发开关请求。', 'success');
    } catch (error) { notice(`操作未完成：${error.message}`, 'error'); }
    finally { busy = false; controls(); }
  }
  el('account-schedule-refresh').addEventListener('click', refresh);
  el('account-schedule-search').addEventListener('input', renderAccounts);
  el('account-schedule-form').addEventListener('submit', event => {
    event.preventDefault();
    act('create', { openId: Number(el('account-schedule-open').value), closeId: Number(el('account-schedule-close').value),
      order: el('account-schedule-order').value, firstAt: el('account-schedule-first').value,
      secondAt: el('account-schedule-second').value });
  });
  window.groupAdmin.accountScheduleOnState(state => {
    if (!state || state.owner !== owner || busy) return;
    plans = state.plans; renderPlans();
  });
  window.groupAdmin.onAuth(state => {
    if (!['login', 'expired', 'required', 'storage-error'].includes(state.phase) &&
        (!owner || state.owner === owner)) return;
    generation++; accounts = []; plans = []; owner = null;
    renderAccounts(); renderChoices(); renderPlans(); controls();
    notice('授权状态已变化，请重新读取平台账号。');
  });
  renderAccounts(); renderPlans(); controls();
})();
