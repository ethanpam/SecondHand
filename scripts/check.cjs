'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
let count = 0;
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(cjs|mjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
      count++;
    }
  }
}
for (const folder of ['desktop', 'renderer', 'extension', 'shared', 'scripts', 'tests']) check(path.join(root, folder));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || !manifest.permissions.includes('nativeMessaging')) throw new Error('Extension must use Manifest V3 and native messaging.');
for (const permission of [...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])]) {
  if (permission !== 'https://hhsservices.iowa.gov/*' && permission !== 'https://hhsservices.iowa.gov/apspssp/*') throw new Error(`Unexpected host permission: ${permission}`);
}
if (manifest.permissions.includes('storage')) throw new Error('Applicant information must not be stored in Chrome extension storage.');
console.log(`Checked ${count} JavaScript files and extension permissions.`);
