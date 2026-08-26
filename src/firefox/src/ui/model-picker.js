/**
 * Composer model picker — pure helpers.
 *
 * The side panel shows a model chip in the composer footer whenever the
 * active provider carries a selectable model catalog (`config.models`,
 * e.g. the managed cloud gateway). These helpers stay DOM-free so the
 * chip's decisions are unit-testable and byte-identical across browsers.
 */

/**
 * Normalize a raw model list: strings only, trimmed, non-empty, deduped,
 * original order preserved.
 * @param {*} models - Candidate list (anything non-array yields []).
 * @returns {string[]} Clean model ids.
 */
export function normalizeModelList(models) {
  return [...new Set(
    (Array.isArray(models) ? models : [])
      .map((model) => String(model ?? '').trim())
      .filter(Boolean),
  )];
}

/**
 * The models a provider config offers for in-composer switching.
 * Only providers that persist a catalog (`config.models`) participate;
 * everything else keeps its model field in Settings.
 * @param {object} config - Provider config from get_providers.
 * @returns {string[]} Selectable model ids.
 */
export function selectableChatModels(config) {
  if (!config || typeof config !== 'object') return [];
  return normalizeModelList(config.models);
}

/**
 * Short display name for a model id: the segment after the last '/',
 * so vendor-prefixed ids ("MiniMax/MiniMax-M3", "models/gemini-2.5-pro")
 * stay readable on a small chip. Falls back to the full id when the
 * split leaves nothing.
 * @param {*} model - Model id.
 * @returns {string} Display name.
 */
export function modelShortName(model) {
  const full = String(model ?? '').trim();
  const short = full.slice(full.lastIndexOf('/') + 1).trim();
  return short || full;
}

/**
 * Vendor prefix of a model id (everything through the last '/'), or ''
 * when the id has none. The menu dims this part so the distinguishing
 * segment carries the row.
 * @param {*} model - Model id.
 * @returns {string} Vendor prefix including the trailing '/'.
 */
export function modelVendorPrefix(model) {
  const full = String(model ?? '').trim();
  const cut = full.lastIndexOf('/');
  if (cut <= 0) return '';
  const prefix = full.slice(0, cut + 1);
  // A pathological id like "/model" has no meaningful vendor part.
  return prefix === '/' ? '' : prefix;
}

/**
 * Derive the composer model picker state from a get_providers response.
 * `visible` is true only when the ACTIVE provider is enabled and exposes a
 * catalog; the chip never surfaces stale catalogs from inactive providers.
 * @param {object} response - { providers, active } from the background.
 * @returns {{visible: boolean, providerId: string, providerLabel: string,
 *            model: string, models: string[], supportsVision: boolean}}
 */
export function modelPickerState(response) {
  const providers = (response && typeof response === 'object' && response.providers) || {};
  const providerId = String(response?.active ?? '');
  const config = providers[providerId];
  const models = selectableChatModels(config);
  const configuredModel = String(config?.model ?? '').trim();
  if (!config || config.enabled === false || !models.length) {
    return {
      visible: false,
      providerId,
      providerLabel: '',
      model: configuredModel,
      models: [],
      supportsVision: false,
    };
  }
  return {
    visible: true,
    providerId,
    providerLabel: String(config.label || providerId),
    // The gateway policy (openai.js) rejects a model outside the catalog, so
    // an out-of-catalog leftover renders as-is but is never offered back.
    model: configuredModel || models[0],
    models,
    supportsVision: config.supportsVision === true,
  };
}

/**
 * Which footnote the model menu shows about image handling.
 * - 'dedicated': a dedicated vision model is configured; images go there.
 * - 'inherit':   no dedicated vision model, the chat model reads images
 *                itself (the default when every gateway model is multimodal).
 * - 'none':      nothing trustworthy to say (hidden chip, vision-less
 *                provider, or the background status probe failed).
 * @param {object} state - modelPickerState() result.
 * @param {object} visionStatus - get_vision_provider_status response.
 * @returns {{kind: 'dedicated'|'inherit'|'none', model: string}}
 */
export function modelVisionNote(state, visionStatus) {
  if (!state?.visible || !visionStatus || visionStatus.ok !== true) {
    return { kind: 'none', model: '' };
  }
  const dedicatedModel = String(visionStatus.model ?? '').trim();
  if (visionStatus.dedicated === true && dedicatedModel) {
    return { kind: 'dedicated', model: dedicatedModel };
  }
  if (state.supportsVision) {
    return { kind: 'inherit', model: state.model };
  }
  return { kind: 'none', model: '' };
}
