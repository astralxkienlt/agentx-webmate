"""Provisioning handler protocol.

A handler answers "give this verified person a credential of kind X". The
registry exists so `/v1/provision-keys/{name}` can dispatch by name, and so a
second gateway can be added later without touching the route.
"""
from typing import Literal, Protocol, runtime_checkable

import httpx

from app.auth.models import Identity
from app.schemas.proxy import ProvisionResponse

HandlerKind = Literal["provision", "fetch"]


@runtime_checkable
class SecretHandler(Protocol):
    name: str
    kind: HandlerKind
    vendor_id: str

    async def handle(
        self, identity: Identity, client: httpx.AsyncClient, *, rotate: bool = False
    ) -> ProvisionResponse: ...
