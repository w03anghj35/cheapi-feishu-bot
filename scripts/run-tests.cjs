'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (!require('./ensure-electron.cjs').installedRuntime()) {
  console.error('Electron runtime missing. Run npm run runtime:install before tests.'); process.exit(1);
}
const files = fs.readdirSync(path.join(root, 'key-tool'))
  .filter(name => /^test-.*\.js$/.test(name) && name !== 'test-fixture.js')
  .sort().map(name => path.join('key-tool', name));
files.push('scripts/test-runtime.cjs');
if (!files.length) throw new Error('No unit tests found');
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) { console.error('Could not start Node tests.'); process.exit(1); }
process.exit(result.status ?? 1);

