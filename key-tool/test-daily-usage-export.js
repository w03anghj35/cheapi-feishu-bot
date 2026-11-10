'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { exportRows, exportWorkbook, wideLayout } = require('./daily-usage-export');

const today = '2026-11-04';
const snapshot = (day, rows, final = true, source) => ({ day, checkedAt: `${day}T08:30:00Z`, final, rows, source });
const state = { snapshots: {
  '2026-11-02': snapshot('2026-11-02', [
    { name: '甲', users: [{ id: 1, email: 'one@example.invalid', cost: 0 }] },
    { name: '乙', users: [{ id: 2, email: 'two@example.invalid', cost: 3.5 }] }
  ], true, 'backfill-current-ownership'),
  '2026-11-03': snapshot('2026-11-03', [{ name: '甲', users: [] }]),
  '2026-11-04': snapshot('2026-11-04', [{ name: '甲', users: [
    { id: 1, email: 'one@example.invalid', cost: 1.25 },
    { id: 3, email: '=1+1@example.invalid', cost: 2 }
  ] }], false)
} };

test('date export separates real zero, missing person, empty profile and ongoing subtotal', () => {
  const result = exportRows(state, { scope: 'all', start: '2026-11-02', end: '2026-11-05' }, today);
  assert.equal(result.people, 2);
  assert.equal(result.count, 4);
  assert.equal(result.rows.length, 9);
  const find = (day, name, id = null) => result.rows.find(row => row.day === day && row.name === name && row.id === id);
  assert.equal(find('2026-11-02', '甲', 1).cost, 0);
  assert.equal(find('2026-11-02', '甲', 1).dailyTotal, 0);
  assert.equal(find('2026-11-02', '甲', 1).source, '按当前归属回填');
  assert.equal(find('2026-11-03', '甲').dailyTotal, 0);
  assert.equal(find('2026-11-03', '乙').phase, '未记录');
  assert.equal(find('2026-11-03', '乙').dailyTotal, null);
  assert.equal(find('2026-11-04', '甲', 1).dailyTotal, 3.25);
  assert.equal(find('2026-11-04', '甲', 1).totalKind, '已记录小计');
  assert.equal(find('2026-11-04', '甲', 3).dailyTotal, null);
  assert.equal(find('2026-11-05', '甲').phase, '未到');
  assert.equal(find('2026-11-05', '甲').dailyTotal, null);
  const single = exportRows(state, { scope: 'person', name: '乙', start: '2026-11-02', end: '2026-11-05' }, today);
  assert.equal(single.rows.every(row => row.name === '乙'), true);
  assert.equal(single.rows.length, 4);
});

test('date export rejects reversed, excessive and unauthorized ranges', () => {
  const base = { scope: 'person', name: '甲', start: '2026-11-02', end: '2026-11-03' };
  assert.throws(() => exportRows(state, { ...base, name: '不存在' }, today));
  assert.throws(() => exportRows(state, { ...base, start: '2026-11-04' }, today));
  assert.throws(() => exportRows(state, { ...base, start: '2025-01-01' }, today));
  assert.throws(() => exportRows(state, { ...base, start: '2026-02-30' }, today));
  assert.throws(() => exportRows(state, { ...base, scope: 'other' }, today));
  assert.throws(() => exportRows({ snapshots: {} }, { ...base, scope: 'all' }, today));
});
test('past partial day export says pending finalization while preserving recorded subtotal', () => {
  const data = exportRows(state, { scope: 'person', name: '甲', start: '2026-11-04', end: '2026-11-04' }, '2026-11-09');
  assert.equal(data.rows[0].phase, '待补齐');
  assert.equal(data.rows[0].totalKind, '已记录小计');
  assert.equal(data.rows[0].cost, 1.25);
});

