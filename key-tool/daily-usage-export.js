'use strict';
const ExcelJS = require('exceljs');
const { dayKey } = require('./daily-usage');
const { historyCatalog } = require('./daily-usage-history');
const { projectSnapshots, datedIds } = require('./ownership-dates');
const { supplementedUsers } = require('./daily-usage-supplements');

const DAY_MS = 24 * 60 * 60_000;
const MAX_DAYS = 366;
const MAX_ROWS = 150_000;
const MAX_WIDE_CELLS = 500_000;
const phaseLabel = { future: '未到', missing: '未记录', ongoing: '进行中', pending: '待补齐', partial: '单账号回填', final: '已固定' };
const amountFormat = '#,##0.0000';
const groupAmount = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/;

function appendGroupSheet(workbook, data, groupData) {
  const sheet = workbook.addWorksheet('分组用量', {
    views: [{ state: 'frozen', xSplit: 3, ySplit: 3, showGridLines: false }]
  });
  if (groupData === undefined || groupData === null) {
    sheet.getColumn(1).width = 72;
    sheet.addRow(['分组使用记录未读取，不能从旧每日总额拆分。']);
    return;
  }
  if (!groupData || groupData.complete !== true || groupData.start !== data.start ||
      groupData.end !== data.end || !Array.isArray(groupData.days) ||
      !Array.isArray(groupData.groups) || !Array.isArray(groupData.rows) ||
      groupData.days.length !== data.count || data.count > 31)
    throw Error('分组用量与导出日期或读取状态不一致，请重新查询。');
  const days = Array.from({ length: data.count }, (_, index) =>
    new Date(Date.parse(`${data.start}T00:00:00Z`) + index * DAY_MS).toISOString().slice(0, 10));
  if (groupData.days.some((item, index) => item?.day !== days[index] ||
      !['final', 'ongoing', 'future'].includes(item.phase)))
    throw Error('分组用量日期不完整，请重新查询。');
  const groupKeys = new Set();
  for (const group of groupData.groups) {
    if (!group || !(group.id === 'ungrouped' || Number.isSafeInteger(group.id) && group.id > 0) ||
        typeof group.name !== 'string' || !group.name || group.name.length > 200 ||
        /[\x00-\x1f\x7f]/.test(group.name) || groupKeys.has(String(group.id)))
      throw Error('分组用量的分组目录无效。');
    groupKeys.add(String(group.id));
  }
  const groupColumns = Math.max(1, groupData.groups.length);
  const columns = 3 + data.count * groupColumns;
  if (columns > 16384 || (groupData.rows.length + 5) * columns > MAX_WIDE_CELLS)
    throw Error('分组用量表过大，请缩短日期或归属范围。');
  const selectedOwners = new Set(data.rows.map(row => row.name));
  const selectedAccounts = new Set(data.rows.filter(row => row.id !== null)
    .map(row => `${row.name}\u0000${row.id}`));
  const accounts = new Set(), rowsByOwner = new Map();
  for (const row of groupData.rows) {
    if (!row || typeof row.name !== 'string' || !selectedOwners.has(row.name) ||
        !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.email !== 'string' ||
        row.email.length > 254 || !Array.isArray(row.values) || row.values.length !== data.count ||
        !(row.allowedGroups === null || Array.isArray(row.allowedGroups)))
      throw Error('分组用量账号行无效。');
    const identity = `${row.name}\u0000${row.id}`;
    if (!selectedAccounts.has(identity) || accounts.has(identity))
      throw Error('分组用量账号不在导出范围或重复。');
    accounts.add(identity);
    if (row.allowedGroups?.some(group => !group ||
        !Number.isSafeInteger(group.id) || group.id <= 0 || typeof group.name !== 'string'))
      throw Error('当前授权分组字段无效。');
    for (const [index, values] of row.values.entries()) {
      if (values === null) continue;
      if (groupData.days[index].phase === 'future' || !values || typeof values !== 'object' || Array.isArray(values) ||
          Object.keys(values).some(key => !groupKeys.has(key) || typeof values[key] !== 'string' ||
            !groupAmount.test(values[key])))
        throw Error('分组用量金额或归属日期无效。');
    }
    const ownerRows = rowsByOwner.get(row.name) || [];
    ownerRows.push(row); rowsByOwner.set(row.name, ownerRows);
  }
  sheet.getColumn(1).width = 22;
  sheet.getColumn(2).width = 38;
  sheet.getColumn(3).width = 42;
  for (let column = 4; column <= columns; column++) sheet.getColumn(column).width = 20;
  const dateHeader = sheet.addRow(['归属姓名', '平台账号邮箱', '当前授权分组（非历史授权）']);
  dateHeader.height = 30;
  const groupHeader = sheet.addRow([null, null, null]);
  const phaseHeader = sheet.addRow([null, null, null]);
  for (let index = 0; index < days.length; index++) {
    if (!groupData.groups.length) {
      const column = 4 + index;
      dateHeader.getCell(column).value = new Date(`${days[index]}T00:00:00Z`);
      dateHeader.getCell(column).numFmt = 'yyyy-mm-dd';
      groupHeader.getCell(column).value = '无实际使用分组';
      phaseHeader.getCell(column).value = groupData.days[index].phase === 'final' ? '已结束' :
        groupData.days[index].phase === 'ongoing' ? '进行中' : '未到';
    }
    for (const [groupIndex, group] of groupData.groups.entries()) {
      const column = 4 + index * groupData.groups.length + groupIndex;
      dateHeader.getCell(column).value = new Date(`${days[index]}T00:00:00Z`);
      dateHeader.getCell(column).numFmt = 'yyyy-mm-dd';
      groupHeader.getCell(column).value = `${group.name}（ID ${group.id}）`;
      phaseHeader.getCell(column).value = groupData.days[index].phase === 'final' ? '已结束' :
        groupData.days[index].phase === 'ongoing' ? '进行中' : '未到';
    }
  }
  for (const header of [dateHeader, groupHeader, phaseHeader]) header.eachCell({ includeEmpty: true }, cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: header === dateHeader ? 'FF285A79' : 'FFEAF1F6' } };
    cell.font = { name: 'Arial', size: 10, bold: true,
      color: { argb: header === dateHeader ? 'FFFFFFFF' : 'FF36536A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  for (const [name, ownerRows] of rowsByOwner) {
    const band = sheet.addRow([name]); band.height = 23;
    for (let column = 1; column <= Math.max(3, columns); column++) {
      const cell = band.getCell(column);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5D9CC5' } };
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    }
    for (const row of ownerRows) {
      const currentAccess = row.allowedGroups === null ? '当前授权未取得' :
        row.allowedGroups.length ? row.allowedGroups.map(group => `${group.name}（ID ${group.id}）`).join('、') :
          row.accessMode === 'all-nonexclusive' || row.restrictPublicGroups === false ?
            '未单独授权分组；公共组可用（依平台规则）' : '当前未单独授权分组';
      const cells = [name, row.email, currentAccess];
      for (const values of row.values) {
        if (!groupData.groups.length) cells.push(values === null ? null : '无使用记录');
        else for (const group of groupData.groups)
          cells.push(values === null ? null : values[String(group.id)] ?? '0');
      }
      const record = sheet.addRow(cells); record.height = 23;
      record.font = { name: 'Arial', size: 10, color: { argb: 'FF273640' } };
      for (let column = 4; column <= columns; column++) {
        const cell = record.getCell(column);
        cell.numFmt = '@';
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (cell.value !== null) cell.font = { name: 'Arial', size: 10, color: { argb: 'FF149652' } };
      }
    }
  }
  const note = sheet.addRow(['金额保留平台八位十进制精度，以文本存储；空白表示不在归属期或未到日期，0 表示完整读取后无该组用量。当前授权分组不是历史使用分组，实际分组以列标题的分组 ID 为准。']);
  note.height = 48;
  sheet.mergeCells(note.number, 1, note.number, Math.min(Math.max(3, columns), 8));
  note.getCell(1).font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF536B7A' } };
  note.getCell(1).alignment = { vertical: 'middle', wrapText: true };
  sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: note.number - 1, column: Math.max(3, columns) } };
}

