#!/usr/bin/env node
/**
 * Real-Chrome cloud-bridge stability test.
 *
 * Loads the unpacked extension into a fresh Chrome profile, stands up the REAL
 * MCP server's listener on the shipped default port, and never opens Settings —
 * so everything it observes is what a user gets out of the box.
 *
 * The two unit suites each mock one half of this pair: mcp-server tests drive
 * the real listener with a fake extension, test/run.js drives the real
 * extension client with a fake socket. This is the only test where both halves
 * are real, which is why it is the one that can catch a default that never
 * reaches the wire.
 *
 * Covered:
 *   1. a fresh profile dials in on its own (default enabled, default URL)
 *   2. commands round-trip through the service worker
 *   3. the extension reattaches after the controller restarts
 *   4. a superseded socket does not leave a second bridge behind
 *   5. the watchdog alarm is armed, and recovers a destroyed offscreen host
 *
 * Run: node test/cloud-bridge-e2e.mjs            (add --quick to skip step 5)
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Defaults to the unbranded source tree. Point BRIDGE_E2E_EXTENSION at
// brand-dist/chrome to check that the branded build still speaks the same wire
// protocol — the brand pass deliberately preserves the handshake tokens.
const EXTENSION_PATH = process.env.BRIDGE_E2E_EXTENSION
  ? path.resolve(process.env.BRIDGE_E2E_EXTENSION)
  : path.resolve(__dirname, '..', 'src', 'chrome');
const MCP_BRIDGE_DIST = path.resolve(__dirname, '..', 'mcp-server', 'dist', 'bridge.js');
const BRIDGE_PORT = Number(process.env.BRIDGE_E2E_PORT || 17374);
const BRIDGE_PATH = '/extension';

// config.ts reads these once at import time, so they must be set before the
// dynamic import below.
process.env.WEBMATE_BRIDGE_PORT = String(BRIDGE_PORT);
process.env.WEBMATE_BRIDGE_PATH = BRIDGE_PATH;
// Reconnect timing is what this test measures, so the command path must not
// paper over a browser that never came back.
process.env.WEBMATE_CONNECT_GRACE_MS = '2000';
const QUICK = process.argv.includes('--quick');
// The watchdog alarm fires on a one-minute period and Chrome adds its own
// slack, so recovery needs a generous window.
const WATCHDOG_TIMEOUT_MS = 150_000;

const log = message => console.log(`  ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* try the next one */ }
  }
  return '';
}

async function chromeLaunchTarget() {
  if (process.env.BRIDGE_E2E_CHROME_PATH) {
    return { executablePath: process.env.BRIDGE_E2E_CHROME_PATH };
  }
  const candidates = process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  const executablePath = await firstExistingPath(candidates);
  return executablePath ? { executablePath } : { channel: 'chrome' };
}

async function loadMcpBridge() {
  try {
    await access(MCP_BRIDGE_DIST);
  } catch {
    throw new Error(
      `mcp-server is not built. Run \`npm --prefix mcp-server run build\` first — this test `
      + 'drives the real listener, not a stand-in.',
    );
  }
  const { WebMateBridge } = await import(pathToFileURL(MCP_BRIDGE_DIST).href);
  return new WebMateBridge();
}

/** Poll a predicate on the live bridge rather than trusting a single sample. */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return Date.now();
    await sleep(100);
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

async function extensionWorker(context, extensionId) {
  const existing = context.serviceWorkers().find(candidate => candidate.url().includes(extensionId));
  if (existing) return existing;
  return context.waitForEvent('serviceworker', {
    predicate: candidate => candidate.url().includes(extensionId),
    timeout: 20_000,
  });
}

