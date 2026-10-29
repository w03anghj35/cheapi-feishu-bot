'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');

// Do not require('electron') here: recent versions may download on require().
function installedRuntime(directory = electronDir, platform = process.platform) {
  const expected = platform === 'win32' ? 'electron.exe'
    : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  try {
    const version = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
    if (fs.readFileSync(path.join(directory, 'dist', 'version'), 'utf8').trim().replace(/^v/, '') !== version
      || fs.readFileSync(path.join(directory, 'path.txt'), 'utf8') !== expected) return null;
    const executable = path.join(directory, 'dist', expected);
    return fs.statSync(executable).isFile() ? executable : null;
  } catch { return null; }
}

if (require.main === module) {
  if (!fs.existsSync(path.join(electronDir, 'install.js'))) {
    console.error('Electron package missing. Run npm ci first.'); process.exit(1);
  }
  if (!installedRuntime()) {
    console.log('Installing the locked Electron runtime (checksum verification enabled; timeout 5 minutes)...');
    const env = { ...process.env };
    // Always install this computer's runtime into this repository, not an external override.
    for (const name of ['ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_INSTALL_PLATFORM', 'ELECTRON_INSTALL_ARCH',
      'npm_config_platform', 'npm_config_arch', 'electron_use_remote_checksums',
      'npm_config_electron_use_remote_checksums']) delete env[name];
    const result = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], {
      cwd: root, env, stdio: 'inherit', timeout: 300000, windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      console.error('Electron runtime installation failed or timed out. Check network, then run npm run runtime:install.');
      process.exit(1);
    }
  }
  if (!installedRuntime()) {
    console.error('Electron runtime is missing or mismatched after installation.'); process.exit(1);
  }
  console.log('Electron runtime verified. No bot was started.');
}

module.exports = { installedRuntime };
