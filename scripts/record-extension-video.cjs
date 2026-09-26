'use strict';

// QA-only recorder. The caller owns the isolated synthetic browser and its
// captions. This module never opens a browser, navigates, reads profile data, or
// changes the page. Every displayed pane comes from an actual captured PNG.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
// Playwright's pinned package already bundles pngjs; no extra dependency/install.
const { PNG, jpegjs } = require('playwright-core/lib/utilsBundle');
const run = promisify(execFile);
const FPS = 3;
const GAP = 12;
const MAX_PIXELS = 20_000_000;

function supportsFormat(output, format, operation) {
  return output.split('\n').some(line => {
    const match = line.match(/^\s*([DE ]{1,3})\s+(\S+)\s/);
    return match && match[1].includes(operation) && match[2].split(',').includes(format);
  });
}

async function findEncoder() {
  const candidates = [process.env.SECONDHAND_FFMPEG_PATH, 'ffmpeg',
    '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].filter(Boolean);
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH) : null,
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null,
    path.join(path.dirname(require.resolve('playwright-core')), '.local-browsers')
  ].filter(Boolean);
  for (const cache of new Set(caches)) {
    const directories = await fs.readdir(cache, { withFileTypes: true }).catch(() => []);
    for (const directory of directories.filter(item => item.isDirectory() && /^ffmpeg-\d+$/.test(item.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
      for (const executable of ['ffmpeg-mac', 'ffmpeg-linux', 'ffmpeg-win64.exe', 'ffmpeg.exe', 'ffmpeg']) candidates.push(path.join(cache, directory.name, executable));
    }
  }
  let fallback;
  for (const executable of new Set(candidates)) {
    try {
      const [encoders, formats, decoders] = await Promise.all([
        run(executable, ['-hide_banner', '-encoders'], { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }),
        run(executable, ['-hide_banner', '-formats'], { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }),
        run(executable, ['-hide_banner', '-decoders'], { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true })
      ]);
      const encoderText = encoders.stdout + encoders.stderr;
      const formatText = formats.stdout + formats.stderr;
      if (!supportsFormat(formatText, 'image2pipe', 'D')) continue;
      const decoderText = decoders.stdout + decoders.stderr;
      const inputCodec = /^\s*V\S*\s+png\s/m.test(decoderText) ? 'png' : /^\s*V\S*\s+mjpeg\s/m.test(decoderText) ? 'mjpeg' : null;
      if (!inputCodec) continue;
      if (/^\s*V\S*\s+libx264\s/m.test(encoderText) && supportsFormat(formatText, 'mp4', 'E')) {
        return { executable, inputCodec, extension: 'mp4', format: 'mp4', options: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] };
      }
      if (!fallback && /^\s*V\S*\s+libvpx\s/m.test(encoderText) && supportsFormat(formatText, 'webm', 'E')) {
        fallback = { executable, inputCodec, extension: 'webm', format: 'webm', options: ['-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', '4', '-crf', '8', '-b:v', '6000k', '-pix_fmt', 'yuv420p'] };
      }
    } catch { /* An absent or incompatible local binary is not a reason to install one. */ }
  }
  if (fallback) return fallback;
  throw new Error('QA recording requires an existing ffmpeg with PNG/MJPEG input and H.264/MP4 or VP8/WebM output. Set SECONDHAND_FFMPEG_PATH to a compatible local executable. No tool was installed.');
}

async function readPng(file) {
  const bytes = await fs.readFile(file);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('QA screenshot was not a PNG.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('QA screenshot dimensions are unsupported.');
  return PNG.sync.read(bytes);
}

function composite(main, sidebar, size) {
  // Natural screenshot pixels are preserved: no cropped controls, invented UI,
  // frame interpolation, or stretching. The gutter/padding is neutral chrome.
  const image = new PNG({ width: size.width, height: size.height });
  for (let pixel = 0; pixel < image.data.length; pixel += 4) {
    image.data[pixel] = 245; image.data[pixel + 1] = 247; image.data[pixel + 2] = 240; image.data[pixel + 3] = 255;
  }
  for (const [source, left] of [[main, 0], [sidebar, size.mainWidth + GAP]]) {
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const sourceOffset = (y * source.width + x) * 4;
        const targetOffset = (y * size.width + left + x) * 4;
        const alpha = source.data[sourceOffset + 3] / 255;
        for (let channel = 0; channel < 3; channel++) image.data[targetOffset + channel] = Math.round(source.data[sourceOffset + channel] * alpha + image.data[targetOffset + channel] * (1 - alpha));
      }
    }
  }
  return image;
}

