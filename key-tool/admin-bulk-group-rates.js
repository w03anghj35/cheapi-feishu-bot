'use strict';
(() => {
  const el = id => document.getElementById(id);
  const refreshButton = el('bulk-rates-refresh');
  const groupList = el('bulk-rates-group-list');
  const userSearch = el('bulk-rates-user-search');
  const userList = el('bulk-rates-user-list');
  const selectAllButton = el('bulk-rates-select-all');
  const importButton = el('bulk-rates-import');
  const importStatus = el('bulk-rates-import-status');
  const importPreview = el('bulk-rates-import-preview');
  const importSelect = el('bulk-rates-import-select');
  const importDeselect = el('bulk-rates-import-deselect');
  const direction = el('bulk-rates-direction');
  const amount = el('bulk-rates-amount');
  const previewButton = el('bulk-rates-preview');
  const previewList = el('bulk-rates-preview-list');
  const commitButton = el('bulk-rates-commit');
  const notice = el('bulk-rates-notice');
  const selectionSummary = el('bulk-rates-selection-summary');
  const result = el('bulk-rates-result');
  const recordsRefreshButton = el('bulk-rates-records-refresh');
  const recordsList = el('bulk-rates-records');
  const recordsStatus = el('bulk-rates-records-status');
  let snapshot = null, preview = null, busy = false, generation = 0;
  let recordsBusy = false, recordsGeneration = 0;
  let previewShown = 0;
  let selectedGroups = new Set(), selectedUsers = new Set();
  let imported = null, pendingRestore = null;
  const say = (node, message, kind = 'info') => {
    node.textContent = message; node.dataset.kind = kind;
  };
  const rateLabel = value => {
    const rate = typeof value === 'string' && /^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/.test(value) ? Number(value) : value;
    return typeof rate === 'number' && Number.isFinite(rate) ?
      `${Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}x` : '倍率待核对';
  };
  function controls() {
    refreshButton.disabled = busy;
    userSearch.disabled = busy || !snapshot;
    selectAllButton.disabled = busy || !snapshot?.users?.length;
    importButton.disabled = busy || !snapshot?.users?.length;
    const approved = imported && [...importPreview.querySelectorAll('input[type="checkbox"]:checked')].length;
    importSelect.disabled = busy || !approved || !snapshot;
    importDeselect.disabled = busy || !approved || !snapshot;
    direction.disabled = busy || !snapshot;
    amount.disabled = busy || !snapshot;
    for (const input of [...groupList.querySelectorAll('input'), ...userList.querySelectorAll('input')]) input.disabled = busy;
    previewButton.disabled = busy || !snapshot || snapshot.blocked === true || !selectedGroups.size || !selectedUsers.size ||
      !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/.test(amount.value.trim()) || Number(amount.value.trim()) <= 0;
    commitButton.disabled = busy || !preview?.previewId || !preview.changes?.length;
    recordsRefreshButton.disabled = busy || recordsBusy;
  }
  function invalidatePreview() {
    preview = null; previewShown = 0; previewList.replaceChildren(); commitButton.disabled = true;
    say(result, '选择或调整幅度已变化，请重新预览；尚未修改任何用户倍率。');
    controls();
  }
  function clearImport(message = '请先读取当前用户目录，再选择名单文件。') {
    imported = null; importPreview.replaceChildren(); importPreview.hidden = true;
    say(importStatus, message); controls();
  }
  function matchImported(entries) {
    const byEmail = new Map();
    for (const user of snapshot.users) {
      const key = String(user.email || '').trim().toLowerCase();
      if (!key) continue;
      const same = byEmail.get(key) || []; same.push(user); byEmail.set(key, same);
    }
    const matches = [], missing = [], ambiguous = [], seen = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.email !== 'string' || entry.email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email)) throw Error('文档中的邮箱格式无效。');
      const email = entry.email.trim(), candidates = byEmail.get(email.toLowerCase()) || [];
      if (seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      if (candidates.length === 1) matches.push({ user: candidates[0], email });
      else (candidates.length ? ambiguous : missing).push(email);
    }
    return { matches, missing, ambiguous };
  }
  async function readImport() {
    if (busy || !snapshot) return;
    clearImport('正在读取文档；此步骤不会改变勾选或客户价格。');
    busy = true; controls(); const serial = generation;
    try {
      const reply = await window.groupAdmin.bulkGroupRatesImport();
      if (serial !== generation || !snapshot) return;
      if (!reply?.ok) throw Error(reply?.message || '文档读取失败。');
      if (reply.data?.canceled) { say(importStatus, '已取消读取；原勾选未变。'); return; }
      if (!Array.isArray(reply.data?.entries) || reply.data.entries.length > 5000)
        throw Error('文档识别结果不完整。');
      const { matches, missing, ambiguous } = matchImported(reply.data.entries);
      importPreview.replaceChildren(); importPreview.hidden = !matches.length;
      const heading = document.createElement('p'); heading.textContent = '请核对下列邮箱；不需要操作的可取消左侧勾选。';
      importPreview.append(heading);
      for (const { user, email } of matches) {
        const line = document.createElement('label');
        const box = document.createElement('input'); box.type = 'checkbox'; box.value = String(user.id);
        box.checked = reply.data.needsReview !== true;
        box.addEventListener('change', controls);
        const text = document.createElement('span'); text.textContent = `${email} → ${user.username || '未填写用户名'} · ID ${user.id}`;
        line.append(box, text); importPreview.append(line);
      }
      const issue = document.createElement('p');
      issue.textContent = `未找到 ${missing.length} 个、重复邮箱无法唯一定位 ${ambiguous.length} 个。` +
        (missing.length ? ` 未找到：${missing.slice(0, 20).join('、')}${missing.length > 20 ? '…' : ''}。` : '') +
        (ambiguous.length ? ` 重复：${ambiguous.slice(0, 20).join('、')}${ambiguous.length > 20 ? '…' : ''}。` : '');
      importPreview.append(issue);
      imported = { ids: matches.map(row => row.user.id), owner: snapshot.owner, serial };
      say(importStatus, `识别到 ${reply.data.entries.length} 个邮箱，精确匹配 ${matches.length} 位当前活跃用户。` +
        (reply.data.needsReview === true ? ' 此格式的识别仅供参考，请逐项勾选确认匹配邮箱。' : '') +
        ` ${selectedUsers.size === snapshot.users.length ? '当前已全选，可点击“取消勾选文档中的用户”。' : '当前未全选，可点击“勾选文档中的用户”。'}` +
        ' 请先核对名单；尚未改变勾选和价格。', matches.length ? 'success' : 'error');
    } catch (error) { say(importStatus, `读取失败：${error.message} 原勾选未变。`, 'error'); }
    finally { busy = false; controls(); }
  }
  function applyImport(select) {
    if (busy || !snapshot || !imported || imported.serial !== generation || imported.owner !== snapshot.owner) return;
    const checked = [...importPreview.querySelectorAll('input[type="checkbox"]:checked')]
      .map(box => Number(box.value));
    const allowed = new Set(imported.ids);
    const ids = [...new Set(checked.filter(id => allowed.has(id)))];
    if (!ids.length) { say(importStatus, '没有待操作的已核对用户；原勾选未变。'); return; }
    for (const id of ids) { if (select) selectedUsers.add(id); else selectedUsers.delete(id); }
    invalidatePreview(); renderUsers();
    say(importStatus, `已${select ? '勾选' : '取消勾选'}文档中核对的 ${ids.length} 位用户；未提交价格，请重新预览。`, 'success');
  }
  function renderGroups() {
    groupList.replaceChildren();
    const groups = snapshot?.groups || [];
    if (!groups.length) { groupList.textContent = '平台当前没有可用标准分组。'; return; }
    for (const group of groups) {
      const line = document.createElement('label'); line.className = 'bulk-rates-group';
      const box = document.createElement('input'); box.type = 'checkbox'; box.value = String(group.id);
      box.checked = selectedGroups.has(group.id);
      box.addEventListener('change', () => {
        if (box.checked) selectedGroups.add(group.id); else selectedGroups.delete(group.id);
        invalidatePreview(); renderUsers();
      });
      const copy = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = group.name;
      const meta = document.createElement('small');
      const owned = (snapshot.users || []).filter(user => user.groups?.some(row => row.groupId === group.id)).length;
      meta.textContent = `ID ${group.id} · ${group.platform || '平台未标注'} · ${group.exclusive ? '专属' : '公开'} · 默认 ${rateLabel(group.rate)} · 已授权 ${owned} 位用户`;
      copy.append(title, meta); line.append(box, copy); groupList.append(line);
    }
  }
  function renderUsers() {
    const users = snapshot?.users || [];
    const groups = new Map((snapshot?.groups || []).map(group => [group.id, group]));
    const term = userSearch.value.trim().toLocaleLowerCase();
    const visible = users.filter(user => !term ||
      [user.username, user.email, String(user.id)].some(value => String(value || '').toLocaleLowerCase().includes(term)));
    userList.replaceChildren();
    for (const user of visible) {
      const line = document.createElement('label'); line.className = 'bulk-rates-user';
      const box = document.createElement('input'); box.type = 'checkbox'; box.value = String(user.id);
      box.checked = selectedUsers.has(user.id);
      box.addEventListener('change', () => {
        if (box.checked) selectedUsers.add(user.id); else selectedUsers.delete(user.id);
        invalidatePreview(); selection();
      });
      const content = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = `${user.username || '未填写用户名'} · ${user.email || '邮箱待同步'} · ID ${user.id}`;
      const rates = document.createElement('small');
      const owned = (user.groups || []).filter(item => item.allowed === true);
      rates.textContent = owned.length ? `当前已勾选分组与倍率：${owned.map(item =>
        `${groups.get(item.groupId)?.name || `分组 ID ${item.groupId}`} ${rateLabel(item.rate)}${item.customRate == null ? '（默认）' : '（专属）'}`
      ).join('；')}` : '当前没有已勾选的可用分组；所选分组会跳过此用户。';
      content.append(name, rates); line.append(box, content); userList.append(line);
    }
    if (!visible.length) userList.textContent = users.length ? '没有匹配的用户；已勾选的其他用户仍保留。' : '尚无可选用户。';
    selection(visible.length);
  }
  function selection(visibleCount) {
    const total = snapshot?.users?.length || 0;
    const currentVisible = visibleCount ?? [...userList.querySelectorAll('label')].length;
    selectionSummary.textContent = `共 ${total} 位用户；当前搜索显示 ${currentVisible} 位；已勾选 ${selectedUsers.size} 位` +
      `${selectedGroups.size ? `；已选 ${selectedGroups.size} 个分组。` : '；尚未选分组。'} 搜索只筛显示，不会取消隐藏用户的勾选。`;
    selectAllButton.textContent = selectedUsers.size === total && total ? '取消全部用户勾选' : `全选全部 ${total} 位用户`;
    controls();
  }
  function renderSnapshot(next, restore = null) {
    if (!next || !Number.isSafeInteger(next.owner) || !Array.isArray(next.groups) || !Array.isArray(next.users))
      throw Error('平台倍率目录结构不完整。');
    snapshot = next; preview = null; previewShown = 0; selectedGroups.clear(); selectedUsers.clear();
    let dropped = 0;
    if (restore && restore.owner === next.owner) {
      const groups = new Set(next.groups.map(group => group.id));
      for (const id of restore.groups) { if (groups.has(id)) selectedGroups.add(id); else dropped++; }
      const users = new Map(next.users.map(user => [user.id, String(user.email || '').trim().toLowerCase()]));
      for (const [id, email] of restore.users) {
        if (users.get(id) === email && email) selectedUsers.add(id); else dropped++;
      }
    }
    pendingRestore = null;
    groupList.replaceChildren(); userList.replaceChildren(); previewList.replaceChildren();
    say(result, '仅读取到现有分组与用户倍率，未修改任何客户。');
    renderGroups(); renderUsers();
    say(notice, `已读取 ${next.groups.length} 个分组、${next.users.length} 位用户的当前倍率。` +
      (restore && restore.owner === next.owner ? ` 已按用户 ID 和完整邮箱核对后保留 ${selectedUsers.size} 位勾选；${dropped} 项不再匹配已取消。` : '') +
      (next.omittedInactive ? ` 另有 ${next.omittedInactive} 位停用用户未纳入调价。` : '') +
      (next.blocked ? ' 有修改结果待核对，处理前不能继续批量提交。' : ' 勾选分组与用户后可预览。'),
    next.blocked ? 'error' : 'success');
  }
  async function loadRecords() {
    if (recordsBusy || busy) return;
    recordsBusy = true; controls(); const serial = ++recordsGeneration;
    say(recordsStatus, '正在读取最近批量修改记录；不会修改平台价格。', 'busy');
    try {
      const reply = await window.groupAdmin.bulkGroupRatesHistory();
      if (serial !== recordsGeneration) return;
      if (!reply?.ok || !Array.isArray(reply.data)) throw Error(reply?.message || '记录读取失败。');
      recordsList.replaceChildren();
      const rows = reply.data;
      if (!rows.length) recordsList.textContent = '尚无批量调价记录。';
      for (const row of rows) {
        const line = document.createElement('section'); line.className = 'bulk-rates-record';
        const text = document.createElement('p');
        const labels = { success: '平台回读一致', pending: '待核对', unknown: '结果未知',
          failed: '未成功', reviewed: '已人工核对' };
        text.textContent = `${row.at || '时间未知'} · 用户 ID ${row.targetId} · ${labels[row.state] || '状态待确认'}` +
          ` · 操作编号 ${row.requestId || '—'}`;
        line.append(text);
        if (['pending', 'unknown'].includes(row.state) && typeof row.requestId === 'string') {
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = '仅回读平台核对（不重发修改）';
          button.addEventListener('click', async () => {
            if (busy || recordsBusy) return;
            recordsBusy = true; button.disabled = true; controls();
            say(recordsStatus, `正在只读回查用户 ID ${row.targetId} 的平台配置，不会重发修改。`, 'busy');
            try {
              const checked = await window.groupAdmin.bulkGroupRatesReview({ requestId: row.requestId });
              if (!checked?.ok) throw Error(checked?.message || '平台回读未一致。');
              say(recordsStatus, '已回读并核对当前平台配置；请重新读取全部倍率再做下一批。', 'success');
              snapshot = null; preview = null; selectedGroups.clear(); selectedUsers.clear();
              pendingRestore = null;
              clearImport('平台核对已完成，旧文档识别结果失效。');
              groupList.replaceChildren(); userList.replaceChildren(); previewList.replaceChildren();
              say(notice, '平台核对完成后，请重新读取当前分组与倍率。');
            } catch (error) {
              say(recordsStatus, `未能确认平台结果：${error.message}。保护仍在，请勿重发。`, 'error');
            } finally { recordsBusy = false; controls(); void loadRecords(); }
          });
          line.append(button);
        }
        recordsList.append(line);
      }
      say(recordsStatus, `已读取 ${rows.length} 条最近记录；其中 ${rows.filter(row => ['pending','unknown'].includes(row.state)).length} 条待核对。`);
    } catch (error) { if (serial === recordsGeneration) say(recordsStatus, `记录读取失败：${error.message}`, 'error'); }
    finally { recordsBusy = false; controls(); }
  }
  async function refresh() {
    if (busy) return;
    const restore = snapshot && (selectedGroups.size || selectedUsers.size) ? {
      owner: snapshot.owner, groups: [...selectedGroups],
      users: [...selectedUsers].map(id => {
        const user = snapshot.users.find(row => row.id === id);
        return [id, String(user?.email || '').trim().toLowerCase()];
      }) } : pendingRestore;
    if (restore && !confirm('重新读取会使旧预览失效。同一管理员下仍存在且 ID、邮箱一致的用户与分组会保留勾选；不匹配的会取消。是否继续？')) return;
    pendingRestore = restore;
    // The main process invalidates its preview as soon as a new read starts.
    // Clear the renderer copy before awaiting, including on a failed refresh.
    snapshot = null; preview = null; previewShown = 0; selectedGroups.clear(); selectedUsers.clear();
    clearImport('重新读取中；旧文档识别结果已清除。');
    groupList.replaceChildren(); userList.replaceChildren(); previewList.replaceChildren();
    selectionSummary.textContent = '正在重新读取；旧预览已清除，匹配的勾选将在成功读取后恢复。';
    busy = true; controls(); const serial = ++generation;
    say(notice, '正在只读查询全部分组和用户现有倍率；查询不会修改价格。', 'busy');
    try {
      const reply = await window.groupAdmin.bulkGroupRatesSnapshot();
      if (serial !== generation) return;
      if (!reply?.ok) throw Error(reply?.message || '读取失败。');
      renderSnapshot(reply.data, restore);
    } catch (error) { if (serial === generation) say(notice, `读取失败：${error.message} 请检查授权后重试。` +
      (pendingRestore ? ' 原勾选只在本窗口暂存，下次读取成功且身份一致时恢复；旧预览不可提交。' : ''), 'error'); }
    finally { busy = false; controls(); void loadRecords(); }
  }
  function renderPreview(data) {
    previewList.replaceChildren(); previewShown = 0;
    const groups = new Map((snapshot?.groups || []).map(group => [group.id, group]));
    const users = new Map((snapshot?.users || []).map(user => [user.id, user]));
    const heading = document.createElement('p');
    const total = data.changes.length + data.skipped.length;
    previewList.append(heading);
    const list = document.createElement('ol'); list.className = 'bulk-rates-preview-rows';
    previewList.append(list);
    const more = document.createElement('button'); more.type = 'button';
    more.addEventListener('click', () => appendNext()); previewList.append(more);
    function appendNext() {
      const end = Math.min(total, previewShown + 200), batch = document.createDocumentFragment();
      for (let index = previewShown; index < end; index++) {
        const skipped = index >= data.changes.length;
        const row = skipped ? data.skipped[index - data.changes.length] : data.changes[index];
        const line = document.createElement('li');
        if (skipped) line.className = 'bulk-rates-skipped';
        const user = users.get(row.userId);
        const title = `${user?.username || user?.email || `用户 ID ${row.userId}`} · ` +
          `${groups.get(row.groupId)?.name || `分组 ID ${row.groupId}`}：`;
        if (skipped) {
          const reason = { 'not-allowed': '该用户未授权此分组', 'out-of-range': '调整后超出允许倍率范围' }[row.reason] ||
            row.reason || '本项不符合调整条件';
          line.textContent = `${title}跳过（${reason}）`;
        } else line.textContent = `${title}${rateLabel(row.before)} → ${rateLabel(row.after)}`;
        batch.append(line);
      }
      list.append(batch); previewShown = end;
      heading.textContent = `将修改 ${data.changes.length} 项倍率；跳过 ${data.skipped.length} 项。` +
        ` 当前展示 ${end} / ${total} 项${end < total ? '；其余尚未展开，但确认会覆盖完整预览范围' : ''}。`;
      more.hidden = end >= total;
      if (!more.hidden) more.textContent = `再显示 ${Math.min(200, total - end)} 项（剩余 ${total - end} 项）`;
    }
    appendNext();
  }
  async function requestPreview() {
    if (previewButton.disabled || busy) return;
    busy = true; controls(); preview = null; previewList.replaceChildren();
    say(result, '正在按当前平台配置计算预览；不会修改用户价格。', 'busy');
    const serial = generation;
    try {
      const reply = await window.groupAdmin.bulkGroupRatesPreview({
        userIds: [...selectedUsers].sort((a, b) => a - b),
        groupIds: [...selectedGroups].sort((a, b) => a - b),
        direction: direction.value, amount: amount.value.trim()
      });
      if (serial !== generation) return;
      if (!reply?.ok) throw Error(reply?.message || '预览失败。');
      const data = reply.data;
      if (!data || (typeof data.previewId !== 'string' && !(data.previewId === null && !data.changes?.length)) ||
          !Array.isArray(data.changes) || !Array.isArray(data.skipped))
        throw Error('预览回执不完整，请重新读取。');
      const seen = new Set();
      for (const row of [...data.changes, ...data.skipped]) {
        const key = `${row.userId}:${row.groupId}`;
        if (!selectedUsers.has(row.userId) || !selectedGroups.has(row.groupId) || seen.has(key))
          throw Error('预览目标与本次勾选不一致，请重新读取。');
        seen.add(key);
      }
      preview = data; renderPreview(data);
      say(result, data.changes.length ?
        `预览完成：${data.changes.length} 项将修改，${data.skipped.length} 项跳过。核对旧价和新价后再明确确认。` :
        `预览完成：没有可修改的分组；${data.skipped.length} 项跳过，未写入价格。`, 'success');
    } catch (error) { say(result, `预览失败：${error.message}。未修改任何用户价格。`, 'error'); }
    finally { busy = false; controls(); }
  }
  async function commit() {
    if (commitButton.disabled || busy || !preview) return;
    const target = preview;
    if (!confirm(`确认按预览逐项修改 ${target.changes.length} 个用户分组倍率？跳过 ${target.skipped.length} 项未拥有/不可调整的分组。` +
        ` 当前列表仅展开 ${previewShown} / ${target.changes.length + target.skipped.length} 项，提交仍涵盖完整预览。` +
        ' 这是平台价格修改，若中途结果不明将停止，不能自动重试。')) return;
    busy = true; controls();
    say(result, '正在逐项提交并回读平台；请勿重复点击、关闭或重启。', 'busy');
    try {
      const reply = await window.groupAdmin.bulkGroupRatesCommit({ previewId: target.previewId });
      if (!reply?.ok) throw Error(reply?.message || '提交结果无法确认。');
      const data = reply.data || {};
      say(result, `批量操作结束（逐用户提交，非原子事务）：成功 ${data.updated ?? 0} 位用户，` +
        `跳过 ${data.skipped ?? target.skipped.length} 个用户分组组合，失败 ${data.failed ?? 0} 位用户，` +
        `结果不明 ${data.unknown ?? 0} 位用户。${data.stopped ? '已停止后续写入，请先核对操作记录。' : ''}`,
      data.unknown || data.failed || data.stopped ? 'error' : 'success');
      preview = null; previewShown = 0; previewList.replaceChildren();
      // Submitted prices are not guessed into the old snapshot. Require a fresh read.
      snapshot = null; groupList.replaceChildren(); userList.replaceChildren(); selectedGroups.clear(); selectedUsers.clear();
      pendingRestore = null;
      clearImport('价格已提交，旧文档识别结果失效。');
      say(notice, '提交后需点击“读取现有分组与倍率”重新核对；未用本地预览值假装平台已生效。');
    } catch (error) {
      say(result, `提交未能确认：${error.message}。请在操作记录和平台只读核对，勿直接重复提交。`, 'error');
      preview = null; previewShown = 0; snapshot = null; selectedGroups.clear(); selectedUsers.clear();
      pendingRestore = null;
      clearImport('提交结果未确认，旧文档识别结果失效。');
      previewList.replaceChildren(); groupList.replaceChildren(); userList.replaceChildren();
      say(notice, '提交结果未确认，必须先核对记录并重新读取当前倍率。', 'error');
    } finally { busy = false; controls(); void loadRecords(); }
  }
  refreshButton.addEventListener('click', () => void refresh());
  recordsRefreshButton.addEventListener('click', () => void loadRecords());
  selectAllButton.addEventListener('click', () => {
    if (busy || !snapshot) return;
    selectedUsers = selectedUsers.size === snapshot.users.length ? new Set() : new Set(snapshot.users.map(user => user.id));
    invalidatePreview(); renderUsers();
  });
  importButton.addEventListener('click', () => void readImport());
  importSelect.addEventListener('click', () => applyImport(true));
  importDeselect.addEventListener('click', () => applyImport(false));
  userSearch.addEventListener('input', renderUsers);
  for (const input of [direction, amount]) input.addEventListener(input === direction ? 'change' : 'input', invalidatePreview);
  previewButton.addEventListener('click', () => void requestPreview());
  commitButton.addEventListener('click', () => void commit());
  window.addEventListener('admin-view-change', event => {
    if (event.detail?.view === 'bulk-group-rates') {
      if (!snapshot && !busy) void refresh();
      else if (!recordsBusy) void loadRecords();
    }
  });
  window.groupAdmin.bulkGroupRatesOnProgress?.(progress => {
    if (!busy || !progress || progress.stage !== 'users' ||
        !Number.isSafeInteger(progress.completed) || !Number.isSafeInteger(progress.total)) return;
    say(notice, `正在只读读取用户现有倍率：${progress.completed} / ${progress.total}。查询不会修改价格。`, 'busy');
  });
  window.groupAdmin.onAuth(next => {
    if (!['login', 'expired', 'required', 'storage-error'].includes(next?.phase) &&
        (next?.owner === undefined || !snapshot || next.owner === snapshot.owner)) return;
    generation++; recordsGeneration++; snapshot = null; preview = null; previewShown = 0; selectedGroups.clear(); selectedUsers.clear();
    pendingRestore = null;
    clearImport('管理员授权已变化，旧文档识别结果失效。');
    groupList.replaceChildren(); userList.replaceChildren(); previewList.replaceChildren();
    recordsList.replaceChildren(); say(recordsStatus, '授权已变化，请重新读取批量操作记录。');
    say(notice, '管理员授权已变化，请重新读取当前价格。', 'error'); controls();
  });
  controls();
})();
