"""Telemetry payloads.

Every list and string is bounded. These arrive from a browser extension, which
is a trust boundary no matter how friendly the client: an unbounded `logs` array
is a memory-exhaustion request wearing a JSON hat.

`extra="ignore"` throughout, so a newer client can add a field without every
older server rejecting its posts.
"""
from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ClientIdentity(BaseModel):
    """Profile enrichment a client may attach.

    All optional, and all ignored in favour of the token when one is present.
    A client that has signed in should send nothing here.
    """

    model_config = ConfigDict(extra="ignore")

    email: str | None = Field(None, max_length=320)
    full_name: str | None = Field(None, max_length=256)
    department: str | None = Field(None, max_length=256)


class TokenTotals(BaseModel):
    """Today's cumulative token spend. Cumulative, not a delta — a missed tick
    then costs nothing, because the next post carries the running total."""

    model_config = ConfigDict(extra="ignore")

    input_tokens: int = Field(0, ge=0, le=10_000_000_000)
    output_tokens: int = Field(0, ge=0, le=10_000_000_000)
    total_tokens: int = Field(0, ge=0, le=10_000_000_000)
    cost_usd: float = Field(0, ge=0, le=1_000_000)


class ToolInvoke(BaseModel):
    model_config = ConfigDict(extra="ignore")

    tool: str = Field(max_length=128)
    invoke_count: int = Field(0, ge=0, le=10_000_000)
    error_count: int = Field(0, ge=0, le=10_000_000)


class UserTelemetry(ClientIdentity):
    """One periodic tick, batched into a single request.

    The request arriving *is* the presence heartbeat, so there is no separate
    last-active field that could disagree with it.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    # Ignored when a verified token is present; required otherwise.
    username: str | None = Field(None, max_length=256)
    usage_date: date | None = None
    app_version: str | None = Field(None, alias="appVersion", max_length=64)
    browser: str | None = Field(None, max_length=64)
    health_result: str | None = Field(None, max_length=64)
    token_usage: TokenTotals | None = None
    tools: list[ToolInvoke] = Field(default_factory=list, max_length=500)
    activity_by_hour: list[int] = Field(default_factory=list, max_length=24)
    new_sessions: int = Field(0, ge=0, le=100_000)


class HealthCheckIn(ClientIdentity):
    model_config = ConfigDict(extra="ignore")

    username: str | None = Field(None, max_length=256)
    health_result: str = Field(max_length=64)


class LastActiveIn(ClientIdentity):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    username: str | None = Field(None, max_length=256)
    app_version: str | None = Field(None, alias="appVersion", max_length=64)
    browser: str | None = Field(None, max_length=64)


class TokenUsageIn(ClientIdentity):
    model_config = ConfigDict(extra="ignore")

    username: str | None = Field(None, max_length=256)
    input_tokens: int = Field(0, ge=0, le=10_000_000_000)
    output_tokens: int = Field(0, ge=0, le=10_000_000_000)
    total_tokens: int = Field(0, ge=0, le=10_000_000_000)
    cost_usd: float = Field(0, ge=0, le=1_000_000)
    usage_date: date | None = None


class FeedbackIn(ClientIdentity):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    username: str | None = Field(None, max_length=256)
    rating: int | None = Field(None, ge=0, le=5)
    category: str | None = Field(None, max_length=32)
    message: str = Field(min_length=1, max_length=4000)
    app_version: str | None = Field(None, alias="appVersion", max_length=64)


# ── App logs ─────────────────────────────────────────────────────────────────

class AppLogEntry(BaseModel):
    """One event in a batch.

    Only `ts`, `message` and `fingerprint` are required, so a partial payload
    still stores something useful rather than costing the whole batch. Fields the
    schema does not recognise are dropped rather than rejected.
    """

    model_config = ConfigDict(extra="ignore")

    ts: datetime  # client event time, timezone-aware
    level: str = Field("INFO", max_length=16)  # INFO | WARN | ERROR
    module: str | None = Field(None, max_length=256)
    message: str = Field(max_length=8000)
    fingerprint: str = Field(max_length=128)
    count: int = Field(1, ge=1, le=1_000_000)  # collapsed duplicates
    event: str | None = Field(None, max_length=128)
    phase: str | None = Field(None, max_length=16)  # start | success | failure
    code: str | None = Field(None, max_length=64)
    context: dict | None = None


class AppLogBatch(BaseModel):
    """Shared envelope plus a batch of events."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    run_id: UUID  # one per extension session
    username: str | None = Field(None, max_length=256)
    app_version: str | None = Field(None, alias="appVersion", max_length=64)
    browser: str | None = Field(None, max_length=128)
    logs: list[AppLogEntry] = Field(default_factory=list, max_length=5000)
