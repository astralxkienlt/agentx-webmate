"""Normalised identity, derived from verified ID-token claims.

Identity providers spell people differently. Every claim we have seen is read
here and normalised once, so the rest of the service uses `subject`, `username`,
`email`, `display_name` and never touches a raw claim. That is what keeps the
LiteLLM user table, the telemetry roster and the key aliases agreeing with each
other.

**The token decides the account. Always.** Nothing in a request body or query
string contributes to identity. If a client could name its own account, anyone
could fetch anyone else's model key by editing one JSON field (spec R1).
"""
import hashlib
import re

from pydantic import BaseModel, ConfigDict

_SLUG_STRIP = re.compile(r"[^a-z0-9]+")
_LABEL_MAX = 24


def _first(*values: object) -> str:
    for v in values:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


class Identity(BaseModel):
    """Who the caller is, according to a verified token."""

    model_config = ConfigDict(frozen=True)

    subject: str
    email: str = ""
    preferred_username: str = ""
    display_name: str = ""

    @classmethod
    def from_claims(cls, claims: dict) -> "Identity":
        return cls(
            subject=str(claims["sub"]),
            email=_first(claims.get("email")),
            preferred_username=_first(claims.get("preferred_username"), claims.get("upn")),
            display_name=_first(
                claims.get("name"),
                claims.get("preferred_username"),
                claims.get("email"),
                claims.get("sub"),
            ),
        )

    @property
    def username(self) -> str:
        """Bare corporate username, no domain.

        The join key for telemetry. Falls back to the local part of the email so
        a realm that only issues `email` still produces a stable, readable name.
        """
        raw = _first(self.preferred_username, self.email, self.subject)
        return raw.split("@", 1)[0].lower()

    @property
    def user_email(self) -> str:
        """Identity the LiteLLM gateway keys its user records on."""
        return _first(self.email, self.preferred_username).lower()

    @property
    def account_slug(self) -> str:
        """Stable per-person slug: `{label}-{sha256(sub)[:8]}`.

        The digest is taken over `sub`, so the slug survives a rename or a change
        of email address; the label exists only so a human reading the LiteLLM
        console can tell whose key they are looking at.

        This formula is shared with the client and the CLI — if anything else
        generates this slug, it must generate it the same way (spec §7).
        """
        label = _SLUG_STRIP.sub("-", self.username.lower()).strip("-")[:_LABEL_MAX].strip("-")
        digest = hashlib.sha256(self.subject.encode("utf-8")).hexdigest()[:8]
        return f"{label}-{digest}" if label else digest
