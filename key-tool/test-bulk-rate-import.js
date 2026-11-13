'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { readBulkRateSelectionFile } = require('./bulk-rate-import');

function dirFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-rate-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(dir, name, content) {
  const file = path.join(dir, name); fs.writeFileSync(file, content); return file;
}

test('TXT 从任意文本提取完整邮箱，支持一行多个、忽略重复和用户名', async t => {
  const file = write(dirFor(t), 'selection.txt',
    '\uFEFF虚构甲：one@example.invalid、two@example.invalid\r\n仅用户名\nONE@example.invalid\nabc@bad\n');
  const parsed = await readBulkRateSelectionFile(file);
  assert.equal(parsed.fileType, 'txt');
  assert.deepEqual(parsed.entries, [
    { row: 1, email: 'one@example.invalid' },
    { row: 1, email: 'two@example.invalid' }
  ]);
});

test('CSV 从任意列提取邮箱，不依赖表头，正确处理引号与换行', async t => {
  const file = write(dirFor(t), 'selection.csv',
    '姓名,说明,数据\r\n虚构甲,"邮件 one@example.invalid, two@example.invalid",100\r\n虚构乙,"联系\r\nthree@example.invalid",200\r\n');
  const parsed = await readBulkRateSelectionFile(file);
  assert.deepEqual(parsed.entries, [
    { row: 2, email: 'one@example.invalid' },
    { row: 2, email: 'two@example.invalid' },
    { row: 3, email: 'three@example.invalid' }
  ]);
  assert.equal(parsed.rowsRead, 3);
});

test('XLSX 只读第一个工作表任意单元格，拒绝公式且不修改文件', async t => {
  const dir = dirFor(t), file = path.join(dir, 'selection.xlsx');
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('用户');
  sheet.addRow(['姓名', '备注', '金额']);
  sheet.addRow(['虚构甲', 'user1@example.invalid 和 user2@example.invalid', 900]);
  sheet.addRow(['虚构乙', '邮箱：user3@example.invalid', 800]);
  book.addWorksheet('其他').addRow(['not-included@example.invalid']);
  await book.xlsx.writeFile(file);
  const before = fs.readFileSync(file);
  const parsed = await readBulkRateSelectionFile(file);
  assert.deepEqual(parsed.entries, [
    { row: 2, email: 'user1@example.invalid' },
    { row: 2, email: 'user2@example.invalid' },
    { row: 3, email: 'user3@example.invalid' }
  ]);
  assert.deepEqual(fs.readFileSync(file), before);
  sheet.getCell('B2').value = { formula: '1+1', result: 'user1@example.invalid' };
  await book.xlsx.writeFile(file);
  await assert.rejects(readBulkRateSelectionFile(file), /公式/);
});

test('拒绝超大、空、非 UTF-8、损坏和不支持的文件', async t => {
  const dir = dirFor(t);
  await assert.rejects(readBulkRateSelectionFile(write(dir, 'empty.txt', '')), /普通文件/);
  await assert.rejects(readBulkRateSelectionFile(write(dir, 'huge.txt', Buffer.alloc(2 * 1024 * 1024 + 1))), /普通文件/);
  await assert.rejects(readBulkRateSelectionFile(write(dir, 'gbk.txt', Buffer.from([0xff, 0xfe]))), /UTF-8/);
  await assert.rejects(readBulkRateSelectionFile(write(dir, 'broken.csv', '邮箱\n"a@example.invalid')), /引号/);
  await assert.rejects(readBulkRateSelectionFile(write(dir, 'broken.xlsx', 'not-an-excel')), /Excel 文件无法读取/);
  await assert.rejects(readBulkRateSelectionFile(write(dir, 'selection.docx', 'anything')), /仅支持/);
});

test('无完整邮箱拒绝、超长内容和行数上限拒绝，公式样文本不作为邮箱', async t => {
  const dir = dirFor(t);
  await assert.rejects(readBulkRateSelectionFile(write(dir, 'no-email.txt', '虚构甲\n42\nabc@bad')), /完整邮箱/);
  await assert.rejects(readBulkRateSelectionFile(write(dir, 'too-long.txt', 'A'.repeat(2049))), /过长/);
  await assert.rejects(readBulkRateSelectionFile(write(dir, 'too-many.txt', '虚构甲\n'.repeat(5001))), /最多读取/);
  await assert.rejects(readBulkRateSelectionFile(write(dir, 'formula.txt', '=HYPERLINK("http://example.invalid", "a@example.invalid")')), /完整邮箱/);
});
