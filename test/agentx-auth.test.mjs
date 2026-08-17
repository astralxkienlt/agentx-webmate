import { strict as assert } from 'node:assert';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_ROOT = path.join(ROOT, 'brand-dist/chrome');
const SERVICE_PATH = path.join(CHROME_ROOT, 'src/agentx/cloud-service.js');
const CONTROLLER_PATH = path.join(CHROME_ROOT, 'src/ui/agentx-cloud-settings.js');
const UI_PATH = path.join(CHROME_ROOT, 'src/ui/agentx-cloud-ui.js');
const OPENAI_PROVIDER_PATH = path.join(CHROME_ROOT, 'src/providers/openai.js');
const TRANSCRIBE_PATH = path.join(CHROME_ROOT, 'src/agent/transcribe.js');

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const {
  AGENTX_CREDENTIAL_STORAGE_KEY,
  AGENTX_DEVICE_STORAGE_KEY,
  AGENTX_SESSION_STORAGE_KEY,
  createAgentXCloudService,
  normalizeHttpsBaseUrl,
} = await import(pathToFileURL(SERVICE_PATH).href);
const { createAgentXCloudSettingsController } = await import(pathToFileURL(CONTROLLER_PATH).href);
const { renderAgentXCloudPanel } = await import(pathToFileURL(UI_PATH).href);
const { OpenAICompatibleProvider } = await import(pathToFileURL(OPENAI_PROVIDER_PATH).href);
const { transcribeAudio } = await import(pathToFileURL(TRANSCRIBE_PATH).href);

const ISSUER = 'https://identity.example.test/realms/agentx';
const CLIENT_ID = 'agentx-workmate';
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;
const CONFIG = Object.freeze({
  secondBrainBaseUrl: 'https://brain.dev-server.cloud',
  litellmBaseUrl: 'https://aigw.dev-server.cloud/v1',
  oidcIssuer: ISSUER,
  oidcClientId: CLIENT_ID,
  oidcScopes: 'openid profile email',
  oidcProvidersPath: '/api/auth/providers',
  oidcRedirectUris: ['http://127.0.0.1:47821/callback'],
  requestTimeoutMs: 250,
  authTimeoutMs: 1_000,
});
const NOW = 1_800_000_000_000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

function session(overrides = {}) {
  return {
    idToken: jwt({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'user-123',
      email: 'kien@example.test',
      name: 'Kien',
      exp: Math.floor((NOW + 10 * 60_000) / 1000),
    }),
    refreshToken: 'refresh-1',
    expiresAt: NOW + 10 * 60_000,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    tokenEndpoint: TOKEN_ENDPOINT,
    endSessionEndpoint: `${ISSUER}/logout`,
    revocationEndpoint: `${ISSUER}/revoke`,
    redirectUri: CONFIG.oidcRedirectUris[0],
    user: {
      subject: 'user-123',
      email: 'kien@example.test',
      displayName: 'Kien',
    },
    obtainedAt: NOW,
    ...overrides,
  };
}

