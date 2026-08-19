"""Device management: list, heartbeat, revoke.

Revocation is where the sharp edges are. Read the comments on the DELETE route
before changing anything there — each one is a rule from the integration spec
that a plausible-looking simplification would break.
"""
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Query
from loguru import logger

from app.auth.deps import current_device, current_identity, get_http_client, sanitize_device_name
from app.auth.models import Identity
from app.core.errors import CannotRevokeLastDeviceError, ErrorResponse
from app.schemas.proxy import DeviceHeartbeat, MeResponse
from app.services import devices, keys

router = APIRouter(prefix="/v1", tags=["devices"])


@router.get(
    "/me",
    response_model=MeResponse,
    response_model_by_alias=True,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse, "description": "device_revoked"},
        503: {"model": ErrorResponse},
    },
    summary="Who am I, and is this device still allowed",
    description=(
        "A cheap probe. Verifies the token, registers the device and reports "
        "whether this account already holds a key — enough for a client to decide "
        "whether it needs to provision, without asking for a key it may not need."
    ),
)
async def me(
    identity: Annotated[Identity, Depends(current_identity)],
    device_id: Annotated[str, Depends(current_device)],
) -> MeResponse:
    stored = await keys.peek(identity)
    return MeResponse(
        subject=identity.subject,
        username=identity.username,
        email=identity.email,
        display_name=identity.display_name,
        account=identity.account_slug,
        device=device_id,
        has_key=stored is not None,
    )


@router.get(
    "/devices",
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
    summary="Every install this account has signed in from",
)
async def list_devices(
    identity: Annotated[Identity, Depends(current_identity)],
    device_id: Annotated[str, Depends(current_device)],
) -> dict:
    rows = await devices.list_for(identity.subject)
    return {
        "devices": [devices.to_dict(d, device_id) for d in rows],
        "current": device_id,
    }


@router.post(
    "/devices/heartbeat",
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
    summary="Report platform and app version for this install",
    description=(
        "Presence is already recorded by any authenticated call; this route exists "
        "so a client can additionally declare what it is and which version it runs."
    ),
)
async def heartbeat(
    identity: Annotated[Identity, Depends(current_identity)],
    device_id: Annotated[str, Depends(current_device)],
    body: DeviceHeartbeat | None = None,
) -> dict:
    body = body or DeviceHeartbeat()
    device = await devices.register(
        identity.subject,
        device_id,
        sanitize_device_name(body.name),
        platform=body.platform,
        app_version=body.app_version,
    )
    return {"device": devices.to_dict(device, device_id)}


@router.delete(
    "/devices/{target_id}",
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse, "description": "device_revoked (the *calling* device)"},
        404: {
            "model": ErrorResponse,
            "description": "device_not_found — unknown id, or it belongs to somebody else",
        },
        409: {"model": ErrorResponse, "description": "cannot_revoke_last_device"},
    },
    summary="Revoke one install, optionally cutting model access with it",
    description=(
        "Revocation is a tombstone: the revoked install keeps receiving 403 rather "
        "than silently re-registering as new.\n\n"
        "`rotate_key=true` additionally mints a fresh model key, which is what "
        "actually cuts the revoked machine off — one key per person means "
        "revocation alone does not. Check `key_rotation` in the response before "
        "telling anyone their access was cut."
    ),
)
async def revoke_device(
    identity: Annotated[Identity, Depends(current_identity)],
    device_id: Annotated[str, Depends(current_device)],
    client: Annotated[httpx.AsyncClient, Depends(get_http_client)],
    target_id: str,
    rotate_key: Annotated[bool, Query(description="Also rotate this account's model key")] = False,
) -> dict:
    target = target_id.strip().lower()

    # Raises device_not_found for an id belonging to somebody else — a 403 would
    # confirm the id exists, which is not this endpoint's business to reveal.
    await devices.get(identity.subject, target)

    # Rotating while revoking the last install strands the new key: there would
    # be no machine left to collect it. Checked in the service rather than by
    # hiding a button, because any client can call this API.
    if rotate_key and await devices.count_active(identity.subject) <= 1:
        raise CannotRevokeLastDeviceError(
            "rotating the key while revoking your only device would leave no "
            "device able to collect the new key; sign in elsewhere first"
        )

    device = await devices.revoke(identity.subject, target)
    logger.info(f"[Devices] revoked subject={identity.subject} device={target}")

    # The rotation is attempted after the revocation and never undoes it. If it
    # fails, `key_rotation` says so — reporting "access cut" when it was not is
    # worse than reporting nothing.
    rotation = "not_requested"
    if rotate_key:
        rotation = await keys.rotate_for_subject(identity, client)
        logger.info(f"[Devices] key rotation for subject={identity.subject}: {rotation}")

    return {
        "device": devices.to_dict(device, device_id),
        "key_rotated": rotation == "rotated",
        "key_rotation": rotation,
    }
