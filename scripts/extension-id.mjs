/**
 * Chrome extension IDs from manifest keys.
 *
 * Chrome derives an unpacked or packed extension's ID from the `key` field
 * when one is present: SHA-256 over the DER-encoded SPKI public key, first 16
 * bytes, each nibble mapped to a–p ("mpdecimal"). Pinning the key is what
 * gives AgentX Workmate a stable ID to look for in a browser profile no
 * matter which folder the extension was loaded from.
 *
 * Pure helpers, no I/O: used by scripts/brand-build.mjs (build-time guard)
 * and the tests.
 */

import { createHash } from 'node:crypto';

export function extensionIdFromPublicKey(keyBase64) {
  const der = Buffer.from(String(keyBase64 || ''), 'base64');
  if (!der.length) throw new Error('manifest key is empty');
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
