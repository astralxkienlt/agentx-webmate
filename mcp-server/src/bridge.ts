/**
 * Bridge server — the local endpoint the branded extension connects OUT to.
 *
 * Direction matters: a Manifest V3 extension cannot listen on a socket, so
 * `src/chrome/src/offscreen/cloud-bridge.js` dials out from an offscreen
 * document and we host the listener. That also means every command below is
 * initiated by us and answered by the extension.
 *
 * Wire protocol:
 *   extension -> us   {type:'hello', client, protocolVersion, capabilities, status,
 *                      // v3 adds:
 *                      version, browser, installType, token?, signedIn}
 *   us -> extension   {type:'hello_ack', serverVersion, token|null, minExtensionVersion, minProtocol}
 *   us -> extension   {id, action, payload}
 *   extension -> us   {id, ok:true,  result}
 *                     {id, ok:false, error, status?}
 *
 * The extension spreads `payload` over the message it forwards to its own
 * background worker, so payload keys become top-level fields there. Send the
 * exact field names `cloud-runs.js` reads.
 *
 * Paired mode: when Workmate has written a pairing file (see pairing.ts) the
 * hello must speak v3 and carry the pairing token, and we echo the token back
 * so the extension can tell us apart from any other local process on the
 * port. Without the file, v2 hellos are accepted exactly as before — that is
 * the developer checkout and the store build.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { BRAND } from "./brand.generated.js";
import { config } from "./config.js";
import type { WebmateErrorCode } from "./errors.js";
import { readPairing as readPairingFile, type Pairing } from "./pairing.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  MIN_EXTENSION_VERSION,
  MIN_PAIRED_PROTOCOL_VERSION,
  SERVER_VERSION,
} from "./version.js";

/**
 * The `client` value the extension puts in its hello frame. This is a wire
 * identifier inherited from upstream WebBrain — the brand build deliberately
 * preserves protocol tokens, so every branded build still sends exactly this
 * string. Do not "rebrand" it or every handshake is rejected.
 */
export const EXTENSION_CLIENT_ID = "webbrain-extension";

/** Actions present in the extension's ALLOWED_BRIDGE_ACTIONS set. */
export type BridgeAction =
  | "cloud_run"
  | "cloud_status"
  | "cloud_respond"
  | "cloud_abort"
  | "workmate_prepare_update"
  | "workmate_reload";

export interface CloudSnapshot {
  runId: string;
  status: "running" | "needs_user_input" | "aborting" | "completed" | "failed" | "aborted";
  mode?: "ask" | "act";
  /** The permission mode the run executed at. '' when it used the browser's standing one. */
  permissionMode?: string;
  tabId?: number;
  task?: string;
  structured?: boolean;
  pendingInput?: {
    clarifyId?: string;
    clarify_id?: string;
    question?: string;
    [key: string]: unknown;
  } | null;
  result?: unknown;
  summary?: string;
  content?: string;
  finalUrl?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  updates?: unknown[];
  [key: string]: unknown;
}

/** What the attached extension said about itself in `hello`. */
export interface ExtensionInfo {
  version: string | null;
  browser: string | null;
  installType: "workmate" | "dev" | null;
  signedIn: boolean | null;
  protocolVersion: number | null;
  lastHelloAt: string | null;
  capabilities: string[];
}

const NO_EXTENSION: ExtensionInfo = {
  version: null,
  browser: null,
  installType: null,
  signedIn: null,
  protocolVersion: null,
  lastHelloAt: null,
  capabilities: [],
};

/** Everything state.json needs, read after any `onChange` notification. */
export interface BridgeSnapshot extends ExtensionInfo {
  listening: boolean;
  connected: boolean;
  pairingRequired: boolean;
  error: string | null;
}

export const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class BridgeError extends Error {
  readonly status?: number;
  readonly code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED";
  /** Structured code Workmate reacts to; see errors.ts. */
  readonly webmateCode?: WebmateErrorCode;
  constructor(
    message: string,
    status?: number,
    code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED",
    webmateCode?: WebmateErrorCode,
  ) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    this.webmateCode = webmateCode;
  }
}

/**
 * The bridge port was already taken. Its own error type because it is the one
 * startup failure the caller must NOT treat as fatal: dying here takes all six
 * tools with it, leaving the agent no way to tell anyone what went wrong.
 */
export class PortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
    this.port = port;
  }
}

