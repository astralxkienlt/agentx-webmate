// netMind boot watchdog — a classic script, deliberately OUTSIDE the panel's
// ES-module graph.
//
// The sign-in gate ships visible with its spinner row showing, and sidepanel.js
// (one module graph of ~30 files) is what replaces that spinner with real
// state. If any file in that graph fails to load or parse — an interrupted
// update, a corrupted install, an incompatible browser — the module never
// runs and the static spinner used to stay up forever with no error and no
// way out. This script cannot break the same way: it is standalone, runs
// before the module, and only ever acts when the module fails to check in.
//
// The gate module checks in by calling window.__netmindGateBootAlive() at the
// top of its init. From that moment the gate owns the UX (it has its own
// deadlines) and this watchdog retires.
(function () {
  // Generous: the module graph parses in well under a second on any healthy
  // profile. This only has to beat "never".
  var DEADLINE_MS = 15000;
  var timerId = null;
  var armed = true;
  var firstError = '';

  window.__netmindGateBootAlive = function () {
    armed = false;
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  function rememberError(message) {
    if (!firstError && message) firstError = String(message).slice(0, 200);
  }

  window.addEventListener('error', function (event) {
    rememberError(event && (event.message || (event.error && event.error.message)));
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    rememberError(reason && (reason.message || reason));
  });

  function fail() {
    timerId = null;
    if (!armed) return;
    armed = false;
    try {
      var root = document.getElementById('agentx-login-gate');
      // A hidden gate means the module ran and unlocked — nothing to rescue.
      if (!root || root.classList.contains('hidden')) return;
      var busy = root.querySelector('[data-agentx-gate-busy]');
      if (busy) busy.classList.add('hidden');
      var notice = root.querySelector('[data-agentx-gate-notice]');
      if (notice) {
        notice.textContent = 'Giao diện chưa khởi động được — mã giao diện không chạy. Hãy bấm "Tải lại"; nếu vẫn lỗi, hãy cài lại tiện ích. (The panel script failed to start.)'
          + (firstError ? ' [' + firstError + ']' : '');
        notice.classList.remove('hidden');
      }
      var card = root.querySelector('.agentx-gate-card') || root;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'agentx-gate-button';
      button.textContent = 'Tải lại';
      button.addEventListener('click', function () { location.reload(); });
      card.appendChild(button);
      console.error('[AgentX] Panel module never signalled boot; offering manual reload.', firstError || '(no captured error)');
    } catch (renderError) {
      // The console line below is the last remaining diagnostic surface.
      console.error('[AgentX] Boot watchdog could not render its notice:', renderError);
    }
  }

  timerId = setTimeout(fail, DEADLINE_MS);
})();
