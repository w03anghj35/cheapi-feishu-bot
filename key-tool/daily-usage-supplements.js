'use strict';

function supplementedUsers(state, day, name, recorded = []) {
  const dayEntries = Object.hasOwn(state?.supplements || {}, day) ? state.supplements[day] : null;
  const byAccount = dayEntries && Object.hasOwn(dayEntries, name) ? dayEntries[name] : null;
  const supplements = Object.values(byAccount || {});
  const ids = new Set(recorded.map(user => user.id));
  const added = supplements.filter(event => !ids.has(event.user.id));
  return { users: [...recorded, ...added.map(event => event.user)],
    supplemented: supplements.length > 0,
    supplementedIds: supplements.map(event => event.user.id),
    checkedAt: supplements.map(event => event.checkedAt).sort().at(-1) || null };
}

module.exports = { supplementedUsers };
