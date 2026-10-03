'use strict';

// Build-time copy only. Processing never downloads libraries or language data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build/ocr');
const source = name => path.join(root, 'node_modules', name);
fs.mkdirSync(output, { recursive: true });
const assets = {};
function copy(from, relative) {
  const target = path.join(output, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = fs.readFileSync(from);
  fs.writeFileSync(target, bytes);
  assets[relative] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function directory(from, prefix) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('OCR assets must not contain symbolic links.');
    if (entry.isDirectory()) directory(path.join(from, entry.name), `${prefix}/${entry.name}`);
    else copy(path.join(from, entry.name), `${prefix}/${entry.name}`);
  }
}
for (const file of ['tesseract.min.js', 'worker.min.js', 'tesseract.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt']) {
  copy(source(`tesseract.js/dist/${file}`), `tesseract/${file}`);
}
// OEM 1 uses only LSTM. Include scalar, SIMD, and relaxed-SIMD variants so the
// same package runs on supported Windows x64 and both Mac architectures.
for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
  for (const suffix of ['wasm', 'wasm.js']) copy(source(`tesseract.js-core/tesseract-core-${variant}.${suffix}`), `core/tesseract-core-${variant}.${suffix}`);
}
copy(source('tesseract.js-core/LICENSE'), 'core/LICENSE');
copy(source('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), 'language/eng.traineddata.gz');
copy(source('@tesseract.js-data/eng/README.md'), 'language/README.md');
copy(source('@tesseract.js-data/eng/package.json'), 'language/package.json');
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) copy(source(`pdfjs-dist/build/${file}`), `pdf/${file}`);
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) directory(source(`pdfjs-dist/${folder}`), `pdf/${folder}`);
copy(source('pdfjs-dist/LICENSE'), 'pdf/LICENSE');
const versions = Object.fromEntries(['tesseract.js', 'tesseract.js-core', 'pdfjs-dist', '@tesseract.js-data/eng'].map(name => [name, require(source(`${name}/package.json`)).version]));
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ version: 1, versions, assets }, null, 2) + '\n');
console.log(`Prepared ${Object.keys(assets).length} bundled OCR assets (${Math.round(Object.values(assets).reduce((sum, asset) => sum + asset.bytes, 0) / 1048576)} MiB).`);
