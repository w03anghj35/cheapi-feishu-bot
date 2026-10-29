'use strict';
(() => {
  const el = id => document.getElementById(id);
  const labels = { pending: '处理中', unknown: '结果待核对', success: '创建成功', failed: '明确拒绝', reviewed: '已人工核对 · 非成功证明' };
  const kinds = { create: '开始创建', 'create-result': '创建返回', 'create-error': '创建异常', reconcile: '只读核对成功', 'manual-review': '人工确认解除保护', 'admin-reveal': '本机管理员显示密钥', 'admin-copy': '本机管理员复制密钥' };
  const dates = v => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '未记录';
  let page = 1, pages = 1, selected = null, listBusy = false, detailBusy = false, timer, queued = false, detailVersion = 0, secretVersion = 0, filterVersion = 0;
  let filter = { search: '', status: '' };
  function message(text, error = false) { el('history-notice').textContent = text; el('history-notice').classList.toggle('error', error); }
  async function call(name, ...args) {
    const res = await window.groupAdmin[name](...args);
    if (!res.ok) throw new Error(res.message);
    return res.data;
  }
  function controls() {
    el('history-prev').disabled = listBusy || page <= 1; el('history-next').disabled = listBusy || page >= pages;
    el('history-refresh').disabled = listBusy;
    el('history-reveal').disabled = detailBusy || !selected?.hasSecret; el('history-copy').disabled = detailBusy || !selected?.hasSecret;
  }
  function text(tag, value, cls) { const n = document.createElement(tag); n.textContent = value; if (cls) n.className = cls; return n; }
  function hideKey() { secretVersion++; el('history-key').value = ''; el('history-key').type = 'password'; el('history-reveal').textContent = '显示密钥'; }
  function fields(r) {
    el('history-fields').replaceChildren();
    const values = [ ['操作人／客户账号', r.operator.name || '未记录（旧记录）'], ['身份来源', r.operator.source === 'self-reported' ? '手动填写 · 未核验' : '未记录'],
      ['授权平台账户 ID', r.owner ?? '未记录'], ['操作编号', r.requestId], ['创建时间', dates(r.at)], ['最后更新', dates(r.updatedAt)],
      ['创建状态', labels[r.state] || r.state], ['令牌名称（平台提交值）', r.name], ['令牌 ID', r.keyId ?? '未取得／旧记录未缓存'], ['令牌标识', r.maskedKey],
      ['客户分组（创建时）', r.group.customerName ?? '未记录'], ['原始分组（创建时）', r.group.originalName ?? '未记录'], ['分组 ID', r.group.id ?? '未记录'],
      ['平台类型／倍率（创建时）', `${r.group.platform || '未记录'} / ${r.group.rate ?? '未记录'}`], ['设置额度（平台单位）', r.quota ?? '未记录'],
      ['请求有效期', r.days == null ? '平台默认（未指定天数）' : `${r.days} 天`], ['发送情况', ({ possible: '可能发送（中断时需核对）', attempted: '已进入请求适配器（不证明平台已创建）', 'not-sent': '请求未发送' })[r.submission] || '旧记录未记录'],
      ['错误类别', r.errorCode || '无／未记录'] ];
    for (const [k, v] of values) el('history-fields').append(text('dt', k), text('dd', String(v)));
    el('history-events').replaceChildren();
    for (const e of r.events) el('history-events').append(text('li', `${dates(e.at)} · ${kinds[e.kind] || e.kind} · ${labels[e.state] || e.state}${e.code ? ' · ' + e.code : ''}`));
    if (!r.events.length) el('history-events').append(text('li', '旧记录未保存操作过程，不补猜。'));
  }
  async function openDetail(id) {
    const version = ++detailVersion; hideKey(); selected = null; detailBusy = true; controls();
    el('history-detail').hidden = false; el('history-fields').replaceChildren(text('dd', '正在读取…')); el('history-events').replaceChildren();
    try {
      const r = await call('record', id);
      if (version !== detailVersion) return;
      selected = r; fields(r); message('详情来自本机记录；设置额度不代表实际消费或剩余额度。');
    } catch (e) { if (version === detailVersion) message(e.message, true); }
    finally { if (version === detailVersion) { detailBusy = false; controls(); } }
  }
  async function load() {
    if (listBusy) { queued = true; return; }
    const version = filterVersion;
    listBusy = true; controls();
    try {
      const data = await call('records', { ...filter, page, pageSize: 20 });
      if (version !== filterVersion) return;
      page = data.page; pages = data.pages;
      el('history-rows').replaceChildren();
      for (const r of data.items) {
        const tr = document.createElement('tr'), a = document.createElement('td'), b = document.createElement('td'), c = document.createElement('td'), d = document.createElement('td');
        a.append(text('strong', r.operator.name || '操作人未记录'), text('p', dates(r.at), 'muted'), text('p', `授权账户 ID ${r.owner ?? '未记录'} · ${r.operator.source === 'self-reported' ? '手填未核验' : '旧记录'}`, 'muted'));
        b.append(text('strong', r.group.customerName ?? '客户名称未记录'), text('p', `${r.group.originalName ?? '原始名称未记录'} · ID ${r.group.id ?? '—'}`, 'muted'));
        c.append(text('strong', `额度 ${r.quota ?? '—'}`), text('p', `Key ID ${r.keyId ?? '未取得'} · ${r.maskedKey}`, 'muted'), text('p', r.name, 'muted'));
        const badge = text('span', labels[r.state] || r.state, 'history-state'); badge.dataset.state = r.state;
        const button = text('button', '查看详情'); button.type = 'button'; button.dataset.recordId = r.requestId; button.onclick = () => openDetail(r.requestId);
        d.append(badge, button); tr.append(a, b, c, d); el('history-rows').append(tr);
      }
      if (!data.items.length) { const tr = document.createElement('tr'), td = text('td', '暂无符合条件的创建记录。'); td.colSpan = 4; tr.append(td); el('history-rows').append(tr); }
      el('history-summary').textContent = `当前筛选 ${data.total} 条 · 成功 ${data.counts.success} · 待核对 ${data.counts.pending + data.counts.unknown} · 明确拒绝 ${data.counts.failed} · 人工核对 ${data.counts.reviewed}`;
      el('history-page').textContent = `第 ${page} / ${pages} 页 · 每页 20 条`;
      message('本机记录已更新。旧记录缺失的操作人和历史分组名称不会补猜。');
    } catch (e) { if (version === filterVersion) message(e.message, true); }
    finally { listBusy = false; controls(); if (queued) { queued = false; schedule(); } }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(load, 120); }
  el('history-filter').onsubmit = e => { e.preventDefault(); filterVersion++; filter = { search: el('history-search').value, status: el('history-status').value }; page = 1; load(); };
  el('history-refresh').onclick = load;
  el('history-prev').onclick = () => { if (!listBusy && page > 1) { page--; load(); } };
  el('history-next').onclick = () => { if (!listBusy && page < pages) { page++; load(); } };
  el('history-close').onclick = () => { detailVersion++; selected = null; detailBusy = false; hideKey(); el('history-detail').hidden = true; controls(); };
  async function secret(action) {
    if (detailBusy || !selected?.hasSecret) return;
    if (action === 'secret' && el('history-key').value) { hideKey(); return; }
    if (!confirm(action === 'secret' ? '显示此令牌的完整密钥？请确认周围无人旁观。' : '复制此令牌密钥到剪贴板？60 秒后自动清除本工具写入的内容。')) return;
    const id = selected.requestId, version = detailVersion, visibility = secretVersion; detailBusy = true; controls();
    try {
      const value = await call(action, id);
      if (version !== detailVersion) return;
      if (action === 'secret' && visibility === secretVersion && document.hasFocus()) { el('history-key').value = value; el('history-key').type = 'text'; el('history-reveal').textContent = '隐藏密钥'; }
      const latest = await call('record', id);
      if (version !== detailVersion) return;
      selected = latest; fields(selected); message(action === 'secret' ? (el('history-key').value ? '密钥已显示，查看动作已记录。' : '查看动作已记录；窗口失焦或已隐藏，密钥保持隐藏。') : '密钥已复制，复制动作已记录。');
    } catch (e) { if (version === detailVersion) { hideKey(); message(e.message, true); } }
    finally { if (version === detailVersion) { detailBusy = false; controls(); } }
  }
  el('history-reveal').onclick = () => secret('secret'); el('history-copy').onclick = () => secret('copySecret');
  window.addEventListener('blur', hideKey);
  window.groupAdmin.onRecordsChanged(schedule);
  load();
})();
