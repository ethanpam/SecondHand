'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') throw new Error('Build the Windows native host on Windows.');
const root = path.resolve(__dirname, '..');
const windowsDirectory = process.env.WINDIR || 'C:\\Windows';
const compiler = ['Framework64', 'Framework'].map(directory =>
  path.join(windowsDirectory, 'Microsoft.NET', directory, 'v4.0.30319', 'csc.exe')).find(file => fs.existsSync(file));
if (!compiler) throw new Error('The Windows .NET Framework C# compiler was not found. Enable .NET Framework 4.8 and try again.');
const library = process.argv.includes('--library');
const directory = path.join(root, 'build', library ? 'native-library' : 'native');
fs.mkdirSync(directory, { recursive: true });
const result = spawnSync(compiler, [...(library ? ['/define:LIBRARY_EDITION'] : []), '/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/reference:System.Web.Extensions.dll',
  `/out:${path.join(directory, 'secondHand-native.exe')}`, path.join(root, 'desktop', 'native-launcher.cs')],
{ stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log('Built Windows native messaging relay.');
