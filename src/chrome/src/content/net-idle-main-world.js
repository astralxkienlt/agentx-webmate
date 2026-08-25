/*
 * Main-world network-idle counter for wait_for_stable.
 *
 * Extension content scripts run in an isolated JavaScript world with their
 * own copy of `window.fetch` / `XMLHttpRequest`, so patching those from
 * content.js observes none of the page's real network calls. This file
 * runs in the page's MAIN world (declared via "world": "MAIN" in
 * manifest.json) so the patch applies to the fetch/XHR the page itself
 * calls. Declaring it statically like this — instead of content.js
 * injecting a <script> element with inline text — keeps it exempt from
 * the page's Content-Security-Policy; pages with a strict `script-src`
 * (no 'unsafe-inline') block inline script injection outright.
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
