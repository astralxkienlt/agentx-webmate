/**
 * Permission MODES — how much authority the user hands the agent up front.
 *
 * KEEP THIS FILE PURE JS — no imports and no chrome.* / browser.* / DOM
 * access — so test/run.js can load it under Node (same convention as
 * permission-gate.js, whose Capability strings this classifies).
 *
 * The gate in permission-gate.js answers "may this (capability, host) run?"
 * from grants the user made ONE PROMPT AT A TIME. That is safe but noisy: a
 * single task can raise a card for navigate, then click, then type, then the
 * form submit. The only escape hatch used to be a master switch that turned
 * every prompt off at once — an all-or-nothing choice between constant
 * interruptions and no gate at all.
 *
 * A mode is the missing middle. It is a STANDING, capability-scoped default:
 *
 *     manual        ask before every consequential action        (default)
 *     auto          act on the page; ask before anything harder to undo
 *     page_actions  auto-accept page interaction incl. form submits
 *     bypass        accept everything (the old master switch, off)
 *
 * Two rules make this safe to reason about:
 *
 *   1. A mode only ever answers a question the user has NOT already answered.
 *      An explicit grant — including a standing "don't allow" — is found
 *      before the mode is consulted (see PermissionManager.check), so a
 *      permissive mode can never re-open a site the user denied. `bypass` is
 *      the documented exception: it is the "accepts all permissions" choice.
 *   2. A mode decision is never recorded as a grant. Modes are a live policy,
 *      so dropping back to `manual` immediately restores the prompts instead
 *      of leaving behind grants the user never actually chose.
 *
 * The ladder is ordered by how hard an action is to undo and how far its
 * effects reach past the page in front of the user — NOT by how likely it is
 * to be what the user wanted. That is why `execute_js` (page-scoped, but
 * arbitrary code) sits above clicking, and why downloads, uploads, network
 * writes and scheduled work sit above everything (they touch the local
 * machine, send data off-page, or outlive the run).
 */

export const PermissionMode = {
  MANUAL: 'manual',
  AUTO: 'auto',
  PAGE_ACTIONS: 'page_actions',
  BYPASS: 'bypass',
};

/**
 * Menu order = risk order, so the number shortcut a user learns ("3") keeps
 * meaning the same amount of authority, and the default sits first.
 */
export const PERMISSION_MODES = Object.freeze([
  PermissionMode.MANUAL,
  PermissionMode.AUTO,
  PermissionMode.PAGE_ACTIONS,
  PermissionMode.BYPASS,
]);

export const DEFAULT_PERMISSION_MODE = PermissionMode.MANUAL;

/** Extension-storage key holding the user's choice. */
export const PERMISSION_MODE_STORAGE_KEY = 'permissionMode';

/**
 * The boolean this replaced ("Ask before consequential actions"). Still read
 * once, to migrate an install that predates modes; still written into config
 * EXPORTS so a file from this build stays readable by an older one.
 */
export const LEGACY_PERMISSION_GATE_KEY = 'askBeforeConsequentialActions';

const RANK = Object.freeze({
  [PermissionMode.MANUAL]: 0,
  [PermissionMode.AUTO]: 1,
  [PermissionMode.PAGE_ACTIONS]: 2,
  [PermissionMode.BYPASS]: 3,
});

/**
 * The LOWEST mode that auto-approves each gated capability. EVERY value of
 * permission-gate.js's Capability must appear here — a capability with no
 * entry falls through to "always ask" (fail closed), and an exhaustiveness
 * test fails so that adding a capability forces a deliberate placement
 * instead of a silent default.
 *
 * The keys are the capability STRINGS rather than Capability references so
 * this file needs no import and stays byte-identical across the Chrome and
 * Firefox trees, whose capability sets differ (Firefox has no dev_patch —
 * Chrome implements those page edits over CDP). The exhaustiveness test is
 * what binds these strings back to the enum.
 */
export const CAPABILITY_AUTO_APPROVE_MODE = Object.freeze({
  // Reversible, page-scoped, and visible to a user who is watching the tab.
  navigate: PermissionMode.AUTO,
  click: PermissionMode.AUTO,
  type: PermissionMode.AUTO,
  dev_patch: PermissionMode.AUTO,   // Chrome-only capability; harmless here
  window: PermissionMode.AUTO,
  // Still page-scoped, but arbitrary code beats any per-action reasoning about
  // what a click will do, so it needs the explicitly wider grant.
  execute_js: PermissionMode.PAGE_ACTIONS,
  // Leaves the page: writes to the local machine, sends data to a host of the
  // model's choosing, or queues work that outlives the run. Only the
  // "accepts all permissions" mode covers these.
  download: PermissionMode.BYPASS,
  upload: PermissionMode.BYPASS,
  network_write: PermissionMode.BYPASS,
  schedule: PermissionMode.BYPASS,
});

/** Unknown / absent / junk → the safe default, never a wider mode. */
export function normalizePermissionMode(value) {
  return Object.hasOwn(RANK, value) ? value : DEFAULT_PERMISSION_MODE;
}

