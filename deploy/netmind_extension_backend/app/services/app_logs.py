"""App-log ingest — bulk insert into the monthly-partitioned `app_logs` table.

Month partitions are created on demand at ingest, so no cron job or pg_partman
is needed at low-to-medium volume. If ingest ever gets hot, move partition
maintenance out to a scheduler; the DDL below is idempotent either way.

Partitions follow the **Vietnam calendar month** (UTC+7, no DST), so a month of
logs is the month an operator means when they say it. Postgres stores and
compares the instant, so explicit `+07` boundaries route correctly whatever the
server session timezone happens to be.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import insert, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.app_log import AppLog
from app.schemas.telemetry import AppLogBatch, AppLogEntry

_LEVEL = {"INFO": 1, "WARN": 2, "WARNING": 2, "ERROR": 3}
_TZ = timezone(timedelta(hours=7))


def month_bounds(ts: datetime) -> tuple[str, str, str]:
    """(partition_name, start, end) for the UTC+7 month containing `ts`."""
    local = ts.astimezone(_TZ) if ts.tzinfo else ts.replace(tzinfo=_TZ)
    y, m = local.year, local.month
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    return (
        f"app_logs_{y:04d}_{m:02d}",
        f"{y:04d}-{m:02d}-01 00:00:00+07",
        f"{ny:04d}-{nm:02d}-01 00:00:00+07",
    )


async def ensure_partitions(db: AsyncSession, entries: list[AppLogEntry]) -> None:
    seen: set[str] = set()
    for entry in entries:
        name, start, end = month_bounds(entry.ts)
        if name in seen:
            continue
        seen.add(name)
        # Every component is derived from integers, never from client text, so
        # there is nothing here to inject through.
        await db.execute(
            text(
                f"CREATE TABLE IF NOT EXISTS {name} PARTITION OF app_logs "
                f"FOR VALUES FROM ('{start}') TO ('{end}')"
            )
        )


async def ingest(
    db: AsyncSession,
    batch: AppLogBatch,
    username: str,
    device_id: str | None,
    verified: bool,
) -> int:
    """Store a batch. Returns the row count.

    Any 2xx makes the client drop its buffer, so an empty batch is a success
    rather than an error — there is nothing to keep and nothing to retry.
    """
    if not batch.logs:
        return 0

    if not get_settings().is_sqlite:
        await ensure_partitions(db, batch.logs)

    rows = [
        {
            "run_id": batch.run_id,
            "username": username,
            "device_id": device_id,
            "ts": entry.ts,
            "level": _LEVEL.get(entry.level.upper(), 1),
            "module": entry.module,
            "event": entry.event,
            "phase": entry.phase,
            "code": entry.code,
            "fingerprint": entry.fingerprint,
            "message": entry.message,
            "count": entry.count,
            "app_version": batch.app_version,
            "browser": batch.browser,
            "identity_verified": verified,
            "context": entry.context,
        }
        for entry in batch.logs
    ]
    await db.execute(insert(AppLog).values(rows))
    return len(rows)
