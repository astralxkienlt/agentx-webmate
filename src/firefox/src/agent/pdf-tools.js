/**
 * PDF reading for the agent (Firefox).
 *
 * Why a separate module: Firefox's built-in PDF viewer is a privileged
 * page (about:reader-style) that our content scripts cannot inject into,
 * so click / read_page / get_accessibility_tree all silently no-op
 * against PDF tabs. The agent ends up clicking around the viewer's
 * chrome indefinitely.
 *
 * What this module does instead: fetches the PDF binary from the
 * tab URL via plain `fetch()`, parses it with the bundled pdfjs-dist
 * library, and returns per-page text. Works with all model providers
 * (text-only too) — the LLM gets readable text instead of being
 * stuck in a viewer-navigation loop.
 *
 * Tier 2 ("Claude passthrough"): when the active provider is
 * Anthropic, we ALSO attach the raw PDF bytes as a `document` content
 * block on a follow-up user message. Claude's API natively
 * understands PDF documents, so the model gets the full layout +
 * embedded images, not just plain text. The text extraction still
 * happens (tool result must be a string), the document attachment is
 * additional context.
 */

import { loadPdfjs } from '../media/vendor-loader.js';

/**
 * pdfjs comes from the per-browser vendor loader: lazily imported on the
 * Firefox background page (this tree), statically imported on Chrome where
 * the MV3 service worker disallows dynamic import().
 */
async function getPdfjs() {
  return loadPdfjs();
}

/**
 * Cheap byte-array → base64 conversion that doesn't blow the call
 * stack on multi-MB PDFs. fromCharCode.apply has a per-call argument
 * limit (~64k in V8), so we chunk.
 */
const BASE64_MAX_INPUT_BYTES = 32 * 1024 * 1024; // 32 MB safety cap