/**
 * Best-effort "who has the port?", for the diagnostic message only.
 *
 * Read-only, POSIX-only, and bounded: a missing or slow `lsof` degrades to an
 * unnamed holder rather than delaying startup. Naming the process matters here
 * because the holder is almost always another copy of THIS server, and the
 * fix — quit that process — is impossible to guess without a PID.
 */
async function portHolder(port: number): Promise<string | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    // -F pc emits one field per line: `p<pid>` then `c<command>`.
    const { stdout } = await run(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"],
      { timeout: 1_000 },
    );
    const pid = /^p(\d+)$/m.exec(stdout)?.[1];
    if (!pid) return null;
    const command = /^c(.+)$/m.exec(stdout)?.[1];
    return command ? `PID ${pid} (${command})` : `PID ${pid}`;
  } catch {
    return null;
  }
}

/**
 * The message the agent relays when the port is taken. Written to be acted on
 * without further investigation: it names the likely cause, explains why the
 * browser still claims to be connected, and gives both ways out.
 */
export async function describePortConflict(port: number): Promise<string> {
  const holder = await portHolder(port);
  return (
    `Port ${port} is already in use${holder ? ` by ${holder}` : ""}, so the ` +
    `${BRAND.extensionName} bridge could not start. Every tool here is unavailable ` +
    "until that is resolved.\n\n" +
    "This is almost always an older MCP server left running by a previous session " +
    "(a crashed or force-quit host does not always reap it). The extension is " +
    `attached to THAT process, which is why ${BRAND.productName} still shows ` +
    '"Connected" in the browser while these tools cannot reach it.\n\n' +
    `To fix: quit ${holder ?? "the process holding the port"}, then start a new ` +
    "session. Alternatively, point both sides at a free port by setting " +
    `${BRAND.envPrefix}BRIDGE_PORT and updating the extension's Cloud bridge URL.`
  );
}

/** Log to stderr only — stdout is the MCP stdio transport and must stay clean. */
function log(...args: unknown[]): void {
  console.error(`[${BRAND.serverName}-mcp]`, ...args);
}

function isAllowedBridgeOrigin(origin: string | string[] | undefined): boolean {
  if (origin == null) return true;
  if (Array.isArray(origin)) return false;
  try {
    const protocol = new URL(origin).protocol;
    return protocol === "chrome-extension:" || protocol === "moz-extension:";
  } catch {
    return false;
  }
}

/** Human-readable instructions for attaching the extension, reused in every "not connected" message. */
export function connectInstructions(): string {
  return (
    `Open the browser, then set ${BRAND.productName} → Settings → General → Advanced → ` +
    `Cloud bridge to ws://127.0.0.1:${config.bridgePort}${config.bridgePath} and enable it.`
  );
}

/** Same message for a Workmate-managed install, where Settings is not the fix. */
export function pairedConnectInstructions(): string {
  return (
    `Open the browser ${BRAND.productName} was installed into (Workmate → Settings → Browser ` +
    "shows which). If chrome://extensions lists it as switched off, switch it back on; " +
    "the extension reconnects on its own within a few seconds."
  );
}

/** Whether Workmate has unpacked the extension folder on this machine. */
export function extensionFolderPresent(installDir: string = config.installDir): boolean {
  return existsSync(path.join(installDir, "manifest.json"));
}

export interface BridgeOptions {
  /** Injected for tests; defaults to reading config.pairingFile. */
  readPairing?: () => Promise<Pairing | null>;
  installDir?: string;
}

export class WebMateBridge {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private extension: ExtensionInfo = { ...NO_EXTENSION };
  private handshakenSocket: WebSocket | null = null;
  private waiters: Array<() => void> = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private unavailableReason: string | null = null;
  private lastError: string | null = null;
  private pairingRequired = false;
  private listeners: Array<() => void> = [];
  private readonly readPairing: () => Promise<Pairing | null>;
  private readonly installDir: string;

  constructor(options: BridgeOptions = {}) {
    this.readPairing =
      options.readPairing ??
      (async () => (config.pairingFile ? readPairingFile(config.pairingFile) : null));
    this.installDir = options.installDir ?? config.installDir;
  }

