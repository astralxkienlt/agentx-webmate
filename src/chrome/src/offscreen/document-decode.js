/**
 * Offscreen document — PDF / DOCX decode host.
 *
 * Why this file exists: pdfjs (3.2 MB) and mammoth (621 KB) used to be static
 * imports on the MV3 service worker's module graph, because `import()` is
 * banned in a service worker and the bundles had to be reachable somehow. That
 * cost the worker ~3.8 MB of parse on EVERY cold start, and MV3 evicts the
 * worker after ~30s idle — with a `/watch` polling every 30-120s the worker
 * wakes continuously, so it was not a once-per-session cost.
 *
 * The offscreen document is a real page context: it may dynamic-import, it has
 * a `Worker` constructor (so pdfjs uses a genuine worker thread instead of its
 * main-thread "fake worker" fallback), and its memory is separate from the
 * worker's. media/decode-host.js is the service worker's client for this.
 *
 * Loaded as `type="module"` from offscreen.html — the other offscreen scripts
 * are classic scripts, but this one needs ES imports to reach the parsers.
 * Like its siblings it filters on its own message type so they don't collide.
 *
 * Bytes arrive base64-encoded: a Uint8Array does not survive the JSON
 * serialization runtime messaging applies.
 */

import { base64ToBytes, bytesToBase64 } from '../agent/pdf-core.js';
import { enqueueDocumentDecode } from '../media/decode-queue.js';
import { extractDocxText } from '../media/extract-docx.js';
import {
  extractPdfText,
  extractPdfTextFromBytes,
  probePdfBytes,
  renderPdfPagesToPng,
} from '../agent/pdf-tools.js';

const DECODE_MESSAGE_TYPE = 'offscreen-decode';

/**
 * One decode at a time. This is where the serialization actually matters now:
 * the multi-megabyte parse buffers live in this document, not in the worker,
 * so the "at most one decoded document in memory" policy has to be enforced
 * on this side of the boundary.
 */
const OPS = {
  async pdf_text_bytes({ bytes, opts }) {
    return extractPdfTextFromBytes(base64ToBytes(bytes), opts || {});
  },
  async pdf_text_url({ url, opts }) {
    const { _pdfBytes, ...rest } = await extractPdfText(url, opts || {});
    // Hand the raw bytes back as base64 so read_pdf's Claude-passthrough tier
    // still gets them; decode-host.js rebuilds the Uint8Array.
    return _pdfBytes ? { ...rest, pdfBytesBase64: bytesToBase64(_pdfBytes) } : rest;
  },
  async pdf_probe({ bytes, opts }) {
    return probePdfBytes(base64ToBytes(bytes), opts || {});
  },
  async pdf_render({ bytes, opts }) {
    return renderPdfPagesToPng(base64ToBytes(bytes), opts || {});
  },
  async docx_text({ bytes, opts }) {
    return extractDocxText(base64ToBytes(bytes), opts || {});
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== DECODE_MESSAGE_TYPE) return false;

  const handler = OPS[msg.op];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown decode op: ${msg.op}` });
    return true;
  }

  enqueueDocumentDecode(() => handler(msg))
    .then((result) => sendResponse({ ok: true, result }))
    // Error objects do not survive messaging; the message is what callers
    // surface as a per-file outcome, so send it as a plain string.
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));

  return true; // keep sendResponse open for the async decode
});
