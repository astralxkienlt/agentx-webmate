/**
 * Run orchestration.
 *
 * `cloud_run` returns as soon as the run is registered — the actual work happens
 * in a detached async IIFE inside the extension (`cloud-runs.js`). So starting a
 * task gives us a snapshot with status 'running', and we poll `cloud_status`
 * until it reaches a terminal state or stops to ask the user something.
 *
 * Important: every tool call still travels the full agent loop inside the
 * extension (`agent.processMessage` -> `_executeToolBatch`), which means the
 * capability x origin permission gate is enforced exactly as it is for a human
 * driving the side panel. This server deliberately does NOT expose the
 * individual browser primitives — `executeTool()` has no gate of its own, and
 * calling it directly would move the trust boundary out of the browser.
 *
 * Permission prompts ride the same clarify channel as free-text questions
 * (`agent._promptPermission`): the extension emits `pendingInput` with
 * `permission: {capability, host}` and `options: ['once','always','deny']`,
 * and its parser accepts EXACTLY those tokens — anything else fails closed to
 * deny. A calling agent that forwards the user's "yes" verbatim would therefore
 * deny its own request, so this module (a) prints the accepted answers in every
 * status text and (b) refuses to forward an answer that does not match.
 */

import { BRAND, tool } from "./brand.generated.js";
import { BridgeError, TERMINAL_STATUSES, WebMateBridge, type CloudSnapshot } from "./bridge.js";
import { config } from "./config.js";

export interface StartRunOptions {
  runId?: string;
  task: string;
  mode: "ask" | "act";
  tabId?: number;
  apiMutationsAllowed?: boolean;
  outputSchema?: unknown;
}

export interface AwaitOptions {
  timeoutMs: number;
}

/** What a paused run is waiting for, normalised from the extension's `pendingInput`. */
export interface PendingInputInfo {
  clarifyId: string;
  question: string;
  /** Accepted answers. Empty for free-text questions. */
  options: string[];
  /** Set when the pause is a capability × host permission request. */
  permission: { capability: string; host: string } | null;
}

export type AnswerVerdict =
  | { ok: true; answer: string }
  | { ok: false; message: string };

/** Capability → verb, mirroring CAPABILITY_LABEL in the extension's permission gate. */
const CAPABILITY_VERB: Record<string, string> = {
  navigate: "navigate to",
  click: "click / submit on",
  type: "type into",
  execute_js: "run JavaScript on",
  dev_patch: "temporarily modify the page on",
  network_write: "make a network request to",
  download: "download files from",
  upload: "upload a file to",
  window: "resize the browser window for",
  schedule: "schedule future work for",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function describePendingInput(pendingInput: unknown): PendingInputInfo | null {
  if (!pendingInput || typeof pendingInput !== "object") return null;
  const raw = pendingInput as Record<string, unknown>;
  const clarifyId = String(raw.clarifyId || raw.clarify_id || "").trim();
  const question = typeof raw.question === "string" ? raw.question : "";
  const options = Array.isArray(raw.options)
    ? raw.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0)
    : [];
  let permission: PendingInputInfo["permission"] = null;
  if (raw.permission && typeof raw.permission === "object") {
    const p = raw.permission as Record<string, unknown>;
    permission = {
      capability: String(p.capability || "").trim(),
      host: String(p.host || "").trim(),
    };
  }
  return { clarifyId, question, options, permission };
}

function permissionSentence(permission: { capability: string; host: string }): string {
  const verb = CAPABILITY_VERB[permission.capability] || `use '${permission.capability || "?"}' on`;
  return `${BRAND.productName} wants to ${verb} ${permission.host || "this site"}.`;
}

/**
 * Check an answer against the pending input before it is sent to the browser.
 * Exact option matches are accepted case-insensitively and normalised to the
 * option's canonical spelling. Natural language is never mapped — translating
 * the user's decision into a token is the calling agent's job, and guessing
 * here would turn this server into a permission-granting heuristic.
 */
export function validateAnswer(pendingInput: unknown, answer: string): AnswerVerdict {
  const trimmed = String(answer ?? "").trim();
  if (!trimmed) return { ok: false, message: `${tool("respond")} requires a non-empty answer.` };
  const info = describePendingInput(pendingInput);
  if (!info || info.options.length === 0) return { ok: true, answer: trimmed };

  const match = info.options.find((option) => option.toLowerCase() === trimmed.toLowerCase());
  if (match) return { ok: true, answer: match };

  const accepted = info.options.join(" | ");
  const head = info.permission
    ? `This run is waiting on a permission request — ${permissionSentence(info.permission)}`
    : `This run is waiting on a choice${info.question ? `: ${info.question}` : "."}`;
  return {
    ok: false,
    message:
      `${head} The answer must be EXACTLY one of: ${accepted} — not "${trimmed}". ` +
      "The browser treats anything else as deny, so the answer was not sent. Translate the " +
      `user's decision into one of those values and call ${tool("respond")} again.`,
  };
}

export async function startRun(
  bridge: WebMateBridge,
  options: StartRunOptions,
  timeoutMs?: number,
): Promise<CloudSnapshot> {
  if (options.apiMutationsAllowed && options.mode !== "act") {
    throw new BridgeError("API mutation permission requires mode 'act'.", 400);
  }

  const payload: Record<string, unknown> = {
    task: options.task,
    mode: options.mode,
  };
  if (options.runId) payload.runId = options.runId;
  if (options.tabId != null) payload.tabId = options.tabId;
  if (options.apiMutationsAllowed) payload.apiMutationsAllowed = true;
  if (options.outputSchema != null) payload.outputSchema = options.outputSchema;

  return await bridge.request<CloudSnapshot>("cloud_run", payload, timeoutMs);
}

