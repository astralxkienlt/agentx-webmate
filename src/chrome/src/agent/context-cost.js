/**
 * Script-aware prompt-size estimation.
 *
 * KEEP THIS FILE PURE JS — no chrome/browser/DOM imports — so test/run.js can
 * load it under Node (same convention as permission-gate.js and loop-bucket.js).
 *
 * The problem: context management used a flat `chars / 4` token proxy. That
 * ratio is an English figure. BPE vocabularies are trained mostly on English,
 * so text in other scripts spends far more tokens per character:
 *
 *   - CJK / Thai: a character is typically its own token (~1 char/token)
 *   - Vietnamese, Arabic, Hebrew, Hindi: diacritics and non-Latin letters
 *     split words into several tokens (~2-2.5 chars/token measured by byte
 *     inflation; a Vietnamese sample in this repo runs 1.30 UTF-8 bytes per
 *     character against English's 1.01)
 *
 * Under-estimating is the harmful direction. The estimate feeds the trigger
 * that compacts BEFORE the provider hard-errors on overflow, and on the FIRST
 * turn there is no provider-reported `prompt_tokens` yet to correct it — so a
 * long Vietnamese page read would sail past the real window and land in
 * _emergencyTrim instead of a clean "context automatically compacted" notice.
 *
 * The model here: every ASCII character costs 1 unit, every non-ASCII
 * character costs NON_ASCII_CHAR_WEIGHT units, and CHARS_PER_TOKEN units make
 * a token. With the weight equal to CHARS_PER_TOKEN that reads simply as "a
 * non-ASCII character costs about one token" — right for CJK, and a
 * deliberately conservative ceiling for Vietnamese diacritics.
 *
 * Pure-ASCII text is unaffected: it scores exactly its character count, so the
 * English-language behaviour these thresholds were tuned against is unchanged.
 *
 * CALIBRATION NOTE: NON_ASCII_CHAR_WEIGHT is derived from UTF-8 byte inflation
 * and the CJK one-char-one-token rule of thumb, not from running a real
 * tokenizer — the extension ships no tokenizer and adding one is a dependency
 * decision. Confirm the weight against tiktoken/o200k on real Vietnamese and
 * CJK page reads before tightening it; err high rather than low.
 */

/** Units per token. Historic English-text ratio, kept so `cost / 4` still reads as tokens. */
export const CHARS_PER_TOKEN = 4;

/** Units charged per non-ASCII character — one token's worth. */
export const NON_ASCII_CHAR_WEIGHT = 4;

/**
 * Weighted size of one string, in the same unit as `String.length` for ASCII.
 *
 * Single pass, no allocation and no regex: this runs over the whole
 * conversation on every agent step, and again per iteration while compaction
 * trims the recent slice.
 */
export function textCost(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) nonAscii++;
  }
  // Surrogate pairs count as two units of a 4-unit charge, which is the right
  // order of magnitude for emoji and astral-plane characters anyway.
  return text.length + (nonAscii * (NON_ASCII_CHAR_WEIGHT - 1));
}

/** Weighted cost of a value's JSON form — for tool calls and structured blocks. */
export function jsonCost(value) {
  try {
    return textCost(JSON.stringify(value ?? ''));
  } catch {
    return 0;
  }
}

/** Weighted units -> approximate tokens. */
export function costToTokens(cost) {
  return Math.ceil(Math.max(0, cost) / CHARS_PER_TOKEN);
}