  /** Subscribe to state changes (listen, connect, handshake, disconnect, errors). */
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        log("state listener failed:", error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** What state.json publishes. */
  snapshot(): BridgeSnapshot {
    return {
      ...this.extension,
      capabilities: [...this.extension.capabilities],
      listening: this.wss !== null,
      connected: this.isConnected(),
      pairingRequired: this.pairingRequired,
      error: this.unavailableReason ?? this.lastError,
    };
  }

  /** Facts from the current extension's hello (empty when nothing is attached). */
  info(): ExtensionInfo {
    return { ...this.extension, capabilities: [...this.extension.capabilities] };
  }

  /**
   * Record that this bridge will never attach, and why.
   *
   * Set when the listener could not be opened at all. Every command then fails
   * fast with this explanation instead of waiting out a connect grace for a
   * browser that has nothing to dial.
   */
  markUnavailable(reason: string): void {
    this.unavailableReason = reason;
    this.changed();
  }

  /** The reason the bridge is unusable, or null when it is merely unattached. */
  unavailable(): string | null {
    return this.unavailableReason;
  }

  async start(): Promise<void> {
    if (this.wss) return;

    await new Promise<void>((resolve, reject) => {
      // Bind to loopback explicitly. Never expose this listener to the network:
      // anything that can reach it can drive the user's logged-in browser.
      const wss = new WebSocketServer(
        { host: "127.0.0.1", port: config.bridgePort },
        () => {
          // Only own the server once it is actually listening. Keeping a failed
          // one would make the `if (this.wss) return` guard above swallow a
          // later retry, and leave stop() closing a server that never opened.
          this.wss = wss;
          resolve();
        },
      );
      wss.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          reject(new PortInUseError(config.bridgePort));
          return;
        }
        reject(error);
      });
    });

    this.wss!.on("connection", (socket, request) => {
      const url = request.url || "";
      const origin = request.headers.origin;
      // Browser WebSocket clients always send Origin. Only extension pages may
      // reach this trusted-local command channel; native clients send none.
      if (!isAllowedBridgeOrigin(origin)) {
        log(`rejected WebSocket origin: ${String(origin)}`);
        socket.close(1008, "Untrusted Origin");
        return;
      }
      if (!url.startsWith(config.bridgePath)) {
        log(`rejected connection on unexpected path: ${url}`);
        socket.close(1008, "Unexpected path");
        return;
      }

      // Latest connection wins. The extension reconnects with backoff after a
      // browser restart or an offscreen-document teardown, and the stale socket
      // is never reused.
      if (this.socket) {
        this.failAllPending(
          new BridgeError(
            `${BRAND.extensionName} connection was superseded mid-command.`,
            undefined,
            "COMMAND_INTERRUPTED",
          ),
        );
        try {
          this.socket.close(1000, "Superseded by a newer extension connection");
        } catch {
          /* already gone */
        }
      }

      this.socket = socket;
      this.handshakenSocket = null;
      this.extension = { ...NO_EXTENSION };
      this.missedPongs = 0;
      log(`extension connected on ${config.bridgePath}`);

      socket.on("pong", () => {
        if (this.socket !== socket) return;
        this.missedPongs = 0;
      });

      socket.on("message", (raw) => this.handleMessage(socket, raw.toString()));

      socket.on("close", () => {
        if (this.socket !== socket) return;
        const wasHandshaken = this.handshakenSocket === socket;
        this.socket = null;
        this.handshakenSocket = null;
        this.extension = { ...NO_EXTENSION };
        this.missedPongs = 0;
        log("extension disconnected");
        this.failAllPending(
          new BridgeError(
            `${BRAND.extensionName} disconnected mid-command.`,
            undefined,
            "COMMAND_INTERRUPTED",
          ),
        );
        if (wasHandshaken) this.changed();
      });

      socket.on("error", (error) => {
        log("socket error:", error instanceof Error ? error.message : String(error));
      });
    });

    this.startHeartbeat();
    // Learn the pairing mode up front so state.json and the "not connected"
    // wording are right before the first hello arrives.
    try {
      this.pairingRequired = (await this.readPairing()) !== null;
    } catch (error) {
      this.pairingRequired = true;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    log(
      `listening on ws://127.0.0.1:${config.bridgePort}${config.bridgePath}` +
        (this.pairingRequired ? " (Workmate pairing required)" : ""),
    );
    this.changed();
  }

  /**
   * Ping the attached extension and hang up on one that stops answering.
   *
   * Without this, a browser that vanishes without closing its TCP connection
   * (killed process, crashed renderer, suspended VM) leaves `isConnected()`
   * returning true and every command failing on the 30s command timeout
   * instead of the honest "no extension is connected".
   *
   * Pongs come from the browser's own WebSocket stack, so this proves the
   * socket is alive — not that the offscreen document's JavaScript is healthy.
   * The command timeout remains the check for that.
   */
  private startHeartbeat(): void {
    if (this.heartbeat || config.heartbeatIntervalMs <= 0) return;
    this.heartbeat = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== 1) return;
      if (this.missedPongs >= 2) {
        log("extension missed two heartbeats — dropping the socket");
        this.missedPongs = 0;
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
        return;
      }
      this.missedPongs += 1;
      try {
        socket.ping();
      } catch {
        /* the close handler will clean up */
      }
    }, config.heartbeatIntervalMs);
    // Never hold the process open on the heartbeat alone: an MCP host stops
    // this server by closing stdin, and an un-unref'd interval would keep the
    // event loop — and the listening port — alive in an orphan process.
    this.heartbeat.unref?.();
  }

  private handleMessage(socket: WebSocket, data: string): void {
    if (this.socket !== socket) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      log("dropped non-JSON frame from extension");
      return;
    }

    // Handshake frame — no id, nothing to correlate.
    if (msg.type === "hello") {
      void this.handleHello(socket, msg);
      return;
    }

    const id = typeof msg.id === "number" ? msg.id : null;
    if (id == null) return;

    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);

    if (msg.ok === false) {
      const status = typeof msg.status === "number" ? msg.status : undefined;
      entry.reject(new BridgeError(String(msg.error || "Unknown bridge error"), status));
      return;
    }
    entry.resolve(msg.result);
  }

  private rejectHandshake(socket: WebSocket, reason: string): void {
    log(`rejecting handshake: ${reason}`);
    this.lastError = reason;
    // 1008 = policy violation. The extension backs off for a minute on it.
    socket.close(1008, reason.slice(0, 120));
    if (this.socket === socket) {
      this.socket = null;
      this.handshakenSocket = null;
      this.extension = { ...NO_EXTENSION };
    }
    this.changed();
  }

  private async handleHello(socket: WebSocket, msg: Record<string, unknown>): Promise<void> {
    if (msg.client !== EXTENSION_CLIENT_ID) {
      this.rejectHandshake(socket, `Unknown client ${String(msg.client)}`);
      return;
    }

    let pairing: Pairing | null = null;
    try {
      pairing = await this.readPairing();
    } catch (error) {
      // A present-but-broken pairing file must fail closed: with the file on
      // disk the operator expects authentication, so an unreadable file cannot
      // quietly become "no authentication".
      this.pairingRequired = true;
      this.rejectHandshake(
        socket,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    // The socket may have been superseded while the file was read.
    if (this.socket !== socket || socket.readyState !== 1) return;
    this.pairingRequired = pairing !== null;

    const protocolVersion = typeof msg.protocolVersion === "number" ? msg.protocolVersion : null;
    if (pairing) {
      if (protocolVersion === null || protocolVersion < MIN_PAIRED_PROTOCOL_VERSION) {
        this.rejectHandshake(
          socket,
          `Bridge protocol v${MIN_PAIRED_PROTOCOL_VERSION} required for a Workmate-managed ` +
            `extension; this one speaks v${protocolVersion ?? "?"}. Update ${BRAND.productName}.`,
        );
        return;
      }
      if (typeof msg.token !== "string" || msg.token !== pairing.token) {
        this.rejectHandshake(
          socket,
          "Pairing token mismatch: this extension was not installed by the Workmate that runs this " +
            "server. Reinstall it from Workmate → Settings → Browser, or reset the token there.",
        );
        return;
      }
    }

    this.handshakenSocket = socket;
    this.lastError = null;
    this.extension = {
      version: typeof msg.version === "string" && msg.version ? msg.version : null,
      browser: typeof msg.browser === "string" && msg.browser ? msg.browser : null,
      installType:
        msg.installType === "workmate" || msg.installType === "dev" ? msg.installType : null,
      signedIn: typeof msg.signedIn === "boolean" ? msg.signedIn : null,
      protocolVersion,
      lastHelloAt: new Date().toISOString(),
      capabilities: Array.isArray(msg.capabilities) ? (msg.capabilities as string[]) : [],
    };
    log(
      `handshake ok — protocol v${protocolVersion}, ` +
        `${BRAND.productName} ${this.extension.version ?? "?"} on ${this.extension.browser ?? "unknown browser"} ` +
        `(${this.extension.installType ?? "unknown install"}${pairing ? ", paired" : ""}), capabilities: ` +
        (this.extension.capabilities.join(", ") || "none"),
    );

    try {
      socket.send(
        JSON.stringify({
          type: "hello_ack",
          serverVersion: SERVER_VERSION,
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          // Echoing the token is how the extension knows we read the same
          // pairing file Workmate wrote for it. Never echo an unverified token.
          token: pairing ? pairing.token : null,
          minExtensionVersion: MIN_EXTENSION_VERSION,
          minProtocol: pairing ? MIN_PAIRED_PROTOCOL_VERSION : 2,
        }),
      );
    } catch (error) {
      log("could not send hello_ack:", error instanceof Error ? error.message : String(error));
    }

    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
    this.changed();
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    if (this.unavailableReason !== null) return false;
    return (
      this.socket !== null &&
      this.socket.readyState === 1 &&
      this.handshakenSocket === this.socket
    );
  }

  capabilities(): string[] {
    return [...this.extension.capabilities];
  }

  /** Whether a Workmate pairing file is in force (as of the last check). */
  isPaired(): boolean {
    return this.pairingRequired;
  }

  /**
   * Re-read whether a pairing file is in force. Called on the failure path
   * only, so a Workmate that installed (or removed) the pairing since this
   * server started still gets the right wording without a restart.
   */
  private async refreshPairingMode(): Promise<void> {
    try {
      this.pairingRequired = (await this.readPairing()) !== null;
    } catch {
      this.pairingRequired = true;
    }
  }

  /** notConnectedError() after refreshing the pairing mode from disk. */
  async describeNotConnected(): Promise<BridgeError> {
    await this.refreshPairingMode();
    return this.notConnectedError();
  }

  /**
   * The error a command gets when nothing is attached — worded for the way
   * this extension was installed, and coded so Workmate can act on it.
   */
  notConnectedError(): BridgeError {
    if (this.pairingRequired && !extensionFolderPresent(this.installDir)) {
      return new BridgeError(
        `${BRAND.productName} is not installed in any browser on this machine yet. ` +
          "Ask the user to install it from Workmate → Settings → Browser.",
        undefined,
        undefined,
        "WEBMATE_NOT_INSTALLED",
      );
    }
    return new BridgeError(
      `No ${BRAND.extensionName} is connected. ` +
        (this.pairingRequired ? pairedConnectInstructions() : connectInstructions()),
      undefined,
      undefined,
      "WEBMATE_NOT_CONNECTED",
    );
  }

  /** Resolve once the extension has connected and completed its handshake. */
  waitForExtension(timeoutMs: number): Promise<boolean> {
    // No listener means nothing can ever dial in — don't burn the grace period.
    if (this.unavailableReason !== null) return Promise.resolve(false);
    if (this.isConnected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(false);
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(wake);
    });
  }

  /** Send one command and await the extension's reply. */
  async request<T = unknown>(
    action: BridgeAction,
    payload: Record<string, unknown> = {},
    timeoutMs = config.commandTimeoutMs,
  ): Promise<T> {
    // A bridge that never opened its listener fails with the reason why, not
    // with "no extension is connected" — that wording sends the user off to
    // check browser settings that are already correct.
    if (this.unavailableReason !== null) {
      throw new BridgeError(this.unavailableReason, undefined, undefined, "WEBMATE_PORT_IN_USE");
    }

    // The extension dials us, so a command issued right after this process
    // binds the port arrives while the browser is still inside its reconnect
    // backoff. Failing instantly there turns an ordinary cold start into a
    // spurious "no extension is connected" on the first tool call.
    if (!this.isConnected() && config.connectGraceMs > 0) {
      await this.waitForExtension(config.connectGraceMs);
    }
    const socket = this.socket;
    if (!socket || !this.isConnected()) {
      throw await this.describeNotConnected();
    }

    const id = this.nextId++;
    const frame = JSON.stringify({ id, action, payload });
    const responseTimeoutMs = Math.max(1, Math.min(config.commandTimeoutMs, timeoutMs));

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            `${BRAND.productName} did not answer '${action}' within ${responseTimeoutMs}ms.`,
            undefined,
            "COMMAND_TIMEOUT",
          ),
        );
      }, responseTimeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });

      try {
        socket.send(frame);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new BridgeError(
            `Failed to send '${action}': ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.missedPongs = 0;
    this.failAllPending(new BridgeError("Bridge shutting down."));
    if (this.socket) {
      try {
        this.socket.close(1001, "Server shutting down");
      } catch {
        /* ignore */
      }
      this.socket = null;
      this.handshakenSocket = null;
      this.extension = { ...NO_EXTENSION };
    }
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    this.changed();
  }
}
