"""Structured client logs — append-only, high volume.

On Postgres this table is **monthly RANGE-partitioned on `ts`**, so retention is
a `DROP TABLE <partition>`: instant, no bloat, no vacuum. `create_all` cannot
express partitioning, so the real table comes from `APP_LOGS_DDL` (raw SQL, run
at startup before `create_all`, which then sees it exists and skips it).

The ORM model below is partition-agnostic — a plain autoincrement PK — purely so
the sqlite test harness can `create_all` an ordinary table.
"""
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Integer,
    SmallInteger,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AppLog(Base):
    __tablename__ = "app_logs"

    # sqlite only autoincrements INTEGER PKs, not BIGINT — the variant keeps the
    # test harness working while production gets a bigint identity column.
    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    run_id: Mapped[str] = mapped_column(Uuid)  # one per extension session
    username: Mapped[str] = mapped_column(Text, index=True)
    device_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    level: Mapped[int] = mapped_column(SmallInteger)  # 1=INFO 2=WARN 3=ERROR
    module: Mapped[str | None] = mapped_column(Text, nullable=True)
    event: Mapped[str | None] = mapped_column(Text, nullable=True)
    phase: Mapped[str | None] = mapped_column(Text, nullable=True)
    code: Mapped[str | None] = mapped_column(Text, nullable=True)
    fingerprint: Mapped[str] = mapped_column(Text, index=True)
    message: Mapped[str] = mapped_column(Text)
    count: Mapped[int] = mapped_column(Integer, default=1)  # collapsed duplicates
    app_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    browser: Mapped[str | None] = mapped_column(Text, nullable=True)
    identity_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    context: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # JSONB on pg


# Postgres-only DDL for the partitioned parent plus its query indexes. Run once
# at startup under an advisory lock, before create_all. Every statement is
# idempotent. Month partitions are created on demand at ingest; retention drops
# whole months.
APP_LOGS_DDL: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS app_logs (
        id                 BIGINT       GENERATED ALWAYS AS IDENTITY,
        run_id             UUID         NOT NULL,
        username           TEXT         NOT NULL,
        device_id          TEXT,
        ts                 TIMESTAMPTZ  NOT NULL,
        received_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
        level              SMALLINT     NOT NULL,
        module             TEXT,
        event              TEXT,
        phase              TEXT,
        code               TEXT,
        fingerprint        TEXT         NOT NULL,
        message            TEXT         NOT NULL,
        count              INTEGER      NOT NULL DEFAULT 1,
        app_version        TEXT,
        browser            TEXT,
        identity_verified  BOOLEAN      NOT NULL DEFAULT FALSE,
        context            JSONB,
        PRIMARY KEY (id, ts)
    ) PARTITION BY RANGE (ts)
    """,
    "CREATE INDEX IF NOT EXISTS ix_app_logs_fingerprint ON app_logs (fingerprint)",
    "CREATE INDEX IF NOT EXISTS ix_app_logs_run         ON app_logs (username, run_id, ts)",
    "CREATE INDEX IF NOT EXISTS ix_app_logs_event       ON app_logs (event, phase, code)",
    "CREATE INDEX IF NOT EXISTS ix_app_logs_level_ts    ON app_logs (level, ts)",
)
