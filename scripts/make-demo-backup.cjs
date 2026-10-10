'use strict';

// An encrypted backup that holds only the fictional applicant in tests/fixtures/applicant-profile.json (Avery
// Example and household), for demos. Restore it in the app with "Restore an encrypted backup" on the password
// screen and open it with the password given here. It is made by the app's own vault and checked as the app
// saves a profile, so it opens like any backup. It never replaces a file that is already there.
//
//   npm run demo:backup -- [file] [password]
// Without a file it writes artifacts/demo/secondhand-demo.secondhand; without a password it makes one and prints it.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Vault } = require('../desktop/vault.cjs');
const { validateProfile } = require('../shared/schema.cjs');
const profile = require('../tests/fixtures/applicant-profile.json');

const ROOT = path.join(__dirname, '..');

async function makeDemoBackup({ file, password }) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Use a password of at least 12 characters, as the app asks.');
  const vault = new Vault(path.resolve(file));
  if (await vault.exists()) throw new Error(`${file} is already there. Choose another file.`);
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const { recoveryKey } = await vault.create(password);
  const clean = validateProfile(structuredClone(profile), { today: new Date().toISOString().slice(0, 10) });
  await vault.update(data => { data.profile = clean; });
  await vault.lock();
  return { file: path.resolve(file), recoveryKey };
}

async function main() {
  const [file = path.join(ROOT, 'artifacts', 'demo', 'secondhand-demo.secondhand'), given] = process.argv.slice(2);
  const password = given || `demo ${crypto.randomBytes(9).toString('base64url')}`;
  const made = await makeDemoBackup({ file, password });
  console.log(`Wrote ${made.file}`);
  console.log(`Password: ${password}`);
  console.log(`Recovery key: ${made.recoveryKey}`);
  console.log('It holds only the fictional applicant Avery Example. Restore it from the password screen: Restore an encrypted backup.');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { makeDemoBackup };
