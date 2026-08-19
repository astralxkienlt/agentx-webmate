"""`POST /v1/provision-keys/{name}` — the route that matters.

Idempotent and safe to call after every sign-in: the second call for a person
returns the same key with `status: "reused"` and never touches the gateway's
write API.
"""
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Request
from loguru import logger

from app.auth.deps import current_device, current_identity, get_http_client
from app.auth.models import Identity
from app.core.errors import ErrorResponse
from app.proxy.providers import registry
from app.proxy.ratelimit import limiter, per_subject_limit
from app.schemas.proxy import ProvisionRequest, ProvisionResponse

router = APIRouter(prefix="/v1/provision-keys", tags=["provision"])

_RESPONSES: dict = {
    400: {"model": ErrorResponse, "description": "device_header_missing | device_header_invalid"},
    401: {"model": ErrorResponse, "description": "missing_bearer | invalid_token"},
    403: {"model": ErrorResponse, "description": "device_revoked"},
    404: {"model": ErrorResponse, "description": "handler_not_found"},
    429: {"model": ErrorResponse, "description": "rate_limited"},
    502: {"model": ErrorResponse, "description": "litellm_refused"},
    503: {
        "model": ErrorResponse,
        "description": (
            "identity_unavailable | store_unavailable | litellm_unconfigured | "
            "litellm_unavailable | key_unreadable — all mean *keep the key you have*"
        ),
    },
}


@router.post(
    "/{name}",
    response_model=ProvisionResponse,
    response_model_by_alias=True,
    responses=_RESPONSES,
    summary="Provision this user's model key",
    description=(
        "Returns the caller's model key, minting one only if they do not already "
        "have one. Safe to call on every sign-in.\n\n"
        "The account is taken from the verified token; there is no way to ask for "
        "somebody else's key. Requires the `X-AgentX-Device` header — a device "
        "list that cannot say which entry is *this* machine is a list nobody dares "
        "revoke from."
    ),
)
@limiter.limit(per_subject_limit)
async def provision_key(
    request: Request,
    name: str,
    identity: Annotated[Identity, Depends(current_identity)],
    device_id: Annotated[str, Depends(current_device)],
    client: Annotated[httpx.AsyncClient, Depends(get_http_client)],
    body: ProvisionRequest | None = None,
) -> ProvisionResponse:
    # An empty body is valid — `curl -d '{}'` and a client that sends nothing at
    # all must both work, so `rotate` defaults rather than being required.
    rotate = bool(body.rotate) if body is not None else False
    handler = registry.get(name, "provision")
    logger.info(
        f"[Provision] handler={name} subject={identity.subject} "
        f"device={device_id} rotate={rotate}"
    )
    response = await handler.handle(identity, client, rotate=rotate)
    logger.info(
        f"[Provision] done handler={name} subject={identity.subject} "
        f"status={response.status}"
    )
    return response
