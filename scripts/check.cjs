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

// Every change to extension/ comes with a newer BUILD in background.js and panel.js (#142): an installed
// extension updates itself only when the app ships a newer build (#85). The change is what this checkout has,
// committed or not, since it left main: its merge base with origin/main. Main itself is not checked. CI checks
// a pull request's merge commit, so it needs main's history (actions/checkout with fetch-depth: 0).
const BUILD_LINE = /^\s*const BUILD = '(\d{4}-\d{2}-\d{2}\.\d+)';$/m;
const BUILD_FILES = ['extension/background.js', 'extension/panel.js'];
// Dates, then the number after the dot, as numbers: 2026-10-05.10 is newer than 2026-10-05.9.
function newerBuild(candidate, current) {
  const [next, now] = [candidate, current].map(build => build.split(/[-.]/).map(Number));
  const at = next.findIndex((part, index) => part !== now[index]);
  return at >= 0 && next[at] > now[at];
}
function buildIn(source, file) {
  const build = BUILD_LINE.exec(source)?.[1];
  if (!build) throw new Error(`${file} has no BUILD line.`);
  return build;
}
function checkBuild(directory = root, env = process.env) {
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  };
  const output = (...args) => {
    const result = git(...args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  if (env.GITHUB_REF === 'refs/heads/main' || output('rev-parse', '--abbrev-ref', 'HEAD').trim() === 'main') return { skipped: 'main' };
  const merged = git('merge-base', 'HEAD', 'refs/remotes/origin/main');
  if (merged.status !== 0) {
    throw new Error('The BUILD check compares this checkout with main, but main’s history isn’t here. Run `git fetch origin main` (in CI, check out with fetch-depth: 0).');
  }
  const base = merged.stdout.trim();
  const changed = [...new Set([...output('diff', '--name-only', base, '--', 'extension/').split('\n'),
    ...output('ls-files', '--others', '--exclude-standard', '--', 'extension/').split('\n')].filter(Boolean))].sort();
  const before = buildIn(output('show', `${base}:${BUILD_FILES[0]}`), `${BUILD_FILES[0]} on main`);
  const [build, panel] = BUILD_FILES.map(file => buildIn(fs.readFileSync(path.join(directory, file), 'utf8'), file));
  if (!changed.length) return { base: before, build, changed };
  if (panel !== build) throw new Error(`${BUILD_FILES[0]} has BUILD ${build} but ${BUILD_FILES[1]} has ${panel}. Change them together.`);
  if (!newerBuild(build, before)) {
    throw new Error(`extension/ changed since main (${changed.join(', ')}), but BUILD is ${build}, not newer than main’s ${before}. Bump BUILD in ${BUILD_FILES.join(' and ')}.`);
  }
  return { base: before, build, changed };
}

if (require.main === module) {
  let count = 0;
  for (const folder of ['desktop', 'renderer', 'extension', 'shared', 'scripts', 'tests']) count += checkFiles(path.join(root, folder));
  checkManifest(JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')));
  const build = checkBuild();
  console.log(`Checked ${count} JavaScript files and extension permissions.`);
  console.log(build.skipped ? 'BUILD check: not run on main.' : build.changed.length ? `BUILD check: extension/ changed since main, and BUILD ${build.build} is newer than main’s ${build.base}.`
    : `BUILD check: extension/ unchanged since main (BUILD ${build.build}).`);
}

module.exports = { checkManifest, checkBuild };
