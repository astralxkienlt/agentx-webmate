// AgentX Skill Hub integration (plan Phase 4) — runs against brand-dist/, the
// way test/agentx-auth.test.mjs does, because the hub record shape and the
// demotion rule live in a brand patch on src/agent/skills.js.
//
//   npm run brand:build && node test/agentx-hub.test.mjs
import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = (target, rel) => path.join(ROOT, 'brand-dist', target, rel);
const load = (target, rel) => import(pathToFileURL(DIST(target, rel)).href);

const HUB = 'https://hub.example.test';
const CONFIG = Object.freeze({ skillHubBaseUrl: `${HUB}/` });
const NOW = 1_800_000_000_000;

const VNEB_RENDER = [
  '---',
  'name: "vneb-portal"',
  'description: "Tra cứu giá điện, công suất phản kháng, khách hàng, kỳ tính tiền trên cổng nội bộ VNEB."',
  'license: "Proprietary"',
  'metadata:',
  '  version: "1.0.0"',
  '  author: "astralx"',
  '  agentx-kind: "browser"',
  '  agentx-targets: "webmate"',
  '---',
  '# Cổng nội bộ VNEB',
  '',
  '```webbrain-skill',
  '{"summary": "Hướng dẫn tra cứu trên cổng nội bộ VNEB", "modes": ["ask", "act"], "intents": ["vneb", "electricity_price_lookup"]}',
  '```',
  '',
  '## Case 1 — Tra cứu công suất phản kháng',
  '',
  '1. Nếu chưa đăng nhập thì dừng và yêu cầu người dùng đăng nhập.',
  '',
].join('\n');

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
    size() { return listeners.size; },
  };
}

function createApi(seed = {}, { external = true } = {}) {
  const values = structuredClone(seed);
  const onChanged = createEvent();
  const onAlarm = createEvent();
  const onMessageExternal = createEvent();
  const alarms = [];
  const api = {
    storage: {
      onChanged,
      local: {
        async get(keys) {
          const names = keys == null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => Object.hasOwn(values, key)).map((key) => [key, structuredClone(values[key])]));
        },
        async set(patch) {
          const changes = {};
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { oldValue: values[key], newValue: structuredClone(value) };
            values[key] = structuredClone(value);
          }
          onChanged.emit(changes, 'local');
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
        },
      },
    },
    alarms: {
      onAlarm,
      async create(name, info) { alarms.push({ name, info }); },
      async clear() {},
    },
    runtime: {
      getManifest: () => ({ version: '1.0.3' }),
      ...(external ? { onMessageExternal } : {}),
      async getPlatformInfo() { return { os: 'mac' }; },
    },
  };
  return { api, values, alarms, onAlarm, onMessageExternal, onChanged };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/markdown; charset=utf-8', ...headers } });
}

const SESSION = { idToken: 'id-token-1', user: { subject: 'user-123', email: 'kien@example.test' } };
const DEVICE = { id: '11111111-2222-4333-8444-555555555555', name: 'E2E Chrome' };
const signedInService = { async restoreSession() { return { session: SESSION, outcome: 'stored' }; }, async deviceIdentity() { return DEVICE; } };
const signedOutService = { async restoreSession() { return { session: null, outcome: 'needs-login' }; }, async deviceIdentity() { return DEVICE; } };

function installRow(overrides = {}) {
  return {
    id: 'inst-1', product: 'webmate', device_id: null, slug: 'vneb-portal', name: 'vneb-portal', kind: 'browser',
    version: null, latest_version: '1.0.0', latest_content_hash: 'sha256:aaa', desired_state: 'installed', reported_state: 'pending',
    reported_version: null, error: '', reason: '', reason_version: null, update_available: false, updated_at: '2026-09-04T00:00:00Z',
    ...overrides,
  };
}

