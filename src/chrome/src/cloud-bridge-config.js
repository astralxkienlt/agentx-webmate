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
