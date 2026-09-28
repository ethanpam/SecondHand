'use strict';

// Publishes a Laya model export to its Hugging Face repo, where the desktop app looks for updates:
// uploads the runtime files, then latest.json on main, pinned to the commit that holds them, then
// reads latest.json back the way the app does. Run it with the hf CLI logged in with write access:
//   node scripts/publish-laya-model.cjs <export folder> --repo JacobTDang/secondhand-laya --format noul-v1 [--hf <path to hf>] [--dry-run]
// --hf (or SECONDHAND_HF_CLI) names the hf executable, and HF_ENDPOINT moves the Hub as it does for
// hf. --dry-run only prints latest.json. docs/laya-model.md has the steps.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MODEL_FILES, MODEL_FORMATS, validateManifest, fetchManifest } = require('../desktop/laya-model.cjs');

const USAGE = 'Usage: node scripts/publish-laya-model.cjs <export folder> --repo <owner/name> --format <format> [--hf <path to hf>] [--dry-run]';

function checkFormat(format) {
  if (!MODEL_FORMATS.includes(format)) throw new Error(`${format} isn’t a format this SecondHand can run (${MODEL_FORMATS.join(', ')}).`);
}

function parseArguments(argv, env) {
  const options = { folder: null, repo: null, format: null, hf: env.SECONDHAND_HF_CLI || 'hf',
    endpoint: (env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, ''), dryRun: false };
  const fail = message => { throw new Error(`${message}\n${USAGE}`); };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (['--repo', '--format', '--hf'].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail(`${argument} needs a value.`);
      options[argument.slice(2)] = value;
    } else if (argument.startsWith('--')) fail(`${argument} isn’t an option.`);
    else if (options.folder) fail(`Give one export folder, not ${argument} too.`);
    else options.folder = path.resolve(argument);
  }
  if (!options.folder) fail('Give the export folder.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo || '')) fail('--repo must be a Hugging Face repo id such as JacobTDang/secondhand-laya.');
  if (!options.format) fail('--format must name the model’s prompt format, such as noul-v1.');
  checkFormat(options.format);
  return options;
}

// Each runtime file's path, size, and SHA-256, in the order the app lists them.
async function describeFiles(folder) {
  const files = [];
  for (const name of MODEL_FILES) {
    const file = path.join(folder, name);
    let size;
    try { size = (await fs.stat(file)).size; }
    catch (error) { throw new Error(`The export folder has no ${name} (${error.code || error.message}).`); }
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    files.push({ path: name, size, sha256: hash.digest('hex') });
  }
  return files;
}

const manifestFor = ({ endpoint, repo, commit, format, files }) => ({ version: 1, model: { revision: commit, format,
  files: files.map(file => ({ path: file.path, url: `${endpoint}/${repo}/resolve/${commit}/${file.path}`, size: file.size, sha256: file.sha256 })) } });

// latest.json: every file pinned to the commit that holds it, checked as the app checks it.
function latestManifest(options) {
  checkFormat(options.format);
  const latest = manifestFor(options);
  validateManifest(latest);
  return latest;
}

// The commit `hf upload --json` made, from its {"url": ".../commit/<hash>"}.
function commitFrom(output) {
  let url;
  try { ({ url } = JSON.parse(output)); } catch { throw new Error(`hf upload didn’t print JSON: ${output.trim()}`); }
  const commit = /\/commit\/([0-9a-f]{40})$/.exec(url || '')?.[1];
  if (!commit) throw new Error(`hf upload named no commit: ${url}`);
  return commit;
}

// Runs the hf CLI with its progress on this terminal, and returns what it printed to stdout.
function runHf(hf) {
  return args => new Promise((resolve, reject) => {
    const child = spawn(hf, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.on('error', error => reject(new Error(`Couldn’t run ${hf} (${error.code || error.message}). Pass --hf with the path to the hf CLI.`)));
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`hf ${args[0]} failed (exit code ${code}).`)));
  });
}

// latest.json on main as it is now, or null when there is none.
async function publishedLatest(url) {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Couldn’t read ${url} (the Hub answered ${response.status}).`);
  return response.json();
}

const sameFiles = (latest, format, files) => latest?.model?.format === format && Array.isArray(latest.model.files) &&
  JSON.stringify(latest.model.files.map(({ path: file, size, sha256 }) => ({ path: file, size, sha256 }))) === JSON.stringify(files);

async function publish({ folder, repo, format, endpoint }, { run, log }) {
  const files = await describeFiles(folder);
  const latestUrl = `${endpoint}/${repo}/resolve/main/latest.json`;
  const current = await publishedLatest(latestUrl);
  if (sameFiles(current, format, files)) {
    log(`latest.json already names these files at ${current.model.revision}. Nothing was uploaded.`);
    return current;
  }
  const commit = commitFrom(await run(['upload', repo, folder, '.', ...MODEL_FILES.flatMap(name => ['--include', name]),
    '--commit-message', `Laya model (${format})`, '--json']));
  log(`Uploaded the model files: commit ${commit}.`);
  const latest = latestManifest({ endpoint, repo, commit, format, files });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-latest-'));
  try {
    const file = path.join(directory, 'latest.json');
    await fs.writeFile(file, `${JSON.stringify(latest, null, 2)}\n`);
    await run(['upload', repo, file, 'latest.json', '--commit-message', `Point latest.json at ${commit}`, '--json']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  let readBack;
  try { readBack = await fetchManifest(latestUrl, new AbortController().signal); }
  catch (error) { throw new Error(`latest.json on main isn’t the one just uploaded (${error.message})`); }
  if (JSON.stringify(readBack) !== JSON.stringify(validateManifest(latest))) {
    throw new Error(`latest.json on main isn’t the one just uploaded (it names ${readBack.model?.revision ?? 'no model'}).`);
  }
  log(`Uploaded latest.json, pinned to ${commit}, and read it back from main.`);
  return latest;
}

async function main(argv) {
  const options = parseArguments(argv, process.env);
  if (options.dryRun) {
    const files = await describeFiles(options.folder);
    process.stdout.write(`${JSON.stringify(manifestFor({ ...options, commit: '<commit>', files }), null, 2)}\n`);
    console.error('Dry run: nothing was uploaded. <commit> stands for the commit the upload creates.');
    return;
  }
  const latest = await publish(options, { run: runHf(options.hf), log: line => console.error(line) });
  process.stdout.write(`${JSON.stringify(latest, null, 2)}\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { parseArguments, describeFiles, latestManifest, commitFrom, publish };
