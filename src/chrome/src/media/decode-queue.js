/**
 * Serialize heavy document decodes (pdfjs parse/render, mammoth unzip) so the
 * background context holds AT MOST ONE decoded document in memory at a time.
 * Parallel multi-megabyte decodes are what get the MV3 service worker killed;
 * a module-level chain per JS context is the whole scheduling policy.
 */
let chain = Promise.resolve();

export function enqueueDocumentDecode(task) {
  const run = chain.then(() => task());
  // Keep the chain alive after failures; the caller still sees the rejection.
  chain = run.then(() => undefined, () => undefined);
  return run;
}
