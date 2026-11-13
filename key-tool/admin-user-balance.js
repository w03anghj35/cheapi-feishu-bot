'use strict';
(() => {
  const el = id => document.getElementById(id);
  const read = el('user-balance-read'), status = el('user-balance-status');
  const summary = el('user-balance-summary'), search = el('user-balance-search');
  const count = el('user-balance-count'), results = el('user-balance-results');
  const time = el('user-balance-time');
  let rows = [], shown = 100, busy = false, generation = 0, data = null;
  const decimals = /^(-?)(0|[1-9]\d{0,17})(?:\.(\d{1,8}))?$/;
  const units = raw => {
    const match = typeof raw === 'string' ? decimals.exec(raw) : null;
    if (!match) throw Error('余额格式不完整，请重新读取。');
    const value = BigInt(match[2]) * 100000000n + BigInt((match[3] || '').padEnd(8, '0'));
    return match[1] ? -value : value;
  };
  const money = raw => {
    units(raw);
    const [integer, fraction] = raw.split('.');
    return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`} CNY`;
  };
  function node(tag, text, className) {
    const element = document.createElement(tag); element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function setStatus(message, kind = 'info') { status.textContent = message; status.dataset.kind = kind; }
  function clear() {
    rows = []; shown = 100; data = null;
    summary.replaceChildren(); summary.hidden = true; results.replaceChildren();
    count.textContent = ''; time.textContent = ''; search.disabled = true;
  }
  function renderSummary() {
    const s = data.summary;
    summary.replaceChildren();
    const cards = [
      ['普通用户正余额合计（已排除管理员）', money(s.positiveTotal)],
      ['普通用户负余额（单列，不抵减）', money(s.negativeTotal)],
      ['计入合计的普通用户', `${s.positiveCount} 人`],
      ['已排除的管理员正余额', money(s.excludedAdminPositive)],
      ['本次读取全部账号', `${s.totalUsers} 人 · 管理员 ${s.adminCount} 人`]
    ];
    for (const [label, value] of cards) {
      const card = document.createElement('div'); card.className = 'user-balance-card';
      card.append(node('span', label), node('strong', value)); summary.append(card);
    }
    summary.hidden = false;
  }
  function renderRows() {
    const term = search.value.trim().toLocaleLowerCase();
    const filtered = term ? rows.filter(row => [row.id, row.email, row.username]
      .some(value => String(value ?? '').toLocaleLowerCase().includes(term))) : rows;
    results.replaceChildren();
    count.textContent = `已读取 ${rows.length} 个账号；筛选显示 ${filtered.length} 个，当前列出 ${Math.min(shown, filtered.length)} 个。全量正余额合计不受筛选影响。`;
    if (!filtered.length) {
      results.append(node('p', rows.length ? '没有匹配的用户。' : '平台暂无用户。')); return;
    }
    const wrap = document.createElement('div'); wrap.className = 'user-balance-table-wrap';
    const table = document.createElement('table'); table.className = 'user-balance-table';
    const caption = node('caption', '用户余额明细（按余额从小到大）'); table.append(caption);
    const head = document.createElement('thead'), header = document.createElement('tr');
    for (const label of ['用户 ID', '用户名／邮箱', '角色', '状态', '余额（CNY）', '合计口径']) {
      const th = node('th', label); th.scope = 'col'; header.append(th);
    }
    head.append(header); table.append(head);
    const body = document.createElement('tbody');
    for (const row of filtered.slice(0, shown)) {
      const tr = document.createElement('tr'), value = units(row.balance);
      tr.append(node('td', String(row.id)));
      const identity = document.createElement('td');
      identity.append(node('strong', row.username || '未设置用户名'), node('span', row.email));
      tr.append(identity, node('td', row.role === 'admin' ? '管理员' : '普通用户'),
        node('td', ({ active: '正常', disabled: '已停用', inactive: '未激活' })[row.status] || row.status),
        node('td', money(row.balance), value < 0n ? 'user-balance-negative' : value > 0n ? 'user-balance-positive' : ''));
      tr.append(node('td', row.role === 'admin' ? '管理员不计入' :
        value > 0n && row.included ? '计入正余额合计' : value === 0n ? '零余额不计入' : '负余额不计入'));
      body.append(tr);
    }
    table.append(body); wrap.append(table); results.append(wrap);
    if (shown < filtered.length) {
      const more = node('button', `再显示 ${Math.min(100, filtered.length - shown)} 个用户`);
      more.type = 'button'; more.addEventListener('click', () => { shown += 100; renderRows(); }); results.append(more);
    }
  }
  async function query() {
    if (busy) return;
    const serial = ++generation;
    clear(); busy = true; read.disabled = true;
    setStatus('正在完整读取用户目录并核对管理员身份，请稍候…', 'busy');
    try {
      const reply = await window.groupAdmin.userBalanceQuery();
      if (serial !== generation) return;
      if (!reply?.ok) throw Error(reply?.message || '余额读取失败。');
      const result = reply.data;
      if (!result || result.complete !== true || !Array.isArray(result.rows) || !result.summary ||
          result.unit !== 'CNY' || !Number.isFinite(Date.parse(result.startedAt)) ||
          !Number.isFinite(Date.parse(result.checkedAt))) throw Error('余额没有完整读回，本次不展示合计。');
      for (const row of result.rows) {
        if (!Number.isSafeInteger(row.id) || row.id <= 0 || !['admin', 'user'].includes(row.role) ||
            typeof row.email !== 'string' || typeof row.username !== 'string' || typeof row.included !== 'boolean')
          throw Error('用户资料不完整，本次不展示合计。');
        units(row.balance);
      }
      units(result.summary.positiveTotal); units(result.summary.negativeTotal); units(result.summary.excludedAdminPositive);
      data = result;
      rows = [...result.rows].sort((a, b) => {
        const left = units(a.balance), right = units(b.balance);
        return left < right ? -1 : left > right ? 1 : a.id - b.id;
      });
      renderSummary(); renderRows(); search.disabled = false;
      const stamp = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      time.textContent = `本次读取区间：${stamp(data.startedAt)} 至 ${stamp(data.checkedAt)}（北京时间）。`;
      setStatus(`读取完成：${rows.length} 个账号。合计仅包括普通用户的正余额。`, 'success');
      read.textContent = '重新读取全部用户余额';
    } catch (error) {
      if (serial !== generation) return;
      clear(); setStatus(`用户余额查询失败：${error.message}`, 'error');
    } finally { busy = false; read.disabled = false; }
  }
  read.addEventListener('click', () => void query());
  search.addEventListener('input', () => { shown = 100; renderRows(); });
  window.groupAdmin.onAuth(state => {
    if (!state || !['login', 'expired', 'required', 'storage-error', 'offline'].includes(state.phase)) return;
    generation++; clear();
    setStatus('管理员授权状态已变化，旧余额已清除；请完成授权后重新读取。', 'error');
  });
})();
