'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { exportRows, exportWorkbook } = require('./daily-usage-export');

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

test('XLSX roundtrip keeps numeric zero, missing blank, filters, frozen identifiers and text cells', async () => {
  const data = exportRows(state, { scope: 'all', start: '2026-11-02', end: '2026-11-05' }, today);
  const buffer = await exportWorkbook(data);
  assert.ok(buffer.length > 2000);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  assert.equal(book.worksheets.length, 1);
  const sheet = book.getWorksheet('用量明细');
  assert.equal(sheet.rowCount, 10);
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].xSplit, 2);
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.views[0].showGridLines, false);
  assert.equal(sheet.autoFilter, 'A1:J1');
  assert.equal(sheet.getCell('E2').value, 0);
  assert.equal(sheet.getCell('F2').value, 0);
  assert.equal(sheet.getCell('F5').value, null);
  assert.equal(sheet.getCell('E8').value, null);
  assert.equal(sheet.getCell('D7').value, '=1+1@example.invalid');
  assert.equal(sheet.getCell('D7').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('J2').value instanceof Date, true);
});
