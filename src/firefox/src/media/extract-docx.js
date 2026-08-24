/**
 * DOCX text extraction for attachments (ingestion v2, lane B).
 *
 * Wraps the vendored mammoth browser bundle (see vendor/mammoth/README.md),
 * loaded through the per-browser vendor loader — statically on Chrome (the
 * MV3 service worker disallows dynamic import()), lazily on the Firefox
 * background page. Bytes → mammoth HTML → flattened plain text:
 *   - tables: one line per row, cells joined with ` | `
 *   - numbered lists keep their numbers (nested levels indent)
 *   - headings/paragraphs become plain lines
 * Legacy OLE .doc files never reach this module — the sniffer rejects them
 * with a dedicated message. A zip that merely wears a .docx name fails the
 * [Content_Types].xml check here and surfaces as a per-file error outcome,
 * not a failed send.
 */
import { loadMammoth } from './vendor-loader.js';
import { flattenDocxHtml, looksLikeOoxmlPackage, toUint8 } from './docx-core.js';

// Vendor-free helpers live in docx-core.js; re-exported so this module stays
// one import for the decode host and for tests that inject mammoth directly.
// Service-worker callers must NOT import from this file — it pulls mammoth
// into the module graph. They go through media/decode-host.js.
export { flattenDocxHtml, looksLikeOoxmlPackage } from './docx-core.js';

/**
 * Extract flattened text from .docx bytes.
 *
 * @param {Uint8Array|ArrayBuffer} bytesInput
 * @param {{ maxChars?: number, mammoth?: object }} opts `mammoth` is a test
 *   seam; production callers get the vendored bundle.
 * @returns {Promise<{ success: true, text: string, totalChars: number,
 *                     truncated: boolean }>}
 * @throws {Error} when the bytes are not a readable OOXML document — callers
 *   map this to a per-file `skipped:'error'` outcome.
 */
export async function extractDocxText(bytesInput, opts = {}) {
  const bytes = toUint8(bytesInput);
  const maxChars = Math.max(1000, Math.floor(opts.maxChars || 200000));
  if (!looksLikeOoxmlPackage(bytes)) {
    throw new Error('Not a readable .docx file: the archive is missing its [Content_Types].xml entry.');
  }
  const mammoth = opts.mammoth || await loadMammoth();
  // Hand mammoth a copy — some engines transfer the buffer to the unzip path.
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let converted;
  try {
    converted = await mammoth.convertToHtml({ arrayBuffer }, { ignoreEmptyParagraphs: true });
  } catch (error) {
    throw new Error(`Could not read .docx contents: ${error?.message || error}`);
  }
  const text = flattenDocxHtml(converted?.value || '');
  const truncated = text.length > maxChars;
  return {
    success: true,
    text: truncated ? text.slice(0, maxChars) : text,
    totalChars: text.length,
    truncated,
  };
}
