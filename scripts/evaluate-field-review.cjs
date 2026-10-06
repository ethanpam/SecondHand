'use strict';

// Runs only the checked-in fictional label cases against an ALREADY LOCAL
// model. No model download/update, applicant vault/settings access, or output
// of profile/document values. This evaluates warning usefulness, not OCR
// correctness, identity verification, or retraining.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createLaya } = require('../desktop/laya.cjs');
const { createFieldReview } = require('../desktop/field-review.cjs');
const fixture = require('../tests/fixtures/field-review/label-cases.json');

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index], value = args[++index];
    if (!['--model-dir', '--model-format'].includes(flag) || !value || value.startsWith('--') || Object.hasOwn(result, flag)) throw new Error('Use --model-dir PATH and --model-format noul-v1|choice-v2, or omit both to find an installed model.');
    result[flag] = value;
  }
  if (Boolean(result['--model-dir']) !== Boolean(result['--model-format']) ||
      (result['--model-format'] && !['noul-v1', 'choice-v2'].includes(result['--model-format']))) throw new Error('A local model directory needs its supported model format.');
  return result['--model-dir'] ? { modelDir: path.resolve(result['--model-dir']), modelFormat: result['--model-format'] } : null;
}

async function findLocalModel() {
  const bases = process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library/Application Support/secondhand'), path.join(os.homedir(), 'Library/Application Support/SecondHand')]
    : process.platform === 'win32'
      ? [path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'secondhand'), path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'SecondHand')]
      : [path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'secondhand'), path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'SecondHand')];
  for (const base of bases) {
    try {
      const { model } = JSON.parse(await fs.readFile(path.join(base, 'models/laya/installed.json'), 'utf8'));
      if (!model || !/^[0-9a-f]{40}$/i.test(model.revision) || !['noul-v1', 'choice-v2'].includes(model.format)) continue;
      const modelDir = path.join(base, 'models/laya', model.revision);
      await fs.access(path.join(modelDir, 'model.onnx'));
      return { modelDir, modelFormat: model.format };
    } catch { /* No local model here. Never download one for this script. */ }
  }
  return null;
}
const warned = row => row.messages.some(message => message.startsWith('Experimental Laya label check'));
const reviewed = row => warned(row) || row.messages.some(message => message.startsWith('Laya checked this source label') || message.startsWith('Laya could not map this source label'));
const requestFor = cases => ({ profile: {}, useLaya: true, documentFields: cases.map(item => ({ id: item.id, page: 1, confidence: 99, ...item.field })) });
async function deadline(work, milliseconds) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local evaluation model load timed out.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function evaluate(config) {
  if (!config) return { state: 'unavailable', message: 'No already-installed local model was found. No download was attempted.', experiment: fixture.description };
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-field-review-eval-'));
  const revision = path.basename(config.modelDir);
  const modelRevision = /^[0-9a-f]{40}$/i.test(revision) ? revision.toLowerCase() : 'custom-local-unidentified';
  // modelDir bypasses the downloader/store; the separate temporary directory
  // ensures evaluation never opens the real application's vault or settings.
  let laya;
  try {
    laya = createLaya({ ...config, userDataDir, manifest: { version: 1, model: null }, enabled: true, updateUrl: null, timeoutMs: 3000 });
    const status = await laya.status();
    if (status.state !== 'ready') return { state: 'unavailable', modelFormat: config.modelFormat, message: 'The existing local model is not ready on this platform. No download was attempted.', experiment: fixture.description };
    const reviewer = createFieldReview({ laya });
    const started = Date.now();
    const cold = await reviewer.review(requestFor(fixture.cases.slice(0, 4)), { today: '2026-10-05' });
    const coldStart = { elapsedMs: Date.now() - started, state: cold.laya.state, labelsChecked: cold.document.filter(reviewed).length, message: cold.laya.message };
    // Report warm results separately. This is not a production warm-up or an
    // extension of a review's three-second budget.
    await deadline(laya.warm(), 30000);
    const cases = [], batches = [];
    for (let index = 0; index < fixture.cases.length; index += 4) {
      const items = fixture.cases.slice(index, index + 4), request = requestFor(items), original = structuredClone(request), start = Date.now();
      const result = await reviewer.review(request, { today: '2026-10-05' });
      assert.deepEqual(request, original, 'Review must not mutate any proposed answer.');
      assert.ok(result.document.every(row => !Object.hasOwn(row, 'value') && !Object.hasOwn(row, 'confidence')), 'Results must not return values or model confidence.');
      batches.push({ state: result.laya.state, elapsedMs: Date.now() - start, labelsChecked: result.document.filter(reviewed).length });
      items.forEach((item, offset) => {
        const row = result.document[offset], checked = reviewed(row), warning = warned(row);
        if (item.expected === 'not-reviewed') assert.equal(checked, false, `Excluded case ${item.id} reached the model.`);
        cases.push({ id: item.id, expected: item.expected, labelReviewed: checked, labelWarning: warning, ...(item.limitation ? { limitation: item.limitation } : {}) });
      });
    }
    const misleading = cases.filter(item => item.expected === 'warning'), benign = cases.filter(item => item.expected === 'no-warning');
    return { state: 'evaluated', modelFormat: config.modelFormat, modelRevision, modelSource: 'Existing local files only; no downloads or updates.', experiment: fixture.description, coldStart,
      warmed: { batches, misleadingLabels: misleading.length, warningsOnMisleading: misleading.filter(item => item.labelWarning).length,
        misleadingWithoutWarning: misleading.filter(item => !item.labelWarning).map(item => item.id),
        ordinaryOrUndetectableValueCases: benign.length, warningsOnThoseCases: benign.filter(item => item.labelWarning).length, cases },
      limits: 'This tiny synthetic set is diagnostic only. Label agreement does not establish value accuracy or identity; some incorrect values cannot be detected. No model was trained or retrained.' };
  } finally {
    await laya?.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  (async () => {
    const config = parseArguments(process.argv.slice(2)) || await findLocalModel();
    process.stdout.write(`${JSON.stringify(await evaluate(config), null, 2)}\n`);
  })().catch(() => {
    process.stderr.write('Local field-label evaluation could not finish. No applicant values were logged; check the local model installation and supported format.\n');
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, findLocalModel, evaluate };
