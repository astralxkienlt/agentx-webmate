/**
 * The drop-in skill ships the server as one ESM file. Bundle it the way
 * scripts/build-skill.mjs does and drive it over stdio like an MCP host would,
 * so a dependency that cannot be bundled (dynamic require, __dirname, native
 * addon) fails here instead of on a user's machine.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";

import { BUNDLE_OPTIONS } from "../scripts/build-skill.mjs";
import { loadBrand } from "../scripts/brand.mjs";

const BRAND = loadBrand();
const tool = (name) => `${BRAND.toolPrefix}_${name}`;

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

test("the single-file skill bundle serves the same catalog as the tsc build", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webmate-bundle-"));
  const outfile = join(dir, "agentx-webmate-mcp.mjs");
  await build({ ...BUNDLE_OPTIONS, outfile });

  const port = await freePort();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [outfile],
    cwd: dir, // no node_modules anywhere near: the bundle must be self-contained
    env: { ...process.env, WEBMATE_BRIDGE_PORT: String(port), WEBMATE_DIR: dir },
    stderr: "pipe",
  });
  const client = new Client({ name: "skill-bundle-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, BRAND.serverName);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["run", "extract", "status", "respond", "abort", "connection"].map(tool),
    );
    const result = await client.callTool({ name: tool("connection"), arguments: {} });
    assert.match(result.content.map((c) => c.text).join("\n"), new RegExp(`ws://127\\.0\\.0\\.1:${port}/extension`));
    // Nothing dialled in: the diagnostic carries the structured code both ways.
    assert.match(result.content[0].text, /^WEBMATE_NOT_CONNECTED: /);
    assert.equal(result.structuredContent?.code, "WEBMATE_NOT_CONNECTED");
    assert.equal(result.structuredContent?.connected, false);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
