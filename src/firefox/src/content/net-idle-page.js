/*
 * Main-world network-idle counter for wait_for_stable.
 *
 * Firefox MV2 content scripts run in an isolated world with their own copy
 * of `window.fetch` / `XMLHttpRequest`, so patching those from content.js
 * observes none of the page's real network calls. This file is loaded
 * through a web-accessible extension URL by net-idle-loader.js so it
 * executes in the page's main world instead — the same technique
 * file-picker-guard-page.js uses, and for the same reason: a <script>
 * element with inline text is blocked outright by pages whose CSP has no
 * 'unsafe-inline', while a src'd extension resource is not.
 *
 * Publishes the in-flight request count to
 * `document.documentElement.dataset.__wbInflight`, which content.js reads
 * from the isolated world — the shared DOM is what crosses the world
 * boundary.
 */
(() => {
  if (window.__wbNetIdleInstalled) return;
  window.__wbNetIdleInstalled = true;
  let inFlight = 0;
  const root = document.documentElement;
  const publish = () => {
    try { root.dataset.__wbInflight = String(inFlight); } catch (_) {}
  };
  publish();
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function() {
      inFlight++; publish();
      return origFetch.apply(this, arguments).finally(() => {
        inFlight = Math.max(0, inFlight - 1); publish();
      });
    };
  }
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && XHR.prototype.send) {
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function() {
      inFlight++; publish();
      const done = () => { inFlight = Math.max(0, inFlight - 1); publish(); };
      this.addEventListener('loadend', done, { once: true });
      return origSend.apply(this, arguments);
    };
  }
})();
