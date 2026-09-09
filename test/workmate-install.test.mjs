// AgentX Workmate install contract — runs against brand-dist/ (built by the
// preceding test:agentx-auth step, like test/agentx-hub.test.mjs) plus the
// release-feed tooling in scripts/.
//
//   npm run brand:build && node test/workmate-install.test.mjs
import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTENSION_ID_PATTERN, extensionIdFromPublicKey } from '../scripts/extension-id.mjs';
import {
  assertValidReleaseManifest,
  buildReleaseManifest,
  canonicalJson,
  releaseAssetUrl,
  releaseNotesFromChangelog,
  sha256Hex,
  signReleaseManifest,
  verifyReleaseManifest,
} from '../scripts/release-manifest.mjs';
import { buildReleaseManifestForZip } from '../scripts/build-zip.mjs';
import { runCli as signReleaseCli } from '../scripts/sign-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const brandConfig = readJson('brand/brand.config.json');

test('brand.config.json pins the Chrome key, the ID it derives to, and Chrome 121+', () => {
  const chromeOverrides = brandConfig.manifestOverrides?.chrome || {};
  assert.ok(chromeOverrides.key, 'manifestOverrides.chrome.key is required for a stable extension ID');
  assert.equal(chromeOverrides.minimum_chrome_version, '121', 'first Chrome without the developer-mode nag bubble');
  assert.ok(!brandConfig.manifestOverrides.all?.key, 'the key must not leak into the Firefox manifest via "all"');
  assert.match(brandConfig.product.extensionId, EXTENSION_ID_PATTERN);
  assert.equal(extensionIdFromPublicKey(chromeOverrides.key), brandConfig.product.extensionId);
  assert.equal(brandConfig.product.extensionId, 'pfadeibckkgklmmjghiikadphihbpape', 'Workmate is compiled against this ID');
  assert.equal(brandConfig.workmate.installDirName, 'AgentX WebMate');
  assert.equal(brandConfig.workmate.minProtocol, 3);
  assert.match(brandConfig.workmate.minWorkmate, /^\d+\.\d+\.\d+$/);
  assert.match(brandConfig.workmate.releaseFeedUrl, /^https:\/\/raw\.githubusercontent\.com\/.+\/main\/release\.json$/);
});

test('the built Chrome manifest carries the key and floor; Firefox stays untouched', () => {
  const chrome = readJson('brand-dist/chrome/manifest.json');
  assert.equal(chrome.key, brandConfig.manifestOverrides.chrome.key);
  assert.equal(chrome.minimum_chrome_version, '121');
  assert.equal(extensionIdFromPublicKey(chrome.key), brandConfig.product.extensionId);
  const firefox = readJson('brand-dist/firefox/manifest.json');
  assert.equal(firefox.key, undefined);
  assert.equal(firefox.minimum_chrome_version, undefined);
  assert.ok(!fs.existsSync(path.join(ROOT, 'brand-dist/chrome/workmate.json')), 'a developer build ships no workmate.json — that file is Workmate\'s to write');
});

test('the built offscreen bridge announces protocol v3 and the Workmate hooks', () => {
  const source = read('brand-dist/chrome/src/offscreen/cloud-bridge.js');
  assert.match(source, /BRIDGE_PROTOCOL_VERSION = 3/);
  assert.match(source, /client: 'webbrain-extension'/, 'the wire identifier must survive the brand build');
  assert.match(source, /'workmate_prepare_update'/);
  assert.match(source, /'workmate_reload'/);
  assert.match(source, /action: 'cloud_bridge_identity'/, 'the offscreen bridge asks the background for its identity before dialling');
  assert.doesNotMatch(source, /chrome\.storage|chrome\.runtime\.getManifest|chrome\.runtime\.getURL/, 'offscreen documents have no chrome.* API beyond runtime messaging');
  const config = read('brand-dist/chrome/src/cloud-bridge-config.js');
  assert.match(config, /WORKMATE_CONFIG_PATH = 'workmate\.json'/);
  assert.match(config, /WORKMATE_SESSION_STORAGE_KEY = 'agentxAuthSessionV1'/);
  const background = read('brand-dist/chrome/src/background.js');
  assert.match(background, /case 'cloud_bridge_identity':/);
  assert.match(background, /case 'workmate_reload':/);
  assert.match(background, /chrome\.runtime\.reload\(\)/);
});

test('canonical JSON sorts keys at every level and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, u: undefined }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson('x'), '"x"');
  assert.equal(canonicalJson([undefined]), '[null]');
});

