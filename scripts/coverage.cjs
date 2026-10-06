'use strict';
// Runs the unit tests with Node's own coverage and fails when a file, or all files together, fall under
// their floor (#143). Coverage counts the repository's code, not tests/.
//   npm run test:coverage
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const MEASURES = ['lines', 'branches', 'functions'];
// The percent of lines, branches and functions the tests run: just under what they ran on 2026-10-06.
// Raise a floor when the tests cover more; never lower one to let a change through.
const FLOORS = Object.freeze({
  'desktop/main.cjs': { lines: 96.5, branches: 94.4, functions: 76.9 },
  'extension/background.js': { lines: 98, branches: 93.2, functions: 96.9 },
  'extension/panel.js': { lines: 99.5, branches: 88.1, functions: 97.1 },
  'extension/content.js': { lines: 97.7, branches: 93.7, functions: 93.4 },
  'renderer/app.js': { lines: 98.1, branches: 84.7, functions: 92.4 },
  'all files': { lines: 97.5, branches: 92.6, functions: 94 }
});
// lcov's summary lines for each file: what they count, and whether they are found or hit.
const FIELDS = { LF: ['lines', 'found'], LH: ['lines', 'hit'], BRF: ['branches', 'found'], BRH: ['branches', 'hit'], FNF: ['functions', 'found'], FNH: ['functions', 'hit'] };

// Each file's lines, branches and functions found and hit, by its path in the repository. Node writes a
// path from the working directory (the repository root); an absolute one is read from `directory`.
function parseLcov(text, directory = root) {
  const files = {};
  let name = null, counts = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      if (name) throw new Error(`${name}: the lcov record has no end_of_record.`);
      const source = line.slice(3);
      const relative = path.isAbsolute(source) ? path.relative(directory, source) : path.normalize(source);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${source} is outside the repository.`);
      name = relative.split(path.sep).join('/');
      counts = {};
    } else if (line === 'end_of_record') {
      for (const field of Object.keys(FIELDS)) if (!Object.hasOwn(counts, field)) throw new Error(`${name}: the lcov record has no ${field}.`);
      files[name] = Object.fromEntries(MEASURES.map(measure => [measure, {}]));
      for (const [field, [measure, kind]] of Object.entries(FIELDS)) files[name][measure][kind] = counts[field];
      name = null;
    } else if (name) {
      const [field, value] = line.split(':');
      if (Object.hasOwn(FIELDS, field)) counts[field] = Number(value);
    }
  }
  if (name) throw new Error(`${name}: the lcov record has no end_of_record.`);
  if (!Object.keys(files).length) throw new Error('The coverage report has no files.');
  return files;
}

// The percent of lines, branches and functions covered in one file, or in several together. Nothing to
// cover counts as fully covered.
function percentages(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  return Object.fromEntries(MEASURES.map(measure => {
    const found = list.reduce((sum, entry) => sum + entry[measure].found, 0);
    const hit = list.reduce((sum, entry) => sum + entry[measure].hit, 0);
    return [measure, found ? hit / found * 100 : 100];
  }));
}

// What falls under its floor, one line each. A file the report doesn't have fails too.
function belowFloor(files, floors = FLOORS) {
  const failures = [];
  for (const [file, floor] of Object.entries(floors)) {
    const entries = file === 'all files' ? Object.values(files) : files[file];
    if (!entries) {
      failures.push(`${file}: not in the coverage report. A file loaded into a vm context or jsdom window needs its file name (tests/helpers/harness.cjs runFile and evalFile).`);
      continue;
    }
    const measured = percentages(entries);
    for (const measure of MEASURES) {
      if (measured[measure] < floor[measure]) failures.push(`${file}: ${measure} ${measured[measure].toFixed(2)}% is under its floor of ${floor[measure]}%`);
    }
  }
  return failures;
}

function main() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-coverage-'));
  try {
    const report = path.join(folder, 'lcov.info');
    const tests = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.cjs')).sort().map(name => `tests/${name}`);
    const run = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-coverage-exclude=tests/**',
      '--test-reporter=dot', '--test-reporter-destination=stdout', '--test-reporter=lcov', `--test-reporter-destination=${report}`, ...tests], { cwd: root, stdio: 'inherit' });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`The tests failed (exit ${run.status ?? run.signal}), so coverage isn’t checked.`);
    const files = parseLcov(fs.readFileSync(report, 'utf8'));
    console.log('\nCoverage (lines / branches / functions), against each floor:');
    for (const [file, floor] of Object.entries(FLOORS)) {
      const measured = files[file] || file === 'all files' ? percentages(file === 'all files' ? Object.values(files) : files[file]) : null;
      console.log(`  ${file.padEnd(24)} ${measured ? MEASURES.map(measure => `${measured[measure].toFixed(2)}% (floor ${floor[measure]}%)`).join(' / ') : 'not in the report'}`);
    }
    const failures = belowFloor(files);
    if (failures.length) throw new Error(`Coverage fell under its floor:\n${failures.map(failure => `  ${failure}`).join('\n')}`);
    console.log('Every floor holds.');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { parseLcov, percentages, belowFloor, FLOORS };
