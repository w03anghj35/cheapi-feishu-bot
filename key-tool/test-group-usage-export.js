'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { exportWorkbook } = require('./daily-usage-export');

const data = { start: '2026-11-02', end: '2026-11-03', count: 2, people: 1, rows: [
  { day: '2026-11-02', name: '甲', id: 1, email: 'one@example.invalid', cost: 1.25,
    dailyTotal: 1.25, phase: '已固定', source: '定时采集' },
  { day: '2026-11-03', name: '甲', id: 1, email: 'one@example.invalid', cost: null,
    dailyTotal: null, phase: '未记录', source: '' }
] };
const details = { start: data.start, end: data.end, complete: true,
  days: [{ day: '2026-11-02', phase: 'final' }, { day: '2026-11-03', phase: 'final' }],
  groups: [{ id: 7, name: '甲组' }, { id: 8, name: '=1+1' }],
  rows: [{ name: '甲', id: 1, email: 'one@example.invalid',
    allowedGroups: [{ id: 7, name: '甲组' }],
    values: [{ '7': '0.00000001', '8': '1.25' }, null] }] };

test('group sheet preserves eight decimals, blanks and current access as distinct from historical use', async () => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await exportWorkbook(data, details));
  assert.equal(book.worksheets.length, 2);
  const sheet = book.getWorksheet('分组用量');
  assert.equal(sheet.views[0].xSplit, 3);
  assert.equal(sheet.views[0].ySplit, 3);
  assert.equal(sheet.getCell('A1').value, '归属姓名');
  assert.equal(sheet.getCell('D1').value.toISOString().slice(0, 10), '2026-11-02');
  assert.equal(sheet.getCell('D2').value, '甲组（ID 7）');
  assert.equal(sheet.getCell('E2').value, '=1+1（ID 8）');
  assert.equal(sheet.getCell('E2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('B5').value, 'one@example.invalid');
  assert.equal(sheet.getCell('C5').value, '甲组（ID 7）');
  assert.equal(sheet.getCell('D5').value, '0.00000001');
  assert.equal(sheet.getCell('E5').value, '1.25');
  assert.equal(sheet.getCell('D5').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('F5').value, null);
  assert.equal(sheet.getCell('G5').value, null);
  assert.match(sheet.getCell('A6').value, /八位十进制精度/);
});

test('group sheet writes real zero after complete read, but never fills a missing membership day', async () => {
  const value = structuredClone(details);
  value.rows[0].values = [{}, null];
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await exportWorkbook(data, value));
  const sheet = book.getWorksheet('分组用量');
  assert.equal(sheet.getCell('D5').value, '0');
  assert.equal(sheet.getCell('E5').value, '0');
  assert.equal(sheet.getCell('F5').value, null);
});

test('group sheet rejects partial, wrong-date, unauthorized and oversized data before producing an export', async () => {
  await assert.rejects(exportWorkbook(data, { ...details, complete: false }), /不一致/);
  await assert.rejects(exportWorkbook(data, { ...details, end: '2026-11-04' }), /不一致/);
  await assert.rejects(exportWorkbook(data, { ...details, rows: [{ ...details.rows[0], id: 999 }] }), /不在导出范围/);
  await assert.rejects(exportWorkbook(data, { ...details, rows: [{ ...details.rows[0],
    values: [{ '7': '0.123456789' }, null] }] }), /金额/);
  const long = { start: '2026-01-01', end: '2026-02-01', count: 32, people: 1, rows: [
    { ...data.rows[0], day: '2026-01-01' }
  ] };
  await assert.rejects(exportWorkbook(long, { ...details, start: long.start, end: long.end }), /不一致/);
});
