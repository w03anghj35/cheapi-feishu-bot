'use strict';
(() => {
  const el = id => document.getElementById(id);
  let snapshot = null, selected = new Set(), selectedProfile = '', busy = false, dirty = false,
    generation = 0, draftTimer = null, draftRevision = 0, draftTail = Promise.resolve();
  const notice = (value, kind = 'info') => { el('ownership-notice').textContent = value; el('ownership-notice').dataset.kind = kind; };
  const draftNotice = value => { el('ownership-draft-status').textContent = value; };
  const current = () => snapshot?.profiles.find(row => row.name === el('ownership-profile').value);
  const missingName = value => /^飞书用户#[a-f0-9]{12,20}$/.test(value || '');
  const memberLabel = row => row.currentFeishuName ? `${row.currentFeishuName}（当前群显示名）` :
    missingName(row.name) ? '飞书姓名未取得' : `${row.name}（登记时姓名）`;
  function memberNameHint() {
    const reason = snapshot?.nameState?.reason;
    if (reason === 'permission') return ' 当前群成员姓名读取被拒绝：请确认应用“查看群成员”权限已开通并发布、机器人仍在目标群；此前请让成员转述机器人私聊的身份摘要核对。';
    if (reason === 'unavailable') return ' 飞书未连接或目标群未就绪，暂不能同步当前群显示名；可用私聊身份摘要核对。';
    if (reason === 'loading') return ' 群成员姓名仍在读取，稍后再次点击“读取平台用户与查询申请”。';
    if (['failed','limit'].includes(reason)) return ' 群成员姓名读取未完成，请稍后重试；不要按截图顺序猜身份。';
    const unresolved = snapshot?.identities.filter(row => missingName(row.name) && !row.currentFeishuName).length || 0;
    return unresolved ? ` 其中 ${unresolved} 位尚无当前群显示名，请让本人转述机器人私聊的身份摘要核对。` : '';
  }
  function controls() {
    el('ownership-refresh').disabled = busy;
    el('ownership-save').disabled = busy || !snapshot || !el('ownership-name').value.trim();
    el('ownership-client-add').disabled = busy || !snapshot?.profiles.length ||
      !el('ownership-client-add-owner').value || !el('ownership-client-add-user').value;
    for (const button of el('ownership-client-rows').querySelectorAll('button,select')) button.disabled = busy;
    const identity = snapshot?.identities.find(row => row.identity === el('ownership-identity').value);
    el('ownership-link-save').disabled = busy || !identity || !['pending','linked'].includes(identity.state) ||
      !snapshot.profiles.some(row => row.name === el('ownership-link-profile').value);
  }
  function fillOwners(select, emptyLabel, preferred) {
    const old = preferred ?? select.value; select.replaceChildren();
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = emptyLabel; select.append(empty);
    for (const row of snapshot?.profiles || []) {
      const option = document.createElement('option'); option.value = row.name;
      option.textContent = `${row.name}（${row.userIds.length} 个客户）`; select.append(option);
    }
    if (snapshot?.profiles.some(row => row.name === old)) select.value = old;
  }
  function renderClients() {
    fillOwners(el('ownership-client-filter'), '全部归属人');
    fillOwners(el('ownership-client-add-owner'), '选择归属人');
    const term = el('ownership-client-search').value.trim().toLocaleLowerCase();
    const owner = el('ownership-client-filter').value;
    const users = new Map((snapshot?.users || []).map(u => [u.id, u]));
    const clients = snapshot?.clients || (snapshot?.profiles || []).flatMap(p => p.userIds.map(id => ({ name:p.name,id })));
    const visible = clients.filter(row => (!owner || row.name === owner) &&
      (!term || [row.name, row.email || '', String(row.id), users.get(row.id)?.email || '', users.get(row.id)?.username || ''].some(s => s.toLocaleLowerCase().includes(term))));
    const add = el('ownership-client-add-user'), old = add.value; add.replaceChildren();
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = '选择平台客户'; add.append(empty);
    for (const user of snapshot?.users || []) {
      if (user.role !== 'user' || (term && ![user.email, user.username || '', String(user.id)]
        .some(value => value.toLocaleLowerCase().includes(term)))) continue;
      const option = document.createElement('option'); option.value = String(user.id);
      option.textContent = `${user.email} · ${user.username || '客户'} · ID ${user.id}`; add.append(option);
    }
    if ([...add.options].some(option => option.value === old)) add.value = old;
    const body = el('ownership-client-rows'); body.replaceChildren();
    for (const row of visible) {
      const tr = document.createElement('tr');
      const cell = value => { const td = document.createElement('td'); td.textContent = value; tr.append(td); return td; };
      cell(row.name);
      const user = users.get(row.id);
      cell(`${user?.username || '客户'} · ${user?.email || row.email || '邮箱待同步'} · ID ${row.id}`);
      cell(row.since || '旧归属：起始日未记录');
      const actions = cell('');
      const select = document.createElement('select'); select.setAttribute('aria-label', `修改用户 ${row.id} 的归属`);
      fillOwners(select, '选择新的归属人', ''); actions.append(select);
      const button = (text, fn) => { const b = document.createElement('button'); b.type='button'; b.textContent=text; b.onclick=fn; actions.append(b); };
      button('修改归属', () => {
        if (!select.value || select.value === row.name) { el('ownership-client-status').textContent='请选择不同的归属人。'; return; }
        if (confirm(`将客户 ID ${row.id} 从“${row.name}”转给“${select.value}”？北京时间今天生效，之前的用量仍属于原归属人。`))
          void changeClient({ action:'move',name:row.name,userId:row.id,targetName:select.value });
      });
      button('移除客户', () => {
        if (confirm(`从“${row.name}”移除客户 ID ${row.id}？只解除归属，不删除平台账号。今天及以后不计入，之前的表保留。`))
          void changeClient({ action:'remove',name:row.name,userId:row.id });
      });
      button('查看用量', () => window.dispatchEvent(new CustomEvent('ownership-view-usage', {detail:{name:row.name}})));
      body.append(tr);
    }
    if (!visible.length) { const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=4;td.textContent='没有匹配的已保存客户。';tr.append(td);body.append(tr); }
    el('ownership-client-summary').textContent=`共 ${clients.length} 条客户归属，当前显示 ${visible.length} 条。`;
    controls();
  }
  async function changeClient(input) {
    if (busy || !snapshot) return;
    if (dirty) { el('ownership-client-status').textContent='下方有未保存的归属草稿，请先保存或重新读取后再修改客户表。'; return; }
    busy=true;controls();el('ownership-client-status').textContent='正在核对并保存客户归属…';
    try {
      const reply=await window.groupAdmin.userOwnershipClientChange({...input,revision:snapshot.revision});
      if(!reply.ok)throw Error(reply.message);
      Object.assign(snapshot,reply.data);renderProfiles(selectedProfile);choose();renderClients();renderChanges();
      clearTimeout(draftTimer); draftTimer=null; draftRevision++;
      const cleared=await draftTail.then(()=>window.groupAdmin.userOwnershipDraftSave(null));
      draftNotice(cleared.ok?'客户表已保存，旧草稿已清除。':'客户表已保存，但旧草稿未清除；下次重开以正式客户表为准。');
      el('ownership-client-status').textContent=`已保存，生效日期：${reply.data.effectiveDay}（北京时间）。当前用量表已联动，历史记录保留。`;
    } catch(error) {el('ownership-client-status').textContent=`未保存：${error.message}`;}
    finally {busy=false;controls();}
  }
  function captureDraft() { return { profile: el('ownership-profile').value, name: el('ownership-name').value,
    search: el('ownership-search').value, userIds: [...selected] }; }
  async function persistDraft() {
    if (!snapshot) return false;
    const revision = draftRevision, value = captureDraft();
    try {
      const pending = draftTail.then(() => window.groupAdmin.userOwnershipDraftSave(value));
      draftTail = pending.catch(() => {});
      const result = await pending;
      if (!result.ok) throw new Error(result.message);
      if (revision === draftRevision) draftNotice('未保存的姓名、搜索词和勾选已加密暂存到本机。');
      return true;
    } catch {
      draftNotice('草稿暂存失败：请保持此窗口打开，先不要重启或刷新。');
      return false;
    }
  }
  function scheduleDraft() {
    if (!snapshot) return;
    draftRevision++;
    clearTimeout(draftTimer);
    draftNotice('草稿待安全暂存；暂勿关闭窗口。');
    draftTimer = setTimeout(() => { draftTimer = null; void persistDraft(); }, 350);
  }
  function renderUsers() {
    const term = el('ownership-search').value.trim().toLocaleLowerCase();
    const rows = snapshot?.users.filter(u => u.role === 'user' &&
      (!term || [String(u.id), u.username, u.email].some(v => v.toLocaleLowerCase().includes(term)))) || [];
    const wrap = el('ownership-users'); wrap.replaceChildren();
    for (const u of rows) {
      const label = document.createElement('label'); label.className = 'ownership-user';
      const box = document.createElement('input'); box.type = 'checkbox'; box.checked = selected.has(u.id);
      box.addEventListener('change', () => { box.checked ? selected.add(u.id) : selected.delete(u.id); dirty = true; summary(rows.length); scheduleDraft(); });
      const info = document.createElement('span');
      info.textContent = `${u.username || '未填写用户名'} · ${u.email} · ID ${u.id} · 余额 ${u.balance} · ${u.status === 'active' ? '启用' : '未启用'}`;
      label.append(box, info); wrap.append(label);
    }
    if (!rows.length) wrap.textContent = '没有匹配的平台普通用户。';
    summary(rows.length);
  }
  function summary(visible) {
    el('ownership-summary').textContent = `显示 ${visible} 个用户；已勾选 ${selected.size} 个（包括当前搜索结果之外的勾选）。`;
  }
  function renderQueries() {
    const root = el('ownership-query-rows'); root.replaceChildren();
    const queries = snapshot?.queries || [];
    if (!queries.length) { root.textContent = '暂无查询记录。'; return; }
    for (const row of queries) {
      const line = document.createElement('p');
      const usageQuery = ['usage','usage-all'].includes(row.kind);
      const outcome = usageQuery ?
        ({ found: `已读取 ${row.count} 个账号（不代表私聊送达）`, 'not-found': '身份未绑定', error: '读取失败' }[row.status] || '状态未知') :
        ({ found: `查到 ${row.count} 个用户`, 'not-found': '姓名未找到', error: '查询失败' }[row.status] || '状态未知');
      line.textContent = `${new Date(row.at).toLocaleString('zh-CN', { hour12: false })} · ${row.actorName}（身份 ${row.identity.slice(0, 12)}）· ${row.kind === 'usage-all' ? '管理员全部用量查询' : usageQuery ? '用量查询' : '余额查询'} ${row.name} · ${outcome}`;
      root.append(line);
    }
  }
  function renderChanges() {
    const root = el('ownership-change-rows'); root.replaceChildren();
    const changes = snapshot?.changes || [];
    if (!changes.length) { root.textContent = '暂无归属修改记录。'; return; }
    for (const row of changes) {
      const line = document.createElement('p');
      const at = row.at ? new Date(row.at).toLocaleString('zh-CN', { hour12: false }) : '旧记录时间未知';
      line.textContent = `${at} · ${row.name} · ${row.state === 'profile' ? '姓名档案' :
        row.state === 'linked' ? `已绑定 ${row.profileName}` : '飞书成员归属'} · ${row.userIds.length} 个平台用户${row.identity ? ` · 身份 ${row.identity.slice(0, 12)}` : ''}`;
      root.append(line);
    }
  }
  function choose() {
    const row = current(); selected = new Set(row?.userIds || []); dirty = false;
    selectedProfile = row?.name || '';
    el('ownership-name').value = row?.name || ''; el('ownership-name').readOnly = !!row;
    renderUsers(); controls();
  }
  function renderProfiles(preferred = '') {
    const select = el('ownership-profile'); select.replaceChildren();
    const fresh = document.createElement('option'); fresh.value = ''; fresh.textContent = '新建归属姓名'; select.append(fresh);
    for (const row of snapshot.profiles || []) {
      const option = document.createElement('option'); option.value = row.name;
      option.textContent = `${row.name} · 已归属 ${row.userIds.length} 个平台用户`;
      select.append(option);
    }
    if ((snapshot.profiles || []).some(row => row.name === preferred)) select.value = preferred;
    const binding = el('ownership-link-profile'), selected = binding.value;
    binding.replaceChildren();
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = '请选择已保存的姓名档案'; binding.append(empty);
    for (const row of snapshot.profiles || []) {
      const option = document.createElement('option'); option.value = row.name;
      option.textContent = `${row.name} · ${row.userIds.length} 个平台用户`; binding.append(option);
    }
    if ((snapshot.profiles || []).some(row => row.name === selected)) binding.value = selected;
  }
  function renderIdentities(preferred = '') {
    const select = el('ownership-identity'); select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = '';
    placeholder.textContent = '请选择已登记成员核对'; select.append(placeholder);
    for (const row of snapshot.identities) {
      const option = document.createElement('option'); option.value = row.identity;
      option.textContent = `${memberLabel(row)} · 身份 ${row.identity.slice(0, 12)} · ${row.state === 'linked' ?
        `已绑定 ${row.profileName}` : row.state === 'assigned' ? '旧式身份归属' : '待管理员核对'}`;
      select.append(option);
    }
    if (snapshot.identities.some(row => row.identity === preferred)) select.value = preferred;
    const currentIdentity = snapshot.identities.find(row => row.identity === select.value);
    el('ownership-link-profile').value = currentIdentity?.state === 'linked' ? currentIdentity.profileName : '';
    controls();
  }
  function applyDraft(restored) {
    el('ownership-profile').value = (snapshot.profiles || []).some(row => row.name === restored.profile) ? restored.profile : '';
    selectedProfile = el('ownership-profile').value;
    el('ownership-name').value = restored.name; el('ownership-name').readOnly = !!selectedProfile;
    el('ownership-search').value = restored.search;
    selected = new Set(restored.userIds); dirty = true; renderUsers(); controls();
  }
  async function refresh() {
    if (busy) return;
    const localDraft = dirty ? captureDraft() : null;
    if (dirty) {
      clearTimeout(draftTimer); draftTimer = null;
      if (!await persistDraft()) return;
    }
    busy = true; controls(); notice('正在读取平台用户和查询申请…', 'busy');
    const revision = generation;
    try {
      const reply = await window.groupAdmin.userOwnershipList();
      if (!reply.ok) throw new Error(reply.message);
      if (revision !== generation) return;
      snapshot = reply.data;
      renderClients();
      renderProfiles(selectedProfile);
      renderIdentities(el('ownership-identity').value);
      choose(); renderQueries(); renderChanges();
      const draft = await window.groupAdmin.userOwnershipDraftState();
      if (!draft.ok) throw new Error(draft.message);
      if (draft.data && revision === generation) {
        applyDraft(draft.data);
        draftNotice('已恢复上次加密暂存的姓名、搜索词和勾选；请核对后正式保存。');
      } else draftNotice('当前没有待恢复草稿。');
      notice(`已读取 ${snapshot.users.length} 个平台用户、${(snapshot.profiles || []).length} 个姓名档案、${snapshot.identities.length} 个已登记飞书身份。${memberNameHint()}`, 'success');
    } catch (error) {
      if (localDraft && snapshot) applyDraft(localDraft);
      notice(`读取失败：${error.message}`, 'error');
    }
    finally { busy = false; controls(); }
  }
  async function save() {
    if (busy || !snapshot || !el('ownership-name').value.trim()) return;
    busy = true; controls();
    for (const input of el('user-ownership').querySelectorAll('input,select')) input.disabled = true;
    clearTimeout(draftTimer); draftTimer = null;
    try {
      if (!await persistDraft()) return;
      notice('正在核对平台用户并保存归属…', 'busy');
      const name = el('ownership-name').value.trim();
      const reply = await window.groupAdmin.userOwnershipSaveName({ name, userIds: [...selected] });
      if (!reply.ok) throw new Error(reply.message);
      snapshot.profiles = reply.data.profiles; snapshot.identities = reply.data.identities;
      snapshot.clients = reply.data.clients; snapshot.revision = reply.data.revision; renderClients();
      snapshot.changes = reply.data.changes; renderChanges();
      renderProfiles(name); selectedProfile = name; el('ownership-name').readOnly = true; dirty = false;
      notice(`归属已保存：${name} · ${selected.size} 个平台用户。请在上方核对飞书成员身份并绑定；绑定后点“用户查询”无需输入姓名。`, 'success');
      const cleared = await draftTail.then(() => window.groupAdmin.userOwnershipDraftSave(null));
      draftNotice(cleared.ok ? '归属已正式保存，待保存草稿已清除。' :
        '归属已正式保存，但草稿标记未清除；下次重开请以正式档案为准。');
    } catch (error) { notice(`保存失败：${error.message}`, 'error'); }
    finally {
      for (const input of el('user-ownership').querySelectorAll('input,select')) input.disabled = false;
      busy = false; controls();
    }
  }
  async function link() {
    if (busy || !snapshot) return;
    const identity = snapshot.identities.find(row => row.identity === el('ownership-identity').value);
    const profileName = el('ownership-link-profile').value;
    if (!identity || !snapshot.profiles.some(row => row.name === profileName)) return;
    if (!confirm(`已通过可信渠道核对飞书成员“${memberLabel(identity)}”及身份摘要 ${identity.identity.slice(0, 12)}，确认绑定到“${profileName}”吗？显示名相同不能代替身份核对。`)) return;
    busy = true; controls(); el('ownership-link-notice').textContent = '正在核对管理员身份并加密保存绑定…';
    try {
      const reply = await window.groupAdmin.userOwnershipLink({ identity: identity.identity, profileName });
      if (!reply.ok) throw new Error(reply.message);
      snapshot.identities = reply.data.identities; snapshot.changes = reply.data.changes;
      snapshot.revision = reply.data.revision; snapshot.clients = reply.data.clients; renderClients();
      renderIdentities(identity.identity); renderChanges();
      el('ownership-link-notice').textContent = `已绑定：${memberLabel(identity)} → ${profileName}。该成员从指定群重新进入后，点击“用户查询”即可直接查看。`;
      if (reply.logWarning) el('ownership-link-notice').textContent += ' 管理操作日志未能持久保存，请保留归属记录文件检查。';
    } catch (error) { el('ownership-link-notice').textContent = `绑定失败：${error.message}`; }
    finally { busy = false; controls(); }
  }
  el('ownership-refresh').addEventListener('click', refresh);
  el('ownership-client-filter').addEventListener('change',renderClients);
  el('ownership-client-search').addEventListener('input',renderClients);
  el('ownership-client-add-owner').addEventListener('change', controls);
  el('ownership-client-add-user').addEventListener('change', controls);
  el('ownership-client-add-form').addEventListener('submit',event=>{event.preventDefault();void changeClient({action:'add',name:el('ownership-client-add-owner').value,userId:Number(el('ownership-client-add-user').value)});});
  el('ownership-save').addEventListener('click', save);
  el('ownership-link-save').addEventListener('click', link);
  el('ownership-identity').addEventListener('change', () => {
    const row = snapshot?.identities.find(item => item.identity === el('ownership-identity').value);
    el('ownership-link-profile').value = row?.state === 'linked' ? row.profileName : '';
    el('ownership-link-notice').textContent = row ? `飞书成员：${memberLabel(row)}；身份摘要：${row.identity.slice(0, 12)}。请让本人出示机器人私聊里的同一摘要，核对后再选择姓名档案；显示名相同不能证明是同一人。` : '请先核对成员身份，再绑定；不会凭同名自动匹配。';
    controls();
  });
  el('ownership-link-profile').addEventListener('change', controls);
  el('ownership-profile').addEventListener('change', () => {
    if (dirty && !confirm('切换归属档案将放弃未保存的勾选，是否继续？')) { el('ownership-profile').value = selectedProfile; return; }
    choose(); scheduleDraft();
  });
  el('ownership-search').addEventListener('input', () => { renderUsers(); scheduleDraft(); });
  el('ownership-name').addEventListener('input', () => { dirty = true; controls(); scheduleDraft(); });
  window.addEventListener('admin-view-change', event => {
    if(event.detail?.view==='user-ownership' && !snapshot && !busy)void refresh();
  });
  window.groupAdmin.onAuth(() => { generation++; clearTimeout(draftTimer); draftTimer = null; snapshot = null; selected.clear(); el('ownership-users').replaceChildren(); el('ownership-query-rows').replaceChildren(); el('ownership-change-rows').replaceChildren(); renderClients(); controls(); notice('授权可能已变化，请重新读取。'); });
})();