test('XLSX roundtrip has names at left, one selected date per column, and owner/daily totals', async () => {
  const data = exportRows(state, { scope: 'all', start: '2026-11-02', end: '2026-11-05' }, today);
  const layout = wideLayout(data);
  assert.equal(layout.accountRows, 3);
  assert.deepEqual(layout.dates, ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
  assert.deepEqual(layout.statuses, ['已固定 · 回填', '部分已记录', '进行中', '未到']);
  const buffer = await exportWorkbook(data);
  assert.ok(buffer.length > 2000);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  assert.equal(book.worksheets.length, 1);
  const sheet = book.getWorksheet('用量明细');
  assert.equal(sheet.rowCount, 11);
  assert.equal(sheet.columnCount, 7);
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].xSplit, 2);
  assert.equal(sheet.views[0].ySplit, 2);
  assert.equal(sheet.views[0].showGridLines, false);
  assert.equal(sheet.autoFilter, 'A1:G10');
  assert.equal(sheet.getCell('A1').value, '归属姓名');
  assert.equal(sheet.getCell('B1').value, '平台账号邮箱');
  assert.equal(sheet.getCell('C1').value instanceof Date, true);
  assert.equal(sheet.getCell('C1').value.toISOString().slice(0, 10), '2026-11-02');
  assert.equal(sheet.getCell('F1').value.toISOString().slice(0, 10), '2026-11-05');
  assert.equal(sheet.getCell('C1').numFmt, 'yyyy-mm-dd');
  assert.equal(sheet.getCell('C2').value, '已固定 · 回填');
  assert.equal(sheet.getCell('E2').value, '进行中');
  assert.equal(sheet.getCell('B2').value, null);
  assert.equal(sheet.getCell('G2').value, null);
  assert.equal(sheet.getCell('A3').value, '甲');
  assert.equal(sheet.getCell('A3').fill.fgColor.argb, 'FF5D9CC5');
  assert.equal(sheet.getCell('B4').value, 'one@example.invalid');
  assert.equal(sheet.getCell('C4').value, 0, 'real zero remains numeric');
  assert.equal(sheet.getCell('D4').value, null, 'unrecorded day remains blank');
  assert.equal(sheet.getCell('E4').value, 1.25);
  assert.equal(sheet.getCell('G4').value, 1.25);
  assert.equal(sheet.getCell('B5').value, '=1+1@example.invalid');
  assert.equal(sheet.getCell('B5').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('B6').value, '归属人合计');
  assert.equal(sheet.getCell('C6').value, 0);
  assert.equal(sheet.getCell('D6').value, 0, 'empty but recorded profile remains a real zero');
  assert.equal(sheet.getCell('E6').value, 3.25);
  assert.equal(sheet.getCell('F6').value, null);
  assert.equal(sheet.getCell('A7').value, '乙');
  assert.equal(sheet.getCell('C9').value, 3.5);
  assert.equal(sheet.getCell('A10').value, '全部归属');
  assert.equal(sheet.getCell('C10').value, 3.5);
  assert.equal(sheet.getCell('E10').value, 3.25);
  assert.equal(sheet.getCell('G10').value, 6.75);
  assert.match(sheet.getCell('A11').value, /空白表示未记录/);
});

test('single-owner export uses exactly the chosen date columns and no all-owner subtotal', async () => {
  const data = exportRows(state, { scope: 'person', name: '乙', start: '2026-11-02', end: '2026-11-04' }, today);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await exportWorkbook(data));
  const sheet = book.getWorksheet('用量明细');
  assert.equal(sheet.columnCount, 6);
  assert.equal(sheet.rowCount, 6);
  assert.equal(sheet.getCell('C1').value.toISOString().slice(0, 10), '2026-11-02');
  assert.equal(sheet.getCell('E1').value.toISOString().slice(0, 10), '2026-11-04');
  assert.equal(sheet.getCell('B4').value, 'two@example.invalid');
  assert.equal(sheet.getCell('C4').value, 3.5);
  assert.equal(sheet.getCell('D4').value, null);
  assert.equal(sheet.getCell('B5').value, '归属人合计');
  assert.equal(sheet.getCell('A6').value.toString().includes('空白表示'), true);
});

test('same account in two owner groups is visible twice and grand total discloses overlap', async () => {
  const shared = { snapshots: { '2026-11-02': snapshot('2026-11-02', [
    { name: '甲', users: [{ id: 7, email: 'same@example.invalid', cost: 2 }] },
    { name: '乙', users: [{ id: 7, email: 'same@example.invalid', cost: 2 }] }
  ]) } };
  const data = exportRows(shared, { scope: 'all', start: '2026-11-02', end: '2026-11-02' }, today);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await exportWorkbook(data));
  const sheet = book.getWorksheet('用量明细');
  assert.equal(sheet.getCell('C4').value, 2);
  assert.equal(sheet.getCell('C7').value, 2);
  assert.equal(sheet.getCell('C9').value, 4);
  assert.match(sheet.getCell('A10').value, /共用账号可能重复/);
});

