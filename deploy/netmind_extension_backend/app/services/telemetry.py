"""Telemetry writes.

Daily aggregates are upserted on their natural key, and the newest post wins.
The client re-reports the running total for the day on every tick, so a dropped
request costs nothing: the next one carries the same cumulative figure. That is
why these are `SET` and not `+=` — adding would double-count every retry.

`identity_verified` rides along on every row so a future dashboard can tell what
a token asserted from what a client typed.
"""
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.ingest import IngestAuth
from app.core.database import engine
from app.models.identity import User
from app.models.telemetry import (
    ActivityHourly,
    DailySession,
    Feedback,
    HealthCheck,
    LastActive,
    TokenUsage,
    ToolUsage,
)


def _insert():
    return pg_insert if engine.dialect.name == "postgresql" else sqlite_insert


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def upsert_user(
    db: AsyncSession, username: str, auth: IngestAuth, enrichment=None
) -> None:
    """Insert or update the profile row.

    A stored field is only overwritten when the incoming post actually carries a
    value, so a later anonymous post cannot blank out a name and department that
    a verified one established.

    `identity_verified` is likewise sticky: once a real token has been seen for
    this user it stays true, because a subsequent unverified post does not
    un-prove what was already proven.
    """
    if not username:
        return

    identity = auth.identity
    email = getattr(enrichment, "email", None)
    full_name = getattr(enrichment, "full_name", None)
    department = getattr(enrichment, "department", None)
    if identity is not None:
        email = identity.email or email
        full_name = identity.display_name or full_name

    existing = (
        await db.execute(select(User).where(User.username == username))
    ).scalar_one_or_none()

    if existing is None:
        db.add(
            User(
                username=username,
                subject=auth.subject,
                email=email,
                full_name=full_name,
                department=department,
                identity_verified=auth.verified,
                first_seen_at=_now(),
                updated_at=_now(),
            )
        )
        return

    if auth.subject:
        existing.subject = auth.subject
    if email:
        existing.email = email
    if full_name:
        existing.full_name = full_name
    if department:
        existing.department = department
    if auth.verified:
        existing.identity_verified = True
    existing.updated_at = _now()


async def record_health(
    db: AsyncSession, username: str, health_result: str, verified: bool
) -> None:
    db.add(
        HealthCheck(
            username=username,
            health_result=health_result,
            identity_verified=verified,
            created_at=_now(),
        )
    )


async def touch_last_active(
    db: AsyncSession,
    username: str,
    app_version: str | None = None,
    browser: str | None = None,
) -> None:
    values = {"username": username, "last_active_at": _now()}
    if app_version:
        values["app_version"] = app_version
    if browser:
        values["browser"] = browser
    stmt = _insert()(LastActive).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=[LastActive.username],
        set_={k: stmt.excluded[k] for k in values if k != "username"},
    )
    await db.execute(stmt)


async def upsert_token_usage(
    db: AsyncSession,
    username: str,
    usage_date: date,
    totals,
    verified: bool,
) -> None:
    values = {
        "username": username,
        "usage_date": usage_date,
        "input_tokens": totals.input_tokens,
        "output_tokens": totals.output_tokens,
        "total_tokens": totals.total_tokens,
        "cost_usd": totals.cost_usd,
        "identity_verified": verified,
        "received_at": _now(),
    }
    stmt = _insert()(TokenUsage).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=[TokenUsage.username, TokenUsage.usage_date],
        set_={k: stmt.excluded[k] for k in values if k not in ("username", "usage_date")},
    )
    await db.execute(stmt)


async def upsert_tools(
    db: AsyncSession, username: str, usage_date: date, tools: list, verified: bool
) -> int:
    """Write per-tool counts. Returns how many rows were written.

    Duplicate tool names within one batch are collapsed to the last occurrence:
    Postgres refuses an `ON CONFLICT` statement that touches the same key twice
    in a single command, so de-duplicating here is what keeps a sloppy client
    from failing the whole request.
    """
    if not tools:
        return 0
    latest = {t.tool: t for t in tools if t.tool}
    if not latest:
        return 0

    rows = [
        {
            "username": username,
            "usage_date": usage_date,
            "tool": tool,
            "invoke_count": t.invoke_count,
            "error_count": t.error_count,
            "identity_verified": verified,
            "received_at": _now(),
        }
        for tool, t in latest.items()
    ]
    stmt = _insert()(ToolUsage).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=[ToolUsage.username, ToolUsage.usage_date, ToolUsage.tool],
        set_={
            "invoke_count": stmt.excluded.invoke_count,
            "error_count": stmt.excluded.error_count,
            "identity_verified": stmt.excluded.identity_verified,
            "received_at": stmt.excluded.received_at,
        },
    )
    await db.execute(stmt)
    return len(rows)


async def upsert_activity(
    db: AsyncSession, username: str, usage_date: date, by_hour: list[int], verified: bool
) -> int:
    """Store the 24-slot hourly histogram, skipping empty hours.

    Only non-zero hours are written: a mostly-idle day would otherwise cost 24
    rows per user per day to record almost nothing.
    """
    rows = [
        {
            "username": username,
            "usage_date": usage_date,
            "hour": hour,
            "count": count,
            "identity_verified": verified,
            "received_at": _now(),
        }
        for hour, count in enumerate(by_hour[:24])
        if isinstance(count, int) and count > 0
    ]
    if not rows:
        return 0
    stmt = _insert()(ActivityHourly).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=[ActivityHourly.username, ActivityHourly.usage_date, ActivityHourly.hour],
        set_={
            "count": stmt.excluded.count,
            "identity_verified": stmt.excluded.identity_verified,
            "received_at": stmt.excluded.received_at,
        },
    )
    await db.execute(stmt)
    return len(rows)


async def upsert_sessions(
    db: AsyncSession, username: str, usage_date: date, new_sessions: int, verified: bool
) -> None:
    values = {
        "username": username,
        "usage_date": usage_date,
        "new_sessions": new_sessions,
        "identity_verified": verified,
        "received_at": _now(),
    }
    stmt = _insert()(DailySession).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=[DailySession.username, DailySession.usage_date],
        set_={k: stmt.excluded[k] for k in values if k not in ("username", "usage_date")},
    )
    await db.execute(stmt)


async def record_feedback(
    db: AsyncSession, username: str, payload, verified: bool
) -> Feedback:
    row = Feedback(
        username=username,
        rating=payload.rating,
        category=payload.category,
        message=payload.message,
        app_version=payload.app_version,
        identity_verified=verified,
        created_at=_now(),
    )
    db.add(row)
    await db.flush()
    return row
