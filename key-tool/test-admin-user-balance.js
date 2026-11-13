'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.value = ''; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = [...children]; }
  addEventListener(event, fn) { this.events[event] = fn; }
  dispatch(event) { this.events[event]?.({ preventDefault() {} }); }
}
function setup(query) {
  const nodes = new Map();
  const document = { getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    createElement: tag => new Element(tag) };
  let auth;
  const context = { document, window: { groupAdmin: { userBalanceQuery: query, onAuth: fn => { auth = fn; } } },
    Date, BigInt, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'admin-user-balance.js'), 'utf8'), context);
  return { node: id => document.getElementById('user-balance-' + id), auth: state => auth(state) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function reply() {
  return { ok: true, data: { complete: true, unit: 'CNY',
    startedAt: '2026-11-12T00:00:00Z', checkedAt: '2026-11-12T00:00:01Z',
    summary: { totalUsers: 4, adminCount: 1, positiveCount: 1, zeroCount: 1, negativeCount: 1,
      positiveTotal: '0.00000001', negativeTotal: '-10', excludedAdminPositive: '1000000000000' },
    rows: [
      { id: 1, username: '<img src=x>', email: 'tiny@example.invalid', role: 'user', status: 'disabled', balance: '0.00000001', included: true },
      { id: 2, username: '管理员', email: 'admin@example.invalid', role: 'admin', status: 'active', balance: '1000000000000', included: false },
      { id: 3, username: '负数', email: 'negative@example.invalid', role: 'user', status: 'active', balance: '-10', included: false },
      { id: 4, username: '零', email: 'zero@example.invalid', role: 'user', status: 'active', balance: '0', included: false }
    ] } };
}
test('user balance renders exact decimals, sorted accounts and unchanged global totals when searching', async () => {
  const ui = setup(async () => reply());
  ui.node('read').dispatch('click'); await flush();
  assert.match(ui.node('summary').textContent, /0\.00000001 CNY/);
  assert.match(ui.node('summary').textContent, /-10 CNY/);
  assert.match(ui.node('summary').textContent, /1,000,000,000,000 CNY/);
  const table = ui.node('results').children[0].children[0];
  const rows = table.children.find(node => node.tagName === 'tbody').children;
  assert.deepEqual(rows.map(row => row.children[0].textContent), ['3', '4', '1', '2']);
  assert.match(rows[2].textContent, /已停用/);
  assert.match(rows[2].textContent, /计入正余额合计/);
  assert.match(rows[3].textContent, /管理员不计入/);
  assert.equal(rows[2].children[1].children[0].textContent, '<img src=x>');
  const summary = ui.node('summary').textContent;
  ui.node('search').value = 'tiny'; ui.node('search').dispatch('input');
  assert.match(ui.node('count').textContent, /筛选显示 1 个/);
  assert.equal(ui.node('summary').textContent, summary);
  assert.match(ui.node('results').textContent, /0\.00000001 CNY/);
});
test('expired authorization clears balances and an older pending reply cannot restore them', async () => {
  let finish;
  const ui = setup(() => new Promise(resolve => { finish = resolve; }));
  ui.node('read').dispatch('click');
  ui.auth({ phase: 'expired' });
  finish(reply()); await flush();
  assert.equal(ui.node('summary').hidden, true);
  assert.equal(ui.node('results').textContent, '');
  assert.match(ui.node('status').textContent, /旧余额已清除/);
  assert.equal(ui.node('read').disabled, false);
});
test('normal authorization checking does not discard a successful balance query and failed refresh clears totals', async () => {
  let finish;
  const ui = setup(() => new Promise(resolve => { finish = resolve; }));
  ui.node('read').dispatch('click');
  ui.auth({ phase: 'checking' }); ui.auth({ phase: 'ready' });
  finish(reply()); await flush();
  assert.equal(ui.node('summary').hidden, false);
  ui.node('read').dispatch('click'); finish({ ok: false, message: '分页缺失' }); await flush();
  assert.equal(ui.node('summary').hidden, true);
  assert.match(ui.node('status').textContent, /分页缺失/);
  assert.equal(ui.node('results').textContent, '');
});
