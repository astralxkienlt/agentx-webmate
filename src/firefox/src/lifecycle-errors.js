/**
 * Rejections the browser raises about its own lifecycle — not about us.
 *
 * An MV3 service worker is started, suspended and killed at the browser's
 * discretion, and every `chrome.*` call is a request sent to the browser
 * process. A worker that is starting, restarting or being torn down can have
 * such a request in flight at the moment the browser stops being able to
 * attribute it to a live worker; Chromium answers those with a bare
 * `Error: No SW` (extensions/browser/extension_function_dispatcher.cc).
 * Chrome's own extensions team classes that as a browser bug that extensions
 * "shouldn't need to handle". It carries no stack, because the frame that
 * rejects is a chrome binding rather than a line anyone wrote — which is why
 * the Errors page prints it as `Uncaught (in promise) Error: No SW` at
 * background.js 0:1, pointing at nothing.
 *
 * The rest of the family has the same shape: a context torn down mid-call
 * (extension reload or update), a message port closed before its answer came
 * back, a receiving end that no longer exists, a browser on its way down,
 * Firefox's disconnected message manager.
 *
 * None of them mean the extension is broken and none of them are actionable,
 * but an *unhandled* one is recorded as an extension error — the same list
 * users read when something real breaks. So the guard cancels exactly this
 * family and leaves every other rejection reported as loudly as before: a
 * rejection we could actually fix must never be hidden by this file. Even the
 * cancelled ones still reach the worker's console at debug level.
 *
 * This is a backstop, not a licence to float promises. Call sites still own
 * their rejections — see the boot-time hydration helper in background.js.
 */

/** Messages that are the whole story: matched after normalisation. */
const LIFECYCLE_MESSAGES = [
  // Chromium: the browser could not resolve the worker that issued the call.
  'no sw',
];

/**
 * Messages whose tail varies with the call (a receiving end, a port, a
 * context), matched by prefix.
 */
const LIFECYCLE_MESSAGE_PREFIXES = [
  'extension context invalidated',
  'the message port closed before a response was received',
  'could not establish connection',
  'the browser is shutting down',
  // Firefox's background page hits this one when its end goes away.
  'message manager disconnected',
];

/**
 * Pull a comparable message out of whatever landed in `reason` — rejections
 * reach us as Errors, DOMExceptions, bare strings, or plain objects from a
 * structured clone.
 */
function lifecycleMessageOf(reason) {
  if (reason == null) return '';
  const raw = typeof reason === 'string' ? reason : reason.message;
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .toLowerCase();
}

/**
 * True when `reason` is the browser telling us about its own lifecycle rather
 * than about a defect in this extension.
 */
export function isBrowserLifecycleError(reason) {
  const message = lifecycleMessageOf(reason);
  if (!message) return false;
  if (LIFECYCLE_MESSAGES.includes(message)) return true;
  return LIFECYCLE_MESSAGE_PREFIXES.some(prefix => message.startsWith(prefix));
}

/**
 * Stop browser-lifecycle rejections from being logged as extension errors.
 * Returns an uninstall function; anything that is not lifecycle noise is left
 * untouched, so real bugs keep reaching the Errors page.
 */
export function installLifecycleRejectionGuard(scope = globalThis, { onSuppressed } = {}) {
  if (typeof scope?.addEventListener !== 'function') return () => {};
  const report = onSuppressed || ((reason) => {
    console.debug('[WebBrain] ignored browser-lifecycle rejection:', reason?.message || reason);
  });
  const handler = (event) => {
    if (!isBrowserLifecycleError(event?.reason)) return;
    // Cancelling the event is what keeps it off the extension's Errors page:
    // an unhandled rejection is only reported once its event goes uncancelled.
    event.preventDefault?.();
    try {
      report(event.reason);
    } catch { /* a broken reporter must not become a second rejection */ }
  };
  scope.addEventListener('unhandledrejection', handler);
  return () => { scope.removeEventListener?.('unhandledrejection', handler); };
}
