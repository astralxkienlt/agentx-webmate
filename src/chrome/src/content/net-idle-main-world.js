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
  // Exactly one decrement per request, however that request ends.
  const oneShotDone = () => {
    let spent = false;
    return () => {
      if (spent) return;
      spent = true;
      inFlight = Math.max(0, inFlight - 1);
      publish();
    };
  };
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function() {
      inFlight++; publish();
      const done = oneShotDone();
      let pending;
      try {
        pending = origFetch.apply(this, arguments);
      } catch (e) {
        done(); // threw before a promise ever existed
        throw e;
      }
      if (!pending || typeof pending.then !== 'function') {
        done();
        return pending;
      }
      // Hand the page back its OWN promise and watch that promise from the
      // side. The earlier `return origFetch.apply(...).finally(done)` handed
      // back a *derived* promise instead, so a page request that failed with
      // nobody catching it surfaced as "Uncaught (in promise) TypeError:
      // Failed to fetch" with this file on top of the stack — a page-side
      // network failure filed against the extension in chrome://extensions.
      // Our observer takes both outcomes and returns undefined, so the branch
      // we own always fulfills and can never be reported as unhandled.
      // The trade: a rejection the page itself never handles now counts as
      // handled, so it stops reaching the page console. The counter is a
      // best-effort tightener for wait_for_stable; being blamed for every
      // failed request on every page the user visits is the worse of the two.
      try { pending.then(done, done); } catch (_) { done(); }
      return pending;
    };
  }
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && XHR.prototype.send) {
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function() {
      inFlight++; publish();
      const done = oneShotDone();
      try { this.addEventListener('loadend', done, { once: true }); } catch (_) {}
      try {
        return origSend.apply(this, arguments);
      } catch (e) {
        done(); // send() threw synchronously: 'loadend' never fires for this call
        throw e;
      }
    };
  }
})();
