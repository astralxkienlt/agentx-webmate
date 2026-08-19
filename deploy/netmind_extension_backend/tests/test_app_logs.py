"""Structured client-log ingest."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.database import AsyncSessionLocal
from app.models.app_log import AppLog
from app.services.app_logs import month_bounds
from tests.conftest import INGEST_KEY, make_token

LOGS = "/api/logs"


def batch(**overrides) -> dict:
    body = {
        "run_id": str(uuid4()),
        "app_version": "32.1.0",
        "browser": "chrome/140",
        "logs": [
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "level": "ERROR",
                "module": "agent",
                "message": "click failed on selector",
                "fingerprint": "agent:click:timeout",
                "event": "tool_call",
                "phase": "failure",
                "code": "TIMEOUT",
                "count": 2,
                "context": {"selector": "#submit"},
            }
        ],
    }
    body.update(overrides)
    return body


async def _logs():
    async with AsyncSessionLocal() as session:
        return (await session.execute(select(AppLog))).scalars().all()


@pytest.mark.asyncio
async def test_batch_is_stored_with_the_token_identity(client):
    response = client.post(
        LOGS, headers={"Authorization": f"Bearer {make_token()}"}, json=batch()
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"accepted": 1, "identity_verified": True}

    rows = await _logs()
    assert rows[0].username == "kienlt"
    assert rows[0].level == 3  # ERROR
    assert rows[0].count == 2
    assert rows[0].context == {"selector": "#submit"}
    assert rows[0].identity_verified is True


@pytest.mark.asyncio
async def test_body_username_is_ignored_when_a_token_is_present(client):
    client.post(
        LOGS,
        headers={"Authorization": f"Bearer {make_token(preferred_username='kienlt')}"},
        json=batch(username="somebody-else"),
    )
    rows = await _logs()
    assert rows[0].username == "kienlt"


@pytest.mark.asyncio
async def test_shared_key_batch_is_flagged_unverified(client):
    response = client.post(
        LOGS, headers={"X-Auth-Key": INGEST_KEY}, json=batch(username="claimed")
    )
    assert response.json() == {"accepted": 1, "identity_verified": False}
    rows = await _logs()
    assert rows[0].username == "claimed"
    assert rows[0].identity_verified is False


def test_anonymous_batch_is_rejected(client):
    assert client.post(LOGS, json=batch(username="x")).status_code == 401


def test_empty_batch_is_a_success(client):
    """Any 2xx makes the client drop its buffer. An empty batch has nothing to
    keep and nothing to retry, so it is a success, not an error."""
    response = client.post(
        LOGS, headers={"Authorization": f"Bearer {make_token()}"}, json=batch(logs=[])
    )
    assert response.status_code == 200
    assert response.json()["accepted"] == 0


@pytest.mark.asyncio
async def test_unknown_level_falls_back_to_info(client):
    entry = batch()
    entry["logs"][0]["level"] = "TRACE"
    client.post(LOGS, headers={"Authorization": f"Bearer {make_token()}"}, json=entry)
    rows = await _logs()
    assert rows[0].level == 1


@pytest.mark.asyncio
async def test_device_header_is_recorded_when_present(client):
    dev = str(uuid4())
    client.post(
        LOGS,
        headers={"Authorization": f"Bearer {make_token()}", "X-AgentX-Device": dev.upper()},
        json=batch(),
    )
    rows = await _logs()
    assert rows[0].device_id == dev, "device id is lowercased"


@pytest.mark.asyncio
async def test_missing_device_header_is_tolerated(client):
    """Logs are worth keeping even from a client that forgot the header — this
    route is not a security boundary the way provisioning is."""
    response = client.post(
        LOGS, headers={"Authorization": f"Bearer {make_token()}"}, json=batch()
    )
    assert response.status_code == 200
    assert (await _logs())[0].device_id is None


def test_oversized_batch_is_rejected(client):
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "message": "x",
        "fingerprint": "f",
    }
    response = client.post(
        LOGS,
        headers={"Authorization": f"Bearer {make_token()}"},
        json=batch(logs=[entry] * 5001),
    )
    assert response.status_code == 422


def test_malformed_run_id_is_rejected(client):
    response = client.post(
        LOGS,
        headers={"Authorization": f"Bearer {make_token()}"},
        json=batch(run_id="not-a-uuid"),
    )
    assert response.status_code == 422


def test_entry_without_a_fingerprint_is_rejected(client):
    """The fingerprint is how errors are grouped; an ungrouped error is noise."""
    response = client.post(
        LOGS,
        headers={"Authorization": f"Bearer {make_token()}"},
        json=batch(logs=[{"ts": datetime.now(timezone.utc).isoformat(), "message": "x"}]),
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_multiple_entries_are_stored_in_one_batch(client):
    now = datetime.now(timezone.utc)
    entries = [
        {
            "ts": (now - timedelta(seconds=i)).isoformat(),
            "level": "WARN",
            "message": f"event {i}",
            "fingerprint": f"fp-{i}",
        }
        for i in range(25)
    ]
    response = client.post(
        LOGS, headers={"Authorization": f"Bearer {make_token()}"}, json=batch(logs=entries)
    )
    assert response.json()["accepted"] == 25
    assert len(await _logs()) == 25


# ── Partition naming (Postgres only, but the arithmetic is testable anywhere) ──

@pytest.mark.parametrize(
    "moment,expected",
    [
        (datetime(2026, 8, 19, 12, 0, tzinfo=timezone.utc), "app_logs_2026_08"),
        # 23:30 UTC on 31 Aug is 06:30 on 1 Sep in Vietnam — the September
        # partition. Bucketing by UTC would file it under August and an operator
        # dropping "August" would take a September day with it.
        (datetime(2026, 8, 31, 23, 30, tzinfo=timezone.utc), "app_logs_2026_09"),
        (datetime(2026, 12, 31, 20, 0, tzinfo=timezone.utc), "app_logs_2027_01"),
    ],
)
def test_partition_follows_the_vietnam_calendar_month(moment, expected):
    assert month_bounds(moment)[0] == expected


def test_partition_bounds_are_explicitly_utc_plus_seven():
    """Explicit +07 boundaries route correctly whatever the server session
    timezone happens to be."""
    _, start, end = month_bounds(datetime(2026, 8, 19, tzinfo=timezone.utc))
    assert start == "2026-08-01 00:00:00+07"
    assert end == "2026-09-01 00:00:00+07"
