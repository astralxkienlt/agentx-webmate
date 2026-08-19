import { AGENTX_RUNTIME_CONFIG } from '../agentx/runtime-config.js';
import {
  AGENTX_SESSION_STORAGE_KEY,
  createAgentXCloudService,
} from '../agentx/cloud-service.js';
import { installCloudCredential } from '../agentx/cloud-provider-install.js';

const COPY = {
  en: {
    eyebrow: 'netMind Extension',
    title: 'Sign in to start',
    body: 'Turn your browser into an AI browser',
    checking: 'Checking your session…',
    signIn: 'Sign in with Viettel SSO',
    signingIn: 'Opening secure sign-in…',
    provisioning: 'Preparing your model connection…',
    retry: 'Try again',
    credit: 'Developed by Trung tâm Nền tảng công nghệ & Chuyển đổi số',
    idleExpired: 'You were signed out after a period of inactivity. Sign in again to continue.',
    signedOutElsewhere: 'You signed out of netMind. Sign in again to keep using the panel.',
    needs_login: 'Your session is no longer valid. Sign in again to continue.',
    invalid_token: 'Second Brain rejected the identity token. Sign in again.',
    missing_bearer: 'The identity request did not include a valid bearer token. Sign in again.',
    device_revoked: 'This device has been revoked. Sign in again to reconnect.',
    identity_unavailable: 'Viettel SSO verification is temporarily unavailable. Try again in a moment.',
    store_unavailable: 'Second Brain storage is temporarily unavailable. Try again in a moment.',
    litellm_unavailable: 'LiteLLM is temporarily unavailable. Try again in a moment.',
    litellm_unconfigured: 'Second Brain has no LiteLLM admin key. Ask the operator to finish the server configuration.',
    key_unreadable: 'Second Brain could not decrypt the saved key. Sign in again.',
    gateway_models_empty: 'The gateway returned no models for this account. Ask the operator to grant model access.',
    sign_in_cancelled: 'Sign-in was cancelled before it completed.',
    sign_in_timeout: 'Sign-in exceeded five minutes. Start the flow again.',
    network_unavailable: 'Could not reach the service. Check your connection and try again.',
    request_timeout: 'The service took too long to answer. Try again.',
    genericError: 'Sign-in failed. {detail}',
  },
  vi: {
    eyebrow: 'netMind Extension',
    title: 'Đăng nhập để bắt đầu',
    body: 'Biến trình duyệt của bạn thành trình duyệt AI',
    checking: 'Đang kiểm tra phiên đăng nhập…',
    signIn: 'Đăng nhập bằng Viettel SSO',
    signingIn: 'Đang mở trang đăng nhập bảo mật…',
    provisioning: 'Đang chuẩn bị kết nối mô hình…',
    retry: 'Thử lại',
    credit: 'Được phát triển bởi Trung tâm Nền tảng công nghệ & Chuyển đổi số',
    idleExpired: 'Bạn đã bị đăng xuất sau một thời gian không dùng. Hãy đăng nhập lại để tiếp tục.',
    signedOutElsewhere: 'Bạn vừa đăng xuất khỏi netMind. Hãy đăng nhập lại để dùng tiếp.',
    needs_login: 'Phiên đăng nhập không còn hợp lệ. Hãy đăng nhập lại để tiếp tục.',
    invalid_token: 'Second Brain từ chối token đăng nhập. Hãy đăng nhập lại.',
    missing_bearer: 'Yêu cầu xác minh tài khoản thiếu bearer token hợp lệ. Hãy đăng nhập lại.',
    device_revoked: 'Thiết bị này đã bị thu hồi. Hãy đăng nhập lại để kết nối.',
    identity_unavailable: 'Viettel SSO tạm thời không xác minh được tài khoản. Hãy thử lại sau ít phút.',
    store_unavailable: 'Kho dữ liệu Second Brain tạm thời chưa sẵn sàng. Hãy thử lại sau ít phút.',
    litellm_unavailable: 'LiteLLM tạm thời chưa sẵn sàng. Hãy thử lại sau ít phút.',
    litellm_unconfigured: 'Second Brain chưa có khóa quản trị LiteLLM. Hãy nhờ quản trị viên hoàn tất cấu hình máy chủ.',
    key_unreadable: 'Second Brain không giải mã được khóa đã lưu. Hãy đăng nhập lại.',
    gateway_models_empty: 'Cổng mô hình chưa cấp mô hình nào cho tài khoản này. Hãy nhờ quản trị viên cấp quyền.',
    sign_in_cancelled: 'Đăng nhập bị hủy giữa chừng.',
    sign_in_timeout: 'Quá 5 phút chưa đăng nhập xong. Hãy làm lại từ đầu.',
    network_unavailable: 'Không kết nối được dịch vụ. Hãy kiểm tra mạng rồi thử lại.',
    request_timeout: 'Dịch vụ trả lời quá lâu. Hãy thử lại.',
    genericError: 'Đăng nhập không thành công. {detail}',
  },
};

