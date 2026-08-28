#!/usr/bin/env node
/**
 * Branded MCP server for the browser extension (AgentX WebMate, netMind, …).
 *
 * Gives AgentX Workmate — or any other MCP client (Claude Code, Codex, Cursor)
 * — the ability to delegate a browser task to the user's REAL browser session:
 * already logged in, cookies present, MFA already passed. That session is the
 * thing a headless automation framework cannot reproduce, and it is the only
 * reason this server is interesting.
 *
 * Scope is deliberately coarse. We expose task delegation, not the ~50
 * low-level browser primitives, because:
 *   1. the permission gate lives in the extension's agent loop, not in
 *      `executeTool()`, so per-primitive access would bypass every safety
 *      property the extension advertises; and
 *   2. driving 50 primitives over a socket costs a round trip and a pile of
 *      tokens per click. Delegation is both safer and cheaper.
 *
 * Every user-visible name comes from brand/brand.config.json via
 * src/brand.generated.ts (see scripts/brand.mjs), so a brand branch differs in
 * config only. stdout belongs to the MCP stdio transport; logging goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { BRAND, tool } from "./brand.generated.js";
import {
  BridgeError,
  PortInUseError,
  WebMateBridge,
  connectInstructions,
  describePortConflict,
  type CloudSnapshot,
} from "./bridge.js";
import { bridgeUrl, config } from "./config.js";
import {
  PERMISSION_MODES,
  abort,
  awaitSettled,
  describeSnapshot,
  getStatus,
  respond,
  startRun,
} from "./runs.js";

export const SERVER_NAME = BRAND.serverName;
export const SERVER_VERSION = "1.0.0";

const PRODUCT = BRAND.productName;
const T = {
  run: tool("run"),
  extract: tool("extract"),
  status: tool("status"),
  respond: tool("respond"),
  abort: tool("abort"),
  connection: tool("connection"),
};

const bridge = new WebMateBridge();

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    instructions:
      `These tools run inside the user's own signed-in browser through the ${BRAND.extensionName}. ` +
      "Use them for pages that need the user's login (SSO dashboards, webmail, " +
      `admin panels, internal tools). Prefer mode='ask' (read-only) and ${T.extract} for ` +
      "structured data; use mode='act' whenever the task opens a site, navigates, clicks, types " +
      `or submits. If a tool reports that no extension is connected, call ${T.connection} and ` +
      "relay its instructions to the user instead of retrying. Runs default to " +
      "permission_mode='bypass' and do not stop for permission cards; pass a narrower " +
      "permission_mode when the user wants to approve actions in the browser themselves. " +
      `When a run stops at 'needs_user_input', ask the user and answer with ${T.respond} — ` +
      "never guess. That pause is the task's own question in every mode. Under a narrower " +
      "permission_mode it can also be a permission request, which lists its accepted answers " +
      "(once | always | deny); send one of those exactly, translating the user's words — the " +
      "browser treats anything else as deny.",
  },
);

/**
 * How much authority ONE delegated run carries, as a tool parameter.
 *
 * Defaults to `bypass` — the rung that runs a whole task without stopping —
 * because of who sits on the other end of this socket. A permission card raised
 * by a run started here is answered through the respond tool, which is to say
 * by the caller: the same agent that requested the action decides whether to
 * allow it. A narrower default does not put a human in that loop. It spends a
 * round trip per action to reach the same answer, and it pushes callers toward
 * replying `always`, which writes a PERSISTENT grant for that host into the
 * user's browser for a decision they never made.
 *
 * What the default costs is real and belongs in writing: under `bypass` a run
 * may download, upload, issue write requests and schedule work on any host, in
 * a browser where the user is already signed in everywhere, with nothing shown
 * before it happens. A task assembled from page content therefore reaches
 * further than it does in any other mode. Pass a narrower mode whenever a human
 * is actually watching the side panel and wants to approve actions themselves.
 *
 * Two things no mode changes: the run stays visible and abortable in the panel,
 * and a page's own WebMCP callback keeps its mandatory confirmation.
 */
const permissionModeParam = z
  .enum(PERMISSION_MODES)
  .default("bypass")
  .describe(
    "Authority for this run. 'bypass' (default) runs the task through without permission " +
      "cards. 'page_actions' still asks before downloads, uploads, network writes and " +
      "scheduled work; 'auto' also asks before running JavaScript and before form submits; " +
      "'manual' asks before every consequential action. Narrow it when a human is watching " +
      "the browser and wants to approve actions themselves.",
  );

type TextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (text: string): TextResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): TextResult => ({ content: [{ type: "text", text }], isError: true });

function toolError(error: unknown): TextResult {
  if (error instanceof BridgeError) return fail(error.message);
  return fail(error instanceof Error ? error.message : String(error));
}

server.registerTool(
  T.run,
  {
    title: "Run a browser task in the user's real session",
    description:
      `Delegate a web task to ${PRODUCT} running in the user's actual browser — already ` +
      "signed in, with existing cookies and sessions. Use this when a task needs a page " +
      "the caller cannot reach: an authenticated dashboard, a webmail account, an admin " +
      "panel, a SaaS report behind SSO. Describe the goal in plain language, the way you " +
      "would to a colleague sharing the screen.\n\n" +
      "mode='ask' is read-only: it reads, extracts and summarises the page that is already " +
      "open, and cannot navigate, click, type or submit. Use mode='act' whenever the task " +
      "involves going somewhere or doing something — opening a site, searching on it, " +
      "playing, clicking, typing, submitting. Use 'ask' only when nothing but reading is " +
      "needed.\n\n" +
      "How far the run may go is permission_mode, which is separate from 'ask'/'act' and " +
      "defaults to 'bypass': the task runs through without permission cards. Narrow it when " +
      "the user wants to approve actions in the browser themselves.\n\n" +
      "If the run stops with status 'needs_user_input', relay the question to the user and " +
      `answer with ${T.respond} — never guess on their behalf. Under a narrower ` +
      "permission_mode the pause can be a permission request, which lists its accepted " +
      "answers (once | always | deny); send one of those exactly.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "The goal, in plain language. e.g. 'open the Stripe dashboard and list last " +
            "week's failed payments with amounts and customer emails'.",
        ),
      mode: z
        .enum(["ask", "act"])
        .default("ask")
        .describe(
          "'ask' is read-only: it reads the page that is already open and cannot navigate, " +
            "click, type or submit. 'act' permits navigation, clicking and typing. Default " +
            "'ask'. This chooses what the run MAY do; permission_mode chooses whether it has " +
            "to ask first.",
        ),
      tab_id: z
        .number()
        .int()
        .optional()
        .describe(
          "Target a specific browser tab. Omit to use the active tab, which is almost " +
            "always what you want.",
        ),
      allow_api_mutations: z
        .boolean()
        .default(false)
        .describe(
          `Lift ${PRODUCT}'s UI-first rule so the agent may issue mutating HTTP requests ` +
            "directly instead of clicking through the interface. Off by default and rarely " +
            "correct — the UI path is visible and stoppable. Only valid when mode is 'act'.",
        ),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(3600)
        .optional()
        .describe(
          "How long to wait before returning control. The run keeps going in the browser " +
            `past this point; poll ${T.status} to pick it back up.`,
        ),
      permission_mode: permissionModeParam,
      wait: z
        .boolean()
        .default(true)
        .describe(
          "Wait for the run to settle. Set false to start it and return the run_id " +
            "immediately.",
        ),
    },
  },
  async ({
    task,
    mode,
    tab_id,
    allow_api_mutations,
    permission_mode,
    timeout_seconds,
    wait,
  }): Promise<TextResult> => {
    const timeoutMs = timeout_seconds ? timeout_seconds * 1000 : config.defaultRunTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const runId = `mcp_${randomUUID()}`;
    try {
      let started: CloudSnapshot;
      try {
        started = await startRun(
          bridge,
          {
            runId,
            task,
            mode,
            tabId: tab_id,
            apiMutationsAllowed: allow_api_mutations,
            permissionMode: permission_mode,
          },
          Math.max(1, deadline - Date.now()),
        );
      } catch (error) {
        if (
          error instanceof BridgeError &&
          (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED")
        ) {
          return ok(describeSnapshot({ runId, status: "running" }, true));
        }
        throw error;
      }

      if (!wait) {
        return ok(
          `Started in the background.\n${describeSnapshot(started)}\n\n` +
            `Poll ${T.status} with this run_id for progress.`,
        );
      }

      const { snapshot, timedOut } = await awaitSettled(bridge, started.runId, {
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      return ok(describeSnapshot(snapshot, timedOut));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  T.extract,
  {
    title: "Extract structured data from the user's real browser",
    description:
      "Read a page in the user's actual signed-in browser and return data that matches a " +
      `caller-supplied JSON Schema. This tool always uses ${PRODUCT} Ask mode, so it ` +
      "cannot click, type, navigate or submit. Use it for authenticated reports, tables, " +
      "account details and other page data that should come back as predictable JSON rather " +
      `than a prose summary. Use ${T.run} instead when the task needs interaction.\n\n` +
      "If the run stops with status 'needs_user_input', relay the question to the user and " +
      `answer with ${T.respond} — never guess on their behalf. If it lists accepted ` +
      "answers, send one of those exactly.\n\n" +
      "permission_mode defaults to 'bypass' here too. Ask mode already cannot navigate, " +
      "click, type or submit, so it changes little; it is accepted so a read that does trip " +
      "a gate does not stall waiting for an answer.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "What to extract and any scope or filtering rules. Be explicit about the page, " +
            "time range, rows and fields the result should cover.",
        ),
      output_schema: z
        .record(z.unknown())
        .describe(
          "A JSON Schema object describing the exact result. Prefer an object root with " +
            "properties and required fields so the caller can rely on the returned shape.",
        ),
      tab_id: z
        .number()
        .int()
        .optional()
        .describe("Target a specific browser tab. Omit to use the active tab."),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(3600)
        .optional()
        .describe(
          "How long to wait before returning control. The extraction keeps running past " +
            `this point; poll ${T.status} with its run_id.`,
        ),
      permission_mode: permissionModeParam,
      wait: z
        .boolean()
        .default(true)
        .describe(
          "Wait for the extraction to settle. Set false to start it and return the run_id " +
            "immediately.",
        ),
    },
  },
  async ({
    task,
    output_schema,
    tab_id,
    permission_mode,
    timeout_seconds,
    wait,
  }): Promise<TextResult> => {
    const timeoutMs = timeout_seconds ? timeout_seconds * 1000 : config.defaultRunTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const runId = `mcp_${randomUUID()}`;
    try {
      let started: CloudSnapshot;
      try {
        started = await startRun(
          bridge,
          {
            runId,
            task,
            mode: "ask",
            tabId: tab_id,
            outputSchema: output_schema,
            permissionMode: permission_mode,
          },
          Math.max(1, deadline - Date.now()),
        );
      } catch (error) {
        if (
          error instanceof BridgeError &&
          (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED")
        ) {
          return ok(describeSnapshot({ runId, status: "running" }, true));
        }
        throw error;
      }

      if (!wait) {
        return ok(
          `Structured extraction started in the background.\n${describeSnapshot(started)}\n\n` +
            `Poll ${T.status} with this run_id for progress.`,
        );
      }

      const { snapshot, timedOut } = await awaitSettled(bridge, started.runId, {
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      return ok(describeSnapshot(snapshot, timedOut));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  T.status,
  {
    title: "Check a browser run",
    description:
      `Fetch the current state of a browser run in ${PRODUCT}, including its result once finished. ` +
      "Omit run_id to list every run this browser knows about.",
    inputSchema: {
      run_id: z
        .string()
        .optional()
        .describe("The run to inspect. Omit to list all runs."),
    },
  },
  async ({ run_id }): Promise<TextResult> => {
    try {
      const result = await getStatus(bridge, run_id);
      const runs = (result as { runs?: CloudSnapshot[] }).runs;
      if (runs) {
        if (!runs.length) return ok(`No ${PRODUCT} runs on record.`);
        return ok(
          runs
            .map((run) => `${run.runId}  ${run.status.padEnd(16)}  ${run.task ?? ""}`)
            .join("\n"),
        );
      }
      return ok(describeSnapshot(result as CloudSnapshot));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  T.respond,
  {
    title: "Answer a question from a browser run",
    description:
      "Supply the user's answer to a run sitting at status 'needs_user_input', then keep " +
      `waiting for it to settle. The answer must come from the user — ${PRODUCT} pauses ` +
      "precisely because a human decision is required.\n\n" +
      "Permission requests accept EXACTLY once, always or deny (the status text shows which " +
      "is pending). Translate the user's decision into one of those tokens; free text such " +
      "as 'yes' is rejected here because the browser would treat it as deny.",
    inputSchema: {
      run_id: z.string().describe("The run that is waiting."),
      clarify_id: z.string().describe("The clarify_id reported alongside the question."),
      answer: z
        .string()
        .min(1)
        .describe(
          "The user's answer. Free-text questions: pass their words through verbatim. " +
            "Permission requests: exactly 'once', 'always' or 'deny'.",
        ),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(3600)
        .optional()
        .describe("How long to wait after answering before returning control."),
    },
  },
  async ({ run_id, clarify_id, answer, timeout_seconds }): Promise<TextResult> => {
    const timeoutMs = timeout_seconds ? timeout_seconds * 1000 : config.defaultRunTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    try {
      try {
        await respond(
          bridge,
          run_id,
          clarify_id,
          answer,
          Math.max(1, deadline - Date.now()),
        );
      } catch (error) {
        if (
          error instanceof BridgeError &&
          (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED")
        ) {
          return ok(describeSnapshot({ runId: run_id, status: "running" }, true));
        }
        throw error;
      }
      const { snapshot, timedOut } = await awaitSettled(bridge, run_id, {
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      return ok(describeSnapshot(snapshot, timedOut));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  T.abort,
  {
    title: "Stop a browser run",
    description:
      "Halt a run that is going wrong or is no longer needed. Note that actions already " +
      "taken in the browser are not undone.",
    inputSchema: {
      run_id: z.string().describe("The run to stop."),
    },
  },
  async ({ run_id }): Promise<TextResult> => {
    try {
      const snapshot = await abort(bridge, run_id);
      return ok(describeSnapshot(snapshot));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  T.connection,
  {
    title: `Check the ${PRODUCT} browser connection`,
    description:
      `Report whether the ${BRAND.extensionName} is currently attached. Call this first ` +
      "when a browser tool fails, so you can tell the user what to fix instead of retrying " +
      "blindly.",
    inputSchema: {},
  },
  async (): Promise<TextResult> => {
    // A bridge that never opened its listener has a specific, actionable
    // answer. Report it before the generic "check your browser settings"
    // text below, which would send the user to settings that are already fine.
    const unavailable = bridge.unavailable();
    if (unavailable) return fail(unavailable);

    // Same grace the command path uses, so this diagnostic never reports
    // "not connected" for a browser that is one backoff tick from attaching.
    if (!bridge.isConnected() && config.connectProbeMs > 0) {
      await bridge.waitForExtension(config.connectProbeMs);
    }
    if (bridge.isConnected()) {
      const caps = bridge.capabilities();
      return ok(
        `Connected. Listening on ${bridgeUrl()}.` +
          (caps.length ? `\nExtension capabilities: ${caps.join(", ")}` : ""),
      );
    }
    return ok(
      `Not connected. Listening on ${bridgeUrl()}, but no extension has dialled in.\n\n` +
        `To connect: open a Chromium browser (Chrome, Edge, Brave) with the ${BRAND.extensionName} ` +
        `installed. ${connectInstructions()}\n` +
        "The extension holds one bridge socket at a time, so this cannot run at the same " +
        "time as the Cloud bridge on port 17373 or the LM Studio plugin on 17375.\n\n" +
        "Firefox cannot host the bridge — that build has no offscreen document. If the " +
        "user is on Firefox, say so rather than suggesting settings changes.",
    );
  },
);

async function main(): Promise<void> {
  try {
    await bridge.start();

    // Give an already-open extension a bounded chance to reconnect before the
    // stdio server advertises browser tools. If this promise is discarded, the
    // grace period is illusory and the first tool call can race the reconnect.
    await bridge.waitForExtension(3_000);
  } catch (error) {
    // A taken port must NOT be fatal. Exiting here kills all six tools, so the
    // MCP host only sees "server failed" and the agent has no way to explain
    // anything — which is precisely how a leftover server from a previous
    // session turns into a silent loss of browser tools. Serve stdio anyway
    // and let every tool answer with the reason.
    if (!(error instanceof PortInUseError)) throw error;
    const reason = await describePortConflict(error.port);
    bridge.markUnavailable(reason);
    console.error(`[${SERVER_NAME}-mcp] ${reason.split("\n")[0]}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}-mcp] ready on stdio`);
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await bridge.stop().catch((error) => {
    console.error(`[${SERVER_NAME}-mcp] shutdown error:`, error);
  });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// MCP hosts commonly stop stdio servers by closing the child's stdin rather
// than sending a signal. Without these handlers the WebSocket listener keeps
// the event loop alive and leaves port 17374 occupied by an orphan process.
process.stdin.once("end", () => void shutdown());
process.stdin.once("close", () => void shutdown());

main().catch((error) => {
  console.error(`[${SERVER_NAME}-mcp] fatal:`, error);
  process.exit(1);
});
