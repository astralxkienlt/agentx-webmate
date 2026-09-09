# AgentX Workmate integration contract

How AgentX Workmate installs, pairs with, and updates this extension without a
browser store. Workmate's side of the contract lives in
`apps/desktop/electron/webmate/` and `hermes_cli/` of the Workmate repository;
this page is the single place both sides are written down.

## Files on the user's machine

Everything sits in one machine-level folder — `<AgentX root>/webmate/`, which is
`~/.agentx/webmate/` on macOS/Linux and `%LOCALAPPDATA%\agentx\webmate\` on
Windows. It is *not* under `accounts/<slug>/`: the extension belongs to the
machine, not to a signed-in account. Deleting the folder removes every trace.

| Path | Written by | Purpose |
|---|---|---|
| `AgentX WebMate/` | Workmate | The unpacked extension folder the browser is pointed at (contents of `agentx-webmate-chrome-<ver>.zip`). The name never changes because Chrome stores the absolute path; versions are swapped by two renames. |
| `AgentX WebMate/workmate.json` | Workmate | Read by the extension before every dial (see below). |
| `pairing.json` | Workmate (0600) | The pairing token the MCP server checks against `hello.token`. |
| `state.json` | MCP server | What the bridge knows: listening, connected, browser, extension version, sign-in, last command outcome. Temp + rename; Workmate watches it. |
| `commands/<uuid>.json` | Workmate | One command per file for the running server (`prepare_update`, `reload`, `resume`); consumed on pick-up. |
| `versions/<ver>/`, `versions/prev/` | Workmate | Staging for the next version and the previous one (rollback). |
| `update-check.json` | Workmate | Cache of the last feed check, including any version waiting for the browser to close. |

The MCP server resolves the folder as `WEBMATE_DIR` (Workmate sets it when it
registers the server) → `AGENTX_HOME` with the `accounts/<slug>` and
`profiles/<name>` layers stripped → the platform default.

## `workmate.json`

```json
{ "schema": 1, "wsUrl": "ws://127.0.0.1:17374/extension", "token": "<base64, 32 bytes>",
  "installId": "<uuid>", "workmateVersion": "0.21.0", "minServerVersion": "1.1.0" }
```

`src/chrome/src/offscreen/cloud-bridge.js` fetches it with
`chrome.runtime.getURL('workmate.json')` before every dial. Missing file ⇒
developer/store install: the Settings URL is used, no token is sent, and the
server's `hello_ack` is accepted with any token. Present ⇒ `wsUrl` must pass the
same loopback check as the Settings URL (else the Settings URL is used and the
error is shown in the status line), the token is sent, and a `hello_ack` whose
`token` differs closes the socket with a sixty-second hold-off.

## `pairing.json`

```json
{ "schema": 1, "token": "<same token>", "port": 17374, "installId": "<uuid>", "createdAt": "<ISO>" }
```

Read by the MCP server on every handshake (`WEBMATE_PAIRING_FILE` overrides the
path). Present ⇒ `hello.protocolVersion ≥ 3` and `hello.token === token` are
required; anything else is closed with code 1008 and a reason. Absent ⇒ the
pre-Workmate behaviour: v2 hellos accepted, no token. A present but unreadable
file rejects every handshake — it never degrades to "no authentication".

## Bridge protocol v3

```json
{ "type": "hello", "client": "webbrain-extension", "protocolVersion": 3,
  "version": "1.0.4", "browser": "Chrome 152", "installType": "workmate",
  "token": "<from workmate.json, absent in dev>", "signedIn": true,
  "capabilities": ["saved_workflows_v1", "run_modes_v1", "scheduled_jobs_v1", "workmate_update_v1"],
  "status": { … } }
