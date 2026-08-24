/**
 * DOCX helpers that need no unzip engine — the vendor-free half of
 * extract-docx.js.
 *
 * Split out so the Chrome MV3 service worker can sniff a .docx and flatten
 * mammoth HTML WITHOUT pulling the 621 KB mammoth bundle into its static
 * module graph. The one function that actually converts a document
 * (`extractDocxText`) stays in extract-docx.js, which only the decode host
 * loads. Keep this module free of mammoth, extension APIs and DOM globals.
 */


export function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(0);
}

/**
 * True OOXML validation: the required [Content_Types].xml entry must exist.
 * Plain byte search over the zip — entry names are stored verbatim next to
 * each local file header, so no inflate is needed just to validate.
 */
export function looksLikeOoxmlPackage(bytesInput) {
  const bytes = toUint8(bytesInput);
  const needle = '[Content_Types].xml';
  const pattern = new Uint8Array(needle.length);
  for (let i = 0; i < needle.length; i++) pattern[i] = needle.charCodeAt(i);
  outer:
  for (let i = 0; i + pattern.length <= bytes.length; i++) {
    if (bytes[i] !== pattern[0]) continue;
    for (let j = 1; j < pattern.length; j++) {
      if (bytes[i + j] !== pattern[j]) continue outer;
    }
    return true;
  }
  return false;
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeHtmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[entity] ?? match;
  });
}

/**
 * Flatten mammoth's constrained HTML output to plain text. This is not a
 * general HTML parser: mammoth emits well-formed p/h1..6/ol/ul/li/table/
 * tr/td/th/br plus inline formatting, and this walker handles exactly that.
 * Tables become one line per row with ` | ` between cells; ordered lists
 * keep their numbers, nested levels indent two spaces per depth.
 */
export function flattenDocxHtml(html) {
  const lines = [];
  const listStack = [];
  let cells = null;        // current table row's cells while inside <tr>
  let cellBuffer = null;   // text accumulator while inside <td>/<th>
  let lineBuffer = '';
  let linePrefix = '';     // list indent + marker, kept out of trimming
  let lineActive = false;

  const appendText = (text) => {
    if (cellBuffer != null) cellBuffer += text;
    else {
      lineBuffer += text;
      lineActive = lineActive || text.trim().length > 0;
    }
  };

  const flushLine = () => {
    const text = lineBuffer.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
    if (lineActive && (text || linePrefix)) lines.push(linePrefix + text);
    lineBuffer = '';
    linePrefix = '';
    lineActive = false;
  };

  const tokens = String(html || '').match(/<[^>]*>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token[0] !== '<') {
      appendText(decodeHtmlEntities(token));
      continue;
    }
    const tagMatch = token.match(/^<\/?\s*([a-zA-Z0-9]+)/);
    if (!tagMatch) continue;
    const tag = tagMatch[1].toLowerCase();
    const closing = token[1] === '/';

    if (tag === 'br') {
      appendText(cellBuffer != null ? ' ' : '\n');
      continue;
    }
    if (tag === 'p' || /^h[1-6]$/.test(tag) || tag === 'li') {
      // Inside a table cell, block boundaries just separate words.
      if (cellBuffer != null) {
        cellBuffer += ' ';
        continue;
      }
      flushLine();
      if (!closing) {
        lineActive = true;
        if (tag === 'li') {
          const depth = Math.max(0, listStack.length - 1);
          const level = listStack[listStack.length - 1];
          const marker = level?.type === 'ol' ? `${level.counter++}.` : '-';
          linePrefix = `${'  '.repeat(depth)}${marker} `;
        }
      }
      continue;
    }
    if (tag === 'ol' || tag === 'ul') {
      if (cellBuffer != null) continue;
      flushLine();
      if (closing) listStack.pop();
      else {
        const startMatch = token.match(/start=["']?(\d+)/i);
        listStack.push({
          type: tag,
          counter: startMatch ? Math.max(1, parseInt(startMatch[1], 10)) : 1,
        });
      }
      continue;
    }
    if (tag === 'table') {
      if (!closing) flushLine();
      continue;
    }
    if (tag === 'tr') {
      if (closing) {
        if (cells) {
          const rowText = cells.join(' | ').trim();
          if (rowText.replace(/[|\s]/g, '')) lines.push(rowText);
        }
        cells = null;
      } else {
        flushLine();
        cells = [];
      }
      continue;
    }
    if (tag === 'td' || tag === 'th') {
      if (closing) {
        if (cells && cellBuffer != null) cells.push(cellBuffer.replace(/\s+/g, ' ').trim());
        cellBuffer = null;
      } else if (cells) {
        cellBuffer = '';
      }
      continue;
    }
    if (tag === 'img') {
      // Embedded pictures cannot ride a text lane; note their presence so
      // the model knows layout content was dropped rather than absent.
      appendText('[image]');
      continue;
    }
    // Inline formatting (strong/em/u/a/span/sup/sub…) contributes only its
    // text content, which arrives via the text tokens.
  }
  flushLine();
  return lines.join('\n');
}

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
