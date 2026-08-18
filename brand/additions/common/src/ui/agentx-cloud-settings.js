import { AGENTX_RUNTIME_CONFIG } from '../agentx/runtime-config.js';
import { createAgentXCloudService, AgentXCloudError } from '../agentx/cloud-service.js';
import {
  pickGatewayModel,
  pickGatewayVisionModel,
  visionModelsFromGateway,
} from '../agentx/cloud-models.js';
import {
  bindAgentXCloudPanel,
  bindAgentXCloudVisionPanel,
  renderAgentXCloudPanel,
  renderAgentXCloudVisionPanel,
} from './agentx-cloud-ui.js';

const PROVIDER_ID = 'webbrain_cloud';

function publicProvider(credential) {
  if (!credential) return null;
  const models = Array.isArray(credential.models) ? [...credential.models] : [];
  const visionModels = Array.isArray(credential.visionModels)
    ? [...credential.visionModels]
    : visionModelsFromGateway(models);
  return {
    account: credential.account || '',
    baseUrl: credential.baseUrl || '',
    model: credential.model || '',
    models,
    visionModel: credential.visionModel || '',
    visionModels,
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
    const visionModels = visionModelsFromGateway(
      models,
      credential.visionFromInfo,
    );
    const current = await sendToBackground('get_providers').catch(() => null);
    const currentConfig = current?.providers?.[PROVIDER_ID] || {};
    const model = pickGatewayModel(
      currentConfig.model,
      models,
      credential.model,
    );
    if (!model) {
      throw new AgentXCloudError(
        'gateway_models_empty',
        'LiteLLM không trả về mô hình nào cho khóa này.',
      );
    }
    const visionModel = pickGatewayVisionModel(
      currentConfig.agentxCloudVisionModel || credential.visionModel,
      visionModels,
    );
    const installedCredential = {
      ...credential,
      models,
      model,
      visionModels,
      visionModel,
    };
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
        agentxCloudVisionModel: installedCredential.visionModel,
        agentxCloudVisionModels: installedCredential.visionModels,
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
        agentxCloudVisionModel: '',
        agentxCloudVisionModels: [],
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
        'select-vision-model': 'selecting-vision-model',
        'test-vision': 'testing-vision',
        'clear-vision': 'clearing-vision',
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
              'Mô hình bạn chọn không có trong danh sách mà cổng cấp.',
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
            visionTestOk: false,
            visionTestModel: '',
          });
          return;
        }
        if (action === 'select-vision-model') {
          const model = String(payload.model || '').trim();
          const availableModels = Array.isArray(status.provider?.visionModels)
            ? status.provider.visionModels
            : [];
          if (model && !availableModels.includes(model)) {
            throw new AgentXCloudError(
              'invalid_vision_model_selection',
              'Mô hình đọc ảnh bạn chọn không có trong danh sách mà cổng này cấp.',
            );
          }
          await sendToBackground('update_provider', {
            providerId: PROVIDER_ID,
            markConfigured: false,
            config: { agentxCloudVisionModel: model },
          });
          await refreshProviders();
          paint({
            action: null,
            error: null,
            provider: { ...status.provider, visionModel: model },
            visionTestOk: false,
            visionTestModel: '',
          });
          return;
        }
        if (action === 'test-vision') {
          if (!String(status.provider?.visionModel || '').trim()) {
            throw new AgentXCloudError(
              'vision_model_required',
              'Hãy chọn mô hình đọc ảnh trên Cloud trước khi kiểm tra kết nối.',
            );
          }
          const result = await sendToBackground('test_vision_provider');
          if (!result?.ok) {
            throw new AgentXCloudError(
              'gateway_vision_test_failed',
              result?.error || 'Không kiểm tra được kết nối đọc ảnh qua LiteLLM.',
            );
          }
          paint({
            action: null,
            error: null,
            visionTestOk: true,
            visionTestModel: result.model || status.provider?.visionModel || '',
          });
          return;
        }
        if (action === 'clear-vision') {
          await sendToBackground('update_provider', {
            providerId: PROVIDER_ID,
            markConfigured: false,
            config: { agentxCloudVisionModel: '' },
          });
          await refreshProviders();
          paint({
            action: null,
            error: null,
            provider: { ...status.provider, visionModel: '' },
            visionTestOk: false,
            visionTestModel: '',
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
          visionTestOk: false,
          visionTestModel: '',
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
    bindVision(root) {
      bindAgentXCloudVisionPanel(root, (action, payload) => void perform(action, payload));
    },
    initialize,
    selectModel(model) {
      return perform('select-model', { model });
    },
    selectVisionModel(model) {
      return perform('select-vision-model', { model });
    },
    isConnected() {
      return status.connected === true;
    },
    render() {
      return renderAgentXCloudPanel(status, locale());
    },
    renderVision() {
      return renderAgentXCloudVisionPanel(status, locale());
    },
    status() {
      return { ...status };
    },
  };
}
