#!/usr/bin/env node
/**
 * Build the drop-in AgentX Workmate skill package.
 *
 * Output:
 *   release/webmate/                      the skill folder (SKILL.md, scripts/)
 *   release/agentx-webmate-skill-<v>.zip  the same folder zipped, unzip into
 *                                         $AGENTX_HOME/skills/autonomous-ai-agents/
 *
 * The MCP server is bundled into ONE ESM file (scripts/agentx-webmate-mcp.mjs)
 * so an installed skill needs nothing but Node.js >= 20 — no clone, no npm.
 * ws's optional native accelerators stay external; ws falls back to pure JS
 * when they are absent.
 */

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
const releaseDir = join(packageDir, "release");
const skillOut = join(releaseDir, "webmate");
const bundleOut = join(skillOut, "scripts", "agentx-webmate-mcp.mjs");

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
    js: "import { createRequire as __agentxCreateRequire } from 'node:module'; const require = __agentxCreateRequire(import.meta.url);",
  },
};

export async function buildSkill() {
  rmSync(skillOut, { recursive: true, force: true });
  mkdirSync(join(skillOut, "scripts"), { recursive: true });

  await build({ ...BUNDLE_OPTIONS, outfile: bundleOut });
  // esbuild marks shebang outputs executable; the bundle is always launched via
  // `node`, and a bare +x on a .mjs trips skill scanners for no benefit.
  chmodSync(bundleOut, 0o644);

  for (const file of ["SKILL.md", "scripts/setup.py", "scripts/check_bridge.py"]) {
    cpSync(join(packageDir, "skill", file), join(skillOut, file));
  }

  const zipName = `agentx-webmate-skill-${version}.zip`;
  const zipPath = join(releaseDir, zipName);
  rmSync(zipPath, { force: true });
  const zip = spawnSync("zip", ["-qr", zipName, "webmate"], { cwd: releaseDir, stdio: "inherit" });
  const zipped = zip.status === 0 && existsSync(zipPath);

  return { skillOut, bundleOut, zipPath: zipped ? zipPath : null, version };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await buildSkill();
  const kb = (p) => `${Math.round(statSync(p).size / 1024)} KB`;
  console.log(`skill folder: ${result.skillOut}`);
  console.log(`server bundle: ${result.bundleOut} (${kb(result.bundleOut)})`);
  if (result.zipPath) console.log(`zip: ${result.zipPath} (${kb(result.zipPath)})`);
  else console.log("zip: skipped (`zip` not found) — the skill folder above is complete");
}