function bytesToBase64(bytes) {
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
 * Throws with a helpful message on failure — file:// URLs in Firefox
 * are blocked by default for extensions; about:config
 * `extensions.webextensions.background.allowed_protocols` would have to
 * be modified, which is not user-friendly. We surface a descriptive
 * error instead of leaving the agent guessing.
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
          'Cannot fetch local PDF from a file:// URL. Firefox blocks ' +
          'extension fetches against file:// for privacy. Workaround: ' +
          'open the PDF over http(s) (e.g. drag it into a local web ' +
          'server, or upload it to a file host) and try read_pdf again.'
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

/**
 * Extract text from already-fetched PDF bytes.
 *
 * This is the core that both `read_pdf` (URL wrapper below) and the
 * ingestion-v2 attachment paths (`_applyAttachments` lane B, the
 * `read_attachment` tool) share. Returns:
 *   {
 *     success, title, totalPages, fromPage, toPage, pageCount,
 *     pages: ['page 1 text', 'page 2 text', ...],
 *     pageCharCounts: [n1, n2, ...],
 *     hasExtractableText, truncated, byteLength
 *   }
 *
 * `hasExtractableText` is a heuristic — a PDF that's pure scanned
 * images returns near-empty text from getTextContent(). The flag tells
 * the planner "you need a vision model for this PDF" without us
 * having to render every page to PNG ourselves.
 *
 * `opts.pdfjs` injects the parser for Node tests; production callers omit
 * it and get the lazily-loaded vendored bundle.
 */
export async function extractPdfTextFromBytes(bytes, opts = {}) {
  const fromPage = Math.max(1, Math.floor(opts.fromPage || 1));
  const requestedTo = opts.toPage ? Math.floor(opts.toPage) : fromPage + 49;
  const maxChars = Math.max(1000, Math.floor(opts.maxChars || 50000));
  const truncationHint = String(opts.truncationHint || 'use read_pdf with fromPage to read more');

  const pdfjs = opts.pdfjs || await getPdfjs();
  const loadingTask = pdfjs.getDocument({
    // pdfjs transfers the buffer to its worker; hand it a copy so the
    // caller's bytes stay usable (upload replay, page rendering).
    data: bytes.slice(),
    // Suppress pdfjs's noisy console.warn for "non-embedded font fallback" etc.
    // We surface real errors via the catch below.
    verbosity: 0,
  });

  try {
    const pdf = await loadingTask.promise;
    const totalPages = pdf.numPages;
    const startPage = Math.min(fromPage, totalPages);
    const endPage = Math.min(totalPages, Math.max(startPage, requestedTo));

    // Best-effort title from the document's metadata dictionary.
    let title = '';
    try {
      const meta = await pdf.getMetadata();
      title = meta?.info?.Title || '';
    } catch { /* ignore */ }

    const pages = [];
    const pageCharCounts = [];
    let charCount = 0;
    let truncated = false;
    // Last page actually read, so the truncation notice's "read more with
    // fromPage" advice resolves to a page that was really covered. Reporting
    // `endPage` after an early `break` would make a caller resume past the
    // unread pages and silently lose them.
    let lastRead = startPage - 1;

    for (let i = startPage; i <= endPage; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();

      // pdfjs returns text items as a flat array with positional info.
      // For LLM consumption we just join them with spaces — preserving
      // exact layout would be more accurate but blows the token budget.
      const pageText = content.items
        .map((item) => (item && typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (charCount + pageText.length > maxChars) {
        const remaining = Math.max(0, maxChars - charCount);
        pages.push(pageText.slice(0, remaining) + `… [page truncated, ${truncationHint}]`);
        pageCharCounts.push(pageText.length);
        lastRead = i;
        truncated = true;
        break;
      }

      pages.push(pageText);
      pageCharCounts.push(pageText.length);
      charCount += pageText.length;
      lastRead = i;

      // Free per-page resources — pdfjs caches aggressively otherwise.
      page.cleanup?.();
    }

    // Heuristic: <100 chars across the whole requested range almost certainly
    // means the pages are scanned images with no text layer. Tell the model.
    const hasExtractableText = pages.join('\n').length > 100;

    return {
      success: true,
      title,
      totalPages,
      fromPage: startPage,
      toPage: lastRead,
      pageCount: pages.length,
      pages,
      pageCharCounts,
      hasExtractableText,
      truncated,
      byteLength: bytes.length,
    };
  } finally {
    // The service worker decodes documents back to back (probe, lane B,
    // read_attachment); leaking one worker/document per call is what gets
    // the SW killed on large PDFs.
    try { await loadingTask.destroy(); } catch { /* ignore */ }
  }
}

/**
 * Extract text from a PDF at a URL — the `read_pdf` tool entry point.
 * Same result shape as extractPdfTextFromBytes, plus `_pdfBytes` for the
 * Tier 2 Claude passthrough path; the batch loop strips it before
 * stringifying so the LLM doesn't see ~1 MB of base64 nonsense in the
 * tool result text.
 */
export async function extractPdfText(url, opts = {}) {
  const bytes = await fetchPdfBytes(url);
  const result = await extractPdfTextFromBytes(bytes, opts);
  return { ...result, _pdfBytes: bytes };
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

/**
 * Cheap structural probe for a freshly attached PDF: page count plus a
 * text-layer sample over the first `sampleLimit` pages. Used by the
 * background `attachment_probe` handler to label chips ("PDF · 12 pages" /
 * "PDF scan — needs vision") without paying for a full extraction.
 */
export async function probePdfBytes(bytes, opts = {}) {
  const sampleLimit = Math.max(1, Math.floor(opts.sampleLimit || 8));
  const pdfjs = opts.pdfjs || await getPdfjs();
  const loadingTask = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const pdf = await loadingTask.promise;
    const totalPages = pdf.numPages;
    const sampledPages = Math.min(totalPages, sampleLimit);
    let sampledChars = 0;
    let lowTextSampled = 0;
    for (let i = 1; i <= sampledPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const chars = content.items.reduce(
        (sum, item) => sum + (item && typeof item.str === 'string' ? item.str.trim().length : 0),
        0,
      );
      sampledChars += chars;
      if (chars < PDF_LOW_TEXT_PAGE_CHARS) lowTextSampled++;
      page.cleanup?.();
    }
    return {
      pages: totalPages,
      hasTextLayer: sampledChars >= PDF_LOW_TEXT_PAGE_CHARS * sampledPages && lowTextSampled < sampledPages,
      coverage: sampledPages ? (sampledPages - lowTextSampled) / sampledPages : 0,
    };
  } finally {
    try { await loadingTask.destroy(); } catch { /* ignore */ }
  }
}

// Q3: scanned-PDF delivery renders at most the first 8 pages per send at
// ~144 DPI equivalent, under a shared pixel ceiling split across the pages
// still to render. Later pages go through read_attachment({mode:'render'}).
export const PDF_RENDER_MAX_PAGES_PER_SEND = 8;
export const PDF_RENDER_PIXEL_BUDGET = 4_000_000;
const PDF_RENDER_TARGET_SCALE = 2; // 144 DPI over the PDF-native 72

/**
 * Render specific PDF pages to PNG data URLs for vision delivery.
 *
 * Each page's scale starts at ~144 DPI and shrinks so the page fits inside
 * `pixelBudget / pagesRemaining` — early pages cannot starve later ones.
 * Canvas creation is injectable; the default OffscreenCanvas path works in
 * both the MV3 service worker and the Firefox background page.
 *
 * @param {Uint8Array} bytes
 * @param {{ pages: number[], pixelBudget?: number, pdfjs?: object,
 *           createCanvas?: (w: number, h: number) => OffscreenCanvas }} opts
 * @returns {Promise<{ page: number, dataUrl: string, width: number, height: number }[]>}
 */
export async function renderPdfPagesToPng(bytes, opts = {}) {
  const requested = [...new Set((opts.pages || [])
    .map((page) => Math.floor(Number(page)))
    .filter((page) => Number.isFinite(page) && page >= 1))]
    .sort((a, b) => a - b);
  if (!requested.length) return [];
  const pixelBudget = Math.max(250_000, Math.floor(opts.pixelBudget || PDF_RENDER_PIXEL_BUDGET));
  const createCanvas = opts.createCanvas || ((width, height) => new OffscreenCanvas(width, height));

  const pdfjs = opts.pdfjs || await getPdfjs();
  const loadingTask = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const pdf = await loadingTask.promise;
    const pages = requested.filter((page) => page <= pdf.numPages);
    const rendered = [];
    let budgetRemaining = pixelBudget;
    for (let index = 0; index < pages.length; index++) {
      const pageBudget = Math.max(1, Math.floor(budgetRemaining / (pages.length - index)));
      const page = await pdf.getPage(pages[index]);
      const baseViewport = page.getViewport({ scale: 1 });
      const basePixels = Math.max(1, baseViewport.width * baseViewport.height);
      const scale = Math.min(PDF_RENDER_TARGET_SCALE, Math.sqrt(pageBudget / basePixels));
      const viewport = page.getViewport({ scale: Math.max(0.1, scale) });
      const width = Math.max(1, Math.round(viewport.width));
      const height = Math.max(1, Math.round(viewport.height));
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport }).promise;
      rendered.push({
        page: pages[index],
        dataUrl: await canvasToPngDataUrl(canvas),
        width,
        height,
      });
      budgetRemaining = Math.max(0, budgetRemaining - width * height);
      page.cleanup?.();
    }
    return rendered;
  } finally {
    try { await loadingTask.destroy(); } catch { /* ignore */ }
  }
}

async function canvasToPngDataUrl(canvas) {
  if (typeof canvas.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buffer = new Uint8Array(await blob.arrayBuffer());
    return `data:image/png;base64,${bytesToBase64(buffer)}`;
  }
  // Regular <canvas> fallback (injected by tests or DOM-context callers).
  if (typeof canvas.toDataURL === 'function') return canvas.toDataURL('image/png');
  throw new Error('Canvas implementation cannot export PNG data');
}

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
