/**
 * The drop-in skill package must be host-neutral: one folder/zip with a rendered
 * SKILL.md (no template placeholders, no angle brackets) and the unified scripts.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildSkill, renderTemplate } from "../scripts/build-skill.mjs";
import { loadBrand } from "../scripts/brand.mjs";

test("renderTemplate fills brand placeholders", () => {
  const brand = loadBrand();
  const out = renderTemplate("{{productName}} {{tool:run}} {{hostTool:run}}", brand);
  assert.match(out, new RegExp(brand.productName));
  assert.match(out, new RegExp(`${brand.toolPrefix}_run`));
  assert.match(out, new RegExp(`mcp__${brand.skillName}__${brand.toolPrefix}_run`));
});

test("buildSkill produces a host-neutral package", async () => {
  const { brand, version, skillOut, bundleOut, zipPath } = await buildSkill();
  try {
    assert.ok(existsSync(join(skillOut, "SKILL.md")));
    assert.ok(existsSync(join(skillOut, "scripts", "setup.py")));
    assert.ok(existsSync(join(skillOut, "scripts", "check_bridge.py")));
    assert.ok(existsSync(join(skillOut, "scripts", "brand.json")));
    assert.ok(existsSync(bundleOut));

    const skill = readFileSync(join(skillOut, "SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /\{\{/);
    assert.doesNotMatch(skill, /[<>]/);

    const front = skill.split("---")[1] ?? "";
    assert.doesNotMatch(front, /[<>]/);

    const brandJson = JSON.parse(readFileSync(join(skillOut, "scripts", "brand.json"), "utf8"));
    assert.equal(brandJson.registrationName, brand.skillName);
    assert.equal(brandJson.bundleFile, brand.bundleFile);
    assert.equal(brandJson.host, undefined);

    if (zipPath) {
      assert.match(zipPath, new RegExp(`${brand.slug}-skill-${version.replaceAll(".", "\\.")}\\.zip$`));
    }
  } finally {
    rmSync(skillOut, { recursive: true, force: true });
  }
});
