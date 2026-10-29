'use strict';

// Feishu card JSON 1.0 form/input contract. Do not insert passwords in outgoing cards.
function registrationForm(session, button) {
  const text = content => ({ tag: 'plain_text', content });
  const draft = session.registration || {};
  const fallback = { tag: 'fallback_text', text: text('请升级飞书客户端后使用注册表单。不要在聊天框发送密码。') };
  const input = (name, title, placeholder, maxLength, inputType = 'text') => ({
    tag: 'input', name, required: true, label: text(title), label_position: 'top',
    placeholder: text(placeholder), max_length: maxLength, input_type: inputType,
    width: 'default', fallback,
    ...(name !== 'password' && draft[name] !== undefined ? { default_value: String(draft[name]) } : {})
  });
  return { tag: 'form', name: 'user_registration_form', fallback, elements: [
    input('email', '账号邮箱', '请输入有效邮箱', 254),
    input('password', '新账号专用密码', '至少8字符，最多72个UTF-8字节', 72, 'password'),
    input('username', '用户名', '请输入用户名（1–60字符）', 60),
    input('concurrency', '并发数（1–50）', '请输入1–50的整数', 2),
    { tag: 'markdown', content: '初始余额（必选）' },
    { tag: 'select_static', name: 'balance', required: true, placeholder: text('请选择初始余额'),
      options: [0, 1, 5, 10].map(value => ({ text: text(String(value)), value: String(value) })),
      ...([0, 1, 5, 10].includes(draft.balance) ? { initial_option: String(draft.balance) } : {}) },
    { ...button('下一步：核对信息', 'register-submit', {}, 'primary'),
      name: 'registration_submit', action_type: 'form_submit' }
  ] };
}
module.exports = { registrationForm };
