/**
 * Bridge resilience tests — the failure modes an agent driving the browser
 * actually hits, rather than the happy-path round trip covered in
 * bridge.test.mjs.
 *
 * Runs in its own file because both behaviours are configured at import time
 * and need values no other test should inherit.
 *
 * Run: node --test test/bridge-resilience.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never read the developer machine's real ~/.agentx/webmate (Workmate writes a
// pairing.json there, which would switch this bridge into paired mode and
// reject the v2 fake extension below).
process.env.WEBMATE_DIR = mkdtempSync(join(tmpdir(), "webmate-test-"));
process.env.WEBMATE_BRIDGE_PORT = process.env.WEBMATE_BRIDGE_PORT || "17398";
process.env.WEBMATE_HEARTBEAT_INTERVAL_MS = "60";
process.env.WEBMATE_CONNECT_GRACE_MS = "4000";
process.env.WEBMATE_CONNECT_PROBE_MS = "50";
process.env.WEBMATE_COMMAND_TIMEOUT_MS = "2000";

const { WebMateBridge, EXTENSION_CLIENT_ID } = await import("../dist/bridge.js");
const { bridgeUrl, config } = await import("../dist/config.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeExtension(url, handler) {
  const socket = new WebSocket(url);
  socket.on("open", () => {
    socket.send(
      JSON.stringify({
        type: "hello",
        client: EXTENSION_CLIENT_ID,
        protocolVersion: 2,
        capabilities: ["run_modes_v1"],
      }),
    );
  });
  socket.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!msg.action) return;
    socket.send(JSON.stringify({ id: msg.id, ...(await handler(msg)) }));
  });
  return socket;
}

test("heartbeat settings are wired through the branded env names", () => {
  assert.equal(config.heartbeatIntervalMs, 60);
  assert.equal(config.connectGraceMs, 4000);
  // The grace must cover a full extension backoff cycle (10s ceiling) by
  // default; this file only overrides it to keep the suite quick.
  assert.equal(config.connectProbeMs, 50);
});

test("a command waits out the extension's reconnect backoff instead of failing instantly", async () => {
  const bridge = new WebMateBridge();
  await bridge.start();
  assert.equal(bridge.isConnected(), false);

  // Issue the command first — this is the MCP host spawning the server and
  // calling a tool before the browser has re-dialled.
  const pending = bridge.request("cloud_status", { runId: "run_late" });
  let ext;
  const attach = sleep(400).then(() => {
    ext = fakeExtension(bridgeUrl(), () => ({
      ok: true,
      result: { runId: "run_late", status: "completed" },
    }));
  });

  const result = await pending;
  await attach;
  assert.deepEqual(result, { runId: "run_late", status: "completed" });

  ext.close();
  await bridge.stop();
});

test("the grace has a floor: a browser that never attaches still reports not connected", async () => {
  const bridge = new WebMateBridge();
  await bridge.start();
  const startedAt = Date.now();
  await assert.rejects(
    () => bridge.request("cloud_status", { runId: "run_absent" }),
    /No .* is connected/,
  );
  const waited = Date.now() - startedAt;
  assert.ok(waited >= config.connectGraceMs - 50, `should wait out the grace, waited ${waited}ms`);
  assert.ok(waited < config.connectGraceMs + 2000, `should not wait far past the grace, waited ${waited}ms`);
  await bridge.stop();
});

test("a socket that stops answering pings is dropped instead of being reported connected", async () => {
  const bridge = new WebMateBridge();
  await bridge.start();

  const socket = fakeExtension(bridgeUrl(), () => ({ ok: true, result: {} }));
  // Suppress the automatic pong `ws` would send, so this stands in for a
  // browser that vanished without its TCP connection being torn down.
  socket.pong = () => {};
  await new Promise((resolve) => socket.on("open", resolve));
  await sleep(150);
  assert.equal(bridge.isConnected(), true, "a live socket stays connected while pings are outstanding");

  // Two missed pongs, then the terminate on the third tick.
  await sleep(config.heartbeatIntervalMs * 5);
  assert.equal(bridge.isConnected(), false, "a silent socket must stop counting as an attached browser");

  socket.terminate();
  await bridge.stop();
});

test("a healthy socket answers pings and is never dropped", async () => {
  const bridge = new WebMateBridge();
  await bridge.start();

  const socket = fakeExtension(bridgeUrl(), () => ({ ok: true, result: {} }));
  await new Promise((resolve) => socket.on("open", resolve));
  await sleep(config.heartbeatIntervalMs * 8);
  assert.equal(bridge.isConnected(), true, "auto-pong keeps a real extension attached across heartbeats");

  socket.close();
  await bridge.stop();
});
