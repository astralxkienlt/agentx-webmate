"""Thin client for the LiteLLM admin API.

Every function here maps gateway outcomes onto the three wire errors that mean
different things to a laptop:

    unreachable / timeout  → LiteLLMUnavailableError (503)  nothing was minted
    answered, said no      → LiteLLMRefusedError (502)      this request is wrong
    not configured         → LiteLLMUnconfiguredError (503) operator must act

The admin key lives only in this process. It is never returned, never logged,
and never travels to a client — packaging it into the client is the failure this
whole architecture exists to prevent.
"""
import json
from dataclasses import dataclass

import httpx
from loguru import logger

from app.core.config import Settings, get_settings
from app.core.errors import (
    LiteLLMRefusedError,
    LiteLLMUnavailableError,
    LiteLLMUnconfiguredError,
)

@dataclass(frozen=True)
class MintedKey:
    key: str
    token: str
    key_alias: str
    litellm_user_id: str


def _base(settings: Settings) -> str:
    if not settings.litellm_enabled:
        raise LiteLLMUnconfiguredError(
            "LiteLLM is not configured on this deployment; set LITELLM_BASE_URL "
            "and LITELLM_ADMIN_KEY"
        )
    return str(settings.litellm_base_url).rstrip("/")


def _headers(settings: Settings) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.litellm_admin_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


async def _request(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    settings: Settings,
    *,
    json_body: dict | None = None,
    params: dict | None = None,
) -> httpx.Response:
    url = f"{_base(settings)}{path}"
    try:
        return await client.request(
            method,
            url,
            headers=_headers(settings),
            json=json_body,
            params=params,
            timeout=settings.litellm_timeout,
        )
    except httpx.TimeoutException as e:
        logger.warning(f"[LiteLLM] timeout after {settings.litellm_timeout}s path={path}")
        raise LiteLLMUnavailableError("LiteLLM timed out") from e
    except httpx.HTTPError as e:
        logger.error(f"[LiteLLM] network error err={type(e).__name__} path={path}")
        raise LiteLLMUnavailableError("LiteLLM unreachable") from e


def _json_or_refuse(response: httpx.Response, what: str) -> dict:
    try:
        payload = response.json()
    except ValueError as e:
        logger.error(f"[LiteLLM] {what}: non-JSON body")
        raise LiteLLMRefusedError(f"LiteLLM returned a non-JSON body for {what}") from e
    if not isinstance(payload, dict):
        raise LiteLLMRefusedError(f"LiteLLM returned an unexpected body for {what}")
    return payload


async def generate_key(
    client: httpx.AsyncClient,
    *,
    key_alias: str,
    user_email: str,
    settings: Settings | None = None,
) -> MintedKey:
    """Mint a virtual key. The plaintext in the response is revealed only here.

    No `models` list is sent, deliberately. The key inherits whatever the
    gateway's own permission model grants it — the team's models when
    LITELLM_TEAM_ID names one, the proxy's models otherwise. Curating a list
    here froze every key with the models of its mint day; leaving permission to
    the gateway means a model granted to the team reaches existing keys with no
    re-mint at all.
    """
    settings = settings or get_settings()
    body: dict = {
        "key_alias": key_alias,
        "duration": None,
        "metadata": {"source": "netmind-extension-backend", "user_email": user_email},
    }
    if settings.litellm_team_id:
        body["team_id"] = settings.litellm_team_id

    response = await _request(client, "POST", "/key/generate", settings, json_body=body)
    if response.status_code >= 400:
        logger.warning(f"[LiteLLM] key/generate HTTP {response.status_code}")
        raise LiteLLMRefusedError(
            f"LiteLLM key/generate returned HTTP {response.status_code}"
        )
    payload = _json_or_refuse(response, "key/generate")

    key = payload.get("key")
    if not isinstance(key, str) or not key:
        logger.error("[LiteLLM] key/generate response carried no key")
        raise LiteLLMRefusedError("LiteLLM key/generate response carried no key")

    return MintedKey(
        key=key,
        # `token` is the gateway's handle for this key and the only safe thing to
        # delete later. Absent on some LiteLLM versions, hence the tolerant read.
        token=str(payload.get("token") or ""),
        key_alias=str(payload.get("key_alias") or key_alias),
        litellm_user_id=str(payload.get("user_id") or ""),
    )


async def delete_key_by_token(
    client: httpx.AsyncClient, token: str, settings: Settings | None = None
) -> bool:
    """Retire exactly one key, by token.

    **Never** deletes by alias. Every install belonging to one person shares an
    alias, so an alias-scoped delete kills the key their other browser is using
    (spec R5). Returns False rather than raising: a rotation that could not tidy
    up the old key has still successfully issued the new one, and failing the
    request would be strictly worse than leaving one orphan for an operator to
    sweep up.
    """
    if not token:
        return False
    settings = settings or get_settings()
    try:
        response = await _request(
            client, "POST", "/key/delete", settings, json_body={"keys": [token]}
        )
    except (LiteLLMUnavailableError, LiteLLMUnconfiguredError):
        logger.warning("[LiteLLM] could not reach gateway to delete the retired key")
        return False
    if response.status_code >= 400:
        logger.warning(f"[LiteLLM] key/delete HTTP {response.status_code}")
        return False
    return True


async def key_is_live(
    client: httpx.AsyncClient, key: str, settings: Settings | None = None
) -> bool | None:
    """Is this stored key still usable?

    Returns True (live), False (proven gone) or None (could not tell).

    The three-way answer is the point. "Could not tell" must behave like "live",
    because treating an unreachable gateway as proof of death mints a fresh key
    on every login during an outage — the exact pile-up the stored key exists to
    prevent.
    """
    settings = settings or get_settings()
    try:
        response = await _request(
            client, "GET", "/key/info", settings, params={"key": key}
        )
    except (LiteLLMUnavailableError, LiteLLMUnconfiguredError):
        return None

    if response.status_code in (401, 403, 404):
        # The gateway is up and does not know this key. Definitive.
        logger.warning(f"[LiteLLM] key/info says key is gone (HTTP {response.status_code})")
        return False
    if response.status_code >= 400:
        return None

    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None

    info = payload.get("info")
    if not isinstance(info, dict):
        info = payload
    if info.get("blocked"):
        logger.warning("[LiteLLM] key/info reports the key is blocked")
        return False
    return True


def encode_models(models: list[str]) -> str:
    return json.dumps(models, ensure_ascii=False)


def decode_models(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except ValueError:
        return []
    return [m for m in value if isinstance(m, str)] if isinstance(value, list) else []
