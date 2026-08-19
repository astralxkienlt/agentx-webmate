#!/usr/bin/env node
// Builds the branded extension from the pristine upstream sources.
//
// Nothing under src/ is ever modified in place. Every brand change lives under
// brand/ and is applied here, which is what keeps `git merge upstream/main`
// conflict-free across the ~750 upstream files we do not own.
//
// Layering order (later wins):
//   1. copy src/<target>/           pristine upstream
//   2. brand/overrides/<target>/    whole-file replacements
//   3. brand/additions/<target>/    brand-new files
//   4. brand/patches/<target>/      surgical diffs (fail loudly on drift)
//   5. config.replacements          string/regex swaps
//   6. manifest + icons + theme
//   7. verify: preserve guard, `node --check`, leftover audit
//
// Usage: node scripts/brand-build.mjs [--target chrome|firefox|all] [--watch] [--clean]

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = path.join(ROOT, 'brand');
const OUT = path.join(ROOT, 'brand-dist');

const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.svg', '.xml']);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const log = (...m) => console.log('[brand]', ...m);
const warn = (...m) => console.warn('[brand] WARN', ...m);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Minimal glob support: ** crosses path separators, * does not.
const globToRe = (g) => {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if ('.+^${}()|[]\\?'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
};

async function walk(dir, base = dir, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, acc);
    else acc.push(path.relative(base, full));
  }
  return acc;
}

// `written` collects every path this build produced, so prune() can delete
// whatever is left over from a previous build. Chrome holds an unpacked
// extension by directory path and re-reads it on reload, so the directory has
// to exist continuously — wiping and recreating it makes `brand:watch` race
// against Chrome and surface a spurious "manifest file is missing" error.
async function copyTree(from, to, { skip = () => false, written = null } = {}) {
  let n = 0;
  for (const rel of await walk(from)) {
    if (skip(rel)) continue;
    const dest = path.join(to, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(from, rel), dest);
    written?.add(rel.split(path.sep).join('/'));
    n++;
  }
  return n;
}

// Remove files a previous build left behind (upstream deleted them, or they
// dropped out of features.exclude), then drop the directories that emptied out.
async function prune(outDir, written) {
  let removed = 0;
  for (const rel of await walk(outDir)) {
    if (written.has(rel.split(path.sep).join('/'))) continue;
    await fs.rm(path.join(outDir, rel), { force: true });
    removed++;
  }
  const dirs = [];
  const collect = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      await collect(full);
      dirs.push(full);
    }
  };
  await collect(outDir);
  for (const dir of dirs.reverse()) {
    if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
  }
  return removed;
}

// --- 4. patches ------------------------------------------------------------
// A patch that stops applying means upstream rewrote the code it hooks into.
// Failing the build is the point: it surfaces the drift the day it lands
// rather than silently shipping a half-branded or broken extension.
async function applyPatches(outDir, target) {
  const dir = path.join(BRAND, 'patches', target);
  if (!existsSync(dir)) return 0;
  const patches = (await fs.readdir(dir)).filter((f) => f.endsWith('.patch')).sort();
  for (const p of patches) {
    try {
      await execFileAsync('git', ['apply', '--unsafe-paths', `--directory=${path.relative(ROOT, outDir)}`, path.join(dir, p)], {
        cwd: ROOT,
      });
      log(`  patch ok: ${target}/${p}`);
    } catch (err) {
      throw new Error(
        `Patch failed: brand/patches/${target}/${p}\n` +
          `Upstream changed the code this patch targets.\n` +
          `Fix: rebuild the patch against the current src/${target}/ tree.\n\n` +
          (err.stderr || err.message)
      );
    }
  }
  return patches.length;
}

// --- 5. replacements -------------------------------------------------------
function compileReplacements(config) {
  return (config.replacements || []).map((r) => ({
    label: r.from || r.regex,
    re: r.regex ? new RegExp(r.regex, r.flags || 'g') : new RegExp(escapeRe(r.from), 'g'),
    to: r.to,
    only: r.only?.map(globToRe) || null,
    except: r.except?.map(globToRe) || null,
  }));
}

