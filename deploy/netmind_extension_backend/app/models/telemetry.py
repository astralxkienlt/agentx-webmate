"""Telemetry tables.

Every table keys on `username` and carries `identity_verified`, so a future
dashboard can separate what a verified token asserted from what an unverified
client typed. Daily aggregates use a natural unique constraint and are upserted:
the extension re-reports the running total for the day on every tick, so the
latest post for a (user, day) wins and a missed tick self-heals on the next one.
"""
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class HealthCheck(Base):
    """Gateway reachability as seen from the user's browser, one row per tick."""

    __tablename__ = "health_check"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Text, index=True)
    health_result: Mapped[str] = mapped_column(Text)
    identity_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class TokenUsage(Base):
    """Cumulative LLM token spend for one user on one day."""

    __tablename__ = "token_usage"
    __table_args__ = (
        UniqueConstraint("username", "usage_date", name="uq_token_usage_user_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Text, index=True)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), default=0)
    usage_date: Mapped[date] = mapped_column(Date, index=True)
    identity_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class LastActive(Base):
    """Last time we heard from each user. The telemetry post itself is the
    heartbeat, so there is no separate presence call to get out of sync with."""

    __tablename__ = "last_active"

    username: Mapped[str] = mapped_column(Text, primary_key=True)
    last_active_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    app_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    browser: Mapped[str | None] = mapped_column(Text, nullable=True)


class ToolUsage(Base):
    """Per-user, per-day, per-tool invoke and error counts.

    For a browser agent a "tool" is an agent action — click, type, navigate,
    read_page — which is the grain at which a failure is actually diagnosable.
    """

    __tablename__ = "tool_usage"
    __table_args__ = (
        UniqueConstraint(
            "username", "usage_date", "tool", name="uq_tool_usage_user_date_tool"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Text, index=True)
    usage_date: Mapped[date] = mapped_column(Date, index=True)
    tool: Mapped[str] = mapped_column(Text, index=True)
    invoke_count: Mapped[int] = mapped_column(Integer, default=0)
    error_count: Mapped[int] = mapped_column(Integer, default=0)
    identity_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ActivityHourly(Base):
    """Human-message counts bucketed by the user's local hour, for a load heatmap."""

    __tablename__ = "activity_hourly"
    __table_args__ = (
        UniqueConstraint(
            "username", "usage_date", "hour", name="uq_activity_hourly_user_date_hour"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Text, index=True)
    usage_date: Mapped[date] = mapped_column(Date, index=True)
    hour: Mapped[int] = mapped_column(Integer)  # 0–23, client local
    count: Mapped[int] = mapped_column(Integer, default=0)
    identity_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class DailySession(Base):
    """Count of chat sessions a user started on a given day."""

    __tablename__ = "session_daily"
    __table_args__ = (
        UniqueConstraint("username", "usage_date", name="uq_session_daily_user_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Text, index=True)
    usage_date: Mapped[date] = mapped_column(Date, index=True)
    new_sessions: Mapped[int] = mapped_column(Integer, default=0)
    identity_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Feedback(Base):
    """User feedback submitted from the extension."""

    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(Text, index=True)
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 1–5
    category: Mapped[str | None] = mapped_column(Text, nullable=True)
    message: Mapped[str] = mapped_column(Text)
    app_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, server_default="new")
    identity_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