function credential(overrides = {}) {
  return {
    subject: 'user-123',
    authority: CONFIG.secondBrainBaseUrl,
    key: 'sk-existing-secret',
    baseUrl: CONFIG.litellmBaseUrl,
    models: ['model-a'],
    model: 'model-a',
    keyAlias: 'agentx-kien',
    keyToken: 'key-handle',
    account: 'kien',
    status: 'reused',
    cachedAt: NOW,
    provisionOutcome: 'reused',
    warningCode: '',
    ...overrides,
  };
}

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function createApi(seed = {}, { onTabCreated } = {}) {
  const values = structuredClone(seed);
  const onUpdated = createEvent();
  const onRemoved = createEvent();
  let nextTabId = 40;
  return {
    values,
    api: {
      storage: {
        local: {
          async get(keys) {
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(names.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
          },
          async set(patch) {
            Object.assign(values, structuredClone(patch));
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
          },
        },
      },
      runtime: {
        async getPlatformInfo() {
          return { os: 'mac' };
        },
      },
      tabs: {
        onUpdated,
        onRemoved,
        async create(details) {
          const tab = { id: nextTabId++, ...details };
          setTimeout(() => onTabCreated?.(tab, { onUpdated, onRemoved }), 0);
          return tab;
        },
        async remove() {},
      },
    },
  };
}

function service(api, fetchImpl) {
  return createAgentXCloudService({
    api,
    config: CONFIG,
    fetchImpl,
    cryptoImpl: webcrypto,
    now: () => NOW,
  });
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('runtime URLs are normalized and reject unsafe credentials', () => {
  assert.equal(
    normalizeHttpsBaseUrl('https://aigw.dev-server.cloud/', 'gateway', { openAiCompatible: true }),
    'https://aigw.dev-server.cloud/v1',
  );
  assert.throws(
    () => normalizeHttpsBaseUrl('https://user:secret@example.test', 'gateway'),
    /HTTPS/,
  );
});

test('signed-out UI surfaces structured discovery errors and busy labels', () => {
  const errorMarkup = renderAgentXCloudPanel({
    signedIn: false,
    error: {
      code: 'oidc_discovery_failed',
      message: 'Dịch vụ trả HTTP 404.',
    },
  }, 'vi');
  assert.match(errorMarkup, /Kết nối Cloud thất bại/);
  assert.match(errorMarkup, /HTTP 404/);

  const busyMarkup = renderAgentXCloudPanel({
    signedIn: false,
    action: 'signing-in',
  }, 'en');
  assert.match(busyMarkup, /Opening secure sign-in/);
});

test('AgentX provider sends only model-key bearer authentication', () => {
  const provider = Object.create(OpenAICompatibleProvider.prototype);
  provider.config = {
    providerName: 'agentx-cloud',
    apiKey: 'sk-model-key',
    agentxCloudManaged: true,
  };
  const headers = provider._headers();
  assert.equal(headers.Authorization, 'Bearer sk-model-key');
  assert.equal(headers['X-WebBrain-Device-Id'], undefined);
  assert.equal(headers['X-WebBrain-Client'], undefined);
  assert.equal(headers['X-WebBrain-Help-Improve'], undefined);
});

test('AgentX provider refuses missing or non-gateway models', () => {
  const provider = Object.create(OpenAICompatibleProvider.prototype);
  provider.config = {
    providerName: 'agentx-cloud',
    apiKey: 'sk-model-key',
    agentxCloudManaged: true,
    models: ['gateway-model-a', 'gateway-model-b'],
    model: 'gateway-model-b',
    extraBody: { model: 'hard-coded-external-model' },
  };

  assert.equal(provider.model, 'gateway-model-b');
  assert.equal(provider._buildChatCompletionsBody([], {}).model, 'gateway-model-b');

  provider.config.model = 'hard-coded-external-model';
  assert.throws(() => provider.model, /not available through this gateway key/);
  provider.config.model = '';
  assert.throws(() => provider.model, /requires an active model selected from the gateway/);
});

test('AgentX transcription refuses a model outside the gateway allowlist', async () => {
  const providers = new Map([[
    'webbrain_cloud',
    {
      config: {
        type: 'openai',
        providerName: 'agentx-cloud',
        baseUrl: CONFIG.litellmBaseUrl,
        apiKey: 'sk-model-key',
      },
    },
  ]]);
  const result = await transcribeAudio(providers, new Blob(['audio'], { type: 'audio/webm' }), {
    providerId: 'webbrain_cloud',
    modelOverride: 'whisper-1',
    allowedModels: ['gateway-model-a'],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /blocked/);
});

test('authorization code + PKCE uses ID token and provisions the configured gateway', async () => {
  let authUrl;
  let modelRequest;
  let tokenRequest;
  let providersRequested = false;
  const fake = createApi({}, {
    onTabCreated(tab, events) {
      authUrl = new URL(tab.url);
      const callback = new URL(CONFIG.oidcRedirectUris[0]);
      callback.searchParams.set('code', 'authorization-code');
      callback.searchParams.set('state', authUrl.searchParams.get('state'));
      events.onUpdated.emit(tab.id, { url: callback.toString() });
    },
  });
  const fetchImpl = async (url, init = {}) => {
    const requestUrl = String(url);
    if (requestUrl === `${CONFIG.secondBrainBaseUrl}/api/auth/providers`) {
      providersRequested = true;
      return jsonResponse({
        providers: [{
          name: 'keycloak',
          supports_native_oidc: true,
          native_oidc: {
            issuer: ISSUER,
            client_id: CLIENT_ID,
            scopes: 'openid profile email',
            confidential: false,
          },
        }],
      });
    }
    if (requestUrl === `${ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: TOKEN_ENDPOINT,
        end_session_endpoint: `${ISSUER}/logout`,
        revocation_endpoint: `${ISSUER}/revoke`,
      });
    }
    if (requestUrl === TOKEN_ENDPOINT) {
      tokenRequest = init;
      return jsonResponse({
        id_token: jwt({
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: 'user-123',
          email: 'kien@example.test',
          name: 'Kien',
          nonce: authUrl.searchParams.get('nonce'),
          exp: Math.floor((NOW + 10 * 60_000) / 1000),
        }),
        access_token: 'must-not-be-used',
        refresh_token: 'refresh-1',
      });
    }
    if (requestUrl === `${CONFIG.secondBrainBaseUrl}/v1/model-key`) {
      modelRequest = init;
      return jsonResponse({
        key: 'sk-new-secret',
        key_alias: 'agentx-kien',
        token: 'handle-1',
        base_url: 'https://aigw.dev-server.cloud/',
        models: ['model-a', 'model-b'],
        default_model: 'model-a',
        status: 'issued',
        account: 'kien',
      });
    }
    if (requestUrl === `${CONFIG.litellmBaseUrl}/models`) {
      return jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const result = await service(fake.api, fetchImpl).signInAndProvision();
  const tokenForm = new URLSearchParams(tokenRequest.body);
  assert.equal(tokenForm.get('grant_type'), 'authorization_code');
  assert.equal(tokenForm.get('client_secret'), null);
  assert.ok(tokenForm.get('code_verifier'));
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('client_id'), CONFIG.oidcClientId);
  assert.equal(providersRequested, false);
  assert.equal(modelRequest.headers.Authorization, `Bearer ${result.session.idToken}`);
  assert.notEqual(modelRequest.headers.Authorization, 'Bearer must-not-be-used');
  assert.deepEqual(JSON.parse(modelRequest.body), { rotate: false });
  assert.match(modelRequest.headers['X-AgentX-Device'], /^[0-9a-f-]{36}$/);
  assert.equal(result.credential.baseUrl, CONFIG.litellmBaseUrl);
  assert.equal(result.credential.model, 'model-a');
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY].user.email, 'kien@example.test');
  assert.equal(fake.values[AGENTX_DEVICE_STORAGE_KEY].id, modelRequest.headers['X-AgentX-Device']);
});

test('LiteLLM model list overrides stale Second Brain model metadata', async () => {
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
  });
  let gatewayAuthorization = '';
  let modelKeyRequestBody;
  const result = await service(fake.api, async (url, init = {}) => {
    const requestUrl = String(url);
    if (requestUrl === `${CONFIG.secondBrainBaseUrl}/v1/model-key`) {
      modelKeyRequestBody = JSON.parse(init.body);
      return jsonResponse({
        key: 'sk-legacy-key',
        base_url: 'https://aigw.dev-server.cloud',
        models: ['hard-coded-external-model', 'model-secondary'],
        default_model: 'hard-coded-external-model',
        status: 'reused',
      });
    }
    if (requestUrl === `${CONFIG.litellmBaseUrl}/models`) {
      gatewayAuthorization = init.headers.Authorization;
      return jsonResponse({
        data: [
          { id: 'model-primary' },
          { id: 'model-secondary' },
          { id: 'model-primary' },
        ],
      });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  }).retryProvision();

  assert.deepEqual(modelKeyRequestBody, { rotate: false });
  assert.equal(gatewayAuthorization, 'Bearer sk-legacy-key');
  assert.deepEqual(result.credential.models, ['model-primary', 'model-secondary']);
  assert.equal(result.credential.model, 'model-primary');
  assert.equal(result.credential.models.includes('hard-coded-external-model'), false);
  assert.equal(
    fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].model,
    'model-primary',
  );
});

test('callback state is validated before OAuth errors or token exchange', async () => {
  let tokenRequested = false;
  let providersRequested = false;
  const fake = createApi({}, {
    onTabCreated(tab, events) {
      const callback = new URL(CONFIG.oidcRedirectUris[0]);
      callback.searchParams.set('state', 'attacker-state');
      callback.searchParams.set('error', 'access_denied');
      events.onUpdated.emit(tab.id, { url: callback.toString() });
    },
  });
  const fetchImpl = async (url) => {
    if (String(url) === `${CONFIG.secondBrainBaseUrl}/api/auth/providers`) {
      providersRequested = true;
      return jsonResponse({
        providers: [{
          native_oidc: {
            issuer: ISSUER,
            client_id: CLIENT_ID,
            confidential: false,
          },
        }],
      });
    }
    if (String(url) === `${ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: TOKEN_ENDPOINT,
      });
    }
    tokenRequested = true;
    throw new Error('Token endpoint must not be called');
  };
  await assert.rejects(
    () => service(fake.api, fetchImpl).signIn(),
    (error) => error.code === 'state_mismatch',
  );
  assert.equal(tokenRequested, false);
  assert.equal(providersRequested, false);
});

test('cached key is reused after one successful LiteLLM probe', async () => {
  const cached = credential();
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const requests = [];
  const result = await service(fake.api, async (url) => {
    requests.push(String(url));
    return jsonResponse({ data: [{ id: 'model-a' }] });
  }).retryProvision();
  assert.equal(result.credential.key, cached.key);
  assert.equal(result.credential.provisionOutcome, 'reused-local');
  assert.deepEqual(requests, [`${CONFIG.litellmBaseUrl}/models`]);
});

test('cached model selection is replaced when the gateway no longer exposes it', async () => {
  const cached = credential({
    model: 'removed-model',
    models: ['removed-model', 'model-a'],
  });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const result = await service(
    fake.api,
    async () => jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
  ).retryProvision();

  assert.deepEqual(result.credential.models, ['model-a', 'model-b']);
  assert.equal(result.credential.model, 'model-a');
  assert.equal(fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].model, 'model-a');
});

test('a rejected cached key fetches current key with rotate false', async () => {
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
  });
  let requestBody;
  let modelProbeCount = 0;
  const result = await service(fake.api, async (url, init = {}) => {
    if (String(url).endsWith('/models')) {
      modelProbeCount++;
      return modelProbeCount === 1
        ? jsonResponse({ error: 'invalid key' }, 401)
        : jsonResponse({ data: [{ id: 'model-b' }] });
    }
    requestBody = JSON.parse(init.body);
    return jsonResponse({
      key: 'sk-current-secret',
      base_url: 'https://aigw.dev-server.cloud',
      models: ['model-b'],
      default_model: 'model-b',
      status: 'reused',
    });
  }).retryProvision();
  assert.deepEqual(requestBody, { rotate: false });
  assert.equal(result.credential.key, 'sk-current-secret');
  assert.equal(
    fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].key,
    'sk-current-secret',
  );
});

