"""Authentication for telemetry ingestion.

Two ways in, and the difference is recorded on every row they write:

**Verified — `Authorization: Bearer <id_token>`.** The realm vouches for the
caller. `username` comes from the token and the one in the request body is
*ignored*, so a client cannot report telemetry as somebody else (spec R1). Rows
land with `identity_verified = true`.

**Unverified — `X-Auth-Key: <shared secret>`.** For clients that have not signed
in. A browser extension cannot keep a secret: the key ships inside a bundle any
user can read in DevTools. So this path proves only "some copy of the extension
sent this", the body's `username` is taken at face value, and rows land with
`identity_verified = false`. Any report where attribution matters must filter on
that column rather than quietly averaging the two populations together.

Leaving `INGEST_AUTH_KEY` unset disables the fallback entirely, which is the
right setting once every client signs in.

One deliberate asymmetry: a token that the realm *rejects* is an error, but a
realm we *cannot reach* falls back to the shared key when one is configured.
Telemetry is worth keeping through a JWKS outage, and the fallback grants no new
capability — anyone holding the shared key could simply omit the bearer instead.
A rejected token is different: it means the client is broken or lying, and
silently downgrading it would hide that.
"""
import hmac
from dataclasses import dataclass
from typing import Annotated

import httpx
from fastapi import Depends, Header, Request
from loguru import logger

from app.auth.tokens import looks_like_jwt, verify_bearer
from app.auth.models import Identity
from app.core.config import Settings, get_settings
from app.core.errors import (
    AppError,
    IdentityUnavailableError,
    InvalidTokenError,
    MissingBearerError,
)


class IngestUnauthorizedError(AppError):
    status_code = 401
    code = "ingest_unauthorized"


class IngestUnconfiguredError(AppError):
    """Neither identity nor a shared key is configured, so nothing can be trusted."""

    status_code = 503
    code = "ingest_unconfigured"


@dataclass(frozen=True)
class IngestAuth:
    """How this request authenticated, and who it may claim to be."""

    verified: bool
    identity: Identity | None = None

    def username(self, declared: str | None) -> str:
        """The username to record.

        Verified callers get theirs from the token — whatever the body says is
        discarded. Unverified callers get what they declared, which is exactly
        why their rows are marked unverified.
        """
        if self.verified and self.identity is not None:
            return self.identity.username
        return (declared or "").strip().lower()

    @property
    def subject(self) -> str | None:
        return self.identity.subject if self.identity else None


def _shared_key_ok(provided: str | None, settings: Settings) -> bool:
    expected = settings.ingest_auth_key
    if not expected or not provided:
        return False
    # Constant time: a shared secret compared byte-by-byte leaks itself to
    # anyone patient enough to measure.
    return hmac.compare_digest(provided, expected)


async def ingest_auth(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_auth_key: Annotated[str | None, Header()] = None,
    settings: Annotated[Settings, Depends(get_settings)] = ...,  # type: ignore[assignment]
) -> IngestAuth:
    from app.auth.deps import get_http_client  # circular at module scope

    if not settings.identity_enabled and not settings.ingest_auth_key:
        raise IngestUnconfiguredError(
            "ingestion accepts neither tokens nor a shared key on this deployment"
        )

    if authorization:
        try:
            token = _bearer_or_none(authorization)
        except MissingBearerError:
            token = None

        # In userinfo mode a bearer need not be a JWT at all — the issuer may
        # hand out an opaque token — so shape is no longer what makes it usable.
        usable = looks_like_jwt(token or "") or settings.uses_userinfo
        if token and usable and settings.identity_enabled:
            client: httpx.AsyncClient = get_http_client(request)
            try:
                claims = await verify_bearer(token, client, settings)
            except IdentityUnavailableError:
                # Could not ask the realm. Keep the data if the shared key is
                # also present; otherwise surface the outage honestly.
                if _shared_key_ok(x_auth_key, settings):
                    logger.warning(
                        "[Ingest] identity provider unreachable; accepting this "
                        "batch on the shared key as unverified"
                    )
                    return IngestAuth(verified=False)
                raise
            identity = Identity.from_claims(claims)
            request.state.identity = identity
            return IngestAuth(verified=True, identity=identity)

        # A bearer was presented but is not a usable token. Do not quietly
        # downgrade it — that hides a broken client.
        raise InvalidTokenError("Authorization header is not a usable ID token")

    if _shared_key_ok(x_auth_key, settings):
        return IngestAuth(verified=False)

    raise IngestUnauthorizedError(
        "provide either 'Authorization: Bearer <id_token>' or a valid X-Auth-Key"
    )


def _bearer_or_none(authorization: str) -> str | None:
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        return None
    return parts[1].strip()
