'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const permitted = new Set(['--admin-groups', '--fixture-test', '--diagnostic']);
if (args.length > 1 || args.some(arg => !permitted.has(arg))) {
  console.error('Unsupported launcher arguments.'); process.exit(1);
}
const executable = require('./ensure-electron.cjs').installedRuntime();
if (!executable) {
  console.error('Electron runtime unavailable. Run install.bat or npm run runtime:install.'); process.exit(1);
}
const entry = args[0] === '--diagnostic' ? 'key-tool/feishu-main.js' : 'key-tool';
const forwarded = args.filter(arg => arg !== '--diagnostic');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [entry, ...forwarded], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('Could not start Electron.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });

