---
name: {{skillName}}
description: "Delegate browser tasks to the signed-in {{productName}}."
version: 1.1.0
author: AstralX Technology
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Browser, {{shortName}}, MCP, Delegation, Signed-In-Session, SSO, Webmail, Dashboards]
    related_skills: [agentx-agent, computer-use]
---

# {{productName}} Skill

{{productName}} is the AgentX browser extension: an agent that lives in the side
panel of the user's own Chrome, already signed in to every site the user uses.
This skill delegates whole browser tasks to it over MCP — opening a video,
reading an SSO dashboard, pulling rows out of webmail, filling a form on an
internal tool — and brings the result back into the conversation. It does not
drive the page click by click; {{shortName}}'s own agent loop, site adapters and
per-host permission gate do that.

This package is self-contained: `scripts/{{bundleFile}}` is the MCP
server itself (one file, needs only Node.js), and `scripts/setup.py` registers
it with AgentX Workmate. No catalog entry or AgentX source change is required.

## When to Use

- The page needs the **user's login**: SaaS dashboards behind SSO, webmail,
  admin panels, banking, internal tools, anything with cookies or MFA already
  passed in their browser.
- The user says "in my browser", "the tab I have open", "my account", "open
  YouTube / Gmail / …", or names a site they are logged into.
- You need **structured data** from an authenticated page
  (`{{hostTool:extract}}` with a JSON Schema).

Do **not** use it when:

- The page is public and only needs reading → `web_extract` / `web_search`, or
  the headless `browser_navigate` family (AgentX's own Chromium, not the user's).
- The task is pure HTTP (an API with a key the user gave you) → `terminal`.
- The user is on Firefox — the bridge is Chromium-only.

## Prerequisites

1. **Node.js ≥ 20 on `PATH`** (AgentX Workmate already needs Node for its own
   browser tools).
2. **Install this skill** into the active profile so the path is
   `$AGENTX_HOME/skills/autonomous-ai-agents/{{skillName}}/SKILL.md` (unzip the
   package into `$AGENTX_HOME/skills/autonomous-ai-agents/`), or into any
   directory listed under `skills.external_dirs` in `config.yaml`.
3. **Register the bundled server** (idempotent; re-run after moving the skill):
   ```bash
   python3 "${AGENTX_HOME:-$HOME/.agentx}/skills/autonomous-ai-agents/{{skillName}}/scripts/setup.py"
   ```
   It writes `mcp_servers.{{skillName}}` → `node …/scripts/{{bundleFile}}`
   into the profile's `config.yaml` (use `--home` for another profile, e.g. an
   account home under `~/.agentx/accounts/<slug>`; `--dry-run` to preview).
   Then start a new session or `/reload-mcp`. If your AgentX build ships the
   `{{skillName}}` catalog entry, `agentx mcp install official/{{skillName}}` is an
   equivalent alternative.
4. **Extension attached.** In a Chromium browser with {{productName}} installed:
   **Settings → General → Advanced → Cloud bridge**, URL
   `ws://127.0.0.1:17374/extension`, toggle on. The status line shows
   **Connected** while an AgentX session (which hosts the MCP server) is running.
5. **Same machine.** The bridge is loopback-only on both ends. If AgentX runs on
   a VPS, forward the port from the laptop: `ssh -L 17374:127.0.0.1:17374 <vps>`.
6. **{{shortName}} has its own model.** {{shortName}} runs its own LLM loop (AgentX Cloud
   after signing in, or any provider configured in its Settings). AgentX's model
   choice does not apply to the browser side.
7. Only **one bridge at a time**: 17373 ({{shortName}} Cloud), 17374 (this MCP
   server), 17375 (LM Studio plugin).

## How to Run

Tools appear as `mcp__{{skillName}}__<tool>`:

```
{{hostTool:connection}}()
{{hostTool:run}}(task="open youtube.com, search for 'Anh Nhớ Ra Rằng Vũ' and play the official video", mode="act")
{{hostTool:run}}(task="summarise the thread that is open in Gmail", mode="ask")
{{hostTool:extract}}(task="list overdue invoices on this page", output_schema={"type":"object","properties":{"invoices":{"type":"array","items":{"type":"object","properties":{"customer":{"type":"string"},"amount":{"type":"number"},"due_date":{"type":"string"}},"required":["customer","amount","due_date"]}}},"required":["invoices"]})
{{hostTool:status}}(run_id="mcp_…")
{{hostTool:respond}}(run_id="mcp_…", clarify_id="perm_…", answer="once")
{{hostTool:abort}}(run_id="mcp_…")
```

Health check without a chat session:

```bash
python3 "${AGENTX_HOME:-$HOME/.agentx}/skills/autonomous-ai-agents/{{skillName}}/scripts/check_bridge.py"
```

## Quick Reference

| Tool | Use it for | Key arguments | Returns |
|---|---|---|---|
| `{{tool:connection}}` | Is the extension attached? Call first after any failure. | — | `Connected…` or fix-it instructions |
| `{{tool:run}}` | Any browser task | `task`, `mode` (`ask` read-only / `act` navigate+interact), `timeout_seconds`, `wait`, `tab_id`, `allow_api_mutations` | `run_id`, `status`, `final_url`, result text |
| `{{tool:extract}}` | Predictable JSON from an authenticated page (always Ask mode) | `task`, `output_schema`, `timeout_seconds` | JSON matching the schema |
| `{{tool:status}}` | Poll a run that outlived its timeout; list runs | `run_id` (omit to list) | snapshot |
| `{{tool:respond}}` | Answer a `needs_user_input` pause | `run_id`, `clarify_id`, `answer` — permission requests: exactly `once` / `always` / `deny` | snapshot after resuming |
| `{{tool:abort}}` | Stop a run (completed actions are not undone) | `run_id` | final snapshot |

