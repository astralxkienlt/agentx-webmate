/**
 * The version on the wire is the version in package.json — the bundled
 * skill's brand.json, the release notes and hello_ack all quote it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { packageDir } from "../scripts/brand.mjs";

const { SERVER_VERSION, BRIDGE_PROTOCOL_VERSION, MIN_PAIRED_PROTOCOL_VERSION } = await import("../dist/version.js");
const { WEBMATE_ERROR_CODES, isWebmateErrorCode } = await import("../dist/errors.js");

test("SERVER_VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(`${packageDir}/package.json`, "utf8"));
  assert.equal(SERVER_VERSION, pkg.version);
});

test("the paired floor never exceeds what this server speaks", () => {
  assert.ok(MIN_PAIRED_PROTOCOL_VERSION <= BRIDGE_PROTOCOL_VERSION);
  assert.equal(BRIDGE_PROTOCOL_VERSION, 3);
});

test("the structured error codes are the six Workmate reacts to", () => {
  assert.deepEqual(
    [...WEBMATE_ERROR_CODES],
    ["WEBMATE_DISABLED", "WEBMATE_NOT_INSTALLED", "WEBMATE_NOT_CONNECTED", "WEBMATE_OUTDATED", "WEBMATE_NOT_SIGNED_IN", "WEBMATE_PORT_IN_USE"],
  );
  assert.equal(isWebmateErrorCode("WEBMATE_NOT_CONNECTED"), true);
  assert.equal(isWebmateErrorCode("COMMAND_TIMEOUT"), false);
});