test('release notes come from the matching CHANGELOG section only', () => {
  const changelog = [
    '# Changelog', '', '## [Unreleased]', '', '- not yet', '',
    '## [1.0.4] - 2026-09-09', '', '### Added', '- Workmate install', '',
    '## [1.0.3] - 2026-09-01', '', '- older',
  ].join('\n');
  assert.equal(releaseNotesFromChangelog(changelog, '1.0.4'), '### Added\n- Workmate install');
  assert.equal(releaseNotesFromChangelog(changelog, '1.0.3'), '- older');
  assert.equal(releaseNotesFromChangelog(changelog, '9.9.9'), '');
  assert.equal(releaseNotesFromChangelog(changelog, '1.0'), '', 'a prefix must not match a longer version');
});

test('release asset URLs follow the GitHub release layout', () => {
  assert.equal(
    releaseAssetUrl('https://github.com/astralxkienlt/agentx-webmate/', '1.0.4', 'agentx-webmate-chrome-1.0.4.zip'),
    'https://github.com/astralxkienlt/agentx-webmate/releases/download/v1.0.4/agentx-webmate-chrome-1.0.4.zip',
  );
  assert.throws(() => releaseAssetUrl('https://example.com/x', '1.0.4', 'a.zip'), /GitHub repository URL/);
});

function temporaryKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

test('a manifest signed with a temporary key verifies, and any tampering breaks it', () => {
  const keys = temporaryKeyPair();
  const other = temporaryKeyPair();
  const manifest = buildReleaseManifest({
    version: '1.0.4',
    publishedAt: '2026-09-09T00:00:00.000Z',
    chrome: { fileName: 'agentx-webmate-chrome-1.0.4.zip', sha256: sha256Hex(Buffer.from('zip bytes')), bytes: 9 },
    homepage: 'https://github.com/astralxkienlt/agentx-webmate',
    minWorkmate: '0.21.0',
    minProtocol: 3,
    notes: { en: 'Workmate install', vi: 'Cài từ Workmate' },
  });
  assertValidReleaseManifest(manifest);
  assert.equal(verifyReleaseManifest(manifest, keys.publicPem), false, 'unsigned never verifies');

  const signed = signReleaseManifest(manifest, keys.privatePem);
  assert.match(signed.signature, /^ed25519:[A-Za-z0-9+/]+=*$/);
  assert.equal(verifyReleaseManifest(signed, keys.publicPem), true);
  assert.equal(verifyReleaseManifest(signed, other.publicPem), false, 'a different key must not verify');

  // Key order in the file must not matter: a re-serialised copy still verifies.
  const reordered = JSON.parse(JSON.stringify({ signature: signed.signature, notes: signed.notes, chrome: { bytes: 9, sha256: signed.chrome.sha256, url: signed.chrome.url }, schema: 1, version: '1.0.4', publishedAt: signed.publishedAt, minProtocol: 3, minWorkmate: '0.21.0' }));
  assert.equal(verifyReleaseManifest(reordered, keys.publicPem), true);

  for (const tamper of [
    (m) => { m.chrome.sha256 = sha256Hex(Buffer.from('other zip')); },
    (m) => { m.chrome.url = m.chrome.url.replace('astralxkienlt', 'attacker'); },
    (m) => { m.version = '1.0.5'; },
    (m) => { m.minWorkmate = '0.0.1'; },
    (m) => { m.signature = 'ed25519:' + Buffer.alloc(64).toString('base64'); },
    (m) => { m.signature = m.signature.replace('ed25519:', 'rsa:'); },
    (m) => { delete m.signature; },
  ]) {
    const copy = JSON.parse(JSON.stringify(signed));
    tamper(copy);
    assert.equal(verifyReleaseManifest(copy, keys.publicPem), false);
  }
  assert.throws(() => signReleaseManifest({ ...manifest, chrome: { ...manifest.chrome, url: 'http://insecure/x.zip' } }, keys.privatePem), /https/);
  assert.equal(verifyReleaseManifest({ ...signed, chrome: { ...signed.chrome, url: 'http://insecure/x.zip' } }, keys.publicPem), false);
});

