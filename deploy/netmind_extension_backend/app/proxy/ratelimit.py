"""Per-subject rate limiting for the provisioning surface.

Keyed on the verified `subject`, not on IP: a whole office behind one NAT is one
IP, and rate-limiting them as a unit would throttle a floor of people because
one of them retried. `current_identity` runs as a route dependency before the
limiter sees the request, so `request.state.identity` is always set by then.

Storage is in-memory, so counters are per worker process and the effective limit
is workers × replicas × `RATE_LIMIT_PER_MIN`. That is fine for a surface whose
happy path is one call per sign-in; point slowapi at Redis if real abuse ever
shows up.
"""
from fastapi import Request
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from starlette.responses import JSONResponse

from app.core.config import get_settings
from app.core.errors import error_json


def _subject_key(request: Request) -> str:
    identity = getattr(request.state, "identity", None)
    if identity is not None:
        return f"sub:{identity.subject}"
    # Unauthenticated requests never reach a limited route, but slowapi may ask
    # before the dependency has run. Fall back to the client host rather than
    # raising inside the limiter.
    return f"ip:{request.client.host if request.client else 'unknown'}"


limiter = Limiter(key_func=_subject_key)


def per_subject_limit() -> str:
    return f"{get_settings().rate_limit_per_min}/minute"


async def rate_limit_exceeded_handler(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RateLimitExceeded)
    return error_json("rate_limited", f"rate limit exceeded: {exc.detail}", 429)
