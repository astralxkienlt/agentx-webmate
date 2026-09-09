/**
 * Workmate pairing — the paired handshake, hello_ack, and state.json.
 *
 * Both modes of the same listener are exercised here: without a pairing file
 * a v2 hello is accepted exactly as before (developer checkout, store build);
 * with one, the extension must speak v3 and present the token, and the server
 * echoes it back. The pairing file is re-read per handshake, so one bridge
 * instance is enough to walk through every case.
 *
 * Run: node --test test/pairing.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

const DIR = mkdtempSync(path.join(tmpdir(), "webmate-pairing-"));
process.env.WEBMATE_DIR = DIR;
process.env.WEBMATE_BRIDGE_PORT = process.env.WEBMATE_BRIDGE_PORT || "17397";
process.env.WEBMATE_COMMAND_TIMEOUT_MS = "2000";
process.env.WEBMATE_CONNECT_GRACE_MS = "300";

const { WebMateBridge, EXTENSION_CLIENT_ID } = await import("../dist/bridge.js");
const { bridgeUrl, config } = await import("../dist/config.js");
const { parsePairing, readPairing, PairingFileError } = await import("../dist/pairing.js");
const { StateFile } = await import("../dist/state.js");
const { SERVER_VERSION } = await import("../dist/version.js");

const TOKEN = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const OTHER = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");

function writePairing(token = TOKEN) {
  writeFileSync(
    config.pairingFile,
    JSON.stringify({ schema: 1, token, port: config.bridgePort, installId: "inst-1", createdAt: "2026-09-09T00:00:00Z" }),
  );
}
function clearPairing() {
  rmSync(config.pairingFile, { force: true });
}

/** A fake extension that records what the server sends and closes cleanly. */
function dial({ protocolVersion = 3, token, extra = {} } = {}) {
  const socket = new WebSocket(bridgeUrl());
  const events = { acks: [], closes: [], frames: [] };
  socket.on("open", () => {
    const hello = {
      type: "hello",
      client: EXTENSION_CLIENT_ID,
      protocolVersion,
      capabilities: ["run_modes_v1"],
      status: { enabled: true },
      ...extra,
    };
    if (token !== undefined) hello.token = token;
    socket.send(JSON.stringify(hello));
  });
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    events.frames.push(msg);
    if (msg.type === "hello_ack") events.acks.push(msg);
    if (msg.action) socket.send(JSON.stringify({ id: msg.id, ok: true, result: { echoed: msg.action } }));
  });
  socket.on("close", (code, reason) => events.closes.push({ code, reason: reason.toString() }));
  const closed = new Promise((resolve) => socket.on("close", resolve));
  const acked = new Promise((resolve) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "hello_ack") resolve(msg);
    });
  });
  return { socket, events, closed, acked };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.after(() => rmSync(DIR, { recursive: true, force: true }));

test("parsePairing accepts Workmate's file and rejects junk", () => {
  const pairing = parsePairing(JSON.stringify({ schema: 1, token: TOKEN, port: 17374, installId: "x", createdAt: "t" }));
  assert.equal(pairing.token, TOKEN);
  assert.equal(pairing.port, 17374);
  assert.throws(() => parsePairing("{"), PairingFileError);
  assert.throws(() => parsePairing(JSON.stringify({ schema: 2, token: TOKEN })), /schema/);
  assert.throws(() => parsePairing(JSON.stringify({ schema: 1, token: "short" })), /too short/);
  assert.throws(() => parsePairing("[]"), /object/);
});

test("readPairing returns null for a missing file and throws for a broken one", async () => {
  mkdirSync(DIR, { recursive: true });
  clearPairing();
  assert.equal(await readPairing(config.pairingFile), null);
  writeFileSync(config.pairingFile, "not json");
  await assert.rejects(() => readPairing(config.pairingFile), PairingFileError);
  clearPairing();
});

