"""One model key per person, minted exactly once.

The whole module exists to make this true: **a person has one key, and every
install of theirs receives that same key.** The first call for a `subject` mints
at the gateway; every call after it — from that browser or any other — reads the
stored row and never touches LiteLLM's write API.

Three details make it hold up under concurrency and failure:

*Advisory lock on the mint path.* Two browsers signing in for the first time at
the same moment must not both mint. The lock is taken only on the mint path, so
the common case (reuse) never pays for it. It does hold a database connection
across an HTTP call to the gateway — bounded by `litellm_timeout` — which is the
price of the invariant. Minting happens once per person in their lifetime; the
connection cost is real but rare, and the alternative is an orphaned key at the
gateway for every race.

*Mint → store → delete old, never reordered.* Deleting first means a failed
store loses everybody's access. Deleting last means the worst case is one orphan
key visible at the gateway, which an operator can see and sweep.

*Reuse is verified, but only a proven-dead key is replaced.* `key_is_live`
answers live / gone / unknown. Unknown behaves like live, because treating an
unreachable gateway as proof of death mints a new key on every sign-in during an
outage — the exact pile-up the store exists to prevent.
"""
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx
from loguru import logger
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import Identity
from app.core.config import Settings, get_settings
from app.core.database import AsyncSessionLocal, engine
from app.core.errors import KeyUnreadableError, LiteLLMUnconfiguredError
from app.core.logging import mask_key
from app.models.keys import LlmKey
from app.proxy import crypto, litellm_client

# Status values the client switches on. `reused` is not cosmetic: telling a
# user's second browser that their key was "replaced" describes the fix as
# though it were the bug.
STATUS_ISSUED = "issued"
STATUS_REUSED = "reused"
STATUS_ROTATED = "rotated"


@dataclass(frozen=True)
class KeyResult:
    key: str
    key_alias: str
    token: str
    account: str
    base_url: str
    models: list[str]
    default_model: str
    status: str
    created_at: str
    rotated_at: str | None


def _insert():
    return pg_insert if engine.dialect.name == "postgresql" else sqlite_insert


def _lock_key(subject: str) -> int:
    """A stable 63-bit signed integer for `pg_advisory_xact_lock`."""
    digest = hashlib.sha256(subject.encode("utf-8")).digest()[:8]
    return int.from_bytes(digest, "big") & 0x7FFF_FFFF_FFFF_FFFF


def _alias_for(identity: Identity, settings: Settings) -> str:
    """Console label: `[prefix][email]`, so an operator can read whose key it is.

    Falls back to the account slug for an issuer that supplies no email — the
    alias must still name its owner. Only ever a label: keys are deleted by
    token, never by alias (spec R5).
    """
    who = identity.user_email or identity.account_slug
    return f"[{settings.key_alias_prefix}][{who}]"


def _result_from_row(row: LlmKey, key: str, status: str) -> KeyResult:
    models = litellm_client.decode_models(row.models)
    return KeyResult(
        key=key,
        key_alias=row.key_alias,
        token=row.litellm_token or "",
        account=row.account,
        base_url=row.base_url,
        models=models,
        default_model=row.default_model or (models[0] if models else ""),
        status=status,
        created_at=row.created_at.isoformat() if row.created_at else "",
        rotated_at=row.rotated_at.isoformat() if row.rotated_at else None,
    )


async def _read(subject: str, session: AsyncSession | None = None) -> LlmKey | None:
    """Read a stored key, optionally on a caller-supplied session.

    The mint path passes its own session so that reading and writing under the
    advisory lock costs **one** connection rather than two. With a modest pool
    and a fleet installing the extension on the same morning, taking a second
    connection while already holding one is how every worker ends up waiting for
    a connection that only a waiting worker can release.
    """
    if session is not None:
        return (
            await session.execute(select(LlmKey).where(LlmKey.subject == subject))
        ).scalar_one_or_none()

    async with AsyncSessionLocal() as own:
        row = (
            await own.execute(select(LlmKey).where(LlmKey.subject == subject))
        ).scalar_one_or_none()
        if row is not None:
            own.expunge(row)
    return row


def _unseal(row: LlmKey, settings: Settings) -> str:
    """Open a stored key, or raise the wire error that tells an operator why.

    `key_unreadable` is a 503 rather than a 500: the client should hold onto the
    key it already has while somebody restores the right KEK.
    """
    try:
        return crypto.open_sealed(
            crypto.Sealed(row.ciphertext, row.nonce, row.kek_id), row.subject, settings
        )
    except (crypto.KekMismatchError, crypto.KekUnavailableError) as e:
        logger.error(
            f"[Keys] stored key for subject={row.subject} cannot be opened "
            f"(kek_id={row.kek_id!r}): {e}"
        )
        raise KeyUnreadableError(
            "a key is stored for this account but no configured KEK opens it"
        ) from e


