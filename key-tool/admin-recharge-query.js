'use strict';
(() => {
  const el = id => document.getElementById(id);
  const form = el('recharge-query-form');
  const recipientInput = el('recharge-query-user-id');
  const adminInput = el('recharge-query-admin-id');
  const runButton = el('recharge-query-run');
  const status = el('recharge-query-status');
  const warning = el('recharge-query-warning');
  const summary = el('recharge-query-summary');
  const filter = el('recharge-query-filter');
  const count = el('recharge-query-count');
  const results = el('recharge-query-results');
  const audit = el('recharge-query-audit');
  const auditStatus = el('recharge-query-audit-status');
  const auditRows = el('recharge-query-audit-rows');
  const typeLabels = {
    'admin-recharge': '管理员充值', 'admin-deduction': '管理员扣减',
    'code-balance': '兑换码余额', 'affiliate-balance': '推广余额',
    subscription: '订阅额度', other: '其他充值／调整', 'non-monetary': '非金额记录'
  };
  let busy = false, rows = [], displayed = 100, auditDisplayed = 100, result = null, generation = 0;
  const value = data => data === null || data === undefined || data === '' ? '未提供' : String(data);
  const amount = (raw, unit) => {
    if (raw === null || raw === undefined || raw === '') return '未提供';
    const number = String(raw);
    if (!/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/.test(number)) return '未提供';
    const [whole, fraction] = number.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${grouped}${fraction === undefined ? '' : `.${fraction}`} ${unit}`;
  };
  const time = raw => {
    if (!raw) return '时间未提供';
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ?
      `${date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）` : String(raw);
  };
  function setStatus(message, kind = 'info') { status.textContent = message; status.dataset.kind = kind; }
  function setWarning(message) { warning.textContent = message; warning.hidden = !message; }
  function textNode(tag, content, className) {
    const node = document.createElement(tag);
    node.textContent = content;
    if (className) node.className = className;
    return node;
  }
  function clearResult() {
    rows = []; result = null; displayed = 100; auditDisplayed = 100;
    summary.replaceChildren(); summary.hidden = true;
    results.replaceChildren(); count.textContent = '';
    audit.hidden = true; auditStatus.textContent = ''; auditRows.replaceChildren();
    filter.value = ''; filter.disabled = true;
    setWarning('');
  }
  function readId(input, label) {
    const raw = input.value.trim();
    if (!raw) return undefined;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new Error(`${label}必须是正整数平台用户 ID。`);
    return Number(raw);
  }
  function renderSummary(data) {
    summary.replaceChildren();
    summary.hidden = false;
    const unit = value(data.unit) === '未提供' ? '平台余额单位' : String(data.unit);
    const totals = data.summary || {};
    const attributable = data.operatorAvailable === true && totals.selfExclusionReady === true;
    const small = attributable && totals.smallOther !== null && totals.smallOther !== undefined ?
      typeof totals.smallOther === 'object' ?
        `${amount(totals.smallOther.amount, unit)} · ${value(totals.smallOther.count)} 笔` :
        amount(totals.smallOther, unit) : null;
    const values = [
      ['管理员正向充值（未剔除）', amount(totals.adminGross, unit)],
      ['管理员给自己充值（待剔除）', attributable ? amount(totals.selfExcluded, unit) : null],
      ['管理员给他人充值（剔除后）', attributable ? amount(totals.adminNet, unit) : null],
      [`给他人单笔低于 ${Number.isFinite(totals.smallThreshold) ? totals.smallThreshold : 10} ${unit} 的小额充值`, small]
    ];
    for (const [label, formatted] of values) {
      const card = document.createElement('div'); card.className = 'recharge-query-total';
      card.append(textNode('span', label), textNode('strong', formatted ?? '待确认'));
      summary.append(card);
    }
  }
  function matchingRows() {
    const search = filter.value.trim().toLocaleLowerCase();
    if (!search) return rows;
    return rows.filter(row => [row.id, row.recipientId, row.recipientEmail,
      row.recipientName, row.actorId, row.actorName, row.kind,
      typeLabels[row.kind] || row.classification].some(field =>
      String(field ?? '').toLocaleLowerCase().includes(search)));
  }
  function renderRows() {
    const visible = matchingRows();
    const total = visible.length;
    results.replaceChildren();
    count.textContent = `本次读取 ${rows.length} 笔；当前筛选 ${total} 笔，显示前 ${Math.min(displayed, total)} 笔。`;
    if (!total) { results.append(textNode('p', rows.length ? '没有匹配的充值记录。' : '没有查到充值记录。')); return; }
    const unit = result?.unit || '平台余额单位';
    const list = document.createElement('ol'); list.className = 'recharge-query-list';
    for (const row of visible.slice(0, displayed)) {
      const item = document.createElement('li'); item.className = 'recharge-query-item';
      const recipient = [row.recipientName, row.recipientEmail].filter(Boolean).join(' · ');
      const actor = result?.operatorAvailable !== true || row.actorId === null || row.actorId === undefined ?
        '操作人未提供（无法确认谁充的）' :
        `${value(row.actorName)} · 操作人 ID ${row.actorId}`;
      const kind = typeLabels[row.kind] || '类型未确认';
      const self = row.kind === 'admin-recharge' ?
        result?.operatorAvailable !== true ? '是否自充待确认' :
          row.selfStatus === 'self' ? '管理员给自己充值' :
          row.selfStatus === 'other' ? '管理员给他人充值' : '是否自充待确认' : '';
      const top = document.createElement('div'); top.className = 'recharge-query-item-top';
      top.append(textNode('strong', `${kind} · ${amount(row.amount, unit)}`),
        textNode('span', time(row.at)));
      item.append(top,
        textNode('p', `收款人：${recipient || '名称未提供'} · 用户 ID ${value(row.recipientId)}`),
        textNode('p', `操作人：${actor}`));
      if (self) item.append(textNode('p', self, 'recharge-query-self'));
      item.append(textNode('p', `平台类型：${value(row.kind)} · 流水 ID ${value(row.id)}`, 'recharge-query-source'));
      list.append(item);
    }
    results.append(list);
    if (total > displayed) {
      const more = document.createElement('button'); more.type = 'button';
      more.textContent = `再显示 ${Math.min(100, total - displayed)} 笔`;
      more.addEventListener('click', () => { displayed += 100; renderRows(); });
      results.append(more);
    }
  }
  function renderAudit(data) {
    if (!Array.isArray(data.auditRows)) return;
    audit.hidden = false;
    const candidates = data.auditRows;
    auditRows.replaceChildren();
    const state = data.auditComplete === false ?
      `审计候选读取不完整；目前仅有 ${candidates.length} 条，不能视作完整操作记录。` :
      `本次读取 ${candidates.length} 条独立审计候选，未与上方充值流水逐笔对账。`;
    auditStatus.textContent = data.auditWarning ? `${state} ${String(data.auditWarning)}` : state;
    auditStatus.dataset.kind = data.auditComplete === false ? 'error' : 'info';
    if (!candidates.length) { auditRows.append(textNode('p', '没有查到对应的管理员操作审计候选。')); return; }
    const list = document.createElement('ol'); list.className = 'recharge-query-list';
    for (const row of candidates.slice(0, auditDisplayed)) {
      const item = document.createElement('li'); item.className = 'recharge-query-item recharge-query-audit-item';
      const recipient = [row.recipientName, row.recipientEmail].filter(Boolean).join(' · ');
      const actor = [row.actorEmail, row.actorId == null ? '' : `ID ${row.actorId}`].filter(Boolean).join(' · ');
      const top = document.createElement('div'); top.className = 'recharge-query-item-top';
      top.append(textNode('strong', `请求操作：${value(row.operation)}`), textNode('span', time(row.at)));
      item.append(top,
        textNode('p', `请求目标：${recipient || '名称未提供'} · 用户 ID ${value(row.recipientId)}`),
        textNode('p', `请求发起账号：${actor || '未提供'}`),
        textNode('p', `请求值：${value(row.requestedValue)}（非已入账金额） · HTTP 状态：${value(row.statusCode)}`),
        textNode('p', `审计 ID ${value(row.id)} · 请求 ID ${value(row.requestId)}`, 'recharge-query-source'));
      if (row.selfCandidate === true) item.append(textNode('p', '管理员自充候选，未经逐笔对账，不计入已确认扣除。', 'recharge-query-self'));
      list.append(item);
    }
    auditRows.append(list);
    if (candidates.length > auditDisplayed) {
      const more = document.createElement('button'); more.type = 'button';
      more.textContent = `再显示 ${Math.min(100, candidates.length - auditDisplayed)} 条审计候选`;
      more.addEventListener('click', () => { auditDisplayed += 100; renderAudit(data); });
      auditRows.append(more);
    }
  }
  async function query(event) {
    event.preventDefault();
    if (busy) return;
    let userId, adminUserId;
    try {
      userId = readId(recipientInput, '收款用户 ID');
      adminUserId = readId(adminInput, '管理员账号用户 ID');
    } catch (error) { setStatus(error.message, 'error'); return; }
    clearResult(); busy = true; runButton.disabled = true;
    const queryGeneration = generation;
    recipientInput.disabled = true; adminInput.disabled = true;
    setStatus(userId ? `正在读取用户 ID ${userId} 的充值记录…` : '正在逐个读取全部用户的充值记录…', 'busy');
    try {
      const reply = await window.groupAdmin.rechargeQuery({ userId, adminUserId });
      if (queryGeneration !== generation) throw new Error('管理员授权状态已变化。');
      if (!reply?.ok) throw new Error(reply?.message || '查询失败。');
      const data = reply.data;
      if (!data || !Array.isArray(data.rows)) throw new Error('平台返回的充值记录格式不完整。');
      result = data; rows = data.rows;
      filter.disabled = false;
      renderSummary(data); renderRows(); renderAudit(data);
      const readCount = Number.isSafeInteger(data.scannedUsers) ? data.scannedUsers : '未知';
      setStatus(data.complete === false ?
        `只读取到 ${readCount} 位用户，结果不完整；下方明细和汇总不能视为全部充值。` :
        `查询完成：读取 ${readCount} 位用户、${rows.length} 笔记录。`,
      data.complete === false ? 'error' : 'success');
      const warnings = [];
      if (!adminUserId) warnings.push('尚未提供管理员账号用户 ID。');
      if (data.operatorAvailable === false) warnings.push('平台充值流水未提供可靠操作人；“谁充的”、管理员自充剔除、给他人净额和小额分类均待确认。');
      if (data.complete === false) warnings.push('本次只得到部分数据，请核对失败原因后重新查询。');
      if (data.auditComplete === false) warnings.push('管理员操作审计候选读取不完整。');
      setWarning(warnings.join(' '));
    } catch (error) {
      clearResult(); setStatus(`充值查询失败：${error.message}`, 'error');
    } finally {
      busy = false; runButton.disabled = false;
      recipientInput.disabled = false; adminInput.disabled = false;
    }
  }
  form.addEventListener('submit', query);
  for (const input of [recipientInput, adminInput]) input.addEventListener('input', () => {
    if (!result || busy) return;
    clearResult(); setStatus('查询条件已修改，请重新查询。');
  });
  filter.addEventListener('input', () => { displayed = 100; renderRows(); });
  window.groupAdmin.rechargeOnProgress(progress => {
    if (!busy || !progress) return;
    const scanned = Number.isSafeInteger(progress.scannedUsers) ? progress.scannedUsers : 0;
    const total = Number.isSafeInteger(progress.totalUsers) ? progress.totalUsers : '未知';
    const found = Array.isArray(progress.rows) ? progress.rows.length :
      Number.isSafeInteger(progress.rows) ? progress.rows : '未知';
    setStatus(`正在读取：已检查 ${scanned} / ${total} 位用户，发现 ${found} 笔记录…`, 'busy');
  });
  window.groupAdmin.onAuth(state => {
    if (!['login', 'expired', 'required', 'storage-error'].includes(state.phase)) return;
    generation++;
    clearResult(); setStatus('管理员授权状态已变化，请重新登录后查询。', 'error');
  });
})();
