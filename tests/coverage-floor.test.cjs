'use strict';
// scripts/coverage.cjs: reads the test run's lcov report and fails when a file, or all files together, fall
// below the floor set for them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLcov, percentages, belowFloor, FLOORS } = require('../scripts/coverage.cjs');

const ROOT = '/synthetic/repo';
// Node writes each file's path from the working directory; an absolute one is read from the repository root.
const lcov = [
  'TN:', 'SF:desktop/main.cjs', 'FNF:10', 'FNH:8', 'BRF:20', 'BRH:19', 'LH:97', 'LF:100', 'end_of_record',
  'TN:', `SF:${ROOT}/extension/panel.js`, 'FNF:4', 'FNH:4', 'BRF:0', 'BRH:0', 'LF:50', 'LH:50', 'end_of_record'
].join('\n');

test('an lcov report reads as each file’s lines, branches and functions found and hit, by its path in the repository', () => {
  assert.deepEqual(parseLcov(lcov, ROOT), {
    'desktop/main.cjs': { lines: { found: 100, hit: 97 }, branches: { found: 20, hit: 19 }, functions: { found: 10, hit: 8 } },
    'extension/panel.js': { lines: { found: 50, hit: 50 }, branches: { found: 0, hit: 0 }, functions: { found: 4, hit: 4 } }
  });
  assert.throws(() => parseLcov('SF:a.js\nLF:1\nLH:1\n', ROOT), /a\.js: the lcov record has no end_of_record/);
  assert.throws(() => parseLcov('SF:/elsewhere/a.js\nLF:1\nLH:1\nend_of_record\n', ROOT), /\/elsewhere\/a\.js is outside the repository/);
  assert.throws(() => parseLcov('SF:../elsewhere/a.js\nLF:1\nLH:1\nend_of_record\n', ROOT), /\.\.\/elsewhere\/a\.js is outside the repository/);
  assert.throws(() => parseLcov('SF:a.js\nLH:1\nend_of_record\n', ROOT), /a\.js: the lcov record has no LF/);
  assert.throws(() => parseLcov('', ROOT), /no files/);
});

test('percentages are per file and for all files together; nothing to cover counts as fully covered', () => {
  const files = parseLcov(lcov, ROOT);
  assert.deepEqual(percentages(files['desktop/main.cjs']), { lines: 97, branches: 95, functions: 80 });
  assert.deepEqual(percentages(files['extension/panel.js']), { lines: 100, branches: 100, functions: 100 });
  assert.deepEqual(percentages(Object.values(files)), { lines: 98, branches: 95, functions: 12 / 14 * 100 });
});

test('a file under its floor fails with its numbers, and so does a file the report doesn’t have', () => {
  const files = parseLcov(lcov, ROOT);
  assert.deepEqual(belowFloor(files, { 'desktop/main.cjs': { lines: 97, branches: 95, functions: 80 }, 'all files': { lines: 98, branches: 95, functions: 85 } }), []);
  assert.deepEqual(belowFloor(files, { 'desktop/main.cjs': { lines: 97.5, branches: 95, functions: 80.1 } }), [
    'desktop/main.cjs: lines 97.00% is under its floor of 97.5%', 'desktop/main.cjs: functions 80.00% is under its floor of 80.1%']);
  assert.deepEqual(belowFloor(files, { 'all files': { lines: 98.5, branches: 0, functions: 0 } }), ['all files: lines 98.00% is under its floor of 98.5%']);
  assert.deepEqual(belowFloor(files, { 'renderer/app.js': { lines: 1, branches: 1, functions: 1 } }),
    ['renderer/app.js: not in the coverage report. A file loaded into a vm context or jsdom window needs its file name (tests/helpers/harness.cjs runFile and evalFile).']);
});

test('the floors cover the files the tests load into a vm context or jsdom window, and all files together', () => {
  for (const file of ['desktop/main.cjs', 'extension/background.js', 'extension/panel.js', 'extension/content.js', 'renderer/app.js', 'all files']) {
    assert.ok(FLOORS[file], `${file} has a floor`);
    for (const measure of ['lines', 'branches', 'functions']) assert.ok(FLOORS[file][measure] > 0 && FLOORS[file][measure] <= 100, `${file} ${measure}`);
  }
});