async function applyReplacements(outDir, rules) {
  if (!rules.length) return { files: 0, hits: 0 };
  let files = 0;
  let hits = 0;
  for (const rel of await walk(outDir)) {
    if (!TEXT_EXT.has(path.extname(rel))) continue;
    const posix = rel.split(path.sep).join('/');
    const applicable = rules.filter(
      (r) => (!r.only || r.only.some((re) => re.test(posix))) && !(r.except && r.except.some((re) => re.test(posix)))
    );
    if (!applicable.length) continue;
    const full = path.join(outDir, rel);
    const before = await fs.readFile(full, 'utf8');
    let after = before;
    for (const r of applicable) {
      let ruleHits = 0;
      after.replace(r.re, () => {
        ruleHits++;
        return '';
      });
      if (!ruleHits) continue;
      hits += ruleHits;
      // Use the native replacement string so config rules can safely use
      // capture references such as $1 without receiving a literal "$1".
      after = after.replace(r.re, r.to);
    }
    if (after !== before) {
      await fs.writeFile(full, after);
      files++;
    }
  }
  return { files, hits };
}

// --- 6. manifest, icons, theme --------------------------------------------
async function rewriteManifest(outDir, config, target) {
  const file = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  const p = config.product;

  manifest.name = p.name;
  if (p.description) manifest.description = p.description;
  if (p.shortName) manifest.short_name = p.shortName;
  if (p.homepage) manifest.homepage_url = p.homepage;
  if (manifest.action?.default_title) manifest.action.default_title = p.name;

  if (target === 'firefox' && p.firefoxId) {
    manifest.browser_specific_settings = {
      ...manifest.browser_specific_settings,
      gecko: { ...manifest.browser_specific_settings?.gecko, id: p.firefoxId },
    };
  }

  const overrides = { ...config.manifestOverrides?.all, ...config.manifestOverrides?.[target] };
  Object.assign(manifest, overrides);

  await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

const applyIcons = (outDir, written) =>
  existsSync(path.join(BRAND, 'icons'))
    ? copyTree(path.join(BRAND, 'icons'), path.join(outDir, 'icons'), {
        written: { add: (rel) => written.add(`icons/${rel}`) },
      })
    : 0;

// Appended rather than edited in: the last declaration wins in CSS, so a
// variable override at the end of the file beats the upstream default without
// touching the 85KB upstream stylesheet.
const THEME_HTML = new Set([
  'settings.html',
  'history.html',
  'traces.html',
  'install.html',
  'mic-permission.html',
  'emergency-box.html',
  'emergency-pdf.html',
  'emergency-communication.html',
]);

const FONT_HTML_SKIP = new Set(['sidepanel.html']);

// JOSE signature algorithms services.oidcIdTokenAlg may pin an ID token to.
// `none` is absent on purpose: it is refused outright, never configured.
const ID_TOKEN_ALGS = [
  'HS256', 'HS384', 'HS512',
  'RS256', 'RS384', 'RS512',
  'ES256', 'ES384', 'ES512',
  'PS256', 'PS384', 'PS512',
];

async function applyTheme(outDir, config, written) {
  const fontsFile = path.join(BRAND, 'fonts.css');
  const themeFile = path.join(BRAND, 'theme.css');
  if (!existsSync(themeFile)) return false;

  const fonts = existsSync(fontsFile) ? `${await fs.readFile(fontsFile, 'utf8')}\n` : '';
  const theme = await fs.readFile(themeFile, 'utf8');
  const combined = `${fonts}${theme}`;

  const stylesDir = path.join(outDir, 'styles');
  await fs.mkdir(stylesDir, { recursive: true });
  await fs.writeFile(path.join(stylesDir, 'brand-fonts.css'), fonts || combined);
  await fs.writeFile(path.join(stylesDir, 'brand-theme.css'), combined);
  written?.add('styles/brand-fonts.css');
  written?.add('styles/brand-theme.css');

  const sidepanel = path.join(outDir, 'styles', 'sidepanel.css');
  if (!existsSync(sidepanel)) {
    warn('styles/sidepanel.css not found — upstream moved it; theme NOT appended');
  } else {
    await fs.appendFile(
      sidepanel,
      `\n\n/* ===== ${config.product.name} theme (brand/fonts.css + brand/theme.css) ===== */\n${combined}`
    );
  }

  await injectBrandStylesheets(outDir);
  return true;
}

async function injectBrandStylesheets(outDir) {
  for (const rel of await walk(outDir)) {
    if (!rel.endsWith('.html')) continue;
    const posix = rel.split(path.sep).join('/');
    if (posix.split('/').includes('vendor')) continue;
    const base = path.basename(rel);
    const full = path.join(outDir, rel);
    let html = await fs.readFile(full, 'utf8');
    if (!html.includes('</head>')) continue;
    if (html.includes('brand-fonts.css') || html.includes('brand-theme.css')) continue;

    const hrefFor = (file) =>
      path.relative(path.dirname(full), path.join(outDir, 'styles', file)).split(path.sep).join('/');

    const links = [];
    if (THEME_HTML.has(base)) {
      links.push(`<link rel="stylesheet" href="${hrefFor('brand-theme.css')}">`);
    } else if (!FONT_HTML_SKIP.has(base)) {
      links.push(`<link rel="stylesheet" href="${hrefFor('brand-fonts.css')}">`);
    }
    if (base === 'mic-permission.html') {
      links.push(
        '<style id="netmind-brand-page">body{background:var(--bg-primary);color:var(--text-primary)}h1{color:var(--text-primary);-webkit-text-fill-color:var(--text-primary)}</style>'
      );
    }
    if (!links.length) continue;
    html = html.replace('</head>', `  ${links.join('\n  ')}\n</head>`);
    await fs.writeFile(full, html);
  }
}

async function applyFirstRunStyles(outDir, config) {
  const tokensFile = path.join(ROOT, 'tokens.css');
  if (!existsSync(tokensFile)) {
    throw new Error('tokens.css not found — first-run styles require their shared design tokens');
  }
  const tokens = await fs.readFile(tokensFile, 'utf8');
  const styles = [
    {
      source: 'first-run-onboarding.css',
      target: path.join('styles', 'sidepanel.css'),
      label: 'first-run onboarding',
    },
    {
      source: 'first-run-install.css',
      target: path.join('src', 'ui', 'install.css'),
      label: 'first-run install page',
    },
  ];
  let applied = 0;
  for (const style of styles) {
    const source = path.join(BRAND, style.source);
    if (!existsSync(source)) continue;
    const target = path.join(outDir, style.target);
    if (!existsSync(target)) {
      warn(`${style.target} not found — ${style.label} styles NOT applied`);
      continue;
    }
    const css = await fs.readFile(source, 'utf8');
    await fs.appendFile(
      target,
      `\n\n/* ===== ${config.product.name} first-run tokens (tokens.css) ===== */\n${tokens}` +
      `\n\n/* ===== ${config.product.name} ${style.label} (brand/${style.source}) ===== */\n${css}`
    );
    applied++;
  }
  return applied;
}

function normalizedServiceUrl(value, label, { openAiCompatible = false } = {}) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`brand.config.json services.${label} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`brand.config.json services.${label} must be a credential-free HTTPS base URL`);
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = openAiCompatible && !/\/v1$/i.test(pathname)
    ? `${pathname}/v1`
    : (pathname || '/');
  return url.toString().replace(/\/+$/, '');
}

async function writeRuntimeConfig(outDir, config, written) {
  const services = config.services || {};
  const secondBrainBaseUrl = normalizedServiceUrl(
    services.secondBrainBaseUrl,
    'secondBrainBaseUrl',
  );
  const litellmBaseUrl = normalizedServiceUrl(
    services.litellmBaseUrl,
    'litellmBaseUrl',
    { openAiCompatible: true },
  );
  const oidcIssuer = normalizedServiceUrl(services.oidcIssuer, 'oidcIssuer');
  const oidcClientId = String(services.oidcClientId || '').trim();
  if (!oidcClientId || /[\u0000-\u0020]/.test(oidcClientId)) {
    throw new Error('brand.config.json services.oidcClientId must be a non-empty client ID without whitespace');
  }
  const oidcScopes = [...new Set(
    String(services.oidcScopes || 'openid profile email')
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
  )];
  if (!oidcScopes.includes('openid')) oidcScopes.unshift('openid');
  // Discovery is the norm, so these stay optional. They exist for providers
  // that serve no /.well-known/openid-configuration — the Viettel SSO wrapper
  // is one. Both or neither: one endpoint alone leaves the other undiscovered,
  // which fails at sign-in rather than here.
  const oidcAuthorizationEndpoint = services.oidcAuthorizationEndpoint
    ? normalizedServiceUrl(services.oidcAuthorizationEndpoint, 'oidcAuthorizationEndpoint')
    : '';
  const oidcTokenEndpoint = services.oidcTokenEndpoint
    ? normalizedServiceUrl(services.oidcTokenEndpoint, 'oidcTokenEndpoint')
    : '';
  if (Boolean(oidcAuthorizationEndpoint) !== Boolean(oidcTokenEndpoint)) {
    throw new Error(
      'brand.config.json services.oidcAuthorizationEndpoint and services.oidcTokenEndpoint '
      + 'must be set together, or both left out to use OIDC discovery',
    );
  }
  // Optional even when the two above are set. Left empty, signing out clears
  // everything the extension holds but leaves the SSO server's own session
  // standing, so the next sign-in goes through without asking for credentials.
  const oidcEndSessionEndpoint = services.oidcEndSessionEndpoint
    ? normalizedServiceUrl(services.oidcEndSessionEndpoint, 'oidcEndSessionEndpoint')
    : '';
  // The extension never verifies an ID-token signature — it has no key for a
  // symmetric alg and the server it hands the token to is the one that must
  // verify. Pinning the header alg is the part it can enforce: it refuses a
  // token downgraded to `none` or signed with an alg this deployment never
  // issues. Empty accepts any alg except `none`.
  const oidcIdTokenAlg = String(services.oidcIdTokenAlg || '').trim().toUpperCase();
  if (oidcIdTokenAlg && !ID_TOKEN_ALGS.includes(oidcIdTokenAlg)) {
    throw new Error(
      `brand.config.json services.oidcIdTokenAlg must be one of ${ID_TOKEN_ALGS.join(', ')}`,
    );
  }
  const redirectUris = Array.isArray(services.oidcRedirectUris)
    ? services.oidcRedirectUris.map((value) => {
        const url = new URL(String(value || ''));
        if (
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          url.pathname !== '/callback' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        ) {
          throw new Error(
            'brand.config.json services.oidcRedirectUris must contain only '
            + 'http://127.0.0.1:<port>/callback URLs',
          );
        }
        return url.toString();
      })
    : [];
  if (!redirectUris.length) {
    throw new Error('brand.config.json services.oidcRedirectUris must not be empty');
  }
  // How long a signed-in session may sit unused before the panel demands a
  // fresh sign-in. Omit the key to accept the 12-hour default; 0 disables the
  // idle window and leaves only Keycloak's own token lifetime.
  const rawIdleTimeout = services.sessionIdleTimeoutMs;
  const sessionIdleTimeoutMs = rawIdleTimeout === undefined
    ? 12 * 60 * 60_000
    : Number(rawIdleTimeout);
  if (!Number.isFinite(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 0) {
    throw new Error(
      'brand.config.json services.sessionIdleTimeoutMs must be a non-negative number of milliseconds',
    );
  }

  const relativePath = 'src/agentx/runtime-config.js';
  const target = path.join(outDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(
    target,
    `// Generated by scripts/brand-build.mjs from brand/brand.config.json.\n`
      + `// Do not edit brand-dist output directly.\n`
      + `export const AGENTX_RUNTIME_CONFIG = Object.freeze(${JSON.stringify({
        secondBrainBaseUrl,
        litellmBaseUrl,
        oidcIssuer,
        oidcClientId,
        oidcScopes: oidcScopes.join(' '),
        oidcAuthorizationEndpoint,
        oidcTokenEndpoint,
        oidcEndSessionEndpoint,
        oidcIdTokenAlg,
        oidcProvidersPath: '/api/auth/providers',
        oidcRedirectUris: redirectUris,
        requestTimeoutMs: 15_000,
        authTimeoutMs: 5 * 60_000,
        sessionIdleTimeoutMs,
      }, null, 2)});\n`,
  );
  written.add(relativePath);
}

