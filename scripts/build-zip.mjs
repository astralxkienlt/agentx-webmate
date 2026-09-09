#!/usr/bin/env node
/**
 * Build branded extension submission zips.
 *
 *   node scripts/build-zip.mjs
 *
 * Or via npm:  npm run build:zip
 *
 * Runs the AgentX WebMate brand build, then uses `git archive --format=zip`
 * with a temporary index so the output is POSIX-style with
 * forward-slash paths, which AMO's automated validator requires (it
 * silently rejects zips made by PowerShell's Compress-Archive because
 * those carry Windows backslash separators inside the central directory).
 *
 * Source-of-truth is the generated brand-dist tree. The package version must
 * still match HEAD, so an uncommitted version bump cannot produce a
 * new-looking filename around old release metadata.
 *
 * Output:
 *   dist/agentx-webmate-chrome-<version>.zip
 *   dist/agentx-webmate-edge-<version>.zip
 *   dist/agentx-webmate-firefox-<version>.zip
 *   dist/release.json   (unsigned update feed for AgentX Workmate — sha256 and
 *                        size of the Chrome zip, compatibility floor from
 *                        brand.config.json "workmate", notes from CHANGELOG.md;
 *                        scripts/sign-release.mjs adds the signature)
 *
 * <version> is read from package.json at HEAD, and every archived manifest
 * must match it. An uncommitted version bump is rejected instead of creating
 * a new-looking filename around an old manifest.
 */

import { readFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildReleaseManifest, releaseNotesFromChangelog, sha256File } from './release-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const targets = [
  { packageName: 'chrome', sourceDir: 'chrome' },
  // Microsoft Edge uses the same Chromium-compatible MV3 source tree.
  { packageName: 'edge', sourceDir: 'chrome' },
  { packageName: 'firefox', sourceDir: 'firefox' },
];

export function assertMatchingArchiveVersion(expected, actual, label) {
  if (actual !== expected) {
    throw new Error(`${label} is ${actual}, but the release package version is ${expected}.`);
  }
}

const FLAG_LICENSE_PATH = 'icons/flags/LICENSE.flag-icons.txt';
const REJECTED_FLAG_LICENSE_PATH = 'icons/flags/LICENSE.flag-icons';

