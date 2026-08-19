"""Stored LiteLLM virtual keys — one row per person."""
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class LlmKey(Base):
    """A person's model key, sealed at rest.

    Primary key is `subject`, which is what makes "one key per person" a
    database invariant rather than a convention someone has to remember.

    `litellm_token` is the gateway's handle for this key and the **only** thing
    a rotation deletes. Deleting by `key_alias` instead would delete the key
    every install of that person is currently using, because they all share one
    alias — the bug that motivated this whole design (spec R5).

    `models` and `default_model` are stored as reported by the gateway at mint
    time so a reuse can answer without a round trip. They are refreshed whenever
    the gateway is consulted anyway.
    """

    __tablename__ = "llm_keys"

    subject: Mapped[str] = mapped_column(Text, primary_key=True)
    account: Mapped[str] = mapped_column(Text)  # account_slug, for humans
    username: Mapped[str] = mapped_column(Text)
    user_email: Mapped[str] = mapped_column(Text)

    # Sealed plaintext of the virtual key (see app/proxy/crypto.py).
    ciphertext: Mapped[str] = mapped_column(Text)
    nonce: Mapped[str] = mapped_column(Text)
    kek_id: Mapped[str] = mapped_column(Text)

    key_alias: Mapped[str] = mapped_column(Text)
    litellm_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    litellm_user_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    team_id: Mapped[str | None] = mapped_column(Text, nullable=True)

    base_url: Mapped[str] = mapped_column(Text)
    models: Mapped[str] = mapped_column(Text)  # JSON array, ordered
    default_model: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    rotated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
