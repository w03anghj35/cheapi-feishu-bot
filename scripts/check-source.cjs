'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['key-tool', 'scripts'].flatMap(dir => fs.readdirSync(path.join(root, dir))
  .filter(name => /\.(?:js|cjs)$/.test(name)).map(name => path.join(dir, name)));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) { console.error('Syntax check failed: ' + file); process.exit(1); }
}
console.log('Syntax checks passed: ' + files.length + ' files.');