test("without a pairing file a v2 hello is accepted and the ack carries no token", async () => {
  clearPairing();
  const bridge = new WebMateBridge();
  await bridge.start();
  assert.equal(bridge.isPaired(), false);

  const ext = dial({ protocolVersion: 2 });
  assert.equal(await bridge.waitForExtension(3000), true);
  const ack = await ext.acked;
  assert.equal(ack.serverVersion, SERVER_VERSION);
  assert.equal(ack.token, null);
  assert.equal(ack.minProtocol, 2);
  const info = bridge.info();
  assert.equal(info.protocolVersion, 2);
  assert.equal(info.version, null, "a v2 hello carries no version");

  ext.socket.close();
  await ext.closed;
  await bridge.stop();
});

test("a v3 hello without a pairing file is accepted and its facts are recorded", async () => {
  clearPairing();
  const bridge = new WebMateBridge();
  await bridge.start();

  const ext = dial({
    protocolVersion: 3,
    token: TOKEN, // ignored: nothing to check it against, and it must not be echoed
    extra: { version: "1.0.4", browser: "Chrome 152", installType: "workmate", signedIn: false },
  });
  assert.equal(await bridge.waitForExtension(3000), true);
  const ack = await ext.acked;
  assert.equal(ack.token, null, "an unverified token must never be echoed back");
  const info = bridge.info();
  assert.deepEqual(
    { version: info.version, browser: info.browser, installType: info.installType, signedIn: info.signedIn, protocolVersion: info.protocolVersion },
    { version: "1.0.4", browser: "Chrome 152", installType: "workmate", signedIn: false, protocolVersion: 3 },
  );
  assert.ok(info.lastHelloAt);

  ext.socket.close();
  await ext.closed;
  await bridge.stop();
});

test("with a pairing file the token is required, checked, and echoed", async () => {
  writePairing();
  const bridge = new WebMateBridge();
  await bridge.start();
  assert.equal(bridge.isPaired(), true);

  // Wrong token → 1008 with a reason the user can act on.
  const wrong = dial({ token: OTHER, extra: { version: "1.0.4", browser: "Chrome 152", installType: "workmate" } });
  await wrong.closed;
  assert.equal(wrong.events.closes[0].code, 1008);
  assert.match(wrong.events.closes[0].reason, /token mismatch/i);
  assert.equal(wrong.events.acks.length, 0, "a rejected hello gets no ack");
  assert.equal(bridge.isConnected(), false);
  assert.match(bridge.snapshot().error, /token mismatch/i);

  // No token at all → same refusal.
  const missing = dial({ extra: { version: "1.0.4" } });
  await missing.closed;
  assert.equal(missing.events.closes[0].code, 1008);

  // Too old to carry a token → protocol refusal, not a token one.
  const old = dial({ protocolVersion: 2 });
  await old.closed;
  assert.equal(old.events.closes[0].code, 1008);
  assert.match(old.events.closes[0].reason, /protocol v3/i);

  // Right token → connected, and the ack echoes the token.
  const right = dial({ token: TOKEN, extra: { version: "1.0.4", browser: "Edge 152", installType: "workmate", signedIn: true } });
  assert.equal(await bridge.waitForExtension(3000), true);
  const ack = await right.acked;
  assert.equal(ack.token, TOKEN);
  assert.equal(ack.minProtocol, 3);
  assert.equal(bridge.snapshot().error, null, "a good handshake clears the last error");
  assert.equal(bridge.info().browser, "Edge 152");

  // Commands still flow, including the two Workmate hooks.
  const prepared = await bridge.request("workmate_prepare_update", {});
  assert.deepEqual(prepared, { echoed: "workmate_prepare_update" });
  const reloaded = await bridge.request("workmate_reload", {});
  assert.deepEqual(reloaded, { echoed: "workmate_reload" });

  right.socket.close();
  await right.closed;
  await bridge.stop();
  clearPairing();
});

