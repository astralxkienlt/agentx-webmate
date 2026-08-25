/*
 * Firefox MV2 content scripts run in an isolated world. Load the net-idle
 * counter through a web-accessible extension URL so it executes in the
 * page's main world and can see the page's own fetch/XHR calls.
 */
(() => {
  try {
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('src/content/net-idle-page.js');
    script.async = false;
    script.onload = () => { try { script.remove(); } catch {} };
    script.onerror = () => { try { script.remove(); } catch {} };
    (document.head || document.documentElement).appendChild(script);
  } catch {}
})();
