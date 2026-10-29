'use strict';
// Heuristic preflight, not a guarantee that arbitrary source contains no secrets.
// Print only rule/path/line, never matched credential content.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const list = spawnSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8' });
if (list.error || list.status !== 0) { console.error('Run this check in an initialized Git repository.'); process.exit(1); }
const files = list.stdout.split('\0').filter(Boolean);
if (!files.length) { console.error('No staged/tracked files to inspect. Stage the explicit export file list first.'); process.exit(1); }
const rules = [
  ['api-key', /\bsk-[a-zA-Z0-9_-]{24,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['jwt', /\beyJ[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{15,}\b/g],
  ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/g],
  ['credential-literal', /(?:app_?secret|access_?token|refresh_?token|authorization|cookie|password)\s*[:=]\s*['"][^'"\r\n]{10,}['"]/gi],
];
const findings = [];
for (const file of files) {
  if (/(?:^|\/)(?:node_modules|outputs|\.runtime|dist|CheapiKeyStudio[^/]*)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:journal|db|sqlite\d*|log|tmp|zip|7z|exe|pem|key)$|(?:^|\/)(?:config\.json|\.npmrc|Cookies|Local State)$/i.test(file)) {
    findings.push({ file, rule: 'forbidden-runtime-file' }); continue;
  }
  // Inspect exactly the index bytes that will be committed, not a newer working copy.
  const staged = spawnSync('git', ['show', ':' + file], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  if (staged.error || staged.status !== 0) {
    findings.push({ file, rule: 'unreadable-index-entry' }); continue;
  }
  const raw = staged.stdout;
  if (raw.includes(0)) { findings.push({ file, rule: 'unexpected-binary' }); continue; }
  const content = raw.toString('utf8');
  for (const [rule, expression] of rules) {
    expression.lastIndex = 0;
    for (const match of content.matchAll(expression)) {
      const testFixture = /^key-tool\/test-/.test(file)
        && /fixture|fictional|synthetic|not-real|changed-after-submit|password\\n/i.test(match[0]);
      const validationPlaceholder = file === 'key-tool/user-registration-service.js'
        && match[0] === ['password', "'validation-only-placeholder'"].join(': ');
      if (!testFixture && !validationPlaceholder) findings.push({ file, rule, line: content.slice(0, match.index).split('\n').length });
    }
  }
}
if (findings.length) { console.error(JSON.stringify({ passed: false, findings }, null, 2)); process.exit(1); }
console.log(JSON.stringify({ passed: true, inspectedFiles: files.length, scope: 'tracked filenames and credential patterns; not a security certification' }));

