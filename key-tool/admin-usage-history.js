'use strict';
(() => {
  const el = id => document.getElementById(id);
  const month = el('usage-history-month'), week = el('usage-history-week');
  const person = el('usage-history-person'), root = el('usage-history-table');
  const status = el('usage-history-status');
  const collectionStatus = el('usage-history-collection-status');
  const backfillButton = el('usage-history-backfill');
  const backfillStatus = el('usage-history-backfill-status');
  const collectTodayButton = el('usage-history-collect-today');
  const todayStatus = el('usage-history-today-status');
  const exportStart = el('usage-history-export-start'), exportEnd = el('usage-history-export-end');
  const exportStatus = el('usage-history-export-status');
  const exportPerson = el('usage-history-export-person'), exportAll = el('usage-history-export-all');
  let catalog = null, generation = 0, observedSnapshot = false, seenSnapshot = '';
  let requestedPerson = null;
  const money = value => `$${Number(value).toFixed(4)}`;
  const phaseText = { future: '未到', missing: '未记录', ongoing: '进行中', pending: '待补齐', final: '已固定' };
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
  function cell(row, tag, value) {
    const node = document.createElement(tag); node.textContent = value; row.append(node); return node;
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
    const serial = ++generation;
    const previous = { month: month.value, week: week.value, person: requestedPerson || person.value };
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
      void readWeek();
      void refreshCollectionStatus();
    } catch (error) { if (serial === generation) status.textContent = `历史目录读取失败：${error.message}`; }
  }
  month.addEventListener('change', () => { setWeeks(); void readWeek(); });
  week.addEventListener('change', () => void readWeek());
  person.addEventListener('change', () => void readWeek());
  el('usage-history-refresh').addEventListener('click', () => void refresh());
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
        `已导出 ${reply.data.fileName}：${reply.data.people} 位归属人、${reply.data.days} 个日期列、${reply.data.rows} 个账号行。请妥善保管含邮箱的文件。`;
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
  setInterval(() => { if (!el('usage-history').hidden) void showBackfillStatus(); }, 2000);
  setInterval(() => { if (!el('usage-history').hidden) void refreshCollectionStatus(); }, 60000);
  window.addEventListener('admin-view-change', event => {
    if (event.detail.view === 'usage-history') { void refresh(); void showBackfillStatus(); void refreshCollectionStatus(); }
    else if (event.detail.previous === 'usage-history') { generation++; root.replaceChildren(); }
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
