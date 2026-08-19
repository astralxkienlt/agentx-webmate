/**
 * media-core: byte-first attachment sniffing and classification.
 *
 * The composer used to trust `file.type` (OS-registry dependent, spoofable by
 * renaming) to decide what a picked file is. Ingestion v2 decides from the
 * actual bytes instead: magic signature ▸ declared header ▸ file extension,
 * in that order, and a generic container (zip) never overrides a more
 * specific hint. A "PNG" that is really HTML is rejected outright instead of
 * being handed to a vision model as an image.
 *
 * Pure ESM with no extension-API or DOM dependencies: imported by the side
 * panel (ingest), the background (probe/materialize), and Node unit tests.
 */

// Caps mirror the historical composer limits: 16 MB for binary attachments
// (matches PDF_PASSTHROUGH_MAX_BYTES in pdf-tools.js) and 5 MB for text,
// which lands in the model context and must stay far smaller.
export const MAX_BINARY_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// How much of the head of the file the text heuristic inspects.
const TEXT_SNIFF_WINDOW_BYTES = 8 * 1024;
// Printable-character ratio a BOM-less file must reach to classify as text.
const TEXT_PRINTABLE_RATIO = 0.85;
// The PDF spec allows junk before the header; %PDF- must appear in the first
// 1024 bytes for readers to accept the file, so we scan exactly that window.
const PDF_HEADER_WINDOW_BYTES = 1024;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Estimate the decoded size of a base64 payload BEFORE decoding it, so a
 * pasted multi-megabyte data URL can be rejected without materializing the
 * bytes first (len × 3⁄4 minus padding).
 */
export function estimateBase64DecodedBytes(base64Length, padding = 0) {
  const length = Math.max(0, Math.floor(Number(base64Length) || 0));
  const pad = Math.min(2, Math.max(0, Math.floor(Number(padding) || 0)));
  return Math.max(0, Math.floor((length * 3) / 4) - pad);
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(0);
}

