'use strict';
const $ = id => document.getElementById(id);
let state = { groups: [], owner: null }, busy = false, dirty = false, stale = false, authBusy = false, authState = { phase: 'checking' };
function notice(text, error = false) { $('admin-notice').textContent = text; $('admin-notice').classList.toggle('error', error); }
function controls() {
  const blocked = busy || authBusy || ['login', 'checking', 'expired', 'required', 'storage-error'].includes(authState.phase);
  $('admin-refresh').disabled = busy || authBusy || authState.phase === 'login';
  $('admin-save').disabled = blocked || stale || !state.owner || !state.groups.length;
  $('admin-login').disabled = busy || authBusy || ['checking', 'storage-error'].includes(authState.phase);
  $('admin-complete-login').disabled = busy || authBusy || authState.phase !== 'login';
  $('admin-recover').hidden = authState.canRecover !== true;
  $('admin-recover').disabled = busy || authBusy || authState.canRecover !== true;
  for (const input of document.querySelectorAll('[data-group-id]')) input.disabled = blocked;
}
function renderAuth(next) {
  authState = next;
  if (next.phase === 'login') stale = true;
  const labels = { ready: '已验证 · 本机加密授权可用', saved: '已保存 · 首次请求时核验平台授权',
    required: '尚未配置 · 请管理员登录并保存', login: '等待管理员登录 · 完成后点击保存，客户创建暂时暂停',
    checking: '正在核验平台授权…', expired: '授权已失效或未登录 · 请重新授权',
    offline: '网络或平台响应异常 · 可重新读取核验，不会自动重发创建', 'storage-error': '本机授权存储异常 · 已停止使用，请保留文件并检查' };
  $('auth-status').textContent = labels[next.phase] || '授权状态未知，请检查';
  document.querySelector('.auth-card').dataset.phase = next.phase;
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  $('auth-meta').textContent = `绑定账户 ID：${next.owner ?? '—'} · 保存：${date(next.savedAt)} · 核验：${date(next.verifiedAt)}`;
  // Status pushes never rebuild the group form or overwrite unsaved aliases.
  controls();
}
async function authorize(action) {
  if (busy || authBusy) return;
  if (dirty && !confirm('维护授权可能切换账户，当前未保存的分组名称会在完成登录后重新读取。是否继续？')) return;
  authBusy = true; controls();
  try {
    const response = await window.groupAdmin[action]();
    if (!response.ok) throw new Error(response.message);
    if (action === 'completeLogin') {
      renderAuth(response.data.auth); render(response.data.catalog);
      notice('授权已加密保存并通过平台核验，分组已重新读取。');
    } else { renderAuth(response.data); notice(action === 'recoverAuthorization'
      ? '恢复操作已结束；若显示尚未配置，请点击登录／重新授权，由您完成登录后保存。操作记录和待核对保护保持不变。'
      : '请在平台窗口完成登录，然后返回此页点击完成登录并保存。'); }
  } catch (e) { notice(e.message, true); }
  finally { authBusy = false; controls(); }
}
function updateCount() {
  let count = 0;
  for (const input of document.querySelectorAll('[data-group-id]')) {
    const published = input.value.trim() !== ''; count += Number(published);
    input.dataset.published = String(published);
    input.nextElementSibling.textContent = published ? '保存后客户可见' : '未命名 · 对客户隐藏';
  }
  $('publish-count').textContent = `${count} 个待发布 · ${state.groups.length - count} 个隐藏`;
}
function render(next) {
  state = next; dirty = false; stale = false;
  $('admin-account').textContent = state.owner ? `平台账户 ID ${state.owner} · ${state.groups.length} 个原始分组` : '服务未就绪，请使用管理员首次登录入口维护授权';
  $('catalog-rows').replaceChildren();
  for (const group of state.groups) {
    const row = document.createElement('div'); row.className = 'catalog-row';
    const original = document.createElement('div'); original.className = 'catalog-original';
    const title = document.createElement('strong'); title.textContent = group.name;
    const meta = document.createElement('p'); meta.className = 'muted';
    meta.textContent = `${group.platform || '平台未标注'} · ID ${group.id}${group.rate !== null ? ' · 倍率 ' + group.rate : ''}`;
    const description = document.createElement('p'); description.className = 'muted'; description.textContent = group.description;
    original.append(title, meta, description);
    const edit = document.createElement('div'); edit.className = 'catalog-edit';
    const label = document.createElement('label'); label.htmlFor = `alias-${group.id}`; label.textContent = '客户显示名称';
    const input = document.createElement('input'); input.id = label.htmlFor; input.dataset.groupId = group.id;
    input.value = group.customerName; input.maxLength = 80; input.placeholder = '留空，不提供给客户选择'; input.autocomplete = 'off';
    const hint = document.createElement('p'); hint.className = 'hint';
    input.addEventListener('input', () => { dirty = true; updateCount(); notice('有未保存的修改，点击保存后生效。'); });
    edit.append(label, input, hint); row.append(original, edit); $('catalog-rows').append(row);
  }
  if (!state.groups.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '暂无可配置分组，请检查授权或重新读取。'; $('catalog-rows').append(empty); }
  updateCount(); controls();
}
async function run(name, input) {
  if (busy || authBusy) return;
  if (name === 'save' && stale) { notice('授权已更新，请先重新读取分组再保存。', true); return; }
  busy = true; controls();
  try {
    const response = await window.groupAdmin[name](input);
    if (!response.ok) throw new Error(response.message);
    render(response.data);
    notice(name === 'save' ? '已保存。仅已命名且平台可用的分组对客户开放。' : '原始分组已读取。请填写客户名称，留空隐藏。');
  } catch (e) { notice(e.message, true); }
  finally { busy = false; controls(); }
}
$('admin-refresh').onclick = () => { if (!dirty || confirm('重新读取会放弃尚未保存的修改，是否继续？')) run('refresh'); };
$('admin-login').onclick = () => authorize('login');
$('admin-recover').onclick = () => authorize('recoverAuthorization');
$('admin-complete-login').onclick = () => authorize('completeLogin');
window.groupAdmin.onAuth(renderAuth);
window.groupAdmin.onAuthError(message => notice(message, true));
window.groupAdmin.onLoginComplete(result => {
  renderAuth(result.auth);
  if (!dirty) { render(result.catalog); notice('授权已保存，分组已重新读取。'); }
  else { stale = true; controls(); notice('授权已保存；为保留您的草稿，尚未替换表单。请重新读取分组后再保存名称。'); }
});
let botState = null, botBusy = false, botPolicyDirty = false;
function botNotice(message, error = false) { $('bot-notice').textContent = message; $('bot-notice').classList.toggle('error', error); }
function renderBot(next) {
  botState = next; const c = next.connection || {};
  const failures = next.createFailures || { items: [], storageError: false };
  $('bot-failure-notice').textContent = failures.storageError
    ? '诊断日志无法继续安全保存，当前仅显示可读／本轮内存记录；请保留原文件检查。'
    : failures.items.length ? '最近 20 条失败诊断（最新在前），不会自动重新创建。' : '暂无已记录的创建失败；旧版错误无法追溯。';
  $('bot-failures').replaceChildren();
  const stages = { admission: '进入创建前', validation: '参数／额度校验', identity: '平台身份预检查',
    groups: '平台分组预检查', policy: '提交前策略检查', 'pending-storage': '保存待处理记录',
    submission: '提交阶段（可能已发送，先核对）', 'receipt-storage': '保存创建回执', unknown: '阶段未知，先核对' };
  for (const row of [...failures.items].reverse()) {
    const li = document.createElement('li');
    li.textContent = `${row.at} · ${row.code}${row.httpStatus ? ` / HTTP ${row.httpStatus}` : ''} · ${stages[row.stage] || stages.unknown} · 操作编号 ${row.requestId || '无效／未取得'}`;
    $('bot-failures').append(li);
  }
  $('bot-connection').textContent = ({ connected: '已连接', connecting: '连接中', reconnecting: '重新连接中',
    unconfigured: '未配置 · 请在此处保存 Secret', 'storage-error': '存储异常 · 请保留文件检查', failed: '连接失败', 'stop-error': '旧连接未停止' })[c.phase] || '未连接';
  if (c.error) botNotice(c.error.message, true);
  for (const id of ['bot-credentials-save','bot-app-id','bot-app-secret']) $(id).disabled = botBusy || authBusy || authState.phase !== 'ready' || c.active || c.storageError;
  $('bot-owner').textContent = next.ownerLabel || '未绑定'; $('bot-group').textContent = next.groupLabel || '未绑定';
  $('bot-enabled').textContent = next.enabled ? '已开启 · 全群成员可申请' : '已关闭';
  const p = next.policy || {};
  $('bot-account-binding').textContent = !Number.isSafeInteger(next.platformAccountId) ? '2API 授权未就绪' :
    !Number.isSafeInteger(p.platformOwnerId) ? '此策略尚未绑定账户' :
      p.platformOwnerId === next.platformAccountId ? `匹配 · 账户 ID ${p.platformOwnerId}` : `不匹配 · 策略 ${p.platformOwnerId} / 当前 ${next.platformAccountId}`;
  if (!botPolicyDirty) {
    $('bot-max-quota').value = p.maxQuota ?? '20'; $('bot-user-day').value = p.maxUserDailyQuota ?? '';
    $('bot-group-day').value = p.maxGroupDailyQuota ?? ''; $('bot-enable').checked = p.enabled === true;
  }
  $('bot-owner-approve').hidden = !next.ownerCandidate;
  $('bot-candidate').textContent = next.ownerCandidate ? `检测到待确认管理员身份：${next.ownerCandidate.label}` :
    next.groupCandidate ? `待确认目标群 ID ${next.groupCandidate.groupId}；发起者 ${next.groupCandidate.label}` : '';
  $('bot-group-approve').hidden = !next.groupCandidate;
  $('bot-connect').disabled = botBusy || c.phase === 'connected' || c.phase === 'connecting';
  $('bot-disconnect').disabled = botBusy || !c.active;
  for (const id of ['bot-owner-start','bot-owner-approve','bot-group-start','bot-group-approve','bot-save']) $(id).disabled = botBusy || authBusy || authState.phase !== 'ready';
  $('bot-owner-start').disabled = botBusy || authBusy || authState.phase !== 'ready' || c.phase !== 'connected';
  $('bot-group-start').disabled = botBusy || authBusy || authState.phase !== 'ready' || c.phase !== 'connected' || !next.ownerBound;
}
async function botCall(name, ...args) {
  if (botBusy) return null;
  botBusy = true; if (botState) renderBot(botState);
  try {
    const response = await window.groupAdmin[name](...args);
    if (!response.ok) throw new Error(response.message || '操作失败。');
    if (response.data?.connection) renderBot(response.data);
    return response.data;
  } catch (error) { botNotice(error.message, true); throw error; }
  finally { botBusy = false; if (botState) renderBot(botState); }
}
$('bot-refresh').onclick = async () => { try { const r = await botCall('feishuState'); if (r) renderBot(r); } catch {} };
$('bot-connect').onclick = async () => { try { await botCall('feishuConnect'); botNotice('已开始连接；请等待“已连接”状态。'); } catch {} };
$('bot-credentials-form').onsubmit = async event => {
  event.preventDefault();
  if (botBusy) return;
  const appId = $('bot-app-id').value, appSecret = $('bot-app-secret').value;
  $('bot-app-secret').value = '';
  if (!confirm('保存后将关闭群申请并清除管理员／群绑定。确认 App ID 正确，并由您亲自填写了 Secret 吗？')) return;
  try { await botCall('feishuSaveCredentials', { appId, appSecret }); botNotice('配置已在业务工具加密保存。请连接飞书，重新绑定管理员及唯一目标群。'); } catch {}
};
window.addEventListener('blur', () => { $('bot-app-secret').value = ''; });
window.addEventListener('beforeunload', () => { $('bot-app-secret').value = ''; });
$('bot-disconnect').onclick = async () => { try { await botCall('feishuDisconnect'); botNotice('连接已断开，群内申请已停止。'); } catch {} };
$('bot-owner-start').onclick = async () => { try { const r = await botCall('feishuStartOwnerBinding'); if (r) $('bot-challenge').textContent = `请由管理员本人私聊机器人发送：/绑定管理员 ${r.code}（5 分钟有效）。验证码仅显示在本机窗口，不要转发。`; } catch {} };
$('bot-owner-approve').onclick = async () => {
  if (!confirm('確認挑战消息是您本人从飞书账号发出的吗？确认后此身份可修改群策略、额度及启停机器人。')) return;
  try { const r = await botCall('feishuConfirmOwner'); if (r) renderBot(r); botNotice('管理员飞书身份已绑定并加密保存。'); } catch {}
};
$('bot-group-start').onclick = async () => { try { const r = await botCall('feishuStartGroupBinding'); if (r) $('bot-challenge').textContent = `请在唯一的 2API 目标群中 @机器人并发送：/绑定机器人 ${r.code}（5 分钟有效）。只会绑定此群。`; } catch {} };
$('bot-group-approve').onclick = async () => {
  if (!confirm('请核对待绑定群 ID 与 2API 群完全一致。确认后机器人只接受这个群的申请。')) return;
  try { const r = await botCall('feishuConfirmGroup'); if (r) renderBot(r); botNotice('目标群已绑定。完成额度设置并勾选启用后才会开放申请。'); } catch {}
};
for (const id of ['bot-max-quota','bot-user-day','bot-group-day','bot-enable']) $(id).addEventListener('input', () => { botPolicyDirty = true; });
$('bot-policy-form').onsubmit = async event => {
  event.preventDefault(); if (botBusy) return;
  const maxQuota = Number($('bot-max-quota').value);
  const optionalLimit = element => element.value.trim() === '' ? null : Number(element.value);
  const maxUserDailyQuota = optionalLimit($('bot-user-day')), maxGroupDailyQuota = optionalLimit($('bot-group-day'));
  if (!Number.isFinite(maxQuota) || maxQuota <= 0 ||
      (maxUserDailyQuota !== null && (!Number.isFinite(maxUserDailyQuota) || maxUserDailyQuota < maxQuota)) ||
      (maxGroupDailyQuota !== null && (!Number.isFinite(maxGroupDailyQuota) || maxGroupDailyQuota < maxQuota))) {
    botNotice('请设置有效的单次上限；每日额度可留空表示无限制，若填写则不能低于单次上限。', true); return;
  }
  if ($('bot-enable').checked && (!botState?.ownerBound || !botState?.groupBound || botState?.connection?.phase !== 'connected')) {
    botNotice('启用前必须已绑定管理员、精确目标群并保持飞书长连接。', true); return;
  }
  try { const r = await botCall('feishuSavePolicy', { maxQuota, maxUserDailyQuota, maxGroupDailyQuota, enabled: $('bot-enable').checked }); if (r) { botPolicyDirty = false; renderBot(r); botNotice(`策略已加密保存：单次最多 ${maxQuota}；${maxUserDailyQuota === null ? '个人每日不限' : `个人每日最多 ${maxUserDailyQuota}`}；${maxGroupDailyQuota === null ? '全群每日不限' : `全群每日最多 ${maxGroupDailyQuota}`}。`); } } catch {}
};
window.groupAdmin.feishuOnState(renderBot);
window.groupAdmin.feishuState().then(response => { if (response.ok) renderBot(response.data); else botNotice(response.message, true); }).catch(() => botNotice('无法读取飞书状态。', true));
let feishuPolling = false;
setInterval(async () => {
  if (feishuPolling || document.hidden) return;
  feishuPolling = true;
  try { const response = await window.groupAdmin.feishuState(); if (response.ok) renderBot(response.data); }
  catch {} finally { feishuPolling = false; }
}, 2000);
$('catalog-form').onsubmit = event => {
  event.preventDefault();
  if (busy || authBusy) return;
  const items = [...document.querySelectorAll('[data-group-id]')].map(input => ({ id: Number(input.dataset.groupId), name: input.value }));
  const published = items.filter(item => item.name.trim()).length;
  if (!published && !confirm('全部名称为空，保存后客户将没有可选分组。确定继续？')) return;
  run('save', { owner: state.owner, items });
};
window.addEventListener('beforeunload', event => { if (dirty && !busy) { event.preventDefault(); event.returnValue = ''; } });
window.groupAdmin.authState().then(response => { if (response.ok) renderAuth(response.data); }).catch(() => notice('无法读取授权状态，请重新打开管理页。', true));
run('refresh');
