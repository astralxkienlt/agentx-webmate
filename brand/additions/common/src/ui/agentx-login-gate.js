import { AGENTX_RUNTIME_CONFIG } from '../agentx/runtime-config.js';
import {
  AGENTX_SESSION_STORAGE_KEY,
  AgentXCloudError,
  createAgentXCloudService,
} from '../agentx/cloud-service.js';
import { installCloudCredential } from '../agentx/cloud-provider-install.js';

const COPY = {
  en: {
    eyebrow: 'AgentX WebMate',
    title: 'Sign in to start',
    body: 'AgentX WebMate runs on your organization’s model gateway. Sign in once and the panel is ready to use.',
    checking: 'Checking your session…',
    signIn: 'Sign in to AgentX',
    signingIn: 'Opening secure sign-in…',
    provisioning: 'Preparing your model connection…',
    retry: 'Try again',
    passwordNote: 'Developed by AstralX',
    idleExpired: 'You were signed out after a period of inactivity. Sign in again to continue.',
    signedOutElsewhere: 'You signed out of AgentX. Sign in again to keep using the panel.',
    needs_login: 'Your session is no longer valid. Sign in again to continue.',
    invalid_token: 'Second Brain rejected the identity token. Sign in again.',
    missing_bearer: 'The identity request did not include a valid bearer token. Sign in again.',
    device_revoked: 'This device has been revoked. Sign in again to reconnect.',
    identity_unavailable: 'Keycloak verification is temporarily unavailable. Try again in a moment.',
    store_unavailable: 'Second Brain storage is temporarily unavailable. Try again in a moment.',
    litellm_unavailable: 'LiteLLM is temporarily unavailable. Try again in a moment.',
    litellm_unconfigured: 'Second Brain has no LiteLLM admin key. Ask the operator to finish the server configuration.',
    key_unreadable: 'Second Brain could not decrypt the saved key. Sign in again.',
    gateway_models_empty: 'The gateway returned no models for this account. Ask the operator to grant model access.',
    sign_in_cancelled: 'Sign-in was cancelled before it completed.',
    sign_in_timeout: 'Sign-in exceeded five minutes. Start the flow again.',
    network_unavailable: 'Could not reach the service. Check your connection and try again.',
    request_timeout: 'The service took too long to answer. Try again.',
    background_unavailable: 'The extension background did not respond. Try again; if it keeps happening, close and reopen the panel.',
    genericError: 'Sign-in failed. {detail}',
    openSettings: 'Open Settings',
  },
  vi: {
    eyebrow: 'AgentX WebMate',
    title: 'Đăng nhập để bắt đầu',
    body: 'AgentX WebMate chạy trên cổng mô hình của tổ chức bạn. Đăng nhập một lần là dùng được ngay.',
    checking: 'Đang kiểm tra phiên đăng nhập…',
    signIn: 'Đăng nhập AgentX',
    signingIn: 'Đang mở trang đăng nhập bảo mật…',
    provisioning: 'Đang chuẩn bị kết nối mô hình…',
    retry: 'Thử lại',
    passwordNote: 'Được phát triển bởi AstralX',
    idleExpired: 'Bạn đã bị đăng xuất sau một thời gian không dùng. Hãy đăng nhập lại để tiếp tục.',
    signedOutElsewhere: 'Bạn vừa đăng xuất khỏi AgentX. Hãy đăng nhập lại để dùng tiếp.',
    needs_login: 'Phiên đăng nhập không còn hợp lệ. Hãy đăng nhập lại để tiếp tục.',
    invalid_token: 'Second Brain từ chối token đăng nhập. Hãy đăng nhập lại.',
    missing_bearer: 'Yêu cầu xác minh tài khoản thiếu bearer token hợp lệ. Hãy đăng nhập lại.',
    device_revoked: 'Thiết bị này đã bị thu hồi. Hãy đăng nhập lại để kết nối.',
    identity_unavailable: 'Keycloak tạm thời không xác minh được tài khoản. Hãy thử lại sau ít phút.',
    store_unavailable: 'Kho dữ liệu Second Brain tạm thời chưa sẵn sàng. Hãy thử lại sau ít phút.',
    litellm_unavailable: 'LiteLLM tạm thời chưa sẵn sàng. Hãy thử lại sau ít phút.',
    litellm_unconfigured: 'Second Brain chưa có khóa quản trị LiteLLM. Hãy nhờ quản trị viên hoàn tất cấu hình máy chủ.',
    key_unreadable: 'Second Brain không giải mã được khóa đã lưu. Hãy đăng nhập lại.',
    gateway_models_empty: 'Cổng mô hình chưa cấp mô hình nào cho tài khoản này. Hãy nhờ quản trị viên cấp quyền.',
    sign_in_cancelled: 'Đăng nhập bị hủy giữa chừng.',
    sign_in_timeout: 'Quá 5 phút chưa đăng nhập xong. Hãy làm lại từ đầu.',
    network_unavailable: 'Không kết nối được dịch vụ. Hãy kiểm tra mạng rồi thử lại.',
    request_timeout: 'Dịch vụ trả lời quá lâu. Hãy thử lại.',
    background_unavailable: 'Nền tiện ích không phản hồi. Hãy thử lại; nếu vẫn lỗi, hãy đóng rồi mở lại bảng điều khiển.',
    genericError: 'Đăng nhập không thành công. {detail}',
    openSettings: 'Mở Cài đặt',
  },
};

