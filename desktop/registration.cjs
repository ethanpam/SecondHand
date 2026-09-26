'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { atomicWrite } = require('./vault.cjs');
const { HOST_NAME, EXTENSION_ID } = require('./bridge.cjs');
const runFile = promisify(execFile);

const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;

// Windows registers the manifest through the registry instead of a fixed folder.
function chromeHostManifestDirectory(platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') return path.posix.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
  if (platform === 'linux') return path.posix.join(home, '.config/google-chrome/NativeMessagingHosts');
  return null;
}

async function registerHost(app, extensionId) {
  if (!EXTENSION_ID.test(extensionId)) throw new Error('Use the 32-letter extension ID shown at chrome://extensions.');
  const userData = app.getPath('userData');
  let executable = process.execPath;
  if (!app.isPackaged) {
    if (process.platform === 'win32') throw new Error('On Windows, install the packaged SecondHand app before connecting the extension.');
    executable = path.join(userData, 'secondhand-native-host');
    // Chrome launches this process with its own environment. Keep it bound to
    // the desktop that registered it, including an isolated development vault.
    await atomicWrite(executable, Buffer.from(`#!/bin/sh\nexport SECONDHAND_USER_DATA=${shellQuote(userData)}\nunset SECONDHAND_TEST_MODE SECONDHAND_TEST_USER_DATA\nexec ${shellQuote(process.execPath)} ${shellQuote(app.getAppPath())} "$@"\n`));
    await fs.chmod(executable, 0o700);
  }
  if (process.platform === 'win32') {
    executable = path.join(path.dirname(process.execPath), 'secondHand-native.exe');
    await fs.access(executable);
  }
  let manifestDirectory = chromeHostManifestDirectory();
  if (process.platform === 'win32') manifestDirectory = path.join(userData, 'native-messaging');
  else if (!manifestDirectory) throw new Error('Native messaging is supported on Windows, macOS, and Linux.');
  const manifestPath = path.join(manifestDirectory, `${HOST_NAME}.json`);
  await atomicWrite(manifestPath, Buffer.from(JSON.stringify({
    name: HOST_NAME,
    description: 'SecondHand local benefits vault bridge',
    path: executable,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  }, null, 2)));
  if (process.platform === 'win32') {
    await runFile('reg.exe', ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
  }
  return { extensionId, manifestPath };
}

module.exports = { registerHost, chromeHostManifestDirectory };
