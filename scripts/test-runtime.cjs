'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installedRuntime } = require('./ensure-electron.cjs');

test('runtime preflight never downloads and rejects missing, mismatched or incomplete runtime', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-runtime-fixture-'));
  try {
    assert.equal(installedRuntime(temp, 'win32'), null);
    fs.mkdirSync(path.join(temp, 'dist'));
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(temp, 'dist/version'), '1.2.3');
    fs.writeFileSync(path.join(temp, 'path.txt'), 'electron.exe');
    assert.equal(installedRuntime(temp, 'win32'), null);
    fs.writeFileSync(path.join(temp, 'dist/electron.exe'), 'fixture only');
    assert.equal(installedRuntime(temp, 'win32'), path.join(temp, 'dist/electron.exe'));
    fs.writeFileSync(path.join(temp, 'dist/version'), '9.9.9');
    assert.equal(installedRuntime(temp, 'win32'), null);
    fs.writeFileSync(path.join(temp, 'dist/version'), 'v1.2.3\n');
    assert.ok(installedRuntime(temp, 'win32'));
    fs.writeFileSync(path.join(temp, 'path.txt'), '../other.exe');
    assert.equal(installedRuntime(temp, 'win32'), null);
  } finally {
    // This unique fixture root is owned by this test; never accept an external cleanup path.
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
