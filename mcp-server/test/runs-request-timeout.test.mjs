import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WEBMATE_POLL_INTERVAL_MS = "5";

const { PERMISSION_MODES, awaitSettled, describeSnapshot, startRun } = await import(
  "../dist/runs.js"
);
// Never read the developer machine's real ~/.agentx/webmate (Workmate writes a
// pairing.json there, which would switch this bridge into paired mode and
// reject the v2 fake extension below).
process.env.WEBMATE_DIR = mkdtempSync(join(tmpdir(), "webmate-test-"));
const { BridgeError } = await import("../dist/bridge.js");

/** A bridge that records the one payload it is handed. */
function recordingBridge() {
  const seen = {};
  return {
    seen,
    async request(action, payload) {
      seen.action = action;
      seen.payload = payload;
      return { runId: payload.runId, status: "running" };
    },
  };
}

test("startRun forwards its caller-supplied run ID and command budget", async () => {
  let observed;
  const bridge = {
    async request(action, payload, requestTimeoutMs) {
      observed = { action, payload, requestTimeoutMs };
      return { runId: payload.runId, status: "running" };
    },
  };

  const result = await startRun(
    bridge,
    { runId: "recoverable-start", task: "do work", mode: "ask" },
    25,
  );

  assert.equal(result.runId, "recoverable-start");
  assert.deepEqual(observed, {
    action: "cloud_run",
    payload: { runId: "recoverable-start", task: "do work", mode: "ask" },
    requestTimeoutMs: 25,
  });
});

test("startRun forwards a structured output schema without changing Ask mode", async () => {
  let observed;
  const bridge = {
    async request(action, payload) {
      observed = { action, payload };
      return { runId: payload.runId, status: "running" };
    },
  };
  const outputSchema = {
    type: "object",
    properties: { invoices: { type: "array", items: { type: "object" } } },
    required: ["invoices"],
  };

  await startRun(bridge, {
    runId: "structured-read",
    task: "Extract overdue invoices",
    mode: "ask",
    outputSchema,
  });

  assert.deepEqual(observed, {
    action: "cloud_run",
    payload: {
      runId: "structured-read",
      task: "Extract overdue invoices",
      mode: "ask",
      outputSchema,
    },
  });
});

test("startRun rejects API mutation permission in ask mode before dispatch", async () => {
  let dispatched = false;
  const bridge = {
    async request() {
      dispatched = true;
    },
  };

  await assert.rejects(
    () =>
      startRun(bridge, {
        task: "read the page",
        mode: "ask",
        apiMutationsAllowed: true,
      }),
    /requires mode 'act'/,
  );
  assert.equal(dispatched, false);
});

test("awaitSettled bounds each status request by the remaining run budget", async () => {
  let observedRequestTimeout;
  const bridge = {
    async request(_action, _payload, requestTimeoutMs) {
      observedRequestTimeout = requestTimeoutMs;
      const delayMs = (requestTimeoutMs ?? 500) + 5;
      return await new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("status response stalled")), delayMs);
      });
    },
  };

  const startedAt = Date.now();
  const result = await awaitSettled(bridge, "stalled-run", { timeoutMs: 40 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.equal(result.snapshot.status, "running");
  assert.ok(observedRequestTimeout > 0 && observedRequestTimeout <= 40);
  assert.ok(elapsedMs < 250, `40ms timeout took ${elapsedMs}ms`);
});

test("a command timeout returns the run ID instead of losing recovery access", async () => {
  const bridge = {
    async request() {
      throw new BridgeError("status command timed out", undefined, "COMMAND_TIMEOUT");
    },
  };

  const result = await awaitSettled(bridge, "recoverable-run", { timeoutMs: 5_000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.snapshot.runId, "recoverable-run");
  assert.equal(result.snapshot.status, "running");
});

test("a disconnected status request preserves recovery access to the run", async () => {
  const bridge = {
    async request() {
      throw new BridgeError(
        "extension disconnected mid-command",
        undefined,
        "COMMAND_INTERRUPTED",
      );
    },
  };

  const result = await awaitSettled(bridge, "interrupted-run", { timeoutMs: 5_000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.snapshot.runId, "interrupted-run");
  assert.equal(result.snapshot.status, "running");
});

test("startRun forwards the run's permission mode, and omits it when unset", async () => {
  for (const permissionMode of PERMISSION_MODES) {
    const bridge = recordingBridge();
    await startRun(bridge, { runId: "scoped", task: "Open the report", mode: "act", permissionMode });
    assert.equal(bridge.seen.payload.permissionMode, permissionMode);
  }

  // Omitted must stay OMITTED rather than become an explicit narrow mode: the
  // browser reads an absent key as "no opinion" and applies its standing mode,
  // and sending one would overrule a choice the caller never made.
  const bare = recordingBridge();
  await startRun(bare, { runId: "bare", task: "Open the report", mode: "act" });
  assert.equal("permissionMode" in bare.seen.payload, false);
});

test("a run reports back the permission mode it actually executed at", async () => {
  // The caller asked for one; the browser is the authority on what it granted.
  const described = describeSnapshot({
    runId: "scoped",
    status: "completed",
    mode: "act",
    permissionMode: "bypass",
  });
  assert.match(described, /^permission_mode: bypass$/m);

  // A run on the browser's standing mode has nothing to report, and must not
  // invent a mode it was never given.
  const standing = describeSnapshot({ runId: "plain", status: "completed", mode: "act" });
  assert.doesNotMatch(standing, /permission_mode/);
});
