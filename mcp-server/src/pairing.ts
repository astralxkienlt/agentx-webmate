/**
 * Workmate pairing file.
 *
 * AgentX Workmate writes `<webmate dir>/pairing.json` (mode 0600) when it
 * installs the extension, and the same token into the extension folder's
 * `workmate.json`. The presence of the file switches this server into paired
 * mode: every `hello` must carry that token and speak protocol v3, and the
 * server echoes the token in `hello_ack` so the extension can tell a real
 * Workmate server from any other local process squatting on the port.
 *
 * The file is re-read on every handshake. It is tiny, and Workmate's
 * "reset token" rewrites it and then asks the extension to reload — a cached
 * copy here would reject the very reconnect that follows.
 */

import { readFile } from "node:fs/promises";

export interface Pairing {
  token: string;
  port: number | null;
  installId: string;
  createdAt: string | null;
}

export class PairingFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingFileError";
  }
}

/** Parse pairing.json text. Throws PairingFileError on anything unusable. */
export function parsePairing(text: string): Pairing {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PairingFileError(
      `pairing.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PairingFileError("pairing.json must contain a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  if (record.schema !== 1) {
    throw new PairingFileError(`pairing.json schema ${String(record.schema)} is not supported.`);
  }
  const token = typeof record.token === "string" ? record.token.trim() : "";
  // 32 random bytes base64 is 44 characters; anything much shorter is not a
  // token Workmate generated and would make the check trivially guessable.
  if (token.length < 32) {
    throw new PairingFileError("pairing.json token is missing or too short.");
  }
  const port = typeof record.port === "number" && Number.isInteger(record.port) ? record.port : null;
  return {
    token,
    port,
    installId: typeof record.installId === "string" ? record.installId : "",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
  };
}

/**
 * Read the pairing file. `null` means "no Workmate pairing" (dev mode). A
 * present but unreadable file throws: refusing every handshake until Workmate
 * rewrites it is safer than silently falling back to unauthenticated mode.
 */
export async function readPairing(file: string): Promise<Pairing | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PairingFileError(
      `pairing.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parsePairing(text);
}
