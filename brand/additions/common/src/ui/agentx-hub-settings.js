// Settings → Skills → "AgentX Hub" (plan Phase 4, item 5).
//
// The card searches the hub's browser-skill catalog, installs and removes
// skills, shows which enabled skills came from the hub (and which of those
// the person edited by hand), and the sync status. Installs and removals go
// through the background (`agentx_hub_install` / `agentx_hub_uninstall`) so
// the background stays the only writer of hub-managed `customSkills`; search
// and preview read the hub directly with the shared client.
import { AGENTX_RUNTIME_CONFIG } from '../agentx/runtime-config.js';
import {
  createAgentXHubClient,
  hubSkillPageUrl,
  publicHubError,
  readHubConfig,
  writeHubConfig,
} from '../agentx/hub-client.js';
import { AGENTX_HUB_SYNC_STATE_KEY } from '../agentx/hub-sync.js';
import { CUSTOM_SKILLS_STORAGE_KEY } from '../agent/skills.js';
import { escapeHtml } from './utils.js';

const COPY = {
  en: {
    title: 'AgentX Skill Hub',
    intro: 'Browser skills scanned and signed by the AgentX Skill Hub. Install here or from the hub website; installs, updates and removals follow your account across devices.',
    signedInAs: 'Signed in as {who}',
    signedOut: 'Sign in on the Providers tab to install from the hub. The public catalog is still searchable.',
    hub: 'Hub',
    lastSync: 'Last sync: {when}',
    never: 'never',
    syncNow: 'Sync now',
    syncing: 'Syncing…',
    status_synced: 'up to date',
    status_offline: 'hub unreachable — installed skills keep working',
    status_reauth: 'session rejected — sign in again',
    status_not_signed_in: 'not signed in',
    status_error: 'error',
    status_never: 'not synced yet',
    searchLabel: 'Search the catalog',
    searchPlaceholder: 'Name, description, tag…',
    search: 'Search',
    searching: 'Searching…',
    noResults: 'No browser skill matches.',
    install: 'Install',
    installing: 'Installing…',
    installed: 'Installed v{version}',
    update: 'Update to v{version}',
    reinstall: 'Reinstall (replaces your edits)',
    reinstallConfirm: 'You edited this skill by hand. Reinstalling replaces your copy with the hub version. Continue?',
    remove: 'Remove',
    removing: 'Removing…',
    open: 'Open on hub',
    installedHeading: 'Skills from the hub',
    installedEmpty: 'No skill from the hub yet.',
    fromHub: 'AgentX Hub',
    editedFromHub: 'Edited from AgentX Hub',
    editedNote: 'edited by hand — not updated automatically',
    updateAvailable: 'v{version} available',
    disabledNote: 'switched off by the hub{reason}',
    parkedHeading: 'Switched off (kept, not loaded)',
    failedNote: 'last install failed: {code}',
    orgHeading: 'Your organisation',
    verdict_safe: 'safe',
    verdict_caution: 'caution',
    verdict_dangerous: 'dangerous',
    visibility_public: 'public',
    visibility_org: 'organisation',
    visibility_private: 'private',
    installedMessage: 'Installed {name} v{version}. It is ready for the next run.',
    removedMessage: 'Removed {name}.',
    advanced: 'Advanced',
    hubUrlLabel: 'Hub address',
    hubUrlHint: 'HTTPS only (HTTP allowed for 127.0.0.1 / localhost). Leave empty to use the default.',
    hubUrlSave: 'Save',
    hubUrlReset: 'Use default',
    hubUrlSaved: 'Hub address saved. Syncing…',
    externalChannel: 'One-click install from the hub website: available',
    externalChannelMissing: 'One-click install from the hub website is not available in this browser — use "Import from URL" with the link the hub shows.',
    error_not_signed_in: 'Sign in to AgentX (Providers tab) first.',
    error_network_unavailable: 'Could not reach the hub. Check your connection and try again.',
    error_request_timeout: 'The hub took too long to answer. Try again.',
    error_invalid_token: 'The hub rejected your session. Sign in again on the Providers tab.',
    error_identity_unavailable: 'The identity provider is temporarily unavailable. Try again in a moment.',
    error_hub_unavailable: 'The hub is temporarily unavailable.',
    error_skill_not_found: 'That skill is not on the hub (or not visible to you).',
    error_not_published: 'That skill has no published version yet.',
    error_skill_limit_reached: 'WebMate keeps at most {max} skills. Remove one first.',
    error_kind_mismatch: 'That is not a browser skill.',
    error_background_unavailable: 'The extension background did not respond. Try again.',
    error_generic: 'The hub request failed ({code}).',
  },
  vi: {
    title: 'AgentX Skill Hub',
    intro: 'Kỹ năng trình duyệt đã được AgentX Skill Hub quét và ký. Cài ở đây hoặc từ trang hub; việc cài, cập nhật, gỡ theo tài khoản của bạn trên mọi thiết bị.',
    signedInAs: 'Đang đăng nhập: {who}',
    signedOut: 'Đăng nhập ở tab Nhà cung cấp để cài từ hub. Danh mục công khai vẫn tìm được.',
    hub: 'Hub',
    lastSync: 'Đồng bộ lần cuối: {when}',
    never: 'chưa bao giờ',
    syncNow: 'Đồng bộ ngay',
    syncing: 'Đang đồng bộ…',
    status_synced: 'đã cập nhật',
    status_offline: 'không tới được hub — kỹ năng đã cài vẫn dùng bình thường',
    status_reauth: 'phiên bị từ chối — hãy đăng nhập lại',
    status_not_signed_in: 'chưa đăng nhập',
    status_error: 'lỗi',
    status_never: 'chưa đồng bộ',
    searchLabel: 'Tìm trong danh mục',
    searchPlaceholder: 'Tên, mô tả, tag…',
    search: 'Tìm',
    searching: 'Đang tìm…',
    noResults: 'Không có kỹ năng trình duyệt nào khớp.',
    install: 'Cài',
    installing: 'Đang cài…',
    installed: 'Đã cài v{version}',
    update: 'Cập nhật lên v{version}',
    reinstall: 'Cài lại (ghi đè bản đã sửa)',
    reinstallConfirm: 'Bạn đã sửa tay kỹ năng này. Cài lại sẽ thay bản của bạn bằng bản trên hub. Tiếp tục?',
    remove: 'Gỡ',
    removing: 'Đang gỡ…',
    open: 'Mở trên hub',
    installedHeading: 'Kỹ năng từ hub',
    installedEmpty: 'Chưa có kỹ năng nào từ hub.',
    fromHub: 'Từ AgentX Hub',
    editedFromHub: 'Đã sửa từ AgentX Hub',
    editedNote: 'đã sửa tay — không tự cập nhật',
    updateAvailable: 'có bản v{version}',
    disabledNote: 'hub đã tắt{reason}',
    parkedHeading: 'Đã tắt (giữ nội dung, không nạp)',
    failedNote: 'lần cài gần nhất lỗi: {code}',
    orgHeading: 'Tổ chức của bạn',
    verdict_safe: 'an toàn',
    verdict_caution: 'cần chú ý',
    verdict_dangerous: 'nguy hiểm',
    visibility_public: 'công khai',
    visibility_org: 'tổ chức',
    visibility_private: 'riêng tư',
    installedMessage: 'Đã cài {name} v{version}. Dùng được ngay ở lượt chạy kế tiếp.',
    removedMessage: 'Đã gỡ {name}.',
    advanced: 'Nâng cao',
    hubUrlLabel: 'Địa chỉ hub',
    hubUrlHint: 'Chỉ HTTPS (cho phép HTTP với 127.0.0.1 / localhost). Để trống để dùng mặc định.',
    hubUrlSave: 'Lưu',
    hubUrlReset: 'Dùng mặc định',
    hubUrlSaved: 'Đã lưu địa chỉ hub. Đang đồng bộ…',
    externalChannel: 'Cài một chạm từ trang hub: sẵn sàng',
    externalChannelMissing: 'Trình duyệt này không có kênh cài một chạm từ trang hub — dùng "Nhập từ URL" với liên kết hub hiển thị.',
    error_not_signed_in: 'Hãy đăng nhập AgentX (tab Nhà cung cấp) trước.',
    error_network_unavailable: 'Không kết nối được hub. Kiểm tra mạng rồi thử lại.',
    error_request_timeout: 'Hub trả lời quá lâu. Hãy thử lại.',
    error_invalid_token: 'Hub từ chối phiên đăng nhập. Hãy đăng nhập lại ở tab Nhà cung cấp.',
    error_identity_unavailable: 'Máy chủ định danh tạm thời không tới được. Thử lại sau ít phút.',
    error_hub_unavailable: 'Hub tạm thời chưa sẵn sàng.',
    error_skill_not_found: 'Kỹ năng này không có trên hub (hoặc bạn không được xem).',
    error_not_published: 'Kỹ năng này chưa có phiên bản xuất bản.',
    error_skill_limit_reached: 'WebMate chỉ giữ tối đa {max} kỹ năng. Hãy gỡ bớt trước.',
    error_kind_mismatch: 'Đây không phải kỹ năng trình duyệt.',
    error_background_unavailable: 'Nền tiện ích không phản hồi. Hãy thử lại.',
    error_generic: 'Yêu cầu tới hub thất bại ({code}).',
  },
};

