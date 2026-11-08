'use strict';
const { ToolError } = require('./service');

async function reviewAbsentAction(input, { assertAdmin, currentPublisher, confirm }) {
  await assertAdmin();
  const publisher = currentPublisher();
  let candidate;
  try { candidate = publisher.reviewCandidate(input); }
  catch { throw new ToolError('INPUT', '待核对群卡片已变化，请重新读取后核对。'); }
  const groupRef = publisher.state().groupRef;
  const attemptedAt = new Date(candidate.attemptedAt).toLocaleString('zh-CN',
    { timeZone: 'Asia/Shanghai', hour12: false });
  const choice = await confirm({
    type: 'warning', buttons: ['取消', '已核对未见，记录并暂停'], defaultId: 0, cancelId: 0,
    message: '确认原目标群没有这张每日用量卡片？',
    detail: `归属：${candidate.name}\n目标群摘要：${groupRef}\n首次尝试：${attemptedAt}（北京时间）\n\n` +
      '请先在这个群按时间和归属姓名核对。若其实已发送，之后重新发布可能重复向全群公开邮箱与金额。' +
      '此按钮只加密记录人工核对并暂停群发布；不会立即发消息或删除旧记录。'
  });
  if (choice.response !== 1) return { cancelled: true, state: publisher.state() };
  await assertAdmin();
  const current = currentPublisher();
  const scope = current.scope();
  if (candidate.scope.owner !== scope.owner || candidate.scope.groupId !== scope.groupId)
    throw new ToolError('POLICY', '平台管理员或目标群已变化，本次未解除保护。');
  return { cancelled: false, state: current.reviewAbsent(input) };
}

module.exports = { reviewAbsentAction };
