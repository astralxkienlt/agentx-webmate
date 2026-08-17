const COPY = {
  en: {
    eyebrow: 'ACCOUNT CONNECTION',
    titleSignedOut: 'Sign in to use AgentX WebMate Cloud',
    bodySignedOut: 'Your browser opens the organization’s Keycloak sign-in page. AgentX WebMate never receives your password.',
    signIn: 'Sign in to AgentX',
    signingIn: 'Opening secure sign-in…',
    restoring: 'Restoring your secure session…',
    provisioning: 'Creating your Cloud connection…',
    signedInNotConnected: 'Your identity is verified. Finish connecting the model gateway.',
    retry: 'Connect gateway',
    retrying: 'Connecting gateway…',
    connected: 'Connected',
    sessionOffline: 'Identity refresh is temporarily unavailable. Your existing model key is still active and has not been replaced.',
    persistenceWarning: 'This browser could not persist the refreshed session. Cloud works until the extension restarts.',
    gateway: 'Gateway',
    model: 'Active model',
    chooseModel: 'Choose active model',
    switchingModel: 'Switching model…',
    device: 'This device',
    account: 'Account',
    modelsAvailable: '{count} models available',
    test: 'Test connection',
    testing: 'Testing connection…',
    testPassed: 'Connection verified with {model}.',
    signOut: 'Sign out',
    signingOut: 'Signing out…',
    keyProtected: 'The model key is stored locally and is never displayed in Settings.',
    needs_login: 'Your session is no longer valid. Sign in again; AgentX WebMate will fetch the account’s current key without rotating it.',
    invalid_token: 'Second Brain rejected the identity token. Sign in again.',
    missing_bearer: 'The identity request did not include a valid bearer token. Sign in again.',
    device_revoked: 'This device has been revoked. The saved model key was kept, but Cloud is disconnected until you sign in again.',
    identity_unavailable: 'Keycloak verification is temporarily unavailable. The current model key was kept.',
    store_unavailable: 'Second Brain storage is temporarily unavailable. The current model key was kept.',
    litellm_unavailable: 'LiteLLM is temporarily unavailable. The current model key was kept.',
    litellm_unconfigured: 'Second Brain has no LiteLLM admin key. Ask the operator to finish the server configuration.',
    key_unreadable: 'Second Brain could not decrypt the saved key. The current local key was kept.',
    sign_in_cancelled: 'Sign-in was cancelled before it completed.',
    sign_in_timeout: 'Sign-in exceeded five minutes. Start the flow again.',
    genericError: 'Cloud connection failed. {detail}',
  },
  vi: {
    eyebrow: 'KẾT NỐI TÀI KHOẢN',
    titleSignedOut: 'Đăng nhập để dùng AgentX WebMate Cloud',
    bodySignedOut: 'Trình duyệt sẽ mở trang đăng nhập Keycloak của tổ chức. AgentX WebMate không bao giờ nhận mật khẩu của bạn.',
    signIn: 'Đăng nhập AgentX',
    signingIn: 'Đang mở đăng nhập bảo mật…',
    restoring: 'Đang khôi phục phiên bảo mật…',
    provisioning: 'Đang tạo kết nối Cloud…',
    signedInNotConnected: 'Danh tính đã được xác minh. Hãy hoàn tất kết nối tới model gateway.',
    retry: 'Kết nối gateway',
    retrying: 'Đang kết nối gateway…',
    connected: 'Đã kết nối',
    sessionOffline: 'Tạm thời chưa thể làm mới danh tính. Model key hiện có vẫn được giữ nguyên và tiếp tục hoạt động.',
    persistenceWarning: 'Trình duyệt không thể lưu phiên vừa làm mới. Cloud vẫn hoạt động cho tới khi extension khởi động lại.',
    gateway: 'Gateway',
    model: 'Model đang dùng',
    chooseModel: 'Chọn model đang dùng',
    switchingModel: 'Đang đổi model…',
    device: 'Thiết bị này',
    account: 'Tài khoản',
    modelsAvailable: 'Có {count} model khả dụng',
    test: 'Kiểm tra kết nối',
    testing: 'Đang kiểm tra kết nối…',
    testPassed: 'Đã xác minh kết nối với {model}.',
    signOut: 'Đăng xuất',
    signingOut: 'Đang đăng xuất…',
    keyProtected: 'Model key được lưu cục bộ và không bao giờ hiển thị trong Cài đặt.',
    needs_login: 'Phiên đăng nhập không còn hợp lệ. Hãy đăng nhập lại; AgentX WebMate sẽ lấy key hiện tại của tài khoản và không tự xoay key.',
    invalid_token: 'Second Brain từ chối identity token. Hãy đăng nhập lại.',
    missing_bearer: 'Yêu cầu danh tính không có bearer token hợp lệ. Hãy đăng nhập lại.',
    device_revoked: 'Thiết bị này đã bị thu hồi. Model key đã lưu vẫn được giữ, nhưng Cloud bị ngắt cho tới khi bạn đăng nhập lại.',
    identity_unavailable: 'Keycloak tạm thời không thể xác minh danh tính. Model key hiện tại vẫn được giữ.',
    store_unavailable: 'Kho dữ liệu Second Brain tạm thời chưa sẵn sàng. Model key hiện tại vẫn được giữ.',
    litellm_unavailable: 'LiteLLM tạm thời chưa sẵn sàng. Model key hiện tại vẫn được giữ.',
    litellm_unconfigured: 'Second Brain chưa có LiteLLM admin key. Hãy yêu cầu quản trị viên hoàn tất cấu hình server.',
    key_unreadable: 'Second Brain không thể giải mã key đã lưu. Model key cục bộ hiện tại vẫn được giữ.',
    sign_in_cancelled: 'Đăng nhập đã bị huỷ trước khi hoàn tất.',
    sign_in_timeout: 'Đăng nhập vượt quá năm phút. Hãy bắt đầu lại.',
    genericError: 'Kết nối Cloud thất bại. {detail}',
  },
};

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function displayHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return String(value || '—');
  }
}

