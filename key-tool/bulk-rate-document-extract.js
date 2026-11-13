'use strict';

// Local-only candidate extraction. The caller must show the candidates for
// review and must never treat OCR or PDF text as authorization to change rates.
const fs = require('node:fs/promises');
const path = require('node:path');
const mammoth = require('mammoth');
const JSZip = require('jszip');

const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_DOCX_UNCOMPRESSED = 20 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 200;
const MAX_TEXT_CHARS = 200_000;
const MAX_PDF_PAGES = 20;
const MAX_PDF_RENDER_PIXELS = 3_000_000;
const PDF_TIMEOUT_MS = 60_000;
const MAX_IMAGE_PIXELS = 12_000_000;
const MAX_IMAGE_SIDE = 7000;
const OCR_TIMEOUT_MS = 45_000;
const EMAIL = /[a-z\d!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z\d!#$%&'*+/=?^_`{|}~-]+)*@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+/gi;

function fail(message) { throw Error(message); }

function findEmails(text, row, entries, seen) {
  for (const match of text.matchAll(EMAIL)) {
    const email = match[0];
    const before = text[match.index - 1] || '';
    const after = text[match.index + email.length] || '';
    if (email.length > 254 || /[a-z\d.!#$%&'*+/=?^_`{|}~@-]/i.test(before) ||
        /[a-z\d.@-]/i.test(after)) continue;
    const key = email.toLowerCase();
    if (!seen.has(key)) { seen.add(key); entries.push({ row, email }); }
    if (entries.length > 5000) fail('文件中邮箱过多，请拆分后重试。');
  }
}

function collectLines(text, fileType) {
  if (text.length > MAX_TEXT_CHARS) fail('文档文字过多，请拆分后重试。');
  const lines = text.split(/\r\n|\n|\r/), entries = [], seen = new Set();
  if (lines.length > 5000) fail('文档行数过多，请拆分后重试。');
  for (let index = 0; index < lines.length; index++) findEmails(lines[index], index + 1, entries, seen);
  if (!entries.length) fail('文档没有可识别的完整邮箱；若是扫描图片，请改用 PNG/JPG 图片导入。');
  return { entries, rowsRead: lines.length, fileType, needsReview: true };
}

async function docxText(bytes) {
  if (bytes.subarray(0, 2).toString() !== 'PK') fail('Word 文件格式不正确，请另存为 .docx。');
  let zip;
  // Do not inflate entries until their declared expanded sizes are checked.
  try { zip = await JSZip.loadAsync(bytes); }
  catch { fail('Word 文件损坏或不是有效的 .docx。'); }
  const files = Object.values(zip.files);
  if (files.length > MAX_DOCX_ENTRIES || !zip.file('word/document.xml') || !zip.file('[Content_Types].xml') ||
      files.some(file => /(?:^|\/)vbaProject\.bin$/i.test(file.name)))
    fail('Word 文件结构不符合安全读取要求。');
  let uncompressed = 0;
  for (const file of files) {
    if (file.dir) continue;
    const size = file._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0) fail('Word 文件大小信息不完整。');
    uncompressed += size;
    if (uncompressed > MAX_DOCX_UNCOMPRESSED) fail('Word 文件展开后过大，请拆分后重试。');
  }
  try {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value || '';
  } catch { fail('Word 文字无法读取，请另存为 .docx 后重试。'); }
}

async function pdfEmails(bytes) {
  if (bytes.subarray(0, 5).toString() !== '%PDF-') fail('PDF 文件格式不正确。');
  const { getDocument, VerbosityLevel, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false,
    disableFontFace: true, isEvalSupported: false, stopAtErrors: true,
    verbosity: VerbosityLevel.ERRORS, disableAutoFetch: true });
  const deadlineAt = Date.now() + PDF_TIMEOUT_MS;
  let document;
  try {
    document = await until(loading.promise, deadlineAt, 'PDF 读取超时，请拆分后重试。', () => loading.destroy());
    if (document.numPages > MAX_PDF_PAGES) fail(`PDF 最多支持 ${MAX_PDF_PAGES} 页，请拆分后重试。`);
    const entries = [], seen = new Set(); let total = 0, ocrUsed = false;
    for (let pageNo = 1; pageNo <= document.numPages; pageNo++) {
      const page = await until(document.getPage(pageNo), deadlineAt, 'PDF 读取超时，请拆分后重试。');
      const content = await until(page.getTextContent(), deadlineAt, 'PDF 读取超时，请拆分后重试。');
      const text = content.items.map(item => `${item.str || ''}${item.hasEOL ? '\n' : ''}`).join('');
      total += text.length;
      if (total > MAX_TEXT_CHARS) fail('PDF 文字过多，请拆分后重试。');
      const foundBefore = entries.length;
      findEmails(text, pageNo, entries, seen);
      const operations = await until(page.getOperatorList(), deadlineAt, 'PDF 读取超时，请拆分后重试。');
      const hasRasterImage = operations.fnArray.some(operation => operation >= OPS.paintImageMaskXObject &&
        operation <= OPS.paintSolidColorImageMask);
      // A page can contain both selectable text and a scanned email image.
      if (entries.length === foundBefore || hasRasterImage) {
        const image = await renderPdfPage(page, deadlineAt);
        const recognized = await ocrText(image, '.png', Math.min(OCR_TIMEOUT_MS, deadlineAt - Date.now()));
        total += recognized.length;
        if (total > MAX_TEXT_CHARS) fail('PDF 文字过多，请拆分后重试。');
        findEmails(recognized, pageNo, entries, seen);
        ocrUsed = true;
      }
      page.cleanup();
    }
    if (!entries.length) fail('PDF 经文字读取和本机图片识别后仍没有完整邮箱。');
    return { entries, rowsRead: document.numPages, fileType: 'pdf', needsReview: true, ocrUsed };
  } catch (error) {
    if (/PDF 最多支持|PDF 文字过多|PDF 经文字读取|PDF 读取超时|图片识别超时|PDF 页面像素过大/.test(error.message)) throw error;
    fail('PDF 无法读取；请检查文件是否加密或损坏。');
  } finally { await loading.destroy().catch(() => {}); }
}