// --- 7. verification -------------------------------------------------------
// Guards against the failure mode that actually bites: a replacement rule that
// is broader than intended silently rewriting an API host or a storage key.
async function checkPreserved(outDir, config) {
  const preserve = config.preserve || [];
  if (!preserve.length) return;
  const broken = [];
  for (const rel of await walk(outDir)) {
    if (!TEXT_EXT.has(path.extname(rel))) continue;
    const srcFile = path.join(ROOT, 'src', path.basename(outDir), rel);
    if (!existsSync(srcFile)) continue;
    const [out, orig] = await Promise.all([
      fs.readFile(path.join(outDir, rel), 'utf8'),
      fs.readFile(srcFile, 'utf8'),
    ]);
    for (const token of preserve) {
      const n = (s) => s.split(token).length - 1;
      if (n(out) < n(orig)) broken.push(`${rel}: "${token}" ${n(orig)} -> ${n(out)}`);
    }
  }
  if (broken.length) {
    throw new Error(
      `A replacement rule modified a token listed in brand.config.json "preserve".\n` +
        `These are API hosts / storage keys — rewriting them breaks the product.\n` +
        `Narrow the offending rule with "only"/"except".\n\n  ` +
        broken.slice(0, 20).join('\n  ')
    );
  }
}

// Catches the classic white-label bug: a replacement that lands inside an
// identifier and turns valid JS into a syntax error.
async function checkSyntax(outDir) {
  const files = (await walk(outDir)).filter((f) => f.endsWith('.js') && !f.includes('vendor'));
  const bad = [];
  for (const rel of files) {
    try {
      await execFileAsync(process.execPath, ['--check', path.join(outDir, rel)]);
    } catch (err) {
      bad.push(`${rel}: ${String(err.stderr || err.message).split('\n').slice(0, 3).join(' ')}`);
    }
  }
  if (bad.length) {
    throw new Error(`Branded output is not valid JavaScript:\n  ` + bad.slice(0, 10).join('\n  '));
  }
  return files.length;
}