async function encode({ encoder, captures, frameCount, output }) {
  const first = await Promise.all([readPng(captures.main[0].file), readPng(captures.sidebar[0].file)]);
  const size = { mainWidth: first[0].width, sideWidth: first[1].width,
    width: Math.ceil((first[0].width + GAP + first[1].width) / 2) * 2,
    height: Math.ceil(Math.max(first[0].height, first[1].height) / 2) * 2 };
  if (size.width * size.height > MAX_PIXELS) throw new Error('The combined QA recording dimensions are unsupported.');
  const child = spawn(encoder.executable, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-vcodec', encoder.inputCodec, '-i', 'pipe:0',
    '-an', ...encoder.options, '-frames:v', String(frameCount), '-f', encoder.format, output],
  { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000); });
  // Handle stream errors even when the process exits between writes.
  child.stdin.on('error', () => {});
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`QA video encoding failed (${code}): ${stderr.trim() || 'ffmpeg exited without an output'}`)));
  });
  // Attach immediately so a process failure during frame preparation is handled.
  completed.catch(() => {});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5 * 60 * 1000);
  const indices = [0, 0], decoded = first.slice();
  try {
    for (let frame = 0; frame < frameCount; frame++) {
      const timestamp = frame * 1000 / FPS;
      for (const [index, name] of ['main', 'sidebar'].entries()) {
        const sequence = captures[name];
        let next = indices[index];
        while (next + 1 < sequence.length && sequence[next + 1].at <= timestamp) next++;
        if (next !== indices[index]) {
          decoded[index] = await readPng(sequence[next].file); indices[index] = next;
          const width = index === 0 ? size.mainWidth : size.sideWidth;
          if (decoded[index].width !== width || decoded[index].height !== first[index].height) throw new Error('Keep the QA browser and sidebar dimensions fixed while recording.');
        }
      }
      const frameImage = composite(decoded[0], decoded[1], size);
      const bytes = encoder.inputCodec === 'png' ? PNG.sync.write(frameImage, { colorType: 2 }) : jpegjs.encode(frameImage, 95).data;
      await new Promise((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()));
    }
    child.stdin.end();
    await completed;
  } catch (error) {
    child.stdin.destroy(); child.kill('SIGKILL');
    const processError = await completed.then(() => null, cause => cause);
    throw error.code === 'EPIPE' && processError ? processError : error;
  } finally { clearTimeout(timeout); }
}

/** Capture an already-open, isolated synthetic page and genuine native sidebar.
 * Call stop() in the walkthrough's finally block before closing either surface.
 * The caller must put any QA captions on its fictional fixture before starting.
 */
async function startRecording({ page, panel, outputDirectory }) {
  if (!page || typeof page.screenshot !== 'function' || !panel || typeof panel.screenshot !== 'function' || typeof outputDirectory !== 'string' || !outputDirectory.trim()) {
    throw new TypeError('Provide a Playwright page, native sidebar screenshot helper, and outputDirectory.');
  }
  const encoder = await findEncoder();
  const directory = path.resolve(outputDirectory);
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, `secondhand-extension-qa.${encoder.extension}`);
  try { await fs.access(output); throw new Error(`A QA recording already exists at ${output}. Choose a new output directory.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = await fs.mkdtemp(path.join(directory, '.secondhand-frames-'));
  const captures = { main: [], sidebar: [] };
  const started = performance.now();
  let stopping = false, failure, stopPromise;
  const wakeups = new Set();
  const wake = () => { for (const resolve of wakeups) resolve(); wakeups.clear(); };
  const wait = milliseconds => new Promise(resolve => {
    const done = () => { clearTimeout(timer); wakeups.delete(done); resolve(); };
    const timer = setTimeout(done, Math.max(0, milliseconds)); wakeups.add(done);
  });
  const capture = async name => {
    const file = path.join(temporary, `${name}-${String(captures[name].length).padStart(6, '0')}.png`);
    const at = performance.now() - started;
    if (name === 'main') await page.screenshot({ path: file, type: 'png', fullPage: false, timeout: 15000 });
    else await panel.screenshot(file);
    captures[name].push({ file, at });
  };
  try {
    const initial = await Promise.allSettled(['main', 'sidebar'].map(capture));
    const failed = initial.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw new Error('Unable to capture initial isolated QA surfaces.', { cause: error });
  }
  const loop = async name => {
    let due = performance.now() + 1000 / FPS;
    while (!stopping) {
      await wait(due - performance.now());
      if (stopping) return;
      try { await capture(name); }
      catch (error) { failure ||= new Error(`Unable to record the ${name} QA surface.`, { cause: error }); stopping = true; wake(); return; }
      due = Math.max(due + 1000 / FPS, performance.now());
    }
  };
  const loops = ['main', 'sidebar'].map(loop);
  return {
    stop() {
      if (stopPromise) return stopPromise;
      const elapsed = performance.now() - started;
      stopping = true; wake();
      stopPromise = (async () => {
        try {
          await Promise.all(loops);
          if (failure) throw failure;
          const frameCount = Math.max(1, Math.ceil(elapsed * FPS / 1000));
          const partial = path.join(temporary, `recording.${encoder.extension}`);
          await encode({ encoder, captures, frameCount, output: partial });
          // Exclusive copy prevents a concurrent recording from being overwritten.
          await fs.copyFile(partial, output, require('node:fs').constants.COPYFILE_EXCL);
          return { path: output, durationSeconds: frameCount / FPS, frameCount };
        } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      })();
      return stopPromise;
    }
  };
}

module.exports = { startRecording };
