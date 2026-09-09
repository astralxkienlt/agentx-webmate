import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const { BRAND, tool } = await import("../dist/brand.generated.js");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const scratchDir = mkdtempSync(join(tmpdir(), "webmate-catalog-"));
process.on("exit", () => rmSync(scratchDir, { recursive: true, force: true }));

function spawnServer(port) {
  return new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: packageDir,
    // state.json / commands go to a scratch dir, never the developer's real profile.
    env: { ...process.env, WEBMATE_BRIDGE_PORT: String(port), WEBMATE_DIR: scratchDir },
    stderr: "pipe",
  });
}

test("MCP catalog exposes structured extraction alongside run controls, under the configured brand", async () => {
  const port = await freePort();
  const client = new Client({ name: `${BRAND.serverName}-catalog-test`, version: "1.0.0" });

  try {
    await client.connect(spawnServer(port));

    // The server identifies itself under the brand, and ships guidance for
    // hosts (Claude Code) that surface server instructions.
    assert.equal(client.getServerVersion()?.name, BRAND.serverName);
    assert.match(client.getInstructions() ?? "", /signed-in browser/);
    assert.match(client.getInstructions() ?? "", new RegExp(escapeRe(BRAND.productName)));

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["run", "extract", "status", "respond", "abort", "connection"].map(tool),
    );

    // Nothing user-visible may carry the upstream brand — the MCP host shows
    // these names and descriptions verbatim to the model and the user.
    for (const t of tools) {
      assert.doesNotMatch(`${t.name} ${t.title ?? ""} ${t.description}`, /webbrain/i, t.name);
    }

    const extract = tools.find((t) => t.name === tool("extract"));
    assert.ok(extract, "structured extraction tool is missing");
    assert.deepEqual(extract.inputSchema.required, ["task", "output_schema"]);
    assert.equal(extract.inputSchema.properties.output_schema.type, "object");
    assert.match(extract.description, new RegExp(`always uses ${escapeRe(BRAND.productName)} Ask mode`, "i"));
  } finally {
    await client.close().catch(() => {});
  }
});

test("the connection tool explains how to attach the extension when nothing is connected", async () => {
  const port = await freePort();
  const client = new Client({ name: `${BRAND.serverName}-connection-test`, version: "1.0.0" });

  try {
    await client.connect(spawnServer(port));
    const result = await client.callTool({ name: tool("connection"), arguments: {} });
    const text = result.content.map((c) => c.text).join("\n");
    assert.match(text, /Not connected/);
    assert.match(text, new RegExp(`ws://127\\.0\\.0\\.1:${port}/extension`));
    assert.match(text, new RegExp(`${escapeRe(BRAND.productName)} → Settings → General → Advanced → Cloud bridge`));
    assert.doesNotMatch(text, /webbrain/i);
  } finally {
    await client.close().catch(() => {});
  }
});
