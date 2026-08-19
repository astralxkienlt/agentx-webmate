# netMind Extension Backend — API Reference

Two surfaces in one service:

| Surface | Paths | Who calls it |
|---|---|---|
| **Provisioning** | `/v1/*` | the extension, to exchange an SSO token for a model key |
| **Telemetry ingest** | `/api/background-logs/*`, `/api/logs` | the extension, to report usage and errors |

There is deliberately **no read API** here. Telemetry is collected and stored;
whatever reads it later is a separate service. A public-facing process cannot
leak what it does not serve.

Every path below is relative to `API_BASE_PATH`. With
`API_BASE_PATH=/netmind-extension`, `/v1/me` is served at
`/netmind-extension/v1/me`. `/health` is the one exception — it stays at the
root so a container healthcheck can bypass nginx.

Interactive docs live at `<base>/api/docs` and `<base>/api/redoc` in
development. Both are **disabled in production**, along with `openapi.json`.

---

## Authentication

### Provisioning: ID token + device header

```http
Authorization: Bearer <viettel_sso_id_token>
X-AgentX-Device: 6f1c2c7a-9a3e-4a1d-8f0b-2c9d1e5f7a01
X-AgentX-Device-Name: MacBook Pro          # optional, display only
```

Three things about this are not negotiable:

**The issuer is asked, not the signature checked.** The Viettel SSO wrapper is a
CAS-to-OIDC shim rather than an identity provider: it signs ID tokens with HS256
using a secret held only by the wrapper process, publishes no JWKS, and
registers no clients — `/authorize` forwards *any* `client_id` to the upstream
CAS unchanged. There is therefore no key, public or shared, that this service
could verify a signature against. So it doesn't: with `OIDC_USERINFO_ENDPOINT`
set, the bearer is handed back to the issuer and a `200` from `/userinfo` is the
proof. The claims in that response are the identity; the token's own claims are
read for nothing.

> ⚠ **`aud` proves nothing on this wrapper.** It is echoed back from whatever
> `client_id` the client sent, so pinning it would refuse valid sign-ins while
> stopping no forgery. Audience pinning is skipped in userinfo mode for exactly
> that reason. It comes back the moment the issuer registers clients properly.

Two other modes remain configured-but-unused, and both verify locally:
`OIDC_SHARED_SECRET` for an issuer that shares its HS\* signing secret, and
`JWKS_URL` for one that publishes RS\*/ES\*/PS\* public keys. Moving to either is
an environment change, not a rewrite — and moving the wrapper to **RS256 +
JWKS** is the single change that would restore local verification and end this
service's dependence on the wrapper being up.

Because verification is a round trip, an SSO outage **does** stop new
verifications. Two things blunt it: answers are cached for
`OIDC_USERINFO_CACHE_SECONDS` (default 60), and an unreachable issuer is
`503 identity_unavailable`, never `401` — clients keep the key they hold and
retry rather than being signed out.

**The token decides the account.** There is no body or query parameter that
names a user. If there were, anyone could fetch anyone else's key by editing one
line of JSON. Fields like `username` in a request body are ignored whenever a
verified token is present.

**Every request declares its device.** Missing header is
`400 device_header_missing`. A device list that cannot say which entry is *this
machine* is a list nobody dares revoke from.

### Ingest: the same token, or a shared key

Ingest accepts either:

```http
Authorization: Bearer <viettel_sso_id_token>     # → identity_verified: true
```
```http
X-Auth-Key: <INGEST_AUTH_KEY>                 # → identity_verified: false
```

An extension cannot keep a secret — the key ships inside a bundle any user can
read in DevTools. So the shared key proves only "some copy of the extension sent
this". Rows written that way are stored with `identity_verified = false`, and
the body's `username` is taken at face value.

**Any report where attribution matters must filter on `identity_verified`.**
Averaging the two populations together produces a number that means nothing.

Leaving `INGEST_AUTH_KEY` unset disables the fallback entirely, which is the
right setting once every client signs in.

