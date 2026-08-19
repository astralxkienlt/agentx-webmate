"""netMind Extension backend — telemetry ingest and SSO → LLM key provisioning.

One process, two surfaces, no role split: everything mounts everywhere. There is
deliberately **no dashboard read API** here. Telemetry is collected and stored;
whatever reads it later is a separate service with its own authentication story,
and keeping it out means this public-facing process cannot leak what it does not
serve.
"""
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi.errors import RateLimitExceeded
from sqlalchemy import text

from app.api.background_logs import router as background_logs_router
from app.api.logs_ingest import router as logs_ingest_router
from app.core.config import get_settings, validate_security
from app.core.database import Base, engine
from app.core.errors import register_exception_handlers
from app.core.logging import RequestLogMiddleware, configure_logging
from app.models.app_log import APP_LOGS_DDL
from app.proxy.ratelimit import limiter, rate_limit_exceeded_handler
from app.proxy.routes import auth_providers, devices, provision, secrets

# Import for side effects: each module registers its tables on Base.metadata or
# its handler in the provider registry.
import app.models.app_log  # noqa: F401,E402
import app.models.identity  # noqa: F401,E402
import app.models.keys  # noqa: F401,E402
import app.models.telemetry  # noqa: F401,E402
import app.proxy.providers.litellm_handler  # noqa: F401,E402

_DESCRIPTION = """
Backend for the netMind browser extension.

**Provisioning** (`/v1/*`) — the extension exchanges its Keycloak ID token for a
LiteLLM model key. One key per person, minted once, reused by every browser they
sign in from. The gateway admin key exists only on this server and is never sent
to a client.

**Telemetry ingest** (`/api/background-logs/*`, `/api/logs`) — usage, tool counts
and structured logs are collected and stored. This service does not read them
back; a dashboard is a separate concern.

## Authentication
- Provisioning: `Authorization: Bearer <id_token>` plus the `X-AgentX-Device` header.
- Ingest: the same bearer, or a shared `X-Auth-Key` for clients that have not
  signed in — rows from the latter are marked `identity_verified = false`.

## Errors
Flat bodies: `{"error": "device_revoked", "detail": "…"}`. Switch on `error`;
`detail` is prose and will be reworded. A `503` always means *keep the key you
have and retry later* — never *sign out*.
"""

_TAGS_METADATA = [
    {"name": "provision", "description": "SSO → LLM key provisioning."},
    {"name": "secrets", "description": "Read an already-provisioned secret."},
    {"name": "devices", "description": "Identity probe and device management."},
    {"name": "auth", "description": "Public OIDC discovery for clients."},
    {"name": "telemetry", "description": "Client telemetry ingestion."},
    {"name": "client-logs", "description": "Batched structured client logs."},
    {"name": "health", "description": "Service health."},
]

# Arbitrary constant identifying the schema-init advisory lock (any bigint).
_SCHEMA_LOCK_KEY = 918274


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging()  # before anything logs
    validate_security()  # refuse to boot on an unsafe or incomplete config

    async with engine.begin() as conn:
        if not settings.is_sqlite:
            # Serialise create_all across replicas booting together: the first
            # one runs the DDL, the others block and then find it already done.
            # Released on commit.
            await conn.execute(
                text("SELECT pg_advisory_xact_lock(:k)"), {"k": _SCHEMA_LOCK_KEY}
            )
            # app_logs is partitioned, which create_all cannot express — build
            # the parent first so create_all sees it exists and skips it.
            for stmt in APP_LOGS_DDL:
                await conn.execute(text(stmt))
        await conn.run_sync(Base.metadata.create_all)

    # One shared client for every outbound call: JWKS fetches and LiteLLM admin
    # requests. Connection reuse, and one place to bound timeouts.
    async with httpx.AsyncClient() as client:
        app.state.http_client = client
        yield


def create_app() -> FastAPI:
    settings = get_settings()
    base = settings.api_base_prefix

    # Interactive docs map the whole API, including which headers carry
    # credentials. Fine in development, withheld in production.
    docs_on = not settings.is_production

    app = FastAPI(
        title="netMind Extension Backend",
        version="1.0.0",
        description=_DESCRIPTION,
        openapi_tags=_TAGS_METADATA,
        docs_url=f"{base}/api/docs" if docs_on else None,
        redoc_url=f"{base}/api/redoc" if docs_on else None,
        openapi_url=f"{base}/api/openapi.json" if docs_on else None,
        redirect_slashes=False,  # a 307 would drop the mount prefix
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,  # explicit allowlist, never "*"
        allow_credentials=False,  # bearer tokens, not cookies
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Auth-Key",
            "X-AgentX-Device",
            "X-AgentX-Device-Name",
        ],
    )
    app.add_middleware(RequestLogMiddleware)

    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
    register_exception_handlers(app)

    # ── Provisioning ─────────────────────────────────────────────────────────
    app.include_router(provision.router, prefix=base)
    app.include_router(secrets.router, prefix=base)
    app.include_router(devices.router, prefix=base)
    app.include_router(auth_providers.router, prefix=base)

    # ── Telemetry ingest ─────────────────────────────────────────────────────
    app.include_router(
        background_logs_router, prefix=f"{base}/api/background-logs", tags=["telemetry"]
    )
    app.include_router(logs_ingest_router, prefix=f"{base}/api/logs", tags=["client-logs"])

    @app.get("/health", tags=["health"], summary="Service health")
    async def health() -> dict:
        # Stays at the root path whatever the mount prefix, so the container
        # healthcheck can hit uvicorn directly and bypass nginx.
        #
        # Reports each dependency honestly rather than collapsing them: a
        # deployment that only manages devices is legitimate, and answering 503
        # because LiteLLM is unset would take a working service out of the load
        # balancer for a feature nobody asked it to serve.
        ok = True
        checks: dict[str, str] = {}
        try:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            checks["database"] = "ok"
        except Exception as e:  # noqa: BLE001 — health must never raise
            logging.getLogger("uvicorn.error").warning("health: database check failed: %s", e)
            checks["database"] = "unavailable"
            ok = False  # only Postgres can fail this service

        checks["identity"] = "ok" if settings.identity_enabled else "unconfigured"
        checks["litellm"] = "ok" if settings.litellm_enabled else "unconfigured"
        checks["key_encryption"] = "ok" if settings.brain_kek else "unconfigured"

        return {
            "status": "ok" if ok else "degraded",
            "environment": settings.environment,
            "checks": checks,
        }

    return app


app = create_app()
