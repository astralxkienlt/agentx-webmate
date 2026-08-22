/**
 * Brand derivation: the same code must come out as AgentX WebMate on `main`
 * and as netMind on `netmind-extension` with nothing but brand.config.json
 * differing. These pin the derivation rules without switching branches.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deriveBrand, loadBrand, renderBrandModule } from "../scripts/brand.mjs";

test("AgentX WebMate derives every name from product.* alone", () => {
  const brand = deriveBrand({
    product: { name: "AgentX WebMate", shortName: "WebMate", slug: "agentx-webmate", homepage: "https://x" },
  });
  assert.deepEqual(brand, {
    productName: "AgentX WebMate",
    extensionName: "AgentX WebMate extension",
    shortName: "WebMate",
    slug: "agentx-webmate",
    homepage: "https://x",
    serverName: "agentx-webmate",
    toolPrefix: "webmate",
    envPrefix: "WEBMATE_",
    skillName: "webmate",
    packageName: "agentx-webmate-mcp",
    bundleFile: "agentx-webmate-mcp.mjs",
  });
});

test("netMind overrides only what it needs under the mcp key", () => {
  const brand = deriveBrand({
    product: { name: "netMind Extension", shortName: "netMind", slug: "netmind-extension" },
    mcp: { serverName: "netmind", packageName: "netmind-mcp" },
  });
  assert.equal(brand.productName, "netMind Extension");
  assert.equal(brand.extensionName, "netMind Extension");
  assert.equal(brand.serverName, "netmind");
  assert.equal(brand.toolPrefix, "netmind");
  assert.equal(brand.envPrefix, "NETMIND_");
  assert.equal(brand.skillName, "netmind");
  assert.equal(brand.packageName, "netmind-mcp");
  assert.equal(brand.bundleFile, "netmind-mcp.mjs");
});

test("odd short names still yield identifier-safe prefixes", () => {
  assert.equal(deriveBrand({ product: { name: "Foo Bar 2", shortName: "Foo-Bar 2" } }).toolPrefix, "foo_bar_2");
  assert.equal(deriveBrand({ product: { name: "Foo" } }).slug, "foo");
  assert.throws(() => deriveBrand({ product: { shortName: "!!!" } }), /tool prefix/);
});

test("the repo's own brand.config.json renders a compilable module", () => {
  const brand = loadBrand();
  const source = renderBrandModule(brand);
  assert.match(source, /export const BRAND = /);
  assert.match(source, /export const tool = /);
  assert.ok(brand.toolPrefix.length > 0 && brand.serverName.length > 0);
});
