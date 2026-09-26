'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

(async () => {
  const directory = path.resolve(process.argv[2] || path.join(__dirname, '../release'));
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(exe|dmg|zip)$/.test(entry.name))
    .map(entry => entry.name).sort();
  if (!files.length) throw new Error('No downloadable installers or extension archive found.');
  const lines = [];
  for (const file of files) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(directory, file))) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${file}`);
  }
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  console.log(`Wrote SHA-256 checksums for ${files.length} downloads.`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
