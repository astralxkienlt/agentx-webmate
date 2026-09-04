// Desired-state sync between the AgentX Skill Hub and WebMate's custom
// skills (plan Phase 4, items 3 and 4).
//
// The hub's `/v1/me/changes?product=webmate` snapshot is the source of truth.
// Every sync reconciles it against `customSkills`: a row that wants a skill
// installed is fetched (the `webmate` render) and written to storage — the
// existing `chrome.storage.onChanged` listener in background.js hot-reloads
// it into the agent; `removed` deletes the hub-managed record; `disabled`
// (a yank, a demotion, or "switch off" on the web) parks the record here so
// switching it back on needs no download; a newer version replaces the
// content unless the person edited the copy by hand, in which case the copy
// is left alone and only flagged. Then each row is told what happened.
//
// Losing the hub is never a revocation: every failure short of an explicit
// `removed` leaves the installed skills exactly as they are.
//
// `reconcileHubSkills` is pure apart from the injected `fetchRender`, so the
// unit tests drive it with fakes; `createAgentXHubSyncRunner` wires it to the
// extension APIs (alarms, storage, the external message channel).
import {
  CUSTOM_SKILLS_STORAGE_KEY,
  MAX_CUSTOM_SKILLS,
  normalizeCustomSkills,
} from '../agent/skills.js';
import {
  AGENTX_HUB_PRODUCT,
  AgentXHubError,
  createAgentXHubClient,
  hubOriginOf,
  hubSkillPageUrl,
  isValidHubSlug,
  isValidHubVersion,
  publicHubError,
  readHubConfig,
} from './hub-client.js';

export const AGENTX_HUB_SYNC_STATE_KEY = 'agentxHubSyncStateV1';
export const AGENTX_HUB_SYNC_ALARM = 'agentx-hub-sync';
export const AGENTX_HUB_SYNC_PERIOD_MINUTES = 5;
export const AGENTX_HUB_MESSAGE_PING = 'agentx-hub/ping';
export const AGENTX_HUB_MESSAGE_INSTALL = 'agentx-hub/install';
export const AGENTX_HUB_MESSAGE_TYPES = Object.freeze([AGENTX_HUB_MESSAGE_PING, AGENTX_HUB_MESSAGE_INSTALL]);
// After a 401 the bearer is stale; polling harder would only repeat it.
const REAUTH_BACKOFF_MS = 5 * 60_000;

export function hubSkillId(slug) {
  return `hub_${String(slug).replace(/\//g, '__')}`;
}

/** The raw record hub-sync writes; normalizeCustomSkills fills in the rest. */
export function hubRecordFrom({ slug, version, contentHash, content, baseUrl, createdAt, name = '' }) {
  return {
    id: hubSkillId(slug),
    name,
    sourceType: 'hub',
    sourceUrl: hubSkillPageUrl(baseUrl, slug),
    hubSlug: slug,
    hubVersion: String(version || ''),
    contentHash: String(contentHash || ''),
    content,
    createdAt: Number.isFinite(Number(createdAt)) ? Number(createdAt) : Date.now(),
  };
}

export function emptySyncState() {
  return { cursor: null, lastSyncAt: 0, lastStatus: 'never', lastError: null, parked: {}, notices: {}, counts: {} };
}

export function normalizeSyncState(value) {
  const state = emptySyncState();
  if (!value || typeof value !== 'object') return state;
  if (Number.isFinite(Number(value.cursor))) state.cursor = Number(value.cursor);
  if (Number.isFinite(Number(value.lastSyncAt))) state.lastSyncAt = Number(value.lastSyncAt);
  if (typeof value.lastStatus === 'string') state.lastStatus = value.lastStatus;
  if (value.lastError && typeof value.lastError === 'object') state.lastError = publicHubError(value.lastError);
  if (value.parked && typeof value.parked === 'object') {
    for (const [slug, record] of Object.entries(value.parked)) {
      if (isValidHubSlug(slug) && record && typeof record === 'object' && typeof record.content === 'string') state.parked[slug] = record;
    }
  }
  if (value.notices && typeof value.notices === 'object') state.notices = { ...value.notices };
  if (value.counts && typeof value.counts === 'object') state.counts = { ...value.counts };
  return state;
}

