'use strict';

// The Windows native relay (desktop/native-launcher.cs) is built only on Windows, by the C# 5 compiler that
// ships with the .NET Framework (scripts/build-native-host.cjs), and runs only there (npm run test:native with
// SECONDHAND_PACKAGED_EXE). These checks read its source, so any computer catches the mistakes that matter most.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appLaunch } = require('../desktop/bridge.cjs');
const { build } = require('../package.json');

const source = fs.readFileSync(path.join(__dirname, '..', 'desktop/native-launcher.cs'), 'utf8');
// The code without comments, and with every string and character literal emptied.
const code = source.replace(/@"(?:[^"]|"")*"|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
  token => token[0] === '/' ? '' : token[0] === "'" ? "''" : '""');

// Each call or declaration of `name` in the code, with its arguments split at top-level commas.
function uses(name) {
  return [...code.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, 'g'))].map(match => {
    const args = [];
    let depth = 1, current = '', index = match.index + match[0].length;
    for (; depth; index++) {
      const character = code[index];
      if (character === undefined) throw new Error(`Unclosed call to ${name}.`);
      if ('([{'.includes(character)) depth++;
      if (')]}'.includes(character)) depth--;
      if (depth && !(depth === 1 && character === ',')) current += character;
      else { if (current.trim()) args.push(current.trim().replace(/\s+/g, ' ')); current = ''; }
    }
    return { declaration: /\bstatic\s+(extern\s+)?[\w.[\]<>]+\s+$/.test(code.slice(0, match.index)), args };
  });
}
const calls = name => uses(name).filter(use => !use.declaration);

test('the Windows relay starts only the installed secondHand.exe in its own folder, the name the Windows build gives the app', () => {
  assert.equal(/const string AppExecutable = "([^"]*)";/.exec(source)?.[1], `${build.win.executableName}.exe`);
  assert.deepEqual(build.win.extraFiles.map(file => file.to), ['secondHand-native.exe'], 'the relay is installed next to the app');
  assert.match(code, /string folder = Path\.GetDirectoryName\(Assembly\.GetEntryAssembly\(\)\.Location\);/);
  assert.match(code, /string app = Path\.Combine\(folder, AppExecutable\);/);
});

test('the relay starts the app with nothing from the request: no arguments, none of its handles, and without the test settings', () => {
  // StartApp takes nothing, so no request value can reach it, and only openApp calls it.
  assert.equal(uses('StartApp').find(use => use.declaration)?.args.length, 0);
  assert.equal(calls('StartApp').length, 1);
  assert.equal(calls('OpenApp').length, 1);
  // Process.Start makes the app inherit the relay's handles, Chrome's native-messaging pipes among them.
  assert.doesNotMatch(code, /Process\.Start|ProcessStartInfo|ShellExecute/);
  const declared = uses('CreateProcess').filter(use => use.declaration);
  assert.equal(declared.length, 1);
  assert.deepEqual([declared[0].args[0], declared[0].args[1], declared[0].args[4], declared[0].args[6], declared[0].args[7]],
    ['string applicationName', 'StringBuilder commandLine', 'bool inheritHandles', 'IntPtr environment', 'string currentDirectory']);
  const started = calls('CreateProcess');
  assert.equal(started.length, 1, 'one place starts a process');
  assert.deepEqual(started[0].args, ['app', 'new StringBuilder("" + app + "")', 'IntPtr.Zero', 'IntPtr.Zero', 'false',
    'DetachedProcess | CreateNewProcessGroup', 'IntPtr.Zero', 'folder', 'ref startup', 'out process']);
  assert.match(source, /new StringBuilder\("\\"" \+ app \+ "\\""\)/, 'the command line is the quoted app path alone');
  // The environment is the relay's own, less the test settings the macOS host also drops.
  const env = { PATH: 'C:\\Windows', SECONDHAND_USER_DATA: 'C:\\data', SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_USER_DATA: 'C:\\temp\\test' };
  const dropped = Object.keys(env).filter(key => !Object.hasOwn(appLaunch({ execPath: 'secondHand', appPath: 'app', packaged: true, env }).options.env, key));
  assert.deepEqual(dropped, ['SECONDHAND_TEST_MODE', 'SECONDHAND_TEST_USER_DATA']);
  for (const name of dropped) {
    const removed = source.search(new RegExp(`Environment\\.SetEnvironmentVariable\\("${name}", null\\);`));
    assert.ok(removed >= 0, `${name} is removed`);
    assert.ok(removed < source.search(/(?<![\w.])CreateProcess\(app,/), `${name} is removed before the app starts`);
  }
});

test('the relay uses only C# 5, the language of the compiler that ships with Windows', () => {
  const newer = {
    'string interpolation': /\$""/,
    'null-conditional operators': /\?\.(?!\d)|\?\[(?!\])/,
    nameof: /\bnameof\s*\(/,
    'exception filters': /\bcatch\s*(\([^)]*\))?\s*when\b/,
    'using static': /\busing\s+static\b/,
    'out variables': /\bout\s+var\b/,
    'pattern variables': /\bis\s+[A-Za-z_][\w.]*\s+[a-z_]\w*\s*[)&|;]/
  };
  for (const [feature, pattern] of Object.entries(newer)) assert.doesNotMatch(code, pattern, feature);
});
