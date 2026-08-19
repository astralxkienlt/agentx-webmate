"""Verification by asking the issuer, for an issuer that publishes no key.

The Viettel SSO wrapper is a CAS-to-OIDC shim, not an identity provider in its
own right. It signs ID tokens with HS256 using a secret held only by the wrapper
process, serves no JWKS, and registers no clients — `/authorize` forwards any
`client_id` at all to the upstream CAS. Two consequences follow, and both are
why this module exists:

**There is no key to verify against.** Not a public one, because HS256 has none;
not a shared one, because the wrapper hands its signing secret to nobody. Local
signature verification is not merely unconfigured here, it is unavailable. So
the bearer is checked the only way left: hand it back to the issuer and ask who
it belongs to. A `200` from `/userinfo` is the proof.

**`aud` proves nothing.** The wrapper echoes back whatever `client_id` was sent,
so pinning the audience — the defence `verify_id_token` leans on — would only be
theatre. The token's *own* claims are ignored entirely in this mode; identity
comes from the userinfo response and nowhere else.

The cost is a network round trip per verification, and with it a dependency this
service did not have before: an issuer that is down can no longer be worked
around locally. That is what the cache and the error split below are for.

    401/403 from the issuer      → InvalidTokenError (401)   we asked, the answer is no
    unreachable / 5xx / garbage  → IdentityUnavailableError (503)  we could not ask

Collapsing the second into the first would sign the whole fleet out on a network
blip, which is exactly the rule `tokens.py` states and this module inherits.
"""
import hashlib
import time

import httpx
from loguru import logger

from app.core.config import Settings
from app.core.errors import (
    IdentityUnavailableError,
    IdentityUnconfiguredError,
    InvalidTokenError,
)

# Verified claims by token digest. The token itself is never a key and never
# stored: a cache readable in a core dump must not be a wallet of live bearers.
_CACHE: dict[str, tuple[float, dict]] = {}
# Enough for a busy fleet, small enough that a flood of junk bearers cannot grow
# it without bound. Only *verified* answers land here, so this is a ceiling on
# concurrent signed-in users, not on attacker-controlled input.
_CACHE_MAX = 2048


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def clear_cache() -> None:
    """Drop every cached answer. For tests and for a deliberate flush."""
    _CACHE.clear()


def _cached(key: str) -> dict | None:
    hit = _CACHE.get(key)
    if hit is None:
        return None
    expires_at, claims = hit
    if expires_at <= time.monotonic():
        _CACHE.pop(key, None)
        return None
    return claims


def _remember(key: str, claims: dict, ttl: float) -> None:
    if ttl <= 0:
        return
    if len(_CACHE) >= _CACHE_MAX:
        now = time.monotonic()
        for stale in [k for k, (exp, _) in _CACHE.items() if exp <= now]:
            _CACHE.pop(stale, None)
        if len(_CACHE) >= _CACHE_MAX:
            # Still full of live entries. Start over rather than evict by a
            # guess: a wrong eviction costs one round trip, nothing more.
            _CACHE.clear()
    _CACHE[key] = (time.monotonic() + ttl, claims)


async def verify_via_userinfo(
    token: str, client: httpx.AsyncClient, settings: Settings
) -> dict:
    """Claims for a bearer the issuer vouches for, or a refusal.

    Returns the userinfo document. `sub` is mandatory — an identity without a
    stable subject is not an identity, and every account slug, key alias and
    telemetry row downstream is derived from it.
    """
    endpoint = settings.oidc_userinfo_endpoint.strip()
    if not endpoint:
        raise IdentityUnconfiguredError("no userinfo endpoint configured to verify tokens with")
    if not token:
        raise InvalidTokenError("empty bearer token")

    key = _digest(token)
    cached = _cached(key)
    if cached is not None:
        return cached

    try:
        response = await client.get(
            endpoint,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=settings.oidc_userinfo_timeout,
        )
    except httpx.HTTPError as e:
        # Named exception, not a bare except: an outage must never be able to
        # arrive here disguised as a rejection.
        logger.warning(f"[Userinfo] {endpoint} unreachable: {type(e).__name__}: {e}")
        raise IdentityUnavailableError("could not reach the issuer to verify this token") from e

    if response.status_code in (401, 403):
        stated = _oauth_error(response)
        if stated is None:
            # A 401/403 carrying no OAuth error body did not come from the
            # issuer weighing this token. Something in front of it refused the
            # request — a gateway, a WAF, a host-based rule — and we learned
            # nothing at all about the bearer. Calling that a rejection would
            # sign every user out over an infrastructure fault, which is the one
            # thing the 401/503 split exists to prevent.
            logger.error(
                f"[Userinfo] {endpoint} answered HTTP {response.status_code} with no OAuth "
                f"error body — something in front of the issuer refused us, not the issuer"
            )
            raise IdentityUnavailableError(
                f"the issuer could not be asked about this token "
                f"(HTTP {response.status_code} from in front of it)"
            )
        # The issuer's own wording is worth keeping — "Token not found or
        # expired" tells an operator something "invalid" does not.
        raise InvalidTokenError(f"the issuer rejected this token ({stated})")

    if response.status_code != 200:
        logger.warning(f"[Userinfo] {endpoint} answered HTTP {response.status_code}")
        raise IdentityUnavailableError(
            f"the issuer answered HTTP {response.status_code} when asked to verify this token"
        )

    try:
        claims = response.json()
    except ValueError as e:
        logger.error(f"[Userinfo] {endpoint} returned a body that is not JSON")
        raise IdentityUnavailableError("the issuer's userinfo response was not JSON") from e

    if not isinstance(claims, dict) or not str(claims.get("sub") or "").strip():
        # A 200 without a subject is a broken issuer, not a bad token, so it is
        # 503: clients keep the key they hold while somebody fixes the wrapper.
        logger.error(f"[Userinfo] {endpoint} returned 200 with no usable 'sub'")
        raise IdentityUnavailableError("the issuer's userinfo response carried no sub")

    _remember(key, claims, settings.oidc_userinfo_cache_seconds)
    return claims


def _oauth_error(response: httpx.Response) -> str | None:
    """The issuer's stated reason, or None if this is not an OAuth error at all.

    `None` is the load-bearing case: it means the refusal came with no OAuth
    error object, so whatever produced it was not the issuer answering a
    question about a token. Never returns the token, never a whole body.
    """
    try:
        body = response.json()
    except ValueError:
        return None
    if not isinstance(body, dict) or not body.get("error"):
        return None
    stated = body.get("error_description") or body.get("error")
    if isinstance(stated, str) and stated.strip():
        return stated.strip()[:200]
    return None