/** A hub the runner talks to without HTTP. */
function fakeHub({ signedIn = true, installs = [], renders = {}, failChanges = null } = {}) {
  const calls = { changes: 0, renders: [], reports: [], created: [], removed: [] };
  return {
    calls,
    installs,
    async identity({ required = true } = {}) {
      if (!signedIn) {
        if (required) throw Object.assign(new Error('not signed in'), { code: 'not_signed_in' });
        return { token: '', device: null, subject: '', signedIn: false };
      }
      return { token: 'id-token-1', device: DEVICE, subject: 'user-123', signedIn: true };
    },
    async changes(cursor) {
      calls.changes += 1;
      if (failChanges) throw failChanges;
      return { cursor: 42, installs: structuredClone(installs), updates: [], org: null, events: [], has_more: false, product: 'webmate' };
    },
    async getRender(slug, version = 'latest') {
      calls.renders.push([slug, version]);
      const key = `${slug}@${version}`;
      const found = renders[key] || renders[`${slug}@latest`];
      if (!found) throw Object.assign(new Error(`no render for ${key}`), { code: 'skill_not_found', status: 404 });
      return found;
    },
    async reportInstall(id, report) { calls.reports.push({ id, ...report }); return { id, reported_state: report.state }; },
    async createInstall(body) { calls.created.push(body); return { id: `inst-${calls.created.length}`, ...body }; },
    async listMyInstalls() { return { installs: structuredClone(installs) }; },
    async removeInstall(id) { calls.removed.push(id); return { ok: true }; },
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------- record shape (patch 080)

test('normalizeCustomSkills keeps hub provenance and MAX_CUSTOM_SKILLS is 40 in both builds', async () => {
  for (const target of ['chrome', 'firefox']) {
    const { normalizeCustomSkills, MAX_CUSTOM_SKILLS } = await load(target, 'src/agent/skills.js');
    assert.equal(MAX_CUSTOM_SKILLS, 40, `${target}: plan §8 decision 6`);
    const [hub, edited, url, junk] = normalizeCustomSkills([
      { id: 'hub_vneb-portal', sourceType: 'hub', sourceUrl: `${HUB}/skills/vneb-portal`, hubSlug: 'vneb-portal', hubVersion: '1.0.0', contentHash: 'sha256:aaa', content: VNEB_RENDER, createdAt: 5 },
      { id: 'hub_other', sourceType: 'text', hubSlug: 'owner/other', hubVersion: '2.1.0', contentHash: 'sha256:bbb', content: '# Other\n\nEdited body', createdAt: 6 },
      { id: 'from-url', sourceType: 'url', sourceUrl: 'https://example.com/skill.md', hubSlug: 'ignored?', content: '# URL\n\nBody', createdAt: 7 },
      { id: 'bad-hub', sourceType: 'hub', sourceUrl: `${HUB}/skills/x`, hubSlug: 'Not A Slug', content: '# Bad\n\nBody', createdAt: 8 },
    ]);
    assert.equal(hub.sourceType, 'hub', `${target}: hub records keep their sourceType`);
    assert.equal(hub.sourceUrl, `${HUB}/skills/vneb-portal`, `${target}: the skill page URL is the source`);
    assert.deepEqual([hub.hubSlug, hub.hubVersion, hub.contentHash], ['vneb-portal', '1.0.0', 'sha256:aaa'], `${target}: provenance fields survive`);
    assert.equal(hub.name, 'vneb-portal', `${target}: the frontmatter name names the record`);
    assert.deepEqual([...hub.modes].sort(), ['act', 'ask'], `${target}: fence modes parsed from the render`);
    assert.deepEqual(hub.intents, ['vneb', 'electricity_price_lookup'], `${target}: fence intents parsed from the render`);
    assert.equal(edited.sourceType, 'text', `${target}: an edited copy is plain text`);
    assert.deepEqual([edited.hubSlug, edited.hubVersion, edited.contentHash], ['owner/other', '2.1.0', 'sha256:bbb'], `${target}: …but keeps its hub origin`);
    assert.equal(Object.hasOwn(url, 'hubSlug'), false, `${target}: an invalid hubSlug is dropped`);
    assert.equal(junk.sourceType, 'text', `${target}: sourceType hub without a valid slug degrades to text`);
    assert.equal(Object.hasOwn(junk, 'hubSlug'), false, `${target}: …without provenance`);
    // Records without any hub field carry no hub keys at all (the upstream shape is untouched).
    const [plain] = normalizeCustomSkills([{ id: 'plain', sourceType: 'text', content: '# Plain\n\nBody', createdAt: 1 }]);
    assert.deepEqual(Object.keys(plain).sort(), ['content', 'createdAt', 'id', 'intents', 'modes', 'name', 'sourceType', 'sourceUrl', 'summary', 'tools'], `${target}: upstream record shape unchanged`);
  }
});

test('applySkillEdit keeps hub provenance on a rename and demotes to text on a content edit', async () => {
  for (const target of ['chrome', 'firefox']) {
    const { normalizeCustomSkills, applySkillEdit } = await load(target, 'src/agent/skills.js');
    const skills = normalizeCustomSkills([
      { id: 'hub_vneb-portal', sourceType: 'hub', sourceUrl: `${HUB}/skills/vneb-portal`, hubSlug: 'vneb-portal', hubVersion: '1.0.0', contentHash: 'sha256:aaa', content: VNEB_RENDER, createdAt: 5 },
    ]);
    const renamed = applySkillEdit(skills, 'hub_vneb-portal', { name: 'VNEB (của tôi)', content: VNEB_RENDER });
    assert.equal(renamed.demoted, false, `${target}: a pure rename keeps hub provenance`);
    assert.equal(renamed.skill.sourceType, 'hub', `${target}: still a hub record`);
    assert.equal(renamed.skill.hubVersion, '1.0.0', `${target}: version kept`);
    const edited = applySkillEdit(skills, 'hub_vneb-portal', { name: 'vneb-portal', content: `${VNEB_RENDER}\n\n## Case 2 — Thêm của tôi\n` });
    assert.equal(edited.demoted, true, `${target}: a content edit demotes (like url)`);
    assert.equal(edited.skill.sourceType, 'text', `${target}: demoted to text`);
    assert.equal(edited.skill.sourceUrl, '', `${target}: the hub page is no longer the source`);
    assert.deepEqual([edited.skill.hubSlug, edited.skill.hubVersion, edited.skill.contentHash], ['vneb-portal', '1.0.0', 'sha256:aaa'], `${target}: origin kept so sync can flag a newer version without overwriting`);
    assert.equal(edited.skill.id, 'hub_vneb-portal', `${target}: identity kept`);
  }
});

test('a hub skill declaring ask is in the Ask-mode catalog and loads through load_skill', async () => {
  for (const target of ['chrome', 'firefox']) {
    const { normalizeCustomSkills, getEligibleSkillCatalog, buildSkillLoaderDefinition } = await load(target, 'src/agent/skills.js');
    const { hubRecordFrom } = await load(target, 'src/agentx/hub-sync.js');
    const skills = normalizeCustomSkills([
      hubRecordFrom({ slug: 'vneb-portal', version: '1.0.0', contentHash: 'sha256:aaa', content: VNEB_RENDER, baseUrl: HUB, createdAt: NOW }),
      hubRecordFrom({ slug: 'act-only', version: '1.0.0', contentHash: 'sha256:ccc', content: '# Act only\n\n```webbrain-skill\n{"summary": "Act only.", "modes": ["act"]}\n```\nBody', baseUrl: HUB, createdAt: NOW }),
    ]);
    const ask = getEligibleSkillCatalog(skills, { mode: 'ask', tier: 'full' });
    assert.deepEqual(ask.map((s) => s.id), ['hub_vneb-portal'], `${target}: Ask mode sees the skill that declares ask`);
    assert.deepEqual(ask[0].intents, ['vneb', 'electricity_price_lookup'], `${target}: intents reach the catalog`);
    const act = getEligibleSkillCatalog(skills, { mode: 'act', tier: 'mid' });
    assert.deepEqual(act.map((s) => s.id), ['hub_vneb-portal', 'hub_act-only'], `${target}: Act mode sees both`);
    const loader = buildSkillLoaderDefinition(skills, { mode: 'act', tier: 'full' });
    assert.deepEqual(loader.function.parameters.properties.skill_id.enum, ['hub_vneb-portal', 'hub_act-only'], `${target}: load_skill enumerates hub ids`);
    assert.equal(getEligibleSkillCatalog(skills, { mode: 'act', tier: 'compact' }).length, 0, `${target}: compact tier loads no skills`);
  }
});

// ---------------------------------------------------------------- hub-client

test('hub base URL rules: HTTPS, loopback HTTP, no credentials; storage override wins', async () => {
  const { normalizeHubBaseUrl, readHubConfig, writeHubConfig, AGENTX_HUB_CONFIG_STORAGE_KEY } = await load('chrome', 'src/agentx/hub-client.js');
  assert.equal(normalizeHubBaseUrl('https://skills.dev-server.cloud/'), 'https://skills.dev-server.cloud');
  assert.equal(normalizeHubBaseUrl('http://127.0.0.1:4173/'), 'http://127.0.0.1:4173');
  assert.equal(normalizeHubBaseUrl('http://localhost:8820'), 'http://localhost:8820');
  for (const bad of ['http://skills.dev-server.cloud', 'https://user:pw@hub.test', 'https://hub.test/?x=1', 'https://hub.test/#f', 'not a url', '']) {
    assert.throws(() => normalizeHubBaseUrl(bad), /HTTPS/, bad);
  }
  const fake = createApi();
  assert.deepEqual(await readHubConfig(fake.api, CONFIG), { baseUrl: HUB, source: 'default' });
  assert.deepEqual(await writeHubConfig(fake.api, { baseUrl: 'http://127.0.0.1:4173/' }), { baseUrl: 'http://127.0.0.1:4173', source: 'override' });
  assert.deepEqual(await readHubConfig(fake.api, CONFIG), { baseUrl: 'http://127.0.0.1:4173', source: 'override' });
  await assert.rejects(writeHubConfig(fake.api, { baseUrl: 'http://evil.test' }), /HTTPS/);
  fake.values[AGENTX_HUB_CONFIG_STORAGE_KEY] = { baseUrl: 'garbage' };
  assert.deepEqual(await readHubConfig(fake.api, CONFIG), { baseUrl: HUB, source: 'default' }, 'a broken override falls back to the default');
  assert.deepEqual(await writeHubConfig(fake.api, { baseUrl: '' }), { baseUrl: '', source: 'default' });
  assert.equal(Object.hasOwn(fake.values, AGENTX_HUB_CONFIG_STORAGE_KEY), false);
});

test('the client sends the ID token and device headers, parses render provenance, and classifies errors', async () => {
  const { createAgentXHubClient } = await load('chrome', 'src/agentx/hub-client.js');
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    const u = new URL(url);
    if (u.pathname === '/v1/skills/vneb-portal/versions/latest/render/webmate') {
      return textResponse(VNEB_RENDER, 200, { 'X-AgentX-Slug': 'vneb-portal', 'X-AgentX-Version': '1.0.0', 'X-AgentX-Content-Hash': 'sha256:aaa', 'X-AgentX-Signature': 'sig', 'X-AgentX-Kid': 'k1' });
    }
    if (u.pathname === '/v1/skills') return jsonResponse({ skills: [{ slug: 'vneb-portal', name: 'vneb-portal' }], next_cursor: null });
    if (u.pathname === '/v1/me/changes') return jsonResponse({ cursor: 7, installs: [], updates: [], org: null, events: [] });
    if (u.pathname === '/v1/installs' && init.method === 'POST') return jsonResponse({ id: 'inst-9', ...JSON.parse(init.body) }, 201);
    if (u.pathname === '/v1/installs/inst-9/report') return jsonResponse({ id: 'inst-9', reported_state: JSON.parse(init.body).state });
    if (u.pathname === '/v1/skills/private-one/versions/latest/render/webmate') return jsonResponse({ code: 'skill_not_found', message: 'No such skill.', detail: null }, 404);
    if (u.pathname === '/v1/me') return jsonResponse({ code: 'invalid_token', message: 'That token is not valid here.', detail: null }, 401);
    if (u.pathname === '/v1/me/installs') return jsonResponse({ code: 'identity_unavailable', message: 'realm down', detail: null }, 503);
    throw new Error(`unexpected ${u.pathname}`);
  };
  const fake = createApi();
  const client = createAgentXHubClient({ api: fake.api, config: CONFIG, fetchImpl, service: signedInService });

  const rendered = await client.getRender('vneb-portal');
  assert.equal(requests[0].url, `${HUB}/v1/skills/vneb-portal/versions/latest/render/webmate`);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer id-token-1');
  assert.equal(requests[0].init.headers['X-AgentX-Device'], DEVICE.id);
  assert.equal(requests[0].init.headers['X-AgentX-Device-Name'], DEVICE.name);
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.cache, 'no-store', 'latest moves under one URL: the browser cache must not answer');
  assert.deepEqual({ slug: rendered.slug, version: rendered.version, contentHash: rendered.contentHash, kid: rendered.kid }, { slug: 'vneb-portal', version: '1.0.0', contentHash: 'sha256:aaa', kid: 'k1' });
  assert.equal(rendered.content, VNEB_RENDER);

  await client.listBrowserSkills('vneb');
  assert.equal(new URL(requests[1].url).searchParams.get('kind'), 'browser');
  assert.equal(new URL(requests[1].url).searchParams.get('q'), 'vneb');
  await client.changes(5);
  assert.equal(new URL(requests[2].url).search, '?product=webmate&limit=200&cursor=5');
  await client.createInstall({ slug: 'vneb-portal', allDevices: true });
  assert.deepEqual(JSON.parse(requests[3].init.body), { slug: 'vneb-portal', product: 'webmate', desired_state: 'installed', device_id: null });
  await client.createInstall({ slug: 'vneb-portal', version: '1.0.0' });
  assert.deepEqual(JSON.parse(requests[4].init.body), { slug: 'vneb-portal', product: 'webmate', desired_state: 'installed', version: '1.0.0' }, 'a device-pinned install omits device_id so the header decides');
  await client.reportInstall('inst-9', { state: 'installed', version: '1.0.0' });
  assert.deepEqual(JSON.parse(requests[5].init.body), { state: 'installed', version: '1.0.0' });

  await assert.rejects(client.getRender('private-one'), (error) => error.code === 'skill_not_found' && error.status === 404 && !error.transient);
  await assert.rejects(client.me(), (error) => error.code === 'invalid_token' && error.status === 401);
  await assert.rejects(client.listMyInstalls(), (error) => error.code === 'identity_unavailable' && error.transient === true);
  await assert.rejects(client.getRender('Bad Slug'), (error) => error.code === 'invalid_request');

  // Signed out: the catalog is still reachable anonymously; installs are not.
  const anonymous = createAgentXHubClient({ api: fake.api, config: CONFIG, fetchImpl, service: signedOutService });
  await anonymous.listBrowserSkills('');
  assert.equal(requests.at(-1).init.headers.Authorization, undefined, 'no bearer when signed out');
  await assert.rejects(anonymous.createInstall({ slug: 'vneb-portal' }), (error) => error.code === 'not_signed_in');

  // Network failures and timeouts are transient, not "removed".
  const offline = createAgentXHubClient({ api: fake.api, config: CONFIG, service: signedInService, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.changes(), (error) => error.code === 'network_unavailable' && error.transient === true);
  const slow = createAgentXHubClient({ api: fake.api, config: CONFIG, service: signedInService, timeoutMs: 20, fetchImpl: (url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) });
  await assert.rejects(slow.changes(), (error) => error.code === 'request_timeout' && error.transient === true);
});

// ---------------------------------------------------------------- reconcile (pure)

test('reconcileHubSkills installs, is idempotent, updates, and never overwrites an edited copy', async () => {
  const { reconcileHubSkills } = await load('chrome', 'src/agentx/hub-sync.js');
  const { normalizeCustomSkills } = await load('chrome', 'src/agent/skills.js');
  const renders = { 'vneb-portal@latest': { slug: 'vneb-portal', version: '1.0.0', contentHash: 'sha256:aaa', content: VNEB_RENDER } };
  const fetched = [];
  const fetchRender = async (slug, version) => { fetched.push([slug, version]); const r = renders[`${slug}@${version}`]; if (!r) throw Object.assign(new Error('nope'), { code: 'skill_not_found' }); return r; };

  // 1. A fresh install row → fetch, record, report installed.
  const first = await reconcileHubSkills({ installs: [installRow()], skills: [], parked: {}, fetchRender, baseUrl: HUB, now: NOW });
  assert.equal(first.changed, true);
  assert.deepEqual(fetched, [['vneb-portal', 'latest']]);
  assert.equal(first.skills.length, 1);
  assert.deepEqual([first.skills[0].sourceType, first.skills[0].hubSlug, first.skills[0].hubVersion, first.skills[0].contentHash], ['hub', 'vneb-portal', '1.0.0', 'sha256:aaa']);
  assert.deepEqual(first.reports, [{ install_id: 'inst-1', slug: 'vneb-portal', state: 'installed', version: '1.0.0', error: '' }]);
  assert.deepEqual(first.counts.installed, 1);
  const skills = normalizeCustomSkills(first.skills);

  // 2. The same snapshot once the hub knows → nothing to fetch, nothing to report.
  const again = await reconcileHubSkills({ installs: [installRow({ reported_state: 'installed', reported_version: '1.0.0' })], skills, parked: {}, fetchRender, baseUrl: HUB, now: NOW });
  assert.equal(again.changed, false);
  assert.equal(fetched.length, 1);
  assert.deepEqual(again.reports, []);

  // 3. A new version on the hub (latest_content_hash moved) → refetch, replace in place, report the new version.
  renders['vneb-portal@latest'] = { slug: 'vneb-portal', version: '1.1.0', contentHash: 'sha256:bbb', content: VNEB_RENDER.replace('Case 1', 'Case 1 (bản mới)') };
  const updated = await reconcileHubSkills({ installs: [installRow({ latest_version: '1.1.0', latest_content_hash: 'sha256:bbb', reported_state: 'installed', reported_version: '1.0.0' })], skills, parked: {}, fetchRender, baseUrl: HUB, now: NOW });
  assert.equal(updated.changed, true);
  assert.equal(updated.skills[0].hubVersion, '1.1.0');
  assert.match(updated.skills[0].content, /bản mới/);
  assert.equal(updated.skills[0].createdAt, skills[0].createdAt, 'an update keeps the creation time');
  assert.deepEqual(updated.reports, [{ install_id: 'inst-1', slug: 'vneb-portal', state: 'installed', version: '1.1.0', error: '' }]);
  assert.equal(updated.counts.updated, 1);

  // 4. The person edited the copy (sourceType text, hub origin kept) → left alone, flagged, reported as the version it came from.
  const edited = normalizeCustomSkills([{ ...skills[0], sourceType: 'text', sourceUrl: '', content: `${VNEB_RENDER}\n\nMy notes\n` }]);
  const kept = await reconcileHubSkills({ installs: [installRow({ latest_version: '1.1.0', latest_content_hash: 'sha256:bbb', reported_state: 'installed', reported_version: '1.0.0' })], skills: edited, parked: {}, fetchRender, baseUrl: HUB, now: NOW });
  assert.equal(kept.changed, false, 'an edited copy is never overwritten');
  assert.match(kept.skills[0].content, /My notes/);
  assert.deepEqual(kept.notices['vneb-portal'], { kind: 'edited', updateAvailable: true, localVersion: '1.0.0', latestVersion: '1.1.0' });
  assert.deepEqual(kept.reports, [], 'already reported at 1.0.0: nothing new to say');
  assert.equal(kept.counts.edited, 1);
});

test('reconcileHubSkills removes, parks on disable, restores without a download, and reports failures per row', async () => {
  const { reconcileHubSkills } = await load('chrome', 'src/agentx/hub-sync.js');
  const { normalizeCustomSkills, MAX_CUSTOM_SKILLS } = await load('chrome', 'src/agent/skills.js');
  let fetches = 0;
  const fetchRender = async (slug) => {
    fetches += 1;
    if (slug === 'broken') throw Object.assign(new Error('The hub took too long'), { code: 'request_timeout' });
    // The hash the hub's snapshot row carries for the same bytes (installRow's latest_content_hash).
    return { slug, version: '1.0.0', contentHash: slug === 'vneb-portal' ? 'sha256:aaa' : `sha256:${slug}`, content: VNEB_RENDER.replace('vneb-portal', slug) };
  };
  const base = await reconcileHubSkills({ installs: [installRow()], skills: [], parked: {}, fetchRender, baseUrl: HUB, now: NOW });
  const skills = normalizeCustomSkills(base.skills);
  assert.equal(fetches, 1);

  // disabled (a yank) → parked, removed from the enabled list, reported.
  const disabled = await reconcileHubSkills({ installs: [installRow({ desired_state: 'disabled', reason: 'leaks the reactor code', reason_version: '1.0.0', reported_state: 'installed', reported_version: '1.0.0' })], skills, parked: {}, fetchRender, baseUrl: HUB, now: NOW });
  assert.equal(disabled.skills.length, 0);
  assert.equal(disabled.parked['vneb-portal'].hubSlug, 'vneb-portal', 'the record is kept, not deleted');
  assert.deepEqual(disabled.reports, [{ install_id: 'inst-1', slug: 'vneb-portal', state: 'disabled', version: '', error: '' }]);
  assert.deepEqual(disabled.notices['vneb-portal'], { kind: 'disabled', reason: 'leaks the reactor code', version: '1.0.0' });

  // installed again → restored from the parked copy, no download.
  const restored = await reconcileHubSkills({ installs: [installRow({ reported_state: 'disabled' })], skills: [], parked: disabled.parked, fetchRender, baseUrl: HUB, now: NOW });
  assert.equal(fetches, 1, 'no download to switch back on');
  assert.equal(restored.skills.length, 1 && restored.skills[0].hubSlug === 'vneb-portal' ? 1 : 0);
  assert.deepEqual(restored.parked, {});
  assert.deepEqual(restored.reports, [{ install_id: 'inst-1', slug: 'vneb-portal', state: 'installed', version: '1.0.0', error: '' }]);
  assert.equal(restored.counts.restored, 1);

  // removed → gone locally (an edited copy of another slug stays), reported.
  const fork = normalizeCustomSkills([{ id: 'hub_mine', sourceType: 'text', hubSlug: 'mine', hubVersion: '1.0.0', contentHash: 'sha256:m', content: '# Mine\n\nMy own text', createdAt: 1 }]);
  const removed = await reconcileHubSkills({
    installs: [installRow({ desired_state: 'removed', reported_state: 'installed', reported_version: '1.0.0' }), installRow({ id: 'inst-2', slug: 'mine', desired_state: 'removed' })],
    skills: [...restored.skills, ...fork], parked: {}, fetchRender, baseUrl: HUB, now: NOW,
  });
  assert.deepEqual(removed.skills.map((s) => s.id), ['hub_mine'], 'the hub record goes; the edited copy is the person’s own text');
  assert.deepEqual(removed.reports.map((r) => [r.install_id, r.state]), [['inst-1', 'removed'], ['inst-2', 'removed']]);

  // A pinned version row refetches the exact version when the local one differs.
  const pinned = await reconcileHubSkills({ installs: [installRow({ version: '0.9.0', reported_state: 'installed', reported_version: '1.0.0' })], skills, parked: {}, fetchRender, baseUrl: HUB, now: NOW });
  assert.equal(pinned.changed, true);
  assert.equal(fetches, 2);

  // One row fails to fetch → that row is reported failed; the others carry on. Two rows for one slug share one record and both hear back.
  const mixed = await reconcileHubSkills({
    installs: [installRow({ id: 'inst-b', slug: 'broken' }), installRow({ id: 'inst-d1', slug: 'other', device_id: DEVICE.id }), installRow({ id: 'inst-d2', slug: 'other', device_id: null })],
    skills: [], parked: {}, fetchRender, baseUrl: HUB, now: NOW,
  });
  assert.deepEqual(mixed.skills.map((s) => s.hubSlug), ['other']);
  assert.deepEqual(mixed.reports.map((r) => [r.install_id, r.state]), [['inst-b', 'failed'], ['inst-d1', 'installed'], ['inst-d2', 'installed']]);
  assert.match(mixed.reports[0].error, /^request_timeout: The hub took too long/);
  assert.deepEqual(mixed.notices.broken, { kind: 'failed', code: 'request_timeout', message: 'The hub took too long' });

  // The 40-skill ceiling is reported, not silently truncated by normalize.
  const full = normalizeCustomSkills(Array.from({ length: MAX_CUSTOM_SKILLS }, (_, i) => ({ id: `s${i}`, sourceType: 'text', content: `# S${i}\n\nBody`, createdAt: i })));
  const limited = await reconcileHubSkills({ installs: [installRow({ slug: 'one-more', id: 'inst-l' })], skills: full, parked: {}, fetchRender, baseUrl: HUB, now: NOW });
  assert.equal(limited.skills.length, MAX_CUSTOM_SKILLS);
  assert.deepEqual(limited.reports.map((r) => [r.install_id, r.state]), [['inst-l', 'failed']]);
  assert.match(limited.reports[0].error, /skill_limit_reached/);

  // A hub record the snapshot does not mention is left exactly where it is.
  const orphan = await reconcileHubSkills({ installs: [], skills, parked: {}, fetchRender, baseUrl: HUB, now: NOW });
  assert.equal(orphan.changed, false);
  assert.equal(orphan.skills.length, 1);
});

// ---------------------------------------------------------------- runner (alarms, storage, messages)

test('the runner registers the alarm, syncs the snapshot into customSkills, and reports back', async () => {
  const { createAgentXHubSyncRunner, AGENTX_HUB_SYNC_ALARM, AGENTX_HUB_SYNC_STATE_KEY } = await load('chrome', 'src/agentx/hub-sync.js');
  const { CUSTOM_SKILLS_STORAGE_KEY } = await load('chrome', 'src/agent/skills.js');
  const fake = createApi({ [CUSTOM_SKILLS_STORAGE_KEY]: [{ id: 'humanizer', name: 'Humanizer', sourceType: 'built-in', sourceUrl: 'skills/humanizer.md', content: '# Humanizer\n\nBody', createdAt: 0 }] });
  const hub = fakeHub({ installs: [installRow()], renders: { 'vneb-portal@latest': { slug: 'vneb-portal', version: '1.0.0', contentHash: 'sha256:aaa', content: VNEB_RENDER } } });
  const runner = createAgentXHubSyncRunner({ api: fake.api, client: hub, config: CONFIG, extensionVersion: '1.0.3', now: () => NOW });
  runner.install();
  assert.deepEqual(fake.alarms.map((a) => a.name), [AGENTX_HUB_SYNC_ALARM]);
  assert.equal(fake.alarms[0].info.periodInMinutes, 5, 'plan §2.6: poll every five minutes');
  assert.equal(fake.onAlarm.size(), 1);
  assert.equal(fake.onMessageExternal.size(), 1);
  // install() kicks off a startup sync; wait for it and then sync explicitly.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = await runner.syncNow({ reason: 'test' });
  assert.equal(result.status, 'synced', JSON.stringify(result));
  const stored = fake.values[CUSTOM_SKILLS_STORAGE_KEY];
  assert.deepEqual(stored.map((s) => s.id), ['humanizer', 'hub_vneb-portal'], 'the packaged skill stays; the hub skill is appended');
  assert.equal(stored[1].sourceType, 'hub');
  assert.equal(stored[1].sourceUrl, `${HUB}/skills/vneb-portal`);
  assert.ok(hub.calls.reports.some((r) => r.id === 'inst-1' && r.state === 'installed' && r.version === '1.0.0'));
  assert.equal(fake.values[AGENTX_HUB_SYNC_STATE_KEY].cursor, 42);
  assert.equal(fake.values[AGENTX_HUB_SYNC_STATE_KEY].lastStatus, 'synced');
  // The alarm drives the same path.
  hub.installs[0].reported_state = 'installed';
  hub.installs[0].reported_version = '1.0.0';
  const before = hub.calls.changes;
  fake.onAlarm.emit({ name: AGENTX_HUB_SYNC_ALARM });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(hub.calls.changes, before + 1);
  fake.onAlarm.emit({ name: 'somebody-elses-alarm' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(hub.calls.changes, before + 1, 'other alarms are ignored');
  const status = await runner.status();
  assert.equal(status.signedIn, true);
  assert.equal(status.baseUrl, HUB);
  assert.deepEqual(status.installed.map((s) => [s.slug, s.version, s.sourceType]), [['vneb-portal', '1.0.0', 'hub']]);
  assert.equal(status.externalChannel, true);
  assert.equal(status.extensionVersion, '1.0.3');
});

test('losing the hub is not a revocation: offline, reauth and signed-out syncs leave skills alone', async () => {
  const { createAgentXHubSyncRunner } = await load('chrome', 'src/agentx/hub-sync.js');
  const { CUSTOM_SKILLS_STORAGE_KEY } = await load('chrome', 'src/agent/skills.js');
  const { hubRecordFrom } = await load('chrome', 'src/agentx/hub-sync.js');
  const installed = [hubRecordFrom({ slug: 'vneb-portal', version: '1.0.0', contentHash: 'sha256:aaa', content: VNEB_RENDER, baseUrl: HUB, createdAt: 1 })];

  const offlineFake = createApi({ [CUSTOM_SKILLS_STORAGE_KEY]: installed });
  const offlineHub = fakeHub({ failChanges: Object.assign(new Error('Failed to fetch'), { code: 'network_unavailable', transient: true }) });
  const offline = await createAgentXHubSyncRunner({ api: offlineFake.api, client: offlineHub, config: CONFIG, now: () => NOW }).syncNow();
  assert.equal(offline.status, 'offline');
  assert.equal(offline.error.code, 'network_unavailable');
  assert.equal(offlineFake.values[CUSTOM_SKILLS_STORAGE_KEY].length, 1, 'nothing removed');

  const authFake = createApi({ [CUSTOM_SKILLS_STORAGE_KEY]: installed });
  const authHub = fakeHub({ failChanges: Object.assign(new Error('rejected'), { code: 'invalid_token', status: 401 }) });
  let clock = NOW;
  const authRunner = createAgentXHubSyncRunner({ api: authFake.api, client: authHub, config: CONFIG, now: () => clock });
  assert.equal((await authRunner.syncNow()).status, 'reauth');
  clock += 60_000;
  assert.equal((await authRunner.syncNow()).status, 'reauth');
  assert.equal(authHub.calls.changes, 1, 'a rejected bearer is not retried for five minutes');
  clock += 5 * 60_000;
  await authRunner.syncNow();
  assert.equal(authHub.calls.changes, 2, '…then it is');
  assert.equal(authFake.values[CUSTOM_SKILLS_STORAGE_KEY].length, 1);

  const outFake = createApi({ [CUSTOM_SKILLS_STORAGE_KEY]: installed });
  const outHub = fakeHub({ signedIn: false });
  const out = await createAgentXHubSyncRunner({ api: outFake.api, client: outHub, config: CONFIG, now: () => NOW }).syncNow();
  assert.equal(out.status, 'not_signed_in');
  assert.equal(outHub.calls.changes, 0);
  assert.equal(outFake.values[CUSTOM_SKILLS_STORAGE_KEY].length, 1);
});

test('the external channel answers ping and install only, and only for the hub origin', async () => {
  const { createAgentXHubSyncRunner, AGENTX_HUB_MESSAGE_PING, AGENTX_HUB_MESSAGE_INSTALL } = await load('chrome', 'src/agentx/hub-sync.js');
  const { CUSTOM_SKILLS_STORAGE_KEY } = await load('chrome', 'src/agent/skills.js');
  const fake = createApi();
  const hub = fakeHub({ renders: { 'vneb-portal@latest': { slug: 'vneb-portal', version: '1.0.0', contentHash: 'sha256:aaa', content: VNEB_RENDER } } });
  const runner = createAgentXHubSyncRunner({ api: fake.api, client: hub, config: CONFIG, extensionVersion: '1.0.3', now: () => NOW });
  runner.install();

  const send = (message, sender) => new Promise((resolve) => {
    const listeners = [];
    fake.onMessageExternal.emit(message, sender, (response) => resolve(response));
    void listeners;
  });
  const hubSender = { origin: HUB, url: `${HUB}/skills/vneb-portal`, id: 'page' };

  const stranger = await send({ type: AGENTX_HUB_MESSAGE_PING }, { origin: 'https://evil.example', url: 'https://evil.example/' });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.error.code, 'origin_not_allowed');
  const strangerInstall = await send({ type: AGENTX_HUB_MESSAGE_INSTALL, slug: 'vneb-portal' }, { url: 'https://evil.example/x' });
  assert.equal(strangerInstall.error.code, 'origin_not_allowed');
  assert.equal(hub.calls.renders.length, 0, 'a foreign page never triggers a download');

  const ping = await send({ type: AGENTX_HUB_MESSAGE_PING }, hubSender);
  assert.deepEqual(ping, { ok: true, product: 'webmate', extensionVersion: '1.0.3', hub: HUB, signedIn: true, messageTypes: [AGENTX_HUB_MESSAGE_PING, AGENTX_HUB_MESSAGE_INSTALL] });

  const unknown = await send({ type: 'agentx-hub/uninstall', slug: 'vneb-portal' }, hubSender);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'unsupported_message');
  const noType = await send('agentx-hub/install', hubSender);
  assert.equal(noType.error.code, 'unsupported_message');

  const badSlug = await send({ type: AGENTX_HUB_MESSAGE_INSTALL, slug: '../etc' }, hubSender);
  assert.equal(badSlug.ok, false);
  assert.equal(badSlug.error.code, 'invalid_request');

  const started = Date.now();
  const installed = await send({ type: AGENTX_HUB_MESSAGE_INSTALL, slug: 'vneb-portal', version: 'latest' }, hubSender);
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.skill.id, 'hub_vneb-portal');
  assert.equal(installed.skill.version, '1.0.0');
  assert.deepEqual([...installed.skill.modes].sort(), ['act', 'ask']);
  assert.ok(Date.now() - started < 3000, 'acceptance: the skill is in storage within 3 seconds');
  const stored = fake.values[CUSTOM_SKILLS_STORAGE_KEY];
  assert.deepEqual(stored.map((s) => s.id), ['hub_vneb-portal']);
  assert.equal(stored[0].content, VNEB_RENDER.trim(), 'the extension fetched the render itself; the page sent no content');
  assert.deepEqual(hub.calls.renders, [['vneb-portal', 'latest']]);
  assert.equal(hub.calls.created.length, 0, 'the web already recorded the install row');
  // The page's message never carries content, and a message that tries is ignored.
  const smuggled = await send({ type: AGENTX_HUB_MESSAGE_INSTALL, slug: 'vneb-portal', content: '# evil' }, hubSender);
  assert.equal(smuggled.ok, true);
  assert.equal(fake.values[CUSTOM_SKILLS_STORAGE_KEY][0].content, VNEB_RENDER.trim());

  // Signed out: the page is told, nothing is written.
  const outFake = createApi();
  const outRunner = createAgentXHubSyncRunner({ api: outFake.api, client: fakeHub({ signedIn: false }), config: CONFIG, now: () => NOW });
  const outPing = await outRunner.handleExternalMessage({ type: AGENTX_HUB_MESSAGE_PING }, hubSender);
  assert.equal(outPing.signedIn, false);
  const outInstall = await outRunner.handleExternalMessage({ type: AGENTX_HUB_MESSAGE_INSTALL, slug: 'vneb-portal' }, hubSender);
  assert.equal(outInstall.ok, false);
  assert.equal(outInstall.error.code, 'not_signed_in');
  assert.equal(outFake.values[CUSTOM_SKILLS_STORAGE_KEY], undefined);

  // Without the channel (Firefox) install() still works and status says so.
  const ffFake = createApi({}, { external: false });
  const ffRunner = createAgentXHubSyncRunner({ api: ffFake.api, client: fakeHub(), config: CONFIG, now: () => NOW });
  ffRunner.install();
  assert.equal((await ffRunner.status()).externalChannel, false);
});