```

`client` is the upstream wire identifier and must not change. `browser` comes
from `navigator.userAgentData.brands` (UA string fallback). `signedIn` reflects
the AgentX session in `chrome.storage.local`; `null` when storage cannot answer.

The server replies once per socket:

```json
{ "type": "hello_ack", "serverVersion": "1.1.0", "protocolVersion": 3,
  "token": "<echo of the pairing token, or null>", "minExtensionVersion": "1.0.4", "minProtocol": 3 }
```

While an accepted extension is attached, a second connection to the same port
is *held* until its own hello passes the same checks; only then does it take
over (the first socket is closed with 1000 "Superseded"). A rejected hello
(v2, wrong token, unknown client) or ten seconds of silence closes the newcomer
alone. So a developer checkout, a store copy, or the person's own browser once a
Workmate window exists can dial 17374 all day without knocking the
Workmate-installed copy off — before this rule the merely-connected newcomer
superseded first and was refused second, and `state.json.connected` flapped
every few seconds on a machine that had both. While nothing has completed a
handshake, the latest connection still wins, as before.

Two bridge actions were added for updates (`ALLOWED_BRIDGE_ACTIONS` in the
extension, `BridgeAction` in the server):

- `workmate_prepare_update` → the extension stops accepting new runs (503
  "about to update") and answers `{ ok: true, draining: true, busy: <n> }`. Idempotent;
  `{ resume: true }` lifts the drain. The drain also clears itself after five
  minutes so a Workmate that dies mid-update cannot wedge the browser.
- `workmate_reload` → answers `{ ok: true }` and calls `chrome.runtime.reload()`
  250 ms later, after the ack has crossed the socket.

  Verified on Chrome 152: for an extension the user loaded through
  `chrome://extensions` the reload happens in place and the extension re-dials
  within seconds. For an extension loaded through CDP `Extensions.loadUnpacked`
  (the phase-3 "Workmate browser window", and `test/workmate-install-e2e.mjs`)
  the reload **unloads it for good** — no service worker, no targets afterwards.
  That mode must call `Extensions.loadUnpacked` again after swapping the folder
  instead of relying on the reload; the ID stays the same because of the
  manifest `key`.

## `state.json`

```json
{ "schema": 1, "pid": 4242, "port": 17374, "serverVersion": "1.1.0",
  "listening": true, "connected": true, "pairingRequired": true,
  "browser": "Chrome 152", "extensionVersion": "1.0.4", "installType": "workmate",
  "signedIn": true, "protocolVersion": 3, "lastHelloAt": "<ISO>", "error": null,
  "lastCommand": { "id": "<uuid>", "action": "prepare_update", "ok": true, "busy": 0,
                   "error": null, "startedAt": "<ISO>", "finishedAt": "<ISO>" },
  "updatedAt": "<ISO>" }
```

Written only by the process that holds the port. A reader that sees
`listening: true` with a dead `pid` is looking at a force-quit server's last
words.

## Commands

Workmate writes `commands/<uuid>.json` (temp + rename):

```json
{ "id": "<uuid>", "action": "prepare_update" | "reload" | "resume" }
```

The server deletes the file on pick-up, runs the action, and records the
outcome as `state.json.lastCommand`. `prepare_update` polls the extension until
`busy` reaches 0 or `WEBMATE_PREPARE_UPDATE_TIMEOUT_MS` (60 s) passes; with no
extension attached it reports `ok: false, error: "WEBMATE_NOT_CONNECTED"`, which
Workmate reads as "browser closed — swap the folder now".

## Structured error codes

Every failing tool result starts with one of these and repeats it as
`structuredContent.code`:

`WEBMATE_NOT_INSTALLED` (pairing configured, no extension folder) ·
`WEBMATE_NOT_CONNECTED` · `WEBMATE_OUTDATED` · `WEBMATE_NOT_SIGNED_IN`
(extension refused the run for lack of a model, or `hello.signedIn` is false) ·
`WEBMATE_PORT_IN_USE`. `WEBMATE_DISABLED` is raised by Workmate itself when the
server is switched off.

