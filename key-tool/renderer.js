'use strict';
const $ = id => document.getElementById(id);
let state = { groups: [], unresolved: [], connected: false }, selected = null, busy = false, result = null, requestId = crypto.randomUUID();
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function call(name, ...args) {
  const response = await window.keyTool[name](...args);
  if (!response.ok) { const e = new Error(response.message); e.code = response.code; e.definitive = response.definitive; throw e; }
  return response.data;
}
function controls() {
  $('create').disabled = busy || !state.connected || !selected || state.unresolved.length > 0 || !!result;
  for (const id of ['refresh','operator','name','quota','days']) $(id).disabled = busy;
  for (const b of $('groups').querySelectorAll('button')) b.disabled = busy || !!result;
  for (const b of $('pending-list').querySelectorAll('button')) b.disabled = busy;
}
function showState(next) {
  state = next;
  $('connection').textContent = state.connected ? '服务已就绪 · 分组已更新' : '服务未就绪 · 请联系管理员';
  $('count').textContent = `${state.groups.length} 个分组`;
  if (!state.groups.some(g => g.id === selected)) selected = null;
  $('selected').value = state.groups.find(g => g.id === selected)?.name || '请先点击左侧分组';
  $('groups').replaceChildren();
  for (const g of state.groups) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'group';
    button.dataset.groupId = g.id; button.setAttribute('aria-pressed', String(selected === g.id));
    const title = document.createElement('strong'); title.textContent = g.name;
    button.append(title);
    button.addEventListener('click', () => { selected = g.id; showState(state); });
    $('groups').append(button);
  }
  if (!state.groups.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = state.connected ? '暂无已发布分组，请联系管理员设置客户名称。' : '服务暂不可用，请刷新或联系管理员。'; $('groups').append(p); }
  $('pending').hidden = state.unresolved.length === 0; $('pending-list').replaceChildren();
  for (const r of state.unresolved) {
    const div = document.createElement('div'); div.className = 'pending-row';
    const p = document.createElement('p'); p.textContent = `${r.name} · 额度 ${r.quota}`;
    const recover = document.createElement('button'); recover.textContent = '只读核对并找回密钥';
    recover.onclick = () => run(async () => { displayResult(await call('reconcile', r.requestId)); showState(await call('state')); notice('核对成功，未发送新的创建请求。'); });
    const ack = document.createElement('button'); ack.textContent = '已在平台人工核对';
    ack.onclick = () => run(async () => { showState(await call('acknowledge', r.requestId)); requestId = crypto.randomUUID(); notice('已解除保护；没有重试、停用或删除任何令牌。'); });
    div.append(p, recover, ack); $('pending-list').append(div);
  }
  controls();
}
async function run(fn) {
  if (busy) return;
  busy = true; controls();
  try { await fn(); } catch (e) {
    if (e.definitive) requestId = crypto.randomUUID();
    notice(e.message, true);
    try { showState(await call('state')); } catch { /* keep current UI and explicit error */ }
  } finally { busy = false; controls(); }
}
function displayResult(value) {
  result = value; $('result').hidden = false; $('secret').value = value.key; $('secret').type = 'password'; $('reveal').textContent = '显示';
  $('result-meta').textContent = `${value.name} · Key ID ${value.id} · 分组 ID ${value.groupId} · 额度 ${value.quota}`;
  $('result').scrollIntoView({ block: 'nearest' }); controls();
}
async function refreshGroups() {
  notice('正在读取可用分组…'); showState(await call('refresh'));
  notice(state.groups.length ? '已读取分组。请选择分组并填写正数额度。' : '暂无已发布分组，请联系管理员配置。');
}
$('refresh').onclick = () => run(refreshGroups);
$('form').onsubmit = e => {
  e.preventDefault(); if (busy || result || !selected || !state.connected) return;
  const input = { requestId, groupId: selected, quota: $('quota').value, name: $('name').value, days: $('days').value, operator: $('operator').value.trim() };
  if (!input.operator) { notice('请填写操作人／客户账号，便于管理员追踪。', true); return; }
  if (!(Number(input.quota) > 0) || !Number.isFinite(Number(input.quota))) { notice('额度必须填写且大于 0。', true); return; }
  const groupName = state.groups.find(g => g.id === selected)?.name;
  if (!confirm(`确定创建 1 枚令牌？\n操作人：${input.operator}\n分组：${groupName}\n额度：${input.quota}\n有效期：${input.days ? input.days + ' 天' : '平台默认'}\n不会自动创建其他令牌。`)) return;
  run(async () => { notice('正在创建，请勿重复提交或关闭窗口…'); displayResult(await call('create', input)); notice('创建成功，请妥善交付密钥。'); });
};
$('reveal').onclick = () => { const show = $('secret').type === 'password'; $('secret').type = show ? 'text' : 'password'; $('reveal').textContent = show ? '隐藏' : '显示'; };
$('hide-key').onclick = () => { $('secret').type = 'password'; $('reveal').textContent = '显示'; };
$('copy').onclick = () => run(async () => { if (result) { await call('copy', result.key); notice('密钥已复制，60 秒后清除本工具写入的剪贴板内容。'); } });
$('another').onclick = () => { if (busy) return; result = null; $('secret').value = ''; $('result').hidden = true; requestId = crypto.randomUUID(); $('quota').value = ''; notice('请重新填写额度，再创建下一枚。'); controls(); };
window.keyTool.onNotice(message => notice(message, true));
window.keyTool.onState(next => { showState(next); notice('管理员已更新分组；仅显示已发布的客户名称，请确认当前选择。'); });
run(async () => { showState(await call('state')); await refreshGroups(); });
