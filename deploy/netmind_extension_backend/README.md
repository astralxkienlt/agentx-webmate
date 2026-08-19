# netMind Extension Backend

Telemetry ingest and SSO → LLM key provisioning for the netMind browser
extension. One FastAPI process, two surfaces, no read API.

- **[docs/api.md](docs/api.md)** — the API reference
- **[../../docs/intergration/agentx-auth-and-model-key.md](../../docs/intergration/agentx-auth-and-model-key.md)** — the integration spec this implements

## What it does

The extension signs a user in through the **Viettel SSO wrapper**, then presents
its **ID token** here to get a LiteLLM model key. One key per person, minted
once, reused by every browser they sign in from. The gateway's admin key lives
only on this server and never reaches a client — that is the whole point of the
design.

Alongside that, the extension reports usage and structured logs, which are stored
and left alone. A dashboard is a separate service; this one deliberately serves
no read API, so a public-facing process cannot leak what it does not have.

## Run it

```bash
cp .env.example .env
# Fill in at minimum:
#   SECRET_KEY, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_SHARED_SECRET, BRAIN_KEK
#   openssl rand -base64 32     # → BRAIN_KEK
# OIDC_SHARED_SECRET is the secret the Viettel SSO wrapper signs ID tokens with.
docker compose up --build
curl -s localhost:8000/health | jq
```

Without Docker:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload
```

Interactive docs are at `/api/docs` in development, and disabled in production.

## Tests

```bash
.venv/bin/pip install -r requirements-test.txt
.venv/bin/python -m pytest
```

That runs against in-memory sqlite and needs nothing else. **Also run it against
Postgres before shipping** — sqlite has no partitioning, no advisory locks and
different `ON CONFLICT` semantics, and a real bug in the key-minting path was
invisible until the suite ran on the real engine:

```bash
docker run -d --name pg-test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=netmind_test -p 55433:5432 postgres:16-alpine

DATABASE_URL="postgresql+asyncpg://postgres:test@localhost:55433/netmind_test" \
  .venv/bin/python -m pytest
```

Nine tests are Postgres-only and skip on sqlite.

## The parts worth understanding before changing anything

**The SSO wrapper signs with HS256, so the verification secret is a signing
key.** Anything that can check a token can also mint one, which makes
`OIDC_SHARED_SECRET` as sensitive as `BRAIN_KEK`: never in the extension, never
in a log, never in git. The algorithm is pinned to exactly one value, and that
pin — not a list of acceptable algorithms — is what blocks algorithm-confusion
forgery. The asymmetric (RS256 + JWKS) path is implemented and tested, so
hardening the wrapper later is an environment flip rather than a rewrite; it is
also the only way to stop this service being able to forge what it verifies.

**401 is a verdict, 503 is an outage.** A rejected token means sign in again; a
realm we could not *reach* means keep the token and retry. Collapsing the second
into the first signs out every user at once the next time JWKS hiccups. This is
why `InvalidTokenError` and `IdentityUnavailableError` are separate classes and
why no `except Exception` sits anywhere near token verification.

**The token decides the account, always.** No request body or query parameter
contributes to identity. A field that could steer it would let anyone fetch
anyone else's key by editing one line of JSON.

**One key per person, and only proven-dead keys get replaced.** `/key/info`
answers live, gone, or *unknown* — and unknown behaves like live. Treating an
unreachable gateway as proof of death mints a fresh key on every sign-in for the
length of an outage, which is the exact pile-up the stored key exists to prevent.

**Keys are deleted by token, never by alias.** Every install of one person shares
an alias, so an alias-scoped delete kills the key another browser is using right
now.

**Revocation is a tombstone.** The row stays and the revoked install keeps
getting 403. Deleting it would let that install re-register as new on its next
call, and revocation would last exactly one request.

**`BRAIN_KEK` is not recoverable.** Lose it and every stored key is unreadable;
the only way out is deleting the rows so everyone mints again. Back it up
somewhere other than the host holding the database.

## Layout

```
app/
  core/        config, database, logging, wire errors
  auth/        token verification (HS256 secret / JWKS), identity, ingest auth
  proxy/       key envelope, LiteLLM client, routes, rate limiting
  api/         telemetry ingest routes
  models/      SQLAlchemy tables
  schemas/     request/response shapes
  services/    keys, devices, telemetry, app logs
tests/         171 tests; 9 are Postgres-only
```
