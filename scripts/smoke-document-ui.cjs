'use strict';

// Actual Electron + PDF rendering + English OCR + parser + encrypted vault.
// Only the native file-picker result is stubbed. The fixture and vault are
// synthetic, Laya is disabled, and no normal user-data directory is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const arguments_ = process.argv.slice(2);
const options = {};
for (let index = 0; index < arguments_.length; index += 2) {
  const flag = arguments_[index], value = arguments_[index + 1];
  if (!['--executable', '--artifacts', '--case'].includes(flag) || !value || value.startsWith('--') || options[flag]) {
    throw new Error('Usage: node scripts/smoke-document-ui.cjs [--executable /absolute/path/to/app] [--artifacts directory] [--case 1040sr|w2|ssa1099|1099nec]');
  }
  options[flag] = flag === '--case' ? value : path.resolve(value);
}
// Expected values were checked against the visible synthetic PDFs, not derived
// from parser output. Combined names remain review-only on these three samples.
const address = { addressLine1: '1847 TEST DATA AVE', addressLine2: 'APT 4B', city: 'DES MOINES', state: 'IA', zip: '50309' };
const cases = {
  '1040sr': {
    file: 'synthetic-1040sr.pdf', title: 'Form 1040-SR tax return · Tax year 2024', text: '1040',
    profile: { firstName: 'ALEXANDER', lastName: 'SAMPLE', ...address, addressLine2: '4B' },
    review: { taxLine1a: '68450', taxLine2b: '460' }, amount: 'taxLine1a'
  },
  'w2': {
    file: 'synthetic_w2_page3_2025.pdf', title: 'Form W-2 wage statement · Tax year 2025', text: 'W-2',
    profile: { ssn: '000-12-3456', addressLine1: '1847 TEST DATA AVE, APT 4B', city: 'DES MOINES', state: 'IA', zip: '50309' },
    review: { taxLineW2Box1: '68450.00', taxLineW2Box2: '8214.00', taxLineW2Box3: '68450.00', taxLineW2Box4: '4243.90', taxLineW2Box5: '68450.00', taxLineW2Box6: '992.53', w2EmployeeName: 'ALEXANDER J SAMPLE' },
    amount: 'taxLineW2Box1', ssn: 'w2EmployeeSsn'
  },
  'ssa1099': {
    file: 'synthetic_ssa1099_filled.pdf', title: 'Form SSA-1099 benefit statement', text: 'SSA-1099',
    profile: { ssn: '000-12-3456', ...address },
    review: { ssaRecipientName: 'ALEXANDER J SAMPLE', taxLineSsaBox3: '18600.00', taxLineSsaBox4: '0.00', taxLineSsaBox5: '18600.00', taxLineSsaBox6: '0.00' },
    amount: 'taxLineSsaBox3', ssn: 'applicantSsn', warning: /years disagree.*2018.*2019/
  },
  '1099nec': {
    file: 'synthetic_1099nec_copyb_2026.pdf', title: 'Form 1099-NEC nonemployee compensation · Tax year 2026', text: '1099-NEC',
    profile: address,
    review: { necRecipientName: 'ALEXANDER J SAMPLE', taxLineNecBox1a: '68450.00', taxLineNecBox1b: '0.00', taxLineNecBox1d: '0.00', taxLineNecBox3: '0.00', taxLineNecBox4: '0.00' },
    amount: 'taxLineNecBox1b', lowConfidence: 'taxLineNecBox1a'
  }
};
const caseName = options['--case'] || '1040sr';
if (!Object.hasOwn(cases, caseName)) throw new Error('Unknown synthetic document case. Choose 1040sr, w2, ssa1099, or 1099nec.');
const scenario = cases[caseName];
const fixture = path.join(root, 'tests/fixtures/ocr', scenario.file);
const executable = options['--executable'];
const output = options['--artifacts'] || path.join(root, 'artifacts/ocr', caseName);
const passphrase = 'synthetic-document-ui-vault-passphrase';
// The deliberately impossible sample SSN must be flagged, and is not selected
// or saved in this UI scenario. Address fields still exercise draft/save/lock.
const expected = Object.fromEntries(Object.entries(scenario.profile).filter(([key]) => key !== 'ssn'));

