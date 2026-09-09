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
 *                             button with the email pre-filled.
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
      try {
        const result = await getService().signInAndProvision({ loginHint });
        await installCloudCredential(sendToBackground, result.credential);
        return {
          ok: true,
          outcome: 'signed-in',
          signedIn: true,
          email: String(result.session?.user?.email || ''),
          silent: false,
        };
      } catch (error) {
        return failure(error);
      }
    });
  }

  return { hint, open, status };
}
