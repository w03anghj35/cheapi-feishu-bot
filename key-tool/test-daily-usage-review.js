'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewAbsentAction } = require('./daily-usage-review');

const input = { name: '虚构归属', at: '2026-11-06T02:00:03Z', confirmed: true };
function fixture(response = 0) {
  let scope = { owner: 1, groupId: 'oc_fixture_12345678' }, checks = 0, writes = 0;
  let options;
  const publisher = {
    reviewCandidate(value) {
      assert.deepEqual(value, input);
      return { scope: { ...scope }, name: input.name, at: input.at,
        attemptedAt: '2026-11-06T02:00:00Z' };
    },
    state: () => ({ enabled: true, groupRef: 'group123', cards: [] }),
    scope: () => ({ ...scope }),
    reviewAbsent(value) { assert.deepEqual(value, input); writes++; return { enabled: false }; }
  };
  return { publisher,
    deps: { assertAdmin: async () => { checks++; }, currentPublisher: () => publisher,
      confirm: async value => { options = value; return { response }; } },
    changeScope: next => { scope = next; },
    checks: () => checks, writes: () => writes, options: () => options };
}
test('native cancellation preserves the unresolved attempt and defaults to cancel', async () => {
  const f = fixture(0);
  assert.deepEqual(await reviewAbsentAction(input, f.deps), { cancelled: true,
    state: { enabled: true, groupRef: 'group123', cards: [] } });
  assert.equal(f.checks(), 1); assert.equal(f.writes(), 0);
  assert.deepEqual(f.options().buttons, ['取消', '已核对未见，记录并暂停']);
  assert.equal(f.options().defaultId, 0); assert.equal(f.options().cancelId, 0);
  assert.match(f.options().detail, /目标群摘要：group123/);
  assert.match(f.options().detail, /不会立即发消息/);
  assert.equal(f.options().detail.includes('oc_fixture_12345678'), false);
});
test('native approval rechecks admin and exact group before the single durable review', async () => {
  const f = fixture(1);
  assert.deepEqual(await reviewAbsentAction(input, f.deps), { cancelled: false, state: { enabled: false } });
  assert.equal(f.checks(), 2); assert.equal(f.writes(), 1);
  const changed = fixture(1);
  changed.deps.confirm = async () => { changed.changeScope({ owner: 1, groupId: 'oc_other_12345678' }); return { response: 1 }; };
  await assert.rejects(reviewAbsentAction(input, changed.deps), { code: 'POLICY' });
  assert.equal(changed.writes(), 0);
});
test('stale record and failed second authorization never write review', async () => {
  const f = fixture(1);
  f.publisher.reviewCandidate = () => { throw Error('stale'); };
  await assert.rejects(reviewAbsentAction(input, f.deps), { code: 'INPUT' });
  assert.equal(f.writes(), 0); assert.equal(f.options(), undefined);
  const denied = fixture(1);
  denied.deps.assertAdmin = async () => { if (++denied.authorizationChecks === 2) throw Error('expired'); };
  denied.authorizationChecks = 0;
  await assert.rejects(reviewAbsentAction(input, denied.deps), /expired/);
  assert.equal(denied.writes(), 0);
});
