"""Request and response shapes for the provisioning surface.

Field naming follows the desktop backend's convention — camelCase on the wire
via aliases, `apiKey` / `vendorId` / `meta` — while carrying the data a browser
extension needs to configure an OpenAI-compatible client without a second round
trip: `baseUrl`, `models`, `defaultModel`.

`baseUrl` in particular is authoritative and **overrides whatever the client has
configured locally**. That is what lets an operator move the gateway by editing
one server's environment instead of every installed extension (spec §6.3).
"""
from pydantic import BaseModel, ConfigDict, Field


class ProvisionRequest(BaseModel):
    """Body of a provisioning call. Everything is optional; `{}` is valid.

    Note what is *absent*: there is no account, subject or username field. The
    verified token decides whose key this is, and nothing a client sends can
    influence that. A body field naming the account would let anyone fetch
    anyone else's key by editing one line of JSON (spec R1).
    """

    model_config = ConfigDict(extra="ignore")

    rotate: bool = Field(
        default=False,
        description=(
            "Retire the existing key and mint a replacement. Reserve this for an "
            "explicit user action such as 'my key leaked'. A key the gateway "
            "rejects should be re-fetched with rotate=false, not rotated — a "
            "rejection usually means another install already rotated, and "
            "rotating again starts a ping-pong between the two."
        ),
    )


class ProvisionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    api_key: str = Field(alias="apiKey", description="Plaintext virtual key. Never log this.")
    vendor_id: str = Field(alias="vendorId", description="Provisioning handler that issued it.")
    base_url: str = Field(
        alias="baseUrl",
        description="Gateway root. Overrides any locally configured base URL.",
    )
    models: list[str] = Field(
        default_factory=list, description="Models this key can reach, in priority order."
    )
    default_model: str = Field(
        default="", alias="defaultModel", description="models[0]; pin only if the user has not chosen."
    )
    status: str = Field(
        description="issued (first key for this person) | reused (already had one) | rotated"
    )
    account: str = Field(default="", description="Stable per-person slug, for display and support.")
    key_alias: str = Field(
        default="", alias="keyAlias", description="Label in the gateway console. Never a handle."
    )
    token: str = Field(
        default="",
        description="Gateway handle for this key. The only thing a rotation deletes.",
    )
    created_at: str = Field(default="", alias="createdAt")
    rotated_at: str | None = Field(default=None, alias="rotatedAt")
    meta: dict[str, str] = Field(default_factory=dict)


class MeResponse(BaseModel):
    """Cheap 'am I still allowed here' probe."""

    model_config = ConfigDict(populate_by_name=True)

    subject: str
    username: str
    email: str = ""
    display_name: str = Field(default="", alias="displayName")
    account: str = ""
    device: str = Field(default="", description="Device id this call arrived on.")
    has_key: bool = Field(default=False, alias="hasKey")


class DeviceHeartbeat(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    # The cap here is an abuse bound, not the real limit: names are sanitised and
    # truncated to 64 characters on the way in. It sits well above any plausible
    # hostname so that a long one is quietly shortened rather than failing the
    # heartbeat — a cosmetic field must never cost a client its check-in.
    name: str | None = Field(default=None, max_length=4096)
    platform: str | None = Field(default=None, max_length=64)
    app_version: str | None = Field(default=None, alias="appVersion", max_length=64)
