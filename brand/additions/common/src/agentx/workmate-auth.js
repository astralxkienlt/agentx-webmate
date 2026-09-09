/**
 * Sign-in on request from AgentX Workmate — the two bridge actions the
 * offscreen bridge forwards to the background (`auth_hint`, `auth_open`).
 *
 * The problem this solves: Workmate signs the person in to AgentX in their
 * browser, then installs this extension into the same browser, and the side
 * panel still greets them with "Đăng nhập để bắt đầu". The Keycloak SSO cookie
 * from Workmate's sign-in is right there in the profile, so:
 *
 *   auth_hint { loginHint }   prompt=none authorize through chrome.identity
 *                             (cloud-service.js silentSignIn): no window, no
 *                             click. The hint is the account email Workmate
 *                             is signed in as. "No session here" is a normal
 *                             answer (outcome `login-required`), remembered
 *                             for a minute so Workmate's retries do not spin
 *                             the identity flow.
 *   auth_open { loginHint }   the interactive sign-in the panel's button
 *                             runs, opened from Workmate's "Đăng nhập WebMate"
 *                             button with the email pre-filled. Answers as
 *                             soon as the sign-in tab is open (`opened`);
 *                             the person may take minutes, so the outcome
 *                             reaches Workmate through the session relay
 *                             (a `session` frame once the session is stored),
 *                             not through this reply.
 *
 * Both install the provisioned gateway credential the way the panel does
 * (installCloudCredential), so the panel — open or not — finds itself signed
 * in through storage. Nothing here takes a credential over the socket.
 */

import { AGENTX_RUNTIME_CONFIG } from './runtime-config.js';
import { AgentXCloudError, createAgentXCloudService } from './cloud-service.js';
import { installCloudCredential } from './cloud-provider-install.js';

export const LOGIN_REQUIRED_HOLDOFF_MS = 60_000;

function sameEmail(left, right) {
  const a = String(left || '').trim().toLowerCase();
  const b = String(right || '').trim().toLowerCase();
  return Boolean(a) && a === b;
}

export function createWorkmateAuth({
  api,
  sendToBackground,
  config = AGENTX_RUNTIME_CONFIG,
  service = null,
  serviceOptions = {},
  now = () => Date.now(),
  holdoffMs = LOGIN_REQUIRED_HOLDOFF_MS,
} = {}) {
  if (typeof sendToBackground !== 'function') {
    throw new TypeError('sendToBackground is required');
  }

  let cloud = service;
  let inFlight = null;
  // The interactive sign-in that is currently open, if any, and how the last
  // one ended (reported by status() for Workmate's diagnostics).
  let interactive = null;
  let lastInteractive = null;
  // After Keycloak said "no session" for a hint, the same hint gets the same
  // answer for a while: the person has not signed in to Workmate in between.
  let holdoff = { until: 0, loginHint: '' };

  function getService() {
    if (!cloud) cloud = createAgentXCloudService({ ...serviceOptions, api, config });
    return cloud;
  }

  async function status() {
    const current = await getService().publicStatus();
    return {
      signedIn: Boolean(current.signedIn),
      email: String(current.user?.email || ''),
      outcome: String(current.outcome || ''),
      interactiveOpen: interactive !== null,
      lastInteractive,
    };
  }

  function failure(error) {
    const code = error instanceof AgentXCloudError ? error.code : 'error';
    return {
      ok: false,
      outcome: 'error',
      signedIn: false,
      error: code,
      message: error?.message || String(error),
    };
  }

  async function alreadySignedIn(loginHint) {
    const current = await status();
    if (!current.signedIn) return null;
    return {
      ok: true,
      outcome: 'already-signed-in',
      signedIn: true,
      email: current.email,
      matchesHint: !loginHint || sameEmail(current.email, loginHint),
    };
  }

  async function runExclusive(work) {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(work)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function hint(msg = {}) {
    const loginHint = String(msg.loginHint || '').trim();
    return runExclusive(async () => {
      const already = await alreadySignedIn(loginHint);
      if (already) return already;
      if (holdoff.until > now() && holdoff.loginHint === loginHint) {
        return { ok: true, outcome: 'login-required', signedIn: false, heldOff: true, retryAt: holdoff.until };
      }
      try {
        const result = await getService().silentSignInAndProvision({ loginHint });
        await installCloudCredential(sendToBackground, result.credential);
        return {
          ok: true,
          outcome: 'signed-in',
          signedIn: true,
          email: String(result.session?.user?.email || ''),
          silent: true,
        };
      } catch (error) {
        if (error instanceof AgentXCloudError && error.code === 'login_required') {
          holdoff = { until: now() + holdoffMs, loginHint };
          return {
            ok: true,
            outcome: 'login-required',
            signedIn: false,
            error: error.code,
            message: error.message,
            detail: error.detail || '',
          };
        }
        if (error instanceof AgentXCloudError && error.code === 'identity_unavailable_api') {
          return { ok: false, outcome: 'unsupported', signedIn: false, error: error.code, message: error.message };
        }
        return failure(error);
      }
    });
  }

  function open(msg = {}) {
    const loginHint = String(msg.loginHint || '').trim();
    return runExclusive(async () => {
      const already = await alreadySignedIn(loginHint);
      if (already && already.matchesHint) return already;
      if (interactive) {
        return { ok: true, outcome: 'in-progress', signedIn: false, startedAt: interactive.startedAt };
      }
      const startedAt = now();
      interactive = { startedAt, loginHint };
      // Runs for as long as the person takes; the bridge reply below does not
      // wait for it. The stored session (storage.onChanged → session frame)
      // is how Workmate learns the end of it.
      const flow = getService()
        .signInAndProvision({ loginHint })
        .then(async (result) => {
          await installCloudCredential(sendToBackground, result.credential);
          lastInteractive = {
            ok: true,
            outcome: 'signed-in',
            email: String(result.session?.user?.email || ''),
            finishedAt: now(),
          };
        })
        .catch((error) => {
          lastInteractive = { ...failure(error), finishedAt: now() };
        })
        .finally(() => {
          if (interactive && interactive.startedAt === startedAt) interactive = null;
        });
      // Give the tab a moment to open so a refusal to open one (no window,
      // no tabs permission) is reported here rather than swallowed.
      const opened = await Promise.race([
        flow.then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('opened'), 750)),
      ]);
      if (opened === 'settled') {
        return lastInteractive?.ok
          ? { ok: true, outcome: 'signed-in', signedIn: true, email: lastInteractive.email, silent: false }
          : { ...(lastInteractive || failure(new Error('sign-in ended'))), signedIn: false };
      }
      return { ok: true, outcome: 'opened', signedIn: false, startedAt };
    });
  }

  return { hint, open, status };
}
