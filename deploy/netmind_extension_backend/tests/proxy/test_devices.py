"""Device registry and revocation.

Three rules from the integration spec are encoded here, each with a test whose
failure would mean a real security or usability regression:

1. somebody else's device is 404, not 403;
2. revocation is a tombstone, so a revoked install cannot re-register;
3. revoking the last install while rotating is 409.
"""
from tests.conftest import auth_headers, device_id, make_token

PROVISION = "/v1/provision-keys/litellm"


def test_calling_registers_the_device(client):
    dev = device_id()
    client.get("/v1/me", headers=auth_headers(device=dev))
    devices = client.get("/v1/devices", headers=auth_headers(device=dev)).json()
    assert [d["id"] for d in devices["devices"]] == [dev]
    assert devices["current"] == dev


def test_device_list_marks_the_calling_device(client):
    token = make_token()
    first, second = device_id(), device_id()
    client.get("/v1/me", headers=auth_headers(token, first))
    body = client.get("/v1/devices", headers=auth_headers(token, second)).json()

    current = [d for d in body["devices"] if d["current"]]
    assert len(current) == 1 and current[0]["id"] == second


def test_devices_are_scoped_to_their_owner(client):
    mine = device_id()
    client.get("/v1/me", headers=auth_headers(make_token(subject="me"), mine))
    theirs = client.get(
        "/v1/devices", headers=auth_headers(make_token(subject="them"), device_id())
    ).json()
    assert mine not in [d["id"] for d in theirs["devices"]]


def test_heartbeat_records_platform_and_version(client):
    dev = device_id()
    response = client.post(
        "/v1/devices/heartbeat",
        headers=auth_headers(device=dev),
        json={"name": "Kien's Laptop", "platform": "macOS", "appVersion": "32.1.0"},
    )
    assert response.status_code == 200
    device = response.json()["device"]
    # The apostrophe is outside the allowed set [A-Za-z0-9 ._-] and is replaced
    # rather than escaped — a device name is display-only and never worth the
    # risk of carrying punctuation into a header or a log line.
    assert device["name"] == "Kien s Laptop"
    assert device["platform"] == "macOS"
    assert device["app_version"] == "32.1.0"


def test_device_name_is_sanitised(client):
    """The name arrives in an HTTP header and is whatever a user typed. Anything
    that could break header framing or a log line is removed, not escaped."""
    dev = device_id()
    response = client.post(
        "/v1/devices/heartbeat",
        headers=auth_headers(device=dev),
        json={"name": "Bad\r\nName: injected  <script>"},
    )
    name = response.json()["device"]["name"]
    assert "\r" not in name and "\n" not in name
    assert "<" not in name and ">" not in name


def test_long_device_name_is_truncated_not_rejected(client):
    """A long hostname must cost the client its name, not its check-in."""
    response = client.post(
        "/v1/devices/heartbeat",
        headers=auth_headers(device=device_id()),
        json={"name": "x" * 500},
    )
    assert response.status_code == 200
    assert len(response.json()["device"]["name"]) == 64


def test_device_id_is_case_insensitive(client):
    """Postgres normalises UUIDs; two spellings of one id must not become two
    devices in the list a user is asked to revoke from."""
    dev = device_id()
    token = make_token()
    client.get("/v1/me", headers=auth_headers(token, dev))
    client.get("/v1/me", headers=auth_headers(token, dev.upper()))
    body = client.get("/v1/devices", headers=auth_headers(token, dev)).json()
    assert len(body["devices"]) == 1


# ── Revocation ───────────────────────────────────────────────────────────────

def test_revoked_device_is_refused_afterwards(client):
    token = make_token()
    victim, caller = device_id(), device_id()
    client.get("/v1/me", headers=auth_headers(token, victim))
    client.get("/v1/me", headers=auth_headers(token, caller))

    assert client.delete(
        f"/v1/devices/{victim}", headers=auth_headers(token, caller)
    ).status_code == 200

    blocked = client.get("/v1/me", headers=auth_headers(token, victim))
    assert blocked.status_code == 403
    assert blocked.json()["error"] == "device_revoked"


def test_revocation_is_a_tombstone_not_a_delete(client):
    """A revoked install must keep getting 403 however many times it calls.

    Deleting the row would let it re-register as a brand-new device on the next
    request, which is exactly what revocation has to prevent.
    """
    token = make_token()
    victim, caller = device_id(), device_id()
    client.get("/v1/me", headers=auth_headers(token, victim))
    client.get("/v1/me", headers=auth_headers(token, caller))
    client.delete(f"/v1/devices/{victim}", headers=auth_headers(token, caller))

    for _ in range(3):
        assert client.get("/v1/me", headers=auth_headers(token, victim)).status_code == 403

    listed = client.get("/v1/devices", headers=auth_headers(token, caller)).json()
    entry = next(d for d in listed["devices"] if d["id"] == victim)
    assert entry["revoked"] is True, "the row must survive as a tombstone"


def test_revoking_someone_elses_device_is_404_not_403(client):
    """403 would confirm the id exists — a question this endpoint must not answer."""
    theirs = device_id()
    client.get("/v1/me", headers=auth_headers(make_token(subject="them"), theirs))

    response = client.delete(
        f"/v1/devices/{theirs}",
        headers=auth_headers(make_token(subject="me"), device_id()),
    )
    assert response.status_code == 404
    assert response.json()["error"] == "device_not_found"


