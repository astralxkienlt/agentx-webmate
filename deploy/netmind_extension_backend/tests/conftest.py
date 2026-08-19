"""Test harness.

Environment is set **before** any app module is imported, because
`app.core.database` builds its engine and `app.core.config` its settings at
import time. Importing first and patching after would give every test a
Postgres engine that is not there.

Tokens are signed for real, never faked past the verifier. A test that patches
`verify_id_token` proves nothing about whether verification works, so the suite
carries actual key material:

* the **HS256 shared secret**, matching the Viettel SSO wrapper this deployment
  authenticates against;
* an RSA keypair whose public half is served as a JWKS, exercising the
  asymmetric path that exists for a future hardening of the wrapper.

A scripted LiteLLM gateway stands in for the outside world, so mint/reuse/rotate
can be driven through every branch — including the ones that only happen when
the gateway misbehaves.
"""
import base64
import os
import uuid
from datetime import datetime, timedelta, timezone

# ── Environment, before app imports ──────────────────────────────────────────
# Shaped like the real deployment: the Viettel SSO wrapper, which signs HS256
# and publishes no JWKS.
ISSUER = "https://netmind.viettel.test/sso-wrapper"
CLIENT_ID = "netmind-extension"
LITELLM_BASE = "https://aigw.test"
INGEST_KEY = "test-ingest-key"
# 32+ chars, as validate_security requires of a real deployment.
SHARED_SECRET = "test-shared-secret-at-least-32-chars-long"
# Only used by the asymmetric-path tests; the wrapper publishes no JWKS.
JWKS_URL = "https://idp.test/jwks.json"
KEK = base64.b64encode(b"0" * 32).decode()
KEK_ALT = base64.b64encode(b"1" * 32).decode()

# sqlite by default so the suite runs anywhere with no services. Set
# DATABASE_URL to a Postgres DSN to run the exact same tests against the real
# engine — that is the only way to exercise partitioning, advisory locks and
# multi-row ON CONFLICT, none of which sqlite implements the same way:
#
#   DATABASE_URL=postgresql+asyncpg://postgres:test@localhost:5432/db pytest
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

os.environ.update(
    # The app runs on TestClient's portal loop while assertions run on
    # pytest-asyncio's; a pooled asyncpg connection cannot cross between them.
    DB_DISABLE_POOLING="true",
    ENVIRONMENT="test",
    SECRET_KEY="test-secret",
    OIDC_ISSUER=ISSUER,
    OIDC_CLIENT_ID=CLIENT_ID,
    OIDC_ID_TOKEN_ALG="HS256",
    OIDC_SHARED_SECRET=SHARED_SECRET,
    OIDC_AUTHORIZATION_ENDPOINT=f"{ISSUER}/authorize",
    OIDC_TOKEN_ENDPOINT=f"{ISSUER}/token",
    LITELLM_BASE_URL=LITELLM_BASE,
    LITELLM_ADMIN_KEY="sk-admin-test",
    LITELLM_TEAM_ID="team-test",
    BRAIN_KEK=KEK,
    BRAIN_KEK_ID="k1",
    INGEST_AUTH_KEY=INGEST_KEY,
    LOG_DIR="/tmp/netmind-extension-test-logs",
    LOG_LEVEL="WARNING",
    RATE_LIMIT_PER_MIN="1000",
)

import httpx  # noqa: E402
import pytest  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from jose import jwk, jwt  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.core.database import Base, engine  # noqa: E402

KID = "test-key-1"
SUBJECT = "user-abc-123"

# One keypair for the whole session: generating RSA per test is slow enough to
# be noticeable and buys nothing.
_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_private_pem = _private_key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode()
_public_pem = (
    _private_key.public_key()
    .public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    .decode()
)

# A second keypair, for tokens signed by a key the realm does not advertise.
_other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_PRIVATE_PEM = _other_key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode()

_JWK = {**jwk.construct(_public_pem, "RS256").to_dict(), "kid": KID, "use": "sig", "alg": "RS256"}
# jose renders JWK members as bytes; the wire format is str.
JWKS_DOCUMENT = {
    "keys": [{k: (v.decode() if isinstance(v, bytes) else v) for k, v in _JWK.items()}]
}


def make_token(
    *,
    subject: str = SUBJECT,
    email: str = "kien@example.test",
    preferred_username: str = "kienlt",
    name: str = "Le Trung Kien",
    issuer: str = ISSUER,
    audience: str | list[str] = CLIENT_ID,
    expires_in: int = 600,
    algorithm: str = "HS256",
    key: str | None = None,
    kid: str | None = None,
) -> str:
    """Mint an ID token the way the SSO wrapper does.

    Defaults produce a valid HS256 token; override exactly one thing to test
    that one thing. `key` overrides the signing material, which is how a
    wrong-secret or wrong-keypair token is produced.
    """
    now = datetime.now(timezone.utc)
    claims = {
        "sub": subject,
        "iss": issuer,
        "aud": audience,
        "exp": int((now + timedelta(seconds=expires_in)).timestamp()),
        "iat": int(now.timestamp()),
        "email": email,
        "preferred_username": preferred_username,
        "name": name,
    }
    if key is None:
        key = SHARED_SECRET if algorithm.startswith("HS") else _private_pem
    # The wrapper sends no `kid` — with a symmetric secret there is nothing to
    # select between, and honouring a token's own key hint is how key-confusion
    # bugs begin.
    headers = {"kid": kid} if kid else None
    return jwt.encode(claims, key, algorithm=algorithm, headers=headers)


USERINFO_URL = f"{ISSUER}/userinfo"


