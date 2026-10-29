'use strict';
const $ = id => document.getElementById(id);
const labels = { unconfigured: '等待配置', disconnected: '未连接', connecting: '正在连接', connected: '已连接', reconnecting: '连接中断 · 正在重连', failed: '连接失败 · 已停止', 'storage-error': '配置存储异常', 'stop-error': '停止异常 · 请关闭窗口' };
let state = null, busy = false, initialized = false, draft = false, polling = false, version = 0, timer;
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function render(next) {
  state = next;
  if (!initialized) { if (state.appId) $('app-id').value = state.appId; initialized = true; }
  $('saved').textContent = state.hasCredential ? '已加密保存 · ' + date(state.savedAt) : '尚无已保存配置';
  $('connection-status').textContent = labels[state.phase] || '状态未知';
  $('connection-status').dataset.phase = state.phase;
  $('message-count').textContent = state.counts.messages;
  $('callback-count').textContent = state.counts.callbacks;
  $('connected-at').textContent = date(state.connectedAt) || '尚未连接';
  $('last-event').textContent = date(state.lastEventAt) || '尚未收到';
  $('retries').textContent = state.reconnectAttempts;
  $('diagnostics').textContent = state.counts.diagnostics;
  $('status-hint').textContent = state.error?.message || (state.phase === 'connected' ? '长连接已建立。仍需发布和实际事件验证；尚未开放令牌创建。' : state.active ? '等待真实握手结果，最多等待 45 秒；可以随时断开。' : '重开不会自动连接。保存配置后，请主动点击连接飞书。');
  const locked = busy || state.active || state.storageError;
  $('save').disabled = locked;
  $('app-id').disabled = locked; $('app-secret').disabled = locked;
  $('connect').disabled = busy || !state.hasCredential || state.storageError || state.active || draft;
  $('disconnect').disabled = busy || !state.active;
}
function markDraft() { draft = true; if (state) render(state); }
$('app-id').addEventListener('input', markDraft); $('app-secret').addEventListener('input', markDraft);
async function action(name, input) {
  if (busy) return;
  busy = true; const current = ++version;
  if (state) render(state);
  try {
    const response = await window.feishuConnection[name](input);
    if (current !== version) return;
    if (!response.ok) throw new Error(response.error || '操作未完成。');
    if (name === 'save') { $('app-secret').value = ''; draft = false; }
    render(response.data);
    notice(response.data.error?.message || ({ save: '配置已加密保存；输入框已清空。现在可以点击连接飞书。', connect: '已开始连接，实际结果以连接状态为准。', disconnect: '已断开；不会自动恢复连接。' }[name]), Boolean(response.data.error));
  } catch (error) {
    notice(error.message || '本机通信失败，请查看连接状态后重试。', true);
  } finally { busy = false; if (state) render(state); }
}
$('config-form').addEventListener('submit', event => { event.preventDefault(); action('save', { appId: $('app-id').value, appSecret: $('app-secret').value }); });
$('connect').addEventListener('click', () => action('connect'));
$('disconnect').addEventListener('click', () => action('disconnect'));
async function refresh() {
  if (busy || polling) return;
  polling = true; const current = version;
  try {
    const response = await window.feishuConnection.state();
    if (current !== version) return;
    if (!response.ok) throw new Error(response.error);
    const first = !initialized;
    render(response.data);
    if (first) notice(response.data.error?.message || (state.hasCredential ? '已找到本机加密配置，未自动连接。' : '请在本机填写应用密钥，不需要把密钥发到聊天里。'), Boolean(response.data.error));
  } catch { if (current === version) notice('无法读取本机连接状态，正在继续检查；这不代表已连接或已断开。', true); }
  finally { polling = false; }
}
window.addEventListener('beforeunload', () => { $('app-secret').value = ''; clearInterval(timer); });
refresh(); timer = setInterval(refresh, 1000);