async function main() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-document-ui-'));
  let application, page;
  const errors = [];
  const started = Date.now();
  try {
    await fs.access(fixture);
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ layaEnabled: false, extensionId: '', autofillWithoutAsking: false, trustedSites: [] }));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SECONDHAND_USER_DATA;
    delete env.SECONDHAND_TEST_MODE;
    delete env.SECONDHAND_TEST_USER_DATA;
    if (executable) {
      await fs.access(executable);
      env.SECONDHAND_TEST_MODE = '1';
      env.SECONDHAND_TEST_USER_DATA = userData;
    } else env.SECONDHAND_USER_DATA = userData;
    application = await electron.launch({ ...(executable ? { executablePath: executable } : {}),
      args: executable ? [] : [root], env, timeout: 60000 });
    const runtime = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged, arch: process.arch, platform: process.platform, electron: process.versions.electron
    }));
    assert.equal(runtime.packaged, Boolean(executable), 'The requested development or packaged app must actually be running.');
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await application.evaluate(({ app, BrowserWindow, dialog }, { fixture, userData }) => {
      if (app.getPath('userData') !== userData) throw new Error('OCR UI smoke refused to use a non-isolated vault path.');
      const window = BrowserWindow.getAllWindows()[0];
      window.setBounds({ width: 1100, height: 800 });
      // Product OCR still opens/validates/reads this file through the real service.
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    }, { fixture, userData });
    await expect(page.locator('#auth-view')).toBeVisible();
    await page.locator('#passphrase').fill(passphrase);
    await page.locator('#confirm-passphrase').fill(passphrase);
    if (await page.locator('#device-reset-field').isVisible()) await page.locator('#allow-device-reset').uncheck();
    await page.locator('#auth-submit').click();
    await expect(page.locator('#recovery-dialog')).toBeVisible({ timeout: 30000 });
    await page.locator('#recovery-saved').check();
    await page.locator('#recovery-done').click();
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#setup-dialog')).toBeVisible();
    await page.locator('#setup-skip').click();
    await expect(page.locator('#setup-dialog')).not.toBeVisible();
    assert.equal((await page.evaluate(() => window.secondHand.status())).laya.enabled, false);
    const savedBeforeRead = await page.evaluate(async () => (await window.secondHand.getData()).profile);

    // Keep unrelated, intentionally unsaved edits while reading the PDF.
    await page.locator('.nav-item[data-view="profile"]').click();
    await page.locator('#firstName').fill('Existing fictional draft');
    await page.locator('#email').fill('preserved@example.invalid');
    await page.locator('#monthlyEarnedIncome').fill('1234.00');
    await page.locator('.nav-item[data-view="documents"]').click();
    await expect(page.locator('#view-documents')).toBeVisible();
    await page.screenshot({ path: path.join(output, 'document-ui-empty.png') });
    await page.evaluate(() => {
      window.__documentUiSmokeProgress = [];
      window.__documentUiSmokeUnsubscribe = window.secondHand.onDocumentProgress(({ phase, page, total }) => window.__documentUiSmokeProgress.push({ phase, page, total }));
    });
    await page.locator('#read-document').click();
    await expect(page.locator('#document-progress-card')).toBeVisible();
    await page.waitForFunction(() => !document.getElementById('document-review').hidden || !document.getElementById('document-error').hidden, null, { timeout: 180000 });
    assert.equal(await page.locator('#document-error').isVisible(), false, await page.locator('#document-error').textContent());
    await expect(page.locator('#document-review')).toBeVisible();
    await expect(page.locator('#read-document')).toBeEnabled();
    await expect(page.locator('#document-name')).toHaveText(scenario.file);
    await expect(page.locator('#document-type')).toHaveText(scenario.title);
    await expect(page.locator('#document-draft-note')).toBeVisible();
    assert.equal(await page.locator('#document-fields input[type="checkbox"]:checked').count(), 0);
    await expect(page.locator('#apply-document-fields')).toBeDisabled();
    assert.deepEqual(await page.evaluate(async () => (await window.secondHand.getData()).profile), savedBeforeRead, 'Reading must not save OCR values.');
    await expect(page.locator('#firstName')).toHaveValue('Existing fictional draft');
    const rows = await page.locator('#document-fields .document-field').evaluateAll(rows => rows.map(row => ({
      id: row.dataset.fieldId,
      key: row.querySelector('input[type="checkbox"]')?.dataset.profileKey || null,
      value: row.querySelector('input[type="text"]')?.value || row.querySelector('.document-field-value strong')?.textContent || null,
      label: row.querySelector('.document-field-label')?.textContent || ''
    })));
    assert.deepEqual(Object.fromEntries(rows.filter(row => row.key).map(row => [row.key, row.value])), scenario.profile);
    assert.equal(rows.filter(row => row.key).some(row => /Income|birthDate|middleName/i.test(row.key)), false, 'Conflicting identity readings and historical amounts must not become selectable suggestions.');
    assert.deepEqual(Object.fromEntries(rows.filter(row => !row.key).map(row => [row.id, row.value])),
      scenario.review, 'Historical amounts and ambiguous names remain review-only.');
    await expect(page.locator('#document-review-summary')).toContainText('fields checked');
    await expect(page.locator('#document-fields .field-review-result')).toHaveCount(rows.length);
    if (caseName === '1040sr') await expect(page.locator('[data-field-id="applicantFirstName"] .field-review-result')).toHaveClass(/needs-review/);
    if (scenario.ssn) await expect(page.locator(`[data-field-id="${scenario.ssn}"] .field-review-result`)).toHaveClass(/needs-review/);
    if (scenario.lowConfidence) await expect(page.locator(`[data-field-id="${scenario.lowConfidence}"] .field-review-result`)).toContainText(/confidence is low/i);
    if (scenario.warning) await expect(page.locator('#document-warnings')).toContainText(scenario.warning);
    await expect(page.locator(`[data-field-id="${scenario.amount}"] .field-review-result`)).toContainText(/historical|annual|current income/i);
    await expect(page.locator('#document-review-laya')).not.toBeChecked();
    // Explicitly requesting model feedback never turns on a disabled model.
    await page.locator('#document-review-laya').check();
    await page.locator('#check-document-fields').click();
    await expect(page.locator('#document-review-summary')).toContainText('fields checked');
    await expect(page.locator('#document-review-laya-status')).toContainText(/off|unavailable|not ready|No supported applicant source labels/i);
    assert.equal((await page.evaluate(() => window.secondHand.status())).laya.enabled, false);
    await expect(page.locator('#apply-document-fields')).toBeDisabled();
    const progress = await page.evaluate(() => window.__documentUiSmokeProgress);
    assert.ok(progress.some(event => event.phase === 'recognizing' && event.page === 1 && event.total === 1));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'document-ui-review.png'), fullPage: true });
    await page.locator('#document-raw > summary').click();
    await expect(page.locator('#document-pages')).toContainText(scenario.text);
    await page.locator('#document-pages .document-page > summary').first().click();
    await page.locator('#document-raw').screenshot({ path: path.join(output, 'document-ui-text.png') });
    await page.locator('#document-raw > summary').click();

    for (const key of Object.keys(expected)) await page.locator(`#document-fields input[data-profile-key="${key}"]`).check();
    await expect(page.locator('#apply-document-fields')).toBeDisabled();
    await page.locator('#document-confirm-applicant').check();
    await page.locator('#apply-document-fields').click();
    await expect(page.locator('#view-profile')).toBeVisible();
    for (const [key, value] of Object.entries(expected)) await expect(page.locator(`#${key}`)).toHaveValue(value);
    await expect(page.locator('#email')).toHaveValue('preserved@example.invalid');
    await expect(page.locator('#monthlyEarnedIncome')).toHaveValue('1234.00');
    await expect(page.locator('#ssn')).toHaveValue('');
    await expect(page.locator('#birthDate')).toHaveValue('');
    await expect(page.locator('#profile-save-state')).toHaveText('Unsaved changes');
    assert.deepEqual(await page.evaluate(async () => (await window.secondHand.getData()).profile), savedBeforeRead, 'Applying reviewed fields still must not save the draft.');
    for (const id of ['document-name', 'document-fields', 'document-pages']) assert.equal(await page.locator(`#${id}`).textContent(), '');
    await page.screenshot({ path: path.join(output, 'document-ui-draft.png') });
    // A structurally impossible SSN is flagged without changing it or saving anything.
    await page.locator('#ssn').fill('000-12-0000');
    await page.locator('#check-profile-fields').click();
    await expect(page.locator('#profile-review-summary')).toContainText('fields checked');
    await expect(page.locator('[data-review-scope="profile"][data-review-key="ssn"]')).toHaveClass(/needs-review/);
    await expect(page.locator('#ssn')).toHaveValue('000-12-0000');
    assert.deepEqual(await page.evaluate(async () => (await window.secondHand.getData()).profile), savedBeforeRead);
    await expect(page.locator('#toast')).toBeHidden({ timeout: 10000 });
    await page.screenshot({ path: path.join(output, 'field-review-profile.png'), fullPage: true });
    await page.locator('#ssn').fill('');
    await expect(page.locator('#profile-review-summary')).toBeEmpty();
    await page.locator('#save-profile').click();
    await expect(page.locator('#profile-save-state')).toBeHidden();
    const saved = await page.evaluate(async () => (await window.secondHand.getData()).profile);
    for (const [key, value] of Object.entries(expected)) assert.equal(saved[key], value);
    assert.equal(saved.email, 'preserved@example.invalid');
    assert.equal(saved.monthlyEarnedIncome, '1234.00');
    assert.equal(saved.ssn, ''); assert.equal(saved.birthDate, '');
    const vaultBytes = await fs.readFile(path.join(userData, 'vault.secondhand'), 'utf8');
    for (const secret of [...Object.values(expected), 'preserved@example.invalid', scenario.file, passphrase]) {
      // Short apartment/state strings can occur by chance in encrypted base64.
      if (secret.length > 6) assert.equal(vaultBytes.includes(secret), false, 'Saved applicant text must not appear as plaintext in the vault.');
    }
    await page.locator('#lock-button').click();
    await expect(page.locator('#auth-view')).toBeVisible();
    await expect(page.locator('#firstName')).toHaveValue('');
    for (const id of ['document-name', 'document-fields', 'document-pages']) assert.equal(await page.locator(`#${id}`).textContent(), '');
    await page.locator('#passphrase').fill(passphrase);
    await page.locator('#auth-submit').click();
    await expect(page.locator('#workspace')).toBeVisible({ timeout: 30000 });
    assert.deepEqual(await page.evaluate(() => window.secondHand.getData()).then(data => data.profile), saved);
    await page.locator('.nav-item[data-view="profile"]').click();
    await expect(page.locator('#firstName')).toHaveValue(expected.firstName || 'Existing fictional draft');
    await page.locator('.nav-item[data-view="documents"]').click();
    await expect(page.locator('#document-empty')).toBeVisible();
    await expect(page.locator('#document-review')).toBeHidden();
    assert.equal((await page.evaluate(() => window.secondHand.status())).laya.enabled, false);
    assert.equal((await fs.readdir(userData)).includes(scenario.file), false);
    await page.evaluate(() => { window.__documentUiSmokeUnsubscribe(); delete window.__documentUiSmokeUnsubscribe; delete window.__documentUiSmokeProgress; });
    assert.deepEqual(errors, []);
    const report = {
      passed: true, runtime, fixture: `tests/fixtures/ocr/${scenario.file}`, durationSeconds: (Date.now() - started) / 1000,
      actual: ['Electron desktop UI', 'native IPC', 'PDF rendering', 'two English OCR passes', 'document analysis', 'encrypted vault save', 'lock and unlock'],
      stubbed: ['native file-picker response selects the explicit synthetic fixture'],
      selectedKeys: Object.keys(expected), reviewOnlyFieldCount: rows.filter(row => !row.key).length,
      progressPhases: [...new Set(progress.map(event => event.phase))],
      assertions: ['all suggestions unchecked', 'reading and apply never auto-save', 'applicant attestation required', 'unrelated unsaved edits preserved', 'annual income not converted', 'OCR review cleared on leaving and lock', 'saved values persist after unlock', 'Laya disabled', 'every OCR candidate gets a rule result', 'optional model review does not enable Laya', 'impossible SSN flagged without correction or saving', 'edits clear previous review'],
      screenshots: ['document-ui-empty.png', 'document-ui-review.png', 'document-ui-text.png', 'document-ui-draft.png', 'field-review-profile.png'],
      limitations: 'Synthetic document only. This does not establish recognition accuracy on arbitrary real tax returns; every selected answer requires review.'
    };
    await fs.writeFile(path.join(output, 'document-ui-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Document UI smoke passed (${runtime.packaged ? 'packaged' : 'development'} ${runtime.platform}/${runtime.arch}): actual PDF OCR, ${Object.keys(expected).length} reviewed draft fields, no auto-save, preserved edits, encrypted save and lock/unlock. Artifacts: ${output}`);
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error('Document UI state:', await page.evaluate(() => ({
        documentStatus: document.getElementById('document-status').textContent,
        documentError: document.getElementById('document-error').textContent,
        progress: document.getElementById('document-progress-label').textContent,
        reviewVisible: !document.getElementById('document-review').hidden
      })).catch(() => ({ unavailable: true })));
      if (await page.locator('#workspace').isVisible().catch(() => false)) await page.screenshot({ path: path.join(output, 'document-ui-failure.png'), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (application) await application.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