test('transient gateway failure retains the usable cached key', async () => {
  const cached = credential();
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const result = await service(fake.api, async () => jsonResponse({ error: 'down' }, 503))
    .retryProvision();
  assert.equal(result.credential.key, cached.key);
  assert.equal(result.credential.provisionOutcome, 'stale-offline');
  assert.equal(fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].key, cached.key);
});

test('an authoritative empty gateway model list never falls back to a stale cached model', async () => {
  const cached = credential({ model: 'removed-model', models: ['removed-model'] });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const cloud = service(fake.api, async (url) => {
    if (String(url).endsWith('/models')) return jsonResponse({ data: [] });
    return jsonResponse({
      key: 'sk-current-secret',
      base_url: CONFIG.litellmBaseUrl,
      models: ['removed-model'],
      default_model: 'removed-model',
      status: 'reused',
    });
  });
  await assert.rejects(
    () => cloud.retryProvision(),
    (error) => error.code === 'gateway_models_empty',
  );
});

test('invalid_grant clears auth session but never deletes cached model key', async () => {
  const cached = credential();
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({ expiresAt: NOW - 1 }),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const restored = await service(fake.api, async () => jsonResponse({ error: 'invalid_grant' }, 400))
    .restoreSession();
  assert.equal(restored.outcome, 'needs-login');
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY], undefined);
  assert.equal(fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records[0].key, cached.key);
});

