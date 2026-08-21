/**
 * Runtime configuration, all environment-driven.
 *
 * Every setting is read from `WEBMATE_<NAME>` first and then from the upstream
 * `WEBBRAIN_<NAME>` spelling, so a snippet copied from WebBrain documentation
 * keeps working. When both are set, the WEBMATE_ name wins.
 *
 * The bridge port intentionally defaults to 17374, NOT 17373. The WebMate
 * Cloud sidecar owns 17373 and the LM Studio plugin owns 17375, and the
 * extension's `cloud-bridge.js` holds exactly one outbound socket — so it can
 * be pointed at one controller at a time, never several. Using a distinct
 * port keeps the failure mode obvious ("nothing connected") instead of two
 * processes fighting over one listener.
 */

const PREFIX = "WEBMATE_";
const LEGACY_PREFIX = "WEBBRAIN_";

/**
 * Resolve `WEBMATE_<x>`, falling back to `WEBBRAIN_<x>`. Returns the variable
 * name that was actually set so error messages point at the right spelling.
 */
function readEnv(name: string): { name: string; raw: string } | null {
  for (const candidate of [name, name.replace(PREFIX, LEGACY_PREFIX)]) {
    const raw = process.env[candidate];
    if (raw) return { name: candidate, raw };
  }
  return null;
}

function parseIntFromEnv(name: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

/** Ports carry a 16-bit ceiling. Durations must NOT — see durationFromEnv. */
function portFromEnv(name: string, fallback: number): number {
  const found = readEnv(name);
  if (!found) return fallback;
  const parsed = parseIntFromEnv(found.name, found.raw);
  if (parsed <= 0 || parsed > 65535) {
    throw new Error(`${found.name} must be a valid TCP port (1-65535), got: ${found.raw}`);
  }
  return parsed;
}

/**
 * Millisecond durations. Deliberately separate from portFromEnv: reusing the
 * port validator here rejected every timeout above 65535ms, including the
 * five-minute default this file itself documents.
 */
function durationFromEnv(name: string, fallback: number): number {
  const found = readEnv(name);
  if (!found) return fallback;
  const parsed = parseIntFromEnv(found.name, found.raw);
  if (parsed <= 0) {
    throw new Error(
      `${found.name} must be a positive duration in milliseconds, got: ${found.raw}`,
    );
  }
  return parsed;
}

function stringFromEnv(name: string, fallback: string): string {
  return readEnv(name)?.raw || fallback;
}

export const config = {
  /** Port this process listens on for the extension's outbound bridge socket. */
  bridgePort: portFromEnv("WEBMATE_BRIDGE_PORT", 17374),

  /** Path segment the extension connects to. Must match the URL set in WebMate settings. */
  bridgePath: stringFromEnv("WEBMATE_BRIDGE_PATH", "/extension"),

  /**
   * How long to wait for the extension to answer a single bridge command.
   * Starting a run returns immediately; this is not the task timeout.
   */
  commandTimeoutMs: durationFromEnv("WEBMATE_COMMAND_TIMEOUT_MS", 30_000),

  /** Default ceiling for how long `webmate_run` will poll before giving up. */
  defaultRunTimeoutMs: durationFromEnv("WEBMATE_RUN_TIMEOUT_MS", 300_000),

  /** Interval between `cloud_status` polls while a run is in flight. */
  pollIntervalMs: durationFromEnv("WEBMATE_POLL_INTERVAL_MS", 1_000),
} as const;

/** The URL the user must paste into Settings → General → Advanced → Cloud bridge. */
export function bridgeUrl(): string {
  return `ws://127.0.0.1:${config.bridgePort}${config.bridgePath}`;
}
