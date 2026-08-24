/**
 * PDF helpers that need no parser — the vendor-free half of pdf-tools.js.
 *
 * Split out so the Chrome MV3 service worker can use `isPdfUrl`,
 * `fetchPdfBytes`, coverage reporting and the Claude passthrough block
 * WITHOUT pulling pdfjs (3.2 MB) into its static module graph. Everything
 * that actually parses a PDF lives in pdf-tools.js, which only the decode
 * host loads. Keep this module free of pdfjs, extension APIs and DOM
 * globals so both browser trees and test/run.js can import it directly.
 */

/**
 * Cheap byte-array → base64 conversion that doesn't blow the call
 * stack on multi-MB PDFs. fromCharCode.apply has a per-call argument
 * limit (~64k in V8), so we chunk.
 */
const BASE64_MAX_INPUT_BYTES = 32 * 1024 * 1024; // 32 MB safety cap

export function bytesToBase64(bytes) {
  if (bytes.length > BASE64_MAX_INPUT_BYTES) {
    throw new Error(`PDF too large for base64 conversion (${bytes.length} bytes, cap ${BASE64_MAX_INPUT_BYTES}).`);
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}


/**
 * Inverse of bytesToBase64. Runtime messaging JSON-serializes its payload, so
 * binary crossing the service-worker <-> decode-host boundary travels as
 * base64 and is rebuilt here — a raw Uint8Array would arrive as a plain
 * `{"0":37,"1":80,...}` object and every parser would reject it.
 */
export function base64ToBytes(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Heuristic: does this URL look like a PDF? Used by `read_page` to
 * decide whether to redirect to `read_pdf`.
 */
export function isPdfUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.pathname.toLowerCase().endsWith('.pdf')) return true;
  // Some servers include the .pdf in a query parameter (e.g. content-disposition
  // viewers, Google Drive previews). Catch the common patterns.
  const fileParam = parsed.searchParams.get('file');
  if (fileParam && fileParam.toLowerCase().endsWith('.pdf')) return true;
  return false;
}

/**
 * Fetch the PDF binary from `url`. Returns a Uint8Array.
 * Throws with a helpful message on failure — file:// URLs in Chrome
 * require the user-toggle "Allow access to file URLs" at
 * chrome://extensions, which we explain instead of leaving the
 * agent guessing.
 */
export async function fetchPdfBytes(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    let res;
    try {
      res = await fetch(url, { credentials: 'include', signal: controller.signal });
    } catch (e) {
      if (typeof url === 'string' && url.startsWith('file://')) {
        throw new Error(
          'Cannot fetch local PDF from a file:// URL. WebBrain needs ' +
          'file-URL access in Chrome: open chrome://extensions, find ' +
          'WebBrain, click "Details", and enable "Allow access to file URLs". ' +
          'Then reload the PDF tab and try read_pdf again.'
        );
      }
      throw new Error(`PDF fetch failed: ${e.message}`);
    }
    if (!res.ok) {
      throw new Error(`PDF fetch returned HTTP ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    clearTimeout(timeout);
  }
}

// A page under this many extracted characters is treated as having no usable
// text layer (page numbers and stray marks survive OCR-less scans).
export const PDF_LOW_TEXT_PAGE_CHARS = 20;

function formatPageRanges(pageNumbers) {
  const sorted = [...pageNumbers].sort((a, b) => a - b);
  const ranges = [];
  for (const page of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && page === last.end + 1) last.end = page;
    else ranges.push({ start: page, end: page });
  }
  return ranges.map(({ start, end }) => (start === end ? `${start}` : `${start}–${end}`)).join(', ');
}

/**
 * Per-page coverage check for extracted PDF text (thresholds mirror the
 * Hermes ingestion pipeline): count characters per page; when at least two
 * examined pages — and either ≥ 20% of them or ≥ 10 pages — fall under 20
 * characters, the extraction is declared partial and the English header
 * lists the low-text page ranges plus the vision escape hatch.
 *
 * @param {number[]} pageCharCounts chars per examined page
 * @param {{ fromPage?: number }} opts first examined page's 1-based number
 * @returns {{ lowTextPages: number[], partial: boolean, warning: string }}
 */
export function buildPdfCoverageReport(pageCharCounts, opts = {}) {
  const fromPage = Math.max(1, Math.floor(opts.fromPage || 1));
  const counts = Array.isArray(pageCharCounts) ? pageCharCounts : [];
  const lowTextPages = [];
  counts.forEach((count, index) => {
    if ((Number(count) || 0) < PDF_LOW_TEXT_PAGE_CHARS) lowTextPages.push(fromPage + index);
  });
  const partial = lowTextPages.length >= 2
    && (lowTextPages.length >= counts.length * 0.2 || lowTextPages.length >= 10);
  const warning = partial
    ? `[PDF text coverage warning: pages ${formatPageRanges(lowTextPages)} contain little or no extractable text — `
      + 'likely scanned images. Reading those pages requires vision: call '
      + "read_attachment with mode:'render' and the page range on a vision-capable model.]"
    : '';
  return { lowTextPages, partial, warning };
}


// Q3: scanned-PDF delivery renders at most the first 8 pages per send at
// ~144 DPI equivalent, under a shared pixel ceiling split across the pages
// still to render. Later pages go through read_attachment({mode:'render'}).
export const PDF_RENDER_MAX_PAGES_PER_SEND = 8;
export const PDF_RENDER_PIXEL_BUDGET = 4_000_000;

/**
 * Whether the given provider can natively consume PDFs as a
 * `document` content block. Currently Anthropic only — OpenAI's
 * gpt-4o has its own PDF API surface (file-uploads + references)
 * that's a different shape, not portable from the Anthropic format,
 * so we keep that for a future iteration.
 */
export function providerSupportsPdfPassthrough(provider) {
  if (!provider) return false;
  const className = provider.constructor?.name || '';
  if (className === 'AnthropicProvider') return true;
  // Some users route Claude through OpenAI-compatible endpoints; the
  // model name is the only signal there.
  const model = (provider.config?.model || '').toLowerCase();
  if (className === 'OpenAICompatibleProvider' && model.includes('claude')) return true;
  return false;
}

/**
 * Build the `document` content block for the Anthropic Messages API
 * from raw PDF bytes. Caller is responsible for size-checking — Claude's
 * cap is ~32 MB base64 / ~24 MB binary as of writing, but we cap
 * lower (16 MB binary) to leave room for the rest of the conversation.
 */
export function buildClaudeDocumentBlock(bytes, name) {
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: bytesToBase64(bytes),
    },
    ...(name ? { title: name } : {}),
  };
}

export const PDF_PASSTHROUGH_MAX_BYTES = 16 * 1024 * 1024; // 16 MB
