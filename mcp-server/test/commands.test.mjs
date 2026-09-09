/**
 * Command files from Workmate: pick-up, claim-by-delete, ordering, outcomes.
 *
 * Also drives the built server end to end: a fake extension attached over
 * the bridge sees `workmate_prepare_update` polled until it reports idle,
 * then `workmate_reload`, and state.json records both outcomes.
 *
 * Run: node --test test/commands.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const { CommandWatcher, parseCommand } = await import("../dist/commands.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

/** Workmate's way of dropping a command: write a temp sibling, then rename. */
function dropCommand(dir, id, action, payload) {
  const tmp = path.join(dir, `${id}.json.tmp`);
  writeFileSync(tmp, JSON.stringify({ id, action, payload }));
  renameSync(tmp, path.join(dir, `${id}.json`));
}

async function until(predicate, { timeoutMs = 5_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("parseCommand accepts the five actions and names unknown ones", () => {
  const { command } = parseCommand(JSON.stringify({ id: "c1", action: "prepare_update" }), "/x/c1.json");
  assert.deepEqual(command, { id: "c1", action: "prepare_update", payload: {}, file: "/x/c1.json" });
  const hint = parseCommand(JSON.stringify({ id: "c2", action: "auth_hint", payload: { loginHint: "k@x.test" } }), "/x/c2.json").command;
  assert.deepEqual(hint, { id: "c2", action: "auth_hint", payload: { loginHint: "k@x.test" }, file: "/x/c2.json" });
  assert.equal(parseCommand(JSON.stringify({ action: "auth_open" }), "/x/c3.json").command.action, "auth_open");
  assert.equal(parseCommand(JSON.stringify({ action: "reload" }), "/x/abc.json").command.id, "abc", "id falls back to the file stem");
  assert.match(parseCommand(JSON.stringify({ action: "format_disk" }), "/x/y.json").reason, /unknown action/);
  assert.match(parseCommand("nope", "/x/y.json").reason, /not JSON/);
  assert.match(parseCommand("[1]", "/x/y.json").reason, /not an object/);
});

test("the watcher claims each file once, oldest first, and reports outcomes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "webmate-commands-"));
  const handled = [];
  const results = [];
  const watcher = new CommandWatcher({
    dir,
    pollMs: 50,
    handle: async (command) => {
      handled.push(command.action);
      if (command.action === "reload") throw new Error("browser vanished");
      return { ok: true, busy: 0 };
    },
    onResult: (command, outcome, timing) => results.push({ id: command.id, action: command.action, outcome, timing }),
  });
  try {
    // A file already present at start is processed too.
    dropCommand(dir, "first", "prepare_update");
    await watcher.start();
    await until(() => results.length === 1, { label: "startup command" });

    dropCommand(dir, "second", "reload");
    writeFileSync(path.join(dir, "junk.json"), "{ not json");
    writeFileSync(path.join(dir, "ignored.txt"), "x");
    writeFileSync(path.join(dir, "half.json.tmp"), "{}");
    await until(() => results.length === 2, { label: "second command" });

    assert.deepEqual(handled, ["prepare_update", "reload"]);
    assert.equal(results[0].outcome.ok, true);
    assert.equal(results[1].outcome.ok, false);
    assert.match(results[1].outcome.error, /browser vanished/);
    assert.ok(results[1].timing.startedAt <= results[1].timing.finishedAt);
    await until(() => !existsSync(path.join(dir, "second.json")) && !existsSync(path.join(dir, "junk.json")), {
      label: "claimed files removed",
    });
    assert.ok(existsSync(path.join(dir, "ignored.txt")), "non-command files are left alone");
    assert.ok(existsSync(path.join(dir, "half.json.tmp")), "a temp file still being written is left alone");
  } finally {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end: prepare_update drains the extension, reload restarts it, state.json records both", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "webmate-e2e-"));
  const port = await freePort();
  const stateFile = path.join(dir, "state.json");
  const commandsDir = path.join(dir, "commands");
  mkdirSync(commandsDir, { recursive: true });

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: packageDir,
    env: {
      ...process.env,
      WEBMATE_DIR: dir,
      WEBMATE_BRIDGE_PORT: String(port),
      WEBMATE_CONNECT_GRACE_MS: "3000",
      WEBMATE_PREPARE_UPDATE_TIMEOUT_MS: "5000",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null);
  const seen = [];
  let busy = 2;
  let ext;
  try {
    await until(() => readState()?.listening === true, { label: "server listening (state.json)" });

    ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    ext.on("open", () => {
      ext.send(
        JSON.stringify({
          type: "hello",
          client: "webbrain-extension",
          protocolVersion: 3,
          version: "1.0.4",
          browser: "Chrome 152",
          installType: "dev",
          signedIn: false,
          instanceId: "inst-e2e",
          capabilities: ["workmate_update_v1"],
          status: {},
        }),
      );
    });
    ext.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (!msg.action) return;
      seen.push(msg.action);
      if (msg.action === "auth_hint") {
        assert.equal(msg.payload.loginHint, "kien@example.test");
        ext.send(JSON.stringify({ id: msg.id, ok: true, result: { ok: true, outcome: "signed-in", signedIn: true, email: "kien@example.test" } }));
        return;
      }
      if (msg.action === "auth_open") {
        // A refusal carries its code as `code` (never `error`, which the offscreen bridge reserves).
        ext.send(JSON.stringify({ id: msg.id, ok: true, result: { ok: false, outcome: "error", signedIn: false, code: "sign_in_window_failed", message: "no window" } }));
        return;
      }
      if (msg.action === "workmate_prepare_update") {
        // Two polls report work in flight, then the browser is idle.
        const reply = { ok: true, draining: true, busy };
        busy = Math.max(0, busy - 1);
        ext.send(JSON.stringify({ id: msg.id, ok: true, result: reply }));
        return;
      }
      ext.send(JSON.stringify({ id: msg.id, ok: true, result: { ok: true } }));
    });
    await until(() => readState()?.connected === true, { label: "extension connected (state.json)" });
    assert.equal(readState().browser, "Chrome 152");
    assert.equal(readState().signedIn, false);
    assert.equal(readState().instanceId, "inst-e2e");
    assert.deepEqual(readState().connections.map((c) => [c.instanceId, c.browser, c.active]), [["inst-e2e", "Chrome 152", true]]);

    // auth_hint reaches the browser nobody is signed in to, with the account email.
    dropCommand(commandsDir, "cmd-hint", "auth_hint", { loginHint: "kien@example.test" });
    await until(() => readState()?.lastCommand?.id === "cmd-hint", { label: "auth_hint outcome", timeoutMs: 10_000 });
    const hinted = readState().lastCommand;
    assert.equal(hinted.ok, true, `auth_hint failed: ${hinted.error}`);
    assert.equal(hinted.signedIn, true);
    assert.deepEqual(hinted.results.map((r) => [r.instanceId, r.outcome, r.signedIn, r.email]), [["inst-e2e", "signed-in", true, "kien@example.test"]]);
    assert.equal(readState().signedIn, true, "the answer marks the browser signed in at once");

    // A second hint has nobody left to ask.
    dropCommand(commandsDir, "cmd-hint-2", "auth_hint", { loginHint: "kien@example.test" });
    await until(() => readState()?.lastCommand?.id === "cmd-hint-2", { label: "second auth_hint outcome", timeoutMs: 10_000 });
    assert.deepEqual(readState().lastCommand.results, []);
    assert.equal(seen.filter((a) => a === "auth_hint").length, 1, "signed-in browsers are not asked again");

    dropCommand(commandsDir, "cmd-open", "auth_open", { loginHint: "kien@example.test" });
    await until(() => readState()?.lastCommand?.id === "cmd-open", { label: "auth_open outcome", timeoutMs: 10_000 });
    const opened = readState().lastCommand;
    assert.equal(opened.ok, false);
    assert.ok(seen.includes("auth_open"), "auth_open goes to the active browser even when it is signed in");
    assert.deepEqual(opened.results.map((r) => [r.outcome, r.error, r.message]), [["error", "sign_in_window_failed", "no window"]], "the extension's `code` lands as the result's error");
    assert.match(opened.error, /no window/);

    dropCommand(commandsDir, "cmd-prepare", "prepare_update");
    await until(() => readState()?.lastCommand?.id === "cmd-prepare", { label: "prepare_update outcome", timeoutMs: 10_000 });
    const prepared = readState().lastCommand;
    assert.equal(prepared.ok, true, `prepare_update failed: ${prepared.error}`);
    assert.equal(prepared.busy, 0);
    assert.equal(seen.filter((a) => a === "workmate_prepare_update").length, 3, "polled until busy hit 0");

    dropCommand(commandsDir, "cmd-reload", "reload");
    await until(() => readState()?.lastCommand?.id === "cmd-reload", { label: "reload outcome", timeoutMs: 10_000 });
    assert.equal(readState().lastCommand.ok, true);
    assert.ok(seen.includes("workmate_reload"));
    assert.ok(!existsSync(path.join(commandsDir, "cmd-reload.json")), "command files are consumed");

    // Goodbye on stdin close.
    const exited = once(child, "exit");
    child.stdin.end();
    await exited;
    assert.equal(readState().listening, false, "shutdown writes listening:false");
    assert.equal(readState().connected, false);
  } catch (error) {
    error.message += `\n--- server stderr ---\n${stderr}`;
    throw error;
  } finally {
    try {
      ext?.terminate();
    } catch {
      /* ignore */
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
