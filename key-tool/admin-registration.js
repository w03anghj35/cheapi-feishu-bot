'use strict';
(() => {
  const el = id => document.getElementById('registration-' + id);
  const labels = { pending: '处理中／需核对', unknown: '结果待核对', success: '创建成功', failed: '未创建／明确拒绝', reviewed: '已人工核对（非成功证明）' };
  let page = 1, pages = 1, busy = false, queued = false;
  function cell(...values) {
    const td = document.createElement('td');
    for (const value of values) { const p = document.createElement('p'); p.textContent = String(value); td.append(p); }
    return td;
  }
  async function load() {
    if (busy) { queued = true; return; }
    busy = true; controls();
    try {
      const result = await window.groupAdmin.registrationRecords(page);
      if (!result.ok) throw new Error(result.message);
      const data = result.data; page = data.page; pages = data.pages;
      el('rows').replaceChildren();
      for (const row of data.items) {
        const tr = document.createElement('tr'), status = cell(labels[row.state] || row.state, row.requestId, row.errorCode || '');
        if (['pending', 'unknown'].includes(row.state)) {
          const button = document.createElement('button'); button.textContent = '已去平台核对…'; button.type = 'button';
          button.onclick = async () => {
            if (busy) return;
            busy = true; button.disabled = true; controls();
            try {
              const response = await window.groupAdmin.registrationReview(row.requestId);
              if (!response.ok) throw new Error(response.message);
            } catch (error) { el('notice').textContent = error.message; }
            finally { busy = false; button.disabled = false; controls(); load(); }
          };
          status.append(button);
        }
        tr.append(cell(new Date(row.at).toLocaleString('zh-CN'), row.operator, `授权账户 ${row.owner}`),
          cell(row.email, row.username, `用户 ID ${row.userId || '未取得'}`), cell(`初始余额 ${row.balance}`, `并发 ${row.concurrency}`, '普通用户'), status);
        el('rows').append(tr);
      }
      if (!data.items.length) { const tr = document.createElement('tr'), td = cell('暂无注册记录'); td.colSpan = 4; tr.append(td); el('rows').append(tr); }
      el('notice').textContent = `共 ${data.total} 条 · 待核对 ${data.blocked} 条${data.storageError ? ' · 存储异常，注册已锁定' : ''}。不包含密码。`;
      el('page').textContent = `第 ${page} / ${pages} 页`;
    } catch (error) { el('notice').textContent = error.message; }
    finally { busy = false; controls(); if (queued) { queued = false; load(); } }
  }
  function controls() { el('prev').disabled = busy || page <= 1; el('next').disabled = busy || page >= pages; el('refresh').disabled = busy; }
  el('refresh').onclick = load;
  el('prev').onclick = () => { if (!busy && page > 1) { page--; load(); } };
  el('next').onclick = () => { if (!busy && page < pages) { page++; load(); } };
  window.groupAdmin.onRecordsChanged(load);
  load();
})();