function rowsBySlug(installs) {
  const groups = new Map();
  for (const row of Array.isArray(installs) ? installs : []) {
    if (!row || !isValidHubSlug(row.slug)) continue;
    if (!groups.has(row.slug)) groups.set(row.slug, []);
    groups.get(row.slug).push(row);
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }
  return groups;
}

function reportsFor(rows, state, version = '', error = '') {
  const out = [];
  for (const row of rows) {
    const sameVersion = !version || String(row.reported_version || '') === String(version);
    const sameError = !error || String(row.error || '') === String(error);
    if (row.reported_state === state && sameVersion && sameError) continue;
    out.push({ install_id: row.id, slug: row.slug, state, version, error });
  }
  return out;
}

function recordMatches(record, row) {
  if (!record) return false;
  if (row.version) return String(record.hubVersion || '') === String(row.version);
  if (row.latest_content_hash) return String(record.contentHash || '') === String(row.latest_content_hash);
  return true;
}

/**
 * Bring `skills` in line with the hub's `installs` snapshot.
 *
 * Returns the next skills list, the next parked map, the reports to send,
 * notices for the UI, and whether storage needs writing. `fetchRender(slug,
 * version)` is awaited for every install that needs bytes; a failure there
 * is reported as `failed` for that row and the rest carries on.
 */
export async function reconcileHubSkills({ installs, skills, parked, fetchRender, baseUrl, now = Date.now(), maxSkills = MAX_CUSTOM_SKILLS }) {
  const next = [...(Array.isArray(skills) ? skills : [])];
  const nextParked = { ...(parked || {}) };
  const reports = [];
  const notices = {};
  const counts = { installed: 0, updated: 0, removed: 0, disabled: 0, restored: 0, failed: 0, edited: 0 };
  let changed = false;

  const findHub = (slug) => next.findIndex((skill) => skill.sourceType === 'hub' && skill.hubSlug === slug);
  const findFork = (slug) => next.find((skill) => skill.sourceType !== 'hub' && skill.hubSlug === slug) || null;

  for (const [slug, rows] of rowsBySlug(installs)) {
    const effective = rows[0];
    const desired = effective.desired_state;
    const hubIndex = findHub(slug);
    const local = hubIndex === -1 ? null : next[hubIndex];

    if (desired === 'removed') {
      if (local) {
        next.splice(hubIndex, 1);
        changed = true;
        counts.removed += 1;
      }
      if (nextParked[slug]) {
        delete nextParked[slug];
        changed = true;
      }
      reports.push(...reportsFor(rows, 'removed'));
      continue;
    }

    if (desired === 'disabled') {
      if (local) {
        nextParked[slug] = local;
        next.splice(hubIndex, 1);
        changed = true;
        counts.disabled += 1;
      }
      notices[slug] = { kind: 'disabled', reason: String(effective.reason || ''), version: String(effective.reason_version || effective.version || '') };
      reports.push(...reportsFor(rows, 'disabled'));
      continue;
    }

    if (desired !== 'installed') continue;

    const fork = local ? null : findFork(slug);
    if (fork) {
      // The person edited their copy: it is theirs now. Never overwrite it;
      // tell them a newer version exists when the hub moved on.
      const newer = Boolean(effective.latest_content_hash) && String(fork.contentHash || '') !== String(effective.latest_content_hash);
      notices[slug] = { kind: 'edited', updateAvailable: newer, localVersion: String(fork.hubVersion || ''), latestVersion: String(effective.latest_version || '') };
      counts.edited += 1;
      reports.push(...reportsFor(rows, 'installed', fork.hubVersion || ''));
      continue;
    }

    let record = local;
    if (!record && nextParked[slug]) {
      const candidate = nextParked[slug];
      delete nextParked[slug];
      changed = true;
      if (recordMatches(candidate, effective)) {
        record = candidate;
        next.push(candidate);
        counts.restored += 1;
      }
    }

    const needsFetch = !record || !recordMatches(record, effective);
    if (needsFetch) {
      if (!record && next.length >= maxSkills) {
        const error = `skill_limit_reached: WebMate keeps at most ${maxSkills} skills`;
        counts.failed += 1;
        notices[slug] = { kind: 'failed', code: 'skill_limit_reached' };
        reports.push(...reportsFor(rows, 'failed', '', error));
        continue;
      }
      let rendered;
      try {
        rendered = await fetchRender(slug, effective.version || 'latest');
      } catch (error) {
        const code = String(error?.code || 'fetch_failed');
        counts.failed += 1;
        notices[slug] = { kind: 'failed', code, message: String(error?.message || '') };
        reports.push(...reportsFor(rows, 'failed', '', `${code}: ${String(error?.message || '').slice(0, 200)}`));
        continue;
      }
      const fresh = hubRecordFrom({
        slug,
        version: rendered.version || effective.version || effective.latest_version || '',
        contentHash: rendered.contentHash || (effective.version ? '' : effective.latest_content_hash || ''),
        content: rendered.content,
        baseUrl,
        createdAt: record?.createdAt || now,
      });
      const at = findHub(slug);
      if (at === -1) {
        next.push(fresh);
        counts.installed += 1;
      } else {
        next[at] = fresh;
        counts.updated += 1;
      }
      record = fresh;
      changed = true;
    }
    reports.push(...reportsFor(rows, 'installed', record.hubVersion || ''));
  }

  return { skills: next, parked: nextParked, reports, notices, counts, changed };
}

