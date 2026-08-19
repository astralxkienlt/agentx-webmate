"""Boot-time configuration guards and the health endpoint.

`validate_security` is the difference between a deployment that fails on the
deploy screen and one that fails at 09:00 while somebody is signing in.
"""
import pytest

from app.core.config import Settings
from tests.conftest import ISSUER, KEK, SHARED_SECRET


def _settings(**overrides) -> Settings:
    """A settings object built only from what a test states.

    Every field these tests care about is pinned, including the ones set in the
    conftest environment — otherwise `Settings()` would silently inherit them and
    a test asserting "LiteLLM is unconfigured" would quietly assert nothing.
    """
    base = {
        "database_url": "sqlite+aiosqlite:///:memory:",
        "environment": "production",
        "secret_key": "a-real-secret",
        "oidc_issuer": ISSUER,
        "oidc_client_id": "netmind-extension",
        "oidc_extra_audiences": "",
        "oidc_id_token_alg": "HS256",
        "oidc_shared_secret": SHARED_SECRET,
        "jwks_url": "",
        "brain_kek": KEK,
        "brain_kek_previous": "",
        "brain_kek_previous_id": "",
        "litellm_base_url": "",
        "litellm_admin_key": "",
        "cors_origins": "",
        "api_base_path": "",
    }
    return Settings(**{**base, **overrides})


def _validate(settings: Settings) -> None:
    """Run validate_security against an explicit Settings instance."""
    import app.core.config as config

    original = config.get_settings
    config.get_settings = lambda: settings
    try:
        config.validate_security()
    finally:
        config.get_settings = original


# ── Fatal in production ──────────────────────────────────────────────────────

def test_complete_production_config_boots():
    _validate(_settings())


def test_default_secret_key_refuses_to_boot():
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _validate(_settings(secret_key="change-me-in-production"))


def test_missing_realm_refuses_to_boot():
    """Without a realm nothing can be verified and every authenticated route
    would 503 — the service would be furniture."""
    with pytest.raises(RuntimeError, match="identity unconfigured"):
        _validate(_settings(oidc_issuer=""))


def test_missing_kek_refuses_to_boot():
    """Booting without a KEK means minting keys that cannot be stored."""
    with pytest.raises(RuntimeError, match="BRAIN_KEK"):
        _validate(_settings(brain_kek=""))


def test_wildcard_cors_refuses_to_boot():
    with pytest.raises(RuntimeError, match="CORS_ORIGINS"):
        _validate(_settings(cors_origins="*"))


def test_half_configured_litellm_refuses_to_boot():
    """Half-configured is worse than absent: the routes mount and then fail
    per-request in a way that looks like an outage rather than a config gap."""
    with pytest.raises(RuntimeError, match="LiteLLM partially configured"):
        _validate(_settings(litellm_base_url="https://aigw.test", litellm_admin_key=""))


def test_previous_kek_without_its_id_refuses_to_boot():
    with pytest.raises(RuntimeError, match="BRAIN_KEK_PREVIOUS_ID"):
        _validate(_settings(brain_kek_previous=KEK))


# ── Token verification material ──────────────────────────────────────────────

def test_hs256_without_a_shared_secret_refuses_to_boot():
    """The wrapper signs symmetrically, so without its secret every token is
    unverifiable. Better to fail here than to fail every sign-in."""
    with pytest.raises(RuntimeError, match="OIDC_SHARED_SECRET"):
        _validate(_settings(oidc_shared_secret=""))


def test_short_shared_secret_refuses_to_boot():
    """An HMAC secret is attacked offline against one captured token, and a
    forged token mints an identity of the attacker's choosing."""
    with pytest.raises(RuntimeError, match="at least 32"):
        _validate(_settings(oidc_shared_secret="too-short"))


def test_asymmetric_alg_without_a_jwks_url_refuses_to_boot():
    with pytest.raises(RuntimeError, match="JWKS_URL"):
        _validate(_settings(oidc_id_token_alg="RS256", oidc_shared_secret="", jwks_url=""))


def test_asymmetric_alg_with_a_jwks_url_boots():
    _validate(
        _settings(
            oidc_id_token_alg="RS256",
            oidc_shared_secret="",
            jwks_url="https://idp.test/jwks.json",
        )
    )


def test_unsupported_algorithm_refuses_to_boot():
    with pytest.raises(RuntimeError, match="OIDC_ID_TOKEN_ALG"):
        _validate(_settings(oidc_id_token_alg="HS1"))


def test_none_algorithm_refuses_to_boot():
    """`none` must not even be configurable, let alone accepted at runtime."""
    with pytest.raises(RuntimeError, match="OIDC_ID_TOKEN_ALG"):
        _validate(_settings(oidc_id_token_alg="none"))


