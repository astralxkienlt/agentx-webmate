---
name: {{skillName}}
description: Delegate browser tasks to the signed-in {{productName}} — read, extract or act on pages in the user's own Chrome through the `{{skillName}}` MCP server. Use when a task needs a page behind the user's login (SSO dashboards, webmail, admin panels, internal tools), or when the user says "in my browser", "my account", or "open a site for me".
---

# {{productName}} — browser delegation for Claude Code

{{productName}} is the browser extension living in the side panel of the user's
own Chrome, already signed in to every site the user uses. This skill ships its
MCP server as one file (`scripts/{{bundleFile}}`) and teaches Claude to hand it
whole tasks — opening a video, reading an SSO dashboard, pulling rows from
webmail, filling a form on an internal tool — and bring the result back. Claude
never drives the page click by click; the extension's own agent, site adapters
and per-host permission gate do that.

## Setup (once)

1. Node.js ≥ 20 on `PATH`.
2. Register the server at user scope (every project) by running
   `python3 scripts/setup_claude.py` from this skill folder — it executes
   `claude mcp add --transport stdio --scope user {{skillName}} -- node /absolute/path/to/{{skillName}}/scripts/{{bundleFile}}`.
   For one project only: `python3 scripts/setup_claude.py --project DIR`
   writes/merges `DIR/.mcp.json`.
3. Restart Claude Code (or `/mcp` → reconnect). Tools appear as
   `{{hostTool:run}}`, `{{hostTool:extract}}`, `{{hostTool:status}}`,
   `{{hostTool:respond}}`, `{{hostTool:abort}}`, `{{hostTool:connection}}`.
4. In Chrome with {{productName}} installed: **Settings → General → Advanced →
   Cloud bridge**, URL `ws://127.0.0.1:17374/extension`, toggle on. The status
   reads **Connected** while a Claude Code session is running (it hosts the server).

Limits: same machine only (loopback on both ends — from a remote box, forward
the port with `ssh -L 17374:127.0.0.1:17374 REMOTE_HOST`); Chromium only; one bridge
socket at a time (17373 Cloud / 17374 this server / 17375 LM Studio); the
extension runs its own model, independent of Claude's.

Health check: `python3 scripts/check_bridge.py`.

## When to use

- The page needs the **user's login** — cookies, SSO, MFA already passed in
  their browser.
- The user points at **their** browser: "the tab I have open", "my account",
  "open YouTube / Gmail / …".
- You need **structured data** from an authenticated page (`{{hostTool:extract}}`).

Not for public pages you can fetch directly (use WebFetch / your own browser
tools), pure HTTP APIs, or Firefox users (no bridge there).

## Tools

| Tool | Use it for | Key arguments |
|---|---|---|
| `{{hostTool:connection}}` | Is the extension attached? Call first after any failure. | — |
| `{{hostTool:run}}` | Any browser task | `task`, `mode` (`ask` read-only / `act` navigate+interact), `timeout_seconds`, `wait`, `tab_id` |
| `{{hostTool:extract}}` | Predictable JSON from an authenticated page (always Ask mode) | `task`, `output_schema` (JSON Schema) |
| `{{hostTool:status}}` | Poll a run that outlived its timeout; list runs | `run_id` |
| `{{hostTool:respond}}` | Answer a `needs_user_input` pause | `run_id`, `clarify_id`, `answer` — permission requests: exactly `once` / `always` / `deny` |
| `{{hostTool:abort}}` | Stop a run (completed actions stay done) | `run_id` |

Statuses: `running`, `needs_user_input`, `completed`, `failed`, `aborted`.

## Procedure

1. **Check the connection once per session** with `{{hostTool:connection}}`. If
   it says *Not connected*, relay its instructions verbatim and stop — do not
   retry the task in a loop.
2. **Pick the mode from the verb.** `mode="ask"` reads, extracts and summarises
   the page that is already open; it cannot navigate, click, type or submit.
   Use `mode="act"` the moment the task opens a site, searches on it, plays,
   clicks, types or submits — "open YouTube" is an Act task.
3. **Brief it like a colleague.** Name the site, the account if several exist,
   the time range, the fields wanted, the success criterion. The extension
   cannot see this conversation; everything it needs must be in `task`.
4. **Prefer `{{hostTool:extract}}` for data**, with an object-root JSON Schema
   and `required` fields.
5. **Handle the result by status.**
   - `completed` — read `--- result ---`; report `final_url` when useful.
   - `needs_user_input`, **permission request** — the text starts with
     `PERMISSION REQUEST — {{productName}} wants to navigate to youtube.com` and
     lists `once | always | deny`. Ask the user (AskUserQuestion with those
     three options when available, otherwise in chat), then call
     `{{hostTool:respond}}` with **exactly one token**: yes / ok / sure /
     "có" / "đồng ý" → `once`; "always allow" / "luôn luôn" → `always`;
     no / "không" → `deny`. Never forward the user's words verbatim — the
     browser treats anything else as deny, and the server rejects it.
   - `needs_user_input`, **question** (e.g. "Which account?") — ask the user,
     pass their answer through verbatim (or one of the listed `accepted
     answers` exactly, when present).
   - `running (still running — poll …)` — the timeout elapsed but the browser
     is still working: poll `{{hostTool:status}}`; raise `timeout_seconds`
     (≤ 3600) for long tasks instead of re-running.
   - `failed` — read `error`. "denied" means the permission was refused; ask
     before retrying. Wrong page/account → refine `task`.
6. **Stop cleanly** with `{{hostTool:abort}}` if the user changes their mind;
   say plainly that completed actions stay done.
7. **Report** what the extension did, where it ended (`final_url`), and quote
   extracted data rather than paraphrasing numbers.

## Pitfalls

- **Permission answers are tokens, not prose** — `once` / `always` / `deny`.
  `always` persists a grant for that host in the user's browser; use it only
  when the user explicitly asks to stop being prompted for that site. If the
  side panel is open on that tab, the user may also click the request there.
- **One run per tab.** "Tab N already has an active run" → `status` /
  `respond` / `abort` it; do not start a duplicate.
- **Timeouts do not abort.** A run reported as *still running* was not cancelled.
- **Do not put secrets in `task`.** The session is already authenticated; if a
  credential is truly needed the run pauses and the user types it in the browser.
- **`allow_api_mutations` is almost never right** — leave it off unless asked.
- **The server lives only while Claude Code runs.** Between sessions the
  extension shows *Reconnecting…*; that is normal.
- **Moved the skill folder?** Re-run `scripts/setup_claude.py` — the
  registration holds the absolute path of the bundle.
