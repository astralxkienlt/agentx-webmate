"""Async SQLAlchemy engine, session factory and the declarative Base.

pool_pre_ping drops connections killed by a Postgres failover before handing
them out; pool_recycle caps connection age. sqlite (tests) rejects those kwargs
and gets StaticPool instead, so an in-memory database keeps one connection —
otherwise every session would open a fresh, empty database.
"""
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import NullPool, StaticPool

from app.core.config import settings

if settings.is_sqlite:
    _pool_kwargs = {"poolclass": StaticPool, "connect_args": {"check_same_thread": False}}
elif settings.db_disable_pooling:
    _pool_kwargs = {"poolclass": NullPool}
else:
    _pool_kwargs = {
        "pool_size": settings.db_pool_size,
        "max_overflow": settings.db_max_overflow,
        "pool_pre_ping": True,
        "pool_recycle": 1800,
    }

engine = create_async_engine(settings.database_url, echo=False, **_pool_kwargs)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session
