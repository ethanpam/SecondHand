'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const IOWA_HOSTS = ['https://hhsservices.iowa.gov/*', 'https://hhsservices.iowa.gov/apspssp/*'];
// Other sites are approved at runtime, one at a time or all at once; the manifest may only ask for plain https.
const OPTIONAL_HOSTS = ['https://*/*'];

function checkFiles(directory) {
  let count = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) count += checkFiles(file);
    else if (/\.(cjs|mjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
      count++;
    }
  }
  return count;
}

function checkManifest(manifest) {
  if (manifest.manifest_version !== 3 || !manifest.permissions.includes('nativeMessaging')) throw new Error('Extension must use Manifest V3 and native messaging.');
  for (const permission of manifest.host_permissions || []) {
    if (!IOWA_HOSTS.includes(permission)) throw new Error(`Unexpected host permission: ${permission}`);
  }
  for (const permission of manifest.optional_host_permissions || []) {
    if (!OPTIONAL_HOSTS.includes(permission)) throw new Error(`Unexpected optional host permission: ${permission}`);
  }
  const expectedMatches = ['https://hhsservices.iowa.gov/apspssp/ssp.portal', 'https://hhsservices.iowa.gov/apspssp/ssp.portal/*'];
  if (manifest.content_scripts?.length !== 1 || JSON.stringify(manifest.content_scripts[0].matches) !== JSON.stringify(expectedMatches) || manifest.content_scripts[0].all_frames !== false) throw new Error('Automatic detection must stay on exact Iowa portal top frames.');
  const resources = manifest.web_accessible_resources;
  if (resources?.length !== 1 || JSON.stringify(resources[0].matches) !== JSON.stringify(OPTIONAL_HOSTS) || resources[0].resources.some(file => !['panel.html', 'panel.js', 'panel.css'].includes(file))) throw new Error('Only the assistant panel can be web accessible, and only to https pages.');
  if (manifest.side_panel?.default_path !== 'panel.html' || !manifest.permissions.includes('sidePanel') || manifest.action.default_popup) throw new Error('Toolbar must open the native side panel.');
  if (manifest.externally_connectable) throw new Error('Websites cannot send extension commands.');
  if (manifest.permissions.includes('storage')) throw new Error('Applicant information must not be stored in Chrome extension storage.');
}

if (require.main === module) {
  let count = 0;
  for (const folder of ['desktop', 'renderer', 'extension', 'shared', 'scripts', 'tests']) count += checkFiles(path.join(root, folder));
  checkManifest(JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')));
  console.log(`Checked ${count} JavaScript files and extension permissions.`);
}

module.exports = { checkManifest };
