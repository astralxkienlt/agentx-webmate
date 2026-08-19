"""`GET /api/auth/providers` — public OIDC configuration for clients.

Unauthenticated on purpose: a client calls this *before* it has a token, to
learn where to send the user. Everything returned is public by construction in a
public-client PKCE flow — an issuer, a client id and two endpoint URLs. The
shared signing secret is emphatically not part of that set and never appears
here.

The Viettel SSO wrapper serves no `/.well-known/openid-configuration`, so the
authorization and token endpoints are advertised here instead. A client that
reads them from this route needs no discovery document, and moving the SSO
endpoints becomes a change to one server's environment rather than a new build
of every installed extension.
"""
from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.config import Settings, get_settings

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get(
    "/providers",
    summary="Advertise the identity provider clients should use",
    description=(
        "Public. Returns the issuer this deployment verifies tokens against, "
        "plus the authorization and token endpoints (the wrapper publishes no "
        "discovery document), the ID-token algorithm it issues, and which "
        "token to present as the bearer.\n\n"
        "Clients pick the first entry with `native_oidc` and "
        "`confidential: false`. An empty list means this deployment cannot "
        "verify tokens — a reason for a client to fall back, not to crash."
    ),
)
async def providers(settings: Annotated[Settings, Depends(get_settings)]) -> dict:
    if not settings.identity_enabled:
        return {"providers": []}

    native: dict = {
        "issuer": settings.issuer,
        "client_id": settings.oidc_client_id,
        "scopes": settings.oidc_scopes,
        # Public client: PKCE authenticates the code exchange and no secret
        # exists anywhere for a client to need.
        "confidential": False,
        # The algorithm this deployment issues. A client cannot verify a
        # symmetric signature — it holds no key and must never be given one —
        # but it can refuse a token whose header says something else, which is
        # what stops a token downgraded to `none` from being accepted locally.
        "id_token_signed_response_alg": settings.id_token_alg,
        # Which of the two tokens the client should send back as its bearer.
        # Only this service knows: in userinfo mode the issuer is asked about
        # the bearer, and the Viettel wrapper recognises only its own opaque
        # access tokens — it answers 401 for an ID token it never stored, since
        # a self-contained JWT is not in any store to be found. When the
        # signature is checked here instead, the ID token is the right one and
        # the access token cannot be checked at all.
        #
        # Advertised rather than hard-coded in the client so that changing how
        # this deployment verifies stays an environment change, instead of a new
        # build of every installed extension.
        "bearer_token": "access_token" if settings.uses_userinfo else "id_token",
    }
    # Both or neither: one endpoint alone would leave the client half-configured
    # and failing at sign-in rather than here.
    if settings.oidc_authorization_endpoint and settings.oidc_token_endpoint:
        native["authorization_endpoint"] = settings.oidc_authorization_endpoint
        native["token_endpoint"] = settings.oidc_token_endpoint

    return {
        "providers": [
            {
                "name": "viettel-sso",
                "display_name": "Viettel SSO",
                "supports_password": False,
                "supports_native_oidc": True,
                "native_oidc": native,
            }
        ]
    }