async function main() {
  const bridge = await loadMcpBridge();
  try {
    await bridge.start();
  } catch (error) {
    throw new Error(
      `Could not bind 127.0.0.1:${BRIDGE_PORT}. Stop whatever owns it (a running MCP server?) `
      + `or set BRIDGE_E2E_PORT — though only 17374 exercises the shipped default. ${error.message}`,
    );
  }
  log(`MCP listener up on ws://127.0.0.1:${BRIDGE_PORT}${BRIDGE_PATH}`);

  const launchTarget = await chromeLaunchTarget();
  let context = null;
  try {
    context = await chromium.launchPersistentContext('', {
      ...launchTarget,
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
    });

    const browser = context.browser();
    assert.ok(browser, 'Playwright did not expose a browser handle for the persistent context.');
    // Extensions.loadUnpacked lives on the browser-level session, not a page's.
    const browserCdp = await browser.newBrowserCDPSession();
    const loaded = await browserCdp.send('Extensions.loadUnpacked', { path: EXTENSION_PATH });
    const extensionId = String(loaded.id || '');
    assert.match(extensionId, /^[a-p]{32}$/, 'Chrome did not return a valid unpacked extension ID.');
    log(`extension loaded as ${extensionId}`);

    // ---- 1. a fresh profile attaches without anyone opening Settings --------
    assert.ok(
      await bridge.waitForExtension(30_000),
      'A fresh profile never dialled the bridge. The shipped default is not reaching the wire.',
    );
    // The listener rejects any Origin that is not an extension page and any
    // client id other than the wire token, so reaching "connected" already
    // proves both. Capabilities prove the hello frame itself parsed.
    assert.ok(
      bridge.capabilities().includes('run_modes_v1'),
      `handshake did not advertise run modes: ${JSON.stringify(bridge.capabilities())}`,
    );
    log('1/5 fresh profile attached on the default port with no settings interaction');

    const worker = await extensionWorker(context, extensionId);
    const stored = await worker.evaluate(async () => chrome.storage.local.get([
      'webbrainCloudBridgeEnabled',
      'webbrainCloudBridgeUrl',
    ]));
    assert.deepEqual(
      stored,
      {},
      'the default must hold with no stored keys — writing them on boot would freeze today\'s default into every profile',
    );

    // ---- 2. commands round-trip through the service worker -----------------
    await assert.rejects(
      () => bridge.request('cloud_status', { runId: 'run_does_not_exist' }),
      /unknown cloud run/i,
      'an unknown run should surface as a failed command, not a hang',
    );
    await assert.rejects(
      () => bridge.request('get_providers', {}),
      /unsupported cloud bridge action/i,
      'the bridge must keep refusing actions outside the run surface',
    );
    log('2/5 commands round-trip through the worker; the action allowlist still holds');

    // ---- 3. the extension reattaches after the controller restarts ----------
    await bridge.stop();
    await waitFor(() => !bridge.isConnected(), 5_000, 'the socket to drop after the listener stopped');
    log('    listener stopped — restarting it the way an MCP host respawn would');
    await sleep(1_500);
    await bridge.start();
    const reattachStart = Date.now();
    await waitFor(() => bridge.isConnected(), 30_000, 'the extension to reattach');
    const reattachMs = Date.now() - reattachStart;
    assert.ok(
      reattachMs < 20_000,
      `reconnect took ${reattachMs}ms — the backoff ceiling should keep this well under 20s`,
    );
    await assert.rejects(
      () => bridge.request('cloud_status', { runId: 'run_does_not_exist' }),
      /unknown cloud run/i,
      'commands broke after the reconnect',
    );
    log(`3/5 reattached ${reattachMs}ms after the listener came back, and commands still work`);

    // ---- 4. exactly one settled bridge socket, not a pile of them -----------
    // Poll rather than sample once: a status query can land while the offscreen
    // host is mid-dial (Chrome may have just rebuilt it), and "still CONNECTING"
    // is a healthy state, not a failure. A bridge that is genuinely down never
    // converges and this still fails.
    let status = null;
    const statusDeadline = Date.now() + 15_000;
    while (Date.now() < statusDeadline) {
      status = await worker.evaluate(async () => chrome.runtime.sendMessage({ type: 'cloud-bridge-status' }));
      if (status?.connected) break;
      await sleep(250);
    }
    assert.equal(status?.connected, true, `the offscreen bridge never reported a live socket: ${JSON.stringify(status)}`);
    assert.equal(status.enabled, true);
    assert.equal(status.reconnectAttempt, 0, 'a settled bridge should have reset its backoff');
    assert.equal(status.url, `ws://127.0.0.1:${BRIDGE_PORT}${BRIDGE_PATH}`, 'the bridge is not on the shipped default URL');
    log('4/5 the offscreen host reports one settled connection on the default URL');

    // ---- 5. the watchdog recovers a destroyed offscreen host ----------------
    const alarms = await worker.evaluate(async () => chrome.alarms.getAll());
    const watchdog = alarms.find(alarm => alarm.name === 'wb-cloud-bridge-watchdog');
    assert.ok(watchdog, `watchdog alarm was never armed; found ${JSON.stringify(alarms.map(a => a.name))}`);
    assert.equal(watchdog.periodInMinutes, 1, 'watchdog period drifted');

    if (QUICK) {
      log('5/5 skipped (--quick): the watchdog alarm is armed but its recovery was not exercised');
    } else {
      await worker.evaluate(async () => { await chrome.offscreen.closeDocument(); });
      assert.equal(
        await worker.evaluate(async () => chrome.offscreen.hasDocument()),
        false,
        'the offscreen host should be gone',
      );
      await waitFor(() => !bridge.isConnected(), 10_000, 'the bridge to drop with its offscreen host');
      log('    offscreen host destroyed — the one failure the socket cannot heal on its own');
      // Nothing below touches the browser: waitFor only polls the listener from
      // Node. So whatever brings the bridge back does so on its own, which
      // leaves the watchdog alarm as the only mechanism that could have.
      const recoverStart = Date.now();
      await waitFor(() => bridge.isConnected(), WATCHDOG_TIMEOUT_MS, 'the watchdog to rebuild the bridge');
      const recoverMs = Date.now() - recoverStart;
      await assert.rejects(
        () => bridge.request('cloud_status', { runId: 'run_does_not_exist' }),
        /unknown cloud run/i,
        'the recovered bridge cannot run commands',
      );
      log(`5/5 watchdog rebuilt the bridge ${Math.round(recoverMs / 1000)}s after the offscreen host died`);
    }

    console.log('\n  cloud bridge e2e: all checks passed');
  } finally {
    if (context) await context.close().catch(() => {});
    await bridge.stop().catch(() => {});
  }
}

main().catch(error => {
  console.error('\n  cloud bridge e2e FAILED:', error?.message || error);
  process.exitCode = 1;
});