function senderOrigin(sender) {
  if (sender?.origin) return String(sender.origin);
  try {
    return sender?.url ? new URL(sender.url).origin : '';
  } catch {
    return '';
  }
}

export function createAgentXHubSyncRunner({
  api,
  client = null,
  config,
  fetchImpl,
  product = AGENTX_HUB_PRODUCT,
  extensionVersion = '',
  ready = () => Promise.resolve(),
  now = Date.now,
  log = console,
  periodInMinutes = AGENTX_HUB_SYNC_PERIOD_MINUTES,
} = {}) {
  if (!api?.storage?.local) throw new TypeError('createAgentXHubSyncRunner needs the extension storage API');
  const hub = client || createAgentXHubClient({ api, config, fetchImpl, product });
  let inFlight = null;
  let reauthUntil = 0;

  async function readState() {
    const stored = await api.storage.local.get([AGENTX_HUB_SYNC_STATE_KEY, CUSTOM_SKILLS_STORAGE_KEY]);
    return {
      state: normalizeSyncState(stored?.[AGENTX_HUB_SYNC_STATE_KEY]),
      skills: normalizeCustomSkills(stored?.[CUSTOM_SKILLS_STORAGE_KEY]),
    };
  }

  async function writeState(state, skills) {
    const update = { [AGENTX_HUB_SYNC_STATE_KEY]: state };
    if (skills) update[CUSTOM_SKILLS_STORAGE_KEY] = normalizeCustomSkills(skills);
    await api.storage.local.set(update);
  }

  async function allowedOrigins() {
    const { baseUrl } = await readHubConfig(api, config);
    return [hubOriginOf(baseUrl)];
  }

  async function sendReports(reports) {
    let sent = 0;
    for (const report of reports) {
      try {
        await hub.reportInstall(report.install_id, { state: report.state, version: report.version, error: report.error });
        sent += 1;
      } catch (error) {
        log.warn?.('[AgentX] hub report failed', report.slug, error?.code || error);
      }
    }
    return sent;
  }

  async function runSync(reason) {
    await ready();
    const { state, skills } = await readState();
    const finish = async (status, error = null, extra = {}) => {
      state.lastStatus = status;
      state.lastError = error ? publicHubError(error) : null;
      state.lastSyncAt = now();
      Object.assign(state, extra);
      await writeState(state);
      return { ok: status === 'synced', status, reason, error: state.lastError, counts: state.counts };
    };
    if (reauthUntil && now() < reauthUntil) return finish('reauth', state.lastError);
    let who;
    try {
      who = await hub.identity({ required: false });
    } catch (error) {
      return finish('error', error);
    }
    if (!who.signedIn) return finish('not_signed_in');
    let snapshot;
    try {
      snapshot = await hub.changes(state.cursor);
    } catch (error) {
      if (error?.code === 'invalid_token' || error?.status === 401) {
        reauthUntil = now() + REAUTH_BACKOFF_MS;
        return finish('reauth', error);
      }
      return finish(error?.transient ? 'offline' : 'error', error);
    }
    const { baseUrl } = await readHubConfig(api, config);
    const result = await reconcileHubSkills({
      installs: snapshot.installs,
      skills,
      parked: state.parked,
      baseUrl,
      now: now(),
      fetchRender: (slug, version) => hub.getRender(slug, version),
    });
    state.parked = result.parked;
    state.notices = result.notices;
    state.counts = result.counts;
    state.cursor = Number.isFinite(Number(snapshot.cursor)) ? Number(snapshot.cursor) : state.cursor;
    state.org = snapshot.org ? { org_id: snapshot.org.org_id, skills: (snapshot.org.skills || []).map((s) => ({ slug: s.slug, name: s.name, version: s.version })) } : null;
    state.updates = (snapshot.updates || []).map((u) => ({ slug: u.slug, version: u.latest_version, current: u.reported_version }));
    if (result.changed) await writeState(state, result.skills);
    const sent = await sendReports(result.reports);
    return finish('synced', null, { counts: { ...result.counts, reported: sent } });
  }

  function syncNow({ reason = 'manual' } = {}) {
    if (inFlight) return inFlight;
    inFlight = runSync(reason)
      .catch((error) => {
        log.warn?.('[AgentX] hub sync failed', error);
        return { ok: false, status: 'error', reason, error: publicHubError(error) };
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /**
   * Install one skill right now (the Settings "Install" button, or the web
   * page's `agentx-hub/install` message). The extension fetches the render
   * with its own session — a page never hands it skill content.
   */
  async function installFromHub({ slug, version = null, allDevices = false, ensureRow = true } = {}) {
    await ready();
    if (!isValidHubSlug(slug)) throw new AgentXHubError('invalid_request', `Slug không hợp lệ: ${slug}`);
    const ref = version && version !== 'latest' ? String(version) : 'latest';
    if (!isValidHubVersion(ref)) throw new AgentXHubError('invalid_request', `Phiên bản không hợp lệ: ${version}`);
    await hub.identity({ required: true });
    const rendered = await hub.getRender(slug, ref);
    const { state, skills } = await readState();
    const { baseUrl } = await readHubConfig(api, config);
    const existingIndex = skills.findIndex((skill) => skill.hubSlug === slug);
    const existing = existingIndex === -1 ? null : skills[existingIndex];
    const replacedEdited = Boolean(existing && existing.sourceType !== 'hub');
    if (!existing && skills.length >= MAX_CUSTOM_SKILLS) {
      throw new AgentXHubError('skill_limit_reached', `WebMate chỉ giữ tối đa ${MAX_CUSTOM_SKILLS} kỹ năng.`, { detail: { max: MAX_CUSTOM_SKILLS } });
    }
    const record = hubRecordFrom({
      slug,
      version: rendered.version || (ref === 'latest' ? '' : ref),
      contentHash: rendered.contentHash,
      content: rendered.content,
      baseUrl,
      createdAt: existing?.createdAt || now(),
    });
    const next = [...skills];
    if (existing) next[existingIndex] = record;
    else next.push(record);
    delete state.parked[slug];
    delete state.notices[slug];
    await writeState(state, next);
    const normalized = normalizeCustomSkills(next).find((skill) => skill.id === record.id) || null;
    if (ensureRow) {
      try {
        await hub.createInstall({ slug, version: ref === 'latest' ? null : ref, allDevices });
      } catch (error) {
        log.warn?.('[AgentX] hub install row could not be recorded', error?.code || error);
      }
    }
    // Report through the ordinary path (finds every row for the slug).
    void syncNow({ reason: 'install' });
    return {
      ok: true,
      replacedEdited,
      skill: normalized && {
        id: normalized.id,
        name: normalized.name,
        slug,
        version: record.hubVersion,
        contentHash: record.contentHash,
        modes: normalized.modes,
        intents: normalized.intents,
      },
    };
  }

  /** Remove a hub skill here and on the hub (every row for this device / all devices). */
  async function uninstallFromHub({ slug } = {}) {
    await ready();
    if (!isValidHubSlug(slug)) throw new AgentXHubError('invalid_request', `Slug không hợp lệ: ${slug}`);
    let rows = [];
    let hubReachable = true;
    try {
      rows = ((await hub.listMyInstalls()).installs || []).filter((row) => row.slug === slug && row.desired_state !== 'removed');
    } catch (error) {
      hubReachable = false;
      log.warn?.('[AgentX] hub installs could not be listed', error?.code || error);
    }
    for (const row of rows) {
      try {
        await hub.removeInstall(row.id);
      } catch (error) {
        log.warn?.('[AgentX] hub install could not be removed', row.id, error?.code || error);
      }
    }
    const { state, skills } = await readState();
    // An explicit "Remove" in Settings takes the record away whatever its
    // state — hub-managed or edited by hand. (The automatic sync path never
    // deletes an edited copy; see reconcileHubSkills.)
    const next = skills.filter((skill) => skill.hubSlug !== slug);
    const removedLocally = next.length !== skills.length || Boolean(state.parked[slug]);
    delete state.parked[slug];
    delete state.notices[slug];
    await writeState(state, next);
    if (hubReachable && rows.length) void syncNow({ reason: 'uninstall' });
    return { ok: true, removed: removedLocally, rows: rows.length };
  }

  async function status() {
    const { state, skills } = await readState();
    const { baseUrl, source } = await readHubConfig(api, config);
    let signedIn = false;
    let subject = '';
    try {
      const who = await hub.identity({ required: false });
      signedIn = who.signedIn;
      subject = who.subject;
    } catch {
      signedIn = false;
    }
    return {
      ok: true,
      product,
      extensionVersion,
      baseUrl,
      baseUrlSource: source,
      externalChannel: Boolean(api.runtime?.onMessageExternal),
      signedIn,
      subject,
      lastSyncAt: state.lastSyncAt,
      lastStatus: state.lastStatus,
      lastError: state.lastError,
      cursor: state.cursor,
      counts: state.counts,
      notices: state.notices,
      parked: Object.keys(state.parked),
      updates: state.updates || [],
      org: state.org || null,
      installed: skills.filter((skill) => skill.hubSlug).map((skill) => ({
        id: skill.id, name: skill.name, slug: skill.hubSlug, version: skill.hubVersion || '', contentHash: skill.contentHash || '', sourceType: skill.sourceType,
      })),
    };
  }

  /**
   * The only two messages a web page may send (plan Phase 4 item 4), and only
   * from the hub's own origin — the manifest already restricts the channel,
   * this is the second lock.
   */
  async function handleExternalMessage(message, sender) {
    const origin = senderOrigin(sender);
    const allowed = await allowedOrigins();
    if (!origin || !allowed.includes(origin)) {
      return { ok: false, error: { code: 'origin_not_allowed', message: `Origin ${origin || '(unknown)'} may not talk to AgentX WebMate.` } };
    }
    const type = message && typeof message === 'object' ? String(message.type || '') : '';
    if (type === AGENTX_HUB_MESSAGE_PING) {
      let signedIn = false;
      try {
        signedIn = (await hub.identity({ required: false })).signedIn;
      } catch {
        signedIn = false;
      }
      return { ok: true, product, extensionVersion, hub: allowed[0], signedIn, messageTypes: [...AGENTX_HUB_MESSAGE_TYPES] };
    }
    if (type === AGENTX_HUB_MESSAGE_INSTALL) {
      try {
        const result = await installFromHub({ slug: message.slug, version: message.version || null, ensureRow: false });
        return { ok: true, product, skill: result.skill, replacedEdited: result.replacedEdited };
      } catch (error) {
        return { ok: false, product, error: publicHubError(error) };
      }
    }
    return { ok: false, error: { code: 'unsupported_message', message: `AgentX WebMate only answers ${AGENTX_HUB_MESSAGE_TYPES.join(', ')}.` } };
  }

  function install() {
    try {
      Promise.resolve(api.alarms?.create?.(AGENTX_HUB_SYNC_ALARM, { periodInMinutes, delayInMinutes: 1 })).catch(() => {});
    } catch { /* alarms unavailable */ }
    api.alarms?.onAlarm?.addListener?.((alarm) => {
      if (alarm?.name !== AGENTX_HUB_SYNC_ALARM) return;
      void syncNow({ reason: 'alarm' });
    });
    api.runtime?.onMessageExternal?.addListener?.((message, sender, sendResponse) => {
      handleExternalMessage(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: publicHubError(error) }));
      return true;
    });
    // A fresh worker start is a fine moment to catch up on what the web did meanwhile.
    void ready().then(() => syncNow({ reason: 'startup' }));
  }

  return { install, syncNow, installFromHub, uninstallFromHub, status, handleExternalMessage, client: hub };
}
