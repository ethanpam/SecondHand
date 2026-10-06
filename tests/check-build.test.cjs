'use strict';
// #142: a change to extension/ comes with a newer BUILD, or installed extensions never update themselves (#85).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { checkBuild } = require('../scripts/check.cjs');

// A synthetic repository with main at BUILD 2026-10-05.4. Git runs without this computer's user or system
// config, so no hook, signing or identity of the person running the tests applies.
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-build-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
  const run = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const git = (...args) => run(root, args);
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  // As in the real files: background.js has the line at the top level, panel.js inside its function.
  const build = (background, panel = background) => {
    write('extension/background.js', `'use strict';\nconst BUILD = '${background}';\nconst HOST = 'org.secondhand.bridge';\n`);
    write('extension/panel.js', `(function () {\n  'use strict';\n  const BUILD = '${panel}';\n})();\n`);
  };
  const commit = message => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  build('2026-10-05.4');
  write('extension/content.js', '// content\n');
  write('tests/example.test.cjs', '// test\n');
  write('README.md', 'readme\n');
  const first = commit('main');
  git('update-ref', 'refs/remotes/origin/main', first);
  return { root, env, git, run, write, build, commit, check: (extra = {}) => checkBuild(root, { ...env, ...extra }) };
}

test('a branch that changes extension/ without a newer BUILD fails and names the files', t => {
  const repo = repository(t);
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write('extension/content.js', '// content, changed\n');
  repo.commit('change the content script');
  assert.throws(() => repo.check(), error => /extension\/content\.js/.test(error.message) && /2026-10-05\.4/.test(error.message) &&
    /extension\/background\.js and extension\/panel\.js/.test(error.message));
});

test('a newer BUILD in both files passes, a skipped number included', t => {
  const repo = repository(t);
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write('extension/content.js', '// content, changed\n');
  repo.commit('change the content script');
  // Another branch may take .5 first: .4 to .6 is newer, and that is all the check asks.
  repo.build('2026-10-05.6');
  repo.commit('bump');
  assert.deepEqual(repo.check(), { base: '2026-10-05.4', build: '2026-10-05.6', changed: ['extension/background.js', 'extension/content.js', 'extension/panel.js'] });
  repo.build('2026-10-06.1');
  assert.equal(repo.check().build, '2026-10-06.1', 'a later date is newer');
});

test('uncommitted and untracked extension files count too, so the check fails before the commit', t => {
  const repo = repository(t);
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write('extension/content.js', '// content, not committed yet\n');
  assert.throws(() => repo.check(), /extension\/content\.js/);
  repo.git('checkout', '--', 'extension/content.js');
  repo.write('extension/new-helper.js', '// a new file\n');
  assert.throws(() => repo.check(), /extension\/new-helper\.js/);
});

test('an equal or older BUILD fails, and background.js and panel.js must name the same one', t => {
  const repo = repository(t);
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write('extension/content.js', '// content, changed\n');
  for (const [background, panel, error] of [['2026-10-05.4', '2026-10-05.4', /2026-10-05\.4/], ['2026-10-05.3', '2026-10-05.3', /2026-10-05\.3/],
    ['2026-09-30.20', '2026-09-30.20', /2026-09-30\.20/], ['2026-10-05.6', '2026-10-05.4', /panel\.js/], ['2026-10-05.6', '2026-10-05.7', /panel\.js/]]) {
    repo.build(background, panel);
    assert.throws(() => repo.check(), error, `${background} / ${panel}`);
  }
  repo.write('extension/background.js', `'use strict';\nconst HOST = 'org.secondhand.bridge';\n`);
  assert.throws(() => repo.check(), /no BUILD line/);
});

test('changes outside extension/ need no new BUILD', t => {
  const repo = repository(t);
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write('tests/example.test.cjs', '// test, changed\n');
  repo.write('README.md', 'readme, changed\n');
  repo.commit('docs and tests');
  assert.deepEqual(repo.check(), { base: '2026-10-05.4', build: '2026-10-05.4', changed: [] });
});

test('main itself is not checked: the main branch, and CI’s run on a push to main', t => {
  const repo = repository(t);
  repo.write('extension/content.js', '// content, changed on main\n');
  repo.commit('a change on main');
  assert.deepEqual(repo.check(), { skipped: 'main' });
  // CI checks main out by its commit.
  repo.git('checkout', '-q', '--detach', 'HEAD');
  assert.throws(() => repo.check(), /extension\/content\.js/, 'a detached commit is checked');
  assert.deepEqual(repo.check({ GITHUB_REF: 'refs/heads/main' }), { skipped: 'main' });
});

test('in CI on a pull request, the merge commit is compared with main, not with the branch’s own history', t => {
  const repo = repository(t);
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write('extension/content.js', '// content, changed\n');
  repo.commit('change the content script');
  // Main moves on while the pull request is open, with a change of its own outside extension/.
  repo.git('checkout', '-q', 'main');
  repo.write('README.md', 'readme, changed on main\n');
  const advanced = repo.commit('main moves on');
  repo.git('update-ref', 'refs/remotes/origin/main', advanced);
  // GitHub tests the pull request as main with the branch merged in, checked out by its commit.
  repo.git('checkout', '-q', '--detach', advanced);
  repo.git('merge', '-q', '--no-ff', '-m', 'Merge feature into main', 'feature');
  const pull = { GITHUB_REF: 'refs/pull/7/merge', GITHUB_EVENT_NAME: 'pull_request' };
  assert.throws(() => repo.check(pull), error => /extension\/content\.js/.test(error.message) && !/README/.test(error.message));
  repo.git('checkout', '-q', 'feature');
  repo.build('2026-10-05.6');
  repo.commit('bump');
  repo.git('checkout', '-q', '--detach', advanced);
  repo.git('merge', '-q', '--no-ff', '-m', 'Merge feature into main', 'feature');
  assert.deepEqual(repo.check(pull), { base: '2026-10-05.4', build: '2026-10-05.6', changed: ['extension/background.js', 'extension/content.js', 'extension/panel.js'] });
});

test('a checkout without main’s history fails loudly and says how to fetch it', t => {
  const repo = repository(t);
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write('extension/content.js', '// content, changed\n');
  repo.commit('change the content script');
  // actions/checkout's default: the one commit under test, with no main beside it.
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-build-check-shallow-'));
  t.after(() => fs.rmSync(shallow, { recursive: true, force: true }));
  repo.run(os.tmpdir(), ['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${repo.root}`, shallow]);
  assert.throws(() => checkBuild(shallow, repo.env), /fetch-depth: 0|git fetch origin main/);
  // Main fetched as one commit, with nothing joining it to the branch: still no history to compare.
  repo.run(shallow, ['fetch', '-q', '--depth', '1', 'origin', 'main:refs/remotes/origin/main']);
  assert.throws(() => checkBuild(shallow, repo.env), /fetch-depth: 0|git fetch origin main/);
  // With the whole history, the same commit is checked.
  repo.run(shallow, ['fetch', '-q', '--unshallow', 'origin']);
  assert.throws(() => checkBuild(shallow, repo.env), /extension\/content\.js/);
});
