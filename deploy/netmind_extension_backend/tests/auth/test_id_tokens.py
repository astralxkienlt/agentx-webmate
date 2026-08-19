"""ID-token verification against the Viettel SSO wrapper (HS256, no JWKS).

The two tests that earn their keep here are `test_rs256_token_is_refused` and
`test_none_algorithm_is_refused`. The wrapper signs symmetrically, so this
service holds a secret that both verifies *and* signs; pinning the algorithm is
the only thing standing between that and an algorithm-confusion forgery.

The asymmetric path is covered separately in `test_jwks_asymmetric.py`.
"""
import pytest

from tests.conftest import (
    CLIENT_ID,
    ISSUER,
    SHARED_SECRET,
    auth_headers,
    make_token,
)


def test_valid_token_is_accepted(client):
    response = client.get("/v1/me", headers=auth_headers())
    assert response.status_code == 200, response.text
    assert response.json()["subject"] == "user-abc-123"


def test_missing_authorization_is_missing_bearer(client):
    response = client.get("/v1/me", headers={"X-AgentX-Device": "a" * 8})
    assert response.status_code == 401
    assert response.json()["error"] == "missing_bearer"


def test_malformed_authorization_is_missing_bearer(client):
    response = client.get(
        "/v1/me",
        headers={"Authorization": "Token abc", "X-AgentX-Device": "1" * 8},
    )
    assert response.status_code == 401
    assert response.json()["error"] == "missing_bearer"


def test_expired_token_is_invalid_token(client):
    response = client.get("/v1/me", headers=auth_headers(make_token(expires_in=-3600)))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_token_signed_with_the_wrong_secret_is_refused(client):
    """The core of symmetric verification: a different secret is a forgery."""
    forged = make_token(key="a-different-secret-of-sufficient-length-x")
    response = client.get("/v1/me", headers=auth_headers(forged))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_tampered_payload_is_refused(client):
    """Flip a byte in the claims and the signature must stop matching."""
    header, payload, signature = make_token().split(".")
    # Re-encode the payload with a different subject, keeping the old signature.
    import base64
    import json

    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    claims["sub"] = "somebody-else"
    tampered_payload = (
        base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    )
    response = client.get(
        "/v1/me", headers=auth_headers(f"{header}.{tampered_payload}.{signature}")
    )
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_wrong_audience_is_rejected(client):
    """Pinning `aud` stops a token minted for another client being replayed."""
    response = client.get(
        "/v1/me", headers=auth_headers(make_token(audience="some-other-client"))
    )
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_audience_as_a_list_is_accepted(client):
    """Issuers emit `aud` as a list once there is more than one audience; a
    service that only understood the string form would break that day."""
    response = client.get(
        "/v1/me", headers=auth_headers(make_token(audience=["other", CLIENT_ID]))
    )
    assert response.status_code == 200


def test_wrong_issuer_is_rejected(client):
    response = client.get(
        "/v1/me",
        headers=auth_headers(make_token(issuer="https://evil.test/sso-wrapper")),
    )
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_issuer_trailing_slash_is_forgiven(client):
    response = client.get("/v1/me", headers=auth_headers(make_token(issuer=f"{ISSUER}/")))
    assert response.status_code == 200


def test_token_without_sub_is_rejected(client):
    response = client.get("/v1/me", headers=auth_headers(make_token(subject="")))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


# ── Algorithm pinning: the defence against forgery ───────────────────────────

def test_none_algorithm_is_refused(client):
    """`alg: none` must die at the header, before any key is selected."""
    import base64
    import json

    def seg(data: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()

    forged = f"{seg({'alg': 'none', 'typ': 'JWT'})}.{seg({'sub': 'attacker'})}."
    response = client.get("/v1/me", headers=auth_headers(forged))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_rs256_token_is_refused_when_hs256_is_configured(client):
    """Algorithm confusion, the direction that matters here.

    This deployment issues HS256. A token arriving as RS256 — however
    impeccably signed by whoever minted it — is not one of ours, and accepting
    it would mean trusting a key we never chose.
    """
    from tests.conftest import _private_pem

    response = client.get(
        "/v1/me", headers=auth_headers(make_token(algorithm="RS256", key=_private_pem))
    )
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_stronger_hmac_variant_is_still_refused(client):
    """Only the configured algorithm is accepted — not merely a safe-looking one.

    HS512 is no weaker than HS256, and that is exactly why this test exists: the
    rule is "the one we issue", not "one we happen to approve of". A list of
    acceptable algorithms is what lets an attacker choose from it.
    """
    response = client.get("/v1/me", headers=auth_headers(make_token(algorithm="HS512")))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_garbage_bearer_is_refused(client):
    response = client.get("/v1/me", headers=auth_headers("not-a-jwt-at-all"))
    assert response.status_code == 401
    assert response.json()["error"] == "invalid_token"


def test_kid_in_the_header_does_not_steer_key_selection(client, gateway):
    """A symmetric deployment has exactly one key and must not consult a JWKS.

    If a `kid` could send this service off to fetch key material, a token could
    nominate the key used to check it.
    """
    response = client.get(
        "/v1/me", headers=auth_headers(make_token(kid="attacker-chosen-key"))
    )
    assert response.status_code == 200
    assert gateway.jwks_calls == 0, "a symmetric deployment must never fetch a JWKS"


# ── Identity normalisation ───────────────────────────────────────────────────

@pytest.mark.parametrize(
    "claims,expected_username",
    [
        ({"preferred_username": "kienlt", "email": "kien@corp.test"}, "kienlt"),
        ({"preferred_username": "", "email": "kien.le@corp.test"}, "kien.le"),
        ({"preferred_username": "KienLT", "email": ""}, "kienlt"),
    ],
)
def test_username_normalisation(client, claims, expected_username):
    """Username is lowercased and stripped of any domain, whichever claim it came
    from — telemetry joins on it and two spellings must not become two people."""
    response = client.get("/v1/me", headers=auth_headers(make_token(**claims)))
    assert response.status_code == 200, response.text
    assert response.json()["username"] == expected_username


def test_account_slug_is_stable_across_rename(client):
    """The slug digests `sub`, so a rename keeps the same account.

    If it tracked the username, renaming somebody would orphan their key behind
    an alias nobody looks up any more.
    """
    first = client.get(
        "/v1/me", headers=auth_headers(make_token(preferred_username="kienlt"))
    ).json()["account"]
    second = client.get(
        "/v1/me",
        headers=auth_headers(
            make_token(preferred_username="kien.le.trung", email="new@corp.test")
        ),
    ).json()["account"]
    assert first.split("-")[-1] == second.split("-")[-1], "digest half must not change"
    assert first != second, "label half should follow the current name"


def test_secret_never_appears_in_a_response(client):
    """A signing key that leaks into an error body is a forged identity for
    whoever reads it."""
    bodies = [
        client.get("/v1/me", headers=auth_headers()).text,
        client.get("/v1/me", headers=auth_headers("bad")).text,
        client.get("/api/auth/providers").text,
        client.get("/health").text,
    ]
    for body in bodies:
        assert SHARED_SECRET not in body
