"""Telemetry ingestion, and above all its two ways in.

The rule under test throughout: a verified caller's username comes from the
token and the body cannot override it; an unverified caller's comes from the
body and every row it writes says so.
"""
import httpx
import pytest
from sqlalchemy import select

from app.core.database import AsyncSessionLocal
from app.models.identity import User
from app.models.telemetry import ActivityHourly, HealthCheck, TokenUsage, ToolUsage
from tests.conftest import INGEST_KEY, make_token

TELEMETRY = "/api/background-logs/user-telemetry"


def token_headers(token: str | None = None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token or make_token()}"}


def key_headers() -> dict[str, str]:
    return {"X-Auth-Key": INGEST_KEY}


async def _rows(model):
    async with AsyncSessionLocal() as session:
        return (await session.execute(select(model))).scalars().all()


# ── Authentication ───────────────────────────────────────────────────────────

def test_no_credentials_is_rejected(client):
    response = client.post(TELEMETRY, json={"username": "someone"})
    assert response.status_code == 401
    assert response.json()["error"] == "ingest_unauthorized"


def test_wrong_shared_key_is_rejected(client):
    response = client.post(
        TELEMETRY, headers={"X-Auth-Key": "wrong"}, json={"username": "someone"}
    )
    assert response.status_code == 401


def test_valid_token_is_accepted_and_marked_verified(client):
    response = client.post(TELEMETRY, headers=token_headers(), json={})
    assert response.status_code == 200, response.text
    assert response.json()["identity_verified"] is True


def test_shared_key_is_accepted_and_marked_unverified(client):
    response = client.post(TELEMETRY, headers=key_headers(), json={"username": "someone"})
    assert response.status_code == 200
    assert response.json()["identity_verified"] is False


def test_expired_token_is_rejected_not_downgraded(client):
    """A presented-but-invalid token is an error, not a quiet fallback.

    Downgrading it would hide a broken client and silently file its data as
    anonymous.
    """
    response = client.post(
        TELEMETRY,
        headers={**token_headers(make_token(expires_in=-100)), **key_headers()},
        json={"username": "someone"},
    )
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_verification_is_local_so_an_sso_outage_does_not_stop_ingest(client, gateway):
    """A real benefit of symmetric verification, worth pinning down.

    HS256 is checked against a secret this service already holds, so nothing is
    fetched from the SSO wrapper at request time. An unreachable wrapper cannot
    make an already-issued token unverifiable — telemetry keeps flowing, still
    marked verified, for as long as tokens remain unexpired.

    The unreachable-issuer fallback still matters on an asymmetric deployment;
    it is covered in tests/auth/test_jwks_asymmetric.py.
    """
    gateway.jwks_error = httpx.ConnectError("sso wrapper down")
    response = client.post(TELEMETRY, headers=token_headers(), json={})
    assert response.status_code == 200
    assert response.json()["identity_verified"] is True
    assert gateway.jwks_calls == 0, "symmetric verification must not call out"


# ── Identity cannot be spoofed ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_body_username_is_ignored_when_a_token_is_present(client):
    """The single most important behaviour in this file.

    A verified caller reports as themselves whatever the body claims. Without
    this, anyone who can sign in could attribute their usage — or their errors —
    to a colleague.
    """
    response = client.post(
        TELEMETRY,
        headers=token_headers(make_token(preferred_username="kienlt")),
        json={"username": "someone-else", "health_result": "OK"},
    )
    assert response.status_code == 200

    rows = await _rows(HealthCheck)
    assert [r.username for r in rows] == ["kienlt"]
    assert rows[0].identity_verified is True


@pytest.mark.asyncio
async def test_shared_key_caller_is_taken_at_its_word_but_flagged(client):
    client.post(
        TELEMETRY,
        headers=key_headers(),
        json={"username": "claimed-name", "health_result": "OK"},
    )
    rows = await _rows(HealthCheck)
    assert [r.username for r in rows] == ["claimed-name"]
    assert rows[0].identity_verified is False


def test_shared_key_post_without_a_username_is_refused(client):
    """An unattributable row would quietly pollute every aggregate, so refuse it
    rather than file it under the empty string."""
    response = client.post(TELEMETRY, headers=key_headers(), json={"health_result": "OK"})
    assert response.status_code == 401
    assert response.json()["error"] == "ingest_unauthorized"


@pytest.mark.asyncio
async def test_verification_is_sticky_on_the_user_row(client):
    """Once a real token has been seen for a user, a later anonymous post does
    not un-prove it."""
    client.post(TELEMETRY, headers=token_headers(), json={})
    client.post(TELEMETRY, headers=key_headers(), json={"username": "kienlt"})

    async with AsyncSessionLocal() as session:
        user = (
            await session.execute(select(User).where(User.username == "kienlt"))
        ).scalar_one()
    assert user.identity_verified is True
    assert user.subject == "user-abc-123"