// Cheap enough to run on every pointer press: the service itself throttles the
// storage write, this only decides whether to bother calling it.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'focusin'];
const SESSION_POLL_INTERVAL_MS = 60_000;

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
} = {}) {
  if (!root) throw new TypeError('root element is required');
  if (typeof sendToBackground !== 'function') {
    throw new TypeError('sendToBackground is required');
  }

  const service = createAgentXCloudService({ ...serviceOptions, api, config });
  const elements = {
    eyebrow: root.querySelector('[data-agentx-gate-eyebrow]'),
    title: root.querySelector('[data-agentx-gate-title]'),
    body: root.querySelector('[data-agentx-gate-body]'),
    notice: root.querySelector('[data-agentx-gate-notice]'),
    busy: root.querySelector('[data-agentx-gate-busy]'),
    busyLabel: root.querySelector('[data-agentx-gate-busy-label]'),
    button: root.querySelector('[data-agentx-gate-signin]'),
    footnote: root.querySelector('[data-agentx-gate-footnote]'),
  };

  let locked = true;
  let unlocked = null;
  let resolveUnlocked = () => {};
  let busyAction = '';
  let notice = '';
  let watching = false;
  let pollTimer = null;
  const teardown = [];

  function render() {
    const lang = locale();
    if (elements.eyebrow) elements.eyebrow.textContent = copy(lang, 'eyebrow');
    if (elements.title) elements.title.textContent = copy(lang, 'title');
    if (elements.body) elements.body.textContent = copy(lang, 'body');
    if (elements.footnote) elements.footnote.textContent = copy(lang, 'credit');
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

  async function connect(operation) {
    const result = await operation();
    await installCloudCredential(sendToBackground, result.credential);
    notice = '';
    busyAction = '';
    unlock();
    render();
    startWatching();
    resolveUnlocked();
  }

  async function restore({ reasonKey = '' } = {}) {
    busyAction = 'checking';
    // The reason survives the status re-read: whatever cleared the session has
    // already done so, so the second read reports a plain "needs login" and
    // would otherwise wipe the explanation the user needs to see.
    notice = reasonKey ? copy(locale(), reasonKey) : '';
    render();
    try {
      const status = await service.publicStatus();
      if (!status.signedIn) {
        busyAction = '';
        if (!notice && status.idleExpired) notice = copy(locale(), 'idleExpired');
        render();
        return;
      }
      busyAction = 'provisioning';
      render();
      await connect(() => service.retryProvision());
    } catch (error) {
      busyAction = '';
      notice = errorMessage(error, locale());
      render();
    }
  }

  async function signIn() {
    if (busyAction) return;
    busyAction = 'signingIn';
    notice = '';
    render();
    try {
      await connect(() => service.signInAndProvision());
    } catch (error) {
      busyAction = '';
      notice = errorMessage(error, locale());
      render();
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

    const onStorage = (changes, area) => {
      if (area !== 'local' || !(AGENTX_SESSION_STORAGE_KEY in changes)) return;
      if (changes[AGENTX_SESSION_STORAGE_KEY].newValue) return;
      // The sign-out happened in another document, so this one still holds the
      // session in memory. Drop it first or the relock would re-provision from
      // the stale copy and unlock again straight away.
      void service.clearSession().then(() => relock('signedOutElsewhere'));
    };
    api?.storage?.onChanged?.addListener?.(onStorage);
    teardown.push(() => api?.storage?.onChanged?.removeListener?.(onStorage));
  }

  elements.button?.addEventListener('click', () => { void signIn(); });

  return {
    /** Resolves once the panel is signed in and the cloud provider is active. */
    start() {
      if (unlocked) return unlocked;
      unlocked = new Promise((resolve) => { resolveUnlocked = resolve; });
      lock();
      render();
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