async function until(promise, deadlineAt, message, cancel) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) fail(message);
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { try { cancel?.(); } catch {} reject(Error(message)); }, remaining);
    })]);
  } finally { clearTimeout(timer); }
}

async function renderPdfPage(page, deadlineAt) {
  const { createCanvas } = require('@napi-rs/canvas');
  const viewport = page.getViewport({ scale: 1.6 });
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  if (!width || !height || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE ||
      width * height > MAX_PDF_RENDER_PIXELS) fail('PDF 页面像素过大，请拆分或缩小页面后重试。');
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
  const rendering = page.render({ canvasContext: context, canvas, viewport });
  await until(rendering.promise, deadlineAt, 'PDF 读取超时，请拆分后重试。', () => rendering.cancel());
  return until(canvas.encode('png'), deadlineAt, 'PDF 读取超时，请拆分后重试。');
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      bytes.subarray(12, 16).toString() !== 'IHDR') fail('PNG 图片格式不正确。');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('JPG 图片格式不正确。');
  let position = 2;
  while (position < bytes.length) {
    if (bytes[position] !== 0xff) fail('JPG 图片结构损坏。');
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if ([0xd9, 0xda].includes(marker)) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(position);
    if (length < 2 || position + length > bytes.length) fail('JPG 图片结构损坏。');
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 7) fail('JPG 图片结构损坏。');
      return [bytes.readUInt16BE(position + 5), bytes.readUInt16BE(position + 3)];
    }
    position += length;
  }
  fail('JPG 图片缺少尺寸信息。');
}

async function ocrText(bytes, ext, timeoutMs = OCR_TIMEOUT_MS) {
  const [width, height] = ext === '.png' ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!width || !height || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE ||
      width * height > MAX_IMAGE_PIXELS) fail('图片像素过大，请缩小后重试。');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('图片识别超时，请拆分或缩小后重试。');
  const { createWorker } = require('tesseract.js');
  const language = require('@tesseract.js-data/eng');
  const corePath = path.dirname(require.resolve('tesseract.js-core/tesseract-core.wasm.js'));
  const workerPath = require.resolve('tesseract.js/src/worker-script/node/index.js');
  let worker, timeout, expired = false;
  const task = (async () => {
    worker = await createWorker('eng', 1, { langPath: language.langPath,
      workerPath, corePath, cacheMethod: 'none', gzip: language.gzip });
    if (expired) return '';
    const result = await worker.recognize(bytes);
    return result.data.text || '';
  })();
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => { expired = true; reject(Error('图片识别超时，请裁剪或缩小图片后重试。')); }, timeoutMs);
  });
  try { return await Promise.race([task, deadline]); }
  finally {
    clearTimeout(timeout);
    if (worker) await worker.terminate().catch(() => {});
    else if (expired) void task.then(async () => { if (worker) await worker.terminate().catch(() => {}); }).catch(() => {});
  }
}

async function extractDocumentEmails(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) fail('请选择本机文档。');
  const ext = path.extname(filePath).toLowerCase();
  if (!['.docx', '.pdf', '.png', '.jpg', '.jpeg'].includes(ext)) fail('不支持此文件格式。');
  let stat;
  try { stat = await fs.lstat(filePath); }
  catch { fail('文件无法读取，请重新选择。'); }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES)
    fail('请选择不超过 6 MB 的普通文件。');
  const bytes = await fs.readFile(filePath);
  if (bytes.length !== stat.size) fail('文件大小已变化，请重新选择。');
  if (ext === '.docx') return collectLines(await docxText(bytes), 'docx');
  if (ext === '.pdf') return pdfEmails(bytes);
  const text = await ocrText(bytes, ext);
  return collectLines(text, ext === '.png' ? 'png' : 'jpg');
}

module.exports = { extractDocumentEmails };
