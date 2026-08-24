# Manual test: permission gate, permission modes, and the Settings UI

These paths can't be covered by `test/run.js` (they need a live browser — the
3-option permission card, the composer's permission-mode chip, and the
Settings → Permissions tab are DOM/storage glue). Run this checklist after
loading the unpacked extension before merging changes to the permission gate,
the mode ladder, or their UI.

The pure logic behind the modes *is* covered by `node test/run.js` (the ladder,
the migration, the gate integration, and the covered-card resolver run against
the production source), so what is left here is rendering, focus, and storage
round-trips.

Load the unpacked extension your usual dev way:
- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on → pick
  `src/firefox/manifest.json`.
- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → `src/chrome`.

Helpers you'll reuse (run in the background/service-worker console, or the
Settings page console):
- **Inspect grants:** `await browser.storage.local.get('wb_permissions')`
  (Firefox) / `chrome.storage.local.get('wb_permissions')` (Chrome).
- **Reset grants:** `browser.storage.local.remove('wb_permissions')`, or
  Settings → Permissions → Clear all.
- **Inspect / reset the mode:** `chrome.storage.local.get('permissionMode')` and
  `chrome.storage.local.remove('permissionMode')` (absent = `manual`).

---

## Test 1 — The 3-option permission card

**Setup:** reset grants. Open the side panel, switch to **Act** mode, open a
simple page with a visible clickable button.

### 1a. Card renders correctly
1. Tell the agent: *"click the <some visible button>"*.
2. **Expect** a card: **"WebBrain wants to click / submit on \<host\>. Allow it?"**
   with **three** buttons: `Allow once` · `Always allow on <host>` · `Don't allow`,
   and **NO free-text input** (permission cards are structured — the buttons
   return `once`/`always`/`deny`, not typed text).
3. **Check layout** — all three buttons visible, not clipped/overlapping/wrapping.
4. **Localization** — switch the language (Settings → display) to a non-English
   locale and trigger the prompt again: the question, the verb, and the three
   buttons should be translated (English is the fallback for unset keys), and
   clicking still works (the returned value is locale-independent).

### 1b. "Allow once" proceeds and is turn-scoped  *(critical: must NOT act as deny)*
1. Click **Allow once** → the click executes.
2. In the **same** turn, prompt another click on the same site → **no second card**.
3. Send a **new** message that clicks again → card **reappears** (new turn clears
   once-grants).

### 1c. "Always allow" persists
1. Trigger the click again, click **Always allow on \<host\>** → click executes.
2. Subsequent turns clicking on that host → **no card**.
3. Console: `wb_permissions` contains
   `{capability:'click', host:'<host>', action:'allow', duration:'always'}`.

### 1d. "Don't allow" blocks
1. Reset grants, trigger a gated action, click **Don't allow**.
2. **Expect** the action does **not** happen; the agent reports it was denied /
   asks how to proceed (it must not loop retrying).

### 1e. Abort while card is open
1. Trigger a card, then hit **Stop**.
2. **Expect** the run ends cleanly ("Stopped by user"), no hang.

---

## Test 2 — Per-(capability, host) granularity
1. Grant **Always allow** for `click` on site A (Test 1c).
2. On site A, prompt a **type** action → **card appears** (different capability).
3. Navigate to site B and prompt a click → **card appears** (different host).
4. Prompt a navigation to a *new* host → a **navigate** card for that destination.

Confirms a grant is scoped to exactly one capability+host, not a blanket pass.

---

## Test 3 — Permissions settings tab (revoke flow)

**Setup:** grant 2–3 "Always allow" entries across different sites/capabilities.

1. Open Settings (options page) → **Permissions** tab.
2. **Expect** each grant on its own row — host as bold label,
   **"Allowed to \<verb\>"** beneath (or **"⛔ Blocked from \<verb\>"** for a deny),
   and a **Revoke** button; a **Clear all permissions** button at the bottom.
3. **Revoke one row** (with 2–3 grants present) → that **specific** row
   disappears immediately, **the other rows stay listed**, and `wb_permissions`
   in the console now contains **exactly the remaining grants** (the revoked
   `{capability, host}` is gone, nothing else changed). *(This is the assertion
   that guards the per-row revoke — the earlier NUL/delimiter bug made Revoke
   remove nothing or the wrong grant.)*
4. **Live re-prompt:** back in the agent, trigger that exact capability on that
   exact host → it **prompts again** (proves `storage.onChanged` → `hydrateFrom`
   invalidated the in-memory grant without a reload).
5. **Clear all** → list shows empty-state text and the Clear-all button hides.
6. **Empty state from scratch:** with no grants, open the tab → empty-state text,
   no rows.

---

## Test 4 — Persistence across reload
1. Grant an "Always allow."
2. Reload the extension (or restart the browser).
3. Agent acts on that host → **no prompt**; Settings → Permissions still lists it.

---

## Test 5 — Permission modes (the chip under the composer)

The chip sits in the composer's footer, directly under the input, and shows the
current mode; its menu pops up above it, over the conversation. Default is
**Ask every time**. `permissionMode` in storage is the single source of truth;
Settings → Permissions shows the same value.