function exportRows(state, input, today, currentNames = [], datedProfiles = []) {
  state=projectSnapshots(state,datedProfiles);
  dayKey(today);
  const start = dayKey(input?.start), end = dayKey(input?.end);
  const count = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  if (count < 1 || count > MAX_DAYS) throw Error(`导出日期应按顺序选择，且每次最多 ${MAX_DAYS} 天。`);
  if (!['person', 'all'].includes(input?.scope)) throw Error('导出范围无效。');
  const names = historyCatalog(state, currentNames, today).names;
  if (input.scope === 'person' && (typeof input.name !== 'string' || !names.includes(input.name)))
    throw Error('所选归属人无效，请重新读取历史记录。');
  const selected = input.scope === 'all' ? names : [input.name];
  if (!selected.length) throw Error('暂无可导出的归属人。');
  const rows = [];
  for (let offset = 0; offset < count; offset++) {
    const day = new Date(Date.parse(`${start}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
    const snapshot = state?.snapshots?.[day];
    for (const name of selected) {
      const profile = snapshot?.rows.find(row => row.name === name);
      const extra = supplementedUsers(state, day, name, profile?.users || []);
      const phase = day > today ? 'future' : !profile && extra.supplemented ? 'partial' : !profile ? 'missing' : snapshot.final ? 'final' : day < today ? 'pending' : 'ongoing';
      const users = [...extra.users];
      const datedProfile=datedProfiles.find(p=>p.name===name);
      if(day<=today)for(const id of datedIds(datedProfile,day) || [])if(!users.some(u=>u.id===id))
        users.push({id,email:datedProfile.membership?.labels?.find(u=>u.id===id)?.email || `平台用户 ID ${id}`,cost:null});
      const missing=users.some(u=>u.cost===null);
      const total = (profile || extra.supplemented) && (!users.length || users.some(u=>u.cost!==null)) ? users.reduce((sum, user) => sum + (user.cost ?? 0), 0) : null;
      const source = extra.supplemented || snapshot?.source === 'backfill-current-ownership' ? '按当前归属回填' : profile ? '定时采集' : '';
      const checkedAt = [profile ? snapshot.checkedAt : null, extra.checkedAt].filter(Boolean).sort().at(-1) || null;
      for (const [index, user] of (users.length ? users : [null]).entries()) {
        rows.push({ day, name, id: user?.id ?? null, email: user?.email ?? '', cost: user?.cost ?? null,
          dailyTotal: index === 0 ? total : null, phase: phaseLabel[phase],
          totalKind: index === 0 && (profile || extra.supplemented) ? snapshot?.final && !missing ? '完整日' : '已记录小计' : '',
          source, checkedAt });
        if (rows.length > MAX_ROWS) throw Error('导出行数过多，请缩短日期范围后重试。');
      }
    }
  }
  return { rows, count, people: selected.length, start, end };
}

function wideLayout(data) {
  const dates = Array.from({ length: data.count }, (_, offset) =>
    new Date(Date.parse(`${data.start}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10));
  const owners = new Map();
  const dayStatus = new Map(dates.map(day => [day, { phases: new Set(), backfilled: false }]));
  for (const row of data.rows) {
    const status = dayStatus.get(row.day);
    if (!status) throw Error('导出日期与记录不一致，请重新读取。');
    status.phases.add(row.phase);
    if (row.source === '按当前归属回填') status.backfilled = true;
    let owner = owners.get(row.name);
    if (!owner) { owner = { name: row.name, accounts: new Map(), totals: new Map() }; owners.set(row.name, owner); }
    if (row.dailyTotal !== null) {
      if (owner.totals.has(row.day)) throw Error('归属日合计重复，请保留记录核对。');
      owner.totals.set(row.day, row.dailyTotal);
    }
    if (row.id === null) continue;
    let account = owner.accounts.get(row.id);
    if (!account) { account = { id: row.id, email: row.email, costs: new Map() }; owner.accounts.set(row.id, account); }
    else if (row.email && (!row.email.startsWith('平台用户 ID ') || account.email.startsWith('平台用户 ID ')))
      account.email = row.email;
    if (account.costs.has(row.day)) throw Error('账号日期重复，请保留记录核对。');
    account.costs.set(row.day, row.cost);
  }
  if (owners.size !== data.people) throw Error('归属人数量与导出范围不一致，请重新读取。');
  const accountRows = [...owners.values()].reduce((count, owner) => count + owner.accounts.size, 0);
  const sheetRows = 2 + accountRows + owners.size * 2 + (owners.size > 1 ? 1 : 0) + 1;
  if (sheetRows * (dates.length + 3) > MAX_WIDE_CELLS)
    throw Error('横向日表过大，请缩短导出日期范围。');
  const statusText = ({ phases, backfilled }) => {
    const label = phases.has('待补齐') ? '待补齐' : phases.has('进行中') ? '进行中' :
      phases.has('单账号回填') ? '部分已记录' :
      phases.has('已固定') && phases.has('未记录') ? '部分已记录' :
      phases.has('已固定') ? '已固定' : phases.has('未到') ? '未到' : '未记录';
    return backfilled ? `${label} · 回填` : label;
  };
  return { dates, owners: [...owners.values()], accountRows,
    statuses: dates.map(day => statusText(dayStatus.get(day))) };
}

async function exportWorkbook(data, groupData) {
  const layout = wideLayout(data);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cheapi Feishu Bot';
  const sheet = workbook.addWorksheet('用量明细', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 2, showGridLines: false }]
  });
  const lastColumn = layout.dates.length + 3;
  sheet.getColumn(1).width = 22;
  sheet.getColumn(2).width = 38;
  for (let column = 3; column <= lastColumn; column++) {
    sheet.getColumn(column).width = column === lastColumn ? 26 : 21;
    sheet.getColumn(column).numFmt = amountFormat;
  }
  const header = sheet.addRow(['归属姓名', '平台账号邮箱',
    ...layout.dates.map(day => new Date(`${day}T00:00:00Z`)), '期间已记录小计（USD）']);
  header.height = 30;
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF285A79' } };
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  for (let column = 3; column < lastColumn; column++) header.getCell(column).numFmt = 'yyyy-mm-dd';
  const statuses = sheet.addRow(['日期状态', null, ...layout.statuses, null]);
  statuses.height = 25;
  statuses.eachCell({ includeEmpty: true }, cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1F6' } };
    cell.font = { name: 'Arial', size: 9, color: { argb: 'FF36536A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  const sumKnown = values => values.some(value => typeof value === 'number') ?
    values.reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0) : null;
  const grandTotals = Array(layout.dates.length).fill(null);
  let stripe = 0;
  for (const owner of layout.owners) {
    const band = sheet.addRow([owner.name]);
    band.height = 23;
    for (let column = 1; column <= lastColumn; column++) {
      const cell = band.getCell(column);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5D9CC5' } };
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle' };
    }
    const emails = new Map();
    for (const account of owner.accounts.values()) emails.set(account.email, (emails.get(account.email) || 0) + 1);
    let first = true;
    for (const account of owner.accounts.values()) {
      const values = layout.dates.map(day => account.costs.get(day) ?? null);
      const email = emails.get(account.email) > 1 ? `${account.email}（ID ${account.id}）` : account.email;
      const row = sheet.addRow([owner.name, email, ...values, sumKnown(values)]);
      row.height = 23;
      row.font = { name: 'Arial', size: 10, color: { argb: 'FF273640' } };
      if (stripe++ % 2 === 1) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F9FB' } };
      if (first) {
        row.getCell(1).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF17517A' } };
        row.eachCell({ includeEmpty: true }, cell => {
          cell.border = { top: { style: 'thin', color: { argb: 'FF92BDD7' } } };
        });
        first = false;
      }
      for (let column = 3; column <= lastColumn; column++) {
        const cell = row.getCell(column);
        cell.numFmt = amountFormat;
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        if (typeof cell.value === 'number') cell.font = { name: 'Arial', size: 10, color: { argb: 'FF149652' } };
      }
    }
    const totals = layout.dates.map((day, index) => {
      const value = owner.totals.get(day) ?? null;
      if (typeof value === 'number') grandTotals[index] = (grandTotals[index] ?? 0) + value;
      return value;
    });
    const subtotal = sheet.addRow([owner.name, '归属人合计', ...totals, sumKnown(totals)]);
    subtotal.height = 27;
    subtotal.eachCell({ includeEmpty: true }, cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F2F9' } };
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF167B49' } };
      cell.border = { top: { style: 'thin', color: { argb: 'FF428BB3' } },
        bottom: { style: 'thin', color: { argb: 'FFB7CFDD' } } };
    });
    subtotal.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEE75' } };
    for (let column = 3; column <= lastColumn; column++) {
      subtotal.getCell(column).numFmt = amountFormat;
      subtotal.getCell(column).alignment = { vertical: 'middle', horizontal: 'right' };
    }
  }
  if (layout.owners.length > 1) {
    const grand = sheet.addRow(['全部归属', '按归属合计', ...grandTotals, sumKnown(grandTotals)]);
    grand.height = 29;
    grand.eachCell({ includeEmpty: true }, cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF285A79' } };
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    });
    for (let column = 3; column <= lastColumn; column++) {
      grand.getCell(column).numFmt = amountFormat;
      grand.getCell(column).alignment = { vertical: 'middle', horizontal: 'right' };
    }
  }
  const note = sheet.addRow(['空白表示未记录或不在归属期；0.0000 才是实际零。进行中、待补齐和部分已记录的合计仅是已记录小计；回填不证明历史归属。全部归属合计按档案求和，共用账号可能重复。']);
  note.height = 54;
  sheet.mergeCells(note.number, 1, note.number, Math.min(lastColumn, 6));
  note.getCell(1).font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF536B7A' } };
  note.getCell(1).alignment = { vertical: 'middle', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: note.number - 1, column: lastColumn } };
  appendGroupSheet(workbook, data, groupData);
  return workbook.xlsx.writeBuffer();
}

module.exports = { exportRows, exportWorkbook, wideLayout, MAX_DAYS, MAX_ROWS, MAX_WIDE_CELLS };