One asymmetry worth knowing: a token that *fails verification* is a `401`, but an
issuer we *cannot reach* falls back to the shared key when one is configured.
(With HS256 that second case cannot arise — verification is local.) Telemetry
is worth keeping through an issuer outage, and the fallback grants no capability
anyone holding the shared key did not already have.

---

## Errors

Every error is a flat body:

```json
{ "error": "device_revoked", "detail": "This device has been revoked." }
```

**Switch on `error`. Never match on `detail`** — that prose will be reworded,
and code matching it breaks the day someone improves it.

The distinction that matters most is *rejected* versus *unreachable*:

| HTTP | `error` | Meaning | What the client must do |
|---|---|---|---|
| 401 | `missing_bearer` | no bearer presented | sign in |
| 401 | `invalid_token` | signature/claims rejected | discard the token, sign in again |
| 401 | `ingest_unauthorized` | no usable ingest credential | fix the client |
| 503 | `identity_unavailable` | **the issuer could not be reached** (asymmetric mode only) | **keep the token**, retry later |
| 503 | `identity_unconfigured` | no issuer or no verification key | operator must fix |
| 400 | `device_header_missing` | no `X-AgentX-Device` | client bug |
| 400 | `device_header_invalid` | not a UUID | client bug |
| 403 | `device_revoked` | this install was revoked | prompt sign-in; **keep the stored key** |
| 404 | `device_not_found` | unknown device, or someone else's | refresh the list |
| 409 | `cannot_revoke_last_device` | revoking the only install while rotating | explain; sign in elsewhere first |
| 404 | `handler_not_found` | no such handler, or nothing provisioned yet | — |
| 429 | `rate_limited` | too many calls for this subject | back off |
| 502 | `litellm_refused` | the gateway answered and said no | a problem with this request |
| 503 | `litellm_unavailable` | gateway unreachable; **nothing was minted** | keep the key, retry |
| 503 | `litellm_unconfigured` | deployment has no gateway configured | keep the key; operator must fix |
| 503 | `key_unreadable` | a key is stored but no KEK opens it | keep the key; operator must restore the KEK |
| 422 | — | FastAPI schema validation (not a flat body) | client bug |

**A `503` never means sign out.** It means *keep what you have and come back*.
Treating a timeout as a `401` signs out the entire fleet the next time the
issuer has a bad minute.

---

## Provisioning

### `POST /v1/provision-keys/{name}`

Returns this user's model key, minting one only if they do not have one.
Idempotent and safe to call after every sign-in.

`{name}` is the provisioning handler. Only `litellm` is registered; anything
else is `404 handler_not_found`.

**Request**

```http
POST /v1/provision-keys/litellm
Authorization: Bearer <id_token>
X-AgentX-Device: 6f1c2c7a-9a3e-4a1d-8f0b-2c9d1e5f7a01
Content-Type: application/json

{"rotate": false}
```

An empty body, `{}`, or no body at all all mean `rotate: false`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `rotate` | bool | `false` | Retire the current key and mint a replacement |

**Response `200`**

```json
{
  "apiKey": "sk-...",
  "vendorId": "litellm",
  "baseUrl": "https://aigw.dev-server.cloud",
  "models": [],
  "defaultModel": "",
  "status": "reused",
  "account": "kienlt-3f9a1c2b",
  "keyAlias": "[netmind-extension][kien@corp.test]",
  "token": "handle-for-rotation",
  "createdAt": "2026-08-19T09:14:22+00:00",
  "rotatedAt": null,
  "meta": { "username": "kienlt", "userEmail": "kien@corp.test", "keySource": "reused" }
}
```

