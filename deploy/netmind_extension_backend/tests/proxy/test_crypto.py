"""The AES-256-GCM envelope.

Two properties matter more than the round trip: a row must not decrypt under the
wrong subject, and a KEK rotation must not lock anybody out.
"""
import base64

import pytest

from app.core.config import Settings
from app.proxy import crypto
from tests.conftest import KEK, KEK_ALT


def _settings(**overrides) -> Settings:
    base = {
        "brain_kek": KEK,
        "brain_kek_id": "k1",
        "database_url": "sqlite+aiosqlite:///:memory:",
    }
    return Settings(**{**base, **overrides})


def test_round_trip():
    s = _settings()
    sealed = crypto.seal("sk-secret-value", "subject-1", s)
    assert crypto.open_sealed(sealed, "subject-1", s) == "sk-secret-value"


def test_ciphertext_does_not_contain_plaintext():
    s = _settings()
    sealed = crypto.seal("sk-secret-value", "subject-1", s)
    raw = base64.b64decode(sealed.ciphertext)
    assert b"sk-secret-value" not in raw


def test_nonce_differs_per_seal():
    """Reusing a nonce under one key destroys GCM's guarantees outright."""
    s = _settings()
    nonces = {crypto.seal("same-value", "subject-1", s).nonce for _ in range(20)}
    assert len(nonces) == 20


def test_wrong_subject_cannot_open_the_row():
    """The subject is the AAD, so a row moved to another user's record is inert.

    This turns "swap two rows in the database" from privilege escalation into an
    error, which is the entire reason the AAD is there.
    """
    s = _settings()
    sealed = crypto.seal("sk-secret-value", "subject-1", s)
    with pytest.raises(crypto.KekMismatchError):
        crypto.open_sealed(sealed, "subject-2", s)


def test_wrong_kek_cannot_open_the_row():
    sealed = crypto.seal("sk-secret-value", "subject-1", _settings())
    other = _settings(brain_kek=KEK_ALT, brain_kek_id="k9")
    with pytest.raises(crypto.KekMismatchError):
        crypto.open_sealed(sealed, "subject-1", other)


def test_rotation_keeps_old_rows_readable():
    """A row written before a rotation still opens, via BRAIN_KEK_PREVIOUS.

    Without this, rotating the KEK would take every existing key offline at once
    — the operation would be unusable in practice.
    """
    old = _settings()
    sealed = crypto.seal("sk-old-row", "subject-1", old)

    rotating = _settings(
        brain_kek=KEK_ALT,
        brain_kek_id="k2",
        brain_kek_previous=KEK,
        brain_kek_previous_id="k1",
    )
    assert crypto.open_sealed(sealed, "subject-1", rotating) == "sk-old-row"
    assert crypto.needs_rewrap(sealed, rotating) is True

    resealed = crypto.seal("sk-old-row", "subject-1", rotating)
    assert resealed.kek_id == "k2"
    assert crypto.needs_rewrap(resealed, rotating) is False


def test_row_naming_an_unknown_kek_still_opens_if_some_key_works():
    """`kek_id` is a hint, not a gate.

    A row whose id was mislabelled — or written a moment either side of a
    rotation — must still open if any configured KEK opens it. Trusting the
    label absolutely would strand rows for a bookkeeping error.
    """
    s = _settings()
    sealed = crypto.seal("sk-value", "subject-1", s)
    mislabelled = crypto.Sealed(sealed.ciphertext, sealed.nonce, "some-old-label")
    assert crypto.open_sealed(mislabelled, "subject-1", s) == "sk-value"


def test_missing_kek_is_an_explicit_error():
    s = _settings(brain_kek="")
    with pytest.raises(crypto.KekUnavailableError):
        crypto.seal("sk-value", "subject-1", s)


def test_short_kek_is_rejected_rather_than_padded():
    """A 16-byte key would silently give AES-128 where AES-256 was intended."""
    s = _settings(brain_kek=base64.b64encode(b"x" * 16).decode())
    with pytest.raises(crypto.KekUnavailableError, match="32 bytes"):
        crypto.seal("sk-value", "subject-1", s)


def test_non_base64_kek_is_rejected():
    s = _settings(brain_kek="this is not base64!!")
    with pytest.raises(crypto.KekUnavailableError):
        crypto.seal("sk-value", "subject-1", s)


def test_tampered_ciphertext_is_detected():
    """GCM authenticates; a flipped byte must fail rather than decrypt to junk."""
    s = _settings()
    sealed = crypto.seal("sk-value", "subject-1", s)
    raw = bytearray(base64.b64decode(sealed.ciphertext))
    raw[0] ^= 0xFF
    tampered = crypto.Sealed(base64.b64encode(bytes(raw)).decode(), sealed.nonce, "k1")
    with pytest.raises(crypto.KekMismatchError):
        crypto.open_sealed(tampered, "subject-1", s)
