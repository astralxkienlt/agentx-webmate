#!/usr/bin/env node
/**
 * Sign (or verify) dist/release.json for the Workmate update feed.
 *
 *   node scripts/sign-release.mjs                       # sign dist/release.json in place
 *   node scripts/sign-release.mjs --in a.json --out b.json
 *   node scripts/sign-release.mjs --key-file ~/.agentx/webmate-keys/release-signing-key.pem
 *   node scripts/sign-release.mjs --verify              # check the signature only
 *
 * The private key comes from `--key-file` or, in CI, the environment variable
 * WEBMATE_RELEASE_SIGNING_KEY (the PEM text of an Ed25519 PKCS#8 key — a
 * GitHub Actions secret keeps its newlines). The key is never written anywhere
 * by this script.
 *
 * After signing, the result is verified against the committed public key
 * (scripts/release-signing-key.pub.pem, the same key compiled into Workmate).
 * A secret that does not match that key fails the release here, loudly,
 * instead of producing a feed every Workmate silently ignores.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertValidReleaseManifest,
  publicKeyPemFromPrivate,
  signReleaseManifest,
  verifyReleaseManifest,
} from './release-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
/** Repo-relative when inside the checkout, absolute otherwise (temp dirs in tests). */
const show = (file) => {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') ? rel : file;
};
export const DEFAULT_PUBLIC_KEY_FILE = path.join(root, 'scripts', 'release-signing-key.pub.pem');
export const SIGNING_KEY_ENV = 'WEBMATE_RELEASE_SIGNING_KEY';

function parseArgs(argv) {
  const options = { in: path.join(root, 'dist', 'release.json'), out: null, keyFile: null, publicKey: DEFAULT_PUBLIC_KEY_FILE, verify: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--in') options.in = path.resolve(next());
    else if (arg === '--out') options.out = path.resolve(next());
    else if (arg === '--key-file') options.keyFile = path.resolve(next());
    else if (arg === '--public-key') options.publicKey = path.resolve(next());
    else if (arg === '--verify') options.verify = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  options.out = options.out || options.in;
  return options;
}

export function loadSigningKey({ keyFile, env = process.env } = {}) {
  if (keyFile) return readFileSync(keyFile, 'utf8');
  const fromEnv = String(env[SIGNING_KEY_ENV] || '').trim();
  if (!fromEnv) {
    throw new Error(
      `No signing key: pass --key-file PATH or set ${SIGNING_KEY_ENV} to the Ed25519 private key PEM.`,
    );
  }
  // Secrets pasted without newlines still work if the header/footer are intact.
  return fromEnv.includes('\n') ? fromEnv : fromEnv.replace(/-----BEGIN PRIVATE KEY-----\s*/, '-----BEGIN PRIVATE KEY-----\n').replace(/\s*-----END PRIVATE KEY-----/, '\n-----END PRIVATE KEY-----\n');
}

export function runCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const manifest = JSON.parse(readFileSync(options.in, 'utf8'));
  const publicKeyPem = readFileSync(options.publicKey, 'utf8');

  if (options.verify) {
    assertValidReleaseManifest(manifest);
    if (!verifyReleaseManifest(manifest, publicKeyPem)) {
      throw new Error(`${show(options.in)}: signature does not verify with ${show(options.publicKey)}`);
    }
    console.log(`✓ ${show(options.in)} v${manifest.version} verifies with ${show(options.publicKey)}`);
    return manifest;
  }

  const privateKeyPem = loadSigningKey({ keyFile: options.keyFile, env });
  if (publicKeyPemFromPrivate(privateKeyPem).trim() !== publicKeyPem.trim()) {
    throw new Error(
      `The signing key does not match ${show(options.publicKey)}. ` +
        'Workmate only trusts that public key; refusing to sign with anything else.',
    );
  }
  const signed = signReleaseManifest(manifest, privateKeyPem);
  if (!verifyReleaseManifest(signed, publicKeyPem)) throw new Error('signature self-check failed');
  const tmp = `${options.out}.tmp`;
  writeFileSync(tmp, JSON.stringify(signed, null, 2) + '\n');
  renameSync(tmp, options.out);
  console.log(`✓ signed ${show(options.out)} (v${signed.version}, ${signed.chrome.sha256.slice(0, 12)}…)`);
  return signed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(`sign-release: ${error.message}`);
    process.exit(1);
  }
}
