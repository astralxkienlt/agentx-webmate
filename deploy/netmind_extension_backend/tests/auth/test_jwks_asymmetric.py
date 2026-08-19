"""The asymmetric verification path (RS256 + JWKS).

Nothing here runs on the current deployment: the Viettel SSO wrapper signs
HS256. The path is kept — and therefore tested — because hardening the wrapper
to RS256 is the one change that would stop this service being able to forge the
tokens it verifies, and it should be an environment flip rather than a rewrite
when someone decides to make it.

The rule these tests exist to protect is the same one as everywhere else:
**a rejected token is 401, an unreachable issuer is 503.**
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from tests.conftest import (
    JWKS_URL,
    KID,
    OTHER_PRIVATE_PEM,
    auth_headers,
    make_token,
)


@pytest.fixture
def rs256_client(monkeypatch, fake_http):
    """An app configured to expect RS256 tokens verified against a JWKS."""
    monkeypatch.setenv("OIDC_ID_TOKEN_ALG", "RS256")
    monkeypatch.setenv("JWKS_URL", JWKS_URL)
    monkeypatch.setenv("OIDC_SHARED_SECRET", "")
    get_settings.cache_clear()

    from app.auth.jwks import get_jwks_cache
    from app.main import create_app

    get_jwks_cache().clear()
    application = create_app()
    with TestClient(application) as test_client:
        application.state.http_client = fake_http
        yield test_client

    # Restore the process-wide cache for whatever runs next.
    get_settings.cache_clear()
    get_jwks_cache().clear()


def rs256_token(**kwargs) -> str:
    kwargs.setdefault("algorithm", "RS256")
    kwargs.setdefault("kid", KID)
    return make_token(**kwargs)


def test_valid_rs256_token_is_accepted(rs256_client, gateway):
    response = rs256_client.get("/v1/me", headers=auth_headers(rs256_token()))
    assert response.status_code == 200, response.text
    assert gateway.jwks_calls == 1


def test_jwks_is_cached_across_requests(rs256_client, gateway):
    for _ in range(3):
        assert rs256_client.get("/v1/me", headers=auth_headers(rs256_token())).status_code == 200
    assert gateway.jwks_calls == 1, "JWKS should be fetched once and cached"


def test_token_signed_by_an_unadvertised_key_is_refused(rs256_client):
    """The issuer answered and does not vouch for this key: a verdict, not an outage."""
    forged = rs256_token(key=OTHER_PRIVATE_PEM)
    response = rs256_client.get("/v1/me", headers=auth_headers(forged))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_unknown_kid_refetches_once_then_401(rs256_client, gateway):
    """A `kid` miss is what a key rollover looks like, so refetch immediately
    rather than making users wait out the cache TTL."""
    response = rs256_client.get(
        "/v1/me", headers=auth_headers(rs256_token(kid="rolled-over"))
    )
    assert response.status_code == 401
    assert gateway.jwks_calls == 1


def test_hs256_token_is_refused_when_rs256_is_configured(rs256_client, gateway):
    """Algorithm confusion in its classic direction.

    An RS256 verifier handed an HS256 token signed with the public key it trusts
    is the textbook JWT forgery. Pinning the algorithm refuses it before a key is
    ever fetched.
    """
    from tests.conftest import _public_pem

    import base64
    import hashlib
    import hmac as hmac_mod
    import json

    def seg(data: dict) -> bytes:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=")

    from tests.conftest import CLIENT_ID, ISSUER

    signing_input = (
        seg({"alg": "HS256", "kid": KID})
        + b"."
        + seg({"sub": "attacker", "iss": ISSUER, "aud": CLIENT_ID})
    )
    signature = base64.urlsafe_b64encode(
        hmac_mod.new(_public_pem.encode(), signing_input, hashlib.sha256).digest()
    ).rstrip(b"=")
    forged = (signing_input + b"." + signature).decode()

    response = rs256_client.get("/v1/me", headers=auth_headers(forged))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"
    assert gateway.jwks_calls == 0, "must be refused before any key lookup"


def test_token_without_a_kid_is_refused(rs256_client):
    """Asymmetric verification needs to know which advertised key to use."""
    response = rs256_client.get("/v1/me", headers=auth_headers(rs256_token(kid=None)))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


# ── The distinction that protects the fleet ──────────────────────────────────

def test_jwks_unreachable_is_503_not_401(rs256_client, gateway):
    """A network failure reaching the issuer must never look like a rejection:
    401 tells every client in the fleet to sign out, and one JWKS hiccup would
    then log everybody out at once."""
    gateway.jwks_error = httpx.ConnectError("dns is having a day")
    response = rs256_client.get("/v1/me", headers=auth_headers(rs256_token()))
    assert response.status_code == 503
    assert response.json()["error"] == "identity_unavailable"


def test_jwks_timeout_is_503(rs256_client, gateway):
    gateway.jwks_error = httpx.ReadTimeout("slow")
    response = rs256_client.get("/v1/me", headers=auth_headers(rs256_token()))
    assert response.status_code == 503
    assert response.json()["error"] == "identity_unavailable"


def test_jwks_http_error_is_503(rs256_client, gateway):
    gateway.jwks_status = 500
    response = rs256_client.get("/v1/me", headers=auth_headers(rs256_token()))
    assert response.status_code == 503
    assert response.json()["error"] == "identity_unavailable"


def test_empty_jwks_is_503(rs256_client, gateway):
    gateway.jwks_document = {"keys": []}
    response = rs256_client.get("/v1/me", headers=auth_headers(rs256_token()))
    assert response.status_code == 503
    assert response.json()["error"] == "identity_unavailable"


# ── Ingest degradation, which only exists on this path ───────────────────────
#
# A symmetric deployment verifies locally and can never see an unreachable
# issuer, so these two behaviours are reachable only here.

TELEMETRY = "/api/background-logs/user-telemetry"


def test_unreachable_issuer_falls_back_to_the_shared_key(rs256_client, gateway):
    """Telemetry is worth keeping through a JWKS outage.

    The fallback grants no new capability — anyone holding the shared ingest key
    could simply omit the bearer — so accepting the batch as unverified beats
    losing it.
    """
    from tests.conftest import INGEST_KEY

    gateway.jwks_error = httpx.ConnectError("issuer down")
    response = rs256_client.post(
        TELEMETRY,
        headers={
            "Authorization": f"Bearer {rs256_token()}",
            "X-Auth-Key": INGEST_KEY,
        },
        json={"username": "someone"},
    )
    assert response.status_code == 200
    assert response.json()["identity_verified"] is False


def test_unreachable_issuer_without_shared_key_surfaces_the_outage(rs256_client, gateway):
    """No fallback available, so report the outage honestly rather than
    inventing an identity for the row."""
    gateway.jwks_error = httpx.ConnectError("issuer down")
    response = rs256_client.post(
        TELEMETRY, headers={"Authorization": f"Bearer {rs256_token()}"}, json={}
    )
    assert response.status_code == 503
    assert response.json()["error"] == "identity_unavailable"
