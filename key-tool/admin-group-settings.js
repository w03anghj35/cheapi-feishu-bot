'use strict';
(() => {
  const el = id => document.getElementById(id);
  let state = null, busy = false, dirty = false, revision = 0;
  const notice = (text, kind='info') => {
    for(const id of ['settings-notice','settings-save-status']){el(id).textContent=text;el(id).dataset.kind=kind;}
  };
  function controls() {
    el('settings-refresh').disabled = busy;
    el('settings-save').disabled = busy || !state?.owner || !state.groups.length;
    for (const input of el('settings-rows').querySelectorAll('input')) input.disabled = busy;
  }
  async function call(method, arg) {
    const result = await window.groupAdmin[method](arg);
    if (!result.ok) throw Object.assign(new Error(result.message),{code:result.code,operationId:result.operationId,logWarning:result.logWarning});
    return result.data;
  }
  function render(next) {
    state = next; dirty = false; el('settings-rows').replaceChildren();
    for (const group of next.groups) {
      const row = document.createElement('div'); row.className = 'catalog-row';
      const original = document.createElement('div'); original.className = 'catalog-original';
      const title = document.createElement('strong'); title.textContent = group.name;
      const meta = document.createElement('p'); meta.className = 'muted';
      meta.textContent = `ID ${group.id} · ${group.exclusive ? '专属分组' : '公开分组'} · ${group.platform} · 默认 ${group.rate}x`;
      original.append(title, meta);
      const label = document.createElement('label'); label.textContent = '菜单显示名称（留空不发布）';
      const input = document.createElement('input'); input.dataset.settingsGroup = group.id; input.value = group.displayName; input.maxLength = 80;
      input.autocomplete = 'off'; input.addEventListener('input', () => { dirty = true; notice('有未保存的倍率分组名称。'); });
      label.append(input); row.append(original, label); el('settings-rows').append(row);
    }
    controls();
  }
  async function catalog(save) {
    if (busy || (save && !state?.owner)) return;
    if (!save && dirty && !confirm('重新读取会放弃未保存的倍率分组名称，是否继续？')) return;
    busy = true; controls();
    const generation=revision,started=Date.now();
    el('settings-save').textContent=save?'正在保存并发布…':'正在读取分组…';
    notice(save?'正在保存并发布，请稍候；请勿重复点击。':'正在读取平台分组，请稍候。','busy');
    const waiting=setInterval(()=>notice(`仍在${save?'保存并发布':'读取分组'}，已等待 ${Math.floor((Date.now()-started)/1000)} 秒。可在“操作日志”查看当前阶段；尚未确认完成，请勿重复提交。`,'busy'),10000);
    try {
      const input = save ? { owner: state.owner, items: Array.from(el('settings-rows').querySelectorAll('input'), i => ({ id: Number(i.dataset.settingsGroup), name: i.value })) } : undefined;
      const response=await window.groupAdmin[save?'groupSettingsSave':'groupSettingsRefresh'](input);
      if(!response.ok)throw Object.assign(new Error(response.message),{code:response.code,operationId:response.operationId,logWarning:response.logWarning});
      if(generation!==revision){notice('授权在操作期间变化，请重新读取；可到操作日志核对结果。','error');return;}
      render(response.data);
      const published=state.groups.filter(g=>g.displayName).length;
      notice((save ? `保存成功：倍率配置分组已发布，共 ${published} 个可用、${state.groups.length-published} 个隐藏。` : `已读取 ${state.groups.length} 个分组，请命名后发布。`)
        +(response.operationId?` 操作编号：${response.operationId}`:'')+(response.logWarning?' 注意：日志持久化异常，本次日志可能仅保留在内存。':''),'success');
    } catch (error) { notice(`${save?'保存失败':'读取失败'}：${error.message}${error.code?`（${error.code}）`:''}${error.operationId?` 操作编号：${error.operationId}`:''}。请查看“操作日志”。`,'error'); }
    finally { clearInterval(waiting);busy = false;el('settings-save').textContent='保存并发布倍率配置分组';controls(); }
  }
  async function records() {
    try {
      const rows = await call('groupSettingsRecords'); el('settings-records').replaceChildren();
      if (!rows.length) { el('settings-records').textContent = '暂无分组设置记录。'; return; }
      const labels = { success: '已回读成功', pending: '待核对', unknown: '结果未知', failed: '未成功', reviewed: '已人工核对（不等于成功）' };
      for (const row of rows) {
        const section = document.createElement('section'); section.className = 'catalog-row';
        const info = document.createElement('p');
        info.textContent = `${row.at} · 用户ID ${row.targetId} · ${labels[row.state]} · 操作编号 ${row.requestId}\n` + row.changes.map(c => `分组ID ${c.groupId}：${c.allowed ? '允许' : '不允许'}，${c.rate === null ? '默认倍率' : c.rate + 'x'}`).join('；');
        section.append(info);
        if (['pending','unknown'].includes(row.state)) for (const [mode,title] of [['readback','仅回读平台核对'],['manual','已人工核对，解除保护']]) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = title;
          button.onclick = async () => { button.disabled = true;
            try { await call('groupSettingsReview', { requestId: row.requestId, mode }); await records(); notice('核对已完成；未重发修改请求。'); }
            catch (error) { notice(error.message); } finally { button.disabled = false; } };
          section.append(button);
        }
        el('settings-records').append(section);
      }
    } catch (error) { notice(error.message); }
  }
  el('settings-refresh').onclick = () => catalog(false);
  el('settings-form').onsubmit = event => { event.preventDefault(); catalog(true); };
  el('settings-records-refresh').onclick = records;
  window.groupAdmin.onAuth(next => {
    if (state && ((next.owner !== undefined && next.owner !== state.owner) || ['login','expired','required','storage-error'].includes(next.phase))) {
      revision++;state = null; dirty = false; el('settings-rows').replaceChildren(); el('settings-records').replaceChildren(); controls();
      notice('授权已变化，请重新读取倍率分组。');
    }
  });
})();