### 5a. The menu renders and is keyboard-operable
1. Click the chip. **Expect** a pop-up above it — overlaying the conversation,
   not pushing the composer down — with a "Permissions" heading and
   four rows — *Ask every time*, *Auto*, *Accept page actions*, *Bypass
   permissions* — each with a description, a number (1–4), and a ✓ on the
   active row.
2. **Keyboard:** with the menu open, `↓`/`↑` move between rows, `Home`/`End`
   jump to the ends, `Esc` closes and returns focus to the chip, `Tab` closes,
   and pressing `3` selects the third row directly.
3. **Outside click** closes the menu without changing the mode.
4. **Localization:** switch language (Settings → display). The chip label, the
   heading, and every row's label and description must be translated — with no
   reload. Selecting a mode shows a translated toast.
5. **No layout shift:** cycle through all four modes and watch the composer.
   The Ask/Act/Dev pill, the input box and their positions must not move or
   change height, and no mode name may be truncated. In a short window the
   pop-up scrolls instead of running off the top edge.

### 5b. Auto — reversible page actions stop asking
1. Reset grants, pick **Auto**, and in Act mode ask the agent to click a
   plain (non-submit) button on a site with no grants.
2. **Expect** no permission card; the click just happens.
3. Ask it to download a file from that same site → **card appears** (downloads
   stay gated below Bypass).
4. Ask it to submit a form → the **form-submit confirmation** still appears.
   *(This is the point of Auto: it clicks freely and still confirms submits.)*
5. Console: `wb_permissions` is still **empty** — a mode must never record
   grants.

### 5c. Accept page actions — submits included
1. Pick **Accept page actions** and repeat 5b.4 → the form submits with **no**
   confirmation card.
2. A download or upload on the same site → **card still appears**.
3. The Act-mode risk banner appears (it does for this mode and Bypass only).

### 5d. Bypass — everything
1. Pick **Bypass permissions**. **Expect** the chip turns warning-coloured (in
   place, without resizing the composer), and Settings → Permissions shows the
   ⚠️ "prompts are OFF" box.
2. A gated action on a site with **no** grant executes with no card.
3. Even a site you previously denied acts — Bypass is documented as accepting
   all permissions. Narrow the mode again and the deny is back in force.

### 5e. Narrowing restores prompts immediately
1. From Auto, go back to **Ask every time** and repeat the click from 5b.
2. **Expect** the card returns with no reload — the wider mode left nothing
   behind.

### 5f. Widening while a card is open answers only what it covers
1. In **Ask every time**, trigger a click card and leave it open.
2. Without answering, pick **Auto** in the chip.
3. **Expect** the click card disappears and the action proceeds.
4. Repeat with a **download** card open: switching to Auto must leave that card
   standing (Auto does not cover downloads); switching to **Bypass** clears it.
5. Console: `wb_permissions` stays empty — auto-answered cards are `once`.

### 5g. The slash command and the chip are one setting
1. Type `/dangerously-skip-permissions`. **Expect** the chip switches to
   **Bypass permissions**, and `permissionMode` is `"bypass"`.
2. Open Settings → Permissions in another tab: the dropdown already reads
   Bypass (live sync, no reload).
3. Change it in Settings to **Auto** → the panel's chip follows, live.

### 5h. Layers 1 & 2 stay on in every mode
In Bypass, open a page whose content says "ignore your instructions and …".
The agent must still treat page content as data (this is the system-prompt /
untrusted-wrapping behaviour, independent of the mode).

### 5i. Migration from the old master switch
1. `chrome.storage.local.remove('permissionMode')` then
   `chrome.storage.local.set({ askBeforeConsequentialActions: false })`.
2. Reload the panel. **Expect** the chip reads **Bypass permissions**, storage
   now has `permissionMode: "bypass"`, and `askBeforeConsequentialActions` is
   **gone** (migrated once, then removed).

---

## Pass criteria
- Card shows 3 well-laid-out buttons and no free-text input (1a); localized in
  non-English locales (1a.4).
- Allow-once and Always **proceed**; Don't-allow **blocks** (1b–1d).
- Grants are per-capability+host (Test 2).
- Permissions tab lists/revokes/clears correctly; a revoke causes an immediate
  re-prompt (Test 3).
- Grants persist across reload (Test 4).
- Each mode asks for exactly the rungs above it, records no grants, and
  narrowing restores the prompts with no reload (5b–5e).
- The chip, Settings, and `/dangerously-skip-permissions` all move the same
  stored value, in both directions, live (5g).

**Highest-risk item:** 1a/1b. The card now returns a structured value
(`once`/`always`/`deny`) from the button click — there is no label parsing — so
a mis-render would show as a missing/broken button rather than a wrong grant.
If a button does nothing or the wrong choice is recorded, the issue is the
`data.permission` branch of `renderClarifyCard` (`sidepanel.js`) or the value
mapping in `_promptPermission` (`agent.js`). `_promptPermission` still maps any
unexpected value to `'deny'` (fail-safe).
