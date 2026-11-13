'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { extractDocumentEmails } = require('./bulk-rate-document-extract');

function fixture(t, name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-rate-document-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file;
}

async function makeDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function makePdf(text, { count = 1, width = 612, height = 792 } = {}) {
  const safe = text.replace(/[\\()]/g, '\\$&');
  const stream = `BT /F1 16 Tf 72 700 Td (${safe}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${'3 0 R '.repeat(count)}] /Count ${count} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function makeImagePdf(image, width, height, extraText = '') {
  const drawing = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q` +
    (extraText ? ` BT /F1 16 Tf 72 15 Td (${extraText}) Tj ET` : ''));
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im1 4 0 R >> ${extraText ? '/Font << /F1 6 0 R >>' : ''} >> /Contents 5 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Length ${drawing.length} >>\nstream\n`), drawing, Buffer.from('\nendstream')]),
    ...(extraText ? [Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')] : [])
  ];
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let offset = parts[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(offset);
    const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), objects[index], Buffer.from('\nendobj\n')]);
    parts.push(bytes); offset += bytes.length;
  }
  const start = offset;
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (let index = 1; index < offsets.length; index++) parts.push(Buffer.from(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`));
  parts.push(Buffer.from(`trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${start}\n%%EOF\n`));
  return Buffer.concat(parts);
}

test('DOCX extracts full email candidates locally without modifying source', async t => {
  const file = fixture(t, 'list.docx', await makeDocx('one@example.invalid two@example.invalid'));
  const before = fs.readFileSync(file);
  const result = await extractDocumentEmails(file);
  assert.equal(result.fileType, 'docx');
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.entries.map(row => row.email), ['one@example.invalid', 'two@example.invalid']);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('DOCX macro payload and huge expanded zip are rejected before conversion', async t => {
  const macro = await makeDocx('one@example.invalid');
  const zip = await JSZip.loadAsync(macro);
  zip.file('word/vbaProject.bin', Buffer.from([1, 2, 3]));
  await assert.rejects(extractDocumentEmails(fixture(t, 'macro.docx', await zip.generateAsync({ type: 'nodebuffer' }))), /安全读取/);
  const large = await JSZip.loadAsync(macro);
  large.file('huge.txt', 'x'.repeat(21 * 1024 * 1024));
  await assert.rejects(extractDocumentEmails(fixture(t, 'large.docx', await large.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))), /展开后过大/);
});

test('text PDF extracts email candidate, blank PDF fails explicitly', async t => {
  const result = await extractDocumentEmails(fixture(t, 'list.pdf', makePdf('pdf@example.invalid')));
  assert.equal(result.fileType, 'pdf');
  assert.equal(result.needsReview, true);
  assert.equal(result.ocrUsed, false);
  assert.deepEqual(result.entries, [{ row: 1, email: 'pdf@example.invalid' }]);
  await assert.rejects(extractDocumentEmails(fixture(t, 'blank.pdf', makePdf('No addresses'))), /没有完整邮箱/);
});

test('PDF page count and rendered pixel budget reject without returning partial candidates', async t => {
  const tooMany = makePdf('first@example.invalid', { count: 21 });
  await assert.rejects(extractDocumentEmails(fixture(t, 'pages.pdf', tooMany)), /最多支持 20 页/);
  const hugePage = makePdf('No addresses', { width: 2000, height: 2000 });
  await assert.rejects(extractDocumentEmails(fixture(t, 'pixels.pdf', hugePage)), /页面像素过大/);
});

test('scanned PDF locally renders page and OCRs email candidate', { timeout: 60000 }, async t => {
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(1100, 130), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1100, 130);
  ctx.fillStyle = '#000'; ctx.font = 'bold 54px Arial';
  ctx.fillText('scan@example.com', 16, 84);
  const image = await canvas.encode('jpeg');
  const result = await extractDocumentEmails(fixture(t, 'scan.pdf', makeImagePdf(image, 1100, 130)));
  assert.equal(result.fileType, 'pdf');
  assert.equal(result.needsReview, true);
  assert.equal(result.ocrUsed, true);
  assert.deepEqual(result.entries, [{ row: 1, email: 'scan@example.com' }]);
});

test('mixed text and scanned image PDF finds both email candidates', { timeout: 60000 }, async t => {
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(1100, 130), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1100, 130);
  ctx.fillStyle = '#000'; ctx.font = 'bold 54px Arial';
  ctx.fillText('image@example.com', 16, 84);
  const image = await canvas.encode('jpeg');
  const result = await extractDocumentEmails(fixture(t, 'mixed.pdf',
    makeImagePdf(image, 1100, 160, 'layer@example.com')));
  assert.equal(result.ocrUsed, true);
  assert.deepEqual(result.entries.map(row => row.email).sort(), ['image@example.com', 'layer@example.com']);
});

test('image signature and pixel limits reject before OCR; no network fallback', async t => {
  await assert.rejects(extractDocumentEmails(fixture(t, 'wrong.png', Buffer.from('not a png'))), /PNG 图片格式/);
  const png = Buffer.alloc(32);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.write('IHDR', 12); png.writeUInt32BE(10000, 16); png.writeUInt32BE(10000, 20);
  await assert.rejects(extractDocumentEmails(fixture(t, 'huge.png', png)), /像素过大/);
  await assert.rejects(extractDocumentEmails(fixture(t, 'wrong.jpg', Buffer.from('not a jpg'))), /JPG 图片格式/);
});

test('local English OCR recognizes a clean synthetic PNG email', { timeout: 60000 }, async t => {
  let canvas;
  try { canvas = require('@napi-rs/canvas'); }
  catch { t.skip('optional local canvas test fixture unavailable'); return; }
  const board = canvas.createCanvas(1100, 130), ctx = board.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1100, 130);
  ctx.fillStyle = '#000000'; ctx.font = 'bold 54px Arial';
  ctx.fillText('ocr@example.com', 16, 84);
  const result = await extractDocumentEmails(fixture(t, 'mail.png', await board.encode('png')));
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.entries.map(row => row.email), ['ocr@example.com']);
});

test('local English OCR recognizes a clean synthetic JPG email', { timeout: 60000 }, async t => {
  let canvas;
  try { canvas = require('@napi-rs/canvas'); }
  catch { t.skip('optional local canvas test fixture unavailable'); return; }
  const board = canvas.createCanvas(1100, 130), ctx = board.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1100, 130);
  ctx.fillStyle = '#000000'; ctx.font = 'bold 54px Arial';
  ctx.fillText('jpeg@example.com', 16, 84);
  const result = await extractDocumentEmails(fixture(t, 'mail.jpeg', await board.encode('jpeg')));
  assert.equal(result.fileType, 'jpg');
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.entries.map(row => row.email), ['jpeg@example.com']);
});
