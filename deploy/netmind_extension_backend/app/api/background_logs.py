"""Telemetry ingestion — `<base>/api/background-logs/*`.

Paths match the netMind Desktop backend so one nginx configuration and one
dashboard can serve both fleets.

`/user-telemetry` is the endpoint a client should actually use: one post per
tick carrying everything, instead of five requests that can half-succeed. The
single-metric routes below it exist for clients that only have one thing to say,
and for `curl` when diagnosing which metric is misbehaving.
"""
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.ingest import IngestAuth, IngestUnauthorizedError, ingest_auth
from app.core.database import get_db
from app.core.errors import ErrorResponse
from app.schemas.telemetry import (
    FeedbackIn,
    HealthCheckIn,
    LastActiveIn,
    TokenUsageIn,
    UserTelemetry,
)
from app.services import telemetry

router = APIRouter()

_RESPONSES: dict = {
    401: {
        "model": ErrorResponse,
        "description": "ingest_unauthorized | invalid_token",
    },
    503: {"model": ErrorResponse, "description": "identity_unavailable | ingest_unconfigured"},
}


def _require_username(auth: IngestAuth, declared: str | None) -> str:
    """Resolve who this post is about, or refuse it.

    A verified caller's username comes from the token. An unverified one must
    declare it — and a post that names nobody is unattributable, so it is
    rejected rather than filed under an empty string where it would quietly
    pollute every aggregate.
    """
    username = auth.username(declared)
    if not username:
        raise IngestUnauthorizedError(
            "username is required when posting without a verified token"
        )
    return username


@router.post(
    "/user-telemetry",
    responses=_RESPONSES,
    summary="One tick of a user's telemetry, batched",
    description=(
        "Send this every few minutes. Carries gateway health, today's cumulative "
        "token totals, per-tool counts, the hourly activity histogram and the "
        "session count; the request itself records presence.\n\n"
        "Daily figures are cumulative totals, not deltas, so a dropped post costs "
        "nothing — the next one carries the same running total.\n\n"
        "With a verified token the `username` field is ignored and taken from the "
        "token instead."
    ),
)
async def user_telemetry(
    payload: UserTelemetry,
    auth: Annotated[IngestAuth, Depends(ingest_auth)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    username = _require_username(auth, payload.username)
    usage_date = payload.usage_date or date.today()

    # The post itself is the heartbeat — there is no separate presence call that
    # could disagree with it.
    await telemetry.touch_last_active(db, username, payload.app_version, payload.browser)

    if payload.health_result:
        await telemetry.record_health(db, username, payload.health_result, auth.verified)

    if payload.token_usage is not None:
        await telemetry.upsert_token_usage(
            db, username, usage_date, payload.token_usage, auth.verified
        )

    tools_written = await telemetry.upsert_tools(
        db, username, usage_date, payload.tools, auth.verified
    )
    hours_written = await telemetry.upsert_activity(
        db, username, usage_date, payload.activity_by_hour, auth.verified
    )
    if payload.new_sessions:
        await telemetry.upsert_sessions(
            db, username, usage_date, payload.new_sessions, auth.verified
        )

    await telemetry.upsert_user(db, username, auth, payload)
    await db.commit()
    return {
        "ok": True,
        "identity_verified": auth.verified,
        "tools_written": tools_written,
        "hours_written": hours_written,
    }


@router.post(
    "/health-check",
    responses=_RESPONSES,
    summary="Report gateway reachability",
)
async def health_check(
    payload: HealthCheckIn,
    auth: Annotated[IngestAuth, Depends(ingest_auth)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    username = _require_username(auth, payload.username)
    await telemetry.record_health(db, username, payload.health_result, auth.verified)
    await telemetry.touch_last_active(db, username)
    await telemetry.upsert_user(db, username, auth, payload)
    await db.commit()
    return {"ok": True, "identity_verified": auth.verified}


@router.post(
    "/last-active",
    responses=_RESPONSES,
    summary="Presence heartbeat",
)
async def last_active(
    payload: LastActiveIn,
    auth: Annotated[IngestAuth, Depends(ingest_auth)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    username = _require_username(auth, payload.username)
    await telemetry.touch_last_active(db, username, payload.app_version, payload.browser)
    await telemetry.upsert_user(db, username, auth, payload)
    await db.commit()
    return {"ok": True, "identity_verified": auth.verified}


@router.post(
    "/token-usage",
    responses=_RESPONSES,
    summary="Report today's cumulative token totals",
)
async def token_usage(
    payload: TokenUsageIn,
    auth: Annotated[IngestAuth, Depends(ingest_auth)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    username = _require_username(auth, payload.username)
    await telemetry.upsert_token_usage(
        db, username, payload.usage_date or date.today(), payload, auth.verified
    )
    await telemetry.touch_last_active(db, username)
    await telemetry.upsert_user(db, username, auth, payload)
    await db.commit()
    return {"ok": True, "identity_verified": auth.verified}


@router.post(
    "/feedback",
    responses=_RESPONSES,
    summary="Submit user feedback",
)
async def feedback(
    payload: FeedbackIn,
    auth: Annotated[IngestAuth, Depends(ingest_auth)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    username = _require_username(auth, payload.username)
    row = await telemetry.record_feedback(db, username, payload, auth.verified)
    await telemetry.upsert_user(db, username, auth, payload)
    await db.commit()
    return {"ok": True, "id": row.id, "identity_verified": auth.verified}