test('one day and maximum date span produce exactly the selected date columns', async () => {
  const one = exportRows(state, { scope: 'person', name: '甲', start: '2026-11-02', end: '2026-11-02' }, today);
  const oneBook = new ExcelJS.Workbook(); await oneBook.xlsx.load(await exportWorkbook(one));
  const oneSheet = oneBook.getWorksheet('用量明细');
  assert.equal(oneSheet.columnCount, 4);
  assert.equal(oneSheet.getCell('C1').value.toISOString().slice(0, 10), '2026-11-02');
  assert.equal(oneSheet.getCell('D1').value, '期间已记录小计（USD）');
  const long = exportRows({ snapshots: {} }, { scope: 'person', name: '甲',
    start: '2026-01-01', end: '2027-01-01' }, today, ['甲']);
  assert.equal(long.count, 366);
  const longBook = new ExcelJS.Workbook(); await longBook.xlsx.load(await exportWorkbook(long));
  const longSheet = longBook.getWorksheet('用量明细');
  assert.equal(longSheet.columnCount, 369);
  assert.equal(longSheet.getCell(1, 368).value.toISOString().slice(0, 10), '2027-01-01');
  assert.equal(longSheet.getCell(1, 369).value, '期间已记录小计（USD）');
  assert.equal(longSheet.getCell(5, 368).value, null, 'no history cannot become a zero');
});

test('identical email with different platform IDs remains two rows and text names never become formulas', async () => {
  const special = { snapshots: { '2026-11-02': snapshot('2026-11-02', [
    { name: '=1+1', users: [{ id: 7, email: 'same@example.invalid', cost: 1 },
      { id: 8, email: 'same@example.invalid', cost: 2 }] }
  ]) } };
  const data = exportRows(special, { scope: 'all', start: '2026-11-02', end: '2026-11-02' }, today);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await exportWorkbook(data));
  const sheet = book.getWorksheet('用量明细');
  assert.equal(sheet.getCell('A4').value, '=1+1');
  assert.equal(sheet.getCell('A4').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('B4').value, 'same@example.invalid（ID 7）');
  assert.equal(sheet.getCell('B5').value, 'same@example.invalid（ID 8）');
  assert.equal(sheet.getCell('C6').value, 3);
});

test('wide export rejects duplicate account-days and an oversized pivot before writing a workbook', () => {
  const day = '2026-11-02';
  const record = { day, name: '甲', id: 7, email: 'u7@example.invalid', cost: 1,
    dailyTotal: 1, phase: '已固定', source: '定时采集' };
  const duplicate = { start: day, count: 1, people: 1, rows: [record, { ...record, dailyTotal: null }] };
  assert.throws(() => wideLayout(duplicate), /账号日期重复/);
  const oversized = { start: '2026-01-01', count: 366, people: 1,
    rows: Array.from({ length: 1400 }, (_, index) => ({ ...record, day: '2026-01-01',
      id: index + 1, email: `u${index + 1}@example.invalid`, dailyTotal: index ? null : 1400 })) };
  assert.throws(() => wideLayout(oversized), /横向日表过大/);
});

test('a later missing-day ID fallback never replaces an earlier verified email', () => {
  const layout = wideLayout({ start: '2026-11-02', count: 2, people: 1, rows: [
    { day: '2026-11-02', name: '甲', id: 7, email: 'verified@example.invalid', cost: 2,
      dailyTotal: 2, phase: '已固定', source: '定时采集' },
    { day: '2026-11-03', name: '甲', id: 7, email: '平台用户 ID 7', cost: null,
      dailyTotal: null, phase: '未记录', source: '' }
  ] });
  assert.equal(layout.owners[0].accounts.get(7).email, 'verified@example.invalid');
  assert.equal(layout.owners[0].accounts.get(7).costs.get('2026-11-03'), null);
});
