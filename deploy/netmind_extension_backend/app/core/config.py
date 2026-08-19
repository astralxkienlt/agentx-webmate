"""Service configuration.

Two rules shape this file:

1. **Resolve eager and whole.** A deployment either has every field a route
   needs, or it refuses to boot naming the field it lacks. A service that starts
   green and only discovers at 09:00 that it has no realm to verify against is a
   service that breaks while someone is signing in, instead of while you are
   looking at the deploy screen (integration spec §9).
2. **The backend never knows its own domain.** Only paths. Which host serves it
   is nginx's business; which hosts may call it is `CORS_ORIGINS`.
"""
import logging
from functools import lru_cache
from urllib.parse import urlparse

from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("uvicorn.error")

_INSECURE_DEFAULTS = {
    "secret_key": {"", "change-me-in-production"},
}

# All four must be present before the LiteLLM provisioning routes will mint.
# Missing any one → /v1/provision-keys answers 503 litellm_unconfigured rather
# than 500, because 503 is the status that tells a laptop "keep the key you have
# and come back later" — exactly right while an operator fixes the deploy.
_LITELLM_REQUIRED = ("litellm_base_url", "litellm_admin_key")

# Identity is not optional: without a realm there is nothing to verify a bearer
# against, and every authenticated route would fail closed.
_OIDC_REQUIRED = ("oidc_issuer", "oidc_client_id")

# Algorithms this service will verify with. `none` is absent by construction,
# and so is any alg the JOSE libraries would otherwise happily accept.
_SUPPORTED_ALGS = (
    "HS256", "HS384", "HS512",
    "RS256", "RS384", "RS512",
    "ES256", "ES384", "ES512",
    "PS256", "PS384", "PS512",
)

# 32 characters of shared secret. HMAC secrets are attacked offline against a
# single captured token, so a short one is a forgeable identity for anyone who
# sees one request.
_MIN_SHARED_SECRET_LEN = 32


def _mount_prefix(path: str) -> str:
    """Normalise a mount sub-path: leading slash, no trailing slash ("" = root).

    FastAPI rejects a router prefix ending in "/". Accepts a full URL too and
    takes its path, so a pasted-in URL degrades to the right thing instead of
    mounting the whole API under a garbage prefix.
    """
    stripped = urlparse(path).path.strip("/")
    return f"/{stripped}" if stripped else ""


