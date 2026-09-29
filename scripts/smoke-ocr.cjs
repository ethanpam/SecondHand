'use strict';

// Standalone actual Electron OCR harness. It never starts desktop/main.cjs,
// opens a vault, or starts Laya. --input/--output are for explicitly synthetic
// QA documents only; the product UI cannot choose arbitrary output paths.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' });
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (signal) process.stderr.write(`Local OCR process stopped by ${signal}.\n`);
    process.exitCode = code === 0 ? 0 : 1;
  });
} else {
  const { app, BrowserWindow, session, ipcMain } = require('electron');
  const { createOcrEngine } = require('../desktop/ocr-engine.cjs');
  const { readSelectedFile } = require('../desktop/ocr-service.cjs');
  const { analyzeDocument } = require('../shared/document-parser.cjs');
  let temporary, engine;
  app.on('window-all-closed', () => {});
  async function syntheticImage() {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await window.loadURL('about:blank');
      const data = await window.webContents.executeJavaScript(`(() => {
        const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=1000;
        const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,1600,1000);
        c.fillStyle='black';c.font='48px Arial';
        ['SYNTHETIC DOCUMENT FOR LOCAL OCR TEST', 'Avery Example', 'Monthly income 1234.00', 'Never submit this test document.'].forEach((text,i)=>c.fillText(text,80,130+i*140));
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      return Buffer.from(data, 'base64');
    } finally { window.destroy(); }
  }
  function syntheticPdf(pageCount) {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({length: pageCount}, (_,i)=>`${i+3} 0 R`).join(' ')}] >>`,
      ...Array.from({length: pageCount}, ()=> '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>')];
    let content = '%PDF-1.7\n'; const offsets = [0];
    objects.forEach((value,index)=>{ offsets.push(Buffer.byteLength(content)); content += `${index+1} 0 obj\n${value}\nendobj\n`; });
    const xref = Buffer.byteLength(content);
    content += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
    content += offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('');
    content += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(content);
  }
  (async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-ocr-smoke-'));
    app.setPath('userData', temporary);
    await app.whenReady();
    if (process.platform === 'darwin') app.dock?.hide();
    const arguments_ = process.argv.slice(2);
    const argument = name => arguments_.includes(name) ? arguments_[arguments_.indexOf(name) + 1] : null;
    const input = argument('--input');
    const output = argument('--output');
    const bytes = input ? await readSelectedFile(path.resolve(input)) : await syntheticImage();
    const assetsDirectory = argument('--assets') || path.join(root, 'build/ocr');
    engine = createOcrEngine({ BrowserWindow, session, ipcMain, assetsDirectory });
    const result = await engine.read(bytes, { onProgress: value => process.stdout.write(`OCR ${value.phase} ${value.page}/${value.total}\n`) });
    assert.ok(result.pages.every(page => page.text.length && page.words.length), 'OCR must return text and positioned words');
    assert.ok(result.pages.every(page => page.alternative?.words.length), 'Both segmentation passes must return positioned words');
    if (!input) assert.match(result.pages[0].text, /Avery Example/i);
    const document = { name: input ? path.basename(input) : 'synthetic-smoke.png', ...result };
    document.analysis = analyzeDocument(document);
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(document, null, 2), { mode: 0o600 });
    if (!input) {
      // Abort a real WASM job at recognition, not just a promise stub. No late
      // result can survive destruction of its sandboxed worker window.
      engine = createOcrEngine({ BrowserWindow, session, ipcMain, assetsDirectory });
      const controller = new AbortController();
      await assert.rejects(engine.read(bytes, { signal: controller.signal, onProgress: value => {
        if (value.phase === 'recognizing') controller.abort();
      } }), { code: 'CANCELLED' });
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      engine = createOcrEngine({ BrowserWindow, session, ipcMain, assetsDirectory });
      await assert.rejects(engine.read(syntheticPdf(13)), { code: 'PAGE_LIMIT' });
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      process.stdout.write('Actual OCR cancellation and 13-page PDF rejection passed.\n');
    }
    bytes.fill(0);
    process.stdout.write(`Local OCR smoke passed: ${result.pageCount} page(s), ${result.pages.reduce((n,p)=>n+p.words.length,0)} positioned words.\n`);
  })().then(async () => {
    engine?.cancel();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    app.exit(0);
  }, async error => {
    engine?.cancel();
    process.stderr.write(`Local OCR smoke failed: ${error.code || error.name}: ${error.publicMessage || error.message}\n`);
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    app.exit(1);
  });
}
