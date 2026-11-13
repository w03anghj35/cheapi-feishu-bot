'use strict';
(()=>{
  const el=id=>document.getElementById(id);
  let data={items:[],storageError:false},busy=false;
  const statuses={running:'处理中',success:'完成',failure:'失败',interrupted:'中断待核对'};
  const hints={INPUT:'检查名称重复、长度和输入格式。',AUTH:'到管理配置重新核验平台授权。',DENIED:'确认平台管理员权限。',
    POLICY:'检查当前账户、群策略或绑定是否变化。',NETWORK:'检查网络；结果未确认前不要重复提交业务。',HTTP:'核对HTTP状态与平台权限；如涉及业务更新请先核对最终状态。',
    SCHEMA:'平台返回结构或分页变化，重新读取并检查。',STORAGE:'保留本机文件，检查磁盘及权限，不要删除账本。',BUSY:'其他操作尚未完成，等待并查看当前阶段。',
    UNKNOWN:'只读核对平台结果，不自动重试。',KEY_AUTH:'核对受限只读密钥是否有效；原网页登录授权未因此清除。',
    KEY_DENIED:'核对密钥读取权限和允许的出口 IP。',KEY_REQUIRED:'在管理配置核对本机受限只读密钥。',
    RATE_LIMIT:'等待平台限流窗口恢复后再查询。',OPERATION_ERROR:'按操作编号和阶段排查，原始错误已脱敏。'};
  function node(tag,text){const n=document.createElement(tag);n.textContent=text;return n;}
  function render(){
    const table=data.recordTable;
    el('record-table-status').textContent=table?.error|| (table?.updatedAt?`最近更新：${new Date(table.updatedAt).toLocaleString('zh-CN',{hour12:false})} · ${table.rows} 条明细 · ${table.folder}`:'记录表尚未生成。');
    const filter=el('operation-log-filter').value,query=el('operation-log-search').value.trim().toLowerCase();
    const rows=data.items.filter(r=>(filter==='all'||r.status===filter)&&`${r.id} ${r.actionLabel} ${r.stageLabel} ${r.code||''}`.toLowerCase().includes(query));
    el('operation-log-notice').textContent=`显示 ${rows.length} / 最近 ${data.items.length} 条操作。`+(data.storageError?' 日志文件不可写、已达4MB上限或存在损坏；新记录仅在内存中，重启可能丢失。请保留日志原件处理。':'日志已保存到本机，重启后可查看。');
    el('operation-log-rows').replaceChildren();
    if(!rows.length){el('operation-log-rows').append(node('p','暂无符合条件的操作；历史操作不会补造日志。'));return;}
    for(const r of rows){const section=node('article','');section.className='operation-log-entry';section.dataset.status=r.status;
      section.append(node('strong',`${statuses[r.status]||'未知'} · ${r.actionLabel}`));
      section.append(node('p',`${new Date(r.startedAt).toLocaleString('zh-CN',{hour12:false})} · 阶段：${r.stageLabel} · ${r.status==='running'?'已记录耗时':'耗时'} ${(r.durationMs/1000).toFixed(1)} 秒`));
      section.append(node('p',`操作编号：${r.id}${r.code?` · 错误：${r.code}`:''}${r.httpStatus?` · HTTP ${r.httpStatus}`:''}`));
      if(r.status==='interrupted')section.append(node('p','上次程序退出前未记录最终结果；不等于失败，请先检查配置或业务账本。'));
      else if(r.code)section.append(node('p',hints[r.code]||'请结合操作阶段和对应业务记录检查。'));
      el('operation-log-rows').append(section);
    }
  }
  async function refresh(){if(busy)return;busy=true;el('operation-log-refresh').disabled=true;
    try{const response=await window.groupAdmin.operationLog();if(!response.ok)throw new Error(response.message);data=response.data;render();}
    catch(error){el('operation-log-notice').textContent=`日志读取失败：${error.message}`;}
    finally{busy=false;el('operation-log-refresh').disabled=false;}
  }
  el('operation-log-refresh').onclick=refresh;el('operation-log-filter').onchange=render;el('operation-log-search').oninput=render;
  el('record-table-sync').onclick=async()=>{el('record-table-sync').disabled=true;try{const result=await window.groupAdmin.recordTableSync();if(!result.ok)throw new Error(result.message);data.recordTable=result.data;render();}catch(error){el('record-table-status').textContent=error.message;}finally{el('record-table-sync').disabled=false;}};
  el('record-table-open').onclick=async()=>{try{const result=await window.groupAdmin.recordTableOpen();if(!result.ok)throw new Error(result.message);}catch(error){el('record-table-status').textContent=error.message;}};
  window.addEventListener('admin-view-change',event=>{if(event.detail.view==='operation-log')void refresh();});
  setInterval(()=>{if(!document.hidden&&!el('operation-log-title').closest('[data-admin-view]').hidden)void refresh();},3000);
})();
