"""Wire errors.

The body is flat and `error` is one field access away:

    {"error": "device_revoked", "detail": "This device has been revoked."}

Clients switch on `error`. `detail` is prose for humans and will be reworded —
any client matching on it is a client that breaks the day someone improves the
wording (integration spec §6.6).

The distinction the whole table exists to protect is **rejected vs unreachable**:

    401 invalid_token        the realm looked and said no      → sign in again
    503 identity_unavailable we could not ask the realm        → keep the token

Collapsing the second into the first signs the entire fleet out every time the
JWKS endpoint hiccups. That has happened; it is why these are separate classes
rather than one error with a status argument.
"""
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pydantic import BaseModel


class ErrorResponse(BaseModel):
    """Flat error body. Documented so it shows up in the OpenAPI schema."""

    error: str
    detail: str


class AppError(Exception):
    status_code: int = 500
    code: str = "internal_error"

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail or self.code)
        self.detail = detail or self.code


# ── Identity ─────────────────────────────────────────────────────────────────

class MissingBearerError(AppError):
    status_code = 401
    code = "missing_bearer"


class InvalidTokenError(AppError):
    """The realm was consulted (or its keys were) and the token did not pass."""

    status_code = 401
    code = "invalid_token"


class IdentityUnavailableError(AppError):
    """We could not reach the realm. NOT the same as a rejected token."""

    status_code = 503
    code = "identity_unavailable"


class IdentityUnconfiguredError(AppError):
    """This deployment has no realm configured, so nothing can be verified."""

    status_code = 503
    code = "identity_unconfigured"


# ── Device ───────────────────────────────────────────────────────────────────

class DeviceHeaderMissingError(AppError):
    status_code = 400
    code = "device_header_missing"


class DeviceHeaderInvalidError(AppError):
    status_code = 400
    code = "device_header_invalid"


class DeviceRevokedError(AppError):
    status_code = 403
    code = "device_revoked"


class DeviceNotFoundError(AppError):
    """Also returned for a device belonging to somebody else.

    404 rather than 403 on purpose: 403 would confirm that the id exists, which
    is a question this endpoint has no business answering (spec §6.4).
    """

    status_code = 404
    code = "device_not_found"


class CannotRevokeLastDeviceError(AppError):
    status_code = 409
    code = "cannot_revoke_last_device"


# ── Store / gateway ──────────────────────────────────────────────────────────

class StoreUnavailableError(AppError):
    status_code = 503
    code = "store_unavailable"


class KeyUnreadableError(AppError):
    """A stored key exists but no configured KEK opens it."""

    status_code = 503
    code = "key_unreadable"


class LiteLLMUnconfiguredError(AppError):
    """503, not 500: it tells the client to keep its key and retry later, which
    is exactly right while an operator fixes the deployment."""

    status_code = 503
    code = "litellm_unconfigured"


class LiteLLMUnavailableError(AppError):
    """Gateway unreachable. Nothing was minted."""

    status_code = 503
    code = "litellm_unavailable"


class LiteLLMRefusedError(AppError):
    """The gateway answered and said no. A problem with this request."""

    status_code = 502
    code = "litellm_refused"


class HandlerNotFoundError(AppError):
    status_code = 404
    code = "handler_not_found"


def error_json(code: str, detail: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content={"error": code, "detail": detail}
    )


async def _handle_app_error(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, AppError)
    log = logger.bind(code=exc.code, status=exc.status_code)
    if exc.status_code >= 500:
        log.error(f"{exc.code}: {exc.detail}")
    else:
        log.warning(f"{exc.code}: {exc.detail}")
    return error_json(exc.code, exc.detail, exc.status_code)


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, _handle_app_error)
