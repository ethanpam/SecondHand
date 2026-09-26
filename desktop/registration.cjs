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

async function registerHost(app, extensionId) {
  if (!EXTENSION_ID.test(extensionId)) throw new Error('Use the 32-letter extension ID shown at chrome://extensions.');
  const userData = app.getPath('userData');
  let executable = process.execPath;
  if (!app.isPackaged) {
    if (process.platform === 'win32') throw new Error('On Windows, install the packaged SecondHand app before connecting the extension.');
    executable = path.join(userData, 'secondhand-native-host');
    await atomicWrite(executable, Buffer.from(`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(app.getAppPath())} "$@"\n`));
    await fs.chmod(executable, 0o700);
  }
  let manifestDirectory;
  if (process.platform === 'darwin') manifestDirectory = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
  else if (process.platform === 'linux') manifestDirectory = path.join(os.homedir(), '.config/google-chrome/NativeMessagingHosts');
  else if (process.platform === 'win32') manifestDirectory = path.join(userData, 'native-messaging');
  else throw new Error('Native messaging is supported on Windows, macOS, and Linux.');
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

module.exports = { registerHost };
