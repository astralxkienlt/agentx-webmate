#!/usr/bin/env node
/**
 * Real-Chrome acceptance test for the AgentX Workmate install contract.
 *
 * Loads the branded build (brand-dist/chrome, copied into a throwaway
 * "AgentX WebMate" folder so workmate.json can be added and changed without
 * touching the checkout Chrome may be holding) into a fresh Chrome profile via
 * CDP `Extensions.loadUnpacked`, and drives the REAL MCP server listener.
 *
 * Covered:
 *   1. the fixed extension ID: Chrome derives brand.config.json's product.extensionId from the key
 *   2. dev mode (no workmate.json, no pairing.json): v3 hello, installType "dev", browser named
 *   3. paired (workmate.json + pairing.json, same token): connected, hello_ack token echoed,
 *      state.json shows the browser and version
 *   4. a mismatching pairing token is refused with 1008 and the extension holds off
 *   5. `node mcp-server/dist/index.js` over stdio: initialize → tools/list → webmate_connection
 *      names the version and browser of the paired extension
 *   6. workmate_prepare_update drains new runs, resume lifts it, workmate_reload is acknowledged
 *      and tears the extension down (last, because in a CDP-loaded profile the extension does
 *      not come back on its own — see the note in step 6)
 *
 * Run: npm run brand:build && npm --prefix mcp-server run build && node test/workmate-install-e2e.mjs
 * Needs Google Chrome on this machine. Listens on 17398 (BRIDGE_E2E_PORT), NOT
 * the shipped default: a developer's own Chrome may hold brand-dist/chrome
 * loaded and would dial any listener on 17374 with whatever code it last
 * loaded, contaminating the run. The throwaway profile is pointed at the test
 * port through the same Settings key a user would change.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BRAND_DIST = path.join(ROOT, 'brand-dist', 'chrome');
const MCP_DIST = path.join(ROOT, 'mcp-server', 'dist');
const BRIDGE_PORT = Number(process.env.BRIDGE_E2E_PORT || 17398);
const BRIDGE_PATH = '/extension';

const WEBMATE_DIR = mkdtempSync(path.join(tmpdir(), 'webmate-e2e-'));
const INSTALL_DIR = path.join(WEBMATE_DIR, 'AgentX WebMate');
const STATE_FILE = path.join(WEBMATE_DIR, 'state.json');
const PAIRING_FILE = path.join(WEBMATE_DIR, 'pairing.json');

// config.ts reads these once at import time.
process.env.WEBMATE_DIR = WEBMATE_DIR;
process.env.WEBMATE_BRIDGE_PORT = String(BRIDGE_PORT);
process.env.WEBMATE_BRIDGE_PATH = BRIDGE_PATH;
process.env.WEBMATE_CONNECT_GRACE_MS = '2000';

const log = message => console.log(`  ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const token = () => randomBytes(32).toString('base64');

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

async function chromeExecutable() {
  if (process.env.BRIDGE_E2E_CHROME_PATH) return process.env.BRIDGE_E2E_CHROME_PATH;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate); return candidate; } catch { /* next */ }
  }
  return null;
}

function writeWorkmateJson(fields) {
  writeFileSync(path.join(INSTALL_DIR, 'workmate.json'), JSON.stringify({
    schema: 1,
    wsUrl: `ws://127.0.0.1:${BRIDGE_PORT}${BRIDGE_PATH}`,
    installId: 'e2e-install',
    workmateVersion: '0.21.0',
    minServerVersion: '1.1.0',
    ...fields,
  }, null, 2));
}
function writePairing(pairingToken) {
  writeFileSync(PAIRING_FILE, JSON.stringify({ schema: 1, token: pairingToken, port: BRIDGE_PORT, installId: 'e2e-install', createdAt: new Date().toISOString() }));
}
const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null);

async function extensionWorker(context, extensionId) {
  const existing = context.serviceWorkers().find(candidate => candidate.url().includes(extensionId));
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { predicate: candidate => candidate.url().includes(extensionId), timeout: 20_000 });
}

