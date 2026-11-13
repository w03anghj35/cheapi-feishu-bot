'use strict';
(() => {
  const el = id => document.getElementById(id);
  const month = el('usage-history-month'), week = el('usage-history-week');
  const person = el('usage-history-person'), root = el('usage-history-table');
  const status = el('usage-history-status');
  const groupButton = el('usage-group-read'), groupStatus = el('usage-group-status');
  const groupRoot = el('usage-group-table');
  const collectionStatus = el('usage-history-collection-status');
  const backfillButton = el('usage-history-backfill');
  const backfillStatus = el('usage-history-backfill-status');
  const collectTodayButton = el('usage-history-collect-today');
  const todayStatus = el('usage-history-today-status');
  const exportStart = el('usage-history-export-start'), exportEnd = el('usage-history-export-end');
  const exportStatus = el('usage-history-export-status');
  const exportPerson = el('usage-history-export-person'), exportAll = el('usage-history-export-all');
  const accountSelect = el('usage-history-account-backfill-user');
  const accountLabelRefresh = el('usage-history-account-label-refresh');
  const accountLabelStatus = el('usage-history-account-label-status');
  const accountBackfillButton = el('usage-history-account-backfill');
  const accountBackfillStatus = el('usage-history-account-backfill-status');
  let catalog = null, generation = 0, observedSnapshot = false, seenSnapshot = '';
  let groupGeneration = 0, groupBusy = false;
  let requestedPerson = null, accountBusy = false, labelGeneration = 0,
    labelBusy = 0, labelVerifiedName = '';
  const money = value => `$${Number(value).toFixed(4)}`;
  const groupMoney = value => {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/.test(value)) return '金额待核对';
    const [integer, fraction] = value.split('.');
    return `$${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
  };
  const phaseText = { future: '未到', missing: '未记录', ongoing: '进行中', pending: '待补齐', partial: '单账号回填', final: '已固定' };
  const beijingTime = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  async function refreshCollectionStatus() {
    try {
      const reply = await window.groupAdmin.dailyUsageState();
      if (!reply.ok) throw Error(reply.message);
      const data = reply.data, collection = data.collection || {};
      const snapshotKey = `${data.lastDay || ''}:${data.lastCheckedAt || ''}:${(collection.pendingDays || []).join(',')}`;
      const changed = observedSnapshot && seenSnapshot !== snapshotKey;
      observedSnapshot = true; seenSnapshot = snapshotKey;
      collectionStatus.textContent = `本机每小时采样：${!collection.available ? '等待平台管理员授权与原目标群绑定' :
        collection.busy ? '读取中' : collection.retryAfter ? `失败后等待重试（北京时间 ${beijingTime(collection.retryAfter)}）` : '已就绪'}。` +
        ` 最近已存日期：${data.lastDay || '尚无'}；最近采样：${data.lastCheckedAt ? beijingTime(data.lastCheckedAt) : '尚无'}。` +
        (collection.failure ? ` 上次${collection.failure === 'unfinished' ? '历史待补齐日期读取' : collection.failure === 'yesterday' ? '昨日补读' : '今日读取'}未完成；不会把缺日当零。` : '') +
        (collection.pendingDays?.length ? ` 待补齐历史日期：${collection.pendingDays.join('、')}。` : '') +
        (collection.manualDays?.length ? ` 其中 ${collection.manualDays.join('、')} 的归属与当前不同，自动补齐已保留原记录，请管理员先核对。` : '') +
        ` 群卡片${data.enabled && data.dailyTime ? `每日 ${data.dailyTime} 北京时间定时更新` :
          data.enabled ? '待设置每日时间（自动发送已停）' : '未启用'}，不影响本机采样。`;
      if (changed && !el('usage-history').hidden) void refresh();
    } catch { collectionStatus.textContent = '本机采样状态暂不可读取，请核对平台管理员授权和加密账本。'; }
  }
  function options(select, values, label, preferred) {
    select.replaceChildren();
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value.value; option.textContent = value.label; select.append(option);
    }
    if (values.some(item => item.value === preferred)) select.value = preferred;
    select.disabled = !values.length;
    if (!values.length) { const option = document.createElement('option'); option.textContent = label; select.append(option); }
  }
  function setWeeks(preferred) {
    const weeks = catalog?.weeksByMonth?.[month.value] || [];
    const current = weeks.find(item => item.start <= catalog.today && catalog.today <= item.end);
    options(week, weeks.map(item => ({ value: item.start, label: `${item.start} — ${item.end}` })),
      '暂无周', preferred || current?.start || weeks.at(-1)?.start);
  }
  function setAccounts(preferred = '') {
    const accounts = Object.hasOwn(catalog?.accountsByPerson || {}, person.value) ?
      catalog.accountsByPerson[person.value] : [];
    accountSelect.replaceChildren();
    const empty = document.createElement('option'); empty.value = '';
    empty.textContent = accounts.length ? '选择当前归属的账号' : '此归属人暂无当前账号'; accountSelect.append(empty);
    for (const account of accounts) {
      const option = document.createElement('option'); option.value = String(account.id);
      const username = typeof account.username === 'string' ? account.username.trim() : '';
      const email = typeof account.email === 'string' ? account.email.trim() : '';
      option.textContent = `${[username, email].filter(Boolean).join(' · ') || '名称待同步'} · ID ${account.id}`;
      option.disabled = !username && !email;
      accountSelect.append(option);
    }
    if ([...accountSelect.options].some(option => option.value === preferred && !option.disabled))
      accountSelect.value = preferred;
    accountSelect.disabled = !accounts.length;
    accountLabelRefresh.disabled = !person.value || Boolean(labelBusy);
    accountBackfillButton.disabled = accountBusy || labelVerifiedName !== person.value ||
      !accountSelect.value || accountSelect.selectedOptions[0]?.disabled;
  }
  async function loadAccountOptions() {
    const name = person.value, serial = ++labelGeneration;
    labelVerifiedName = '';
    if (!catalog || !name || !Object.hasOwn(catalog.accountsByPerson || {}, name)) {
      accountLabelStatus.textContent = '当前没有可同步的归属账号。';
      setAccounts(); return;
    }
    labelBusy = serial; accountLabelRefresh.disabled = true;
    accountBackfillButton.disabled = true;
    accountLabelStatus.textContent = '正在核对平台用户名和邮箱…';
    try {
      const reply = await window.groupAdmin.dailyUsageAccountOptions({ name });
      if (serial !== labelGeneration || name !== person.value) return;
      if (!reply.ok) throw Error(reply.message);
      if (reply.data?.name !== name || !Array.isArray(reply.data.accounts))
        throw Error('平台账号目录与所选归属不一致。');
      const ids = new Set(catalog.accountsByPerson[name].map(row => row.id));
      if (reply.data.accounts.length !== ids.size || reply.data.accounts.some(row =>
        !Number.isSafeInteger(row.id) || !ids.has(row.id)) ||
        new Set(reply.data.accounts.map(row => row.id)).size !== ids.size)
        throw Error('平台账号目录已变化，请重新读取本机记录。');
      const old = accountSelect.value;
      catalog.accountsByPerson[name] = reply.data.accounts;
      labelVerifiedName = name;
      setAccounts(old);
      const unresolved = reply.data.accounts.filter(row => !row.email && !row.username).length;
      accountLabelStatus.textContent = unresolved ?
        `已同步 ${reply.data.accounts.length} 个账号，其中 ${unresolved} 个仍无可读名称，已禁止选择。` :
        `已同步 ${reply.data.accounts.length} 个账号的当前用户名与邮箱；请按名称选中，ID 仅供核对。`;
    } catch (error) {
      if (serial === labelGeneration) accountLabelStatus.textContent =
        `账号名称同步失败：${error.message} 请点“同步账号名称”重试；历史表仍可查看。`;
    } finally {
      if (serial === labelGeneration) { labelBusy = 0; setAccounts(accountSelect.value); }
    }
  }
  function cell(row, tag, value) {
    const node = document.createElement(tag); node.textContent = value; row.append(node); return node;
  }
  function invalidateGroup() {
    groupGeneration++;
    groupRoot.replaceChildren();
    groupStatus.textContent = '当前选择已变化，请点击“读取所选周的分组用量”。';
  }
  function renderGroup(data) {
    groupRoot.replaceChildren();
    if (!data || !Array.isArray(data.days) || !Array.isArray(data.groups) || !Array.isArray(data.rows) ||
        data.days.length !== 7 || data.complete !== true) throw Error('分组用量未完整返回，请缩小范围后重试。');
    const title = document.createElement('h4'); title.id = 'usage-group-table-title';
    title.className = 'usage-history-table-title';
    title.textContent = `${person.value} · ${data.start} 至 ${data.end} · 每日每分组用户实付（USD）`;
    const scroll = document.createElement('div'); scroll.className = 'usage-history-table-scroll';
    const table = document.createElement('table'); table.className = 'usage-history-table usage-group-table';
    table.setAttribute('aria-labelledby', title.id);
    const head = document.createElement('thead'), dates = document.createElement('tr');
    for (const label of ['归属姓名', '平台账号邮箱', '当前授权分组']) {
      const th = cell(dates, 'th', label); th.rowSpan = 2;
    }
    for (const day of data.days) {
      const th = cell(dates, 'th', `${day.day} · ${phaseText[day.phase] || '待核对'}`);
      th.colSpan = Math.max(1, data.groups.length);
    }
    const groups = document.createElement('tr');
    for (const day of data.days) {
      if (!data.groups.length) cell(groups, 'th', '无实际使用分组');
      else for (const group of data.groups)
        cell(groups, 'th', `${group.name || '未命名分组'} · ID ${group.id}`);
    }
    head.append(dates, groups); table.append(head);
    const body = document.createElement('tbody');
    for (const row of data.rows) {
      if (!Number.isSafeInteger(row.id) || !Array.isArray(row.values) || row.values.length !== 7)
        throw Error('分组用量账号行不完整。');
      const tr = document.createElement('tr');
      cell(tr, 'th', row.name || person.value);
      cell(tr, 'td', `${row.email || '邮箱待同步'} · ID ${row.id}`);
      const explicit = Array.isArray(row.allowedGroups) && row.allowedGroups.length ?
        row.allowedGroups.map(group => `${group.name || '未命名分组'}（ID ${group.id}）`).join('、') : null;
      const allowed = row.allowedGroups === null ? '当前授权未取得' :
        `${explicit || '未单独授权分组'}；${row.accessMode === 'all-nonexclusive' || row.restrictPublicGroups === false ?
          '公共组可用（依平台规则）' : row.restrictPublicGroups === true ? '公共组已限制' : '公共组权限待核对'}`;
      cell(tr, 'td', allowed);
      for (const [index, day] of data.days.entries()) {
        if (!data.groups.length) { cell(tr, 'td', row.values[index] === null ?
          day.phase === 'future' ? '未到' : '未归属' : '无使用记录'); continue; }
        for (const group of data.groups) {
        const values = row.values[index];
        const raw = values === null ? null : values?.[String(group.id)] ?? '0';
        const td = cell(tr, 'td', raw === null ? day.phase === 'future' ? '未到' : '未归属' : groupMoney(raw));
        if (raw === null) td.className = 'usage-group-unassigned';
        else if (raw === '0') td.className = 'usage-group-zero';
        }
      }
      body.append(tr);
    }
    if (!data.rows.length) {
      const tr = document.createElement('tr'), td = cell(tr, 'td', '所选归属人此周没有可统计的账号。');
      td.colSpan = 3 + 7 * Math.max(1, data.groups.length); body.append(tr);
    }
    table.append(body); scroll.append(table); groupRoot.append(title, scroll);
    groupStatus.textContent = `平台使用记录已完整读取：${data.rows.length} 个账号、${data.groups.length} 个展示分组（含当前授权）；按北京时间逐日展示。` +
      (data.accessWarning ? ` ${data.accessWarning}` : '');
  }
  async function readGroupWeek() {
    if (groupBusy || !catalog || !week.value || !person.value) return;
    const serial = ++groupGeneration, selected = { month: month.value, weekStart: week.value, name: person.value };
    groupBusy = true; groupButton.disabled = true; groupRoot.replaceChildren();
    groupStatus.textContent = '正在逐页读取平台使用记录，核对用户、日期和实际分组…';
    try {
      const reply = await window.groupAdmin.dailyUsageGroupWeek(selected);
      if (serial !== groupGeneration || selected.weekStart !== week.value || selected.name !== person.value) return;
      if (!reply?.ok) throw Error(reply?.message || '平台使用记录读取失败。');
      renderGroup(reply.data);
    } catch (error) {
      if (serial === groupGeneration) groupStatus.textContent = `分组用量未完成：${error.message}`;
    } finally { groupBusy = false; groupButton.disabled = false; }
  }
  function render(data) {
    root.replaceChildren();
    const title = document.createElement('h3');
    title.id = 'usage-history-table-title'; title.className = 'usage-history-table-title';
    title.textContent = `${data.name} · ${data.week.start} 至 ${data.week.end} · 用户实付（USD）`;
    const scroll = document.createElement('div'); scroll.className = 'usage-history-table-scroll';
    const table = document.createElement('table'); table.className = 'usage-history-table';
    table.setAttribute('aria-labelledby', title.id);
    const head = document.createElement('thead'), header = document.createElement('tr');
    cell(header, 'th', '平台账号邮箱');
    for (const day of data.days) cell(header, 'th', `${day.day.slice(5)} ${phaseText[day.phase]}${day.source === 'backfill-current-ownership' ? ' · 回填' : ''}`);
    cell(header, 'th', '每周用量'); head.append(header); table.append(head);
    const body = document.createElement('tbody');
    for (const user of data.rows) {
      const tr = document.createElement('tr'); cell(tr, 'th', user.email);
      user.values.forEach((value, index) => cell(tr, 'td', value === null ?
        (user.membership?.[index] === 'removed' ? '已移除' : user.membership?.[index] === 'unassigned' ? '未归属' :
          user.awaitingSample && data.days[index].day === data.today ? '待采样' :
          data.days[index].phase === 'future' ? '未到' : '未记录') : money(value)));
      cell(tr, 'td', user.hasRecordedUsage === false ? '尚无记录' :
        `${money(user.recordedSubtotal)}${user.complete ? '' : '（已记录小计）'}`);
      body.append(tr);
    }
    if (!data.rows.length) {
      const tr = document.createElement('tr'), td = cell(tr, 'td', '所选归属人与周暂无已采集的账号用量。');
      td.colSpan = 9; body.append(tr);
    }
    table.append(body);
    const foot = document.createElement('tfoot'), total = document.createElement('tr');
    cell(total, 'th', '合计');
    data.totals.forEach((value, index) => cell(total, 'td', value === null ?
      (data.days[index].phase === 'future' ? '未到' : '未记录') :
      `${money(value)}${data.totalsComplete[index] ? '' : '（小计）'}`));
    cell(total, 'td', `${money(data.recordedSubtotal)}${data.complete ? '' : '（已记录小计）'}`);
    foot.append(total); table.append(foot); scroll.append(table); root.append(title, scroll);
    const recorded = data.days.filter(day => day.checkedAt).map(day => day.checkedAt).sort();
    status.textContent = `已读取 ${data.rows.length} 个账号；${data.complete ? '完整周统计' : '此周尚不完整，周合计仅为已记录小计'}。` +
      (data.awaitingCount ? ` ${data.awaitingCount} 个当前归属账号今日待采样，未读取金额不计为零。` : '') +
      (recorded.length ? ` 最近采样（北京时间）：${new Date(recorded.at(-1)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}。` : ' 本周尚无采样。');
  }
  async function readWeek() {
    invalidateGroup();
    const serial = ++generation; root.replaceChildren();
    if (!catalog || !week.value || !person.value) { status.textContent = '暂无可选归属人或周记录。'; return; }
    status.textContent = '正在读取本机加密历史记录…';
    try {
      const reply = await window.groupAdmin.dailyUsageHistoryWeek({ month: month.value,
        weekStart: week.value, name: person.value });
      if (serial !== generation) return;
      if (!reply.ok) throw Error(reply.message);
      render(reply.data);
    } catch (error) { if (serial === generation) status.textContent = `历史用量读取失败：${error.message}`; }
  }
  async function refresh() {
    invalidateGroup();
    const serial = ++generation;
    labelGeneration++; labelBusy = 0; labelVerifiedName = '';
    accountBackfillButton.disabled = true; accountLabelRefresh.disabled = true;
    accountLabelStatus.textContent = '正在读取当前归属账号，随后同步平台名称…';
    const previous = { month: month.value, week: week.value, person: requestedPerson || person.value,
      account: requestedPerson ? '' : accountSelect.value };
    requestedPerson = null;
    catalog = null; root.replaceChildren(); status.textContent = '正在读取本机可用的历史月份与归属人…';
    month.disabled = true; week.disabled = true; person.disabled = true;
    try {
      const reply = await window.groupAdmin.dailyUsageHistoryCatalog();
      if (serial !== generation) return;
      if (!reply.ok) throw Error(reply.message);
      catalog = reply.data;
      if (!exportStart.value && !exportEnd.value) {
        const today = Date.parse(`${catalog.today}T00:00:00Z`);
        const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * 86400000;
        exportStart.value = new Date(monday).toISOString().slice(0, 10);
        exportEnd.value = new Date(monday + 6 * 86400000).toISOString().slice(0, 10);
      }
      options(month, catalog.months.map(value => ({ value, label: value })), '暂无月份', previous.month);
      setWeeks(previous.week);
      options(person, catalog.names.map(value => ({ value, label: value })), '暂无归属人', previous.person);
      setAccounts(previous.account);
      void loadAccountOptions();
      void readWeek();
      void refreshCollectionStatus();
    } catch (error) { if (serial === generation) status.textContent = `历史目录读取失败：${error.message}`; }
  }
  month.addEventListener('change', () => { setWeeks(); void readWeek(); });
  week.addEventListener('change', () => void readWeek());
  person.addEventListener('change', () => { setAccounts(); void readWeek(); void loadAccountOptions(); });
  accountSelect.addEventListener('change', () => {
    accountBackfillButton.disabled = accountBusy || labelVerifiedName !== person.value ||
      !accountSelect.value || accountSelect.selectedOptions[0]?.disabled;
  });
  accountLabelRefresh.addEventListener('click', () => { if (!labelBusy) void loadAccountOptions(); });
  el('usage-history-refresh').addEventListener('click', () => void refresh());
  groupButton.addEventListener('click', () => void readGroupWeek());
  collectTodayButton.addEventListener('click', async () => {
    if (collectTodayButton.disabled) return;
    collectTodayButton.disabled = true;
    todayStatus.textContent = '正在按当前已保存归属读取今日用量并保存；不会发群，请勿重复点击。';
    try {
      const reply = await window.groupAdmin.dailyUsageCollectToday();
      if (!reply.ok) throw Error(reply.message);
      const result = reply.data;
      if (result.failed) throw Error('平台读取未完成或归属在读取期间变化，原快照已保留；请检查采样状态，等待退避结束。');
      if (result.skipped) {
        const reasons = { busy: '已有用量任务正在执行，请稍后再试。', backoff: '上次读取失败，正在等待退避重试；原记录保留。',
          scope: '请核对平台管理员授权与原目标群绑定。', 'authorization': '请先恢复平台管理员授权。',
          'no-users': '没有已保存的归属账号，请先在“用户归属”保存。' };
        todayStatus.textContent = reasons[result.skipped] || '本次未执行采样，请查看采样状态。';
      } else if (result.saved?.length) {
        todayStatus.textContent = '今日用量已采样并保存。新增账号可在所属人的当前周查看；未改历史完整日，也未发群。';
        await refresh();
      } else todayStatus.textContent = '本次没有保存新快照，请查看采样状态。';
      await refreshCollectionStatus();
    } catch (error) { todayStatus.textContent = `今日采样未完成：${error.message}`; }
    finally { collectTodayButton.disabled = false; }
  });
  async function exportHistory(scope) {
    if (exportPerson.disabled || exportAll.disabled) return;
    if (!catalog) { exportStatus.textContent = '请先读取本机历史目录。'; return; }
    if (!exportStart.value || !exportEnd.value || exportStart.value > exportEnd.value) {
      exportStatus.textContent = '请选择有效的开始和结束日期。'; return;
    }
    if (scope === 'person' && !person.value) { exportStatus.textContent = '请先选择所属人。'; return; }
    exportPerson.disabled = true; exportAll.disabled = true;
    exportStatus.textContent = '正在生成 Excel，请在保存对话框选择本机位置…';
    try {
      const reply = await window.groupAdmin.dailyUsageHistoryExport({
        scope, name: scope === 'person' ? person.value : undefined,
        start: exportStart.value, end: exportEnd.value
      });
      if (!reply.ok) throw Error(reply.message);
      exportStatus.textContent = reply.data.canceled ? '已取消导出，未写入文件。' :
        `已导出 ${reply.data.fileName}：${reply.data.people} 位归属人、${reply.data.days} 个日期列、${reply.data.rows} 个账号行。` +
        (reply.data.groupIncluded === true ? ' 已包含平台分组用量工作表。' :
          reply.data.groupIncluded === false ? ' 本次未读取分组用量；分组工作表已标注缺失。' : '') +
        ' 请妥善保管含邮箱的文件。';
    } catch (error) { exportStatus.textContent = `导出失败：${error.message}`; }
    finally { exportPerson.disabled = false; exportAll.disabled = false; }
  }
  exportPerson.addEventListener('click', () => void exportHistory('person'));
  exportAll.addEventListener('click', () => void exportHistory('all'));
  async function showBackfillStatus() {
    try {
      const reply = await window.groupAdmin.dailyUsageBackfillStatus();
      if (!reply.ok) throw Error(reply.message);
      const job = reply.data;
      backfillButton.disabled = job.phase === 'running';
      if (job.phase === 'idle') return;
      backfillStatus.textContent = `${job.month} 补采：${job.phase === 'running' ? '进行中' :
        job.phase === 'done' ? '完成' : job.phase === 'limited' ? '到达本次时间上限，点击可续采' : '已停止'}。` +
        ` 已保存 ${job.completed} 天，跳过已有 ${job.skipped} 天，共 ${job.total} 天；当前 ${job.day || '—'}。` +
        (job.message || '历史回填按当前归属，不会发群。');
    } catch { backfillStatus.textContent = '补采状态暂不可读取，请检查管理员授权。'; }
  }
  backfillButton.addEventListener('click', async () => {
    if (backfillButton.disabled) return;
    if (!confirm('确认只读查询本月所有已结束日期的当前归属账号，并加密保存到本机历史表？每账号每天一次请求，可能需要数分钟；不会向飞书群发送。历史归属可能与现在不同，回填结果只代表当前归属。')) return;
    backfillButton.disabled = true;
    backfillStatus.textContent = '正在补采本月已结束日期；请保持程序和管理员授权可用。';
    try {
      const reply = await window.groupAdmin.dailyUsageBackfillCurrentMonth();
      if (!reply.ok) throw Error(reply.message);
      await showBackfillStatus();
      if (reply.data.phase === 'done' || reply.data.phase === 'limited') void refresh();
    } catch (error) {
      backfillStatus.textContent = `补采未开始或未完成：${error.message}`;
      await showBackfillStatus();
      void refresh();
    }
    finally { backfillButton.disabled = false; }
  });
  async function showAccountBackfillStatus() {
    try {
      const reply = await window.groupAdmin.dailyUsageAccountBackfillStatus();
      if (!reply.ok) throw Error(reply.message);
      const job = reply.data;
      accountBackfillButton.disabled = accountBusy || job.phase === 'running' ||
        labelVerifiedName !== person.value || !accountSelect.value || accountSelect.selectedOptions[0]?.disabled;
      if (job.phase === 'idle') return;
      accountBackfillStatus.textContent = `${job.month} · ${job.name || '归属待确认'} · 账号 ID ${job.userId || '—'} 单账号补采：${job.phase === 'running' ? '进行中' :
        job.phase === 'done' ? '完成' : job.phase === 'limited' ? '到达时间上限，可再次续采' : '已停止'}。` +
        ` 已补 ${job.completed} 天，跳过已有 ${job.skipped} 天，共 ${job.total} 天；当前 ${job.day || '—'}。` +
        (job.message || '只按当前归属回填此账号，不重读其他账号，也不发群。');
    } catch { accountBackfillStatus.textContent = '单账号补采状态暂不可读取，请核对管理员授权。'; }
  }
  accountBackfillButton.addEventListener('click', async () => {
    const name = person.value, userId = Number(accountSelect.value);
    const accounts = Object.hasOwn(catalog?.accountsByPerson || {}, name) ? catalog.accountsByPerson[name] : [];
    if (accountBackfillButton.disabled || !accounts.some(account => account.id === userId)) return;
    if (!confirm(`确认只补“${name}”的账号 ID ${userId} 在本月已结束日期的缺失用量？加入归属前的用量会计入“${name}”历史合计，并标“按当前归属回填”；不重读其他账号、不发群。`)) return;
    accountBusy = true; accountBackfillButton.disabled = true;
    accountBackfillStatus.textContent = '正在逐日读取所选账号缺失的历史金额，请勿重复点击。';
    try {
      const reply = await window.groupAdmin.dailyUsageAccountBackfillCurrentMonth({ name, userId });
      if (!reply.ok) throw Error(reply.message);
      await showAccountBackfillStatus();
      if (['done','limited'].includes(reply.data.phase)) await refresh();
    } catch (error) {
      accountBackfillStatus.textContent = `单账号补采未完成：${error.message}`;
      await showAccountBackfillStatus();
      void refresh();
    }
    finally { accountBusy = false; setAccounts(accountSelect.value); }
  });
  setInterval(() => { if (!el('usage-history').hidden) void showBackfillStatus(); }, 2000);
  setInterval(() => { if (!el('usage-history').hidden) void showAccountBackfillStatus(); }, 2000);
  setInterval(() => { if (!el('usage-history').hidden) void refreshCollectionStatus(); }, 60000);
  window.addEventListener('admin-view-change', event => {
    if (event.detail.view === 'usage-history') { void refresh(); void showBackfillStatus(); void showAccountBackfillStatus(); void refreshCollectionStatus(); }
    else if (event.detail.previous === 'usage-history') { generation++; root.replaceChildren(); invalidateGroup(); }
  });
  window.groupAdmin.onOwnershipChanged?.(() => {
    if (!el('usage-history').hidden) void refresh();
  });
  window.addEventListener('ownership-view-usage', event => {
    if (typeof event.detail?.name !== 'string') return;
    requestedPerson = event.detail.name;
    window.dispatchEvent(new CustomEvent('admin-navigate',{detail:{view:'usage-history'}}));
  });
})();