export async function getStatus(
  bridge: WebMateBridge,
  runId?: string,
  timeoutMs?: number,
): Promise<CloudSnapshot | { runs: CloudSnapshot[] }> {
  const payload = runId ? { runId } : {};
  return await bridge.request<CloudSnapshot | { runs: CloudSnapshot[] }>(
    "cloud_status",
    payload,
    timeoutMs,
  );
}

/**
 * Answer a paused run. Reads the run first so an answer that the browser's
 * permission parser would misread as deny is refused here, with the accepted
 * tokens spelled out, instead of silently denying the user's own request.
 */
export async function respond(
  bridge: WebMateBridge,
  runId: string,
  clarifyId: string,
  answer: string,
  timeoutMs?: number,
): Promise<CloudSnapshot> {
  const current = await getStatus(bridge, runId, timeoutMs);
  const snapshot = (current as { runs?: CloudSnapshot[] }).runs ? null : (current as CloudSnapshot);
  let outgoing = String(answer ?? "").trim();
  if (snapshot?.pendingInput) {
    const verdict = validateAnswer(snapshot.pendingInput, answer);
    if (!verdict.ok) throw new BridgeError(verdict.message, 400);
    outgoing = verdict.answer;
  }
  return await bridge.request<CloudSnapshot>(
    "cloud_respond",
    { runId, clarifyId, answer: outgoing },
    timeoutMs,
  );
}

export async function abort(bridge: WebMateBridge, runId: string): Promise<CloudSnapshot> {
  return await bridge.request<CloudSnapshot>("cloud_abort", { runId });
}

/**
 * Poll until the run finishes, needs the user, or we run out of patience.
 *
 * A timeout here does NOT abort the run — the browser keeps working and the
 * caller can resume with the status tool. Silently killing a half-finished
 * task that may have already submitted a form would be worse than reporting
 * that it is still going.
 */
export async function awaitSettled(
  bridge: WebMateBridge,
  runId: string,
  { timeoutMs }: AwaitOptions,
): Promise<{ snapshot: CloudSnapshot; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: CloudSnapshot = { runId, status: "running" };

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    let result: CloudSnapshot | { runs: CloudSnapshot[] };
    try {
      result = await getStatus(bridge, runId, remainingMs);
    } catch (error) {
      if (
        Date.now() >= deadline ||
        (error instanceof BridgeError &&
          (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED"))
      ) {
        return { snapshot: last, timedOut: true };
      }
      throw error;
    }
    const snapshot = (result as { runs?: CloudSnapshot[] }).runs
      ? null
      : (result as CloudSnapshot);

    if (!snapshot) continue;
    last = snapshot;

    if (TERMINAL_STATUSES.has(snapshot.status) || snapshot.status === "needs_user_input") {
      return { snapshot, timedOut: false };
    }

    await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  return { snapshot: last, timedOut: true };
}

/** Render a snapshot as the text a calling agent actually needs to read. */
export function describeSnapshot(snapshot: CloudSnapshot, timedOut = false): string {
  const lines: string[] = [];
  lines.push(`run_id: ${snapshot.runId}`);
  lines.push(`status: ${snapshot.status}${timedOut ? ` (still running — poll ${tool("status")})` : ""}`);
  if (snapshot.mode) lines.push(`mode: ${snapshot.mode}`);
  if (snapshot.finalUrl) lines.push(`final_url: ${snapshot.finalUrl}`);

  if (snapshot.status === "needs_user_input" && snapshot.pendingInput) {
    const info = describePendingInput(snapshot.pendingInput);
    const question = info?.question || "(no question text supplied)";
    lines.push("");
    if (info?.permission) {
      const host = info.permission.host || "this site";
      lines.push(`PERMISSION REQUEST — ${permissionSentence(info.permission)}`);
      lines.push(
        `Reply with ${tool("respond")}(run_id, clarify_id, answer) where answer is EXACTLY one of: ` +
          `${info.options.length ? info.options.join(" | ") : "once | always | deny"}.`,
      );
      lines.push(`once = allow this time only · always = remember for ${host} · deny = refuse.`);
      lines.push(
        "The browser treats any other text (yes, ok, có, sure…) as deny — ask the user, then " +
          "translate their decision into one of these tokens. Never forward their words verbatim.",
      );
    } else {
      lines.push(`${BRAND.productName} is waiting on a human decision before it continues.`);
      lines.push(`question: ${question}`);
      if (info?.options.length) {
        lines.push(`accepted answers (send one of these exactly): ${info.options.join(" | ")}`);
      }
    }
    lines.push(`clarify_id: ${info?.clarifyId || ""}`);
    lines.push(
      `Relay this to the user and send their answer with ${tool("respond")}. ` +
        "Do not invent an answer on their behalf.",
    );
  }

  if (snapshot.error) {
    lines.push("");
    lines.push(`error: ${snapshot.error}`);
  }

  const body =
    snapshot.result !== undefined && snapshot.result !== null
      ? typeof snapshot.result === "string"
        ? snapshot.result
        : JSON.stringify(snapshot.result, null, 2)
      : snapshot.content || snapshot.summary || "";

  if (body) {
    lines.push("");
    lines.push("--- result ---");
    lines.push(body);
  }

  return lines.join("\n");
}
