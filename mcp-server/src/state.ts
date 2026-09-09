/**
 * `state.json` — what this server knows about the bridge, for Workmate to
 * read.
 *
 * Workmate's desktop app watches this file (fs.watch) to render the
 * "connected · Google Chrome" line during onboarding and in Settings, and to
 * decide whether an update can be applied live. It is written whole on every
 * change, through a temp file and rename, so a reader never sees a torn JSON
 * document. This process is the only writer; the losing side of a port
 * conflict writes nothing, because the winner's file is the truthful one.
 *
 * Readers should treat `listening: true` with a dead `pid` as stale — a
 * force-quit server has no chance to write its goodbye.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LastCommand {
  id: string;
  action: string;
  ok: boolean;
  busy?: number;
  error?: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface BridgeStateFields {
  pid: number;
  port: number;
  serverVersion: string;
  listening: boolean;
  connected: boolean;
  pairingRequired: boolean;
  browser: string | null;
  extensionVersion: string | null;
  installType: "workmate" | "dev" | null;
  signedIn: boolean | null;
  protocolVersion: number | null;
  lastHelloAt: string | null;
  error: string | null;
  lastCommand: LastCommand | null;
}

export interface BridgeState extends BridgeStateFields {
  schema: 1;
  updatedAt: string;
}

export const EMPTY_STATE: Omit<BridgeStateFields, "pid" | "port" | "serverVersion"> = {
  listening: false,
  connected: false,
  pairingRequired: false,
  browser: null,
  extensionVersion: null,
  installType: null,
  signedIn: null,
  protocolVersion: null,
  lastHelloAt: null,
  error: null,
  lastCommand: null,
};

let seq = 0;

/** Write `data` to `file` atomically (temp sibling + rename), creating the directory. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

export class StateFile {
  private state: BridgeState;
  private queue: Promise<void> = Promise.resolve();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string | null,
    seed: Pick<BridgeStateFields, "pid" | "port" | "serverVersion">,
    private readonly log: (...args: unknown[]) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = { schema: 1, ...EMPTY_STATE, ...seed, updatedAt: this.now().toISOString() };
  }

  /** Current in-memory state (what the next write will contain). */
  current(): BridgeState {
    return { ...this.state };
  }

  /** Merge a change in and schedule a write on the next tick (coalesces bursts). */
  update(patch: Partial<BridgeStateFields>): void {
    this.state = { ...this.state, ...patch, updatedAt: this.now().toISOString() };
    if (!this.file) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 0);
    this.timer.unref?.();
  }

  /** Write the current state now. Serialised; safe to call from shutdown. */
  flush(): Promise<void> {
    if (!this.file || !this.dirty) return this.queue;
    this.dirty = false;
    const snapshot = this.state;
    const file = this.file;
    this.queue = this.queue
      .then(() => writeJsonAtomic(file, snapshot))
      .catch((error) => {
        this.log(`could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
      });
    return this.queue;
  }
}
