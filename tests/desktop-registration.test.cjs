'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { HOST_NAME } = require('../desktop/bridge.cjs');
const runFile = promisify(execFile);
const root = path.resolve(__dirname, '..');
const extensionId = 'jogldddafjfbmfjnjlbjloakjbecnjpl';

async function registrationFixture(t, platform = 'darwin') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-registration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fakeHome = path.join(directory, 'synthetic-home');
  const userData = path.join(directory, "vault's $(printf changed) $name");
  const appPath = path.join(directory, "probe's $(printf changed) $name.cjs");
  await fs.writeFile(appPath, "process.stdout.write(JSON.stringify({ userData: process.env.SECONDHAND_USER_DATA, testMode: process.env.SECONDHAND_TEST_MODE, testUserData: process.env.SECONDHAND_TEST_USER_DATA, args: process.argv.slice(2) }));\n");
  const source = await fs.readFile(path.join(root, 'desktop/registration.cjs'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, Buffer,
    process: { platform, execPath: process.execPath },
    require: name => name === 'node:os' ? { homedir: () => fakeHome } :
      name === 'node:child_process' ? { execFile: () => assert.fail('Registration must not execute system registry commands in this fixture') } :
        require(name.startsWith('.') ? path.join(root, 'desktop', name) : name)
  });
  return {
    userData, fakeHome,
    registerHost: module.exports.registerHost,
    app: { isPackaged: false, getPath: name => { assert.equal(name, 'userData'); return userData; }, getAppPath: () => appPath }
  };
}

test('development registration binds its launcher to the exact desktop data path and preserves native arguments', { skip: process.platform === 'win32' }, async t => {
  const { app, registerHost, userData, fakeHome } = await registrationFixture(t);
  const result = await registerHost(app, extensionId);
  assert.equal(result.manifestPath, path.join(fakeHome, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${HOST_NAME}.json`));
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
  assert.deepEqual(manifest, {
    name: HOST_NAME, description: 'SecondHand local benefits vault bridge',
    path: path.join(userData, 'secondhand-native-host'), type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  });
  assert.equal((await fs.stat(manifest.path)).mode & 0o777, 0o700);
  const args = [`chrome-extension://${extensionId}/`, '--parent-window=0', "literal's $(printf changed) $name"];
  // Chrome need not inherit the desktop's launch environment. A different value
  // must not redirect the host to another vault, and shell syntax stays literal.
  for (const inherited of [undefined, '/synthetic-unrelated-vault']) {
    const environment = { ...process.env };
    if (inherited === undefined) delete environment.SECONDHAND_USER_DATA;
    else {
      environment.SECONDHAND_USER_DATA = inherited;
      environment.SECONDHAND_TEST_MODE = '1';
      environment.SECONDHAND_TEST_USER_DATA = path.join(userData, 'another-test-vault');
    }
    const output = await runFile('/bin/sh', [manifest.path, ...args], { env: environment });
    assert.equal(output.stderr, '');
    assert.deepEqual(JSON.parse(output.stdout), { userData, args });
  }
});

test('packaged macOS registration still points directly to the packaged executable', async t => {
  const { app, registerHost, userData } = await registrationFixture(t);
  const result = await registerHost({ ...app, isPackaged: true }, extensionId);
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.path, process.execPath);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  await assert.rejects(fs.access(path.join(userData, 'secondhand-native-host')), { code: 'ENOENT' });
});

test('development Windows registration remains unavailable and invalid IDs write nothing', async t => {
  const { app, registerHost, userData, fakeHome } = await registrationFixture(t, 'win32');
  await assert.rejects(registerHost(app, extensionId), /On Windows, install the packaged/);
  await assert.rejects(registerHost(app, 'invalid'), /32-letter extension ID/);
  await assert.rejects(fs.access(userData), { code: 'ENOENT' });
  await assert.rejects(fs.access(fakeHome), { code: 'ENOENT' });
});
