'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Vault } = require('../desktop/vault.cjs');
const { makeDemoBackup } = require('../scripts/make-demo-backup.cjs');
const profile = require('./fixtures/applicant-profile.json');

test('the demo backup opens with its password and holds only the fictional applicant, as the app saves a profile', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-demo-backup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'demo.secondhand');
  const made = await makeDemoBackup({ file, password: 'demo only long local phrase' });
  assert.equal(made.file, file);
  assert.match(made.recoveryKey, /\S/);
  const vault = new Vault(file);
  await vault.unlock('demo only long local phrase');
  const data = vault.getData();
  assert.equal(data.profile.firstName, profile.firstName);
  assert.equal(data.profile.email, profile.email);
  assert.equal(data.profile.householdMembers.length, profile.householdMembers.length);
  assert.deepEqual(data.applications, []);
  await assert.rejects(makeDemoBackup({ file, password: 'demo only long local phrase' }), /already/, 'an existing file is never replaced');
  await assert.rejects(makeDemoBackup({ file: path.join(directory, 'short.secondhand'), password: 'short' }), /12 characters/);
});
