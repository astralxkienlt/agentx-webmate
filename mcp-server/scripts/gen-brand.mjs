#!/usr/bin/env node
/** Write src/brand.generated.ts from brand/brand.config.json (runs before tsc). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand, packageDir, renderBrandModule } from "./brand.mjs";

export function generateBrandModule() {
  const brand = loadBrand();
  const out = join(packageDir, "src", "brand.generated.ts");
  const next = renderBrandModule(brand);
  mkdirSync(join(packageDir, "src"), { recursive: true });
  // Only touch the file when it changes so `tsc --watch` and build stamps stay quiet.
  if (!existsSync(out) || readFileSync(out, "utf8") !== next) {
    writeFileSync(out, next);
    console.error(`[gen-brand] ${brand.productName}: tools ${brand.toolPrefix}_*, server ${brand.serverName}`);
  }
  return brand;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) generateBrandModule();