function startsWithBytes(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

const IMAGE_SIGNATURES = [
  { mime: 'image/png', check: (b) => startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47]) },
  { mime: 'image/jpeg', check: (b) => startsWithBytes(b, [0xff, 0xd8, 0xff]) },
  { mime: 'image/gif', check: (b) => startsWithBytes(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    mime: 'image/webp',
    check: (b) => startsWithBytes(b, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(b, [0x57, 0x45, 0x42, 0x50], 8),
  },
  { mime: 'image/bmp', check: (b) => startsWithBytes(b, [0x42, 0x4d]) },
];

function sniffImageMime(bytes) {
  for (const { mime, check } of IMAGE_SIGNATURES) {
    if (check(bytes)) return mime;
  }
  return null;
}

function hasPdfHeader(bytes) {
  const window = bytes.subarray(0, Math.min(bytes.length, PDF_HEADER_WINDOW_BYTES));
  // "%PDF-" as bytes: 25 50 44 46 2D
  for (let i = 0; i + 5 <= window.length; i++) {
    if (window[i] === 0x25 && window[i + 1] === 0x50 && window[i + 2] === 0x44
        && window[i + 3] === 0x46 && window[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

const isZip = (bytes) => startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]);
// OLE compound file (legacy .doc/.xls/.ppt).
const isOleCompound = (bytes) => startsWithBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function fileExtension(name) {
  const basename = String(name || '').split(/[\\/]/).pop() || '';
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : '';
}

/**
 * Text detection is deliberately NOT "the decode succeeded": UTF-8 decoding
 * accepts almost anything with replacement characters. A file is text when it
 * carries a UTF BOM, or when the printable ratio over the first 8 KB clears
 * 0.85 after a non-fatal decode (replacement and control characters count
 * against it).
 */
function sniffTextEncoding(bytes) {
  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) return 'utf-8';
  if (startsWithBytes(bytes, [0xff, 0xfe])) return 'utf-16le';
  if (startsWithBytes(bytes, [0xfe, 0xff])) return 'utf-16be';

  const window = bytes.subarray(0, Math.min(bytes.length, TEXT_SNIFF_WINDOW_BYTES));
  if (!window.length) return null;
  let decoded = '';
  try {
    decoded = new TextDecoder('utf-8', { fatal: false }).decode(window);
  } catch {
    return null;
  }
  if (!decoded.length) return null;
  let bad = 0;
  for (const char of decoded) {
    const code = char.codePointAt(0);
    if (code === 0xfffd) { bad++; continue; }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) { bad++; continue; }
    if (code === 0x7f) bad++;
  }
  const printableRatio = 1 - bad / [...decoded].length;
  return printableRatio > TEXT_PRINTABLE_RATIO ? 'utf-8' : null;
}

const TEXT_EXTENSION_MIMES = {
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  log: 'text/plain',
};

function textMimeFor(declaredMime, name) {
  const declared = String(declaredMime || '').toLowerCase();
  if (declared.startsWith('text/') || declared === 'application/json') return declared;
  return TEXT_EXTENSION_MIMES[fileExtension(name)] || 'text/plain';
}

/**
 * Classify a picked/pasted file from its bytes.
 *
 * @param {Uint8Array|ArrayBuffer} input file head or whole file
 * @param {{ name?: string, declaredMime?: string }} meta
 * @returns {{ ok: true, kind: 'image'|'document'|'text'|'binary',
 *             mime: string, docType: 'pdf'|'docx'|null, textEncoding?: string }
 *          | { ok: false, reason: 'mime_mismatch'|'legacy_doc'|'empty' }}
 *
 * `binary` is the lane-C classification: an unknown-but-real file that will
 * ride along as a reference the agent can read on demand — never a silent
 * rejection.
 */
export function sniffAttachment(input, { name = '', declaredMime = '' } = {}) {
  const bytes = toBytes(input);
  if (!bytes.length) return { ok: false, reason: 'empty' };
  const declared = String(declaredMime || '').toLowerCase();
  const extension = fileExtension(name);

  const imageMime = sniffImageMime(bytes);
  if (imageMime) return { ok: true, kind: 'image', mime: imageMime, docType: null };
  // The header (or a renamed extension) promises an image, but the bytes are
  // something else entirely — refuse instead of feeding a mislabeled payload
  // to a vision model.
  if (declared.startsWith('image/')) return { ok: false, reason: 'mime_mismatch' };

  if (hasPdfHeader(bytes)) return { ok: true, kind: 'document', mime: 'application/pdf', docType: 'pdf' };

  if (isOleCompound(bytes)) return { ok: false, reason: 'legacy_doc' };

  if (isZip(bytes)) {
    // Zip is a generic container: only the specific hints (extension or the
    // OOXML MIME) may promote it. Real validation of the OOXML structure
    // happens at extraction time ([Content_Types].xml); a bare zip rides
    // lane C as a reference.
    if (extension === 'docx' || declared === DOCX_MIME) {
      return { ok: true, kind: 'document', mime: DOCX_MIME, docType: 'docx' };
    }
    return { ok: true, kind: 'binary', mime: 'application/zip', docType: null };
  }

  const textEncoding = sniffTextEncoding(bytes);
  if (textEncoding) {
    return { ok: true, kind: 'text', mime: textMimeFor(declared, name), docType: null, textEncoding };
  }

  return { ok: true, kind: 'binary', mime: 'application/octet-stream', docType: null };
}

/**
 * Positive-pattern display name for attachment metadata that crosses the
 * model boundary. Anything outside the allowlist is REPLACED by a neutral
 * placeholder — no escape-then-keep, so a hostile name cannot smuggle
 * markup or fake notice markers no matter how it is later concatenated.
 */
const SAFE_ATTACHMENT_NAME_RE = /^[\p{L}\p{N} ._()-]{1,80}$/u;

export function safeAttachmentDisplayName(name, fallbackIndex = 1) {
  const basename = String(name || '').split(/[\\/]/).pop() || '';
  const trimmed = basename.trim();
  if (SAFE_ATTACHMENT_NAME_RE.test(trimmed)) return trimmed;
  const index = Math.max(1, Math.floor(Number(fallbackIndex) || 1));
  return `attachment-${index}`;
}

/**
 * MIME strings rendered anywhere near the model must be structurally valid
 * (RFC 2045 token "/" token) — anything else is dropped rather than shown.
 */
const MIME_TOKEN_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/i;

export function safeAttachmentMime(mime) {
  const value = String(mime || '').trim().toLowerCase();
  return MIME_TOKEN_RE.test(value) ? value : '';
}
