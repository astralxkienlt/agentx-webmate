import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

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

test("MCP catalog exposes structured extraction alongside run controls", async () => {
  const port = await freePort();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: packageDir,
    env: { ...process.env, WEBMATE_BRIDGE_PORT: String(port) },
    stderr: "pipe",
  });
  const client = new Client({ name: "agentx-webmate-catalog-test", version: "1.0.0" });

  try {
    await client.connect(transport);

    // The server identifies itself under the AgentX brand, and ships guidance
    // for hosts (Claude Code, Workmate) that surface server instructions.
    assert.equal(client.getServerVersion()?.name, "agentx-webmate");
    assert.match(client.getInstructions() ?? "", /signed-in browser/);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "webmate_run",
        "webmate_extract",
        "webmate_status",
        "webmate_respond",
        "webmate_abort",
        "webmate_connection",
      ],
    );

    // Nothing user-visible may still carry the upstream brand — the MCP host
    // shows these names and descriptions verbatim to the model and the user.
    for (const tool of tools) {
      assert.doesNotMatch(`${tool.name} ${tool.title ?? ""} ${tool.description}`, /webbrain/i, tool.name);
    }

    const extract = tools.find((tool) => tool.name === "webmate_extract");
    assert.ok(extract, "structured extraction tool is missing");
    assert.deepEqual(extract.inputSchema.required, ["task", "output_schema"]);
    assert.equal(extract.inputSchema.properties.output_schema.type, "object");
    assert.match(extract.description, /always uses AgentX WebMate Ask mode/i);
  } finally {
    await client.close().catch(() => {});
  }
});

test("webmate_connection explains how to attach the extension when nothing is connected", async () => {
  const port = await freePort();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: packageDir,
    env: { ...process.env, WEBMATE_BRIDGE_PORT: String(port) },
    stderr: "pipe",
  });
  const client = new Client({ name: "agentx-webmate-connection-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "webmate_connection", arguments: {} });
    const text = result.content.map((c) => c.text).join("\n");
    assert.match(text, /Not connected/);
    assert.match(text, new RegExp(`ws://127\\.0\\.0\\.1:${port}/extension`));
    assert.match(text, /AgentX WebMate → Settings → General → Advanced → Cloud bridge/);
    assert.doesNotMatch(text, /webbrain/i);
  } finally {
    await client.close().catch(() => {});
  }
});
