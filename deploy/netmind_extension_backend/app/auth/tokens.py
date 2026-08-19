"""ID-token verification.

Three modes, one entry point (`verify_bearer`), chosen entirely by environment:

* **userinfo** (`OIDC_USERINFO_ENDPOINT` set) — the bearer is handed back to the
  issuer, which says who it belongs to. The only mode that works against an
  issuer whose signing key nobody else holds, which is the case on the Viettel
  SSO wrapper. Lives in `app.auth.userinfo`; nothing below runs.
* **symmetric** (`HS*`) — verified against `OIDC_SHARED_SECRET`, for an issuer
  that does share its signing secret.
* **asymmetric** (`RS*`/`ES*`/`PS*`) — verified against a fetched JWKS.

Everything from here down is the second and third. Two consequences follow from
the symmetric one, and both are load-bearing:

**The secret is a signing key, not a verification key.** HMAC is symmetric —
anything that can check a signature can also produce one. This service can
therefore mint tokens indistinguishable from the wrapper's. That is tolerable
between two services one team runs, and intolerable anywhere else: the secret
must never reach the extension, a log line, or version control.

**The algorithm is pinned, and that is the whole defence.** Algorithm confusion
is the classic JWT forgery: hand an RS256 verifier an HS256 token signed with
the public key it trusts, and it validates. Accepting exactly one configured
algorithm closes it in both directions, before any key is selected. `none` is
refused unconditionally.

The other rule this module exists to protect is the split between *rejected* and
*unreachable*:

    token expired / bad signature / wrong issuer / wrong audience
        → InvalidTokenError (401)          we checked, the answer is no
    JWKS unreachable (asymmetric mode only)
        → IdentityUnavailableError (503)   we could not check

Collapsing the second into the first signs the whole fleet out on a network
blip. Every `except` below therefore names its exception; nothing here can
quietly reclassify an outage as a rejection.
"""
import httpx
from jose import jwt
from jose.exceptions import ExpiredSignatureError, JWTError
from jose.utils import base64url_decode
from loguru import logger

from app.auth.jwks import get_jwks_cache
from app.auth.userinfo import verify_via_userinfo
from app.core.config import Settings, get_settings
from app.core.errors import IdentityUnconfiguredError, InvalidTokenError


def _unverified_header(token: str) -> dict:
    """Read the JOSE header without trusting a single thing inside the token."""
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as e:
        raise InvalidTokenError("token header is not valid JOSE") from e
    if not isinstance(header, dict):
        raise InvalidTokenError("token header is not an object")
    return header


def _checked_alg(header: dict, settings: Settings) -> str:
    """The token's algorithm, or a refusal.

    Compared against the single configured algorithm rather than a permitted
    list. A list is what lets an attacker pick the weakest member of it.
    """
    alg = str(header.get("alg") or "").upper()
    if not alg or alg == "NONE":
        raise InvalidTokenError("token is unsigned (alg=none)")
    expected = settings.id_token_alg
    if alg != expected:
        # The log names both algorithms because the difference between a
        # misconfiguration and a forgery attempt is exactly which one arrived.
        logger.warning(f"[Token] alg mismatch: token used {alg}, this service issues {expected}")
        raise InvalidTokenError(f"token signed with {alg}, not the expected {expected}")
    return alg


def _issuer_matches(claim: object, configured: str) -> bool:
    """Compare `iss` to the configured issuer, forgiving only a trailing slash."""
    return isinstance(claim, str) and claim.rstrip("/") == configured


def _audience_matches(claim: object, accepted: list[str]) -> bool:
    """Does `aud` name an audience this service answers for?

    Two shapes have to be handled: an issuer emits `aud` as a bare string for one
    audience and as a list once there is more than one. A service that only
    understood the first shape would start rejecting every token the day someone
    adds a second client scope.
    """
    if not accepted:
        return False
    if isinstance(claim, str):
        return claim in accepted
    if isinstance(claim, (list, tuple)):
        return any(isinstance(a, str) and a in accepted for a in claim)
    return False


