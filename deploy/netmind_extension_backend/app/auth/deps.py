"""FastAPI dependencies for authentication and device registration.

The ordering here is a security property, not a style choice: bearer is verified
first, then the device is registered *and* checked for revocation in a single
statement. Reading "not revoked" and then acting on it as two steps leaves a
window where a revocation lands in between (spec §6.1).
"""
import re
from typing import Annotated

import httpx
from fastapi import Depends, Header, Request
from sqlalchemy.exc import SQLAlchemyError

from app.auth.tokens import verify_bearer
from app.auth.models import Identity
from app.core.config import Settings, get_settings
from app.core.errors import (
    DeviceHeaderInvalidError,
    DeviceHeaderMissingError,
    MissingBearerError,
    StoreUnavailableError,
)

DEVICE_ID_HEADER = "X-AgentX-Device"
DEVICE_NAME_HEADER = "X-AgentX-Device-Name"

_DEVICE_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
# A device name is whatever the user called their laptop. It reaches us in an
# HTTP header, so anything that could break header framing or a log line is
# removed rather than escaped.
_NAME_ALLOWED = re.compile(r"[^A-Za-z0-9 ._-]+")
_NAME_MAX = 64


def extract_bearer(authorization: str | None) -> str:
    if not authorization:
        raise MissingBearerError("missing Authorization header")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise MissingBearerError("Authorization header must be 'Bearer <token>'")
    return parts[1].strip()


def sanitize_device_name(raw: str | None) -> str:
    """Display-only. Never trusted, never used as a key."""
    if not raw:
        return ""
    cleaned = _NAME_ALLOWED.sub(" ", raw)
    cleaned = " ".join(cleaned.split())
    return cleaned[:_NAME_MAX]


def get_http_client(request: Request) -> httpx.AsyncClient:
    client = getattr(request.app.state, "http_client", None)
    if client is None:  # pragma: no cover — lifespan always sets this
        raise RuntimeError("HTTP client not initialised")
    return client


async def current_identity(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    client: Annotated[httpx.AsyncClient, Depends(get_http_client)] = ...,  # type: ignore[assignment]
    settings: Annotated[Settings, Depends(get_settings)] = ...,  # type: ignore[assignment]
) -> Identity:
    """Verified caller identity. Raises 401/503 — never returns an unverified one."""
    token = extract_bearer(authorization)
    claims = await verify_bearer(token, client, settings)
    identity = Identity.from_claims(claims)
    request.state.identity = identity
    return identity


def device_id_header(
    x_agentx_device: Annotated[str | None, Header()] = None,
) -> str:
    """The calling install's device id, lowercased.

    Missing and malformed are separate error codes because they are separate
    client bugs: one forgot the header, the other is sending something that is
    not a UUID. Telling them apart saves an afternoon.
    """
    if not x_agentx_device or not x_agentx_device.strip():
        raise DeviceHeaderMissingError(f"{DEVICE_ID_HEADER} header is required")
    value = x_agentx_device.strip().lower()
    if not _DEVICE_ID_RE.match(value):
        raise DeviceHeaderInvalidError(f"{DEVICE_ID_HEADER} must be a UUID")
    return value


def device_name_header(
    x_agentx_device_name: Annotated[str | None, Header()] = None,
) -> str:
    return sanitize_device_name(x_agentx_device_name)


async def current_device(
    identity: Annotated[Identity, Depends(current_identity)],
    device_id: Annotated[str, Depends(device_id_header)],
    device_name: Annotated[str, Depends(device_name_header)],
) -> str:
    """Register this install and confirm it is still allowed, in one statement.

    Returns the device id so handlers can name the caller without re-reading the
    header. Raises `DeviceRevokedError` if the install has been revoked.
    """
    # Imported here rather than at module scope: app.services.devices imports
    # the ORM models, which import Base, which the test harness rebinds.
    from app.services import devices

    try:
        await devices.register(identity.subject, device_id, device_name)
    except SQLAlchemyError as e:
        raise StoreUnavailableError("device registry unavailable") from e
    return device_id
