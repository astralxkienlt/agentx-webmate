"""Behaviour that only exists on Postgres.

Skipped on sqlite, which has no partitioning, no advisory locks and different
`ON CONFLICT` semantics. Run with:

    DATABASE_URL=postgresql+asyncpg://postgres:test@localhost:5432/db pytest

These are the tests that caught the real bug: the locked re-read on the mint
path used to hand back the very key the gateway had just rejected, because
sqlite skips the lock and never exercised that branch.
"""
import asyncio
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from sqlalchemy import select, text

from app.auth.models import Identity
from app.core.config import get_settings
from app.core.database import AsyncSessionLocal
from app.models.telemetry import ToolUsage
from app.services import keys
from tests.conftest import make_token

pytestmark = pytest.mark.skipif(
    get_settings().is_sqlite, reason="requires Postgres"
)


async def _table_exists(name: str) -> bool:
    async with AsyncSessionLocal() as session:
        return bool(
            await session.scalar(text("SELECT to_regclass(:n)"), {"n": f"public.{name}"})
        )


# ── Partitioning ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_app_logs_parent_is_actually_partitioned(client):
    """`create_all` would build an ordinary table; the raw DDL must win.

    If this regresses, retention silently stops being a DROP and becomes a table
    scan nobody notices until the disk fills.
    """
    async with AsyncSessionLocal() as session:
        relkind = await session.scalar(
            text(
                "SELECT c.relkind FROM pg_class c "
                "WHERE c.relname = 'app_logs' AND c.relnamespace = 'public'::regnamespace"
            )
        )
    # asyncpg returns "char" columns as bytes; normalise before comparing.
    kind = relkind.decode() if isinstance(relkind, bytes) else relkind
    assert kind == "p", "expected a partitioned table, got relkind={kind!r}".format(kind=kind)


@pytest.mark.asyncio
async def test_month_partition_is_created_on_demand(client):
    """The first log of a month creates that month's partition."""
    assert not await _table_exists("app_logs_2026_03")

    response = client.post(
        "/api/logs",
        headers={"Authorization": f"Bearer {make_token()}"},
        json={
            "run_id": str(uuid4()),
            "logs": [
                {
                    "ts": datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc).isoformat(),
                    "message": "hello",
                    "fingerprint": "fp-1",
                }
            ],
        },
    )
    assert response.status_code == 200
    assert response.json()["accepted"] == 1
    assert await _table_exists("app_logs_2026_03")


@pytest.mark.asyncio
async def test_one_batch_spanning_two_months_creates_both(client):
    body = {
        "run_id": str(uuid4()),
        "logs": [
            {
                "ts": datetime(2026, 4, 20, tzinfo=timezone.utc).isoformat(),
                "message": "april",
                "fingerprint": "fp-a",
            },
            {
                "ts": datetime(2026, 5, 2, tzinfo=timezone.utc).isoformat(),
                "message": "may",
                "fingerprint": "fp-b",
            },
        ],
    }
    response = client.post(
        "/api/logs", headers={"Authorization": f"Bearer {make_token()}"}, json=body
    )
    assert response.json()["accepted"] == 2
    assert await _table_exists("app_logs_2026_04")
    assert await _table_exists("app_logs_2026_05")


@pytest.mark.asyncio
async def test_rows_land_in_the_right_month_partition(client):
    """A UTC instant that is already next month in Vietnam belongs to next month."""
    client.post(
        "/api/logs",
        headers={"Authorization": f"Bearer {make_token()}"},
        json={
            "run_id": str(uuid4()),
            "logs": [
                {
                    # 23:30 UTC on 30 June is 06:30 on 1 July in Vietnam.
                    "ts": datetime(2026, 6, 30, 23, 30, tzinfo=timezone.utc).isoformat(),
                    "message": "boundary",
                    "fingerprint": "fp-boundary",
                }
            ],
        },
    )
    async with AsyncSessionLocal() as session:
        in_july = await session.scalar(text("SELECT count(*) FROM app_logs_2026_07"))
    assert in_july == 1