test("a broken pairing file fails closed instead of falling back to dev mode", async () => {
  writeFileSync(config.pairingFile, "{ definitely not json");
  const bridge = new WebMateBridge();
  await bridge.start();
  assert.equal(bridge.isPaired(), true, "a present file means pairing is expected, even when unreadable");

  const ext = dial({ token: TOKEN, extra: { version: "1.0.4" } });
  await ext.closed;
  assert.equal(ext.events.closes[0].code, 1008);
  assert.match(ext.events.closes[0].reason, /pairing\.json/i);
  await bridge.stop();
  clearPairing();
});

test("not-connected errors say install vs. connect depending on the folder", async () => {
  writePairing();
  const bridge = new WebMateBridge({ installDir: path.join(DIR, "AgentX WebMate") });
  await bridge.start();
  // A failing assertion must not leak the listener: node --test would then
  // wait forever for a child that never exits.
  try {
  await assert.rejects(
    () => bridge.request("cloud_status", {}),
    (error) => {
      assert.equal(error.webmateCode, "WEBMATE_NOT_INSTALLED");
      assert.match(error.message, /not installed/i);
      return true;
    },
  );

  mkdirSync(path.join(DIR, "AgentX WebMate"), { recursive: true });
  writeFileSync(path.join(DIR, "AgentX WebMate", "manifest.json"), "{}");
  await assert.rejects(
    () => bridge.request("cloud_status", {}),
    (error) => {
      assert.equal(error.webmateCode, "WEBMATE_NOT_CONNECTED");
      assert.match(error.message, /Workmate → Settings → Browser/);
      return true;
    },
  );

  // Pairing removed after start: the failure path re-reads the file, so the
  // wording switches back to the developer instructions without a restart.
  clearPairing();
  await assert.rejects(
    () => bridge.request("cloud_status", {}),
    (error) => {
      assert.equal(error.webmateCode, "WEBMATE_NOT_CONNECTED");
      assert.match(error.message, /Cloud bridge/, "dev mode keeps the Settings instructions");
      return true;
    },
  );
  assert.equal(bridge.isPaired(), false);
  } finally {
    await bridge.stop();
    rmSync(path.join(DIR, "AgentX WebMate"), { recursive: true, force: true });
  }
});

test("state.json mirrors the bridge through connect and disconnect", async () => {
  clearPairing();
  const file = path.join(DIR, "state-test", "state.json");
  const state = new StateFile(file, { pid: process.pid, port: config.bridgePort, serverVersion: SERVER_VERSION });
  const bridge = new WebMateBridge();
  bridge.onChange(() => {
    const snap = bridge.snapshot();
    if (!snap.listening) return;
    state.update({
      listening: snap.listening,
      connected: snap.connected,
      pairingRequired: snap.pairingRequired,
      browser: snap.browser,
      extensionVersion: snap.version,
      installType: snap.installType,
      signedIn: snap.signedIn,
      protocolVersion: snap.protocolVersion,
      lastHelloAt: snap.lastHelloAt,
      error: snap.error,
    });
  });
  await bridge.start();
  await state.flush();
  let written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.schema, 1);
  assert.equal(written.listening, true);
  assert.equal(written.connected, false);
  assert.equal(written.pid, process.pid);
  assert.equal(written.port, config.bridgePort);
  assert.equal(written.serverVersion, SERVER_VERSION);

  const ext = dial({ extra: { version: "1.0.4", browser: "Chrome 152", installType: "dev", signedIn: true } });
  await bridge.waitForExtension(3000);
  await ext.acked;
  await state.flush();
  written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.connected, true);
  assert.equal(written.browser, "Chrome 152");
  assert.equal(written.extensionVersion, "1.0.4");
  assert.equal(written.installType, "dev");
  assert.equal(written.signedIn, true);
  assert.equal(written.protocolVersion, 3);
  assert.ok(written.lastHelloAt);

  ext.socket.close();
  await ext.closed;
  await sleep(50);
  await state.flush();
  written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.connected, false);
  assert.equal(written.browser, null, "facts from the old hello must not outlive its socket");

  await bridge.stop();
  state.update({ listening: false, connected: false });
  await state.flush();
  written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.listening, false);
});