function copy(lang, key, params = {}) {
  const dict = COPY[lang] || COPY.en;
  let text = dict[key] ?? COPY.en[key] ?? key;
  for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value ?? ''));
  return text;
}

function pickLang(locale) {
  const code = String(typeof locale === 'function' ? locale() : locale || 'en').slice(0, 2).toLowerCase();
  return COPY[code] ? code : 'en';
}

/** "AgentX Hub · slug@version" for hub records; "Edited from AgentX Hub (slug@version)" for demoted copies; '' otherwise. */
export function agentxHubSourceLabel(skill, locale = 'en') {
  if (!skill || !skill.hubSlug) return '';
  const lang = pickLang(locale);
  const ref = `${skill.hubSlug}@${skill.hubVersion || '?'}`;
  if (skill.sourceType === 'hub') return `${copy(lang, 'fromHub')} · ${ref}`;
  return `${copy(lang, 'editedFromHub')} (${ref})`;
}

export function describeHubError(error, locale = 'en', extra = {}) {
  const lang = pickLang(locale);
  const code = String(error?.code || 'unknown_error');
  const key = `error_${code}`;
  if ((COPY[lang] || COPY.en)[key] || COPY.en[key]) return copy(lang, key, { max: error?.detail?.max ?? 40, ...extra });
  return copy(lang, 'error_generic', { code });
}

