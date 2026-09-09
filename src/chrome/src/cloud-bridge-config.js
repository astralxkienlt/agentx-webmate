/**
 * Cloud-bridge defaults shared by the background controller (cloud-runs.js) and
 * the Settings page (ui/settings.js).
 *
 * Two decisions live here because both sides must agree on them exactly:
 *
 *  1. The bridge is ON unless the user turned it off. The storage key is
 *     therefore read as opt-OUT (`=== false` disables) — an absent key means a
 *     profile that has never touched the toggle, and that profile should still
 *     answer an MCP client. Reading it as `=== true` would leave every fresh
 *     install silently unreachable.
 *  2. The default target is the MCP server on 17374. The Cloud sidecar (17373)
 *     and the LM Studio plugin (17375) stay reachable by retyping the port;
 *     only one bridge socket exists, so the default picks the one an agent
 *     driving this browser actually dials.
 */

export const CLOUD_BRIDGE_ENABLED_KEY = 'webbrainCloudBridgeEnabled';
export const CLOUD_BRIDGE_URL_KEY = 'webbrainCloudBridgeUrl';
export const DEFAULT_CLOUD_BRIDGE_URL = 'ws://127.0.0.1:17374/extension';

/** Opt-out: only an explicit `false` disables the bridge. */
export function isCloudBridgeEnabled(stored = {}) {
  return stored[CLOUD_BRIDGE_ENABLED_KEY] !== false;
}

/** The configured target, falling back to the MCP port for untouched profiles. */
export function cloudBridgeUrlFrom(stored = {}) {
  return stored[CLOUD_BRIDGE_URL_KEY] || DEFAULT_CLOUD_BRIDGE_URL;
}

/**
 * AgentX Workmate install contract (docs/workmate-integration.md).
 *
 * Workmate unpacks the extension into a folder it owns and drops
 * `workmate.json` next to the manifest: the bridge URL to dial and the pairing
 * token the MCP server will check. The background reads it (an offscreen
 * document has no chrome.* API beyond runtime messaging) and hands the parsed
 * result to the offscreen bridge before every dial, so a Workmate that moved
 * its port or rotated the token is picked up on the next reconnect.
 */
export const WORKMATE_CONFIG_PATH = 'workmate.json';

/**
 * Mirrors AGENTX_SESSION_STORAGE_KEY in src/agentx/cloud-service.js (a brand
 * addition this upstream file cannot import). Only the presence check lives
 * here; validity and idle expiry stay the service's business.
 */
export const WORKMATE_SESSION_STORAGE_KEY = 'agentxAuthSessionV1';

/**
 * Parse workmate.json text. Returns `{ config: null, error }` for anything
 * unusable — the bridge then dials the Settings URL and shows the error, so a
 * broken file from Workmate never silences the bridge. `wsUrl` is passed
 * through untouched; the offscreen bridge applies the loopback check at the
 * dial site, the one place that decides where a socket goes.
 */
export function parseWorkmateConfig(text) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? ''));
  } catch (error) {
    return { config: null, error: `workmate.json is not valid JSON: ${error?.message || error}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== 1) {
    return { config: null, error: 'workmate.json has an unsupported schema.' };
  }
  const str = (value) => (typeof value === 'string' ? value.trim() : '');
  return {
    config: {
      wsUrl: str(raw.wsUrl) || null,
      token: str(raw.token),
      installId: str(raw.installId),
      workmateVersion: str(raw.workmateVersion),
      minServerVersion: str(raw.minServerVersion),
    },
    error: '',
  };
}