async function bridgeStatus(worker) {
  return worker.evaluate(async () => chrome.runtime.sendMessage({ type: 'cloud-bridge-status' }));
}

/** Drive the built server over stdio the way an MCP host does. */
async function stdioConnectionProbe(env) {
  const child = spawn(process.execPath, [path.join(MCP_DIST, 'index.js')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) replies.get(msg.id)?.(msg);
    } catch { /* not JSON-RPC */ }
  });
  let nextId = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`no reply to ${method}; stderr: ${stderr}`)), 20_000);
    replies.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'workmate-e2e', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const listed = await call('tools/list', {});
    // The extension re-dials on its backoff (≤10s) after the previous listener went away.
    let probe = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      probe = await call('tools/call', { name: 'webmate_connection', arguments: {} });
      if (probe.result?.structuredContent?.connected) break;
      await sleep(500);
    }
    return { init, listed, probe, stderr };
  } finally {
    child.stdin.end();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

async function main() {
  for (const required of [path.join(BRAND_DIST, 'manifest.json'), path.join(MCP_DIST, 'bridge.js')]) {
    if (!existsSync(required)) throw new Error(`${required} is missing — run brand:build and the mcp-server build first.`);
  }
  const executablePath = await chromeExecutable();
  if (!executablePath) throw new Error('Google Chrome was not found; set BRIDGE_E2E_CHROME_PATH.');

  const brandConfig = JSON.parse(readFileSync(path.join(ROOT, 'brand', 'brand.config.json'), 'utf8'));
  mkdirSync(INSTALL_DIR, { recursive: true });
  cpSync(BRAND_DIST, INSTALL_DIR, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(INSTALL_DIR, 'manifest.json'), 'utf8'));
  log(`staged ${manifest.name} v${manifest.version} into ${INSTALL_DIR}`);

  const { WebMateBridge } = await import(pathToFileURL(path.join(MCP_DIST, 'bridge.js')).href);
  const { StateFile } = await import(pathToFileURL(path.join(MCP_DIST, 'state.js')).href);
  const { SERVER_VERSION } = await import(pathToFileURL(path.join(MCP_DIST, 'version.js')).href);

  // Same wiring index.ts uses, so state.json is exercised for real.
  const state = new StateFile(STATE_FILE, { pid: process.pid, port: BRIDGE_PORT, serverVersion: SERVER_VERSION });
  let bridge = new WebMateBridge();
  const wireState = (b) => b.onChange(() => {
    const snap = b.snapshot();
    if (!snap.listening) return;
    state.update({
      listening: snap.listening, connected: snap.connected, pairingRequired: snap.pairingRequired,
      browser: snap.browser, extensionVersion: snap.version, installType: snap.installType,
      signedIn: snap.signedIn, protocolVersion: snap.protocolVersion, lastHelloAt: snap.lastHelloAt, error: snap.error,
    });
  });
  wireState(bridge);
  await bridge.start();
  log(`MCP listener up on ws://127.0.0.1:${BRIDGE_PORT}${BRIDGE_PATH} (dev mode: no pairing.json)`);

  let context = null;
  try {
    context = await chromium.launchPersistentContext('', {
      executablePath,
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
    });
    const browserCdp = await context.browser().newBrowserCDPSession();
    const loaded = await browserCdp.send('Extensions.loadUnpacked', { path: INSTALL_DIR });
    const extensionId = String(loaded.id || '');

    // ---- 1. the fixed ID -------------------------------------------------
    assert.equal(extensionId, brandConfig.product.extensionId, 'Chrome must derive product.extensionId from the manifest key');
    log(`1/6 Chrome loaded the folder as ${extensionId} — the ID pinned in brand.config.json`);

    // ---- 2. dev mode -----------------------------------------------------
    // Point this profile's Settings URL at the test port (dev mode follows the
    // Settings URL; the background re-syncs the bridge on the storage change).
    const worker = await extensionWorker(context, extensionId);
    await worker.evaluate(async (url) => chrome.storage.local.set({ webbrainCloudBridgeUrl: url }), `ws://127.0.0.1:${BRIDGE_PORT}${BRIDGE_PATH}`);
    assert.ok(await bridge.waitForExtension(30_000), 'the extension never dialled in');
    let info = bridge.info();
    assert.equal(info.protocolVersion, 3);
    assert.equal(info.installType, 'dev');
    assert.equal(info.version, manifest.version);
    assert.match(String(info.browser), /^(Chrome|Chromium) \d+$/);
    assert.equal(typeof info.signedIn, 'boolean');
    await state.flush();
    assert.equal(readState().connected, true);
    assert.equal(readState().installType, 'dev');
    let status = await waitFor(async () => { const s = await bridgeStatus(worker); return s?.connected ? s : null; }, 10_000, 'offscreen status');
    assert.equal(status.installType, 'dev');
    assert.equal(status.workmate, null);
    assert.equal(status.server?.version, SERVER_VERSION, 'hello_ack must reach the extension');
    assert.equal(status.server?.tokenEchoed, false);
    log(`2/6 dev mode: v3 hello, ${info.browser}, ${manifest.version}, signedIn=${info.signedIn}, hello_ack v${status.server.version}`);

    // ---- 3. paired ---------------------------------------------------------
    const pairedToken = token();
    writeWorkmateJson({ token: pairedToken });
    writePairing(pairedToken);
    // Bounce the listener: the extension re-reads workmate.json on its next dial.
    await bridge.stop();
    bridge = new WebMateBridge();
    wireState(bridge);
    await bridge.start();
    assert.equal(bridge.isPaired(), true);
    assert.ok(await bridge.waitForExtension(30_000), 'the paired extension never dialled in');
    info = bridge.info();
    assert.equal(info.installType, 'workmate');
    await state.flush();
    assert.equal(readState().connected, true);
    assert.equal(readState().pairingRequired, true);
    assert.equal(readState().installType, 'workmate');
    assert.equal(readState().error, null);
    status = await waitFor(async () => { const s = await bridgeStatus(worker); return s?.connected && s.installType === 'workmate' ? s : null; }, 10_000, 'paired offscreen status');
    assert.equal(status.workmate.hasToken, true);
    assert.equal(status.server.tokenEchoed, true, 'the server must echo the pairing token');
    assert.equal(status.holdoffUntil, null);
    log(`3/6 paired: connected as installType=workmate, token echoed, state.json browser=${readState().browser}`);

    // ---- 4. mismatch -------------------------------------------------------
    writePairing(token()); // a different token than the extension's workmate.json
    await bridge.stop();
    bridge = new WebMateBridge();
    wireState(bridge);
    await bridge.start();
    const rejectedAt = Date.now();
    await waitFor(async () => { await state.flush(); return /token mismatch/i.test(String(readState()?.error || '')) ? true : null; }, 30_000, 'a token-mismatch rejection in state.json');
    assert.equal(bridge.isConnected(), false);
    status = await waitFor(async () => { const s = await bridgeStatus(worker); return /rejected the handshake|pairing token/i.test(String(s?.lastError || '')) ? s : null; }, 10_000, 'extension-side rejection');
    assert.ok(status.holdoffUntil > Date.now() + 30_000, `extension must hold off for about a minute, got ${status.holdoffUntil - Date.now()}ms`);
    assert.equal(status.connected, false);
    log(`4/6 mismatch: server refused with 1008 (${Date.now() - rejectedAt}ms), state.json.error set, extension holding off`);

    // ---- 5. stdio, with the paired extension attached -----------------------
    writePairing(pairedToken);
    // The extension is in its 60s holdoff from step 4. Toggling the bridge off
    // and on (the Settings switch) clears it — the one explicit act that may
    // skip the wait. Sent the way the background's own stopBridge()/startBridge()
    // send them: a service worker never receives its own runtime messages, so
    // the offscreen-targeted frames are the ones to use from this context.
    await bridge.stop();
    await worker.evaluate(async () => chrome.runtime.sendMessage({ type: 'cloud-bridge-stop' }));
    await worker.evaluate(async (url) => chrome.runtime.sendMessage({ type: 'cloud-bridge-start', url }), `ws://127.0.0.1:${BRIDGE_PORT}${BRIDGE_PATH}`);
    const { init, listed, probe, stderr } = await stdioConnectionProbe({ WEBMATE_DIR, WEBMATE_BRIDGE_PORT: String(BRIDGE_PORT) });
    assert.equal(init.result.serverInfo.name, 'agentx-webmate');
    assert.equal(init.result.serverInfo.version, SERVER_VERSION);
    assert.equal(listed.result.tools.length, 6);
    const text = probe.result.content[0].text;
    assert.equal(probe.result.structuredContent?.connected, true, `webmate_connection never saw the extension: ${text}\n${stderr}`);
    assert.match(text, new RegExp(`AgentX WebMate ${manifest.version.replace(/\./g, '\\.')}`));
    assert.match(text, /(Chrome|Chromium) \d+/);
    assert.match(text, /installed by Workmate/);
    assert.equal(probe.result.structuredContent.version, manifest.version);
    assert.equal(probe.result.structuredContent.installType, 'workmate');
    log(`5/6 stdio: initialize v${init.result.serverInfo.version}, 6 tools, webmate_connection → ${text.split('\n')[1]}`);

    // ---- 6. prepare_update / resume / reload ------------------------------
    bridge = new WebMateBridge();
    wireState(bridge);
    await bridge.start();
    assert.ok(await bridge.waitForExtension(30_000), 'the extension did not re-dial the in-process listener');
    assert.equal(bridge.info().installType, 'workmate');
    const prepared = await bridge.request('workmate_prepare_update', {});
    assert.equal(prepared.ok, true);
    assert.equal(prepared.draining, true);
    assert.equal(prepared.busy, 0);
    await assert.rejects(
      () => bridge.request('cloud_run', { task: 'read this page', mode: 'ask' }),
      /about to update/i,
      'a draining extension must refuse new runs',
    );
    const resumed = await bridge.request('workmate_prepare_update', { resume: true });
    assert.equal(resumed.draining, false);
    await assert.rejects(
      () => bridge.request('cloud_run', { task: 'read this page', mode: 'ask' }),
      (error) => { assert.doesNotMatch(error.message, /about to update/i); return true; },
      'after resume the drain gate is gone (the run fails later for lack of a tab/provider, which is fine)',
    );
    const reloaded = await bridge.request('workmate_reload', {});
    assert.equal(reloaded.ok, true, 'the ack must cross the socket before the runtime goes down');
    await waitFor(async () => (!bridge.isConnected() ? true : null), 10_000, 'the socket to drop on reload');
    // chrome.runtime.reload() on an extension loaded through CDP
    // Extensions.loadUnpacked unloads it for good in this profile (verified on
    // Chrome 152: no service worker, no targets afterwards, and a second
    // loadUnpacked of the same folder returns the ID but does not dial). A
    // user's own Chrome, where the unpacked folder is registered in the
    // profile, reloads in place. Workmate's own browser window (phase 3) must
    // therefore relaunch its Chrome after an update instead of relying on the
    // reload — which is why the assertion stops at the socket dropping.
    log('6/6 prepare_update drains (503 on cloud_run), resume lifts it, workmate_reload is acked and the socket drops');

    console.log('\n  workmate install e2e: all checks passed');
  } finally {
    if (context) await context.close().catch(() => {});
    await bridge.stop().catch(() => {});
    rmSync(WEBMATE_DIR, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('\n  workmate install e2e FAILED:', error?.message || error);
  process.exitCode = 1;
});