class Settings(BaseSettings):
    # ── Core ─────────────────────────────────────────────────────────────────
    database_url: str = "postgresql+asyncpg://postgres:password@0.0.0.0:5432/netmind_extension"
    secret_key: str = "change-me-in-production"
    environment: str = "development"

    # Sub-path the reverse proxy serves this API under, e.g. "/netmind-extension".
    # A PATH, not a URL. nginx forwards the full public path unchanged and the
    # routers mount under it. `/health` stays at root regardless so the container
    # healthcheck bypasses nginx.
    api_base_path: str = ""

    # Comma-separated origins allowed to call this API from a browser. NEVER "*".
    # A browser extension calls from its own origin (chrome-extension://<id>),
    # which must be listed here explicitly.
    cors_origins: str = ""

    log_level: str = "INFO"
    log_dir: str = "logs"

    # SQLAlchemy async pool sizing. Total connections a deployment can open =
    # replicas × workers × (pool_size + max_overflow). Keep under Postgres
    # max_connections (default 100).
    db_pool_size: int = 5
    db_max_overflow: int = 5
    # Open a fresh connection per checkout instead of pooling. Two reasons to
    # turn this on: running behind PgBouncer in transaction mode, where a second
    # pool on this side buys nothing and confuses connection accounting; and the
    # test suite, where the app and the assertions run on different event loops
    # and a pooled asyncpg connection cannot legally cross between them.
    db_disable_pooling: bool = False

    # ── Identity (Viettel SSO wrapper) ───────────────────────────────────────
    # The issuer the extension signs into. `oidc_issuer` must match the `iss`
    # claim byte-for-byte (trailing slash forgiven) and `oidc_client_id` must
    # match `aud` — pinning aud is what stops a token minted for another client
    # being replayed here.
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    # Extra audiences accepted besides oidc_client_id, comma-separated. Empty in
    # normal deployments; exists so a client-id migration can run without a
    # flag-day where every installed extension breaks at once.
    oidc_extra_audiences: str = ""
    oidc_scopes: str = "openid profile email"

    # The ONE algorithm this deployment accepts. Pinning it is the whole
    # defence against algorithm confusion, and it works in both directions: a
    # token arriving under any other alg — `none`, or RS256 where we expect
    # HS256, or the reverse — is refused before a key is ever selected.
    #
    # The Viettel SSO wrapper signs with HS256, so that is the default.
    oidc_id_token_alg: str = "HS256"

    # Shared signing secret, required when `oidc_id_token_alg` is symmetric
    # (HS*). This is the same secret the SSO wrapper signs with.
    #
    # HS256 is symmetric: whatever can verify a token can also MINT one. This
    # value is therefore a signing key, not merely a verification key. Keep it
    # out of the extension, out of logs and out of version control, and give it
    # the same handling as BRAIN_KEK.
    oidc_shared_secret: str = ""

    # Verify a bearer by asking the issuer who it belongs to, instead of
    # checking a signature here. Set this when the issuer signs with a key it
    # gives nobody: the Viettel SSO wrapper signs HS256 with a secret held only
    # by the wrapper process and serves no JWKS, so there is no key to verify
    # against and no client registry to obtain one from. Set = userinfo mode,
    # and the token's own claims (including `aud`) are then ignored entirely.
    # Empty = verify the signature locally, the default everywhere else.
    oidc_userinfo_endpoint: str = ""
    # How long a userinfo answer is trusted. Every verification is a network
    # round trip otherwise, and one sign-in makes several. Keep it short: this
    # window is also how long a token revoked at the issuer keeps working here.
    oidc_userinfo_cache_seconds: int = 60
    oidc_userinfo_timeout: float = 5.0

    # Used only when `oidc_id_token_alg` is asymmetric (RS*/ES*/PS*), where the
    # issuer publishes a JWKS instead. Left in place so that hardening the
    # wrapper to RS256 later is an environment change rather than a rewrite.
    jwks_url: str = ""
    jwks_cache_seconds: int = 600
    jwks_timeout: float = 5.0

    # Clock skew allowed on exp/iat, in seconds. Laptops drift.
    jwt_leeway_seconds: int = 60

    # The wrapper publishes no /.well-known/openid-configuration, so the two
    # endpoints discovery would have supplied are named here and handed to
    # clients by /api/auth/providers. Both or neither.
    oidc_authorization_endpoint: str = ""
    oidc_token_endpoint: str = ""

    # ── LiteLLM gateway ──────────────────────────────────────────────────────
    # The admin key exists ONLY here. It is never packaged into the extension —
    # that is the exact failure this architecture is built to prevent.
    #
    # Where THIS SERVICE reaches the gateway: the admin paths (/key/generate,
    # /model/info) hang off it, so it must NOT end in "/v1".
    litellm_base_url: str = ""
    # Where the EXTENSION is told to send inference. Separate from the line
    # above because the two surfaces are not published together: the admin API
    # stays on the internal network, while a browser can only reach the public
    # HTTPS host — and a browser extension is a secure origin, so a plain-http
    # internal URL is refused as mixed content before the request is even made.
    # Empty falls back to litellm_base_url, which is right when one URL serves
    # both. Like the line above, no trailing "/v1" — the client appends it.
    litellm_public_base_url: str = ""
    litellm_admin_key: str = ""
    litellm_team_id: str = ""
    litellm_timeout: float = 10.0
    # Alias prefix for minted keys: "[{prefix}][{email}]". Only a label for
    # the LiteLLM console — never a handle. Keys are deleted by token, never by
    # alias (spec R5).
    key_alias_prefix: str = "netmind-extension"

    # ── Key envelope (AES-256-GCM) ───────────────────────────────────────────
    # 32 raw bytes, base64. Generate: openssl rand -base64 32
    # Losing this loses every stored key — nothing can decrypt them and the only
    # recovery is deleting the rows so everyone re-mints. BACK IT UP OFF-HOST.
    brain_kek: str = ""
    brain_kek_id: str = "k1"
    # Set both during a KEK rotation; rows migrate to the new KEK as their owner
    # next asks for a key. No downtime window.
    brain_kek_previous: str = ""
    brain_kek_previous_id: str = ""

    # ── Telemetry ingest ─────────────────────────────────────────────────────
    # Fallback shared secret for clients that have not signed in. A browser
    # extension cannot keep a secret — anyone can read it out of the bundle — so
    # rows authenticated this way are stored with identity_verified = false and
    # must never be mixed with token-verified rows in a report that matters.
    # Empty disables the fallback entirely (token-only ingest).
    ingest_auth_key: str = ""
    # Retention window for app_logs, in days. Also settable at runtime from the
    # database; this is only the bootstrap default.
    log_retention_days: int = 60

    # ── Rate limiting ────────────────────────────────────────────────────────
    # Per-subject, in-memory → per worker process. Effective limit is
    # workers × replicas × this value.
    rate_limit_per_min: int = 30

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ── Derived ──────────────────────────────────────────────────────────────

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in ("production", "prod")

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def api_base_prefix(self) -> str:
        return _mount_prefix(self.api_base_path)

    @property
    def issuer(self) -> str:
        """Configured issuer without a trailing slash, for comparing to `iss`."""
        return self.oidc_issuer.rstrip("/")

    @property
    def audiences(self) -> list[str]:
        """Every `aud` value this service accepts."""
        extra = [a.strip() for a in self.oidc_extra_audiences.split(",") if a.strip()]
        return [self.oidc_client_id, *extra] if self.oidc_client_id else extra

    @property
    def id_token_alg(self) -> str:
        return self.oidc_id_token_alg.strip().upper()

    @property
    def uses_userinfo(self) -> bool:
        """True when the issuer is asked about a bearer rather than checked locally."""
        return bool(self.oidc_userinfo_endpoint.strip())

    @property
    def uses_shared_secret(self) -> bool:
        """True when the configured algorithm is symmetric (HMAC)."""
        return self.id_token_alg.startswith("HS")

    @property
    def identity_enabled(self) -> bool:
        """True once tokens can actually be verified.

        Issuer and client id alone are not enough: without the material to check
        a signature with, every token would either be refused or — far worse —
        waved through. So the key for the configured algorithm counts as part of
        being configured at all.
        """
        if not all(getattr(self, f) for f in _OIDC_REQUIRED):
            return False
        if self.uses_userinfo:
            # Nothing local is needed: the issuer itself is the check.
            return True
        return bool(self.oidc_shared_secret) if self.uses_shared_secret else bool(self.jwks_url)

    @property
    def litellm_enabled(self) -> bool:
        """True once provisioning has everything it needs to mint."""
        return all(getattr(self, f) for f in _LITELLM_REQUIRED)

    @property
    def litellm_client_base_url(self) -> str:
        """The gateway URL handed to clients, public one preferred.

        Authoritative on the wire: the extension overwrites whatever it had
        configured with this value, so a URL only this service can reach would
        strand every client that just signed in successfully.
        """
        return (self.litellm_public_base_url or self.litellm_base_url).rstrip("/")

    @property
    def cors_origin_list(self) -> list[str]:
        if self.cors_origins.strip():
            return [o.strip() for o in self.cors_origins.split(",") if o.strip()]
        # Dev fallback. Extensions call from chrome-extension://<id>, which has
        # no sensible default — production must set CORS_ORIGINS explicitly.
        return ["http://localhost:5173", "http://127.0.0.1:5173"]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings. Tests call `get_settings.cache_clear()` after patching env."""
    return Settings()


settings = get_settings()


def validate_security() -> None:
    """Refuse to boot a production deployment that cannot do its job safely.

    Split deliberately into fatal and advisory. A missing LiteLLM config is
    advisory because a deployment that only manages devices is legitimate and
    /health reports it honestly; a missing realm is fatal because every
    authenticated route would 503 and the service would be furniture.
    """
    s = get_settings()
    problems: list[str] = []

    for field, bad in _INSECURE_DEFAULTS.items():
        if getattr(s, field) in bad:
            problems.append(field.upper())

    missing_oidc = [f.upper() for f in _OIDC_REQUIRED if not getattr(s, f)]
    if missing_oidc:
        problems.append("identity unconfigured, missing " + ", ".join(missing_oidc))

    # An algorithm outside the supported set would leave every token unverifiable
    # once traffic starts, which is a fault worth discovering on the deploy screen.
    if s.id_token_alg not in _SUPPORTED_ALGS:
        problems.append(
            f"OIDC_ID_TOKEN_ALG must be one of {', '.join(_SUPPORTED_ALGS)}, "
            f"got '{s.oidc_id_token_alg}'"
        )
    elif s.uses_userinfo:
        # No local key is wanted or checked in this mode. The alg above still
        # matters — it is reported to clients, which refuse a token that arrives
        # under a different one — but nothing here needs material to verify with.
        pass
    elif s.uses_shared_secret and not s.oidc_shared_secret:
        problems.append(
            f"OIDC_SHARED_SECRET is required for {s.id_token_alg} (the SSO wrapper "
            f"signs symmetrically, so this service needs the same secret to verify)"
        )
    elif not s.uses_shared_secret and not s.jwks_url:
        problems.append(f"JWKS_URL is required for {s.id_token_alg}")

    # A short HMAC secret is brute-forceable offline against any captured token,
    # and forging one then mints an identity of the attacker's choosing.
    if s.uses_shared_secret and s.oidc_shared_secret and not s.uses_userinfo:
        if len(s.oidc_shared_secret) < _MIN_SHARED_SECRET_LEN:
            problems.append(
                f"OIDC_SHARED_SECRET must be at least {_MIN_SHARED_SECRET_LEN} "
                f"characters (it is a signing key, not a password)"
            )

    if not s.brain_kek:
        problems.append("BRAIN_KEK (key encryption at rest)")
    if s.brain_kek_previous and not s.brain_kek_previous_id:
        problems.append("BRAIN_KEK_PREVIOUS set without BRAIN_KEK_PREVIOUS_ID")

    if s.cors_origins.strip() == "*":
        problems.append("CORS_ORIGINS must not be '*'")

    # Half-configured LiteLLM is worse than none: the routes mount and then fail
    # per-request in a way that looks like an outage rather than a config gap.
    missing_litellm = [f.upper() for f in _LITELLM_REQUIRED if not getattr(s, f)]
    if missing_litellm and len(missing_litellm) != len(_LITELLM_REQUIRED):
        problems.append("LiteLLM partially configured, missing " + ", ".join(missing_litellm))

    if s.is_production and problems:
        raise RuntimeError(
            "Refusing to start in production with insecure or incomplete config: "
            + "; ".join(problems)
            + ". Set these via environment variables."
        )
    if problems:
        logger.warning(
            "CONFIG: %s — acceptable in dev, MUST be set in production.",
            "; ".join(problems),
        )
    if not s.litellm_enabled:
        logger.warning(
            "LiteLLM not configured: /v1/provision-keys will answer 503 "
            "litellm_unconfigured. Device management still works."
        )