// Cheap enough to run on every pointer press: the service itself throttles the
// storage write, this only decides whether to bother calling it.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'focusin'];
const SESSION_POLL_INTERVAL_MS = 60_000;
// Hard ceiling on one silent restore attempt. Every network call under it is
// individually timeout-capped (worst legitimate chain ≈ 46s of sequential
// fetches), so anything still spinning past this is a hang — storage or
// messaging — that would otherwise leave the spinner up forever with the
// retry button hidden.
const RESTORE_ATTEMPT_TIMEOUT_MS = 60_000;
// One background round trip while installing the credential. The handlers
// answer in milliseconds when the service worker is healthy; what this guards
// against is a worker that accepted the message and then died or deadlocked,
// which used to park the gate at "provisioning" with no way out.
const BACKGROUND_CALL_TIMEOUT_MS = 20_000;

function language(locale) {
  return String(locale || '').toLowerCase().startsWith('vi') ? 'vi' : 'en';
}

function copy(locale, key, params = {}) {
  let value = COPY[language(locale)][key] || COPY.en[key] || key;
  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

function errorMessage(error, locale) {
  if (!error) return '';
  const code = String(error.code || '');
  const translated = COPY[language(locale)][code] || COPY.en[code];
  if (translated) return translated;
  return copy(locale, 'genericError', { detail: error.message || code || '' });
}

/**
 * Blocks the side panel until the user is signed in and the managed cloud
 * provider holds a usable key.
 *
 * The overlay ships visible in sidepanel.html rather than being revealed from
 * here: a gate that only appears once its module has parsed would leave the
 * chat usable for the frames in between, and would fail open if the module
 * ever failed to load.
 */
export function createAgentXLoginGate({
  api,
  root,
  appRoot,
  locale = () => 'en',
  sendToBackground,
  config = AGENTX_RUNTIME_CONFIG,
  serviceOptions = {},
  documentRef = globalThis.document,
  restoreTimeoutMs = RESTORE_ATTEMPT_TIMEOUT_MS,
  backgroundCallTimeoutMs = BACKGROUND_CALL_TIMEOUT_MS,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  if (!root) throw new TypeError('root element is required');
  if (typeof sendToBackground !== 'function') {
    throw new TypeError('sendToBackground is required');
  }

  const setTimer = setTimeoutImpl || globalThis.setTimeout.bind(globalThis);
  const clearTimer = clearTimeoutImpl || globalThis.clearTimeout.bind(globalThis);
  const service = createAgentXCloudService({ ...serviceOptions, api, config });
  const elements = {
    eyebrow: root.querySelector('[data-agentx-gate-eyebrow]'),
    title: root.querySelector('[data-agentx-gate-title]'),
    body: root.querySelector('[data-agentx-gate-body]'),
    notice: root.querySelector('[data-agentx-gate-notice]'),
    busy: root.querySelector('[data-agentx-gate-busy]'),
    busyLabel: root.querySelector('[data-agentx-gate-busy-label]'),
    button: root.querySelector('[data-agentx-gate-signin]'),
    settings: root.querySelector('[data-agentx-gate-settings]'),
    footnote: root.querySelector('[data-agentx-gate-footnote]'),
  };

  let locked = true;
  let unlocked = null;
  let resolveUnlocked = () => {};
  let busyAction = '';
  let notice = '';
  let watching = false;
  let watchingStorage = false;
  let pollTimer = null;
  // Bumped at the start of every restore/sign-in attempt. An attempt that is
  // no longer current must not touch the UI or unlock the panel: its deadline
  // already surfaced a retry button, and a stale unlock racing a live attempt
  // is exactly the kind of surprise this gate exists to prevent.
  let attemptSeq = 0;
  const teardown = [];

  /**
   * sendToBackground with a settle guarantee. The plain call can stay pending
   * forever when the service worker accepts the message and then dies or
   * deadlocks; every gate-critical round trip goes through here instead.
   */
  function boundedSendToBackground(action, data) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimer(() => {
        if (settled) return;
        settled = true;
        reject(new AgentXCloudError(
          'background_unavailable',
          `Nền tiện ích không phản hồi khi xử lý "${action}".`,
          { transient: true },
        ));
      }, backgroundCallTimeoutMs);
      Promise.resolve()
        .then(() => sendToBackground(action, data))
        .then((value) => {
          if (settled) return;
          settled = true;
          clearTimer(timeoutId);
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          clearTimer(timeoutId);
          reject(error);
        });
    });
  }

  function render() {
    const lang = locale();
    if (elements.eyebrow) elements.eyebrow.textContent = copy(lang, 'eyebrow');
    if (elements.title) elements.title.textContent = copy(lang, 'title');
    if (elements.body) elements.body.textContent = copy(lang, 'body');
    if (elements.footnote) elements.footnote.textContent = copy(lang, 'passwordNote');
    if (elements.notice) {
      elements.notice.textContent = notice;
      elements.notice.classList.toggle('hidden', !notice);
    }
    if (elements.busy) {
      elements.busy.classList.toggle('hidden', !busyAction);
      if (elements.busyLabel && busyAction) {
        elements.busyLabel.textContent = copy(lang, busyAction);
      }
    }
    if (elements.button) {
      elements.button.textContent = copy(lang, notice ? 'retry' : 'signIn');
      elements.button.disabled = Boolean(busyAction);
      elements.button.classList.toggle('hidden', Boolean(busyAction));
    }
    if (elements.settings) {
      // Only offered once something has gone wrong. A misconfigured gateway
      // would otherwise be a dead end: the panel is locked, and Settings is
      // the one place the operator can correct it from.
      elements.settings.textContent = copy(lang, 'openSettings');
      elements.settings.classList.toggle('hidden', !notice || Boolean(busyAction));
    }
  }

  function openSettings() {
    const url = api?.runtime?.getURL?.('src/ui/settings.html#providers');
    if (url && api?.tabs?.create) {
      void api.tabs.create({ url });
      return;
    }
    api?.runtime?.openOptionsPage?.();
  }

  function lock() {
    locked = true;
    root.classList.remove('hidden');
    root.removeAttribute('aria-hidden');
    if (appRoot) {
      appRoot.inert = true;
      appRoot.setAttribute('aria-hidden', 'true');
    }
    documentRef?.body?.classList.add('agentx-locked');
  }

  function unlock() {
    locked = false;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    if (appRoot) {
      appRoot.inert = false;
      appRoot.removeAttribute('aria-hidden');
    }
    documentRef?.body?.classList.remove('agentx-locked');
  }

  function relock(reasonKey) {
    if (locked) return;
    busyAction = '';
    // Whoever gated on the first unlock has long since continued, so hand out a
    // fresh promise rather than reusing the settled one.
    unlocked = new Promise((resolve) => { resolveUnlocked = resolve; });
    lock();
    void restore({ reasonKey });
  }

  /**
   * Runs the operation and installs its credential, but only lets the CURRENT
   * attempt unlock. A stale attempt (superseded by retry, or already timed
   * out) may finish its work silently — the provider it installed makes the
   * next attempt fast — yet it must never flip the UI under the live one.
   */
  async function connect(operation, attempt) {
    const result = await operation();
    if (attempt !== attemptSeq) return;
    await installCloudCredential(boundedSendToBackground, result.credential);
    if (attempt !== attemptSeq) return;
    notice = '';
    busyAction = '';
    unlock();
    render();
    startWatching();
    resolveUnlocked();
    // Phase 4: a freshly unlocked panel is the moment to pull what the hub
    // recorded while it was closed (plan §2.6: poll when the side panel opens).
    Promise.resolve()
      .then(() => sendToBackground('agentx_hub_sync', { reason: 'panel' }))
      .catch(() => {});
  }

  async function restore({ reasonKey = '' } = {}) {
    const attempt = ++attemptSeq;
    busyAction = 'checking';
    // The reason survives the status re-read: whatever cleared the session has
    // already done so, so the second read reports a plain "needs login" and
    // would otherwise wipe the explanation the user needs to see.
    notice = reasonKey ? copy(locale(), reasonKey) : '';
    render();
    // The watchdog for everything the per-call timeouts cannot see (a hung
    // storage read, a promise that never settles). It retires this attempt and
    // brings the retry button back instead of spinning forever.
    const deadlineId = setTimer(() => {
      if (attempt !== attemptSeq || !locked) return;
      attemptSeq += 1;
      busyAction = '';
      notice = copy(locale(), 'request_timeout');
      render();
      try {
        console.error('[AgentX] sign-in restore timed out; showing retry');
      } catch { /* ignore */ }
    }, restoreTimeoutMs);
    try {
      const status = await service.publicStatus();
      if (attempt !== attemptSeq) return;
      if (!status.signedIn) {
        busyAction = '';
        if (!notice && status.idleExpired) notice = copy(locale(), 'idleExpired');
        render();
        return;
      }
      busyAction = 'provisioning';
      render();
      await connect(() => service.retryProvision(), attempt);
    } catch (error) {
      if (attempt !== attemptSeq) return;
      busyAction = '';
      notice = errorMessage(error, locale());
      render();
    } finally {
      clearTimer(deadlineId);
    }
  }

  async function signIn() {
    if (busyAction) return;
    // Supersede any still-running restore so it cannot unlock mid-sign-in.
    const attempt = ++attemptSeq;
    busyAction = 'signingIn';
    notice = '';
    render();
    // The interactive window already self-limits at authTimeoutMs; the margin
    // covers the provisioning tail. This only catches true hangs — awaits
    // that never settle — which no inner timeout can reach.
    const deadlineId = setTimer(() => {
      if (attempt !== attemptSeq || !locked) return;
      attemptSeq += 1;
      busyAction = '';
      notice = copy(locale(), 'request_timeout');
      render();
      try {
        console.error('[AgentX] sign-in timed out; showing retry');
      } catch { /* ignore */ }
    }, (Number(config.authTimeoutMs) || 5 * 60_000) + 90_000);
    try {
      await connect(() => service.signInAndProvision(), attempt);
    } catch (error) {
      if (attempt !== attemptSeq) return;
      busyAction = '';
      notice = errorMessage(error, locale());
      render();
    } finally {
      clearTimer(deadlineId);
    }
  }

  async function checkSession() {
    if (locked || busyAction) return;
    let status;
    try {
      status = await service.publicStatus();
    } catch {
      // A transient identity outage keeps the existing key working; the panel
      // must not throw the user out over one failed poll.
      return;
    }
    if (!status.signedIn) relock(status.idleExpired ? 'idleExpired' : 'needs_login');
  }

  // Idle expiry only bites if something records the activity. The panel
  // document is the one surface the user actually touches, so it is what we
  // listen to.
  function startWatching() {
    if (watching) return;
    watching = true;

    const touch = () => { void service.touchSession(); };
    for (const event of ACTIVITY_EVENTS) {
      documentRef?.addEventListener(event, touch, { capture: true, passive: true });
      teardown.push(() => documentRef?.removeEventListener(event, touch, { capture: true }));
    }

    const onVisible = () => {
      if (documentRef?.visibilityState === 'visible') void checkSession();
    };
    documentRef?.addEventListener('visibilitychange', onVisible);
    teardown.push(() => documentRef?.removeEventListener('visibilitychange', onVisible));

    pollTimer = setInterval(() => { void checkSession(); }, SESSION_POLL_INTERVAL_MS);
    watchStorage();
  }

  // The session record can change under an open panel in both directions:
  // a sign-out from Settings, and — since Workmate can sign the extension in
  // from the background (`auth_hint`, silent SSO) — a sign-in while this panel
  // sits locked on "Đăng nhập để bắt đầu". So the listener is armed from
  // start(), not only after the first unlock.
  function watchStorage() {
    if (watchingStorage) return;
    watchingStorage = true;
    const onStorage = (changes, area) => {
      if (area !== 'local' || !(AGENTX_SESSION_STORAGE_KEY in changes)) return;
      if (changes[AGENTX_SESSION_STORAGE_KEY].newValue) {
        // Signed in elsewhere. A locked, idle panel picks the session up now
        // instead of on its next visibility change; an unlocked one already
        // holds a working key and needs nothing.
        if (locked && !busyAction) void restore();
        return;
      }
      if (locked) return;
      // The sign-out happened in another document, so this one still holds the
      // session in memory. Drop it first or the relock would re-provision from
      // the stale copy and unlock again straight away.
      void service.clearSession().then(() => relock('signedOutElsewhere'));
    };
    api?.storage?.onChanged?.addListener?.(onStorage);
    teardown.push(() => {
      api?.storage?.onChanged?.removeListener?.(onStorage);
      watchingStorage = false;
    });
  }

  elements.button?.addEventListener('click', () => { void signIn(); });
  elements.settings?.addEventListener('click', openSettings);

  return {
    /** Resolves once the panel is signed in and the cloud provider is active. */
    start() {
      if (unlocked) return unlocked;
      unlocked = new Promise((resolve) => { resolveUnlocked = resolve; });
      lock();
      render();
      watchStorage();
      void restore();
      return unlocked;
    },
    /** Releases timers and listeners. Used by tests and by panel teardown. */
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      for (const off of teardown.splice(0)) off();
      watching = false;
    },
    isLocked() {
      return locked;
    },
    /** Test seam: drives the same check the poll and visibility hooks run. */
    checkSession,
  };
}