# ── Advisory lock ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_concurrent_first_provision_mints_exactly_once(app, gateway, fake_http):
    """Two browsers signing in at the same instant must not both mint.

    This is what the per-subject advisory lock buys. Without it each request
    reads "no key", both mint, and one of the two keys is orphaned at the gateway
    while the losing browser holds a key the database does not know about.
    """
    identity = Identity.from_claims(
        {"sub": "race-subject", "preferred_username": "racer", "email": "racer@corp.test"}
    )

    results = await asyncio.gather(
        *(keys.get_or_mint(identity, fake_http) for _ in range(5))
    )

    assert gateway.generate_calls == 1, "the lock must serialise the mint"
    assert len({r.key for r in results}) == 1, "everyone gets the same key"
    assert sum(1 for r in results if r.status == keys.STATUS_ISSUED) == 1
    assert sum(1 for r in results if r.status == keys.STATUS_REUSED) == 4


@pytest.mark.asyncio
async def test_dead_key_under_the_lock_is_replaced_not_reserved(app, gateway, fake_http):
    """Direct regression test for the bug Postgres exposed.

    The locked re-read finds the same row we already proved dead. It must
    recognise it as the corpse and mint, not hand it back as `reused`.
    """
    identity = Identity.from_claims(
        {"sub": "dead-key-subject", "preferred_username": "ghost", "email": "g@corp.test"}
    )
    first = await keys.get_or_mint(identity, fake_http)
    assert first.status == keys.STATUS_ISSUED

    gateway.key_info_status = 404  # the gateway now disowns that key
    second = await keys.get_or_mint(identity, fake_http)

    assert second.status == keys.STATUS_ISSUED, "a proven-dead key must be replaced"
    assert second.key != first.key
    assert gateway.generate_calls == 2


@pytest.mark.asyncio
async def test_a_racing_replacement_is_reused_rather_than_re_minted(app, gateway, fake_http):
    """The other half of the same branch.

    If somebody else already replaced the dead key while we waited on the lock,
    take theirs — minting again would start the ping-pong the design exists to
    prevent.
    """
    identity = Identity.from_claims(
        {"sub": "racing-subject", "preferred_username": "racer2", "email": "r2@corp.test"}
    )
    await keys.get_or_mint(identity, fake_http)
    gateway.key_info_status = 404

    results = await asyncio.gather(
        *(keys.get_or_mint(identity, fake_http) for _ in range(4))
    )
    assert gateway.generate_calls == 2, "one original mint plus exactly one replacement"
    assert len({r.key for r in results}) == 1


# ── ON CONFLICT ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_multi_row_upsert_on_composite_key(client):
    """Postgres refuses an ON CONFLICT command touching one key twice, so the
    de-duplication in `upsert_tools` is load-bearing here in a way sqlite never
    reveals."""
    for counts in ((3, 0), (11, 2)):
        response = client.post(
            "/api/background-logs/user-telemetry",
            headers={"Authorization": f"Bearer {make_token()}"},
            json={
                "usage_date": "2026-08-19",
                "tools": [
                    {"tool": "click", "invoke_count": counts[0], "error_count": counts[1]},
                    {"tool": "click", "invoke_count": counts[0], "error_count": counts[1]},
                    {"tool": "navigate", "invoke_count": 1},
                ],
            },
        )
        assert response.status_code == 200, response.text

    async with AsyncSessionLocal() as session:
        rows = (
            await session.execute(select(ToolUsage).order_by(ToolUsage.tool))
        ).scalars().all()
    assert [(r.tool, r.invoke_count, r.error_count) for r in rows] == [
        ("click", 11, 2),
        ("navigate", 1, 0),
    ]


@pytest.mark.asyncio
async def test_device_upsert_never_resurrects_a_revoked_row(client):
    """The `on_conflict` set clause must not touch `revoked_at`.

    A revoked install calls again on its next tick; if the upsert cleared the
    tombstone, revocation would last exactly one request.
    """
    from app.core.errors import DeviceRevokedError
    from app.services import devices

    subject, device = "tombstone-subject", str(uuid4())
    await devices.register(subject, device, "laptop")
    await devices.revoke(subject, device)

    for _ in range(3):
        with pytest.raises(DeviceRevokedError):
            await devices.register(subject, device, "laptop")

    row = await devices.get(subject, device)
    assert row.revoked_at is not None
