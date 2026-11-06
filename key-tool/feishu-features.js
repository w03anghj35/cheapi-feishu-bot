'use strict';

// Stable feature IDs belong to callbacks; labels and their ordering may change independently.
// A new entry needs a server-side handler before it can become usable. Never trust a label/index
// supplied by a card as an operation or a platform route.
const FEATURES = Object.freeze([
  Object.freeze({ id: 'register', label: '用户注册', aliases: Object.freeze(['用户注册', '注册账号', '创建账号']) }),
  Object.freeze({ id: 'token', label: '令牌创建', aliases: Object.freeze(['令牌创建', '创建令牌', '申请令牌', '发送令牌', '领取令牌']) }),
  Object.freeze({ id: 'group-settings', label: '分组设置', adminOnly: true, aliases: Object.freeze(['分组设置', '设置倍率']) }),
  Object.freeze({ id: 'user-query', label: '用户查询', aliases: Object.freeze(['用户查询', '查询用户', '我的用户']) })
]);

function featureById(id) { return FEATURES.find(feature => feature.id === id) || null; }
function featureByText(text) {
  if (typeof text !== 'string') return null;
  const value = text.replace(/^\//, '');
  return FEATURES.find(feature => feature.aliases.includes(value)) || null;
}
const isMenu = text => typeof text === 'string' && /^\/?(?:菜单|功能|帮助|开始)$/.test(text);

const availableFeatures = isAdmin => FEATURES.filter(f => !f.adminOnly || isAdmin === true);
module.exports = { FEATURES, featureById, featureByText, isMenu, availableFeatures };
