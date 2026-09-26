'use strict';

const path = require('node:path');
const os = require('node:os');

// Packaged native-host smoke tests need an isolated local bridge directory.
// This redirects storage only; native-origin/token and vault checks remain intact.
function testStoragePath(environment = process.env, temporaryRoot = os.tmpdir()) {
  if (environment.SECONDHAND_TEST_MODE !== '1') return null;
  const value = environment.SECONDHAND_TEST_USER_DATA;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Test storage must be an absolute temporary directory.');
  const relative = path.relative(path.resolve(temporaryRoot), path.resolve(value));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Test storage must be inside the system temporary directory.');
  }
  return path.resolve(value);
}

module.exports = { testStoragePath };
