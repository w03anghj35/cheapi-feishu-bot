'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isTrustedEntryDocument } = require('./entry-document');

const admin = 'file:///D:/example/key-tool/admin.html';

test('trusted entry file permits same-document fragments without expanding the file boundary', () => {
  assert.equal(isTrustedEntryDocument(admin, admin), true);
  assert.equal(isTrustedEntryDocument(admin + '#main', admin), true);
  assert.equal(isTrustedEntryDocument(admin + '#user-ownership', admin), true);
  for (const wrong of [null, '', 'about:blank', admin + '?x=1', admin + '?x=1#main',
    admin + '.other#main', 'file:///D:/example/key-tool/other.html#main',
    'https://example.invalid/admin.html#main']) {
    assert.equal(isTrustedEntryDocument(wrong, admin), false, String(wrong));
  }
});
