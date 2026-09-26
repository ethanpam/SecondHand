'use strict';

// Conversion only: this helper never captures a screen, opens an application,
// changes permissions, connects to a browser, or uploads anything. The caller
// records the real desktop/portal after user readiness, then explicitly selects
// a relevant time range. It cannot identify passwords or CAPTCHA frames for you.
// AVFoundation first copies only the video track; final clips are always silent.
// The original is preserved, and avconvert's metadata filter remains enabled.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { execFile } = require('node:child_process');
const { parseArgs, promisify } = require('node:util');
const run = promisify(execFile);
const presets = ['Preset1920x1080', 'Preset1280x720'];

function optionsFor({ source, output, startSeconds = 0, durationSeconds, maxBytes = 10_000_000 } = {}) {
  if (typeof source !== 'string' || !source.trim() || typeof output !== 'string' || !output.trim()) throw new TypeError('Provide source and output file paths.');
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new RangeError('startSeconds must be a finite, nonnegative number.');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600) throw new RangeError('Choose an explicit clip duration between 0 and 600 seconds.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_000_000 || maxBytes > 100_000_000) throw new RangeError('The file-size limit must be between 1 MB and 100 MB.');
  const input = path.resolve(source), destination = path.resolve(output);
  if (!/\.(mov|mp4|m4v)$/i.test(input)) throw new Error('Use an existing macOS MOV, MP4, or M4V recording as the source.');
  if (path.extname(destination).toLowerCase() !== '.mp4') throw new Error('The output must have an .mp4 extension.');
  if (input === destination) throw new Error('Choose an output separate from the original recording.');
  return { source: input, output: destination, startSeconds, durationSeconds, maxBytes };
}

async function transcodeClip(options) {
  const selected = optionsFor(options);
  if (process.platform !== 'darwin') throw new Error('This helper requires macOS and its built-in /usr/bin/avconvert.');
  const input = await fs.stat(selected.source);
  if (!input.isFile() || !input.size) throw new Error('The source must be a nonempty recording file.');
  try { await fs.lstat(selected.output); throw new Error('The output already exists. Choose a new filename.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directory = path.dirname(selected.output);
  await fs.mkdir(directory, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(directory, '.secondhand-live-convert-'));
  let smallestBytes;
  try {
    const silent = path.join(temporary, 'video-only.mov');
    const swift = ['-suppress-warnings', '-module-cache-path', path.join(temporary, 'swift-module-cache'), path.join(__dirname, 'silent-video.swift')];
    const inspect = async args => {
      try {
        return await run('/usr/bin/swift', [...swift, ...args], { timeout: 11 * 60 * 1000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        const detail = [error.stderr, error.stdout].filter(Boolean).join('\n').trim().slice(-2500);
        throw new Error(`Silent-video processing failed: ${detail || error.message}`, { cause: error });
      }
    };
    await inspect(['strip', selected.source, silent]);
    for (const preset of presets) {
      const candidate = path.join(temporary, `${preset}.mp4`);
      // Non-HEVC avconvert presets encode H.264. Default fast-start and metadata
      // filtering are retained. No --replace: original/output files are protected.
      try {
        await run('/usr/bin/avconvert', ['--source', silent, '--output', candidate,
          '--preset', preset, '--start', String(selected.startSeconds), '--duration', String(selected.durationSeconds)],
        { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        const detail = [error.stderr, error.stdout].filter(Boolean).join('\n').trim().slice(-2500);
        throw new Error(`macOS video conversion failed: ${detail || error.message}`, { cause: error });
      }
      const converted = await fs.stat(candidate);
      if (!converted.isFile() || !converted.size) throw new Error('macOS did not produce a nonempty video.');
      smallestBytes = Math.min(smallestBytes ?? Infinity, converted.size);
      if (converted.size <= selected.maxBytes) {
        const verification = JSON.parse((await inspect(['verify', candidate])).stdout);
        if (verification.audioTracks !== 0 || verification.videoTracks !== 1 || !(verification.durationSeconds > 0)) throw new Error('The converted clip failed silent-video verification.');
        await fs.copyFile(candidate, selected.output, constants.COPYFILE_EXCL);
        return { path: selected.output, bytes: converted.size, preset, startSeconds: selected.startSeconds,
          requestedDurationSeconds: selected.durationSeconds, durationSeconds: verification.durationSeconds,
          audioTracks: verification.audioTracks, limitBytes: selected.maxBytes };
      }
      await fs.unlink(candidate);
    }
    throw new Error(`The clip is still ${smallestBytes} bytes at 720p, exceeding the ${selected.maxBytes}-byte limit. Choose a shorter segment to preserve readable UI.`);
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, output: { type: 'string' }, start: { type: 'string', default: '0' },
    duration: { type: 'string' }, 'max-mb': { type: 'string', default: '10' }, help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log('Convert an explicitly selected part of an existing real recording to silent H.264 MP4.\n' +
      'Usage: node scripts/record-live-demo.cjs --source recording.mov --output clip.mp4 --start 5 --duration 45 [--max-mb 10]\n' +
      'Audio is removed and verified absent. Requires macOS avconvert and Swift Command Line Tools.\n' +
      'No screen capture, UI automation, permission changes, or upload. Original is preserved; output is never overwritten.\n' +
      'The conservative default limit is 10 MB. An explicit --max-mb value up to 100 is accepted.\n' +
      '1080p is tried before 720p; choose a shorter clip if it remains too large. Review the resulting clip before sharing.');
    return;
  }
  const result = await transcodeClip({ source: values.source, output: values.output,
    startSeconds: Number(values.start), durationSeconds: values.duration === undefined ? NaN : Number(values.duration), maxBytes: Number(values['max-mb']) * 1_000_000 });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { transcodeClip };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
