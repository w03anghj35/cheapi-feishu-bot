'use strict';
const fields = require('./user-registration-service');
function registrationPrompt(session) {
  switch (session.state) {
    case 'register-form': return '请直接填写注册卡片中的邮箱、专用密码、用户名和并发数，选择初始余额，点击“下一步：核对信息”。不要把密码发送到聊天框。\n若未显示输入框，请升级飞书客户端后在本私聊发送“重新显示表单”；也可发送“取消”。';
    case 'register-email': return '① 用户注册：请输入账号邮箱（不是任意数字账号）。仅创建普通用户；并发1–50，初始余额只能选0、1、5、10。10分钟内完成，随时发送“取消”。';
    case 'register-password': return '② 请在本私聊输入新账号密码：至少8个字符、最多72个UTF-8字节，不含控制字符，空格原样保留。\n注意：飞书聊天可能保存这条消息。请用全新的专用密码，不要复用其他账号密码；本工具不会回显或将密码写入本机记录。';
    case 'register-username': return '③ 密码已接收（不回显）。请输入用户名（1–60个字符）。';
    case 'register-concurrency': return '④ 请输入并发数：1–50的整数，例如5。';
    case 'register-balance': return '⑤ 请选择初始余额：0、1、5、10。也可以直接回复其中一个数字。';
    case 'register-confirm': return `请核对注册信息：\n账号：${session.registration.email}\n用户名：${session.registration.username}\n角色：普通用户\n并发数：${session.registration.concurrency}\n初始余额：${session.registration.balance}\n密码：已设置（不显示）\n点击“确认注册”或回复“确认”，只提交一次；发送“取消”不创建。`;
    default: throw new Error('invalid registration step');
  }
}
function advanceRegistration(session, raw) {
  const data = session.registration;
  switch (session.state) {
    case 'register-email': data.email = fields.email(raw); session.state = 'register-password'; break;
    case 'register-password': data.password = fields.password(raw); session.state = 'register-username'; break;
    case 'register-username': data.username = fields.username(raw); session.state = 'register-concurrency'; break;
    case 'register-concurrency':
      if (!/^[1-9]\d?$/.test(raw)) throw new Error('并发数必须是1–50的整数。');
      data.concurrency = fields.concurrency(Number(raw)); session.state = 'register-balance'; break;
    case 'register-balance':
      if (!['0','1','5','10'].includes(raw)) throw new Error('初始余额只能选择0、1、5、10。');
      data.balance = fields.balance(Number(raw)); session.state = 'register-confirm'; break;
    default: throw new Error('当前步骤不接受资料，请确认或取消。');
  }
}
function registrationFormValues(value) {
  const keys = ['email', 'password', 'username', 'concurrency', 'balance'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key) || typeof value[key] !== 'string'))
    throw new Error('请完整填写邮箱、密码、用户名、并发数并选择余额；不能提交额外字段。');
  // Validate non-secret fields first. Never normalize or echo the password.
  const email = fields.email(value.email), username = fields.username(value.username);
  if (!/^[1-9]\d?$/.test(value.concurrency)) throw new Error('并发数必须是1–50的整数。');
  const concurrency = fields.concurrency(Number(value.concurrency));
  if (!['0', '1', '5', '10'].includes(value.balance)) throw new Error('初始余额只能选择0、1、5、10。');
  const balance = fields.balance(Number(value.balance));
  return { email, username, concurrency, balance, password: fields.password(value.password) };
}
module.exports = { registrationPrompt, advanceRegistration, registrationFormValues };
