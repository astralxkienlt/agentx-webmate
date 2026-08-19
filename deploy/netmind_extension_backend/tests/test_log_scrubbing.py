"""Log redaction.

A log file is the artefact that gets pasted into a support ticket, so anything
that reaches one is effectively public. Three things must never survive the
scrubber: bearer tokens, model keys, and raw JWTs (an ID token carries the
user's name and email, so an unscrubbed one turns a log into PII).

The last test is a regression: the scrubber used to eat the word after any
occurrence of "bearer", which in an access line reading `[HTTP] bearer POST
/path` meant redacting the HTTP method and quietly losing it from every
authenticated request.
"""
import pytest

from app.core.logging import _scrub, mask_key
from tests.conftest import SHARED_SECRET, make_token


def scrub(message: str) -> str:
    record = {"message": message}
    _scrub(record)
    return record["message"]


# ── What must be removed ─────────────────────────────────────────────────────

def test_bearer_token_is_redacted():
    out = scrub("calling with Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")
    assert "abcdefghijklmnopqrstuvwxyz123456" not in out
    assert "<redacted>" in out


def test_real_id_token_is_redacted():
    token = make_token()
    out = scrub(f"verifying Bearer {token}")
    assert token not in out


def test_bare_jwt_without_a_bearer_prefix_is_redacted():
    """A token logged on its own is just as damaging as one behind 'Bearer'."""
    token = make_token()
    out = scrub(f"token was {token}")
    assert token not in out
    assert "<jwt-redacted>" in out


def test_jwt_payload_claims_do_not_survive():
    """The specific risk: an ID token carries the user's email and name."""
    token = make_token(email="secret.person@corp.test", name="Secret Person")
    assert "secret.person" not in scrub(f"claims from {token}")


def test_model_key_is_redacted():
    out = scrub("issued key sk-abc123def456ghi789 to the user")
    assert "sk-abc123def456ghi789" not in out
    assert "sk-<redacted>" in out


def test_multiple_secrets_in_one_line_are_all_removed():
    token = make_token()
    out = scrub(f"Bearer {token} produced sk-livekey1234567890")
    assert token not in out
    assert "sk-livekey1234567890" not in out


def test_newlines_are_flattened_so_one_record_is_one_line():
    """`grep ERROR app.log` must return whole records, not fragments — and a
    forged newline must not let attacker-controlled text pose as its own line."""
    out = scrub("first\nsecond\rthird")
    assert "\n" not in out and "\r" not in out
    assert "\\n" in out


# ── What must NOT be removed ─────────────────────────────────────────────────

def test_http_method_after_the_source_label_survives():
    """Regression: the access line is `[HTTP] <source> <method> <path>`.

    With no length floor the scrubber matched "bearer POST" and redacted the
    method, so every authenticated request logged an unknown verb.
    """
    out = scrub("[HTTP] token POST /netmind-extension/api/logs -> 200 18ms")
    assert "POST" in out
    assert "<redacted>" not in out


def test_short_word_after_bearer_is_not_eaten():
    out = scrub("Bearer GET /x")
    assert "GET" in out


def test_ordinary_prose_is_untouched():
    message = "provisioned subject=viettel|kienlt device=6f1c2c7a status=reused"
    assert scrub(message) == message


# ── mask_key ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "value,expected",
    [
        ("", "<empty>"),
        ("sk-short", "sk-<redacted>"),
        ("sk-abcdefghijklmnop", "sk-abc…mnop"),
    ],
)
def test_mask_key(value, expected):
    assert mask_key(value) == expected


def test_mask_key_never_reveals_the_middle():
    key = "sk-" + "x" * 40 + "TAIL"
    masked = mask_key(key)
    assert key not in masked
    assert masked.endswith("TAIL"), "a support ticket needs the tail to identify a key"
    assert len(masked) < 20


def test_shared_secret_would_be_caught_if_logged_behind_bearer():
    """Belt and braces: the signing secret must not survive a careless log call."""
    assert SHARED_SECRET not in scrub(f"Bearer {SHARED_SECRET}")