async def _signing_key(
    header: dict, client: httpx.AsyncClient, settings: Settings
) -> str | dict:
    """Key material for this token, chosen by the configured algorithm."""
    if settings.uses_shared_secret:
        # Symmetric: the shared secret, and nothing from the token influences
        # which key is used. `kid` is deliberately ignored here — letting a
        # token steer key selection is how key-confusion bugs start.
        if not settings.oidc_shared_secret:
            raise IdentityUnconfiguredError("no shared secret configured to verify tokens with")
        return settings.oidc_shared_secret

    kid = header.get("kid")
    if not kid or not isinstance(kid, str):
        raise InvalidTokenError("token header carries no kid")
    return await get_jwks_cache().get_key(kid, client, settings)


async def verify_id_token(
    token: str, client: httpx.AsyncClient, settings: Settings | None = None
) -> dict:
    """Verify an ID token and return its claims.

    Checks the algorithm, the signature, `exp`, `iss`, `aud` and `sub`. Raises
    `InvalidTokenError` for anything the token got wrong and
    `IdentityUnavailableError` only when the issuer could not be consulted.
    """
    settings = settings or get_settings()
    if not settings.identity_enabled:
        raise IdentityUnconfiguredError("this deployment cannot verify tokens")
    if not token:
        raise InvalidTokenError("empty bearer token")

    header = _unverified_header(token)
    alg = _checked_alg(header, settings)
    key = await _signing_key(header, client, settings)

    try:
        claims = jwt.decode(
            token,
            key,
            # Exactly one algorithm. Passing the configured value rather than a
            # list is what makes downgrade impossible at this layer too.
            algorithms=[alg],
            options={
                # `aud` and `iss` are checked below instead: python-jose accepts
                # only one audience string, and this service must be able to
                # answer for several during a client-id migration.
                "verify_aud": False,
                "verify_iss": False,
                "verify_exp": True,
                "verify_signature": True,
                # Nothing here to check `at_hash` against — we never receive the
                # access token that would pair with this ID token.
                "verify_at_hash": False,
                "leeway": settings.jwt_leeway_seconds,
            },
        )
    except ExpiredSignatureError as e:
        raise InvalidTokenError("token has expired") from e
    except JWTError as e:
        # python-jose folds signature failures into one exception type. The
        # reason is logged (never the token) so an operator can tell a rotated
        # secret from a genuine forgery attempt.
        logger.warning(f"[Token] rejected: {type(e).__name__}: {e}")
        raise InvalidTokenError("token signature is not valid") from e

    if not _issuer_matches(claims.get("iss"), settings.issuer):
        logger.warning(f"[Token] issuer mismatch: token said {claims.get('iss')!r}")
        raise InvalidTokenError("token issuer does not match the configured issuer")

    if not _audience_matches(claims.get("aud"), settings.audiences):
        logger.warning(f"[Token] audience mismatch: token said {claims.get('aud')!r}")
        raise InvalidTokenError("token audience does not match this service")

    if not claims.get("sub"):
        raise InvalidTokenError("token carries no sub claim")

    return claims


async def verify_bearer(
    token: str, client: httpx.AsyncClient, settings: Settings | None = None
) -> dict:
    """Claims for a bearer, by whichever check this deployment can actually make.

    Callers never choose the mode. That is the point: an issuer that starts
    publishing a JWKS, or one that never will, is an environment change here and
    nothing at all anywhere else.
    """
    settings = settings or get_settings()
    if not settings.identity_enabled:
        raise IdentityUnconfiguredError("this deployment cannot verify tokens")
    if settings.uses_userinfo:
        return await verify_via_userinfo(token, client, settings)
    return await verify_id_token(token, client, settings)


def looks_like_jwt(token: str) -> bool:
    """Cheap shape check: three base64url segments with a decodable header.

    Used only to route a bearer to the right verifier; it decides nothing about
    trust. A `True` here is never validation.
    """
    parts = token.split(".")
    if len(parts) != 3 or not parts[0] or not parts[1]:
        return False
    try:
        base64url_decode(parts[0].encode())
    except Exception:  # noqa: BLE001 — malformed base64 raises several types
        return False
    return True
