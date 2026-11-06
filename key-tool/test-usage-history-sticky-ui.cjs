'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-history-sticky-ui-'));
app.setPath('userData', dataRoot);
app.commandLine.appendSwitch('disable-gpu');
process.on('exit', () => {
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  catch { console.warn('Electron 测试临时目录仍被系统占用，进程退出后再清理。'); }
});

const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, 'admin.css'), 'utf8');
const columns = Array.from({ length: 8 }, (_, index) => `<th>日期 ${index + 1}</th>`).join('');
const cells = Array.from({ length: 8 }, (_, index) => `<td>$${index + 1}.0000</td>`).join('');
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css}</style>
  <body><main><div class="usage-history-table-wrap"><table class="usage-history-table">
  <thead><tr><th>平台账号邮箱</th>${columns}</tr></thead>
  <tbody><tr><th>fixture@example.invalid</th>${cells}</tr></tbody>
  <tfoot><tr><th>合计</th>${cells}</tr></tfoot></table></div></main></body></html>`;

const timer = setTimeout(() => { console.error('sticky table UI timeout'); app.exit(2); }, 15000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 580, height: 700, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  for (const width of [580, 1040]) {
    window.setSize(width, 700);
    const positions = await window.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector('.usage-history-table-wrap');
      const table = wrap.querySelector('table');
      wrap.scrollLeft = 0;
      const first = () => ({ header: table.querySelector('thead th').getBoundingClientRect().left,
        user: table.querySelector('tbody th').getBoundingClientRect().left,
        total: table.querySelector('tfoot th').getBoundingClientRect().left,
        amount: table.querySelector('tbody td').getBoundingClientRect().left });
      const before = first(); wrap.scrollLeft = 100; const after = first();
      return { before, after, scroll: wrap.scrollLeft, max: wrap.scrollWidth - wrap.clientWidth,
        sticky: getComputedStyle(table.querySelector('tbody th')).position,
        background: getComputedStyle(table.querySelector('tbody th')).backgroundColor };
    })()`);
    assert.ok(positions.max > 100 && positions.scroll >= 99, `${width}: expected horizontal scroll`);
    assert.equal(positions.sticky, 'sticky');
    assert.notEqual(positions.background, 'rgba(0, 0, 0, 0)');
    for (const key of ['header', 'user', 'total'])
      assert.ok(Math.abs(positions.before[key] - positions.after[key]) < 1, `${width}: ${key} moved`);
    assert.ok(positions.after.amount < positions.before.amount - 90, `${width}: amount did not move`);
  }
  console.log('Sticky account column passed at 580px and 1040px.');
  clearTimeout(timer); window.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack || error.message); clearTimeout(timer); app.exit(1); });
