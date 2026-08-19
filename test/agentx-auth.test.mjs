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
const GATE_PATH = path.join(CHROME_ROOT, 'src/ui/agentx-login-gate.js');
const OPENAI_PROVIDER_PATH = path.join(CHROME_ROOT, 'src/providers/openai.js');
const TRANSCRIBE_PATH = path.join(CHROME_ROOT, 'src/agent/transcribe.js');
const MODELS_PATH = path.join(CHROME_ROOT, 'src/agentx/cloud-models.js');

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const {
  AGENTX_CREDENTIAL_STORAGE_KEY,
  AGENTX_DEVICE_STORAGE_KEY,
  AGENTX_SESSION_STORAGE_KEY,
  createAgentXCloudService,
  normalizeHttpsBaseUrl,
} = await import(pathToFileURL(SERVICE_PATH).href);
const { createAgentXCloudSettingsController } = await import(pathToFileURL(CONTROLLER_PATH).href);
const { createAgentXLoginGate } = await import(pathToFileURL(GATE_PATH).href);
const { renderAgentXCloudPanel } = await import(pathToFileURL(UI_PATH).href);
const { OpenAICompatibleProvider } = await import(pathToFileURL(OPENAI_PROVIDER_PATH).href);
const { transcribeAudio } = await import(pathToFileURL(TRANSCRIBE_PATH).href);
const {
  resolveCloudVisionSidecar,
  visionModelsFromGateway,
} = await import(pathToFileURL(MODELS_PATH).href);

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
// The Viettel SSO wrapper shape: no /.well-known/openid-configuration to read,
// so the endpoints discovery would have supplied are configured instead, and
// ID tokens arrive signed with a symmetric alg the extension cannot verify.
const WRAPPER_ISSUER = 'https://sso.example.test/sso-wrapper';
const WRAPPER_TOKEN_ENDPOINT = `${WRAPPER_ISSUER}/token`;
const WRAPPER_CONFIG = Object.freeze({
  ...CONFIG,
  oidcIssuer: WRAPPER_ISSUER,
  oidcAuthorizationEndpoint: `${WRAPPER_ISSUER}/authorize`,
  oidcTokenEndpoint: WRAPPER_TOKEN_ENDPOINT,
  oidcIdTokenAlg: 'HS256',
});
const NOW = 1_800_000_000_000;
// Short enough to step over inside a test, long enough that the service's
// once-a-minute activity write throttle still behaves as it does in the panel.
const IDLE_MS = 30 * 60_000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jwt(claims, alg = 'RS256') {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg, typ: 'JWT' })}.${encode(claims)}.signature`;
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
  const onChanged = createEvent();
  let nextTabId = 40;
  let nextWindowId = 900;
  const createdTabs = [];
  const createdWindows = [];
  return {
    values,
    createdTabs,
    createdWindows,
    storageChanged: onChanged,
    api: {
      storage: {
        onChanged,
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
          createdTabs.push(tab);
          setTimeout(() => onTabCreated?.(tab, { onUpdated, onRemoved }), 0);
          return tab;
        },
        async remove() {},
      },
      windows: {
        async create(details) {
          const id = nextWindowId++;
          const tab = { id: nextTabId++, windowId: id, ...details };
          const window = { id, tabs: [tab] };
          createdWindows.push(window);
          setTimeout(() => onTabCreated?.(tab, { onUpdated, onRemoved }), 0);
          return window;
        },
        async remove() {},
      },
    },
  };
}

function serviceWith(config, api, fetchImpl) {
  return createAgentXCloudService({
    api,
    config,
    fetchImpl,
    cryptoImpl: webcrypto,
    now: () => NOW,
  });
}

function service(api, fetchImpl) {
  return serviceWith(CONFIG, api, fetchImpl);
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
  assert.match(errorMarkup, /Không kết nối được Cloud/);
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

// Drives a full sign-in against the wrapper shape. Every request is recorded so
// a test can assert on what was *not* fetched: reaching for the discovery
// document at all is the regression worth catching here.
function wrapperSignIn(makeIdToken) {
  const requested = [];
  let authUrl;
  const fake = createApi({}, {
    onTabCreated(tab, events) {
      authUrl = new URL(tab.url);
      const callback = new URL(WRAPPER_CONFIG.oidcRedirectUris[0]);
      callback.searchParams.set('code', 'authorization-code');
      callback.searchParams.set('state', authUrl.searchParams.get('state'));
      events.onUpdated.emit(tab.id, { url: callback.toString() });
    },
  });
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    requested.push(requestUrl);
    if (requestUrl === WRAPPER_TOKEN_ENDPOINT) {
      return jsonResponse({
        id_token: makeIdToken(authUrl.searchParams.get('nonce')),
        refresh_token: 'refresh-1',
      });
    }
    if (requestUrl === `${CONFIG.secondBrainBaseUrl}/v1/model-key`) {
      return jsonResponse({
        key: 'sk-new-secret',
        base_url: 'https://aigw.dev-server.cloud/',
        default_model: 'model-a',
        status: 'issued',
      });
    }
    if (requestUrl === `${CONFIG.litellmBaseUrl}/models`) {
      return jsonResponse({ data: [{ id: 'model-a' }] });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };
  return {
    fake,
    requested,
    authUrl: () => authUrl,
    run: () => serviceWith(WRAPPER_CONFIG, fake.api, fetchImpl).signInAndProvision(),
  };
}

function wrapperIdToken(nonce, alg) {
  return jwt({
    iss: WRAPPER_ISSUER,
    aud: WRAPPER_CONFIG.oidcClientId,
    sub: 'user-123',
    email: 'kien@example.test',
    name: 'Kien',
    nonce,
    exp: Math.floor((NOW + 10 * 60_000) / 1000),
  }, alg);
}

test('a provider without a discovery document signs in from configured endpoints', async () => {
  const flow = wrapperSignIn((nonce) => wrapperIdToken(nonce, 'HS256'));
  const result = await flow.run();

  assert.equal(
    flow.requested.some((url) => url.includes('/.well-known/openid-configuration')),
    false,
  );
  const authUrl = flow.authUrl();
  assert.equal(`${authUrl.origin}${authUrl.pathname}`, `${WRAPPER_ISSUER}/authorize`);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('client_id'), WRAPPER_CONFIG.oidcClientId);
  assert.equal(result.session.tokenEndpoint, WRAPPER_TOKEN_ENDPOINT);
  assert.equal(result.session.idTokenAlg, 'HS256');
  // Nothing advertises these without a discovery document, and guessing a
  // revocation URL would POST the refresh token somewhere that may not be one.
  assert.equal(result.session.endSessionEndpoint, '');
  assert.equal(result.session.revocationEndpoint, '');
  assert.equal(result.credential.model, 'model-a');
});

test('sign-in opens its own window so the panel document survives the round trip', async () => {
  const flow = wrapperSignIn((nonce) => wrapperIdToken(nonce, 'HS256'));
  await flow.run();

  // The side panel is enabled per tab and ships no default path. Opening the
  // authorization page as a tab in the current window activates a tab the panel
  // was never enabled on, so Chrome closes the panel — and the listener waiting
  // on the loopback callback dies with the panel document. Sign-in then hangs
  // with nothing to show the user. Its own window keeps the panel's tab active.
  assert.equal(flow.fake.createdWindows.length, 1);
  assert.equal(flow.fake.createdTabs.length, 0);
  assert.match(flow.fake.createdWindows[0].tabs[0].url, /\/sso-wrapper\/authorize\?/);
});

test('an ID token signed with an unconfigured algorithm is refused', async () => {
  for (const alg of ['RS256', 'none']) {
    const flow = wrapperSignIn((nonce) => wrapperIdToken(nonce, alg));
    await assert.rejects(flow.run(), (error) => {
      assert.equal(error.code, 'invalid_token');
      return true;
    }, `alg ${alg} must not be accepted`);
    assert.equal(flow.fake.values[AGENTX_SESSION_STORAGE_KEY], undefined);
  }
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

test('settings controller can select a Cloud vision model without exposing the key', async () => {
  const cached = credential({
    models: ['model-a', 'Qwen/Qwen2.5-VL-7B'],
    visionModels: ['Qwen/Qwen2.5-VL-7B'],
    visionFromInfo: ['Qwen/Qwen2.5-VL-7B'],
  });
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session(),
    [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [cached] },
  });
  const providerState = {
    providers: { webbrain_cloud: { type: 'openai', category: 'cloud' } },
    active: 'openai',
  };
  const controller = createAgentXCloudSettingsController({
    api: fake.api,
    config: CONFIG,
    locale: () => 'vi',
    async sendToBackground(action, data = {}) {
      if (action === 'update_provider') {
        Object.assign(providerState.providers.webbrain_cloud, data.config);
        return { ok: true };
      }
      if (action === 'set_active_provider') {
        providerState.active = data.providerId;
        return { ok: true };
      }
      if (action === 'get_providers') return structuredClone(providerState);
      if (action === 'test_vision_provider') {
        return { ok: true, model: providerState.providers.webbrain_cloud.agentxCloudVisionModel };
      }
      throw new Error(`Unexpected background action: ${action}`);
    },
    onRender() {},
    serviceOptions: {
      fetchImpl: async () => jsonResponse({
        data: [
          { id: 'model-a' },
          { id: 'Qwen/Qwen2.5-VL-7B', supports_vision: true },
        ],
      }),
      cryptoImpl: webcrypto,
      now: () => NOW,
    },
  });

  await controller.initialize();
  const visionMarkup = controller.renderVision();
  assert.doesNotMatch(visionMarkup, /sk-existing-secret/);
  assert.match(visionMarkup, /data-agentx-cloud-vision-model/);
  assert.match(visionMarkup, /Qwen\/Qwen2\.5-VL-7B/);
  assert.match(visionMarkup, /Chưa chọn/);

  await controller.selectVisionModel('Qwen/Qwen2.5-VL-7B');
  assert.equal(controller.status().provider.visionModel, 'Qwen/Qwen2.5-VL-7B');
  assert.equal(
    providerState.providers.webbrain_cloud.agentxCloudVisionModel,
    'Qwen/Qwen2.5-VL-7B',
  );
  assert.match(controller.renderVision(), /value="Qwen\/Qwen2\.5-VL-7B" selected/);
  assert.doesNotMatch(controller.renderVision(), /sk-existing-secret/);
});

test('Cloud vision sidecar uses the gateway key and ignores an empty selection', () => {
  const cloudConfig = {
    agentxCloudManaged: true,
    apiKey: 'sk-existing-secret',
    baseUrl: CONFIG.litellmBaseUrl,
    models: ['model-a', 'Qwen/Qwen2.5-VL-7B'],
    agentxCloudVisionModels: ['Qwen/Qwen2.5-VL-7B'],
    agentxCloudVisionModel: 'Qwen/Qwen2.5-VL-7B',
  };
  const sidecar = resolveCloudVisionSidecar(cloudConfig);
  assert.equal(sidecar.providerName, 'agentx-cloud');
  assert.equal(sidecar.model, 'Qwen/Qwen2.5-VL-7B');
  assert.equal(sidecar.apiKey, 'sk-existing-secret');
  assert.equal(sidecar.supportsVision, true);
  assert.equal(resolveCloudVisionSidecar({ ...cloudConfig, agentxCloudVisionModel: '' }), null);
  assert.equal(
    resolveCloudVisionSidecar({ ...cloudConfig, agentxCloudVisionModel: 'outside-gateway' }),
    null,
  );
  assert.deepEqual(
    visionModelsFromGateway(['model-a', 'Qwen/Qwen2.5-VL-7B']),
    ['Qwen/Qwen2.5-VL-7B'],
  );
});

// ─── Sign-in gate ─────────────────────────────────────────────────────────
// The gate runs in the side panel, so these tests stand in a DOM small enough
// to keep the assertions about behaviour rather than about markup.
function fakeElement(tag = 'div') {
  const classes = new Set();
  return {
    tag,
    textContent: '',
    disabled: false,
    inert: false,
    attributes: {},
    listeners: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      this.listeners[type] = (this.listeners[type] || []).filter((fn) => fn !== handler);
    },
    emit(type, ...args) {
      for (const handler of [...(this.listeners[type] || [])]) handler(...args);
    },
  };
}

function fakeGateDom() {
  const parts = {
    eyebrow: fakeElement('p'),
    title: fakeElement('h1'),
    body: fakeElement('p'),
    notice: fakeElement('p'),
    busy: fakeElement('p'),
    busyLabel: fakeElement('span'),
    signin: fakeElement('button'),
    footnote: fakeElement('p'),
  };
  const selectors = {
    '[data-agentx-gate-eyebrow]': parts.eyebrow,
    '[data-agentx-gate-title]': parts.title,
    '[data-agentx-gate-body]': parts.body,
    '[data-agentx-gate-notice]': parts.notice,
    '[data-agentx-gate-busy]': parts.busy,
    '[data-agentx-gate-busy-label]': parts.busyLabel,
    '[data-agentx-gate-signin]': parts.signin,
    '[data-agentx-gate-footnote]': parts.footnote,
  };
  const root = fakeElement('div');
  root.querySelector = (selector) => selectors[selector] || null;
  const documentRef = fakeElement('document');
  documentRef.body = fakeElement('body');
  documentRef.visibilityState = 'visible';
  return { root, appRoot: fakeElement('div'), documentRef, parts };
}

function gateHarness({ seed, clock, fetchImpl }) {
  const fake = createApi(seed);
  const dom = fakeGateDom();
  const calls = [];
  const providerState = {
    providers: { webbrain_cloud: { type: 'openai', category: 'cloud' } },
    active: 'openai',
  };
  const gate = createAgentXLoginGate({
    api: fake.api,
    root: dom.root,
    appRoot: dom.appRoot,
    documentRef: dom.documentRef,
    locale: () => 'vi',
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
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
    serviceOptions: {
      fetchImpl: fetchImpl || (async () => jsonResponse({ data: [{ id: 'model-a' }] })),
      cryptoImpl: webcrypto,
      now: () => clock.now,
    },
  });
  return { gate, dom, calls, providerState, values: fake.values, storageChanged: fake.storageChanged };
}

test('an untouched session expires on its idle deadline and reports why', async () => {
  const clock = { now: NOW };
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
  });
  const svc = createAgentXCloudService({
    api: fake.api,
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
    fetchImpl: async () => { throw new Error('no network expected'); },
    cryptoImpl: webcrypto,
    now: () => clock.now,
  });

  clock.now = NOW + IDLE_MS - 1;
  assert.equal((await svc.publicStatus()).signedIn, true);

  clock.now = NOW + IDLE_MS;
  const expired = await svc.publicStatus();
  assert.equal(expired.signedIn, false);
  assert.equal(expired.idleExpired, true);
  assert.equal(expired.outcome, 'idle-expired');
  // The session is gone, so a later read cannot resurrect it.
  assert.equal(Object.hasOwn(fake.values, AGENTX_SESSION_STORAGE_KEY), false);
});

test('a session stored before idle expiry shipped is anchored to when it was issued', async () => {
  const clock = { now: NOW + IDLE_MS + 1 };
  const stored = session();
  delete stored.lastActiveAt;
  const fake = createApi({ [AGENTX_SESSION_STORAGE_KEY]: stored });
  const svc = createAgentXCloudService({
    api: fake.api,
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
    fetchImpl: async () => { throw new Error('no network expected'); },
    cryptoImpl: webcrypto,
    now: () => clock.now,
  });
  const status = await svc.publicStatus();
  assert.equal(status.signedIn, false);
  assert.equal(status.idleExpired, true);
});

test('touchSession pushes the idle deadline out and throttles storage writes', async () => {
  const clock = { now: NOW };
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
  });
  const svc = createAgentXCloudService({
    api: fake.api,
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
    fetchImpl: async () => { throw new Error('no network expected'); },
    cryptoImpl: webcrypto,
    now: () => clock.now,
  });

  clock.now = NOW + IDLE_MS - 1_000;
  assert.equal((await svc.touchSession({ force: true })).persisted, true);
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY].lastActiveAt, clock.now);

  // Past the original deadline, alive on the refreshed one.
  clock.now = NOW + IDLE_MS + 1;
  assert.equal((await svc.publicStatus()).signedIn, true);

  // A second touch inside the write interval stays in memory only.
  const persistedAt = fake.values[AGENTX_SESSION_STORAGE_KEY].lastActiveAt;
  const touchedAt = clock.now + 5_000;
  clock.now = touchedAt;
  assert.equal((await svc.touchSession()).persisted, false);
  assert.equal(fake.values[AGENTX_SESSION_STORAGE_KEY].lastActiveAt, persistedAt);

  // Touching a session that already went idle re-locks instead of reviving it.
  // The throttled touch above still moved the in-memory stamp, so the live
  // deadline runs from that touch rather than from the last storage write.
  clock.now = touchedAt + IDLE_MS;
  const dead = await svc.touchSession({ force: true });
  assert.deepEqual(dead, { signedIn: false, idleExpired: true });
});

test('activity in one document keeps the session alive for the other', async () => {
  const clock = { now: NOW };
  const fake = createApi({
    [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
  });
  const options = {
    api: fake.api,
    config: { ...CONFIG, sessionIdleTimeoutMs: IDLE_MS },
    fetchImpl: async () => { throw new Error('no network expected'); },
    cryptoImpl: webcrypto,
    now: () => clock.now,
  };
  // Two surfaces, two service instances — the panel and a Settings tab.
  const panel = createAgentXCloudService(options);
  const settings = createAgentXCloudService(options);

  // Both cache the session, then only the panel sees any activity.
  assert.equal((await panel.publicStatus()).signedIn, true);
  assert.equal((await settings.publicStatus()).signedIn, true);

  clock.now = NOW + IDLE_MS - 1_000;
  await panel.touchSession({ force: true });

  // The Settings tab has been sitting on a stale copy the whole time; it must
  // not decide the busy session went idle.
  clock.now = NOW + IDLE_MS + 1;
  assert.equal((await settings.publicStatus()).signedIn, true);
  assert.equal(Object.hasOwn(fake.values, AGENTX_SESSION_STORAGE_KEY), true);
});

test('the side panel stays locked until the cloud key is installed', async () => {
  const clock = { now: NOW };
  const harness = gateHarness({
    clock,
    seed: {
      [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
    },
  });

  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.dom.appRoot.inert, false);

  await harness.gate.start();
  harness.gate.stop();

  assert.equal(harness.gate.isLocked(), false);
  assert.equal(harness.dom.root.classList.contains('hidden'), true);
  assert.equal(harness.dom.appRoot.inert, false);
  assert.equal(harness.dom.appRoot.attributes['aria-hidden'], undefined);
  assert.equal(harness.providerState.active, 'webbrain_cloud');
  const update = harness.calls.find((call) => call.action === 'update_provider');
  assert.equal(update.data.config.apiKey, 'sk-existing-secret');
  assert.equal(update.data.config.agentxCloudManaged, true);
});

test('a signed-out panel offers sign-in and never unlocks on its own', async () => {
  const clock = { now: NOW };
  const harness = gateHarness({ clock, seed: {} });

  const pending = harness.gate.start();
  const settled = await Promise.race([
    pending.then(() => 'unlocked'),
    Promise.resolve('still-locked'),
  ]);
  harness.gate.stop();

  assert.equal(settled, 'still-locked');
  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.dom.root.classList.contains('hidden'), false);
  assert.equal(harness.dom.appRoot.inert, true);
  assert.equal(harness.dom.parts.signin.textContent, 'Đăng nhập bằng Viettel SSO');
  assert.equal(harness.calls.length, 0);
});

test('the panel re-locks with an idle notice once the session times out', async () => {
  const clock = { now: NOW };
  const harness = gateHarness({
    clock,
    seed: {
      [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
    },
  });
  await harness.gate.start();
  assert.equal(harness.gate.isLocked(), false);

  clock.now = NOW + IDLE_MS;
  await harness.gate.checkSession();
  // relock() kicks off a fresh status read; let it settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.gate.stop();

  assert.equal(harness.gate.isLocked(), true);
  assert.equal(harness.dom.appRoot.inert, true);
  assert.equal(harness.dom.root.classList.contains('hidden'), false);
  assert.match(harness.dom.parts.notice.textContent, /không dùng/);
});

test('signing out elsewhere re-locks the panel that is already open', async () => {
  const clock = { now: NOW };
  const harness = gateHarness({
    clock,
    seed: {
      [AGENTX_SESSION_STORAGE_KEY]: session({ lastActiveAt: NOW }),
      [AGENTX_CREDENTIAL_STORAGE_KEY]: { version: 1, records: [credential()] },
    },
  });
  await harness.gate.start();
  assert.equal(harness.gate.isLocked(), false);

  delete harness.values[AGENTX_SESSION_STORAGE_KEY];
  harness.storageChanged.emit(
    { [AGENTX_SESSION_STORAGE_KEY]: { oldValue: {}, newValue: undefined } },
    'local',
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.gate.stop();

  assert.equal(harness.gate.isLocked(), true);
  assert.match(harness.dom.parts.notice.textContent, /đăng xuất/);
});

test('both branded targets gate the side panel and keep Cloud management in settings', async () => {
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
    assert.match(html, /agentx-cloud-vision-panel/);
    assert.match(settings, /createAgentXCloudSettingsController/);
    assert.match(settings, /renderAgentXCloudVisionSettings/);
    assert.doesNotMatch(settings, /btn-manage-billing|api\.webbrain\.one\/account/);
    assert.match(runtime, /https:\/\/brain\.dev-server\.cloud/);
    assert.match(runtime, /https:\/\/aigw\.dev-server\.cloud\/v1/);
    assert.match(runtime, /"oidcIssuer": "https:\/\/netmind\.viettel\.vn\/sso-wrapper"/);
    assert.match(runtime, /"oidcClientId": "netmind-extension"/);
    // The wrapper serves no discovery document, so these carry what discovery
    // would have supplied. Dropping them silently breaks sign-in.
    assert.match(
      runtime,
      /"oidcAuthorizationEndpoint": "https:\/\/netmind\.viettel\.vn\/sso-wrapper\/authorize"/,
    );
    assert.match(
      runtime,
      /"oidcTokenEndpoint": "https:\/\/netmind\.viettel\.vn\/sso-wrapper\/token"/,
    );
    assert.match(runtime, /"oidcIdTokenAlg": "HS256"/);
    assert.match(manager, /baseUrl: AGENTX_RUNTIME_CONFIG\.litellmBaseUrl/);
    assert.match(manager, /providerName: 'agentx-cloud'/);
    assert.match(manager, /requiresModel: true/);
    assert.match(manager, /resolveCloudVisionSidecar/);
    assert.match(manager, /activeProviderId === WEBBRAIN_CLOUD_PROVIDER_ID/);
    assert.match(openai, /not available through this gateway key/);
    assert.doesNotMatch(manager, /webbrain-cloud 1\.0|api\.webbrain\.one\/v1/);
    // The panel carries the sign-in gate only. Model switching, connection
    // tests and sign-out stay on the Settings card, so the gate's copy never
    // has to duplicate them.
    assert.doesNotMatch(sidepanelHtml, /agentx-cloud-sidepanel|agentx-cloud\.css/);
    assert.doesNotMatch(sidepanelJs, /createAgentXCloudSettingsController|agentxCloudController/);
    assert.match(sidepanelHtml, /agentx-login-gate\.css/);
    assert.match(sidepanelHtml, /id="agentx-login-gate"/);
    assert.match(sidepanelHtml, /data-agentx-gate-signin/);
    // Ships without `hidden`: the gate must be up before its module parses.
    assert.match(sidepanelHtml, /class="agentx-gate"\n/);
    assert.match(sidepanelJs, /createAgentXLoginGate/);
    // Onboarding must not start asking about providers before sign-in settles.
    assert.match(sidepanelJs, /await agentxSignedIn\.catch\(\(\) => \{\}\);/);
  }

  const [transcribe, recorderHost] = await Promise.all([
    fs.readFile(path.join(CHROME_ROOT, 'src/agent/transcribe.js'), 'utf8'),
    fs.readFile(path.join(CHROME_ROOT, 'src/recorder/host.js'), 'utf8'),
  ]);
  assert.match(transcribe, /restrictedProviderId/);
  assert.match(transcribe, /active netMind Cloud model is not in the gateway model list/);
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