export function permissionModeRank(mode) {
  return RANK[normalizePermissionMode(mode)];
}

/**
 * Does `mode` pre-approve `capability` on any host, with no prompt? Called
 * only after the grant lookup found nothing, so this decides prompt vs. run —
 * never allow vs. deny.
 */
export function permissionModeAutoAllows(mode, capability) {
  const required = CAPABILITY_AUTO_APPROVE_MODE[capability];
  if (!required) return false; // unclassified capability → ask
  return permissionModeRank(mode) >= RANK[required];
}

/**
 * The form-submit confirmation is a separate, fresher card than the CLICK
 * capability prompt (it names the host and the fields), so it has its own
 * threshold: `auto` keeps confirming submits — that is the whole point of a
 * mode that otherwise lets the agent click freely — while `page_actions` and
 * above accept them.
 */
export function permissionModeAutoAcceptsSubmit(mode) {
  return permissionModeRank(mode) >= RANK[PermissionMode.PAGE_ACTIONS];
}

/**
 * True only for `bypass`: skip the capability gate wholesale, including
 * standing denies, exactly as the old master switch did when turned off.
 */
export function permissionModeSkipsAllGates(mode) {
  return normalizePermissionMode(mode) === PermissionMode.BYPASS;
}

/** Does this mode still interrupt for SOMETHING? Drives the risk banner. */
export function permissionModeAsksBeforeConsequentialActions(mode) {
  return !permissionModeSkipsAllGates(mode);
}

/**
 * Modes that hand over more than the on-page interaction a user watching the
 * tab can follow. Used for the standing risk banner and the Settings warning.
 */
export function permissionModeIsWide(mode) {
  return permissionModeRank(mode) >= RANK[PermissionMode.PAGE_ACTIONS];
}

/** The pre-modes master switch: OFF meant "never ask" → bypass. */
export function permissionModeFromLegacyGate(askBeforeConsequentialActions) {
  return askBeforeConsequentialActions === false
    ? PermissionMode.BYPASS
    : DEFAULT_PERMISSION_MODE;
}

/** The mirror written into config exports so older builds still read them. */
export function legacyGateValueForMode(mode) {
  return permissionModeAsksBeforeConsequentialActions(mode);
}

/**
 * Resolve the active mode from a storage snapshot. The new key wins whenever
 * it is present — a junk value resolves to the DEFAULT rather than falling
 * back to the legacy boolean, so a corrupted value can never widen authority.
 */
export function resolvePermissionMode(stored) {
  if (stored && Object.hasOwn(stored, PERMISSION_MODE_STORAGE_KEY)) {
    return normalizePermissionMode(stored[PERMISSION_MODE_STORAGE_KEY]);
  }
  if (stored && Object.hasOwn(stored, LEGACY_PERMISSION_GATE_KEY)) {
    return permissionModeFromLegacyGate(stored[LEGACY_PERMISSION_GATE_KEY]);
  }
  return DEFAULT_PERMISSION_MODE;
}

/** i18n keys, derived so the two UIs cannot drift in what they call a mode. */
export function permissionModeLabelKey(mode) {
  return 'sp.permmode.' + normalizePermissionMode(mode);
}

export function permissionModeDescKey(mode) {
  return 'sp.permmode.' + normalizePermissionMode(mode) + '.desc';
}

/**
 * Read the mode, migrating an install that still carries only the legacy
 * boolean. The legacy key is REMOVED once read: leaving a second, unread copy
 * of the same decision in storage is how the two drift apart. Idempotent and
 * convergent, so every context (agent, panel, settings) can call it.
 */
export async function loadPermissionMode(storageArea) {
  if (!storageArea?.get) return DEFAULT_PERMISSION_MODE;
  let stored;
  try {
    stored = await storageArea.get([PERMISSION_MODE_STORAGE_KEY, LEGACY_PERMISSION_GATE_KEY]);
  } catch {
    return DEFAULT_PERMISSION_MODE;
  }
  const mode = resolvePermissionMode(stored);
  const hasLegacy = !!stored && Object.hasOwn(stored, LEGACY_PERMISSION_GATE_KEY);
  const hasMode = !!stored && Object.hasOwn(stored, PERMISSION_MODE_STORAGE_KEY);
  if (hasLegacy) {
    try {
      if (!hasMode && storageArea.set) {
        await storageArea.set({ [PERMISSION_MODE_STORAGE_KEY]: mode });
      }
      if (storageArea.remove) await storageArea.remove(LEGACY_PERMISSION_GATE_KEY);
    } catch { /* best-effort: the resolved mode is already correct in memory */ }
  }
  return mode;
}

export async function savePermissionMode(storageArea, mode) {
  if (!storageArea?.set) return false;
  try {
    await storageArea.set({
      [PERMISSION_MODE_STORAGE_KEY]: normalizePermissionMode(mode),
    });
    return true;
  } catch {
    return false;
  }
}
