"""JWKS cache, for deployments whose issuer signs asymmetrically.

The Viettel SSO wrapper signs with HS256 and publishes no JWKS, so on the
current configuration nothing in this module runs. It is kept wired up and
tested so that hardening the wrapper to RS256 later is an environment change
(`OIDC_ID_TOKEN_ALG` + `JWKS_URL`) rather than a rewrite — and because an
asymmetric issuer is the arrangement where this service could no longer forge
the tokens it verifies.

Fetch failures raise `IdentityUnavailableError` (503), never
`InvalidTokenError` (401). The difference is the difference between "retry
later" and "sign the whole fleet out".
"""
import asyncio
import time
from dataclasses import dataclass, field

import httpx
from loguru import logger

from app.core.config import Settings
from app.core.errors import IdentityUnavailableError, InvalidTokenError


@dataclass
class _CacheEntry:
    keys: dict[str, dict]
    fetched_at: float


@dataclass
class JwksCache:
    """Fetches and caches an issuer's signing keys.

    One instance per process. Takes its httpx client as an argument so the app's
    shared connection pool is reused and tests can inject a transport without
    monkeypatching module globals.
    """

    _entry: _CacheEntry | None = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def clear(self) -> None:
        self._entry = None

    def _fresh(self, ttl: float) -> bool:
        return self._entry is not None and (time.monotonic() - self._entry.fetched_at) < ttl

    async def _fetch(self, client: httpx.AsyncClient, settings: Settings) -> dict[str, dict]:
        url = settings.jwks_url
        try:
            response = await client.get(
                url, headers={"Accept": "application/json"}, timeout=settings.jwks_timeout
            )
        except httpx.TimeoutException as e:
            logger.warning(f"[JWKS] timeout after {settings.jwks_timeout}s url={url}")
            raise IdentityUnavailableError("identity provider timed out") from e
        except httpx.HTTPError as e:
            logger.warning(f"[JWKS] network error err={type(e).__name__} url={url}")
            raise IdentityUnavailableError("identity provider unreachable") from e

        if response.status_code != 200:
            logger.warning(f"[JWKS] HTTP {response.status_code} url={url}")
            raise IdentityUnavailableError(
                f"identity provider returned HTTP {response.status_code}"
            )
        try:
            payload = response.json()
        except ValueError as e:
            logger.warning("[JWKS] non-JSON body")
            raise IdentityUnavailableError("identity provider returned non-JSON JWKS") from e

        keys = payload.get("keys") if isinstance(payload, dict) else None
        if not isinstance(keys, list) or not keys:
            logger.warning("[JWKS] document contains no keys")
            raise IdentityUnavailableError("identity provider returned an empty JWKS")

        by_kid = {k["kid"]: k for k in keys if isinstance(k, dict) and k.get("kid")}
        if not by_kid:
            logger.warning("[JWKS] no key carried a kid")
            raise IdentityUnavailableError("identity provider returned unusable JWKS")
        logger.info(f"[JWKS] loaded {len(by_kid)} key(s) from {url}")
        return by_kid

    async def get_key(self, kid: str, client: httpx.AsyncClient, settings: Settings) -> dict:
        """The signing key for `kid`, refetching once on a miss (key rollover)."""
        ttl = settings.jwks_cache_seconds
        if self._fresh(ttl) and kid in self._entry.keys:
            return self._entry.keys[kid]

        async with self._lock:
            # Re-check inside the lock: while we waited, another request may have
            # refetched and the key we want may now be present. Without this, a
            # rollover costs one fetch per concurrent request.
            if self._fresh(ttl) and kid in self._entry.keys:
                return self._entry.keys[kid]
            keys = await self._fetch(client, settings)
            self._entry = _CacheEntry(keys=keys, fetched_at=time.monotonic())

        key = self._entry.keys.get(kid)
        if key is None:
            # The issuer was reachable and simply does not have this kid. That is
            # a verdict, not an outage — 401, so the client signs in again.
            logger.warning(f"[JWKS] no key for kid={kid} after refetch")
            raise InvalidTokenError("token signed by an unknown key")
        return key


_cache = JwksCache()


def get_jwks_cache() -> JwksCache:
    return _cache