function actionLabel(status, locale) {
  if (['sign-in', 'signing-in'].includes(status.action)) return copy(locale, 'signingIn');
  if (status.action === 'restoring') return copy(locale, 'restoring');
  if (status.action === 'provisioning') return copy(locale, 'provisioning');
  if (['retry', 'retrying'].includes(status.action)) return copy(locale, 'retrying');
  if (['test', 'testing'].includes(status.action)) return copy(locale, 'testing');
  if (status.action === 'selecting-model') return copy(locale, 'switchingModel');
  if (['sign-out', 'signing-out'].includes(status.action)) return copy(locale, 'signingOut');
  return '';
}

function errorMessage(status, locale) {
  const errorCode = status.errorCode || status.error?.code;
  if (!errorCode) return '';
  const translated = COPY[language(locale)][errorCode] || COPY.en[errorCode];
  if (translated) return translated;
  return copy(locale, 'genericError', {
    detail: status.errorMessage || status.error?.message || errorCode,
  });
}

function renderNotice(kind, message) {
  if (!message) return '';
  const icon = kind === 'error' ? '!' : kind === 'success' ? '✓' : 'i';
  const role = kind === 'error' ? 'alert' : 'status';
  return `
    <div class="agentx-cloud-notice agentx-cloud-notice-${kind}" role="${role}">
      <span class="agentx-cloud-notice-icon" aria-hidden="true">${icon}</span>
      <span>${escapeHtml(message)}</span>
    </div>`;
}

function renderBusy(status, locale) {
  if (!status.action) return '';
  return `
    <div class="agentx-cloud-progress" role="status" aria-live="polite">
      <span class="agentx-cloud-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(actionLabel(status, locale))}</span>
    </div>`;
}

function renderSignedOut(status, locale) {
  return `
    <section class="agentx-cloud-auth" aria-labelledby="agentx-cloud-auth-title">
      <div class="agentx-cloud-copy">
        <div class="agentx-cloud-eyebrow">${escapeHtml(copy(locale, 'eyebrow'))}</div>
        <h3 id="agentx-cloud-auth-title">${escapeHtml(copy(locale, 'titleSignedOut'))}</h3>
        <p>${escapeHtml(copy(locale, 'bodySignedOut'))}</p>
      </div>
      ${renderNotice('error', errorMessage(status, locale))}
      ${renderBusy(status, locale)}
      <div class="agentx-cloud-actions">
        <button
          type="button"
          class="btn-primary agentx-cloud-button"
          data-agentx-cloud-action="sign-in"
          ${status.action ? 'disabled aria-disabled="true"' : ''}
        >${escapeHtml(copy(locale, 'signIn'))}</button>
      </div>
    </section>`;
}