async def _store(
    identity: Identity,
    settings: Settings,
    *,
    key: str,
    key_alias: str,
    token: str,
    litellm_user_id: str,
    models: list[str],
    created_at: datetime,
    rotated_at: datetime | None,
    session: AsyncSession | None = None,
) -> LlmKey:
    sealed = crypto.seal(key, identity.subject, settings)
    values = {
        "subject": identity.subject,
        "account": identity.account_slug,
        "username": identity.username,
        "user_email": identity.user_email,
        "ciphertext": sealed.ciphertext,
        "nonce": sealed.nonce,
        "kek_id": sealed.kek_id,
        "key_alias": key_alias,
        "litellm_token": token or None,
        "litellm_user_id": litellm_user_id or None,
        "team_id": settings.litellm_team_id or None,
        "base_url": settings.litellm_client_base_url,
        "models": litellm_client.encode_models(models),
        "default_model": models[0] if models else None,
        "created_at": created_at,
        "rotated_at": rotated_at,
    }
    stmt = _insert()(LlmKey).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=[LlmKey.subject],
        set_={k: stmt.excluded[k] for k in values if k != "subject"},
    )
    if session is not None:
        # Inside the caller's transaction: no commit here, the lock holder owns
        # the commit. `expire_all` drops the stale identity map entry so the
        # re-read below returns what we just wrote rather than what was there.
        await session.execute(stmt)
        session.expire_all()
        return await _read(identity.subject, session)  # type: ignore[return-value]

    async with AsyncSessionLocal() as own:
        await own.execute(stmt)
        await own.commit()
    return await _read(identity.subject)  # type: ignore[return-value]


async def _rewrap(row: LlmKey, key: str, settings: Settings) -> None:
    """Re-seal a row under the current KEK. Best-effort by design.

    A rotation migrates rows lazily, as their owners sign in. A failure here
    costs one retry at the next sign-in and must never break the read that
    already succeeded — the user has their key.
    """
    try:
        sealed = crypto.seal(key, row.subject, settings)
        async with AsyncSessionLocal() as session:
            await session.execute(
                LlmKey.__table__.update()
                .where(LlmKey.subject == row.subject)
                .values(
                    ciphertext=sealed.ciphertext, nonce=sealed.nonce, kek_id=sealed.kek_id
                )
            )
            await session.commit()
        logger.info(f"[Keys] re-wrapped subject={row.subject} under kek_id={sealed.kek_id}")
    except Exception as e:  # noqa: BLE001 — never let housekeeping break a read
        logger.warning(f"[Keys] re-wrap failed for subject={row.subject}: {e}")


async def _mint(
    identity: Identity,
    client: httpx.AsyncClient,
    settings: Settings,
    *,
    previous: LlmKey | None,
    status: str,
    session: AsyncSession | None = None,
) -> KeyResult:
    """Mint at the gateway, store, then retire the previous key. In that order."""
    # Read what we need off `previous` before any I/O: on the locked path it is
    # attached to `session`, and touching an expired attribute afterwards would
    # trigger a lazy refresh at an awkward moment.
    previous_token = previous.litellm_token if previous is not None else None
    previous_created = previous.created_at if previous is not None else None

    alias = _alias_for(identity, settings)
    minted = await litellm_client.generate_key(
        client,
        key_alias=alias,
        user_email=identity.user_email,
        settings=settings,
    )
    logger.info(
        f"[Keys] minted subject={identity.subject} alias={alias} "
        f"key={mask_key(minted.key)}"
    )

    now = datetime.now(timezone.utc)
    row = await _store(
        identity,
        settings,
        key=minted.key,
        key_alias=minted.key_alias,
        token=minted.token,
        litellm_user_id=minted.litellm_user_id,
        # No list recorded: the key inherits the gateway's grants, so any list
        # written here would only drift from what the key can actually reach.
        models=[],
        created_at=previous_created or now,
        rotated_at=now if status == STATUS_ROTATED else None,
        session=session,
    )
    result = _result_from_row(row, minted.key, status)

    # Only now is the old key retired, and only ever by its own token.
    if previous_token and previous_token != minted.token:
        deleted = await litellm_client.delete_key_by_token(client, previous_token, settings)
        if not deleted:
            logger.warning(
                f"[Keys] retired key for subject={identity.subject} could not be "
                f"deleted at the gateway; one orphan key remains for cleanup"
            )

    return result


