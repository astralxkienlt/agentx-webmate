/**
 * Document decode host — Firefox (MV2 background page).
 *
 * Firefox decodes in place: its background page may use dynamic `import()`, so
 * media/vendor-loader.js lazy-loads pdfjs and mammoth on first use and neither
 * bundle sits on the startup path. There is also no offscreen API to move the
 * work into. So this module is a straight pass-through to the parsers.
 *
 * The Chrome twin proxies the same five functions to its offscreen document,
 * because an MV3 service worker can neither hold the bundles cheaply (it is
 * re-parsed on every wake) nor lazy-load them (`import()` is banned there).
 * Both trees expose one identical surface so shared callers (agent.js,
 * background.js) stay byte-identical — same convention as
 * media/vendor-loader.js, the other deliberately divergent module.
 */

export {
  extractPdfText,
  extractPdfTextFromBytes,
  probePdfBytes,
  renderPdfPagesToPng,
} from '../agent/pdf-tools.js';
export { extractDocxText } from './extract-docx.js';
