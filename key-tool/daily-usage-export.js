'use strict';
const ExcelJS = require('exceljs');
const { dayKey } = require('./daily-usage');
const { historyCatalog } = require('./daily-usage-history');

const DAY_MS = 24 * 60 * 60_000;
const MAX_DAYS = 366;
const MAX_ROWS = 150_000;
const phaseLabel = { future: '未到', missing: '未记录', ongoing: '进行中', final: '已固定' };

function exportRows(state, input, today, currentNames = []) {
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
      const phase = day > today ? 'future' : !profile ? 'missing' : snapshot.final ? 'final' : 'ongoing';
      const users = profile?.users || [];
      const total = profile ? users.reduce((sum, user) => sum + user.cost, 0) : null;
      const source = profile ? snapshot.source === 'backfill-current-ownership' ? '按当前归属回填' : '定时采集' : '';
      const checkedAt = profile ? snapshot.checkedAt : null;
      for (const [index, user] of (users.length ? users : [null]).entries()) {
        rows.push({ day, name, id: user?.id ?? null, email: user?.email ?? '', cost: user?.cost ?? null,
          dailyTotal: index === 0 ? total : null, phase: phaseLabel[phase],
          totalKind: index === 0 && profile ? snapshot.final ? '完整日' : '已记录小计' : '',
          source, checkedAt });
        if (rows.length > MAX_ROWS) throw Error('导出行数过多，请缩短日期范围后重试。');
      }
    }
  }
  return { rows, count, people: selected.length, start, end };
}

async function exportWorkbook(data) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cheapi Feishu Bot';
  const sheet = workbook.addWorksheet('用量明细', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 1, showGridLines: false }]
  });
  sheet.columns = [
    { header: '日期（北京时间）', key: 'day', width: 20, style: { numFmt: 'yyyy-mm-dd' } },
    { header: '归属人', key: 'name', width: 24 },
    { header: '平台用户ID', key: 'id', width: 18 },
    { header: '平台账号邮箱', key: 'email', width: 34 },
    { header: '用户实付（USD）', key: 'cost', width: 20, style: { numFmt: '#,##0.0000' } },
    { header: '归属人当日合计（USD）', key: 'dailyTotal', width: 27, style: { numFmt: '#,##0.0000' } },
    { header: '日期状态', key: 'phase', width: 15 },
    { header: '合计口径', key: 'totalKind', width: 18 },
    { header: '采集来源', key: 'source', width: 22 },
    { header: '采样时间（北京时间）', key: 'checkedAt', width: 26, style: { numFmt: 'yyyy-mm-dd hh:mm' } }
  ];
  sheet.getRow(1).font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF28563F' } };
  sheet.getRow(1).height = 27;
  for (const row of data.rows) {
    sheet.addRow({ day: new Date(`${row.day}T00:00:00Z`), name: row.name,
      id: row.id === null ? null : String(row.id), email: row.email, cost: row.cost,
      dailyTotal: row.dailyTotal, phase: row.phase, totalKind: row.totalKind, source: row.source,
      checkedAt: row.checkedAt ? new Date(Date.parse(row.checkedAt) + 8 * 60 * 60_000) : null });
  }
  sheet.autoFilter = { from: 'A1', to: 'J1' };
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    row.font = { name: 'Arial', size: 10, color: { argb: 'FF263C31' } };
    if (number % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7F2' } };
  });
  return workbook.xlsx.writeBuffer();
}

module.exports = { exportRows, exportWorkbook, MAX_DAYS, MAX_ROWS };
