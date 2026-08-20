/**
 * Vendor bundle loading — Chrome (MV3 service worker).
 *
 * Dynamic import() is disallowed on ServiceWorkerGlobalScope by the HTML
 * specification, so the background worker cannot lazy-load pdfjs or mammoth
 * the way a page can (same constraint already noted in providers/manager.js;
 * the old lazy `import()` in pdf-tools silently broke read_pdf on Chrome).
 * Everything the worker may need is imported statically here instead: the
 * bundles join the worker's module graph once at startup, and V8's code
 * cache keeps warm starts cheap.
 *
 * pdfjs detail: the service worker has no Worker constructor, so pdfjs falls
 * back to its "fake worker" — whose default setup would dynamic-import
 * GlobalWorkerOptions.workerSrc, which is equally banned. Publishing the
 * statically imported worker module as `globalThis.pdfjsWorker` makes pdfjs
 * use it directly and skip that import entirely.
 *
 * The Firefox twin of this module keeps lazy dynamic imports (persistent
 * background *page*, where import() is allowed); both export the same
 * `loadPdfjs()` / `loadMammoth()` surface so shared callers stay identical.
 */
import * as pdfjs from '../../vendor/pdfjs/pdf.mjs';
import * as pdfjsWorkerModule from '../../vendor/pdfjs/pdf.worker.mjs';
import '../../vendor/mammoth/mammoth.browser.min.js';

if (!globalThis.pdfjsWorker?.WorkerMessageHandler) {
  globalThis.pdfjsWorker = pdfjsWorkerModule;
}
try {
  // Contexts with a real Worker constructor (a DOM page importing this
  // module) still resolve the worker by URL. Harmless where chrome.runtime
  // is unavailable (Node tests) — the guard just skips.
  if (!pdfjs.GlobalWorkerOptions.workerSrc && globalThis.chrome?.runtime?.getURL) {
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
  }
} catch { /* ignore — workerSrc stays unset outside extension contexts */ }

export async function loadPdfjs() {
  return pdfjs;
}

export async function loadMammoth() {
  if (!globalThis.mammoth?.convertToHtml) {
    throw new Error('mammoth bundle loaded but did not register its API');
  }
  return globalThis.mammoth;
}