def test_revoking_an_unknown_device_is_404(client):
    response = client.delete(
        f"/v1/devices/{device_id()}", headers=auth_headers(device=device_id())
    )
    assert response.status_code == 404
    assert response.json()["error"] == "device_not_found"


def test_revoking_twice_is_idempotent(client):
    token = make_token()
    victim, caller = device_id(), device_id()
    client.get("/v1/me", headers=auth_headers(token, victim))
    client.get("/v1/me", headers=auth_headers(token, caller))

    first = client.delete(f"/v1/devices/{victim}", headers=auth_headers(token, caller))
    second = client.delete(f"/v1/devices/{victim}", headers=auth_headers(token, caller))
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["device"]["revoked_at"] == second.json()["device"]["revoked_at"]


def test_revoke_without_rotation_leaves_the_key_alone(client, gateway):
    token = make_token()
    victim, caller = device_id(), device_id()
    client.post(PROVISION, headers=auth_headers(token, victim), json={})
    client.get("/v1/me", headers=auth_headers(token, caller))

    body = client.delete(
        f"/v1/devices/{victim}", headers=auth_headers(token, caller)
    ).json()
    assert body["key_rotation"] == "not_requested"
    assert body["key_rotated"] is False
    assert gateway.generate_calls == 1


def test_revoke_with_rotation_cuts_model_access(client, gateway):
    """Revocation alone does not cut access — one key per person means the
    revoked machine still holds a working key until it is rotated."""
    token = make_token()
    victim, caller = device_id(), device_id()
    client.post(PROVISION, headers=auth_headers(token, victim), json={})
    client.get("/v1/me", headers=auth_headers(token, caller))

    body = client.delete(
        f"/v1/devices/{victim}?rotate_key=true", headers=auth_headers(token, caller)
    ).json()
    assert body["key_rotation"] == "rotated"
    assert body["key_rotated"] is True
    assert gateway.generate_calls == 2
    assert gateway.deleted_tokens == ["token-1"]


def test_revoking_the_last_device_with_rotation_is_409(client, gateway):
    """The new key would have nowhere to go — no install left to collect it.

    Enforced in the service rather than by hiding a button, because any client
    can call the API.
    """
    token = make_token()
    only = device_id()
    client.post(PROVISION, headers=auth_headers(token, only), json={})

    response = client.delete(
        f"/v1/devices/{only}?rotate_key=true", headers=auth_headers(token, only)
    )
    assert response.status_code == 409
    assert response.json()["error"] == "cannot_revoke_last_device"
    assert gateway.generate_calls == 1, "nothing should have been rotated"

    # And the revocation itself must not have happened either.
    assert client.get("/v1/me", headers=auth_headers(token, only)).status_code == 200


def test_revoking_the_last_device_without_rotation_is_allowed(client):
    """Signing out everywhere is legitimate; only the rotation is impossible."""
    token = make_token()
    only = device_id()
    client.get("/v1/me", headers=auth_headers(token, only))
    assert client.delete(
        f"/v1/devices/{only}", headers=auth_headers(token, only)
    ).status_code == 200


def test_rotation_failure_does_not_undo_the_revocation(client, gateway):
    """Telling somebody who just revoked a stolen laptop that access was cut,
    when it was not, is worse than saying nothing. So report both facts."""
    token = make_token()
    victim, caller = device_id(), device_id()
    client.post(PROVISION, headers=auth_headers(token, victim), json={})
    client.get("/v1/me", headers=auth_headers(token, caller))

    gateway.generate_status = 500
    body = client.delete(
        f"/v1/devices/{victim}?rotate_key=true", headers=auth_headers(token, caller)
    ).json()

    assert body["key_rotation"] == "failed"
    assert body["key_rotated"] is False
    assert body["device"]["revoked"] is True, "revocation still stands"
    assert client.get("/v1/me", headers=auth_headers(token, victim)).status_code == 403


def test_rotation_reports_no_key_when_there_is_nothing_to_rotate(client):
    token = make_token()
    victim, caller = device_id(), device_id()
    client.get("/v1/me", headers=auth_headers(token, victim))
    client.get("/v1/me", headers=auth_headers(token, caller))

    body = client.delete(
        f"/v1/devices/{victim}?rotate_key=true", headers=auth_headers(token, caller)
    ).json()
    assert body["key_rotation"] == "no_key"
    assert body["key_rotated"] is False


# ── /v1/me ───────────────────────────────────────────────────────────────────

def test_me_reports_whether_a_key_exists(client):
    dev = device_id()
    token = make_token()
    assert client.get("/v1/me", headers=auth_headers(token, dev)).json()["hasKey"] is False
    client.post(PROVISION, headers=auth_headers(token, dev), json={})
    assert client.get("/v1/me", headers=auth_headers(token, dev)).json()["hasKey"] is True


def test_me_never_returns_the_key_itself(client):
    dev = device_id()
    token = make_token()
    client.post(PROVISION, headers=auth_headers(token, dev), json={})
    body = client.get("/v1/me", headers=auth_headers(token, dev)).json()
    assert "sk-" not in str(body)
