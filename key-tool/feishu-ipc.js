'use strict';
const { ConnectionError } = require('./feishu-store');
function trusted(event, window, url) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === url);
}
function registerConnectionIPC(ipcMain, getWindow, url, connection) {
  const actions = {
    state: () => connection.state(), save: input => connection.save(input),
    connect: () => connection.connect(), disconnect: () => { connection.disconnect(); return connection.state(); }
  };
  for (const [name, action] of Object.entries(actions)) {
    ipcMain.handle('feishu-connection:' + name, (event, input) => {
      if (!trusted(event, getWindow(), url)) return { ok: false, code: 'DENIED', error: '此窗口无权操作飞书连接。' };
      try { return { ok: true, data: action(input) }; }
      catch (error) {
        if (error instanceof ConnectionError) return { ok: false, code: error.code, error: error.message };
        return { ok: false, code: 'INTERNAL', error: '操作未完成，请检查本机连接状态；错误详情已隐藏以保护凭据。' };
      }
    });
  }
}
module.exports = { trusted, registerConnectionIPC };