function renderConnectionDetails(status, locale) {
  const provider = status.provider || {};
  const user = status.user || {};
  const account = provider.account || user.email || user.subject || '—';
  const models = Array.isArray(provider.models)
    ? [...new Set(provider.models.map(String).map((model) => model.trim()).filter(Boolean))]
    : [];
  const modelCount = models.length || Number(provider.modelCount) || (provider.model ? 1 : 0);
  const modelControl = models.length > 1
    ? `
      <select
        class="agentx-cloud-model-select"
        data-agentx-cloud-model
        aria-label="${escapeHtml(copy(locale, 'chooseModel'))}"
        ${status.action ? 'disabled aria-disabled="true"' : ''}
      >
        ${models.map((model) => `
          <option value="${escapeHtml(model)}" ${model === provider.model ? 'selected' : ''}>
            ${escapeHtml(model)}
          </option>`).join('')}
      </select>`
    : `<code>${escapeHtml(provider.model || models[0] || '—')}</code>`;
  return `
    <dl class="agentx-cloud-details">
      <div>
        <dt>${escapeHtml(copy(locale, 'account'))}</dt>
        <dd>${escapeHtml(account)}</dd>
      </div>
      <div>
        <dt>${escapeHtml(copy(locale, 'gateway'))}</dt>
        <dd><code>${escapeHtml(displayHost(provider.baseUrl || status.configuredLiteLlmBaseUrl))}</code></dd>
      </div>
      <div>
        <dt>${escapeHtml(copy(locale, 'model'))}</dt>
        <dd>
          ${modelControl}
          ${modelCount > 0
            ? `<small>${escapeHtml(copy(locale, 'modelsAvailable', { count: modelCount }))}</small>`
            : ''}
        </dd>
      </div>
      <div>
        <dt>${escapeHtml(copy(locale, 'device'))}</dt>
        <dd>${escapeHtml(status.device?.name || 'AgentX WebMate')}</dd>
      </div>
    </dl>`;
}

function renderSignedIn(status, locale) {
  const connected = status.connected === true;
  const user = status.user || {};
  const title = user.displayName || user.email || copy(locale, 'connected');
  const offline = status.outcome === 'stale-offline';
  const testMessage = status.testOk
    ? copy(locale, 'testPassed', { model: status.testModel || status.provider?.model || 'model' })
    : '';
  return `
    <section class="agentx-cloud-auth" aria-labelledby="agentx-cloud-account-title">
      <header class="agentx-cloud-account">
        <span class="agentx-cloud-status-mark" aria-hidden="true">${connected ? '✓' : '•'}</span>
        <span class="agentx-cloud-account-copy">
          <strong id="agentx-cloud-account-title">${escapeHtml(title)}</strong>
          ${user.email && user.email !== title ? `<span>${escapeHtml(user.email)}</span>` : ''}
        </span>
        <span class="agentx-cloud-connection-label" data-state="${connected ? 'connected' : 'pending'}">
          ${escapeHtml(connected ? copy(locale, 'connected') : copy(locale, 'retry'))}
        </span>
      </header>
      ${connected ? renderConnectionDetails(status, locale) : `
        <p class="agentx-cloud-pending">${escapeHtml(copy(locale, 'signedInNotConnected'))}</p>
      `}
      ${offline ? renderNotice('warning', copy(locale, 'sessionOffline')) : ''}
      ${status.persistenceWarning ? renderNotice('warning', copy(locale, 'persistenceWarning')) : ''}
      ${renderNotice('error', errorMessage(status, locale))}
      ${renderNotice('success', testMessage)}
      ${renderBusy(status, locale)}
      <p class="agentx-cloud-key-note">${escapeHtml(copy(locale, 'keyProtected'))}</p>
      <div class="agentx-cloud-actions">
        ${connected ? `
          <button
            type="button"
            class="btn-secondary agentx-cloud-button"
            data-agentx-cloud-action="test"
            ${status.action ? 'disabled aria-disabled="true"' : ''}
          >${escapeHtml(copy(locale, 'test'))}</button>
        ` : `
          <button
            type="button"
            class="btn-primary agentx-cloud-button"
            data-agentx-cloud-action="retry"
            ${status.action ? 'disabled aria-disabled="true"' : ''}
          >${escapeHtml(copy(locale, 'retry'))}</button>
        `}
        <button
          type="button"
          class="btn-secondary agentx-cloud-button agentx-cloud-sign-out"
          data-agentx-cloud-action="sign-out"
          ${status.action ? 'disabled aria-disabled="true"' : ''}
        >${escapeHtml(copy(locale, 'signOut'))}</button>
      </div>
    </section>`;
}

export function renderAgentXCloudPanel(status = {}, locale = 'en') {
  return status.signedIn
    ? renderSignedIn(status, locale)
    : renderSignedOut(status, locale);
}

export function bindAgentXCloudPanel(root, onAction) {
  if (!root || typeof onAction !== 'function') return;
  root.querySelectorAll('[data-agentx-cloud-action]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      onAction(button.dataset.agentxCloudAction);
    });
  });
  const modelSelect = root.querySelector?.('[data-agentx-cloud-model]');
  modelSelect?.addEventListener('change', () => {
    if (modelSelect.disabled) return;
    onAction('select-model', { model: modelSelect.value });
  });
}
