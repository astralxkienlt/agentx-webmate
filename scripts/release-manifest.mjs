/**
 * release.json — the update feed AgentX Workmate polls.
 *
 * One small signed document per release, committed at the repository root
 * (raw.githubusercontent.com/…/main/release.json) and attached to the GitHub
 * Release. Workmate downloads the Chrome zip it names, checks the sha256, and
 * swaps the unpacked extension folder; the Ed25519 signature is what stops a
 * tampered feed or zip from ever being installed. There is no "install anyway"
 * path on the Workmate side, so a broken signature means "no update".
 *
 *   {
 *     "schema": 1, "version": "1.0.4", "publishedAt": "<ISO>",
 *     "chrome": { "url": "…/agentx-webmate-chrome-1.0.4.zip", "sha256": "<hex>", "bytes": 5230000 },
 *     "minWorkmate": "0.21.0", "minProtocol": 3,
 *     "notes": { "vi": "…", "en": "…" },
 *     "signature": "ed25519:<base64>"
 *   }
 *
 * The signature covers the canonical JSON (keys sorted at every level, no
 * whitespace) of every field except `signature`. Pure helpers only; the CLI
 * lives in scripts/sign-release.mjs and the producer in scripts/build-zip.mjs.
 * Workmate carries a mirror of `canonicalJson` and `verifyReleaseManifest` —
 * keep the two byte-for-byte compatible.
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const RELEASE_MANIFEST_SCHEMA = 1;
export const SIGNATURE_PREFIX = 'ed25519:';
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Deterministic JSON: sorted object keys at every level, no whitespace, undefined dropped. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** The bytes a signature is computed over: everything but `signature`. */
export function signingPayload(manifest) {
  const { signature: _signature, ...rest } = manifest;
  return Buffer.from(canonicalJson(rest), 'utf8');
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(filePath) {
  return sha256Hex(readFileSync(filePath));
}

export function releaseAssetUrl(homepage, version, fileName) {
  const base = String(homepage || '').replace(/\/+$/, '');
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(base)) {
    throw new Error(`product.homepage must be a GitHub repository URL to derive release asset URLs, got: ${homepage}`);
  }
  return `${base}/releases/download/v${version}/${fileName}`;
}

/**
 * The CHANGELOG.md section for `version`: from its `## ` heading up to the
 * next one, heading line excluded. Empty string when the version has no
 * section yet (the manifest then carries an empty note, never a wrong one).
 */
export function releaseNotesFromChangelog(changelog, version) {
  const lines = String(changelog || '').split(/\r?\n/);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return '';
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

export function buildReleaseManifest({
  version,
  publishedAt,
  chrome,
  homepage,
  minWorkmate,
  minProtocol,
  notes,
}) {
  if (!SEMVER.test(String(version))) throw new Error(`release manifest version must be MAJOR.MINOR.PATCH, got: ${version}`);
  if (!chrome || !SHA256_HEX.test(String(chrome.sha256))) throw new Error('release manifest needs the Chrome zip sha256 (hex)');
  if (!Number.isInteger(chrome.bytes) || chrome.bytes <= 0) throw new Error('release manifest needs the Chrome zip size in bytes');
  const en = String(notes?.en ?? '').trim();
  const vi = String(notes?.vi ?? en).trim();
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    version: String(version),
    publishedAt: publishedAt || new Date().toISOString(),
    chrome: {
      url: chrome.url || releaseAssetUrl(homepage, version, chrome.fileName),
      sha256: String(chrome.sha256).toLowerCase(),
      bytes: chrome.bytes,
    },
    minWorkmate: String(minWorkmate || '0.0.0'),
    minProtocol: Number.isInteger(minProtocol) ? minProtocol : 3,
    notes: { vi, en },
  };
}

/** Structural check, independent of the signature. Throws on the first problem. */
export function assertValidReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('release manifest must be an object');
  if (manifest.schema !== RELEASE_MANIFEST_SCHEMA) throw new Error(`release manifest schema ${manifest.schema} is not supported`);
  if (!SEMVER.test(String(manifest.version))) throw new Error(`release manifest version is not MAJOR.MINOR.PATCH: ${manifest.version}`);
  if (Number.isNaN(Date.parse(manifest.publishedAt))) throw new Error('release manifest publishedAt is not a date');
  const chrome = manifest.chrome;
  if (!chrome || typeof chrome !== 'object') throw new Error('release manifest has no chrome package');
  let url;
  try {
    url = new URL(chrome.url);
  } catch {
    throw new Error('release manifest chrome.url is not a URL');
  }
  if (url.protocol !== 'https:') throw new Error('release manifest chrome.url must be https');
  if (!SHA256_HEX.test(String(chrome.sha256))) throw new Error('release manifest chrome.sha256 is not a hex sha256');
  if (!Number.isInteger(chrome.bytes) || chrome.bytes <= 0) throw new Error('release manifest chrome.bytes is not a positive integer');
  if (!SEMVER.test(String(manifest.minWorkmate))) throw new Error('release manifest minWorkmate is not MAJOR.MINOR.PATCH');
  if (!Number.isInteger(manifest.minProtocol) || manifest.minProtocol < 1) throw new Error('release manifest minProtocol is not a positive integer');
  if (!manifest.notes || typeof manifest.notes !== 'object') throw new Error('release manifest has no notes');
  return manifest;
}

export function signReleaseManifest(manifest, privateKeyPem) {
  assertValidReleaseManifest(manifest);
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`release signing key must be Ed25519, got ${key.asymmetricKeyType}`);
  const signature = cryptoSign(null, signingPayload(manifest), key).toString('base64');
  const { signature: _old, ...rest } = manifest;
  return { ...rest, signature: `${SIGNATURE_PREFIX}${signature}` };
}

/** true only for a well-formed manifest whose signature verifies under `publicKeyPem`. */
export function verifyReleaseManifest(manifest, publicKeyPem) {
  try {
    assertValidReleaseManifest(manifest);
    const signature = String(manifest.signature || '');
    if (!signature.startsWith(SIGNATURE_PREFIX)) return false;
    const bytes = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'base64');
    if (bytes.length !== 64) return false;
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return cryptoVerify(null, signingPayload(manifest), key, bytes);
  } catch {
    return false;
  }
}

/** The public half of a private PEM, as SPKI PEM — for checking a secret matches the committed key. */
export function publicKeyPemFromPrivate(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' });
}
