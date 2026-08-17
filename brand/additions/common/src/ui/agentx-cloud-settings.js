import { AGENTX_RUNTIME_CONFIG } from '../agentx/runtime-config.js';
import { createAgentXCloudService, AgentXCloudError } from '../agentx/cloud-service.js';
import { bindAgentXCloudPanel, renderAgentXCloudPanel } from './agentx-cloud-ui.js';

const PROVIDER_ID = 'webbrain_cloud';

function publicProvider(credential) {
  if (!credential) return null;
  return {
    account: credential.account || '',
    baseUrl: credential.baseUrl || '',
    model: credential.model || '',
    models: Array.isArray(credential.models) ? [...credential.models] : [],
    keyAlias: credential.keyAlias || '',
    status: credential.status || credential.provisionOutcome || '',
  };
}

function publicError(error) {
  if (!error) return null;
  return {
    code: String(error.code || 'unknown_error'),
    message: String(error.message || 'Unknown error'),
    detail: String(error.detail || ''),
    status: Number(error.status) || 0,
    transient: error.transient === true,
  };
}

/**
 * Bridges the standalone AgentX auth service into the existing provider page.
 * The controller owns only UI state; tokens and plaintext keys never enter DOM.
 */
export function createAgentXCloudSettingsController({
  api,
  locale = () => 'en',
  sendToBackground,
  onProvidersChanged,
  onRender,
  config = AGENTX_RUNTIME_CONFIG,
  serviceOptions = {},
}) {
  if (typeof sendToBackground !== 'function') {
    throw new TypeError('sendToBackground is required');
  }

  const service = createAgentXCloudService({ ...serviceOptions, api, config });
  let running = null;
  let status = {
    signedIn: false,
    connected: false,
    action: 'restoring',
    error: null,
    provider: null,
    configuredLiteLlmBaseUrl: config.litellmBaseUrl,
    secondBrainBaseUrl: config.secondBrainBaseUrl,
  };

  function paint(patch = {}) {
    status = { ...status, ...patch };
    onRender?.();
    return status;
  }

  async function refreshProviders() {
    const refreshed = await sendToBackground('get_providers');
    onProvidersChanged?.(refreshed);
    return refreshed;
  }

  async function installCredential(credential) {
    const models = Array.isArray(credential.models)
      ? [...new Set(credential.models.map(String).map((model) => model.trim()).filter(Boolean))]
      : [String(credential.model || '').trim()].filter(Boolean);
    const current = await sendToBackground('get_providers').catch(() => null);
    const currentModel = String(current?.providers?.[PROVIDER_ID]?.model || '').trim();
    const credentialModel = String(credential.model || '').trim();
    const model = models.includes(currentModel)
      ? currentModel
      : (models.includes(credentialModel) ? credentialModel : models[0]);
    if (!model) {
      throw new AgentXCloudError(
        'gateway_models_empty',
        'LiteLLM không trả về model nào cho model key này.',
      );
    }
    const installedCredential = { ...credential, models, model };
    await sendToBackground('update_provider', {
      providerId: PROVIDER_ID,
      markConfigured: false,
      config: {
        apiKey: installedCredential.key,
        baseUrl: installedCredential.baseUrl,
        model: installedCredential.model,
        providerName: 'agentx-cloud',
        models: installedCredential.models,
        agentxCloudManaged: true,
        agentxCloudAuthority: installedCredential.authority,
        agentxCloudKeyAlias: installedCredential.keyAlias,
        agentxCloudAccount: installedCredential.account,
      },
    });
    await sendToBackground('set_active_provider', { providerId: PROVIDER_ID });
    await refreshProviders();
    return installedCredential;
  }

  async function removeProviderCredential() {
    await sendToBackground('update_provider', {
      providerId: PROVIDER_ID,
      markConfigured: false,
      config: {
        apiKey: '',
        model: '',
        models: [],
        agentxCloudManaged: false,
        agentxCloudKeyAlias: '',
        agentxCloudAccount: '',
      },
    });
    await refreshProviders();
  }

  async function statusFromSession(extra = {}) {
    const sessionStatus = await service.publicStatus();
    return {
      ...sessionStatus,
      connected: status.connected,
      provider: status.provider,
      ...extra,
    };
  }

  async function connectWith(operation) {
    const result = await operation();
    const installedCredential = await installCredential(result.credential);
    paint({
      ...(await statusFromSession()),
      signedIn: true,
      connected: true,
      action: null,
      error: null,
      provider: publicProvider(installedCredential),
      outcome: result.credential.provisionOutcome || result.credential.status || 'connected',
      warningCode: result.credential.warningCode || '',
      persistenceWarning: result.persistenceWarning || '',
      testOk: false,
      testModel: '',
    });
  }

  async function initialize() {
    if (running) return running;
    running = (async () => {
      paint({ action: 'restoring', error: null });
      try {
        const restored = await service.publicStatus();
        if (!restored.signedIn) {
          paint({
            ...restored,
            connected: false,
            provider: null,
            action: null,
            error: null,
          });
          return;
        }
        paint({ ...restored, signedIn: true, action: 'provisioning' });
        await connectWith(() => service.retryProvision());
      } catch (error) {
        const latest = await service.publicStatus().catch(() => ({ signedIn: false }));
        paint({
          ...latest,
          connected: false,
          provider: null,
          action: null,
          error: publicError(error),
        });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function perform(action, payload = {}) {
    if (running) return running;
    running = (async () => {
      const actionName = {
        'sign-in': 'signing-in',
        retry: 'provisioning',
        test: 'testing',
        'select-model': 'selecting-model',
        'sign-out': 'signing-out',
      }[action];
      if (!actionName) return;
      paint({ action: actionName, error: null, testOk: false, testModel: '' });
      try {
        if (action === 'sign-in') {
          await connectWith(() => service.signInAndProvision());
          return;
        }
        if (action === 'retry') {
          await connectWith(() => service.retryProvision());
          return;
        }
        if (action === 'test') {
          const result = await sendToBackground('test_provider', { providerId: PROVIDER_ID });
          if (!result?.ok) {
            throw new AgentXCloudError(
              'gateway_test_failed',
              result?.error || 'LiteLLM gateway connection test failed.',
            );
          }
          paint({
            action: null,
            error: null,
            testOk: true,
            testModel: result.model || status.provider?.model || '',
          });
          return;
        }
        if (action === 'select-model') {
          const model = String(payload.model || '').trim();
          const availableModels = Array.isArray(status.provider?.models)
            ? status.provider.models
            : [];
          if (!model || !availableModels.includes(model)) {
            throw new AgentXCloudError(
              'invalid_model_selection',
              'Model đã chọn không nằm trong danh sách được gateway cấp.',
            );
          }
          await sendToBackground('update_provider', {
            providerId: PROVIDER_ID,
            markConfigured: false,
            config: { model },
          });
          await refreshProviders();
          paint({
            action: null,
            error: null,
            provider: { ...status.provider, model },
            testOk: false,
            testModel: '',
          });
          return;
        }
        await service.signOut();
        await removeProviderCredential();
        paint({
          ...(await service.publicStatus()),
          signedIn: false,
          connected: false,
          provider: null,
          action: null,
          error: null,
          testOk: false,
          testModel: '',
        });
      } catch (error) {
        const latest = await service.publicStatus().catch(() => ({
          signedIn: status.signedIn,
        }));
        paint({
          ...latest,
          connected: status.connected,
          provider: status.provider,
          action: null,
          error: publicError(error),
        });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    bind(root) {
      bindAgentXCloudPanel(root, (action, payload) => void perform(action, payload));
    },
    initialize,
    selectModel(model) {
      return perform('select-model', { model });
    },
    isConnected() {
      return status.connected === true;
    },
    render() {
      return renderAgentXCloudPanel(status, locale());
    },
    status() {
      return { ...status };
    },
  };
}
