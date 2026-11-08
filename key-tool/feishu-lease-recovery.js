'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function ownerAbsent(pid, probe = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false;
  try { probe(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}
function recoverStaleLease(file, { platform = process.platform, probe = process.kill, run = spawnSync } = {}) {
  if (platform !== 'win32' || path.basename(file) !== 'feishu-connection.lock') return false;
  try {
    // Fast path: no helper is spawned for a live owner or damaged/uncertain lock.
    if (fs.statSync(file).size > 4096) return false;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof record?.token !== 'string' || !/^[0-9a-f-]{36}$/.test(record.token) || !ownerAbsent(record.pid, probe)) return false;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Invoke bundled code directly; do not change machine/user execution policy.
    const helper = fs.readFileSync(path.join(__dirname, 'recover-feishu-lease.ps1'), 'utf8');
    const quotedPath = "'" + path.resolve(file).replace(/'/g, "''") + "'";
    const result = run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `& {\n${helper}\n} -LockPath ${quotedPath}`],
    { windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 4096 });
    return !result.error && result.status === 0 && result.stdout.trim() === 'recovered';
  } catch { return false; }
}
module.exports = { ownerAbsent, recoverStaleLease };
