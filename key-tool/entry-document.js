'use strict';

// A same-document anchor changes frame.url without changing its trusted file.
// Keep the full path and query check; only the fragment is ignored.
function isTrustedEntryDocument(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  try {
    const parsed = new URL(actual);
    parsed.hash = '';
    return parsed.href === expected;
  } catch { return false; }
}

module.exports = { isTrustedEntryDocument };
