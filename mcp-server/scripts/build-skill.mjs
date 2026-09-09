#!/usr/bin/env node
/**
 * Build the drop-in skill package (one zip, all hosts):
 *
 *   release/<skill>/              SKILL.md + setup.py + check_bridge.py
 *   release/<slug>-skill-<version>.zip
 *
 * Every package carries the MCP server bundled into ONE ESM file
 * (scripts/<brand>-mcp.mjs) so an installed skill needs nothing but Node.js
 * >= 20 — no clone, no npm — plus scripts/brand.json so the Python helpers
 * know the product name, registration key and bundle file. All names come
 * from brand/brand.config.json (scripts/brand.mjs).
 *
 *   node scripts/build-skill.mjs
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
const SKILL_SCRIPTS = ["setup.py", "check_bridge.py"];

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

export async function buildSkill() {
  generateBrandModule(); // the bundle compiles src/brand.generated.ts
  const brand = loadBrand();
  const skillOut = join(releaseDir, brand.skillName);
  const scriptsOut = join(skillOut, "scripts");
  rmSync(skillOut, { recursive: true, force: true });
  mkdirSync(scriptsOut, { recursive: true });

  const bundleOut = join(scriptsOut, brand.bundleFile);
  await build({ ...BUNDLE_OPTIONS, outfile: bundleOut });
  // esbuild marks shebang outputs executable; the bundle is always launched
  // via `node`, and a bare +x on a .mjs trips skill scanners for no benefit.
  chmodSync(bundleOut, 0o644);

  const template = readFileSync(join(packageDir, "skill", "SKILL.md"), "utf8");
  writeFileSync(join(skillOut, "SKILL.md"), renderTemplate(template, brand));
  for (const file of SKILL_SCRIPTS) {
    cpSync(join(packageDir, "skill", "scripts", file), join(scriptsOut, file));
  }
  writeFileSync(
    join(scriptsOut, "brand.json"),
    JSON.stringify(
      {
        productName: brand.productName,
        extensionName: brand.extensionName,
        shortName: brand.shortName,
        envPrefix: brand.envPrefix,
        registrationName: brand.skillName,
        serverName: brand.serverName,
        toolPrefix: brand.toolPrefix,
        bundleFile: brand.bundleFile,
        bridgePort: 17374,
        extensionId: brand.extensionId,
        installDirName: brand.installDirName,
        version,
      },
      null,
      2,
    ) + "\n",
  );

  const zipName = `${brand.slug}-skill-${version}.zip`;
  const zipPath = join(releaseDir, zipName);
  rmSync(zipPath, { force: true });
  const zip = spawnSync("zip", ["-qr", zipName, brand.skillName], { cwd: releaseDir, stdio: "inherit" });
  return {
    brand,
    version,
    skillOut,
    bundleOut,
    zipPath: zip.status === 0 && existsSync(zipPath) ? zipPath : null,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { brand, skillOut, bundleOut, zipPath } = await buildSkill();
  const kb = (p) => `${Math.round(statSync(p).size / 1024)} KB`;
  console.log(`brand: ${brand.productName} — skill '${brand.skillName}', tools ${brand.toolPrefix}_*, server key '${brand.skillName}'`);
  console.log(`folder: ${skillOut}`);
  console.log(`bundle: ${bundleOut} (${kb(bundleOut)})`);
  console.log(zipPath ? `zip: ${zipPath} (${kb(zipPath)})` : "zip: skipped (`zip` not found)");
}