| Field | Meaning |
|---|---|
| `apiKey` | The virtual key. **Never log this** — mask it if you must print it. |
| `baseUrl` | Gateway root. **Overrides any locally configured base URL** — that is how an operator moves the gateway by editing one server instead of every installed extension. Append `/v1` for an OpenAI-compatible client. |
| `models` | Empty for keys minted today: the key is minted with no list of its own and reaches exactly what the gateway grants it (its team's models). Discover them with the key itself — `GET {baseUrl}/v1/models`. Non-empty only on rows minted before this policy. |
| `defaultModel` | Empty when `models` is. Pick the gateway's first listed model instead; pin only if the user has not chosen. |
| `status` | `issued` (first key for this person) · `reused` (already had one, nothing minted) · `rotated` |
| `account` | Stable per-person slug. Survives renames — the digest half is taken over `sub`. |
| `keyAlias` | Label in the gateway console. **Never a handle** — see below. |
| `token` | The gateway handle. The only thing a rotation deletes. |

`status` is not cosmetic. A person's second browser gets `reused`; telling them
their key was "replaced" describes the fix as though it were the bug.

#### One key per person

The first call for a subject mints at the gateway. **Every call after it — from
that browser or any other — reads the stored row and never touches the gateway's
write API.**

Verify it yourself: call twice with two different `X-AgentX-Device` values and
the same token. You must get the same `apiKey`, and `status: "reused"` the second
time. If you do not, the second browser is killing the first one's key.

Concurrency is handled by a per-subject advisory lock, so two first-time
sign-ins at the same instant still produce exactly one key.

#### When to rotate — and when not to

`rotate: true` mints a replacement and retires the old key. Other browsers are
not broken: they pick up the new key on their next call, because this endpoint is
where they get their key from.

Use it for an explicit user action ("my key leaked") and for device revocation.

**Do not rotate because the gateway rejected your key.** A rejection almost
always means another install already rotated; the right move is to re-fetch with
`rotate: false` and pick up what they rotated to. Rotating again starts a
ping-pong between two machines that this whole design exists to end.

The old key is deleted by its `token`, never by its alias — every install of one
person shares an alias, so an alias-scoped delete would kill the key another
browser is using right now.

### `GET /v1/secrets/{name}`

The stored key, without ever minting. `404 handler_not_found` if this account has
never provisioned one. Same response shape as above.

Use this when you want to know the current key and must not create gateway state
by asking.

### `GET /v1/me`

Cheap "am I still allowed here" probe. Verifies the token, registers the device,
and reports whether a key exists — enough to decide whether to provision, without
requesting a key you may not need.

```json
{
  "subject": "f:abc:kienlt",
  "username": "kienlt",
  "email": "kien@corp.test",
  "displayName": "Le Trung Kien",
  "account": "kienlt-3f9a1c2b",
  "device": "6f1c2c7a-9a3e-4a1d-8f0b-2c9d1e5f7a01",
  "hasKey": true
}
```

Never returns the key itself.

---

## Devices

### `GET /v1/devices`

```json
{
  "devices": [
    {
      "id": "6f1c2c7a-...",
      "name": "MacBook Pro",
      "platform": "macOS",
      "app_version": "32.1.0",
      "created_at": "2026-08-01T09:14:22+00:00",
      "last_seen_at": "2026-08-19T10:02:11+00:00",
      "revoked_at": null,
      "revoked": false,
      "current": true
    }
  ],
  "current": "6f1c2c7a-..."
}
```

### `POST /v1/devices/heartbeat`

Declare what this install is. Presence is already recorded by any authenticated
call; this adds platform and version.

```json
{ "name": "MacBook Pro", "platform": "macOS", "appVersion": "32.1.0" }
```

`name` is display-only and never trusted: everything outside `[A-Za-z0-9 ._-]` is
replaced and the result is cut to 64 characters. A long hostname is truncated,
not rejected — a cosmetic field must never cost a client its check-in.

### `DELETE /v1/devices/{id}?rotate_key=<bool>`

Revoke one install.

```json
{
  "device": { "...": "as above, revoked: true" },
  "key_rotated": true,
  "key_rotation": "rotated"
}
```

`key_rotation` is one of:

| Value | Meaning |
|---|---|
| `not_requested` | `rotate_key` was false |
| `rotated` | a new key was minted; the revoked machine is now cut off |
| `no_key` | this person never had a key, so there was nothing to cut |
| `unsupported` | this deployment has no gateway configured |
| `failed` | the rotation failed — **the revocation still stands** |

Check this field before telling anyone their access was cut. Saying "access
revoked" to someone who just lost a laptop, when it was not revoked, is worse
than saying nothing.

Three behaviours to preserve if you ever rewrite this:

1. **Someone else's device is `404`, not `403`.** A `403` confirms the id
   exists — a question this endpoint has no business answering.
2. **Revocation is a tombstone, not a delete.** The revoked install keeps
   getting `403`. Deleting the row would let it re-register as new on its next
   call, and revocation would last exactly one request.
3. **Revoking the last install with `rotate_key=true` is `409`.** One key per
   person means revocation alone does not cut model access — only a rotation
   does. But rotating with no install left strands the new key: nothing remains
   to collect it. Enforced in the service, not by hiding a button, because any
   client can call the API.

---

## Telemetry ingest

Paths match the netMind Desktop backend, so one nginx configuration and one
dashboard can serve both fleets.

### `POST /api/background-logs/user-telemetry`

The endpoint a client should actually use: one post per tick carrying
everything, rather than five requests that can half-succeed.

```json
{
  "usage_date": "2026-08-19",
  "appVersion": "32.1.0",
  "browser": "chrome/140",
  "health_result": "OK",
  "token_usage": {
    "input_tokens": 12000,
    "output_tokens": 4300,
    "total_tokens": 16300,
    "cost_usd": 0.42
  },
  "tools": [
    { "tool": "click", "invoke_count": 25, "error_count": 2 },
    { "tool": "navigate", "invoke_count": 11, "error_count": 0 }
  ],
  "activity_by_hour": [0,0,0,0,0,0,0,0,0,7,12,3,0,0,0,0,0,0,0,0,0,0,0,0],
  "new_sessions": 4
}
```

```json
{ "ok": true, "identity_verified": true, "tools_written": 2, "hours_written": 3 }
```

**Daily figures are cumulative totals, not deltas.** Report the running total for
the day on every tick. A dropped post then costs nothing — the next one carries
the same number. Sending deltas would double-count every retry.

| Field | Notes |
|---|---|
| `username` | **Ignored when a token is present.** Required when using `X-Auth-Key`. |
| `usage_date` | Defaults to the server's today |
| `tools` | Max 500 entries. Repeats of one tool collapse to the last value. |
| `activity_by_hour` | Up to 24 ints, index = local hour. Zero hours are not stored. |

The request arriving *is* the presence heartbeat; there is no separate
last-active field that could disagree with it.

### Single-metric routes

For clients with only one thing to say, and for `curl` when diagnosing which
metric misbehaves. All take the same authentication and all return
`{"ok": true, "identity_verified": <bool>}`.

| Route | Body |
|---|---|
| `POST /api/background-logs/health-check` | `{"health_result": "OK"}` |
| `POST /api/background-logs/last-active` | `{"appVersion": "32.1.0", "browser": "chrome/140"}` |
| `POST /api/background-logs/token-usage` | `{"total_tokens": 16300, "cost_usd": 0.42, "usage_date": "2026-08-19"}` |
| `POST /api/background-logs/feedback` | `{"rating": 5, "category": "idea", "message": "…", "appVersion": "32.1.0"}` |

Feedback additionally returns the stored row's `id`.

### `POST /api/logs`

Batched structured logs — errors, warnings and funnel step-events.

```json
{
  "run_id": "0f8c2a1e-4b7d-4a2f-9c3e-1d5b7a9f2c40",
  "appVersion": "32.1.0",
  "browser": "chrome/140",
  "logs": [
    {
      "ts": "2026-08-19T09:14:22.184+07:00",
      "level": "ERROR",
      "module": "agent",
      "message": "click failed on selector",
      "fingerprint": "agent:click:timeout",
      "event": "tool_call",
      "phase": "failure",
      "code": "TIMEOUT",
      "count": 2,
      "context": { "selector": "#submit" }
    }
  ]
}
```

```json
{ "accepted": 1, "identity_verified": true }
```

| Field | Notes |
|---|---|
| `run_id` | UUID, one per extension session. Required — it is how one launch is traced. |
| `logs` | Max 5000 entries. An empty array is a success. |
| `ts` | Timezone-aware. Decides which month partition the row lands in. |
| `level` | `INFO` · `WARN` · `ERROR`. Anything unrecognised becomes `INFO`. |
| `fingerprint` | Required — it is how errors are grouped. An ungrouped error is noise. |
| `message` | Redact absolute paths client-side before sending. |

An empty batch returns `200` with `accepted: 0`. Any 2xx makes a client drop its
buffer, so there must be nothing left to retry.

Optionally send `X-AgentX-Device`; it is recorded when present and the route
works without it. Unlike provisioning, this is not a security boundary — logs
are worth keeping from a client that forgot the header.

Storage is a monthly-partitioned table (Vietnam calendar months, UTC+7).
Partitions are created on demand, so retention is a `DROP TABLE`: instant, no
bloat, no vacuum.

---

## Public routes

### `GET /health`

No authentication. Reports each dependency separately.

```json
{
  "status": "ok",
  "environment": "production",
  "checks": {
    "database": "ok",
    "identity": "ok",
    "litellm": "ok",
    "key_encryption": "ok"
  }
}
```

**Only Postgres can fail this check.** A deployment with no gateway configured is
legitimate — it reports `litellm: "unconfigured"` and stays `ok`, because taking
a working service out of the load balancer over a feature nobody asked it to
serve would be the wrong trade.

### `GET /api/auth/providers`

No authentication — a client calls this *before* it has a token, to learn where
to send the user.

```json
{
  "providers": [
    {
      "name": "viettel-sso",
      "display_name": "Viettel SSO",
      "supports_password": false,
      "supports_native_oidc": true,
      "native_oidc": {
        "issuer": "https://netmind.viettel.vn/sso-wrapper",
        "client_id": "netmind-extension",
        "scopes": "openid profile email",
        "confidential": false,
        "id_token_signed_response_alg": "HS256",
        "authorization_endpoint": "https://netmind.viettel.vn/sso-wrapper/authorize",
        "token_endpoint": "https://netmind.viettel.vn/sso-wrapper/token"
      }
    }
  ]
}
```

Pick the first entry with `native_oidc` and `confidential: false`. An empty list
means this deployment cannot verify tokens — a reason to fall back, not to crash.

The two endpoints are here because **the wrapper publishes no
`/.well-known/openid-configuration`**. A client that reads this route needs no
discovery document; one that ignores it and reaches for discovery anyway gets a
404. `id_token_signed_response_alg` tells a client which algorithm to insist on
in the token header — it cannot check a symmetric signature (it holds no key,
and must never be given one), but it can refuse a token downgraded to `none`.

Everything here is public by construction in a public-client PKCE flow. The
shared signing secret is **not** part of that set and never appears in this
response.

Having this route at all means moving the SSO endpoints is one server's
environment change rather than a new build of every installed extension.

---

## Verifying a deployment with curl

```bash
BASE=https://netmind.example.com/netmind-extension
TOKEN=<id_token>
DEV=$(uuidgen | tr 'A-Z' 'a-z')

# 1. is the service alive, and what does it have configured
curl -sS $BASE/health | jq

# 2. is the token accepted
curl -sS $BASE/v1/me -H "Authorization: Bearer $TOKEN" -H "X-AgentX-Device: $DEV" | jq

# 3. get a key — "issued" the first time, "reused" every time after
curl -sS -X POST $BASE/v1/provision-keys/litellm \
  -H "Authorization: Bearer $TOKEN" -H "X-AgentX-Device: $DEV" \
  -H 'Content-Type: application/json' -d '{"rotate": false}' \
  | jq '.status, .defaultModel, .baseUrl'

# 4. does the issued key actually work
KEY=$(curl -sS -X POST $BASE/v1/provision-keys/litellm \
  -H "Authorization: Bearer $TOKEN" -H "X-AgentX-Device: $DEV" \
  -H 'Content-Type: application/json' -d '{}' | jq -r .apiKey)
curl -sS https://aigw.example.com/v1/models -H "Authorization: Bearer $KEY" | jq '.data[].id'

# 5. a missing device header must be 400 device_header_missing
curl -sS -X POST $BASE/v1/provision-keys/litellm \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' | jq
```

**The acceptance test:** run step 3 twice with two different `DEV` values and the
same `TOKEN`. Both must return the same `apiKey`, and the second must say
`reused`. Anything else means signing in on a second browser breaks the first
one.
