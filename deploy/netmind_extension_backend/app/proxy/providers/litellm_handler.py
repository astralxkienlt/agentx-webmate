"""The LiteLLM provisioning handler.

Thin by design: every decision about minting, reuse and rotation lives in
`app.services.keys`, so it is testable without a route and cannot drift between
the provision and rotate paths.
"""
from typing import Literal

import httpx

from app.auth.models import Identity
from app.proxy.providers import registry
from app.schemas.proxy import ProvisionResponse
from app.services import keys


class LiteLLMHandler:
    name: str = "litellm"
    kind: Literal["provision"] = "provision"
    vendor_id: str = "litellm"

    async def handle(
        self, identity: Identity, client: httpx.AsyncClient, *, rotate: bool = False
    ) -> ProvisionResponse:
        result = await keys.get_or_mint(identity, client, rotate=rotate)
        return ProvisionResponse(
            api_key=result.key,
            vendor_id=self.vendor_id,
            base_url=result.base_url,
            models=result.models,
            default_model=result.default_model,
            status=result.status,
            account=result.account,
            key_alias=result.key_alias,
            token=result.token,
            created_at=result.created_at,
            rotated_at=result.rotated_at,
            meta={
                "username": identity.username,
                "userEmail": identity.user_email,
                # `keySource` mirrors `status`; it exists so a support ticket can
                # be answered from the response alone, without reading server logs.
                "keySource": result.status,
            },
        )


registry.register(LiteLLMHandler())
