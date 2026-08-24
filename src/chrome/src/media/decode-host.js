/**
 * Document decode host — Chrome (MV3 service worker).
 *
 * The service worker must NOT hold pdfjs (3.2 MB) or mammoth (621 KB) in its
 * static module graph: MV3 evicts the worker after ~30s idle and re-parses the
 * whole graph on every wake — and with a `/watch` polling every 30-120s that
 * is continuous. `import()` is banned in a service worker, so the bundles
 * cannot be lazy-loaded there either. They move instead into the offscreen
 * document, which is a real page context (dynamic import, a `Worker`
 * constructor for pdfjs, and its own memory), and this module is the worker's
 * side of that boundary.
 *
 * The Firefox twin exports the same five functions but calls the parsers
 * directly: its background *page* may lazy-import, and Firefox has no
 * offscreen API. Both trees expose one identical surface so shared callers
 * (agent.js, background.js) stay byte-identical — same convention as
 * media/vendor-loader.js, the other deliberately divergent module.
 *
 * Bytes cross runtime messaging as base64. A Uint8Array put on a message
 * arrives as a plain `{"0":37,"1":80,…}` object, which every parser rejects —
 * that shape of mistake is what once shipped DOCX/PDF extraction dead on
 * Chrome, so encoding here is explicit rather than incidental.
 */

import { ensureOffscreen } from '../offscreen/ensure.js';
import { base64ToBytes, bytesToBase64 } from '../agent/pdf-core.js';

export const DECODE_MESSAGE_TYPE = 'offscreen-decode';

/**
 * Options that survive JSON serialization. `pdfjs`, `mammoth` and
 * `createCanvas` are live objects/functions that messaging silently drops;
 * forwarding them would look like injection while actually sending nothing.
 * The offscreen document resolves its own vendor bundles and OffscreenCanvas,
 * so the plain-data options below are the entire contract.
 */
const TRANSFERABLE_OPTS = Object.freeze([
  'fromPage',
  'toPage',
  'maxChars',
  'truncationHint',
  'pages',
  'pixelBudget',
  'sampleLimit',
]);

function plainOpts(opts) {
  const out = {};
  for (const key of TRANSFERABLE_OPTS) {
    if (opts && opts[key] !== undefined) out[key] = opts[key];
  }
  return out;
}

async function callDecodeHost(op, payload) {
  await ensureOffscreen();
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: DECODE_MESSAGE_TYPE, op, ...payload });
  } catch (error) {
    throw new Error(`Document decode host unreachable: ${error?.message || error}`);
  }
  if (!response) throw new Error('Document decode host returned no response.');
  if (!response.ok) throw new Error(response.error || 'Document decode failed.');
  return response.result;
}

export async function extractPdfTextFromBytes(bytes, opts = {}) {
  return callDecodeHost('pdf_text_bytes', { bytes: bytesToBase64(bytes), opts: plainOpts(opts) });
}

export async function extractPdfText(url, opts = {}) {
  const result = await callDecodeHost('pdf_text_url', { url, opts: plainOpts(opts) });
  if (!result || typeof result !== 'object') return result;
  // read_pdf's Claude-passthrough tier expects raw bytes back under _pdfBytes;
  // rebuild them so callers see the same shape a direct call would return.
  const { pdfBytesBase64, ...rest } = result;
  return pdfBytesBase64 ? { ...rest, _pdfBytes: base64ToBytes(pdfBytesBase64) } : rest;
}

export async function probePdfBytes(bytes, opts = {}) {
  return callDecodeHost('pdf_probe', { bytes: bytesToBase64(bytes), opts: plainOpts(opts) });
}

export async function renderPdfPagesToPng(bytes, opts = {}) {
  return callDecodeHost('pdf_render', { bytes: bytesToBase64(bytes), opts: plainOpts(opts) });
}

export async function extractDocxText(bytes, opts = {}) {
  return callDecodeHost('docx_text', { bytes: bytesToBase64(bytes), opts: plainOpts(opts) });
}
