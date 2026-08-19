"""`GET /v1/secrets/{name}` — read-only fetch of an already-provisioned secret.

Distinct from `/v1/provision-keys` in exactly one way, and it is the important
one: this route **never mints**. A client that only wants to know its current
key uses this and cannot accidentally create gateway state by doing so.
"""
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Request
from loguru import logger

from app.auth.deps import current_device, current_identity, get_http_client
from app.auth.models import Identity
from app.core.errors import ErrorResponse, HandlerNotFoundError
from app.proxy.ratelimit import limiter, per_subject_limit
from app.schemas.proxy import ProvisionResponse
from app.services import keys

router = APIRouter(prefix="/v1/secrets", tags=["secrets"])


@router.get(
    "/{name}",
    response_model=ProvisionResponse,
    response_model_by_alias=True,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse, "description": "device_revoked"},
        404: {
            "model": ErrorResponse,
            "description": "handler_not_found — no such handler, or this user has no key yet",
        },
        503: {"model": ErrorResponse},
    },
    summary="Fetch an existing secret without minting",
    description=(
        "Returns the caller's stored key. Answers 404 if they have never "
        "provisioned one — use `POST /v1/provision-keys/{name}` for that."
    ),
)
@limiter.limit(per_subject_limit)
async def fetch_secret(
    request: Request,
    name: str,
    identity: Annotated[Identity, Depends(current_identity)],
    device_id: Annotated[str, Depends(current_device)],
    client: Annotated[httpx.AsyncClient, Depends(get_http_client)],
) -> ProvisionResponse:
    if name != "litellm":
        raise HandlerNotFoundError(f"no fetch handler registered for '{name}'")

    stored = await keys.peek(identity)
    if stored is None:
        raise HandlerNotFoundError("this account has no provisioned key yet")

    logger.info(f"[Secrets] handler={name} subject={identity.subject} device={device_id}")
    return ProvisionResponse(
        api_key=stored.key,
        vendor_id="litellm",
        base_url=stored.base_url,
        models=stored.models,
        default_model=stored.default_model,
        status=stored.status,
        account=stored.account,
        key_alias=stored.key_alias,
        token=stored.token,
        created_at=stored.created_at,
        rotated_at=stored.rotated_at,
        meta={"username": identity.username, "userEmail": identity.user_email},
    )
