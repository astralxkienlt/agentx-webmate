"""Envelope encryption for stored model keys.

LiteLLM reveals a virtual key's plaintext exactly once, at `/key/generate`
(`/key/info` and `/key/list` return only a hash). One key per person, reusable
from any number of installs, therefore *requires* keeping that plaintext — which
in turn requires it be unreadable in a database dump.

    AES-256-GCM, 12-byte nonce, KEK from env, AAD = subject, kek_id per row.

The AAD is the part worth pausing on: binding the ciphertext to its owner's
`subject` means a row copied into somebody else's record does not decrypt. It
turns "swap two rows in the database" from a privilege escalation into an error.

**Rotation** works because `kek_id` is stored per row rather than globally. Set
the new KEK, keep the old one in `BRAIN_KEK_PREVIOUS`, and each row re-wraps
itself the next time its owner asks for a key. No downtime, no migration script,
no window where half the rows are unreadable.

**Losing the KEK loses every key.** There is no recovery path other than
deleting the rows so everyone mints afresh. Back it up somewhere other than the
host that holds the database.
"""
import base64
import os
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import Settings, get_settings

_NONCE_BYTES = 12
_KEY_BYTES = 32


class KekUnavailableError(RuntimeError):
    """No KEK is configured, so nothing can be sealed or opened."""


class KekMismatchError(RuntimeError):
    """A row exists but no configured KEK opens it (wrong key, or rotated away)."""


@dataclass(frozen=True)
class Sealed:
    """A sealed key plus the metadata needed to open it again."""

    ciphertext: str  # base64
    nonce: str  # base64
    kek_id: str


def _decode_kek(raw: str, label: str) -> bytes:
    try:
        key = base64.b64decode(raw, validate=True)
    except Exception as e:  # noqa: BLE001 — binascii raises several types
        raise KekUnavailableError(f"{label} is not valid base64") from e
    if len(key) != _KEY_BYTES:
        raise KekUnavailableError(
            f"{label} must decode to {_KEY_BYTES} bytes, got {len(key)}"
        )
    return key


def _keyring(settings: Settings) -> dict[str, bytes]:
    """Every KEK this process can open a row with, by id."""
    ring: dict[str, bytes] = {}
    if settings.brain_kek:
        ring[settings.brain_kek_id] = _decode_kek(settings.brain_kek, "BRAIN_KEK")
    if settings.brain_kek_previous and settings.brain_kek_previous_id:
        ring[settings.brain_kek_previous_id] = _decode_kek(
            settings.brain_kek_previous, "BRAIN_KEK_PREVIOUS"
        )
    return ring


def seal(plaintext: str, subject: str, settings: Settings | None = None) -> Sealed:
    """Seal `plaintext` under the current KEK, bound to `subject`."""
    settings = settings or get_settings()
    if not settings.brain_kek:
        raise KekUnavailableError("BRAIN_KEK is not configured")
    kek = _decode_kek(settings.brain_kek, "BRAIN_KEK")
    nonce = os.urandom(_NONCE_BYTES)
    ciphertext = AESGCM(kek).encrypt(
        nonce, plaintext.encode("utf-8"), subject.encode("utf-8")
    )
    return Sealed(
        ciphertext=base64.b64encode(ciphertext).decode(),
        nonce=base64.b64encode(nonce).decode(),
        kek_id=settings.brain_kek_id,
    )


def open_sealed(
    sealed: Sealed, subject: str, settings: Settings | None = None
) -> str:
    """Open a sealed key.

    Tries the KEK whose id the row names, then every other configured KEK. The
    fallback matters during rotation: a row written a second before the rotation
    landed names the previous id, and refusing to try the others would turn a
    routine rotation into an outage for whoever wrote that row.
    """
    settings = settings or get_settings()
    ring = _keyring(settings)
    if not ring:
        raise KekUnavailableError("no KEK is configured")

    try:
        ciphertext = base64.b64decode(sealed.ciphertext, validate=True)
        nonce = base64.b64decode(sealed.nonce, validate=True)
    except Exception as e:  # noqa: BLE001
        raise KekMismatchError("stored ciphertext is not valid base64") from e

    ordered = [sealed.kek_id, *(k for k in ring if k != sealed.kek_id)]
    for kek_id in ordered:
        kek = ring.get(kek_id)
        if kek is None:
            continue
        try:
            return AESGCM(kek).decrypt(
                nonce, ciphertext, subject.encode("utf-8")
            ).decode("utf-8")
        except InvalidTag:
            # Wrong KEK, or the row belongs to a different subject. Both are
            # "this key does not open this row"; try the next one.
            continue
    raise KekMismatchError(
        f"no configured KEK opens this row (row kek_id={sealed.kek_id!r})"
    )


def needs_rewrap(sealed: Sealed, settings: Settings | None = None) -> bool:
    """True when a row is sealed under an older KEK than the current one."""
    settings = settings or get_settings()
    return bool(settings.brain_kek) and sealed.kek_id != settings.brain_kek_id