async function auditLeftovers(outDir, config) {
  const token = config.audit?.token || 'webbrain';
  const re = new RegExp(escapeRe(token), 'gi');
  const byFile = [];
  let total = 0;
  for (const rel of await walk(outDir)) {
    if (!TEXT_EXT.has(path.extname(rel))) continue;
    const n = ((await fs.readFile(path.join(outDir, rel), 'utf8')).match(re) || []).length;
    if (n) {
      byFile.push([rel, n]);
      total += n;
    }
  }
  byFile.sort((a, b) => b[1] - a[1]);
  return { total, byFile };
}

// --- driver ----------------------------------------------------------------
async function buildTarget(target, config) {
  const srcDir = path.join(ROOT, 'src', target);
  if (!existsSync(srcDir)) return warn(`src/${target} not found — skipping`);

  const outDir = path.join(OUT, target);
  await fs.mkdir(outDir, { recursive: true });
  const written = new Set();

  const excluded = (config.features?.exclude || []).map(globToRe);
  const copied = await copyTree(srcDir, outDir, {
    skip: (rel) => excluded.some((re) => re.test(rel.split(path.sep).join('/'))),
    written,
  });
  log(`${target}: copied ${copied} upstream files`);

  for (const layer of ['overrides', 'additions']) {
    for (const scope of ['common', target]) {
      const dir = path.join(BRAND, layer, scope);
      if (existsSync(dir)) {
        log(`${target}: ${layer}/${scope} ${await copyTree(dir, outDir, { written })}`);
      }
    }
  }
  await writeRuntimeConfig(outDir, config, written);

  const patched = await applyPatches(outDir, target);
  if (patched) log(`${target}: ${patched} patch(es)`);

  const { files, hits } = await applyReplacements(outDir, compileReplacements(config));
  log(`${target}: ${hits} replacement(s) across ${files} file(s)`);

  const manifest = await rewriteManifest(outDir, config, target);
  const icons = await applyIcons(outDir, written);
  if (icons) log(`${target}: ${icons} icon(s)`);
  if (await applyTheme(outDir, config, written)) log(`${target}: theme appended`);
  const firstRunStyles = await applyFirstRunStyles(outDir, config);
  if (firstRunStyles) log(`${target}: ${firstRunStyles} first-run stylesheet(s) appended`);

  const removed = await prune(outDir, written);
  if (removed) log(`${target}: pruned ${removed} stale file(s)`);

  await checkPreserved(outDir, config);
  log(`${target}: syntax ok (${await checkSyntax(outDir)} js files)`);

  const { total, byFile } = await auditLeftovers(outDir, config);
  log(`${target}: ${total} leftover "${config.audit?.token || 'webbrain'}" occurrence(s)`);
  if (total && flag('audit', false)) {
    byFile.slice(0, 25).forEach(([f, n]) => console.log(`        ${String(n).padStart(4)}  ${f}`));
  }

  log(`${target}: -> brand-dist/${target}  (${manifest.name} v${manifest.version})\n`);
}

async function main() {
  if (flag('clean', false)) {
    await fs.rm(OUT, { recursive: true, force: true });
    return log('cleaned brand-dist/');
  }

  const readConfig = async () => JSON.parse(await fs.readFile(path.join(BRAND, 'brand.config.json'), 'utf8'));
  const config = await readConfig();
  const target = flag('target', 'all');
  const targets = target === 'all' ? ['chrome', 'firefox'] : [String(target)];

  for (const t of targets) await buildTarget(t, config);

  if (flag('watch', false)) {
    log('watching src/, brand/, and tokens.css …');
    const { watch } = await import('node:fs');
    let timer = null;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const fresh = await readConfig();
          for (const t of targets) await buildTarget(t, fresh);
        } catch (e) {
          warn(e.message);
        }
      }, 250);
    };
    for (const d of [path.join(ROOT, 'src'), BRAND]) watch(d, { recursive: true }, rebuild);
    watch(path.join(ROOT, 'tokens.css'), rebuild);
    await new Promise(() => {});
  }
}

main().catch((err) => {
  console.error('\n[brand] BUILD FAILED\n' + (err.stack || err.message));
  process.exit(1);
});