test('build-zip derives the feed from the Chrome zip, brand config and changelog', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmate-release-'));
  try {
    const zipPath = path.join(dir, 'agentx-webmate-chrome-1.0.4.zip');
    fs.writeFileSync(zipPath, Buffer.from('PK fake zip payload'));
    const manifest = buildReleaseManifestForZip({
      version: '1.0.4',
      zipPath,
      brandConfig,
      changelog: '## [1.0.4] - 2026-09-09\n\n### Added\n- Cài từ Workmate\n\n## [1.0.3] - x\n- old',
      publishedAt: '2026-09-09T00:00:00.000Z',
    });
    assert.equal(manifest.chrome.url, 'https://github.com/astralxkienlt/agentx-webmate/releases/download/v1.0.4/agentx-webmate-chrome-1.0.4.zip');
    assert.equal(manifest.chrome.sha256, sha256Hex(Buffer.from('PK fake zip payload')));
    assert.equal(manifest.chrome.bytes, 'PK fake zip payload'.length);
    assert.equal(manifest.minWorkmate, brandConfig.workmate.minWorkmate);
    assert.equal(manifest.minProtocol, 3);
    assert.equal(manifest.notes.en, '### Added\n- Cài từ Workmate');
    assert.equal(manifest.notes.vi, manifest.notes.en);
    assertValidReleaseManifest(manifest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the sign-release CLI refuses a key that is not the committed public key, and round-trips with one that is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmate-sign-'));
  try {
    const keys = temporaryKeyPair();
    const stranger = temporaryKeyPair();
    const publicKeyFile = path.join(dir, 'pub.pem');
    fs.writeFileSync(publicKeyFile, keys.publicPem);
    const keyFile = path.join(dir, 'key.pem');
    fs.writeFileSync(keyFile, keys.privatePem);
    const strangerFile = path.join(dir, 'stranger.pem');
    fs.writeFileSync(strangerFile, stranger.privatePem);
    const input = path.join(dir, 'release.json');
    fs.writeFileSync(input, JSON.stringify(buildReleaseManifest({
      version: '1.0.4',
      publishedAt: '2026-09-09T00:00:00.000Z',
      chrome: { fileName: 'agentx-webmate-chrome-1.0.4.zip', sha256: sha256Hex(Buffer.from('z')), bytes: 1 },
      homepage: 'https://github.com/astralxkienlt/agentx-webmate',
      minWorkmate: '0.21.0',
      minProtocol: 3,
      notes: { en: 'x' },
    })));

    assert.throws(
      () => signReleaseCli(['--in', input, '--key-file', strangerFile, '--public-key', publicKeyFile], {}),
      /does not match/,
    );
    assert.throws(() => signReleaseCli(['--in', input, '--public-key', publicKeyFile], {}), /No signing key/);

    const out = path.join(dir, 'signed.json');
    const signed = signReleaseCli(['--in', input, '--out', out, '--key-file', keyFile, '--public-key', publicKeyFile], {});
    assert.equal(verifyReleaseManifest(JSON.parse(fs.readFileSync(out, 'utf8')), keys.publicPem), true);
    assert.equal(signed.version, '1.0.4');
    // --verify accepts the signed file and rejects a tampered one.
    signReleaseCli(['--in', out, '--public-key', publicKeyFile, '--verify'], {});
    const tampered = JSON.parse(fs.readFileSync(out, 'utf8'));
    tampered.chrome.bytes = 2;
    fs.writeFileSync(out, JSON.stringify(tampered));
    assert.throws(() => signReleaseCli(['--in', out, '--public-key', publicKeyFile, '--verify'], {}), /does not verify/);

    // The env-var path (CI) signs the same way, including a PEM pasted on one line.
    const oneLine = keys.privatePem.replace(/\n/g, '');
    const viaEnv = signReleaseCli(['--in', input, '--out', out, '--public-key', publicKeyFile], { WEBMATE_RELEASE_SIGNING_KEY: oneLine });
    assert.equal(verifyReleaseManifest(viaEnv, keys.publicPem), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed release public key is an Ed25519 SPKI PEM that Workmate can embed verbatim', () => {
  const pem = read('scripts/release-signing-key.pub.pem');
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/);
  const keys = temporaryKeyPair();
  // Anything signed with a random key must NOT verify under the committed key.
  const manifest = signReleaseManifest(buildReleaseManifest({
    version: '1.0.4',
    publishedAt: '2026-09-09T00:00:00.000Z',
    chrome: { fileName: 'a.zip', sha256: sha256Hex(Buffer.from('a')), bytes: 1 },
    homepage: 'https://github.com/astralxkienlt/agentx-webmate',
    minWorkmate: '0.21.0',
    minProtocol: 3,
    notes: { en: 'x' },
  }), keys.privatePem);
  assert.equal(verifyReleaseManifest(manifest, pem), false);
});

let passed = 0;
let failed = 0;
console.log('\nworkmate install contract');
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${t.name}`);
    console.log(`      ${error.message}`);
    failed += 1;
  }
}
console.log(`\n  ${passed} passed, ${failed} failed (${tests.length} total)`);
if (failed > 0) process.exit(1);
