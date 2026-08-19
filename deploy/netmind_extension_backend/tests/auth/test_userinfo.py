"""Verification by asking the issuer (`OIDC_USERINFO_ENDPOINT`).

This is the mode the Viettel deployment runs in, because the SSO wrapper signs
HS256 with a secret it gives nobody and serves no JWKS — there is no key here to
check a signature against, so the bearer is handed back to the issuer instead.

Two rules these tests exist to protect:

* **A rejected token is 401, an unreachable issuer is 503.** The mode adds a
  network dependency to every verification, which makes the split matter *more*
  than it did when verification was local: a wrapper hiccup must not sign the
  fleet out.
* **The token's own claims decide nothing.** `aud`, `iss` and the signature are
  all echoed or self-asserted by an issuer that registers no clients. Identity
  comes from the userinfo response or it does not come at all.
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from tests.conftest import SUBJECT, USERINFO_URL, auth_headers, make_token


@pytest.fixture
def userinfo_client(monkeypatch, fake_http):
    """An app that verifies by asking the issuer, holding no key of its own."""
    monkeypatch.setenv("OIDC_USERINFO_ENDPOINT", USERINFO_URL)
    monkeypatch.setenv("OIDC_SHARED_SECRET", "")
    monkeypatch.setenv("JWKS_URL", "")
    get_settings.cache_clear()

    from app.auth.userinfo import clear_cache
    from app.main import create_app

    clear_cache()
    application = create_app()
    with TestClient(application) as test_client:
        application.state.http_client = fake_http
        yield test_client

    get_settings.cache_clear()
    clear_cache()


def test_a_bearer_the_issuer_vouches_for_is_accepted(userinfo_client, gateway):
    response = userinfo_client.get("/v1/me", headers=auth_headers(make_token()))
    assert response.status_code == 200, response.text
    assert gateway.userinfo_calls == 1


def test_identity_comes_from_userinfo_not_from_the_token(userinfo_client, gateway):
    """A token claiming to be somebody else changes nothing.

    The wrapper's signature cannot be checked here, so a token's own `sub` is
    only an assertion. If it ever reached `Identity`, anyone could mint one.
    """
    gateway.userinfo_document = {**gateway.userinfo_document, "sub": SUBJECT}
    response = userinfo_client.get(
        "/v1/me", headers=auth_headers(make_token(subject="somebody-else"))
    )
    assert response.status_code == 200, response.text
    assert response.json()["subject"] == SUBJECT


def test_an_opaque_bearer_works_because_shape_is_not_the_check(userinfo_client, gateway):
    """The issuer may hand out something that is not a JWT at all."""
    response = userinfo_client.get("/v1/me", headers=auth_headers("opaque-access-token"))
    assert response.status_code == 200, response.text
    assert gateway.userinfo_calls == 1


def test_wrong_audience_no_longer_rejects(userinfo_client):
    """`aud` is echoed back by an issuer that registers no clients.

    Pinning it would refuse valid sign-ins while stopping no forgery, so this
    mode does not look at it.
    """
    response = userinfo_client.get(
        "/v1/me", headers=auth_headers(make_token(audience="anything-at-all"))
    )
    assert response.status_code == 200, response.text


def test_a_token_the_issuer_rejects_is_401(userinfo_client, gateway):
    gateway.userinfo_status = 401
    response = userinfo_client.get("/v1/me", headers=auth_headers(make_token()))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"
    # The issuer's own wording survives: "invalid" alone would tell an operator
    # nothing about whether the token expired or was never known.
    assert "Token not found or expired" in response.json()["detail"]


def test_a_forbidden_token_is_also_401(userinfo_client, gateway):
    gateway.userinfo_status = 403
    response = userinfo_client.get("/v1/me", headers=auth_headers(make_token()))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_a_403_with_no_oauth_body_is_503_not_a_rejection(userinfo_client, gateway):
    """A gateway in front of the issuer refusing us says nothing about the token.

    Seen in production: reaching the wrapper on its internal address answered
    403 with an HTML body. Treating that as `invalid_token` would have signed
    every user out — the extension clears the session on a 401 invalid_token —
    over a fault no user could act on.
    """
    gateway.userinfo_status = 403
    gateway.userinfo_raw_error = "<html><body>Forbidden</body></html>"
    response = userinfo_client.get("/v1/me", headers=auth_headers(make_token()))
    assert response.status_code == 503
    assert response.json()["error"] == "identity_unavailable"


def test_a_401_with_no_oauth_body_is_also_503(userinfo_client, gateway):
    gateway.userinfo_status = 401
    gateway.userinfo_raw_error = "Unauthorized"
    response = userinfo_client.get("/v1/me", headers=auth_headers(make_token()))
    assert response.status_code == 503


def test_an_unreachable_issuer_is_503_not_401(userinfo_client, gateway):
    """The rule the whole module exists for: we could not check ≠ the answer is no."""
    gateway.userinfo_error = httpx.ConnectError("wrapper down")
    response = userinfo_client.get("/v1/me", headers=auth_headers(make_token()))
    assert response.status_code == 503
    assert response.json()["error"] == "identity_unavailable"


def test_a_5xx_from_the_issuer_is_503(userinfo_client, gateway):
    gateway.userinfo_status = 500
    response = userinfo_client.get("/v1/me", headers=auth_headers(make_token()))
    assert response.status_code == 503
    assert response.json()["error"] == "identity_unavailable"


def test_a_404_endpoint_is_503_because_that_is_an_operator_fault(userinfo_client, gateway):
    """A misconfigured URL must not read as "your token is bad" to every user."""
    gateway.userinfo_status = 404
    response = userinfo_client.get("/v1/me", headers=auth_headers(make_token()))
    assert response.status_code == 503


def test_a_200_without_sub_is_503_not_a_silent_identity(userinfo_client, gateway):
    gateway.userinfo_document = {"email": "kien@example.test"}
    response = userinfo_client.get("/v1/me", headers=auth_headers(make_token()))
    assert response.status_code == 503
    assert response.json()["error"] == "identity_unavailable"


def test_a_verified_answer_is_cached_across_requests(userinfo_client, gateway):
    """One sign-in makes several calls; each must not cost a round trip."""
    token = make_token()
    for _ in range(3):
        assert userinfo_client.get("/v1/me", headers=auth_headers(token)).status_code == 200
    assert gateway.userinfo_calls == 1


def test_a_different_bearer_is_not_served_from_another_token_cache(userinfo_client, gateway):
    assert userinfo_client.get("/v1/me", headers=auth_headers(make_token())).status_code == 200
    assert userinfo_client.get("/v1/me", headers=auth_headers("a-different-token")).status_code == 200
    assert gateway.userinfo_calls == 2


def test_a_rejection_is_not_cached(userinfo_client, gateway):
    """Caching a "no" would keep a user locked out after the issuer recovers."""
    token = make_token()
    gateway.userinfo_status = 401
    assert userinfo_client.get("/v1/me", headers=auth_headers(token)).status_code == 401
    gateway.userinfo_status = 200
    assert userinfo_client.get("/v1/me", headers=auth_headers(token)).status_code == 200
    assert gateway.userinfo_calls == 2


def test_a_missing_bearer_is_still_401_missing_bearer(userinfo_client, gateway):
    """No bearer is refused here, before the issuer is troubled about it."""
    response = userinfo_client.get(
        "/v1/me", headers={"X-AgentX-Device": "6f1c2c7a-9a3e-4a1d-8f0b-2c9d1e5f7a01"}
    )
    assert response.status_code == 401
    assert response.json()["error"] == "missing_bearer"
    assert gateway.userinfo_calls == 0
