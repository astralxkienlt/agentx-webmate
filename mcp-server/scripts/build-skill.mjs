#!/usr/bin/env node
/**
 * Build the drop-in skill packages, one per host:
 *
 *   release/workmate/<skill>/   AgentX Workmate skill (SKILL.md + setup.py + check_bridge.py)
 *   release/claude/<skill>/     Claude Code skill   (SKILL.md + setup_claude.py + check_bridge.py)
 *   release/<slug>-skill-<host>-<version>.zip
 *
 * Every package carries the MCP server bundled into ONE ESM file
 * (scripts/<brand>-mcp.mjs) so an installed skill needs nothing but Node.js
 * >= 20 — no clone, no npm — plus scripts/brand.json so the Python helpers
 * know the product name, registration key and bundle file. All names come
 * from brand/brand.config.json (scripts/brand.mjs).
 *
 *   node scripts/build-skill.mjs            # both hosts
 *   node scripts/build-skill.mjs claude     # one host
 */

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand, packageDir } from "./brand.mjs";
import { generateBrandModule } from "./gen-brand.mjs";

const version = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
const releaseDir = join(packageDir, "release");

export const HOSTS = {
  workmate: { scripts: ["setup.py"] },
  claude: { scripts: ["setup_claude.py"] },
};
const COMMON_SCRIPTS = ["check_bridge.py"];

export const BUNDLE_OPTIONS = {
  entryPoints: [join(packageDir, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    // The bundled CommonJS dependencies call require(); ESM has none by default.
    js: "import { createRequire as __brandCreateRequire } from 'node:module'; const require = __brandCreateRequire(import.meta.url);",
  },
};

/** Fill {{key}}, {{tool:name}} and {{hostTool:name}} placeholders; unknown keys are build errors. */
export function renderTemplate(template, brand) {
  return template.replace(/\{\{(\w+)(?::(\w+))?\}\}/g, (_, key, arg) => {
    if (key === "tool") return `${brand.toolPrefix}_${arg}`;
    if (key === "hostTool") return `mcp__${brand.skillName}__${brand.toolPrefix}_${arg}`;
    if (!(key in brand)) throw new Error(`template: unknown placeholder {{${key}}}`);
    return String(brand[key]);
  });
}

export async function buildSkill(hosts = Object.keys(HOSTS)) {
  generateBrandModule(); // the bundle compiles src/brand.generated.ts
  const brand = loadBrand();
  const results = [];
  for (const host of hosts) {
    if (!HOSTS[host]) throw new Error(`unknown host '${host}' (expected ${Object.keys(HOSTS).join("|")})`);
    const skillOut = join(releaseDir, host, brand.skillName);
    const scriptsOut = join(skillOut, "scripts");
    rmSync(skillOut, { recursive: true, force: true });
    mkdirSync(scriptsOut, { recursive: true });

    const bundleOut = join(scriptsOut, brand.bundleFile);
    await build({ ...BUNDLE_OPTIONS, outfile: bundleOut });
    // esbuild marks shebang outputs executable; the bundle is always launched
    // via `node`, and a bare +x on a .mjs trips skill scanners for no benefit.
    chmodSync(bundleOut, 0o644);

    const template = readFileSync(join(packageDir, "skill", host, "SKILL.md"), "utf8");
    writeFileSync(join(skillOut, "SKILL.md"), renderTemplate(template, brand));
    for (const file of COMMON_SCRIPTS) cpSync(join(packageDir, "skill", "common", "scripts", file), join(scriptsOut, file));
    for (const file of HOSTS[host].scripts) cpSync(join(packageDir, "skill", host, "scripts", file), join(scriptsOut, file));
    writeFileSync(
      join(scriptsOut, "brand.json"),
      JSON.stringify(
        {
          host,
          productName: brand.productName,
          extensionName: brand.extensionName,
          shortName: brand.shortName,
          envPrefix: brand.envPrefix,
          registrationName: brand.skillName,
          serverName: brand.serverName,
          toolPrefix: brand.toolPrefix,
          bundleFile: brand.bundleFile,
          bridgePort: 17374,
          version,
        },
        null,
        2,
      ) + "\n",
    );

    const zipName = `${brand.slug}-skill-${host}-${version}.zip`;
    const zipPath = join(releaseDir, zipName);
    rmSync(zipPath, { force: true });
    const zip = spawnSync("zip", ["-qr", join("..", zipName), brand.skillName], { cwd: join(releaseDir, host), stdio: "inherit" });
    results.push({ host, skillOut, bundleOut, zipPath: zip.status === 0 && existsSync(zipPath) ? zipPath : null });
  }
  return { brand, version, results };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const wanted = process.argv.slice(2).filter((a) => a !== "all");
  const { brand, results } = await buildSkill(wanted.length ? wanted : undefined);
  const kb = (p) => `${Math.round(statSync(p).size / 1024)} KB`;
  console.log(`brand: ${brand.productName} — skill '${brand.skillName}', tools ${brand.toolPrefix}_*, server key '${brand.skillName}'`);
  for (const r of results) {
    console.log(`[${r.host}] folder: ${r.skillOut}`);
    console.log(`[${r.host}] bundle: ${r.bundleOut} (${kb(r.bundleOut)})`);
    console.log(r.zipPath ? `[${r.host}] zip: ${r.zipPath} (${kb(r.zipPath)})` : `[${r.host}] zip: skipped (\`zip\` not found)`);
  }
}
