export const SIDE_PANEL_PATH = 'src/ui/sidepanel.html';

/**
 * Owns the one decision Chrome forces on every side-panel extension: which
 * tabs the panel may appear on.
 *
 * Measured behaviour of `setOptions({tabId, path, enabled: true})` on Chrome
 * (verified by driving a loaded build and reading the panel document's own
 * `document.visibilityState`):
 *
 *   * The panel shows on a tab only after an `open()` call for that tab.
 *     Switching to a tab that was never opted in hides it; switching back to
 *     the opted-in tab shows it again — Chrome remembers the open state per
 *     tab, and the panel document survives the round trip.
 *   * A tab that only has options set, with no `open()`, stays hidden. So
 *     enabling a tab the agent created is safe: it makes the panel reachable
 *     there without making it appear.
 *   * Global options (no `tabId`) are the wrong lever for "keep my panel when
 *     I come back": they make the panel available everywhere, so the panel
 *     stays on screen on *every* tab. Do not reach for them to fix a
 *     vanishing panel.
 *
 * Edge (measured on 151) implements the same API with one difference that
 * matters: it does NOT remember the open state per tab. The panel stays up
 * only while each tab you activate is itself enabled — leaving for a tab that
 * never opted in hides it, and it is then unrecoverable from code. Verified
 * dead ends on Edge: `sidePanel.open()` outside a user gesture is rejected
 * outright, re-asserting `enabled: true` on the active tab does not re-show
 * it, and neither does global availability once it has hidden. So per-tab
 * visibility on Edge costs one toolbar click (or Alt+Shift+W) to come back —
 * which lands on the remembered mode and the tab's own conversation. That is
 * a deliberate trade, not an oversight: the alternative is a sidebar on every
 * tab. Same-tab navigation and hops between two opted-in tabs keep the panel
 * up on Edge, so the click is only needed after visiting an unrelated tab.
 *
 * Nothing here ever disables the panel. The historical first-click failures
 * came from a disable racing a gesture's enable+open pair; with no disable
 * path there is no race to lose. A panel the user closes stays closed until
 * the next explicit open.
 *
 * One global setOptions call is allowed to exist, and it lives in
 * background.js, not here: `setOptions({ path, enabled: false })` at SW boot.
 * That call registers the panel *document* without granting visibility
 * anywhere — per-tab records override the disabled default, so it can never
 * race a gesture's enable+open pair (different scope). It exists because Edge
 * opens panels from its own sidebar rail and from session restore without
 * running any of our gesture handlers; with no globally registered path those
 * surfaces rendered chrome-extension://<id>/ as a permanently blank frame
 * that only removing the extension cleared.
 */
export function createSidePanelAvailability({ browserApi, path = SIDE_PANEL_PATH } = {}) {
  /**
   * Let the panel be opened on `tabId`. Deliberately synchronous and
   * fire-and-forget: callers run inside a user gesture and must reach
   * `sidePanel.open()` without ever awaiting, or Chrome drops the gesture and
   * silently refuses to open.
   */
  function enableForTab(tabId) {
    if (tabId == null) return;
    try {
      const applied = browserApi?.sidePanel?.setOptions?.({ tabId, path, enabled: true });
      applied?.catch?.(() => {});
    } catch {
      // A browser without chrome.sidePanel has nothing to enable. Callers
      // still run their own open() attempt and surface that failure instead.
    }
  }

  return { enableForTab };
}