async def get_or_mint(
    identity: Identity,
    client: httpx.AsyncClient,
    *,
    rotate: bool = False,
    settings: Settings | None = None,
) -> KeyResult:
    """This person's model key, minting only if they have none (or asked to rotate)."""
    settings = settings or get_settings()
    if not settings.litellm_enabled:
        raise LiteLLMUnconfiguredError(
            "LiteLLM is not configured on this deployment; the operator must set "
            "LITELLM_BASE_URL and LITELLM_ADMIN_KEY"
        )

    stored = await _read(identity.subject)
    # Set only when the gateway *proved* the stored key dead. Carried into the
    # mint path so the re-read under the lock can tell "somebody else minted a
    # replacement while we waited" from "this is still the same dead key".
    # Without it, the locked re-read finds the corpse and serves it as `reused`.
    rejected_key: str | None = None

    if stored is not None and not rotate:
        key = _unseal(stored, settings)
        live = await litellm_client.key_is_live(client, key, settings)
        if live is not False:  # live, or could not tell — both mean keep it
            if live is None:
                logger.info(
                    f"[Keys] gateway did not answer key/info for subject="
                    f"{identity.subject}; serving the stored key unverified"
                )
            if crypto.needs_rewrap(
                crypto.Sealed(stored.ciphertext, stored.nonce, stored.kek_id), settings
            ):
                await _rewrap(stored, key, settings)
                stored = await _read(identity.subject) or stored
            return _result_from_row(stored, key, STATUS_REUSED)
        rejected_key = key
        logger.warning(
            f"[Keys] stored key for subject={identity.subject} was rejected by the "
            f"gateway; minting a replacement"
        )

    # ── Mint path, serialised per subject ────────────────────────────────────
    if settings.is_sqlite:
        # The test harness is single-connection; there is nothing to serialise.
        return await _mint(
            identity,
            client,
            settings,
            previous=stored,
            status=STATUS_ROTATED if (rotate and stored is not None) else STATUS_ISSUED,
        )

    async with AsyncSessionLocal() as session:
        async with session.begin():
            await session.execute(
                text("SELECT pg_advisory_xact_lock(:k)"), {"k": _lock_key(identity.subject)}
            )
            # Re-read inside the lock. A racing first sign-in may have minted
            # while we waited, and honouring its result is what keeps
            # "one key per person" true rather than merely likely.
            current = await _read(identity.subject, session)
            if current is not None and not rotate:
                key = _unseal(current, settings)
                # Reuse only what we have not already disproved. If this is the
                # very key the gateway just rejected, minting is the whole reason
                # we are here.
                if rejected_key is None or key != rejected_key:
                    logger.info(
                        f"[Keys] another request minted for subject={identity.subject} "
                        f"while we waited on the lock; reusing it"
                    )
                    return _result_from_row(current, key, STATUS_REUSED)
            return await _mint(
                identity,
                client,
                settings,
                previous=current,
                status=STATUS_ROTATED if (rotate and current is not None) else STATUS_ISSUED,
                session=session,
            )


async def peek(
    identity: Identity, settings: Settings | None = None
) -> KeyResult | None:
    """This person's stored key, or None. Never mints, never calls the gateway.

    Backs the read-only `/v1/secrets` route. Deliberately does not verify the key
    against the gateway: a caller asking "what is my key" wants an answer, not a
    round trip that can fail, and the provisioning route is where liveness is
    established.
    """
    settings = settings or get_settings()
    row = await _read(identity.subject)
    if row is None:
        return None
    return _result_from_row(row, _unseal(row, settings), STATUS_REUSED)


async def rotate_for_subject(
    identity: Identity, client: httpx.AsyncClient, settings: Settings | None = None
) -> str:
    """Rotate as part of revoking a device. Returns a `key_rotation` outcome.

    Never raises: revocation must take effect whether or not the rotation
    succeeds. Reporting "model access cut" to somebody who just revoked a stolen
    laptop when it was not cut is worse than saying nothing (spec §6.4).
    """
    settings = settings or get_settings()
    if not settings.litellm_enabled:
        return "unsupported"
    if await _read(identity.subject) is None:
        return "no_key"
    try:
        await get_or_mint(identity, client, rotate=True, settings=settings)
    except Exception as e:  # noqa: BLE001 — revocation still stands
        logger.error(f"[Keys] rotation failed for subject={identity.subject}: {e}")
        return "failed"
    return "rotated"
