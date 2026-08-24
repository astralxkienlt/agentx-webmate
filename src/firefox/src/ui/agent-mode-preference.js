export const AGENT_MODE_STORAGE_KEY = 'agentMode';

/**
 * The composer's Ask / Act / Dev choice, remembered across panel documents.
 *
 * The panel document dies whenever the sidebar closes — a browser restart, a
 * window transfer, the user closing and reopening it — and used to come back
 * in Ask no matter what the user had selected. Only an explicit choice is
 * stored: modes the panel *forces* (a selection-scoped conversation, a
 * standalone chat window) are constraints, not preferences, so they must not
 * overwrite what the user picked.
 */
export function normalizeAgentModePreference(value) {
  return value === 'act' || value === 'dev' ? value : 'ask';
}

export async function loadAgentModePreference(storageArea) {
  if (!storageArea?.get) return 'ask';
  try {
    const stored = await storageArea.get(AGENT_MODE_STORAGE_KEY);
    return normalizeAgentModePreference(stored?.[AGENT_MODE_STORAGE_KEY]);
  } catch {
    return 'ask';
  }
}

export function saveAgentModePreference(storageArea, mode) {
  if (!storageArea?.set) return Promise.resolve(false);
  try {
    return Promise.resolve(storageArea.set({
      [AGENT_MODE_STORAGE_KEY]: normalizeAgentModePreference(mode),
    })).then(() => true).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}