class FakeGateway:
    """Scripted JWKS + LiteLLM, driven over httpx's MockTransport.

    Every knob exists because some branch of the production code only runs when
    the outside world misbehaves, and those branches are the ones worth testing.
    """

    def __init__(self) -> None:
        self.jwks_status = 200
        self.jwks_error: Exception | None = None
        self.jwks_document = JWKS_DOCUMENT
        self.jwks_calls = 0

        # Scripted /userinfo, for the mode where the issuer is asked about a
        # bearer instead of its signature being checked here.
        self.userinfo_status = 200
        self.userinfo_error: Exception | None = None
        self.userinfo_calls = 0
        # Set to raw text to answer like something in FRONT of the issuer: a
        # refusal with no OAuth error object, which says nothing about a token.
        self.userinfo_raw_error: str | None = None
        self.userinfo_document: dict | list | None = {
            "sub": SUBJECT,
            "email": "kien@example.test",
            "preferred_username": "kienlt",
            "name": "Le Trung Kien",
        }

        self.generate_status = 200
        self.generate_calls = 0
        self.generated_keys: list[str] = []
        self.generate_bodies: list[dict] = []
        self.gateway_error: Exception | None = None

        # None → key/info is unreachable, which must read as "unknown", not "gone".
        self.key_info_status: int | None = 200
        self.key_info_blocked = False
        self.deleted_tokens: list[str] = []
        self.delete_status = 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)

        if url.startswith(JWKS_URL):
            self.jwks_calls += 1
            if self.jwks_error:
                raise self.jwks_error
            if self.jwks_status != 200:
                return httpx.Response(self.jwks_status, json={"error": "nope"})
            return httpx.Response(200, json=self.jwks_document)

        if url.startswith(USERINFO_URL):
            self.userinfo_calls += 1
            if self.userinfo_error:
                raise self.userinfo_error
            if self.userinfo_status != 200:
                if self.userinfo_raw_error is not None:
                    return httpx.Response(
                        self.userinfo_status,
                        text=self.userinfo_raw_error,
                        headers={"content-type": "text/html"},
                    )
                return httpx.Response(
                    self.userinfo_status,
                    json={"error": "invalid_token", "error_description": "Token not found or expired"},
                )
            return httpx.Response(200, json=self.userinfo_document)

        if self.gateway_error and url.startswith(LITELLM_BASE):
            raise self.gateway_error

        if url.startswith(f"{LITELLM_BASE}/key/generate"):
            self.generate_calls += 1
            if self.generate_status != 200:
                return httpx.Response(self.generate_status, json={"error": "refused"})
            import json as _json

            body = _json.loads(request.read() or b"{}")
            self.generate_bodies.append(body)
            key = f"sk-generated-{self.generate_calls}"
            self.generated_keys.append(key)
            return httpx.Response(
                200,
                json={
                    "key": key,
                    "token": f"token-{self.generate_calls}",
                    "key_alias": body.get("key_alias", ""),
                    "user_id": "litellm-user-1",
                },
            )

        if url.startswith(f"{LITELLM_BASE}/key/info"):
            if self.key_info_status is None:
                raise httpx.ConnectError("gateway down")
            if self.key_info_status != 200:
                return httpx.Response(self.key_info_status, json={"error": "gone"})
            return httpx.Response(200, json={"info": {"blocked": self.key_info_blocked}})

        if url.startswith(f"{LITELLM_BASE}/key/delete"):
            import json as _json

            body = _json.loads(request.read() or b"{}")
            self.deleted_tokens.extend(body.get("keys", []))
            return httpx.Response(self.delete_status, json={"deleted": True})

        return httpx.Response(404, json={"error": "unexpected", "url": url})


@pytest.fixture
def gateway() -> FakeGateway:
    return FakeGateway()


@pytest.fixture
def fake_http(gateway: FakeGateway) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(gateway.handler))


@pytest.fixture(autouse=True)
async def _reset_state():
    """Fresh schema and a cold JWKS cache for every test.

    The schema is dropped rather than truncated so a test that changes a model
    cannot pass against the previous test's tables.

    On Postgres this mirrors the production startup sequence exactly — raw
    partitioned DDL first, then `create_all` — because building `app_logs` with
    `create_all` alone would produce an ordinary table, and every partition test
    would then pass against a shape production never has.
    """
    from sqlalchemy import text

    from app.auth.jwks import get_jwks_cache
    from app.core.config import get_settings as _get
    from app.models.app_log import APP_LOGS_DDL

    get_settings.cache_clear()
    get_jwks_cache().clear()
    is_sqlite = _get().is_sqlite

    async with engine.begin() as conn:
        if not is_sqlite:
            # CASCADE takes the month partitions with the parent; drop_all cannot
            # see them because they were never declared on the metadata.
            await conn.execute(text("DROP TABLE IF EXISTS app_logs CASCADE"))
        await conn.run_sync(Base.metadata.drop_all)
        if not is_sqlite:
            for statement in APP_LOGS_DDL:
                await conn.execute(text(statement))
        await conn.run_sync(Base.metadata.create_all)
    yield


@pytest.fixture
def app(fake_http):
    from app.main import create_app

    application = create_app()
    return application


@pytest.fixture
def client(app, fake_http):
    with TestClient(app) as test_client:
        # The lifespan opened a real client; swap in the scripted one so no test
        # can reach the network.
        app.state.http_client = fake_http
        yield test_client


def auth_headers(token: str | None = None, device: str | None = None) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token or make_token()}"}
    headers["X-AgentX-Device"] = device or str(uuid.uuid4())
    return headers


def device_id() -> str:
    return str(uuid.uuid4())
