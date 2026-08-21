# AgentX WebMate MCP Server

Give [AgentX Workmate](https://github.com/TrungKiencding/AgentX-Workmate) — or any other MCP client (Claude Code, Codex, Cursor) — the ability to run tasks in **your real browser session**: already signed in, cookies present, MFA already passed.

That session is the whole point. A headless automation framework starts logged out of everything and hits a login wall on the first useful page. AgentX WebMate is already inside the browser you use.

```
AgentX Workmate ──stdio──▶ agentx-webmate-mcp ──ws://127.0.0.1:17374──▶ AgentX WebMate extension ──▶ your tabs
```

## Install

### AgentX Workmate (recommended)

The server ships in Workmate's MCP catalog:

```bash
agentx mcp install official/webmate
```

This clones the WebMate repository into `~/.agentx/mcp-installs/webmate`, builds
`mcp-server/`, and writes an `mcp_servers.webmate` block into
`~/.agentx/config.yaml`. Start a new session (or run `/reload-mcp`) and the six
tools appear as `mcp__webmate__webmate_run`, `mcp__webmate__webmate_extract`, and
so on. The bundled `webmate` skill teaches the agent when to reach for them
instead of its own headless `browser_*` tools.

### From a checkout (development)

```bash
cd mcp-server && npm ci && npm run build
agentx mcp add webmate --command node --args "$PWD/dist/index.js"
```

### Other MCP clients

**Claude Code**

```bash
claude mcp add --transport stdio webmate -- node /path/to/agentx-webmate/mcp-server/dist/index.js
```

**Codex / Cursor / anything reading `mcp.json`**

```json
{
  "mcpServers": {
    "webmate": {
      "command": "node",
      "args": ["/path/to/agentx-webmate/mcp-server/dist/index.js"]
    }
  }
}
```

The MCP client launches this command as a child process when it starts the
configured server; you do not need to keep a second copy running in a terminal.
After adding the configuration, restart or reconnect the MCP client if the
WebMate tools do not appear in its tool list.

## Connect the browser

> **Chromium only.** Chrome, Edge, Brave, Opera, Vivaldi. The bridge runs from the extension's **offscreen document**, and the Firefox build has none — `cloud-bridge.js` and `cloud-runs.js` live only under `src/chrome/`. See [`src/firefox/ARCHITECTURE.md`](../src/firefox/ARCHITECTURE.md).

The MCP server hosts the listener; the extension dials out to it. A Manifest V3 extension cannot listen on a socket, so the direction is fixed.

1. Install the AgentX WebMate extension (load `brand-dist/chrome` from a checkout, or the store build) and open your browser.
2. In **AgentX WebMate → Settings → General → Advanced → Cloud bridge**, set the URL to `ws://127.0.0.1:17374/extension` and enable it. The status line reads **Connected** once the MCP server is running.
3. Ask your MCP client to call `webmate_connection` to confirm.

> **One bridge at a time.** The extension holds exactly one outbound bridge socket. Pointing it here means it is *not* pointed at the WebMate Cloud sidecar (`17373`) or the LM Studio plugin (`17375`). Switch it under **Settings → General → Advanced → Cloud bridge**.

## Launch manually

For a direct launch or connection test, run:

```bash
node mcp-server/dist/index.js
```

Leave that terminal open while using the bridge. The server owns the local
listener on `127.0.0.1:17374`, and exiting it closes the bridge. Press `Ctrl+C`
to stop it. (`npm start` inside `mcp-server/` does the same thing.)

## Troubleshooting

**Connection error: WebSocket error** normally means that no process is
listening at the URL selected in WebMate. Confirm the MCP server is still
running and that Settings uses port `17374`, then check the listener:

```bash
lsof -nP -iTCP:17374 -sTCP:LISTEN
```

No output means the MCP server is not listening. Remember that an MCP host only
starts the server for the duration of a session: with Workmate, the listener
exists while a Workmate session (CLI, TUI, gateway) is running. If it is
listening but the extension does not connect, make sure another bridge
destination is not selected: WebMate Cloud uses `17373`, this MCP server uses
`17374`, and the LM Studio plugin uses `17375`. Only one can be selected at a
time. The bridge is available in Chromium browsers only, not Firefox.

Inside Workmate, `agentx mcp test webmate` spawns the server and lists its tools
without starting a chat session.

## Tools

| Tool | Purpose |
|---|---|
| `webmate_run` | Delegate a task. `mode='ask'` is read-only; `mode='act'` can click and type, gated by in-browser approval. |
| `webmate_extract` | Read authenticated page data into a caller-supplied JSON Schema. Always runs in read-only Ask mode. |
| `webmate_status` | Poll a run, or list every run. |
| `webmate_respond` | Answer a run sitting at `needs_user_input`. |
| `webmate_abort` | Stop a run. Actions already taken are not undone. |
| `webmate_connection` | Report whether the extension is attached, and how to fix it if not. |

Hosts namespace these by server: in Workmate and Claude Code they appear as
`mcp__webmate__webmate_run` and friends.

### Example

> "Open my Stripe dashboard and list last week's failed payments."

```
webmate_run(task: "open the Stripe dashboard and list last week's failed
            payments with amounts and customer emails", mode: "ask")
```

Read-only, in the tab you are already authenticated in. No API key, no headless login dance.

For predictable JSON instead of prose, give `webmate_extract` an explicit
JSON Schema:

```
webmate_extract(
  task: "list the overdue invoices visible in this account",
  output_schema: {
    type: "object",
    properties: {
      invoices: {
        type: "array",
        items: {
          type: "object",
          properties: {
            customer: { type: "string" },
            amount: { type: "number" },
            due_date: { type: "string" }
          },
          required: ["customer", "amount", "due_date"]
        }
      }
    },
    required: ["invoices"]
  }
)
```

This is still a task-level delegation through the browser agent and its normal
permission boundary; it is not a direct page-scraping primitive.

## Why six task-level tools and not 50 browser primitives

AgentX WebMate exposes roughly fifty primitives internally — `click_ax`, `type_ax`, `extract_data`, `iframe_read` and so on. This server deliberately does **not** surface them.

**Safety.** The capability × origin permission gate runs in the agent loop (`_executeToolBatch`), not inside `executeTool()`. An MCP layer calling primitives directly would sit *below* the gate and bypass every approval prompt the product is built on. Delegating a goal keeps the trust boundary in the browser, where the human is.

**Cost.** Driving a UI one primitive at a time over a socket costs a round trip and a slab of tokens per click. Handing over a goal costs one call.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WEBMATE_BRIDGE_PORT` | `17374` | Port the extension connects to. |
| `WEBMATE_BRIDGE_PATH` | `/extension` | Path segment; must match the URL in Settings. |
| `WEBMATE_COMMAND_TIMEOUT_MS` | `30000` | Per-command reply timeout. |
| `WEBMATE_RUN_TIMEOUT_MS` | `300000` | Default ceiling for `webmate_run` polling. |
| `WEBMATE_POLL_INTERVAL_MS` | `1000` | Status poll interval. |

Each variable also accepts the upstream `WEBBRAIN_*` spelling; when both are
set, `WEBMATE_*` wins.

## Security notes

- The listener binds `127.0.0.1` only. Anything that can reach this port can drive your signed-in browser — never expose it to a network or a container bridge.
- Connections from HTTP(S) pages and other non-extension browser origins are rejected before they can replace the extension socket. Accepted connections must also present the extension's `hello` frame with `client: "webbrain-extension"` (the wire identifier inherited from upstream; the brand build keeps protocol tokens unchanged); anything else is closed. This is **not** authentication. The shipping extension sends no shared secret, so a local process could impersonate it. Treat the port as trusted-local, and see [`docs/security-model.md`](../docs/security-model.md).
- A `webmate_run` timeout does **not** abort the run. A task that already submitted a form should not be silently killed — the browser keeps going and `webmate_status` picks it back up.
- `allow_api_mutations` lifts the UI-first rule and is off by default. It is accepted only with `mode: "act"`; Ask runs remain read-only. The UI path is visible and stoppable; direct API mutations are neither.
- Approval prompts for consequential Act-mode actions are shown in the browser side panel, not relayed over MCP. Only clarification questions (`needs_user_input`) round-trip through `webmate_status` / `webmate_respond`. If you drive the browser from another device, pre-approve the hosts you expect the agent to touch or keep the browser within reach.

## Tests

```bash
npm test
```

The suite stands up the real listener and connects a fake extension speaking the exact frames `src/chrome/src/offscreen/cloud-bridge.js` emits — handshake, id correlation under concurrency, error propagation, disconnect mid-command, and the poll/timeout/clarify paths — then spawns the built server over stdio and checks the advertised catalog. If the extension's wire format changes, these fail. That is intentional.

## License

MIT. This package is part of AgentX WebMate, a branded build of
[WebBrain](https://github.com/webbrain-one/webbrain) (MIT).
