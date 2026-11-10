'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dailyUsageCard, retiredDailyUsageCard, MAX_CARD_BYTES } = require('./daily-usage-card');
const input = { name: '虚构归属', checkedAt: '2026-11-06T02:00:00Z',
  days: [{ day: '2026-11-05', final: true, users: [
    { id: 1, email: 'a@example.invalid', cost: 1.5 },
    { id: 2, email: 'b@example.invalid', cost: 2.25 }] },
  { day: '2026-11-06', final: false, users: [
    { id: 1, email: 'a@example.invalid', cost: 3.5 },
    { id: 2, email: 'b@example.invalid', cost: 4.25 }] }] };
test('group card shows per-account daily actual cost, totals and in-progress marker', () => {
  const card = dailyUsageCard(input);
  const text = JSON.stringify(card);
  assert.equal(card.config.enable_forward, false);
  assert.equal(card.config.update_multi, true);
  for (const token of ['a@example.invalid', 'b@example.invalid', '11-05', '11-06 *',
    '$1.5000', '$3.5000', '$3.7500', '$7.7500', '今日进行中']) assert.ok(text.includes(token));
  assert.equal(Buffer.byteLength(text, 'utf8') <= MAX_CARD_BYTES, true);
  assert.equal(card.elements.some(element => element.tag === 'column_set'), true);
});
test('missing day is not displayed as zero and unsafe/incomplete cards fail closed', () => {
  const card = dailyUsageCard({ ...input, days: [input.days[0],
    { ...input.days[1], users: input.days[1].users.slice(0, 1) }] });
  assert.ok(JSON.stringify(card).includes('—'));
  assert.throws(() => dailyUsageCard({ ...input, days: [input.days[0], input.days[0]] }));
  assert.throws(() => dailyUsageCard({ ...input, days: [{ ...input.days[0],
    users: [{ id: 1, email: 'a@example.invalid', cost: NaN }] }] }));
  assert.throws(() => dailyUsageCard({ ...input, days: [{ ...input.days[0],
    users: Array.from({ length: 31 }, (_, i) => ({ id: i + 1, email: `u${i}@example.invalid`, cost: 1 })) }] }));
  const plain = dailyUsageCard({ ...input, name: '<script>alert(1)</script>' });
  assert.equal(plain.header.title.tag, 'plain_text');
});
test('retired card contains no old account details', () => {
  const card = retiredDailyUsageCard('虚构归属', input.checkedAt);
  assert.equal(card.config.enable_forward, false);
  assert.equal(JSON.stringify(card).includes('a@example.invalid'), false);
});
test('an old unfinished day is labelled pending instead of today in progress', () => {
  const card = dailyUsageCard({ ...input, checkedAt: '2026-11-09T02:00:00Z' });
  const text = JSON.stringify(card);
  assert.ok(text.includes('11-06 待补齐'));
  assert.equal(text.includes('11-06 *'), false);
  assert.ok(text.includes('$3.5000'));
  assert.ok(text.includes('历史待补齐日金额仅为已记录小计'));
});
