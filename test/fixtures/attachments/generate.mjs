#!/usr/bin/env node
/**
 * Deterministic generator for the ingestion-v2 attachment fixtures.
 *
 * Run `node test/fixtures/attachments/generate.mjs` to (re)create every
 * binary fixture in this directory. Fixtures are committed so the unit
 * suite stays hermetic; this script is the provenance record — no fixture
 * is a hand-crafted blob.
 *
 * Layout notes:
 *   - PDFs are built with correct xref tables so any conformant parser
 *     (not just pdfjs's error recovery) accepts them.
 *   - "Scan" pages carry a filled rectangle and no BT/ET text operators,
 *     which is exactly what a text-layer probe sees in a scanned document.
 *   - The DOCX is a stored (uncompressed) OOXML package with a numbered
 *     list (numbering.xml wired) and a 3×3 table for the flattener tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── PDF ────────────────────────────────────────────────────────────────────

function pdfEscape(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Build a PDF where each page is either { text: '...' } or { scan: true }.
 */
function buildPdf(pages, { title = '' } = {}) {
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };

  const pageObjectNumbers = [];
  const contentObjectNumbers = [];
  // Reserve numbers: 1 catalog, 2 pages tree, 3 font, then per page 2 objects.
  addObject(null); // 1: catalog — filled later
  addObject(null); // 2: pages tree — filled later
  const fontNumber = addObject('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');

  for (const page of pages) {
    let stream;
    if (page.scan) {
      // No text operators at all: a light gray block standing in for pixels.
      stream = '0.82 0.82 0.82 rg 36 36 540 720 re f';
    } else {
      const lines = String(page.text || '').split('\n');
      const parts = ['BT /F1 12 Tf 72 720 Td 16 TL'];
      lines.forEach((line, index) => {
        if (index > 0) parts.push('T*');
        parts.push(`(${pdfEscape(line)}) Tj`);
      });
      parts.push('ET');
      stream = parts.join('\n');
    }
    const contentNumber = addObject(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
    const pageNumber = addObject(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentNumber} 0 R`
      + `/Resources<</Font<</F1 ${fontNumber} 0 R>>>>>>`,
    );
    contentObjectNumbers.push(contentNumber);
    pageObjectNumbers.push(pageNumber);
  }

  let infoNumber = 0;
  if (title) infoNumber = addObject(`<</Title (${pdfEscape(title)})>>`);

  objects[0] = '<</Type/Catalog/Pages 2 0 R>>';
  objects[1] = `<</Type/Pages/Kids[${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}]`
    + `/Count ${pageObjectNumbers.length}>>`;

  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R${infoNumber ? `/Info ${infoNumber} 0 R` : ''}>>\n`;
  out += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ── ZIP (store method) ─────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method: store
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0x21, 12);        // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(0, 10);
    centralEntry.writeUInt16LE(0, 12);
    centralEntry.writeUInt16LE(0x21, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(data.length, 20);
    centralEntry.writeUInt32LE(data.length, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([centralEntry, nameBytes]));
    offset += local.length + nameBytes.length + data.length;
  }
  const centralStart = offset;
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

// ── DOCX ───────────────────────────────────────────────────────────────────

function buildDocx() {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
  const paragraph = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const numbered = (text, level = 0) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr>`
    + `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (text) => `<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
  const row = (cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraph('Quarterly logistics report')}
    ${numbered('Collect warehouse counts')}
    ${numbered('Verify carrier invoices')}
    ${numbered('Cross-check totals', 1)}
    ${numbered('Publish the summary')}
    <w:tbl>
      <w:tblPr/>
      ${row(['Region', 'Units', 'Revenue'])}
      ${row(['North', '1200', '$18,400'])}
      ${row(['South', '860', '$12,750'])}
    </w:tbl>
    ${paragraph('End of report.')}
  </w:body>
</w:document>`;
  return buildZip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['word/_rels/document.xml.rels', documentRels],
    ['word/numbering.xml', numbering],
    ['word/document.xml', document],
  ]);
}

// ── Fixture manifest ───────────────────────────────────────────────────────

const textPage = (n, extra = '') => `Fixture page ${n}.\n${extra}This synthetic paragraph exists so the text layer of page ${n} comfortably clears the twenty-character coverage threshold used by the extractor.`;

const fixtures = {
  'pdf-text-3p.pdf': () => buildPdf(
    [1, 2, 3].map((n) => ({ text: textPage(n) })),
    { title: 'Three text pages' },
  ),
  'pdf-text-10p.pdf': () => buildPdf(
    Array.from({ length: 10 }, (_, i) => ({
      text: textPage(i + 1, i + 1 === 9 ? 'The vault access code is 7429. ' : ''),
    })),
    { title: 'Ten text pages' },
  ),
  'pdf-scan-2p.pdf': () => buildPdf([{ scan: true }, { scan: true }], { title: 'Two scanned pages' }),
  'pdf-hybrid-10p.pdf': () => buildPdf(
    Array.from({ length: 10 }, (_, i) => (i < 7 ? { text: textPage(i + 1) } : { scan: true })),
    { title: 'Hybrid seven text three scan' },
  ),
  'pdf-text-100p.pdf': () => buildPdf(
    Array.from({ length: 100 }, (_, i) => ({ text: textPage(i + 1) })),
    { title: 'Hundred text pages' },
  ),
  'report.docx': buildDocx,
  // Smallest valid PNG: 1×1 transparent pixel.
  'valid.png': () => Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
  // An HTML document wearing a .png name — the mime_mismatch case.
  'fake-png.png': () => Buffer.from('<!doctype html><html><body>not pixels</body></html>', 'utf8'),
  'bare.zip': () => buildZip([['notes/readme.txt', 'just a plain zip, no OOXML inside']]),
  'utf16-bom.txt': () => {
    const text = 'Xin chào thế giới\nDòng thứ hai có dấu tiếng Việt\n';
    const buffer = Buffer.alloc(2 + text.length * 2);
    buffer.writeUInt16LE(0xfeff, 0);
    for (let i = 0; i < text.length; i++) buffer.writeUInt16LE(text.charCodeAt(i), 2 + i * 2);
    return buffer;
  },
};

for (const [name, build] of Object.entries(fixtures)) {
  const filePath = path.join(HERE, name);
  fs.writeFileSync(filePath, build());
  console.log(`  wrote ${name} (${fs.statSync(filePath).size} bytes)`);
}