export function listZipEntryNames(filePath) {
  const archive = readFileSync(filePath);
  const eocdSignature = 0x06054b50;
  const centralHeaderSignature = 0x02014b50;
  const earliestEocd = Math.max(0, archive.length - 0xffff - 22);
  let eocdOffset = -1;
  for (let offset = archive.length - 22; offset >= earliestEocd; offset -= 1) {
    if (
      archive.readUInt32LE(offset) === eocdSignature
      && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error(`${filePath} has no ZIP end-of-central-directory record.`);

  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  let offset = archive.readUInt32LE(eocdOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== centralHeaderSignature) {
      throw new Error(`${filePath} has an invalid ZIP central-directory entry at index ${index}.`);
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > archive.length) {
      throw new Error(`${filePath} has a truncated ZIP filename at index ${index}.`);
    }
    entries.push(archive.toString('utf8', nameStart, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

export function assertStoreSafeFlagLicenseEntries(entries, label) {
  if (!entries.includes(FLAG_LICENSE_PATH)) {
    throw new Error(`${label} is missing ${FLAG_LICENSE_PATH}.`);
  }
  if (entries.includes(REJECTED_FLAG_LICENSE_PATH)) {
    throw new Error(`${label} still contains Opera-rejected ${REJECTED_FLAG_LICENSE_PATH}.`);
  }
}

const STORE_REVIEWED_JAVASCRIPT_PATHS = [
  'vendor/pdfjs/pdf.mjs',
  'vendor/pdfjs/pdf.worker.mjs',
  'src/providers/manager.js',
];

const STORE_REJECTION_PATTERNS = [
  {
    pattern: /\bLT\s*\+\s*SCRIPT\s*\+\s*GT\s*\+\s*content\s*\+\s*LT\s*\+\s*['"]\/['"]\s*\+\s*SCRIPT\s*\+\s*GT\b/,
    reason: 'split PDF.js <script> construction',
  },
  {
    pattern: /['"]java['"]\s*\+\s*SCRIPT\s*\+\s*['"]:['"]/,
    reason: 'split javascript: scheme',
  },
  {
    pattern: /data:(?:image|audio)\/[a-z0-9.+-]+;base64,[a-z0-9+/=]{128,}/i,
    reason: 'long inline base64 media payload',
  },
];

export function assertStoreReviewableJavaScript(source, label) {
  for (const { pattern, reason } of STORE_REJECTION_PATTERNS) {
    if (pattern.test(source)) {
      throw new Error(`${label} contains ${reason}; use transparent source or a packaged asset.`);
    }
  }
}

/**
 * The unsigned update feed for this build. Pure apart from reading the zip:
 * the workflow signs it right after (scripts/sign-release.mjs) and commits it
 * both under dist/ and at the repository root.
 */
export function buildReleaseManifestForZip({ version, zipPath, brandConfig, changelog, publishedAt }) {
  const fileName = path.basename(zipPath);
  const workmate = brandConfig.workmate || {};
  const notes = releaseNotesFromChangelog(changelog, version);
  return buildReleaseManifest({
    version,
    publishedAt,
    chrome: { fileName, sha256: sha256File(zipPath), bytes: statSync(zipPath).size },
    homepage: brandConfig.product?.homepage,
    minWorkmate: workmate.minWorkmate,
    minProtocol: workmate.minProtocol,
    notes: { en: notes, vi: notes },
  });
}

function readJsonAtHead(relativePath) {
  const source = execFileSync('git', ['show', `HEAD:${relativePath}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(source);
}

function archiveGeneratedTree(sourceDir, out) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'agentx-webmate-archive-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    execFileSync('git', ['read-tree', '--empty'], { cwd: root, env, stdio: 'ignore' });
    execFileSync('git', ['add', '-f', '--', sourceDir], { cwd: root, env, stdio: 'ignore' });
    const tree = execFileSync('git', ['write-tree'], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    execFileSync(
      'git',
      ['archive', '--format=zip', '-o', out, `${tree}:${sourceDir}`],
      { stdio: 'inherit', cwd: root }
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runCli() {
  const workingPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const headPackage = readJsonAtHead('package.json');
  assertMatchingArchiveVersion(
    headPackage.version,
    workingPackage.version,
    'Working-tree package.json version'
  );

  const version = headPackage.version;
  execFileSync(process.execPath, [path.join(root, 'scripts', 'brand-build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });

  for (const { sourceDir } of targets) {
    const brandedDir = path.join(root, 'brand-dist', sourceDir);
    const manifest = JSON.parse(readFileSync(path.join(brandedDir, 'manifest.json'), 'utf8'));
    assertMatchingArchiveVersion(version, manifest.version, `brand-dist/${sourceDir}/manifest.json version`);
    for (const relativePath of STORE_REVIEWED_JAVASCRIPT_PATHS) {
      const archivePath = path.join(brandedDir, relativePath);
      assertStoreReviewableJavaScript(readFileSync(archivePath, 'utf8'), archivePath);
    }
  }

  const distDir = path.join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  console.log(`Building AgentX WebMate extension zips for v${version} from branded output …`);

  for (const { packageName, sourceDir } of targets) {
    const out = path.join(distDir, `agentx-webmate-${packageName}-${version}.zip`);
    archiveGeneratedTree(`brand-dist/${sourceDir}`, out);
    assertStoreSafeFlagLicenseEntries(
      listZipEntryNames(out),
      `dist/agentx-webmate-${packageName}-${version}.zip`
    );
    console.log(`  ✓ dist/agentx-webmate-${packageName}-${version}.zip`);
  }

  const manifest = buildReleaseManifestForZip({
    version,
    zipPath: path.join(distDir, `agentx-webmate-chrome-${version}.zip`),
    brandConfig: JSON.parse(readFileSync(path.join(root, 'brand', 'brand.config.json'), 'utf8')),
    changelog: readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
  });
  writeFileSync(path.join(distDir, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`  ✓ dist/release.json (unsigned — run scripts/sign-release.mjs; sha256 ${manifest.chrome.sha256.slice(0, 12)}…)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(`build-zip: ${error.message}`);
    process.exit(1);
  }
}