test('Settings installs go through the background: install records a device row, reinstall replaces an edited copy, uninstall removes hub rows', async () => {
  const { createAgentXHubSyncRunner } = await load('chrome', 'src/agentx/hub-sync.js');
  const { CUSTOM_SKILLS_STORAGE_KEY, normalizeCustomSkills } = await load('chrome', 'src/agent/skills.js');
  const fake = createApi();
  const hub = fakeHub({ renders: { 'vneb-portal@latest': { slug: 'vneb-portal', version: '1.0.0', contentHash: 'sha256:aaa', content: VNEB_RENDER }, 'vneb-portal@1.0.0': { slug: 'vneb-portal', version: '1.0.0', contentHash: 'sha256:aaa', content: VNEB_RENDER } } });
  const runner = createAgentXHubSyncRunner({ api: fake.api, client: hub, config: CONFIG, now: () => NOW });

  const first = await runner.installFromHub({ slug: 'vneb-portal' });
  assert.equal(first.ok, true);
  assert.equal(first.replacedEdited, false);
  assert.deepEqual(hub.calls.created, [{ slug: 'vneb-portal', version: null, allDevices: false }], 'Settings pins the install to this device');
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The person edits it by hand, then reinstalls from Settings: their copy is replaced, and the response says so.
  const edited = normalizeCustomSkills(fake.values[CUSTOM_SKILLS_STORAGE_KEY]).map((s) => ({ ...s, sourceType: 'text', sourceUrl: '', content: `${s.content}\nmine` }));
  fake.values[CUSTOM_SKILLS_STORAGE_KEY] = edited;
  const second = await runner.installFromHub({ slug: 'vneb-portal', version: '1.0.0' });
  assert.equal(second.replacedEdited, true);
  assert.equal(fake.values[CUSTOM_SKILLS_STORAGE_KEY][0].sourceType, 'hub');
  assert.equal(fake.values[CUSTOM_SKILLS_STORAGE_KEY][0].content, VNEB_RENDER.trim());
  await new Promise((resolve) => setTimeout(resolve, 0));

  hub.installs.push(installRow({ id: 'inst-a', device_id: DEVICE.id }), installRow({ id: 'inst-b', device_id: null }), installRow({ id: 'inst-c', slug: 'other' }));
  const removed = await runner.uninstallFromHub({ slug: 'vneb-portal' });
  assert.deepEqual(removed, { ok: true, removed: true, rows: 2 });
  assert.deepEqual(hub.calls.removed, ['inst-a', 'inst-b'], 'every row for the slug, none for other skills');
  assert.deepEqual(fake.values[CUSTOM_SKILLS_STORAGE_KEY], []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(runner.installFromHub({ slug: 'nope..' }), (error) => error.code === 'invalid_request');

  // An explicit Remove also takes an edited copy away (the sync path never would).
  fake.values[CUSTOM_SKILLS_STORAGE_KEY] = normalizeCustomSkills([{ id: 'hub_vneb-portal', sourceType: 'text', hubSlug: 'vneb-portal', hubVersion: '1.0.0', contentHash: 'sha256:aaa', content: `${VNEB_RENDER}\nmine`, createdAt: 1 }]);
  hub.installs.length = 0;
  const removedFork = await runner.uninstallFromHub({ slug: 'vneb-portal' });
  assert.deepEqual(removedFork, { ok: true, removed: true, rows: 0 });
  assert.deepEqual(fake.values[CUSTOM_SKILLS_STORAGE_KEY], []);
});

// ---------------------------------------------------------------- Settings card

test('the Settings card labels hub records, renders search results and installed rows, and translates errors', async () => {
  for (const target of ['chrome', 'firefox']) {
    const { agentxHubSourceLabel, describeHubError, createAgentXHubSettingsController } = await load(target, 'src/ui/agentx-hub-settings.js');
    assert.equal(agentxHubSourceLabel({ sourceType: 'hub', hubSlug: 'vneb-portal', hubVersion: '1.0.0' }, 'vi'), 'Từ AgentX Hub · vneb-portal@1.0.0');
    assert.equal(agentxHubSourceLabel({ sourceType: 'text', hubSlug: 'vneb-portal', hubVersion: '1.0.0' }, 'en'), 'Edited from AgentX Hub (vneb-portal@1.0.0)');
    assert.equal(agentxHubSourceLabel({ sourceType: 'url', sourceUrl: 'https://x' }, 'vi'), '', 'non-hub records fall through to the upstream label');
    assert.match(describeHubError({ code: 'not_signed_in' }, 'vi'), /đăng nhập AgentX/);
    assert.match(describeHubError({ code: 'skill_limit_reached', detail: { max: 40 } }, 'en'), /40 skills/);
    assert.match(describeHubError({ code: 'weird_code' }, 'en'), /weird_code/);

    const fake = createApi();
    const messages = [];
    const root = { innerHTML: '', dataset: {}, addEventListener() {} };
    const controller = createAgentXHubSettingsController({
      api: fake.api,
      root,
      locale: () => 'vi',
      sendToBackground: async (action, data) => {
        messages.push([action, data]);
        if (action === 'agentx_hub_status') {
          return {
            ok: true, signedIn: true, subject: 'user-123', baseUrl: HUB, baseUrlSource: 'default', externalChannel: target === 'chrome', lastSyncAt: NOW, lastStatus: 'synced', lastError: null,
            installed: [{ id: 'hub_vneb-portal', name: 'vneb-portal', slug: 'vneb-portal', version: '1.0.0', sourceType: 'hub' }, { id: 'hub_mine', name: 'Mine', slug: 'mine', version: '1.0.0', sourceType: 'text' }],
            parked: ['parked-one'], notices: { mine: { kind: 'edited', updateAvailable: true, localVersion: '1.0.0', latestVersion: '1.1.0' }, 'parked-one': { kind: 'disabled', reason: 'yanked', version: '1.0.0' } }, updates: [], org: { org_id: 'astralx', skills: [{ slug: 'team-portal', name: 'Team portal', version: '1.0.0' }] },
          };
        }
        if (action === 'agentx_hub_install') return { ok: true, skill: { name: 'vneb-portal', version: '1.0.0' } };
        return { ok: true };
      },
      clientOptions: { service: signedInService, fetchImpl: async () => jsonResponse({ skills: [{ slug: 'vneb-portal', name: 'vneb-portal', description: 'Tra cứu VNEB', latest_version: '1.1.0', visibility: 'private', scan: { verdict: 'safe' }, owner: { slug: 'astralx' }, downloads: 3 }, { slug: 'other', name: 'Other', description: '', latest_version: '2.0.0', visibility: 'public', scan: { verdict: 'caution' } }], next_cursor: null }) },
    });
    await controller.initialize();
    assert.match(root.innerHTML, /AgentX Skill Hub/);
    assert.match(root.innerHTML, /Đang đăng nhập: user-123/);
    assert.match(root.innerHTML, /data-hub-installed="vneb-portal"/);
    assert.match(root.innerHTML, /Từ AgentX Hub · vneb-portal/);
    assert.match(root.innerHTML, /đã sửa tay/, 'the edited copy is flagged');
    assert.match(root.innerHTML, /có bản v1\.1\.0/, 'and told a newer version exists');
    assert.match(root.innerHTML, /data-hub-parked="parked-one"/);
    assert.match(root.innerHTML, /hub đã tắt — yanked/);
    assert.match(root.innerHTML, /Team portal v1\.0\.0/);
    assert.match(root.innerHTML, target === 'chrome' ? /Cài một chạm từ trang hub: sẵn sàng/ : /không có kênh cài một chạm/);
    await controller.search('vneb');
    assert.match(root.innerHTML, /data-hub-result="vneb-portal"/);
    assert.match(root.innerHTML, /Cập nhật lên v1\.1\.0/, 'installed at 1.0.0, hub at 1.1.0 → update');
    assert.match(root.innerHTML, /data-hub-result="other"/);
    assert.match(root.innerHTML, /data-hub-action="install" data-hub-slug="other"/);
    assert.match(root.innerHTML, /cần chú ý/);
    assert.match(root.innerHTML, /an toàn/);
    assert.match(root.innerHTML, new RegExp(`href="${HUB}/skills/vneb-portal"`));
    assert.doesNotMatch(root.innerHTML, /<script/i);
  }
});

// ---------------------------------------------------------------- build output

test('brand build: manifest channel (Chrome only), runtime config, Settings wiring, background wiring', async () => {
  const chromeManifest = JSON.parse(await fs.readFile(DIST('chrome', 'manifest.json'), 'utf8'));
  assert.deepEqual(chromeManifest.externally_connectable, { matches: ['https://skills.dev-server.cloud/*'] }, 'exactly the hub origin (plan §8 decision 2)');
  const firefoxManifest = JSON.parse(await fs.readFile(DIST('firefox', 'manifest.json'), 'utf8'));
  assert.equal(firefoxManifest.externally_connectable, undefined, 'Firefox has no such channel');
  for (const target of ['chrome', 'firefox']) {
    const runtime = await fs.readFile(DIST(target, 'src/agentx/runtime-config.js'), 'utf8');
    assert.match(runtime, /"skillHubBaseUrl": "https:\/\/skills\.dev-server\.cloud"/, `${target}: runtime config carries the hub`);
    const skills = await fs.readFile(DIST(target, 'src/agent/skills.js'), 'utf8');
    assert.match(skills, /export const MAX_CUSTOM_SKILLS = 40;/, `${target}: limit raised`);
    assert.match(skills, /normalizeHubProvenance/, `${target}: patch 080 applied`);
    const background = await fs.readFile(DIST(target, 'src/background.js'), 'utf8');
    assert.match(background, /createAgentXHubSyncRunner\(\{/, `${target}: patch 081 applied`);
    assert.match(background, /case 'agentx_hub_install':/, `${target}: background answers Settings installs`);
    assert.match(background, new RegExp(`api: ${target === 'chrome' ? 'chrome' : 'browser'},`), `${target}: the right extension API`);
    const html = await fs.readFile(DIST(target, 'src/ui/settings.html'), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="agentx-hub\.css">/, `${target}: card stylesheet`);
    assert.match(html, /id="agentx-hub-card"/, `${target}: card container`);
    assert.ok(html.indexOf('id="agentx-hub-card"') < html.indexOf('id="packaged-skills-card"'), `${target}: the hub card sits above the packaged skills`);
    const settings = await fs.readFile(DIST(target, 'src/ui/settings.js'), 'utf8');
    assert.match(settings, /createAgentXHubSettingsController\(\{/, `${target}: patch 082 applied`);
    assert.match(settings, /agentxHubSourceLabel\(skill, getLocale\(\)\)/, `${target}: hub records are labelled in the enabled list`);
    assert.match(settings, /await agentxHubController\.initialize\(\)/, `${target}: the card initialises with the page`);
    const gate = await fs.readFile(DIST(target, 'src/ui/agentx-login-gate.js'), 'utf8');
    assert.match(gate, /sendToBackground\('agentx_hub_sync', \{ reason: 'panel' \}\)/, `${target}: the panel nudges a sync when it opens`);
    for (const file of ['src/agentx/hub-client.js', 'src/agentx/hub-sync.js', 'src/ui/agentx-hub-settings.js', 'src/ui/agentx-hub.css']) {
      await fs.access(DIST(target, file));
    }
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(error?.stack || error);
  }
}
console.log(`\nAgentX hub: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
