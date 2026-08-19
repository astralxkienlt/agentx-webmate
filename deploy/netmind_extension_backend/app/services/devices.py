"""Device registry.

Three rules from the integration spec (§6.4) that must survive any rewrite:

1. **Another person's device is 404, not 403.** A 403 would confirm the id
   exists — a question this endpoint has no business answering.
2. **Revocation is a tombstone.** The row stays, `revoked_at` is set. Deleting
   it would let the revoked install re-register as new on its next call.
3. **Revoking the last device while rotating the key is 409.** One key per
   person means revocation alone does not cut model access — only a rotation
   does. But rotating with no install left means the new key has nowhere to go.
   Enforced here in the service, not by hiding a button, because any client can
   call the API.
"""
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.core.database import AsyncSessionLocal, engine
from app.core.errors import DeviceNotFoundError, DeviceRevokedError
from app.models.identity import Device


def _insert():
    return pg_insert if engine.dialect.name == "postgresql" else sqlite_insert


def _now() -> datetime:
    return datetime.now(timezone.utc)


def to_dict(device: Device, current_id: str | None = None) -> dict:
    return {
        "id": device.device_id,
        "name": device.name or "",
        "platform": device.platform or "",
        "app_version": device.app_version or "",
        "created_at": device.created_at.isoformat() if device.created_at else None,
        "last_seen_at": device.last_seen_at.isoformat() if device.last_seen_at else None,
        "revoked_at": device.revoked_at.isoformat() if device.revoked_at else None,
        "revoked": device.revoked_at is not None,
        "current": device.device_id == current_id,
    }


async def register(
    subject: str,
    device_id: str,
    name: str = "",
    platform: str | None = None,
    app_version: str | None = None,
) -> Device:
    """Upsert this install and confirm it is not revoked, atomically.

    The revocation check reads the row the upsert just wrote, inside the same
    transaction. Checking first and writing second would leave a window where a
    revocation lands in between and the request proceeds anyway.

    A revoked row is deliberately *not* resurrected by this upsert: the
    `on_conflict` set clause never touches `revoked_at`, so a revoked install
    stays revoked no matter how many times it calls.
    """
    now = _now()
    values = {
        "subject": subject,
        "device_id": device_id,
        "name": name or None,
        "created_at": now,
        "last_seen_at": now,
    }
    if platform is not None:
        values["platform"] = platform
    if app_version is not None:
        values["app_version"] = app_version

    stmt = _insert()(Device).values(**values)
    # Only ever refresh presence and description. `revoked_at` is untouched:
    # that is rule 2, expressed where it cannot be forgotten.
    refresh = {"last_seen_at": stmt.excluded.last_seen_at}
    if name:
        refresh["name"] = stmt.excluded.name
    if platform is not None:
        refresh["platform"] = stmt.excluded.platform
    if app_version is not None:
        refresh["app_version"] = stmt.excluded.app_version
    stmt = stmt.on_conflict_do_update(
        index_elements=[Device.subject, Device.device_id], set_=refresh
    )

    async with AsyncSessionLocal() as session:
        await session.execute(stmt)
        device = (
            await session.execute(
                select(Device).where(
                    Device.subject == subject, Device.device_id == device_id
                )
            )
        ).scalar_one()
        await session.commit()
        session.expunge(device)

    if device.revoked_at is not None:
        raise DeviceRevokedError("this device has been revoked; sign in again to use it")
    return device


async def list_for(subject: str) -> list[Device]:
    async with AsyncSessionLocal() as session:
        rows = (
            await session.execute(
                select(Device)
                .where(Device.subject == subject)
                .order_by(Device.last_seen_at.desc())
            )
        ).scalars().all()
        for row in rows:
            session.expunge(row)
    return list(rows)


async def count_active(subject: str) -> int:
    """Installs that are still allowed to call. Revoked ones do not count."""
    async with AsyncSessionLocal() as session:
        return (
            await session.scalar(
                select(func.count())
                .select_from(Device)
                .where(Device.subject == subject, Device.revoked_at.is_(None))
            )
        ) or 0


async def get(subject: str, device_id: str) -> Device:
    """One device belonging to `subject`.

    Raises `DeviceNotFoundError` both when no such id exists and when it belongs
    to somebody else — rule 1.
    """
    async with AsyncSessionLocal() as session:
        device = (
            await session.execute(
                select(Device).where(
                    Device.subject == subject, Device.device_id == device_id
                )
            )
        ).scalar_one_or_none()
        if device is not None:
            session.expunge(device)
    if device is None:
        raise DeviceNotFoundError("no such device for this account")
    return device


async def revoke(subject: str, device_id: str) -> Device:
    """Tombstone one install. Idempotent — re-revoking keeps the first timestamp."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            update(Device)
            .where(
                Device.subject == subject,
                Device.device_id == device_id,
                Device.revoked_at.is_(None),
            )
            .values(revoked_at=_now())
        )
        await session.commit()
        if result.rowcount == 0:
            # Either it does not exist, or it was already revoked. Distinguish
            # by reading; a repeat revoke must not 404.
            existing = (
                await session.execute(
                    select(Device).where(
                        Device.subject == subject, Device.device_id == device_id
                    )
                )
            ).scalar_one_or_none()
            if existing is None:
                raise DeviceNotFoundError("no such device for this account")
            session.expunge(existing)
            return existing
        device = (
            await session.execute(
                select(Device).where(
                    Device.subject == subject, Device.device_id == device_id
                )
            )
        ).scalar_one()
        session.expunge(device)
    return device