test('explicit sign-out clears only the current account credential', async () => {
  const current = credential();
  const other = credential({
    subject: 'other-user',
    key: 'sk-other-secret',
    account: 'other',
  });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [current, other] },
  });
  await service(fake.api, async () => new Response(null, { status: 204 })).signOut();
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY], undefined);
  assert.deepEqual(
    fake.values[AGENTX_CREDENTIAL_STORAGE_KEY].records.map((record) => record.subject),
    ['other-user'],
  );
});

test('settings controller installs the key and persists a valid model selection', async () => {
  const cached = credential({ models: ['model-a', 'model-b'] });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const calls = [];
  const providerState = {
    providers: { webbrain_cloud: { type: 'openai', category: 'cloud' } },
    active: 'openai',
  };
  const controller = createAgentXCloudSettingsController({
    api: fake.api,
    config: CONFIG,
    locale: () => 'vi',
    async sendToBackground(action, data = {}) {
      calls.push({ action, data });
      if (action === 'update_provider') {
        Object.assign(providerState.providers.webbrain_cloud, data.config);
        return { ok: true };
      }
      if (action === 'set_active_provider') {
        providerState.active = data.providerId;
        return { ok: true };
      }
      if (action === 'get_providers') return structuredClone(providerState);
      throw new Error(`Unexpected background action: ${action}`);
    },
    onProvidersChanged(next) {
      Object.assign(providerState, next);
    },
    onRender() {},
    serviceOptions: {
      fetchImpl: async () => jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
      cryptoImpl: webcrypto,
      now: () => NOW,
    },
  });

  // The cached key probe succeeds, then the controller installs/activates it.
  await controller.initialize();

  const update = calls.find((call) => call.action === 'update_provider');
  assert.equal(update.data.config.apiKey, cached.key);
  assert.equal(update.data.config.baseUrl, CONFIG.litellmBaseUrl);
  assert.equal(update.data.config.providerName, 'agentx-cloud');
  assert.equal(update.data.config.agentxCloudManaged, true);
  assert.equal(providerState.active, 'webbrain_cloud');
  assert.equal(controller.isConnected(), true);
  const markup = controller.render();
  assert.doesNotMatch(markup, /sk-existing-secret/);
  assert.doesNotMatch(markup, /manage-billing|btn-duplicate/);
  assert.match(markup, /aigw\.dev-server\.cloud/);
  assert.match(markup, /data-agentx-cloud-model/);
  assert.match(markup, /model-b/);

  await controller.selectModel('model-b');
  assert.equal(controller.status().provider.model, 'model-b');
  assert.equal(providerState.providers.webbrain_cloud.model, 'model-b');

  // Restoring the Cloud session must preserve a still-available user choice
  // instead of replacing it with Second Brain's first/default model.
  await controller.initialize();
  const updates = calls.filter((call) => call.action === 'update_provider');
  assert.equal(updates.at(-1).data.config.model, 'model-b');
  assert.match(controller.render(), /value="model-b" selected/);
});

