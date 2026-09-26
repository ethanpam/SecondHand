'use strict';
// Small dependency-free ZIP writer using STORE entries. The extension contains only
// bundled text/assets; it never includes a profile, vault, or development dependency.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = path.join(root, 'extension');
const output = path.join(root, 'release/secondHand-extension.zip');
function files(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Extension must not contain symlinks.');
    return entry.isDirectory() ? files(path.join(dir, entry.name), relative + '/') : [relative];
  });
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunks = [], entries = [];
let offset = 0;
for (const relative of files(source)) {
  const name = Buffer.from(relative), data = fs.readFileSync(path.join(source, relative)), crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  chunks.push(local, name, data); entries.push(central, name);
  offset += local.length + name.length + data.length;
}
const directory = Buffer.concat(entries), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length / 2, 8); end.writeUInt16LE(entries.length / 2, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.concat([...chunks, directory, end]));
console.log('Created release/secondHand-extension.zip');