function formatWhen(timestamp, lang) {
  if (!timestamp) return copy(lang, 'never');
  try {
    return new Date(timestamp).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US');
  } catch {
    return String(timestamp);
  }
}

export function createAgentXHubSettingsController({
  api,
  root,
  locale = () => 'en',
  sendToBackground,
  config = AGENTX_RUNTIME_CONFIG,
  confirmImpl = (message) => globalThis.confirm?.(message) ?? true,
  clientOptions = {},
}) {
  if (typeof sendToBackground !== 'function') throw new TypeError('sendToBackground is required');
  const hub = createAgentXHubClient({ api, config, ...clientOptions });
  const state = {
    status: null,
    loading: true,
    query: '',
    results: null,
    searching: false,
    error: null,
    busySlug: '',
    busyAction: '',
    syncing: false,
    message: null,
    hubUrlDraft: null,
  };
  let refreshTimer = 0;

  const lang = () => pickLang(locale);

  async function refreshStatus() {
    try {
      state.status = await sendToBackground('agentx_hub_status');
    } catch (error) {
      state.status = { ok: false, signedIn: false, installed: [], error: publicHubError(error) };
    }
    state.loading = false;
  }

  function installedFor(slug) {
    return (state.status?.installed || []).find((item) => item.slug === slug) || null;
  }

  function badge(text, tone = '') {
    return `<span class="ax-hub-badge${tone ? ` ax-hub-badge--${tone}` : ''}">${escapeHtml(text)}</span>`;
  }

  function renderResult(skill) {
    const l = lang();
    const local = installedFor(skill.slug);
    const notice = state.status?.notices?.[skill.slug] || null;
    const latest = skill.latest_version || '';
    const busy = state.busySlug === skill.slug;
    let action = '';
    if (busy) {
      action = `<button class="btn-secondary" disabled>${escapeHtml(copy(l, state.busyAction === 'remove' ? 'removing' : 'installing'))}</button>`;
    } else if (!local) {
      action = `<button class="btn-primary" data-hub-action="install" data-hub-slug="${escapeHtml(skill.slug)}"${state.status?.signedIn ? '' : ' disabled'}>${escapeHtml(copy(l, 'install'))}</button>`;
    } else if (local.sourceType !== 'hub') {
      action = `<button class="btn-secondary" data-hub-action="reinstall" data-hub-slug="${escapeHtml(skill.slug)}">${escapeHtml(copy(l, 'reinstall'))}</button>`
        + `<button class="btn-secondary" data-hub-action="uninstall" data-hub-slug="${escapeHtml(skill.slug)}">${escapeHtml(copy(l, 'remove'))}</button>`;
    } else if (latest && local.version && latest !== local.version) {
      action = `<button class="btn-primary" data-hub-action="install" data-hub-slug="${escapeHtml(skill.slug)}">${escapeHtml(copy(l, 'update', { version: latest }))}</button>`
        + `<button class="btn-secondary" data-hub-action="uninstall" data-hub-slug="${escapeHtml(skill.slug)}">${escapeHtml(copy(l, 'remove'))}</button>`;
    } else {
      action = `<span class="ax-hub-installed">${escapeHtml(copy(l, 'installed', { version: local.version || latest || '?' }))}</span>`
        + `<button class="btn-secondary" data-hub-action="uninstall" data-hub-slug="${escapeHtml(skill.slug)}">${escapeHtml(copy(l, 'remove'))}</button>`;
    }
    const verdict = skill.scan?.verdict ? badge(copy(l, `verdict_${skill.scan.verdict}`), skill.scan.verdict) : '';
    const visibility = skill.visibility ? badge(copy(l, `visibility_${skill.visibility}`)) : '';
    const noticeText = notice?.kind === 'edited' ? badge(copy(l, 'editedNote'), 'warn') : '';
    return `
      <div class="ax-hub-row" data-hub-result="${escapeHtml(skill.slug)}">
        <div class="ax-hub-row-info">
          <div class="ax-hub-row-title">
            <a href="${escapeHtml(hubSkillPageUrl(state.status?.baseUrl || '', skill.slug))}" target="_blank" rel="noopener noreferrer" data-hub-action="open">${escapeHtml(skill.name || skill.slug)}</a>
            ${latest ? badge(`v${latest}`) : ''}${verdict}${visibility}${noticeText}
          </div>
          <div class="ax-hub-row-desc">${escapeHtml(skill.description || '')}</div>
          <div class="ax-hub-row-meta">${escapeHtml(skill.slug)}${skill.owner?.display_name || skill.owner?.slug ? ` · ${escapeHtml(skill.owner.display_name || skill.owner.slug)}` : ''}${Number.isFinite(Number(skill.downloads)) ? ` · ${escapeHtml(String(skill.downloads))}↓` : ''}</div>
        </div>
        <div class="ax-hub-row-actions">${action}</div>
      </div>`;
  }

  function renderInstalled() {
    const l = lang();
    const items = state.status?.installed || [];
    const parked = state.status?.parked || [];
    const notices = state.status?.notices || {};
    const updates = new Map((state.status?.updates || []).map((u) => [u.slug, u]));
    if (!items.length && !parked.length) return `<div class="setting-desc">${escapeHtml(copy(l, 'installedEmpty'))}</div>`;
    const rows = items.map((item) => {
      const notice = notices[item.slug];
      const update = updates.get(item.slug);
      const flags = [];
      if (item.sourceType !== 'hub') flags.push(badge(copy(l, 'editedNote'), 'warn'));
      if ((notice?.kind === 'edited' && notice.updateAvailable) || update) flags.push(badge(copy(l, 'updateAvailable', { version: notice?.latestVersion || update?.version || '' }), 'accent'));
      if (notice?.kind === 'failed') flags.push(badge(copy(l, 'failedNote', { code: notice.code }), 'danger'));
      const busy = state.busySlug === item.slug;
      return `
        <div class="ax-hub-row" data-hub-installed="${escapeHtml(item.slug)}">
          <div class="ax-hub-row-info">
            <div class="ax-hub-row-title"><span>${escapeHtml(item.name || item.slug)}</span>${badge(`v${item.version || '?'}`)}${flags.join('')}</div>
            <div class="ax-hub-row-meta">${escapeHtml(item.sourceType === 'hub' ? copy(l, 'fromHub') : copy(l, 'editedFromHub'))} · ${escapeHtml(item.slug)}</div>
          </div>
          <div class="ax-hub-row-actions">
            <a class="btn-secondary" href="${escapeHtml(hubSkillPageUrl(state.status?.baseUrl || '', item.slug))}" target="_blank" rel="noopener noreferrer">${escapeHtml(copy(l, 'open'))}</a>
            <button class="btn-secondary" data-hub-action="uninstall" data-hub-slug="${escapeHtml(item.slug)}"${busy ? ' disabled' : ''}>${escapeHtml(copy(l, busy ? 'removing' : 'remove'))}</button>
          </div>
        </div>`;
    });
    const parkedRows = parked.map((slug) => {
      const notice = notices[slug];
      const reason = notice?.reason ? ` — ${notice.reason}` : '';
      return `
        <div class="ax-hub-row ax-hub-row--parked" data-hub-parked="${escapeHtml(slug)}">
          <div class="ax-hub-row-info">
            <div class="ax-hub-row-title"><span>${escapeHtml(slug)}</span>${badge(copy(l, 'disabledNote', { reason }), 'warn')}</div>
          </div>
          <div class="ax-hub-row-actions">
            <a class="btn-secondary" href="${escapeHtml(hubSkillPageUrl(state.status?.baseUrl || '', slug))}" target="_blank" rel="noopener noreferrer">${escapeHtml(copy(l, 'open'))}</a>
            <button class="btn-secondary" data-hub-action="uninstall" data-hub-slug="${escapeHtml(slug)}">${escapeHtml(copy(l, 'remove'))}</button>
          </div>
        </div>`;
    });
    return `${rows.join('')}${parkedRows.length ? `<div class="setting-label ax-hub-subheading">${escapeHtml(copy(l, 'parkedHeading'))}</div>${parkedRows.join('')}` : ''}`;
  }

  function render() {
    if (!root) return;
    const l = lang();
    const status = state.status;
    const who = status?.subject ? status.subject : '';
    const statusKey = `status_${status?.lastStatus || 'never'}`;
    const orgSkills = status?.org?.skills || [];
    root.innerHTML = `
      <div class="ax-hub" data-agentx-hub>
        <div class="ax-hub-head">
          <div>
            <div class="setting-label">${escapeHtml(copy(l, 'title'))}</div>
            <div class="setting-desc">${escapeHtml(copy(l, 'intro'))}</div>
          </div>
          <button class="btn-secondary" data-hub-action="sync"${state.syncing || !status?.signedIn ? ' disabled' : ''}>${escapeHtml(copy(l, state.syncing ? 'syncing' : 'syncNow'))}</button>
        </div>
        <div class="ax-hub-status" data-hub-status="${escapeHtml(status?.lastStatus || 'never')}">
          <span>${escapeHtml(status?.signedIn ? copy(l, 'signedInAs', { who }) : copy(l, 'signedOut'))}</span>
          <span>· ${escapeHtml(copy(l, 'hub'))}: <a href="${escapeHtml(status?.baseUrl || '')}" target="_blank" rel="noopener noreferrer">${escapeHtml(status?.baseUrl || '')}</a></span>
          <span>· ${escapeHtml(copy(l, 'lastSync', { when: formatWhen(status?.lastSyncAt, l) }))} (${escapeHtml(copy(l, statusKey))})</span>
        </div>
        ${status?.lastError ? `<div class="ax-hub-error" role="alert">${escapeHtml(describeHubError(status.lastError, l))}</div>` : ''}
        ${state.error ? `<div class="ax-hub-error" role="alert" data-hub-error>${escapeHtml(describeHubError(state.error, l))}</div>` : ''}
        ${state.message ? `<div class="ax-hub-message" role="status" data-hub-message>${escapeHtml(state.message)}</div>` : ''}
        <form class="ax-hub-search" data-hub-search>
          <label class="setting-desc" for="agentx-hub-query">${escapeHtml(copy(l, 'searchLabel'))}</label>
          <div class="ax-hub-search-row">
            <input type="search" id="agentx-hub-query" name="q" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(copy(l, 'searchPlaceholder'))}" autocomplete="off">
            <button class="btn-primary" type="submit"${state.searching ? ' disabled' : ''}>${escapeHtml(copy(l, state.searching ? 'searching' : 'search'))}</button>
          </div>
        </form>
        <div class="ax-hub-results" data-hub-results>
          ${state.results === null ? '' : state.results.length === 0 ? `<div class="setting-desc">${escapeHtml(copy(l, 'noResults'))}</div>` : state.results.map(renderResult).join('')}
        </div>
        <div class="setting-label ax-hub-subheading">${escapeHtml(copy(l, 'installedHeading'))}</div>
        <div class="ax-hub-installed-list" data-hub-installed-list>${renderInstalled()}</div>
        ${orgSkills.length ? `<div class="setting-label ax-hub-subheading">${escapeHtml(copy(l, 'orgHeading'))}</div><div class="setting-desc">${orgSkills.map((s) => escapeHtml(`${s.name || s.slug} v${s.version || '?'}`)).join(' · ')}</div>` : ''}
        <details class="ax-hub-advanced">
          <summary>${escapeHtml(copy(l, 'advanced'))}</summary>
          <div class="setting-desc">${escapeHtml(status?.externalChannel ? copy(l, 'externalChannel') : copy(l, 'externalChannelMissing'))}</div>
          <form class="ax-hub-url" data-hub-url-form>
            <label class="setting-desc" for="agentx-hub-url">${escapeHtml(copy(l, 'hubUrlLabel'))}</label>
            <div class="ax-hub-search-row">
              <input type="url" id="agentx-hub-url" name="baseUrl" value="${escapeHtml(state.hubUrlDraft ?? (status?.baseUrlSource === 'override' ? status.baseUrl : ''))}" placeholder="${escapeHtml(config.skillHubBaseUrl || '')}">
              <button class="btn-secondary" type="submit">${escapeHtml(copy(l, 'hubUrlSave'))}</button>
              <button class="btn-secondary" type="button" data-hub-action="reset-url">${escapeHtml(copy(l, 'hubUrlReset'))}</button>
            </div>
            <div class="setting-desc">${escapeHtml(copy(l, 'hubUrlHint'))}</div>
          </form>
        </details>
      </div>`;
  }

  async function search(query) {
    state.query = String(query || '').trim();
    state.searching = true;
    state.error = null;
    render();
    try {
      const page = await hub.listBrowserSkills(state.query, { limit: 30 });
      state.results = Array.isArray(page?.skills) ? page.skills : [];
    } catch (error) {
      state.error = publicHubError(error);
      state.results = state.results || [];
    } finally {
      state.searching = false;
      render();
    }
  }

  async function act(action, slug) {
    state.error = null;
    state.message = null;
    if (action === 'reinstall' && !confirmImpl(copy(lang(), 'reinstallConfirm'))) return;
    state.busySlug = slug;
    state.busyAction = action === 'uninstall' ? 'remove' : 'install';
    render();
    try {
      if (action === 'uninstall') {
        const result = await sendToBackground('agentx_hub_uninstall', { slug });
        if (result?.error) throw Object.assign(new Error(result.error.message || result.error), { code: result.error.code || 'unknown_error' });
        state.message = copy(lang(), 'removedMessage', { name: installedFor(slug)?.name || slug });
      } else {
        const result = await sendToBackground('agentx_hub_install', { slug });
        if (result?.error) throw Object.assign(new Error(result.error.message || result.error), { code: result.error.code || 'unknown_error', detail: result.error.detail });
        state.message = copy(lang(), 'installedMessage', { name: result?.skill?.name || slug, version: result?.skill?.version || '?' });
      }
    } catch (error) {
      state.error = publicHubError(error);
    } finally {
      state.busySlug = '';
      state.busyAction = '';
      await refreshStatus();
      render();
    }
  }

  async function sync() {
    state.syncing = true;
    state.error = null;
    render();
    try {
      const result = await sendToBackground('agentx_hub_sync', { reason: 'settings' });
      if (result?.error && result.status !== 'offline') state.error = result.error;
    } catch (error) {
      state.error = publicHubError(error);
    } finally {
      state.syncing = false;
      await refreshStatus();
      render();
    }
  }

  async function saveHubUrl(value) {
    state.error = null;
    try {
      await writeHubConfig(api, { baseUrl: value });
      state.hubUrlDraft = null;
      state.message = copy(lang(), 'hubUrlSaved');
      await refreshStatus();
      render();
      await sync();
    } catch (error) {
      state.error = publicHubError(error);
      render();
    }
  }

  function bind() {
    if (!root || root.dataset.agentxHubBound) return;
    root.dataset.agentxHubBound = '1';
    root.addEventListener('submit', (event) => {
      const form = event.target;
      if (form?.matches?.('[data-hub-search]')) {
        event.preventDefault();
        void search(new FormData(form).get('q'));
      } else if (form?.matches?.('[data-hub-url-form]')) {
        event.preventDefault();
        void saveHubUrl(new FormData(form).get('baseUrl'));
      }
    });
    root.addEventListener('input', (event) => {
      if (event.target?.id === 'agentx-hub-query') state.query = event.target.value;
      if (event.target?.id === 'agentx-hub-url') state.hubUrlDraft = event.target.value;
    });
    root.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-hub-action]');
      if (!button || button.tagName === 'A') return;
      const action = button.dataset.hubAction;
      if (action === 'sync') void sync();
      else if (action === 'reset-url') void saveHubUrl('');
      else if (action === 'install' || action === 'reinstall' || action === 'uninstall') void act(action, button.dataset.hubSlug);
    });
    api?.storage?.onChanged?.addListener?.((changes, area) => {
      if (area && area !== 'local') return;
      if (!changes[CUSTOM_SKILLS_STORAGE_KEY] && !changes[AGENTX_HUB_SYNC_STATE_KEY]) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void refreshStatus().then(render);
      }, 150);
    });
  }

  return {
    async initialize() {
      bind();
      await refreshStatus();
      render();
      return state.status;
    },
    render,
    search,
    sync,
    status() {
      return { ...state };
    },
    readHubConfig: () => readHubConfig(api, config),
  };
}