## Extension ID

`brand/brand.config.json` → `manifestOverrides.chrome.key` pins the ID
(`product.extensionId`, currently `pfadeibckkgklmmjghiikadphihbpape`) so it is
the same whether the folder is loaded from `~/.agentx/webmate/AgentX WebMate`,
a checkout's `brand-dist/chrome`, or a store. Workmate reads
`extensions.settings[<id>]` in the browser profile's `Secure Preferences` to
tell "installed", "installed but disabled" and "not installed" apart.
`minimum_chrome_version` is 121 — the first Chrome without the developer-mode
nag bubble. The private half of the key stays outside the repository
(`~/.agentx/webmate-keys/manifest-key.pem` on the maintainer's machine); a key
that does not match `product.extensionId` fails `npm run brand:build`.

## Update feed — `release.json`

```json
{ "schema": 1, "version": "1.0.4", "publishedAt": "<ISO>",
  "chrome": { "url": "https://github.com/astralxkienlt/agentx-webmate/releases/download/v1.0.4/agentx-webmate-chrome-1.0.4.zip",
              "sha256": "<hex>", "bytes": 5230000 },
  "minWorkmate": "0.21.0", "minProtocol": 3,
  "notes": { "vi": "…", "en": "…" },
  "signature": "ed25519:<base64>" }
```

`scripts/build-zip.mjs` writes the unsigned document to `dist/release.json`
(sha256 and size from the Chrome zip, floor from `brand.config.json`
`workmate`, notes from the version's CHANGELOG section);
`scripts/sign-release.mjs` signs it with the Ed25519 key in the
`WEBMATE_RELEASE_SIGNING_KEY` secret and checks the result against
`scripts/release-signing-key.pub.pem`, the public key compiled into Workmate.
The signature covers the canonical JSON (sorted keys, no whitespace) of every
field except `signature`. Both release workflows commit the signed file to
`dist/release.json` and `release.json` at the repository root, and attach it to
the GitHub Release; Workmate polls
`https://raw.githubusercontent.com/astralxkienlt/agentx-webmate/main/release.json`.

Workmate installs a release only when the sha256 matches the zip and the
signature verifies. There is no "install anyway" button.

## Developer checkout

Nothing changes for a `brand-dist/chrome` load: no `workmate.json`, so the
Settings URL and no token; `node mcp-server/dist/index.js` without a
`pairing.json` accepts the v3 hello exactly as it accepted v2. The server does
write `state.json` into `<AgentX root>/webmate/` — set `WEBMATE_STATE_FILE=off`
(and `WEBMATE_COMMANDS_DIR=off`) to keep a scratch server out of it.

**Once Workmate has run on the machine** it has written
`<AgentX root>/webmate/pairing.json`, and every server that resolves that
folder — including a checkout's `dist/index.js` that a Workmate account config
points at — runs paired and rejects a `brand-dist/chrome` load with
"Bridge protocol v3 required / Pairing token mismatch". To keep developing
against the dev build, copy the machine's
`<AgentX root>/webmate/AgentX WebMate/workmate.json` into `brand-dist/chrome/`
and Reload the extension: `brand:build` preserves that file across rebuilds and
`build:zip` refuses to package a tree that contains it. Delete it (or
`pairing.json`) to go back to unpaired dev mode. Every test that spawns or
constructs the server sets `WEBMATE_DIR` to a scratch directory for the same
reason.

Tests: `npm test` (extension side: `test/run.js` offscreen-bridge cases,
`test/workmate-install.test.mjs`), `cd mcp-server && npm test` (server side:
`test/pairing.test.mjs`, `test/commands.test.mjs`), and the opt-in real-Chrome
acceptance run `node test/workmate-install-e2e.mjs` (loads brand-dist/chrome
into a throwaway profile on port 17398 and walks dev mode, pairing, token
mismatch, the update hooks and the stdio server).
