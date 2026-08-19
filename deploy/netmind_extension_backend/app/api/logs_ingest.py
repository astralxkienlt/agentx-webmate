"""Structured client logs — `POST <base>/api/logs`.

Same path as the netMind Desktop backend. The client batches error/warn records
and funnel step-events and posts them periodically; any 2xx makes it drop the
batch, so this route must not answer 2xx for work it did not do.
"""
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.ingest import IngestAuth, IngestUnauthorizedError, ingest_auth
from app.core.database import get_db
from app.core.errors import ErrorResponse
from app.schemas.telemetry import AppLogBatch
from app.services import app_logs

router = APIRouter()


@router.post(
    "",
    responses={
        401: {"model": ErrorResponse, "description": "ingest_unauthorized | invalid_token"},
        503: {"model": ErrorResponse, "description": "identity_unavailable | ingest_unconfigured"},
    },
    summary="Ingest a batch of client logs",
    description=(
        "Accepts up to 5000 events under one identity envelope and returns how "
        "many were stored. An empty batch is a success — there is nothing to keep "
        "and nothing for the client to retry.\n\n"
        "With a verified token the envelope's `username` is ignored in favour of "
        "the token's."
    ),
)
async def ingest_logs(
    payload: AppLogBatch,
    auth: Annotated[IngestAuth, Depends(ingest_auth)],
    db: Annotated[AsyncSession, Depends(get_db)],
    x_agentx_device: Annotated[str | None, Header()] = None,
) -> dict:
    username = auth.username(payload.username)
    if not username:
        raise IngestUnauthorizedError(
            "username is required when posting without a verified token"
        )

    device_id = (x_agentx_device or "").strip().lower() or None
    accepted = await app_logs.ingest(db, payload, username, device_id, auth.verified)
    await db.commit()
    return {"accepted": accepted, "identity_verified": auth.verified}
