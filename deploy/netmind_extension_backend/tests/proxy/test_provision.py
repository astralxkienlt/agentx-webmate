"""Key provisioning.

`test_two_devices_one_person_get_the_same_key` is the load-bearing test in this
repository. If it ever fails, the second browser someone signs in on is killing
the first one's key — the exact bug this architecture was built to remove.
"""
import httpx

from tests.conftest import auth_headers, device_id, make_token

PROVISION = "/v1/provision-keys/litellm"


def provision(client, token=None, device=None, body=None):
    return client.post(
        PROVISION, headers=auth_headers(token, device), json=body if body is not None else {}
    )


# ── The core invariant ───────────────────────────────────────────────────────

def test_first_call_mints_and_reports_issued(client, gateway):
    response = provision(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "issued"
    assert body["apiKey"] == "sk-generated-1"
    assert gateway.generate_calls == 1


def test_second_call_reuses_and_never_touches_the_gateway(client, gateway):
    first = provision(client).json()
    second = provision(client).json()
    assert second["status"] == "reused"
    assert second["apiKey"] == first["apiKey"]
    assert gateway.generate_calls == 1, "reuse must not mint"


def test_two_devices_one_person_get_the_same_key(client, gateway):
    """One person, two browsers, one key.

    Anything else means signing in on a second machine takes the first one
    offline. Mint exactly once, then hand the same key to everybody.
    """
    token = make_token()
    first = provision(client, token, device_id()).json()
    second = provision(client, token, device_id()).json()

    assert first["apiKey"] == second["apiKey"]
    assert first["status"] == "issued"
    assert second["status"] == "reused"
    assert gateway.generate_calls == 1


def test_different_people_get_different_keys(client, gateway):
    a = provision(client, make_token(subject="person-a", preferred_username="alpha")).json()
    b = provision(client, make_token(subject="person-b", preferred_username="beta")).json()
    assert a["apiKey"] != b["apiKey"]
    assert gateway.generate_calls == 2


# ── Rotation ─────────────────────────────────────────────────────────────────

def test_rotate_mints_a_replacement_and_retires_the_old_key_by_token(client, gateway):
    """Retirement is by token, never by alias — every install of one person
    shares an alias, so an alias-scoped delete kills the key in use elsewhere."""
    first = provision(client).json()
    rotated = provision(client, body={"rotate": True}).json()

    assert rotated["status"] == "rotated"
    assert rotated["apiKey"] != first["apiKey"]
    assert gateway.deleted_tokens == ["token-1"], "old key retired by its own token"


def test_rotate_order_is_mint_then_store_then_delete(client, gateway):
    """The old key is deleted only after the new one is safely stored.

    Deleting first means a failed store loses everybody's access; deleting last
    means the worst case is one orphan key an operator can see and sweep.
    """
    provision(client)
    assert gateway.deleted_tokens == []
    provision(client, body={"rotate": True})
    assert gateway.generate_calls == 2
    assert gateway.deleted_tokens == ["token-1"]


def test_rotation_survives_a_failed_delete(client, gateway):
    """A gateway that will not delete the old key must not fail the rotation:
    the user has a working new key, and one orphan is an operator's problem."""
    provision(client)
    gateway.delete_status = 500
    rotated = provision(client, body={"rotate": True})
    assert rotated.status_code == 200
    assert rotated.json()["status"] == "rotated"


def test_empty_body_is_treated_as_no_rotate(client, gateway):
    """`curl -d '{}'` and a client that sends no body at all must both work."""
    provision(client)
    response = client.post(PROVISION, headers=auth_headers())
    assert response.status_code == 200
    assert response.json()["status"] == "reused"
    assert gateway.generate_calls == 1


# ── Verified reuse: live / gone / unknown ────────────────────────────────────

def test_key_the_gateway_rejects_is_replaced(client, gateway):
    """A key the gateway has never heard of is proven dead — mint a replacement
    rather than hand back something that 401s on its first model call."""
    provision(client)
    gateway.key_info_status = 404
    response = provision(client).json()
    assert response["status"] == "issued"
    assert gateway.generate_calls == 2


def test_blocked_key_is_replaced(client, gateway):
    provision(client)
    gateway.key_info_blocked = True
    assert provision(client).json()["status"] == "issued"
    assert gateway.generate_calls == 2


def test_unreachable_gateway_serves_the_stored_key_unverified(client, gateway):
    """The subtle one.

    An unreachable gateway is *not* proof the key is dead. Treating it as proof
    mints a fresh key on every sign-in for the duration of an outage — precisely
    the pile-up the stored key exists to prevent.
    """
    first = provision(client).json()
    gateway.key_info_status = None  # connection error on /key/info
    second = provision(client)
    assert second.status_code == 200
    assert second.json()["status"] == "reused"
    assert second.json()["apiKey"] == first["apiKey"]
    assert gateway.generate_calls == 1, "an outage must not cause a mint"


def test_key_info_5xx_also_counts_as_unknown(client, gateway):
    first = provision(client).json()
    gateway.key_info_status = 503
    second = provision(client).json()
    assert second["status"] == "reused"
    assert second["apiKey"] == first["apiKey"]
    assert gateway.generate_calls == 1


# ── Model access ─────────────────────────────────────────────────────────────

def test_mint_sends_no_model_list_so_the_key_inherits_gateway_grants(client, gateway):
    """The key reaches exactly what the gateway grants it — nothing curated here.

    A list minted into the key froze it with the models of its mint day; a model
    granted to the team later never reached it. The client discovers what the
    key can see by asking the gateway with the key itself, so the response
    carries no list either.
    """
    body = provision(client).json()
    assert "models" not in gateway.generate_bodies[0], "a minted list would freeze the key"
    assert body["models"] == []
    assert body["defaultModel"] == ""


def test_base_url_is_returned_so_it_can_override_local_config(client):
    """Moving the gateway is one server's environment change, not a new build of
    every installed extension."""
    assert provision(client).json()["baseUrl"] == "https://aigw.test"


def test_key_alias_is_the_prefix_and_email_in_brackets(client, gateway):
    """`[prefix][email]` — the format the gateway console is scanned by."""
    provision(client)
    alias = gateway.generate_bodies[0]["key_alias"]
    assert alias == "[netmind-extension][kien@example.test]"


def test_key_alias_falls_back_to_the_account_slug_without_an_email(client, gateway):
    """An issuer that supplies no email still gets an alias naming its owner."""
    provision(client, make_token(email="", preferred_username=""))
    alias = gateway.generate_bodies[0]["key_alias"]
    assert alias.startswith("[netmind-extension][user-abc-123-")
    assert alias.endswith("]")


# ── Failure mapping ──────────────────────────────────────────────────────────

def test_gateway_unreachable_during_mint_is_503(client, gateway):
    """503 tells the client to keep whatever it has and retry; 500 would not."""
    gateway.gateway_error = httpx.ConnectError("gateway down")
    response = provision(client)
    assert response.status_code == 503
    assert response.json()["error"] == "litellm_unavailable"


def test_gateway_refusal_during_mint_is_502(client, gateway):
    gateway.generate_status = 400
    response = provision(client)
    assert response.status_code == 502
    assert response.json()["error"] == "litellm_refused"


def test_unknown_handler_is_404(client):
    response = client.post("/v1/provision-keys/nope", headers=auth_headers(), json={})
    assert response.status_code == 404
    assert response.json()["error"] == "handler_not_found"


def test_device_header_is_required(client):
    response = client.post(
        PROVISION, headers={"Authorization": f"Bearer {make_token()}"}, json={}
    )
    assert response.status_code == 400
    assert response.json()["error"] == "device_header_missing"


def test_malformed_device_header_is_its_own_error(client):
    """Distinct from 'missing' because it is a distinct client bug."""
    response = client.post(
        PROVISION,
        headers={"Authorization": f"Bearer {make_token()}", "X-AgentX-Device": "not-a-uuid"},
        json={},
    )
    assert response.status_code == 400
    assert response.json()["error"] == "device_header_invalid"


def test_body_cannot_name_a_different_account(client, gateway):
    """The token decides the account. Always.

    A body field that could steer identity would let anyone fetch anyone else's
    key by editing one line of JSON (spec R1).
    """
    provision(client, make_token(subject="victim", preferred_username="victim"))
    attacker = client.post(
        PROVISION,
        headers=auth_headers(make_token(subject="attacker", preferred_username="attacker")),
        json={"subject": "victim", "username": "victim", "account": "victim"},
    ).json()

    assert attacker["meta"]["username"] == "attacker"
    assert attacker["apiKey"] != "sk-generated-1"
    assert gateway.generate_calls == 2


# ── /v1/secrets ──────────────────────────────────────────────────────────────

def test_secrets_returns_the_stored_key_without_minting(client, gateway):
    minted = provision(client).json()
    fetched = client.get("/v1/secrets/litellm", headers=auth_headers()).json()
    assert fetched["apiKey"] == minted["apiKey"]
    assert gateway.generate_calls == 1


def test_secrets_is_404_before_anything_is_provisioned(client, gateway):
    response = client.get("/v1/secrets/litellm", headers=auth_headers())
    assert response.status_code == 404
    assert response.json()["error"] == "handler_not_found"
    assert gateway.generate_calls == 0, "a read must never mint"