def test_identity_is_not_enabled_without_verification_material():
    """Issuer and client id alone are not 'configured'. Without a key, tokens
    would either all fail or — far worse — be waved through."""
    assert _settings(oidc_shared_secret="").identity_enabled is False
    assert _settings().identity_enabled is True


@pytest.mark.parametrize(
    "alg,symmetric",
    [("HS256", True), ("HS512", True), ("RS256", False), ("ES256", False)],
)
def test_symmetric_detection(alg, symmetric):
    assert _settings(
        oidc_id_token_alg=alg,
        oidc_shared_secret=SHARED_SECRET if symmetric else "",
        jwks_url="" if symmetric else "https://idp.test/jwks.json",
    ).uses_shared_secret is symmetric


def test_no_litellm_at_all_is_allowed():
    """A deployment that only manages devices is legitimate; /health says so."""
    settings = _settings()
    assert settings.litellm_enabled is False
    _validate(settings)  # must not raise


def test_development_warns_instead_of_refusing():
    """Same problems, no exception — a developer must be able to run this."""
    _validate(_settings(environment="development", secret_key="change-me-in-production"))


# ── Derived settings ─────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "configured,expected",
    [
        ("", ""),
        ("/netmind-extension", "/netmind-extension"),
        ("netmind-extension/", "/netmind-extension"),
        ("/netmind-extension/", "/netmind-extension"),
        # A pasted-in URL degrades to its path rather than mounting the whole API
        # under a garbage prefix.
        ("https://netmind.example.com/netmind-extension", "/netmind-extension"),
    ],
)
def test_mount_prefix_normalisation(configured, expected):
    assert _settings(api_base_path=configured).api_base_prefix == expected


def test_issuer_trailing_slash_is_normalised():
    assert _settings(oidc_issuer=f"{ISSUER}/").issuer == ISSUER


def test_extra_audiences_allow_a_client_id_migration():
    """Both ids accepted at once, so a migration needs no flag day."""
    settings = _settings(oidc_extra_audiences="old-client-id, another")
    assert settings.audiences == ["netmind-extension", "old-client-id", "another"]


# ── /health ──────────────────────────────────────────────────────────────────

def test_health_reports_each_dependency(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["checks"]["database"] == "ok"
    assert body["checks"]["identity"] == "ok"
    assert body["checks"]["litellm"] == "ok"
    assert body["checks"]["key_encryption"] == "ok"


def test_health_needs_no_authentication(client):
    assert client.get("/health").status_code == 200


def test_auth_providers_advertises_the_wrapper(client):
    body = client.get("/api/auth/providers").json()
    native = body["providers"][0]["native_oidc"]
    assert native["issuer"] == ISSUER
    assert native["client_id"] == "netmind-extension"
    # Public client: PKCE authenticates the exchange and no secret exists.
    assert native["confidential"] is False
    assert native["id_token_signed_response_alg"] == "HS256"


def test_auth_providers_carries_the_endpoints_discovery_would_have_supplied(client):
    """The wrapper serves no /.well-known/openid-configuration, so a client that
    reads this route must get everything it needs to start a sign-in."""
    native = client.get("/api/auth/providers").json()["providers"][0]["native_oidc"]
    assert native["authorization_endpoint"] == f"{ISSUER}/authorize"
    assert native["token_endpoint"] == f"{ISSUER}/token"


def test_auth_providers_names_the_id_token_as_the_bearer_when_verifying_locally(client):
    native = client.get("/api/auth/providers").json()["providers"][0]["native_oidc"]
    assert native["bearer_token"] == "id_token"


def test_auth_providers_names_the_access_token_as_the_bearer_in_userinfo_mode(
    monkeypatch, fake_http
):
    """A client cannot work this out for itself.

    The wrapper's /userinfo recognises only the opaque access token it minted and
    answers 401 for an ID token that was never in any store to be found. Which
    token to send is therefore a fact about how *this* service verifies, and
    advertising it keeps a change of mode an environment change rather than a new
    build of every installed extension.
    """
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("OIDC_USERINFO_ENDPOINT", f"{ISSUER}/userinfo")
    get_settings.cache_clear()
    application = create_app()
    with TestClient(application) as test_client:
        application.state.http_client = fake_http
        native = test_client.get("/api/auth/providers").json()["providers"][0]["native_oidc"]
    get_settings.cache_clear()

    assert native["bearer_token"] == "access_token"


def test_auth_providers_never_leaks_the_signing_secret(client):
    """This route is public and unauthenticated. The shared secret is a signing
    key — leaking it here would hand anybody the ability to mint identities."""
    body = client.get("/api/auth/providers").text
    assert SHARED_SECRET not in body
    assert "sk-admin" not in body
    assert "shared_secret" not in body.lower()