test('both branded targets keep Cloud auth in settings without occupying the side panel', async () => {
  for (const target of ['chrome', 'firefox']) {
    const root = path.join(ROOT, 'brand-dist', target);
    const [html, settings, runtime, manager, openai, sidepanelHtml, sidepanelJs] = await Promise.all([
      fs.readFile(path.join(root, 'src/ui/settings.html'), 'utf8'),
      fs.readFile(path.join(root, 'src/ui/settings.js'), 'utf8'),
      fs.readFile(path.join(root, 'src/agentx/runtime-config.js'), 'utf8'),
      fs.readFile(path.join(root, 'src/providers/manager.js'), 'utf8'),
      fs.readFile(path.join(root, 'src/providers/openai.js'), 'utf8'),
      fs.readFile(path.join(root, 'src/ui/sidepanel.html'), 'utf8'),
      fs.readFile(path.join(root, 'src/ui/sidepanel.js'), 'utf8'),
    ]);
    assert.match(html, /agentx-cloud\.css/);
    assert.match(settings, /createAgentXCloudSettingsController/);
    assert.doesNotMatch(settings, /btn-manage-billing|api\.webbrain\.one\/account/);
    assert.match(runtime, /https:\/\/brain\.dev-server\.cloud/);
    assert.match(runtime, /https:\/\/aigw\.dev-server\.cloud\/v1/);
    assert.match(runtime, /https:\/\/agentx\.astralx\.com\.vn\/auth\/realms\/agent-hub/);
    assert.match(runtime, /"oidcClientId": "agentx-workmate"/);
    assert.match(manager, /baseUrl: AGENTX_RUNTIME_CONFIG\.litellmBaseUrl/);
    assert.match(manager, /providerName: 'agentx-cloud'/);
    assert.match(manager, /requiresModel: true/);
    assert.match(manager, /activeProviderId === WEBBRAIN_CLOUD_PROVIDER_ID/);
    assert.match(openai, /not available through this gateway key/);
    assert.doesNotMatch(manager, /webbrain-cloud 1\.0|api\.webbrain\.one\/v1/);
    assert.doesNotMatch(sidepanelHtml, /agentx-cloud-sidepanel|agentx-cloud\.css/);
    assert.doesNotMatch(sidepanelJs, /createAgentXCloudSettingsController|agentxCloudController/);
  }

  const [transcribe, recorderHost] = await Promise.all([
    fs.readFile(path.join(CHROME_ROOT, 'src/agent/transcribe.js'), 'utf8'),
    fs.readFile(path.join(CHROME_ROOT, 'src/recorder/host.js'), 'utf8'),
  ]);
  assert.match(transcribe, /restrictedProviderId/);
  assert.match(transcribe, /active AgentX Cloud model is not in the gateway model list/);
  assert.match(recorderHost, /allowedModels: activeConfig\.models/);
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
console.log(`\nAgentX auth: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
