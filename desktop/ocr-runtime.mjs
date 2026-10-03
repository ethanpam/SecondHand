import * as pdfjs from './assets/pdf/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./assets/pdf/pdf.worker.mjs', location.href).href;
const api = window.localDocumentWorker;
const error = code => Object.assign(new Error(code), { code });
const clampConfidence = number => Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;

function dimensions(width, height, limits, scale = 1) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > limits.dimension || height > limits.dimension) throw error('IMAGE_SIZE');
  const bounded = Math.min(scale, Math.sqrt((limits.pagePixels - 10000) / (width * height)), limits.dimension / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * bounded)), height: Math.max(1, Math.floor(height * bounded)), scale: bounded };
}
function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
  return { canvas, context };
}
function wordsFrom(data, limits, width, height) {
  const words = [];
  for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) for (const word of line.words || []) {
    if (words.length >= limits.wordsPerPage || typeof word.text !== 'string' || word.text.length > 1000) throw error('OUTPUT_LIMIT');
    const b = word.bbox;
    if (!b) continue;
    words.push({ text: word.text, confidence: clampConfidence(word.confidence), bbox: {
      x0: Math.max(0, Math.min(width, b.x0)), y0: Math.max(0, Math.min(height, b.y0)),
      x1: Math.max(0, Math.min(width, b.x1)), y1: Math.max(0, Math.min(height, b.y1))
    } });
  }
  return words;
}

api.start(async ({ bytes, format, limits }) => {
  let worker, loadingTask, pdf, bitmap;
  const pages = [];
  let total = 1, textCount = 0, wordCount = 0;
  try {
    api.progress({ phase: 'loading', page: 0, total: 0 });
    if (format.kind === 'pdf') {
      loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false,
        maxImageSize: limits.imagePixels, canvasMaxAreaInBytes: limits.pagePixels * 4,
        cMapUrl: new URL('./assets/pdf/cmaps/', location.href).href, cMapPacked: true,
        standardFontDataUrl: new URL('./assets/pdf/standard_fonts/', location.href).href,
        wasmUrl: new URL('./assets/pdf/wasm/', location.href).href,
        iccUrl: new URL('./assets/pdf/iccs/', location.href).href,
        useSystemFonts: false, verbosity: 0 });
      pdf = await loadingTask.promise;
      total = pdf.numPages;
      if (!Number.isInteger(total) || total < 1 || total > limits.pages) throw error('PAGE_LIMIT');
    } else {
      bitmap = await createImageBitmap(new Blob([bytes], { type: format.kind === 'png' ? 'image/png' : 'image/jpeg' }));
      if (bitmap.width * bitmap.height > limits.imagePixels) throw error('IMAGE_SIZE');
    }
    worker = await Tesseract.createWorker('eng', 1, {
      workerPath: new URL('./assets/tesseract/worker.min.js', location.href).href,
      corePath: new URL('./assets/core', location.href).href,
      langPath: new URL('./assets/language', location.href).href,
      cacheMethod: 'none', workerBlobURL: false, gzip: true,
      errorHandler: () => api.fail('READ_FAILED')
    });
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1', user_defined_dpi: '300' });
    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      api.progress({ phase: 'rendering', page: pageNumber, total });
      let canvas, page;
      try {
        if (pdf) {
          page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1 });
          // Some scanner PDFs declare an unusually small page box. Keep a
          // legible minimum raster size rather than trusting its declared DPI.
          const target = dimensions(viewport.width, viewport.height, limits, Math.max(300 / 72, 2600 / Math.max(viewport.width, viewport.height)));
          const image = canvasOf(target.width, target.height);
          canvas = image.canvas;
          await page.render({ canvasContext: image.context, viewport: page.getViewport({ scale: target.scale }), annotationMode: pdfjs.AnnotationMode.DISABLE, background: 'rgb(255,255,255)' }).promise;
        } else {
          const target = dimensions(bitmap.width, bitmap.height, limits);
          const image = canvasOf(target.width, target.height);
          canvas = image.canvas; image.context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        }
        api.progress({ phase: 'recognizing', page: pageNumber, total });
        const recognize = async segmentation => {
          await worker.setParameters({ tessedit_pageseg_mode: segmentation });
          const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
          if (typeof data.text !== 'string' || data.text.length > limits.textPerPage) throw error('OUTPUT_LIMIT');
          const words = wordsFrom(data, limits, canvas.width, canvas.height);
          textCount += data.text.length; wordCount += words.length;
          if (textCount > limits.totalText || wordCount > limits.totalWords) throw error('OUTPUT_LIMIT');
          return { text: data.text, confidence: clampConfidence(data.confidence), words };
        };
        // Automatic and sparse-text segmentation can disagree on ruled forms.
        // Preserve both results for conservative parsing, never repair digits.
        const primary = await recognize('3');
        const alternative = await recognize('11');
        pages.push({ pageNumber, ...primary, width: canvas.width, height: canvas.height, alternative });
      } finally {
        if (canvas) { canvas.width = 1; canvas.height = 1; }
        page?.cleanup();
      }
    }
    api.complete({ pageCount: total, pages });
  } catch (failure) {
    api.fail(failure?.name === 'PasswordException' ? 'PASSWORD' : failure?.code || 'READ_FAILED');
  } finally {
    // Main destroys this renderer after any outcome, also terminating a worker
    // stuck in initialization/recognition. These are best-effort eager cleanup.
    bitmap?.close();
    await worker?.terminate().catch(() => {});
    await loadingTask?.destroy().catch(() => {});
  }
});
