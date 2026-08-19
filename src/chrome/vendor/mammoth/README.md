# mammoth (vendored)

- Package: `mammoth@1.11.0` — https://www.npmjs.com/package/mammoth
- File: `mammoth.browser.min.js` (the published browser UMD bundle, unmodified)
- SHA-256: `62773d3b21c7130342148e78abf7b97dbd3103463d3ffc5a68601a2a007e1cf1`
- License: BSD-2-Clause (see LICENSE)

Used by `src/media/extract-docx.js` to convert .docx attachments to text
locally (no build step, no remote scripts — same vendoring policy as
`vendor/pdfjs` and `vendor/katex`). The UMD wrapper attaches the API to
`self.mammoth` when loaded in the extension's background context.
