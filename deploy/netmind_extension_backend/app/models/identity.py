"""User profile and device registry."""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class User(Base):
    """One row per person, upserted from verified token claims.

    `username` is the join key every telemetry table shares. `subject` is the
    authority — it comes from the token and never changes, whereas a username
    can be renamed underneath us.

    `identity_verified` records whether we have ever seen a verified token for
    this user. A row created only from shared-key ingest is self-declared: it
    says what a client typed, not who they are. Reports that matter must filter
    on this rather than quietly averaging the two together.
    """

    __tablename__ = "users"

    username: Mapped[str] = mapped_column(Text, primary_key=True)
    subject: Mapped[str | None] = mapped_column(Text, nullable=True, index=True)
    email: Mapped[str | None] = mapped_column(Text, nullable=True)
    full_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    department: Mapped[str | None] = mapped_column(Text, nullable=True, index=True)
    identity_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Device(Base):
    """One row per (person, install).

    The primary key is composite on purpose. Keying on `device_id` alone would
    mean two colleagues sharing a laptop collide; keying on the person alone
    would lose the ability to revoke one machine (spec R6).

    Revocation is a **tombstone**, never a delete. A revoked install must keep
    getting 403 — deleting the row would let it re-register as a brand-new
    device on its next call, which is precisely what revocation must prevent.
    """

    __tablename__ = "devices"

    subject: Mapped[str] = mapped_column(Text, primary_key=True)
    device_id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    platform: Mapped[str | None] = mapped_column(Text, nullable=True)
    app_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
