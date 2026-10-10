// A separate installation and vault; the Chrome connection is prepared from the chosen edition.
'use strict';
const { build } = require('../package.json');
module.exports = {
  ...build,
  appId: 'org.secondhand.library',
  productName: 'SecondHand Library',
  artifactName: 'secondHand-library-${version}-${os}-${arch}.${ext}',
  directories: { ...build.directories, output: 'release/library' },
  extraMetadata: { secondHandEdition: 'library' },
  win: { ...build.win, extraFiles: [{ from: 'build/native-library/secondHand-native.exe', to: 'secondHand-native.exe' }] },
  mac: { ...build.mac, executableName: 'SecondHand Library' },
  dmg: { ...build.dmg, title: 'SecondHand Library ${version}' }
};