Statuses: `running`, `needs_user_input`, `completed`, `failed`, `aborted`.

## Procedure

1. **Check the connection once per session.** Call `{{tool:connection}}`. If it
   says *Not connected*, relay its instructions to the user verbatim (open
   Chrome, enable the Cloud bridge on port 17374) and stop. Do not retry the
   task in a loop.
2. **Pick the mode from the verb in the task.** `mode="ask"` reads, extracts
   and summarises the page that is already open; it cannot navigate, click,
   type or submit. Use `mode="act"` the moment the task opens a site, searches
   on it, plays something, clicks, types or submits — "open YouTube" is an
   Act task. Starting such a task in Ask mode only wastes a round trip.
3. **Write the task like a brief to a colleague.** Name the site, the account if
   several exist, the time range, the fields you want back, and the success
   criterion. {{shortName}} cannot see this conversation; everything it needs must be
   in `task`.
4. **Prefer `{{tool:extract}}` for data.** Give an object-root JSON Schema with
   `required` fields so the result is predictable. Use `{{tool:run}}` when the
   task needs interaction or a prose answer.
5. **Handle the result by status.**
   - `completed` — read `--- result ---`; report `final_url` when useful.
   - `needs_user_input`, **permission request** — the text starts with
     `PERMISSION REQUEST — {{productName}} wants to navigate to youtube.com` and
     lists `accepted answers: once | always | deny`. Ask the user (with `clarify`
     offering those three choices, or plain text), then call `{{tool:respond}}`
     with **exactly one token**: "có / ừ / ok / đồng ý / yes / cho phép" →
     `once`; "luôn luôn / always allow / remember" → `always`; "không / no /
     từ chối" → `deny`. Never forward the user's words verbatim — the browser
     treats anything else as deny, and the server rejects it.
   - `needs_user_input`, **question** (e.g. "Which account should I use?") —
     put the question to the user and pass their answer through verbatim. If
     the text lists `accepted answers`, send one of those exactly.
   - `running (still running — poll {{tool:status}})` — the timeout elapsed but
     the browser is still working. Poll `{{tool:status}}` with the `run_id`;
     raise `timeout_seconds` (up to 3600) on long tasks instead of re-running.
   - `failed` — read `error`. "denied" means the permission was refused (by the
     user, or by a wrong token); ask before retrying. A missing-page error
     usually means the wrong tab or account; refine `task` rather than
     switching modes blindly.
6. **Stop cleanly.** If the user changes their mind, call `{{tool:abort}}` with
   the `run_id`. Say plainly that actions already taken stay taken.
7. **Report.** Summarise what {{shortName}} did and where it ended (`final_url`).
   Quote extracted data; do not paraphrase numbers.

## Pitfalls

- **Two browsers.** `browser_*` tools drive AgentX's headless Chromium;
  {{shortName}} drives the user's real Chrome. Do not mix them in one task — state
  in the headless browser is invisible to {{shortName}} and vice versa.
- **Permission answers are tokens, not prose.** `once` / `always` / `deny`
  only. `always` persists a grant for that host in the user's browser — use it
  only when the user explicitly asks to stop being prompted for that site.
  If the {{shortName}} side panel is open on the tab, the same request is shown
  there too and the user may click it directly; either path resolves the run.
- **One run per tab.** "Tab N already has an active run" means a run is still
  going — `{{tool:status}}` it, `{{tool:respond}}` to it, or `{{tool:abort}}` it.
- **Timeouts do not abort.** A `{{tool:run}}` that returns *still running* has
  not been cancelled; do not start a duplicate.
- **Do not put secrets in `task`.** {{shortName}} runs in a session that is already
  authenticated; if it truly needs a credential it will pause with
  `needs_user_input` and the user types it in the browser.
- **`allow_api_mutations` is almost never right.** It lets {{shortName}} issue
  mutating HTTP calls instead of clicking through the visible UI. Leave it off
  unless the user explicitly asks for it.
- **Firefox cannot host the bridge**; say so instead of suggesting settings.
- **The server lives only while a session is running.** The MCP host starts
  it on demand, so the extension shows *Reconnecting…* between sessions. That
  is normal.
- **Moved the skill folder?** Re-run `scripts/setup.py` — the config entry
  holds the absolute path of the bundled server.

## Verification

```bash
python3 "${AGENTX_HOME:-$HOME/.agentx}/skills/autonomous-ai-agents/{{skillName}}/scripts/check_bridge.py"
```

Expected: `config OK`, `server build OK`, `node OK`, and `bridge port …
listening` while a session is open (or *not listening* between sessions,
which the script explains). Then, in a session:

1. `{{hostTool:connection}}()` → `Connected. Listening on
   ws://127.0.0.1:17374/extension.`
2. `{{hostTool:run}}(task="read the title and first paragraph of the
   active tab", mode="ask")` → `status: completed` with the page text.
3. `{{hostTool:run}}(task="open youtube.com and read the first video
   title", mode="act")` → `PERMISSION REQUEST … navigate to youtube.com` →
   `{{hostTool:respond}}(…, answer="once")` → `status: completed`.

`agentx mcp test {{skillName}}` spawns the server and lists its six tools without
opening a chat session.
