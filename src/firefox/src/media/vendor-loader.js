/**
 * Vendor bundle loading — Firefox (persistent MV2 background page).
 *
 * A background *page* may dynamic-import freely, so the heavy vendor
 * bundles stay lazy: users who never touch a PDF or DOCX never pay their
 * load cost. The Chrome twin of this module imports the same bundles
 * statically instead — dynamic import() is disallowed in the MV3 service
 * worker — and both export the same `loadPdfjs()` / `loadMammoth()`
 * surface so shared callers stay identical across the trees.
 */
let pdfjsPromise = null;
let mammothPromise = null;

export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(browser.runtime.getURL('vendor/pdfjs/pdf.mjs'))
      .then((pdfjs) => {
        // Worker URL must be set BEFORE the first getDocument() call; the
        // runtime URL works at any extension-id deploy target.
        pdfjs.GlobalWorkerOptions.workerSrc = browser.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
        return pdfjs;
      })
      .catch((error) => {
        pdfjsPromise = null;
        throw error;
      });
  }
  return pdfjsPromise;
}

export function loadMammoth() {
  if (!mammothPromise) {
    // The UMD wrapper attaches the API to the global scope as a side effect.
    mammothPromise = import(browser.runtime.getURL('vendor/mammoth/mammoth.browser.min.js'))
      .then(() => {
        if (!globalThis.mammoth?.convertToHtml) {
          throw new Error('mammoth bundle loaded but did not register its API');
        }
        return globalThis.mammoth;
      })
      .catch((error) => {
        mammothPromise = null;
        throw error;
      });
  }
  return mammothPromise;
}