@pytest.mark.asyncio
async def test_anonymous_post_does_not_blank_a_known_profile(client):
    """A later post carrying no email must not erase one a verified post set."""
    client.post(TELEMETRY, headers=token_headers(), json={})
    client.post(TELEMETRY, headers=key_headers(), json={"username": "kienlt"})

    async with AsyncSessionLocal() as session:
        user = (
            await session.execute(select(User).where(User.username == "kienlt"))
        ).scalar_one()
    assert user.email == "kien@example.test"


# ── Payload handling ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_batched_telemetry_fans_out_to_every_table(client):
    response = client.post(
        TELEMETRY,
        headers=token_headers(),
        json={
            "usage_date": "2026-08-19",
            "health_result": "OK",
            "token_usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
                "cost_usd": 0.25,
            },
            "tools": [
                {"tool": "click", "invoke_count": 5, "error_count": 1},
                {"tool": "navigate", "invoke_count": 3, "error_count": 0},
            ],
            "activity_by_hour": [0] * 9 + [7] + [0] * 14,
            "new_sessions": 2,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["tools_written"] == 2
    assert body["hours_written"] == 1, "only non-zero hours are stored"

    usage = (await _rows(TokenUsage))[0]
    assert usage.total_tokens == 150
    assert float(usage.cost_usd) == 0.25

    hours = await _rows(ActivityHourly)
    assert [(h.hour, h.count) for h in hours] == [(9, 7)]


@pytest.mark.asyncio
async def test_daily_totals_are_replaced_not_accumulated(client):
    """The client reports a running total, so a retry must not double-count."""
    for total in (100, 250):
        client.post(
            TELEMETRY,
            headers=token_headers(),
            json={
                "usage_date": "2026-08-19",
                "token_usage": {"total_tokens": total, "cost_usd": 1.0},
            },
        )
    rows = await _rows(TokenUsage)
    assert len(rows) == 1
    assert rows[0].total_tokens == 250


@pytest.mark.asyncio
async def test_repeated_tool_names_in_one_batch_do_not_break_the_write(client):
    """Postgres refuses an ON CONFLICT touching one key twice in a command, so a
    sloppy client must be de-duplicated rather than allowed to fail the batch."""
    response = client.post(
        TELEMETRY,
        headers=token_headers(),
        json={
            "usage_date": "2026-08-19",
            "tools": [
                {"tool": "click", "invoke_count": 1},
                {"tool": "click", "invoke_count": 9},
            ],
        },
    )
    assert response.status_code == 200
    rows = await _rows(ToolUsage)
    assert len(rows) == 1
    assert rows[0].invoke_count == 9, "last value for a repeated tool wins"


def test_unknown_fields_are_ignored_not_rejected(client):
    """A newer client must not be broken by an older server."""
    response = client.post(
        TELEMETRY,
        headers=token_headers(),
        json={"health_result": "OK", "some_future_field": {"nested": True}},
    )
    assert response.status_code == 200


def test_oversized_tool_list_is_rejected(client):
    response = client.post(
        TELEMETRY,
        headers=token_headers(),
        json={"tools": [{"tool": f"t{i}"} for i in range(600)]},
    )
    assert response.status_code == 422


def test_negative_token_counts_are_rejected(client):
    response = client.post(
        TELEMETRY, headers=token_headers(), json={"token_usage": {"total_tokens": -5}}
    )
    assert response.status_code == 422


# ── The single-metric routes ─────────────────────────────────────────────────

@pytest.mark.parametrize(
    "path,payload",
    [
        ("/api/background-logs/health-check", {"health_result": "OK"}),
        ("/api/background-logs/last-active", {}),
        ("/api/background-logs/token-usage", {"total_tokens": 10}),
        ("/api/background-logs/feedback", {"message": "works well"}),
    ],
)
def test_single_metric_routes_accept_a_token(client, path, payload):
    response = client.post(path, headers=token_headers(), json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["identity_verified"] is True


@pytest.mark.parametrize(
    "path,payload",
    [
        ("/api/background-logs/health-check", {"health_result": "OK"}),
        ("/api/background-logs/last-active", {}),
        ("/api/background-logs/token-usage", {"total_tokens": 10}),
        ("/api/background-logs/feedback", {"message": "works well"}),
    ],
)
def test_single_metric_routes_reject_anonymous_callers(client, path, payload):
    assert client.post(path, json=payload).status_code == 401


def test_feedback_requires_a_message(client):
    response = client.post(
        "/api/background-logs/feedback", headers=token_headers(), json={"message": ""}
    )
    assert response.status_code == 422
