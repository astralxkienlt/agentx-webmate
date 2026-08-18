const VISION_MODEL_RE = /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|claude|gemini|kimi-k(?:-?3|2\.[5-9])|llava|qwen.*vl|qwen2.*vl|qwen3.*vl|qwen3\.[5-9]|pixtral|llama.*vision|gemma.*vision|gemma-?[34]|[-_/]vl(?:[-_/]|$)|vision/;

export const AGENTX_CLOUD_PROVIDER_ID = 'webbrain_cloud';

export function normalizeGatewayModels(models) {
  return [...new Set(
    (Array.isArray(models) ? models : [])
      .map((model) => String(model || '').trim())
      .filter(Boolean),
  )];
}

export function isLikelyVisionModel(id) {
  return VISION_MODEL_RE.test(String(id || '').toLowerCase());
}

export function gatewayCatalogFromPayload(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const models = [];
  const visionFromInfo = [];
  for (const entry of entries) {
    const id = String(entry?.id || entry?.model_name || '').trim();
    if (!id) continue;
    models.push(id);
    const flag = entry?.model_info?.supports_vision
      ?? entry?.supports_vision
      ?? entry?.capabilities?.vision;
    if (flag === true) visionFromInfo.push(id);
  }
  return {
    models: normalizeGatewayModels(models),
    visionFromInfo: normalizeGatewayModels(visionFromInfo),
  };
}

export function visionModelsFromGateway(models, visionFromInfo = []) {
  const list = normalizeGatewayModels(models);
  const advertised = normalizeGatewayModels(visionFromInfo).filter((id) => list.includes(id));
  if (advertised.length) return advertised;
  const guessed = list.filter(isLikelyVisionModel);
  return guessed.length ? guessed : list;
}

export function pickGatewayModel(preferred, models, fallback = '') {
  const list = normalizeGatewayModels(models);
  const wanted = String(preferred || '').trim();
  if (wanted && list.includes(wanted)) return wanted;
  const backup = String(fallback || '').trim();
  if (backup && list.includes(backup)) return backup;
  return list[0] || '';
}

export function pickGatewayVisionModel(preferred, visionModels) {
  const list = normalizeGatewayModels(visionModels);
  const wanted = String(preferred || '').trim();
  if (!wanted) return '';
  return list.includes(wanted) ? wanted : '';
}

export function resolveCloudVisionSidecar(cloudConfig = {}) {
  if (cloudConfig?.agentxCloudManaged !== true) return null;
  const apiKey = String(cloudConfig.apiKey || '').trim();
  const baseUrl = String(cloudConfig.baseUrl || '').trim();
  if (!apiKey || !baseUrl) return null;
  const models = normalizeGatewayModels(cloudConfig.models);
  const visionModels = normalizeGatewayModels(cloudConfig.agentxCloudVisionModels)
    .filter((model) => models.includes(model));
  const allowlist = visionModels.length ? visionModels : models;
  const model = pickGatewayVisionModel(cloudConfig.agentxCloudVisionModel, allowlist);
  if (!model) return null;
  return {
    type: 'openai',
    category: 'cloud',
    label: 'netMind Cloud Vision',
    providerName: 'agentx-cloud',
    baseUrl,
    model,
    apiKey,
    enabled: true,
    supportsVision: true,
    agentxCloudManaged: true,
    models: allowlist,
  };
}
