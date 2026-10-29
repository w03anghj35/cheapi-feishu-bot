'use strict';
const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { makeFeishuStore } = require('./feishu-store');
const { FeishuConnection } = require('./feishu-connection');
const { registerConnectionIPC } = require('./feishu-ipc');
const { makeConnectionLease } = require('./feishu-connection-lease');
const fixtureMode = process.argv.includes('--feishu-fixture');
const parent = path.join(app.getPath('appData'), 'CheapiKeyStudioFeishu');
fs.mkdirSync(parent, { recursive: true });
const dataDir = fixtureMode ? fs.mkdtempSync(path.join(parent, 'fixture-')) : parent;
app.setName('FeishuConnectionConsole');
app.setPath('userData', dataDir);
const acquired = app.requestSingleInstanceLock();
let window = null, connection = null;
const file = path.join(__dirname, 'feishu.html');
const url = pathToFileURL(file).href;
if (!acquired) app.exit(0);
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', () => connection?.disconnect());
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    const fixture = fixtureMode ? require('./test-feishu-electron.cjs').makeFixture() : null;
    connection = new FeishuConnection({ store: makeFeishuStore(dataDir, safeStorage),
      createClient: fixture ? fixture.createClient : require('./feishu-sdk').createClient,
      lease: fixture ? null : makeConnectionLease(path.join(dataDir, 'feishu-connection.lock')) });
    window = new BrowserWindow({ title: '飞书连接管理 · 令牌助手', width: 1020, height: 850,
      minWidth: 540, minHeight: 620, backgroundColor: '#f4f3ee', show: !fixtureMode,
      webPreferences: { preload: path.join(__dirname, 'feishu-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => connection.disconnect());
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    registerConnectionIPC(ipcMain, () => window, url, connection);
    await window.loadFile(file);
    if (fixture) await require('./test-feishu-electron.cjs').verify({ app, window, connection, fixture, dataDir, safeStorage });
  }).catch(() => {
    connection?.disconnect();
    if (fixtureMode) console.error('Feishu isolated UI regression failed; inspect the local sanitized report.');
    else dialog.showErrorBox('飞书连接管理未能启动', '请检查程序依赖和本机加密存储。没有创建令牌；请保留配置文件，不要重复覆盖。');
    app.exit(1);
  });
}
