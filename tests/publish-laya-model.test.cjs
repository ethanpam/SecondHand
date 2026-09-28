'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MODEL_FILES, validateManifest } = require('../desktop/laya-model.cjs');
const { describeFiles, latestManifest, commitFrom, parseArguments, publish } = require('../scripts/publish-laya-model.cjs');

const script = path.join(__dirname, '../scripts/publish-laya-model.cjs');
const repo = 'JacobTDang/secondhand-laya';
const commit = 'c'.repeat(40);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// A synthetic export folder: every runtime file, and one the app doesn't use.
function exportFolder(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'secondhand-laya-export-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const files = {};
  for (const name of MODEL_FILES) {
    files[name] = Buffer.from(`synthetic ${name}\n`.repeat(3));
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), files[name]);
  }
  fs.writeFileSync(path.join(folder, 'export-notes.txt'), 'not part of the runtime');
  return { folder, files };
}

// A stand-in for the Hub (tests only): the repo's latest.json on main, 404 until one is uploaded.
async function fakeHub(t) {
  const hub = { latest: null, reads: 0 };
  const server = http.createServer((request, response) => {
    if (request.url !== `/${repo}/resolve/main/latest.json`) { response.writeHead(404).end(); return; }
    hub.reads++;
    if (!hub.latest) response.writeHead(404).end(); else response.writeHead(200).end(hub.latest);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  hub.endpoint = `http://127.0.0.1:${server.address().port}`;
  return hub;
}

// A stand-in for the hf CLI (tests only): records each call and answers like `hf upload --json`.
// Uploading latest.json puts it on the fake Hub unless `keep` says the Hub ignores it.
function fakeHf(hub, { keep = false, fail = false } = {}) {
  const calls = [];
  const run = async args => {
    calls.push({ args, latest: args[3] === 'latest.json' ? fs.readFileSync(args[2], 'utf8') : null });
    if (fail) throw new Error('hf upload failed (exit code 1).');
    if (args[3] === 'latest.json') {
      if (!keep) hub.latest = fs.readFileSync(args[2]);
      return `{"url": "https://huggingface.co/${repo}/commit/${'d'.repeat(40)}"}\n`;
    }
    return `{"url": "https://huggingface.co/${repo}/commit/${commit}"}\n`;
  };
  return { calls, run };
}

test('each runtime file’s size and SHA-256 come from the export folder, and a missing file is named', async t => {
  const { folder, files } = exportFolder(t);
  assert.deepEqual(await describeFiles(folder), MODEL_FILES.map(name => ({ path: name, size: files[name].length, sha256: sha256(files[name]) })));
  fs.rmSync(path.join(folder, 'tokenizer/tokenizer.json'));
  await assert.rejects(describeFiles(folder), /tokenizer\/tokenizer\.json/);
});

test('latest.json pins every file to the commit that holds it, names its format, and is one the app accepts', async t => {
  const { folder } = exportFolder(t);
  const files = await describeFiles(folder);
  const latest = latestManifest({ endpoint: 'https://huggingface.co', repo, commit, format: 'noul-v1', files });
  assert.deepEqual(latest, { version: 1, model: { revision: commit, format: 'noul-v1',
    files: files.map(file => ({ path: file.path, url: `https://huggingface.co/${repo}/resolve/${commit}/${file.path}`, size: file.size, sha256: file.sha256 })) } });
  assert.equal(validateManifest(latest).model.revision, commit);
  assert.throws(() => latestManifest({ endpoint: 'https://huggingface.co', repo, commit, format: 'noul-v2', files }), /noul-v2 isn’t a format this SecondHand can run \(noul-v1\)/);
  assert.throws(() => latestManifest({ endpoint: 'https://huggingface.co', repo, commit: 'main', files, format: 'noul-v1' }), /revision/);
});

test('the commit comes from hf upload’s JSON output', () => {
  assert.equal(commitFrom(`{"url": "https://huggingface.co/${repo}/commit/${commit}"}\n`), commit);
  assert.throws(() => commitFrom(`{"url": "https://huggingface.co/${repo}/tree/main/"}`), /no commit/);
  assert.throws(() => commitFrom('✓ Uploaded'), /JSON/);
});

test('arguments: an export folder, --repo and --format; --hf or SECONDHAND_HF_CLI names hf, and HF_ENDPOINT moves the Hub as it does for hf', () => {
  const required = ['export', '--repo', repo, '--format', 'noul-v1'];
  assert.deepEqual(parseArguments(required, {}), { folder: path.resolve('export'), repo, format: 'noul-v1', hf: 'hf', endpoint: 'https://huggingface.co', dryRun: false });
  assert.deepEqual(parseArguments([...required, '--hf', '/venv/bin/hf', '--dry-run'], { SECONDHAND_HF_CLI: '/other/hf', HF_ENDPOINT: 'http://127.0.0.1:9/' }),
    { folder: path.resolve('export'), repo, format: 'noul-v1', hf: '/venv/bin/hf', endpoint: 'http://127.0.0.1:9', dryRun: true });
  assert.equal(parseArguments(required, { SECONDHAND_HF_CLI: '/other/hf' }).hf, '/other/hf');
  assert.throws(() => parseArguments(['--repo', repo, '--format', 'noul-v1'], {}), /export folder/);
  assert.throws(() => parseArguments(['export', '--format', 'noul-v1'], {}), /--repo/);
  assert.throws(() => parseArguments(['export', '--repo', 'not a repo', '--format', 'noul-v1'], {}), /--repo/);
  assert.throws(() => parseArguments(['export', '--repo', repo], {}), /--format/);
  assert.throws(() => parseArguments(['export', '--repo', repo, '--format', 'noul-v7'], {}), /noul-v7 isn’t a format this SecondHand can run/);
  assert.throws(() => parseArguments([...required, '--force'], {}), /--force/);
});

test('--dry-run prints latest.json and contacts nothing', async t => {
  const { folder, files } = exportFolder(t);
  const result = spawnSync(process.execPath, [script, folder, '--repo', repo, '--format', 'noul-v1', '--hf', path.join(folder, 'no-such-hf'), '--dry-run'],
    { encoding: 'utf8', env: { ...process.env, HF_ENDPOINT: 'http://127.0.0.1:9' } });
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(printed, { version: 1, model: { revision: '<commit>', format: 'noul-v1',
    files: MODEL_FILES.map(name => ({ path: name, url: `http://127.0.0.1:9/${repo}/resolve/<commit>/${name}`, size: files[name].length, sha256: sha256(files[name]) })) } });
  assert.match(result.stderr, /Dry run: nothing was uploaded\. <commit> stands for the commit the upload creates\./);
});

test('publish uploads the runtime files, then latest.json pinned to their commit, and reads latest.json back from main', async t => {
  const { folder } = exportFolder(t);
  const hub = await fakeHub(t);
  const hf = fakeHf(hub);
  const log = [];
  const latest = await publish({ folder, repo, format: 'noul-v1', endpoint: hub.endpoint }, { run: hf.run, log: line => log.push(line) });
  assert.deepEqual(hf.calls[0].args, ['upload', repo, folder, '.', ...MODEL_FILES.flatMap(name => ['--include', name]), '--commit-message', 'Laya model (noul-v1)', '--json']);
  const [upload, target, file, ...rest] = hf.calls[1].args;
  assert.deepEqual([upload, target, ...rest], ['upload', repo, 'latest.json', '--commit-message', `Point latest.json at ${commit}`, '--json']);
  assert.equal(path.basename(file), 'latest.json');
  assert.equal(fs.existsSync(file), false, 'the temporary latest.json is deleted');
  assert.deepEqual(JSON.parse(hf.calls[1].latest), latest);
  assert.deepEqual(latest, latestManifest({ endpoint: hub.endpoint, repo, commit, format: 'noul-v1', files: await describeFiles(folder) }));
  assert.equal(hub.reads, 2, 'latest.json was read before the upload and after it');
  assert.deepEqual(log, [`Uploaded the model files: commit ${commit}.`, `Uploaded latest.json, pinned to ${commit}, and read it back from main.`]);
});

test('publish does nothing when latest.json already names these files in this format', async t => {
  const { folder } = exportFolder(t);
  const hub = await fakeHub(t);
  const published = latestManifest({ endpoint: hub.endpoint, repo, commit: 'e'.repeat(40), format: 'noul-v1', files: await describeFiles(folder) });
  hub.latest = Buffer.from(JSON.stringify(published));
  const hf = fakeHf(hub);
  const log = [];
  assert.deepEqual(await publish({ folder, repo, format: 'noul-v1', endpoint: hub.endpoint }, { run: hf.run, log: line => log.push(line) }), published);
  assert.deepEqual(hf.calls, []);
  assert.deepEqual(log, [`latest.json already names these files at ${'e'.repeat(40)}. Nothing was uploaded.`]);
});

test('publish stops when hf fails, and fails loudly when latest.json reads back differently', async t => {
  const { folder } = exportFolder(t);
  const hub = await fakeHub(t);
  const failing = fakeHf(hub, { fail: true });
  await assert.rejects(publish({ folder, repo, format: 'noul-v1', endpoint: hub.endpoint }, { run: failing.run, log() {} }), /hf upload failed/);
  assert.equal(failing.calls.length, 1, 'latest.json isn’t uploaded without the model files');
  const ignored = fakeHf(hub, { keep: true });
  await assert.rejects(publish({ folder, repo, format: 'noul-v1', endpoint: hub.endpoint }, { run: ignored.run, log() {} }),
    /latest\.json on main isn’t the one just uploaded \(Update check failed: the server answered 404\.\)/);
});
