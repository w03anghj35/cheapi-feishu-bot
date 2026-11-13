'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 32;
const MAX_VALUE_LENGTH = 2048;
const MAX_ENTRIES = 5000;
const EMAIL = /[a-z\d!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z\d!#$%&'*+/=?^_`{|}~-]+)*@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+/gi;

function fail(message) { throw Error(message); }
function asText(value) {
  if (value == null) return '';
  if (typeof value === 'object' && value.formula !== undefined)
    fail('文件含公式单元格，请改为纯文本后重试。');
  if (typeof value === 'object' && Array.isArray(value.richText))
    value = value.richText.map(part => part.text || '').join('');
  else if (typeof value === 'object' && typeof value.text === 'string') value = value.text;
  if (typeof value !== 'string') return '';
  const text = value.replace(/^\uFEFF/, '').trim();
  if (text.length > MAX_VALUE_LENGTH || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text))
    fail('文件有过长或非法文本，请检查后重试。');
  return text;
}
function emails(text) {
  if (!text || /^=/.test(text)) return [];
  const found = [];
  for (const match of text.matchAll(EMAIL)) {
    const email = match[0];
    const before = text[match.index - 1] || '';
    const after = text[match.index + email.length] || '';
    if (email.length <= 254 && !/[a-z\d.!#$%&'*+/=?^_`{|}~@-]/i.test(before) &&
        !/[a-z\d.@-]/i.test(after)) found.push(email);
  }
  return found;
}
function collect(rows) {
  const entries = [], seen = new Set();
  if (rows.length > MAX_ROWS) fail(`文件最多读取 ${MAX_ROWS} 行用户。`);
  for (const row of rows) {
    if (row.cells.length > MAX_COLUMNS) fail(`文件每行最多支持 ${MAX_COLUMNS} 列。`);
    for (const cell of row.cells) {
      for (const email of emails(asText(cell))) {
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key); entries.push({ row: row.row, email });
        if (entries.length > MAX_ENTRIES) fail(`文件最多读取 ${MAX_ENTRIES} 个邮箱。`);
      }
    }
  }
  if (!entries.length) fail('文件没有可识别的完整邮箱，请检查内容。');
  return { entries, rowsRead: rows.length };
}
function parseCsv(text) {
  const rows = []; let cells = [], cell = '', quoted = false, closed = false, rowNo = 1;
  function finishCell() { cells.push(cell); cell = ''; closed = false; if (cells.length > MAX_COLUMNS) fail(`文件每行最多支持 ${MAX_COLUMNS} 列。`); }
  function finishRow() { finishCell(); rows.push({ row: rowNo++, cells }); cells = []; if (rows.length > MAX_ROWS) fail(`文件最多读取 ${MAX_ROWS} 行用户。`); }
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') {
      if (cell || closed) fail('CSV 引号格式不正确。');
      quoted = true; closed = true;
    } else if (char === ',') finishCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      finishRow();
    } else {
      if (closed && !/\s/.test(char)) fail('CSV 引号后包含意外字符。');
      cell += char;
    }
  }
  if (quoted) fail('CSV 引号没有闭合。');
  if (cells.length || cell || (!rows.length && text)) finishRow();
  return rows;
}
async function readBulkRateSelectionFile(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) fail('请选择本机用户清单文件。');
  const ext = path.extname(filePath).toLowerCase();
  if (!['.txt', '.csv', '.xlsx'].includes(ext)) fail('仅支持 TXT、CSV 或 Excel .xlsx 用户清单。');
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES)
    fail(`请选择不超过 ${MAX_BYTES / 1024 / 1024} MB 的普通文件。`);
  const bytes = await fs.readFile(filePath);
  if (!bytes.length || bytes.length > MAX_BYTES) fail('文件大小已变化，请重新选择。');
  let rows;
  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(bytes); }
    catch { fail('Excel 文件无法读取或结构损坏，请另存为 .xlsx 后重试。'); }
    const sheet = workbook.worksheets[0];
    if (!sheet) fail('Excel 文件没有工作表。');
    if (sheet.rowCount > MAX_ROWS) fail(`只读取第一个工作表，最多 ${MAX_ROWS} 行用户。`);
    rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (row.cellCount > MAX_COLUMNS) fail(`文件每行最多支持 ${MAX_COLUMNS} 列。`);
      const cells = [];
      for (let index = 1; index <= row.cellCount; index++) cells.push(row.getCell(index).value);
      rows.push({ row: rowNumber, cells });
    });
  } else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
    catch { fail('文本文件需要保存为 UTF-8 编码。'); }
    rows = ext === '.csv' ? parseCsv(text) : text.split(/\r\n|\n|\r/).map((line, index) => ({ row: index + 1, cells: [line] }));
  }
  return { ...collect(rows), fileType: ext.slice(1) };
}

module.exports = { readBulkRateSelectionFile };
