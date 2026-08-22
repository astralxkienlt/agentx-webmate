#!/usr/bin/env python3
"""Health check for the bundled browser-extension MCP server, across hosts.

Answers the questions that explain nearly every "the browser tools don't work"
report, without needing a chat session:

1. Is the bundled server on disk, and is Node.js >= 20 available?
2. Which hosts have the server registered — Hermes
   (``mcp_servers.<name>`` in a profile's config.yaml) and Claude Code
   (``claude mcp get <name>``)?
3. Is anything listening on the bridge port right now? (Informational: the
   host starts the server for the duration of a session, so "not listening"
   between sessions is expected.)

Usage:
    python3 check_bridge.py                 # human-readable report
    python3 check_bridge.py --json
    python3 check_bridge.py --home PATH     # a specific Hermes profile
    python3 check_bridge.py --port 17374

Exit status 0 when the build and node checks pass and at least one host has
the server registered, 1 otherwise. Stdlib only (PyYAML used when available).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_PORT = 17374
MIN_NODE_MAJOR = 20


def load_brand() -> Dict[str, Any]:
    defaults: Dict[str, Any] = {
        "productName": "AgentX WebMate",
        "registrationName": "webmate",
        "toolPrefix": "webmate",
        "bundleFile": "agentx-webmate-mcp.mjs",
        "bridgePort": DEFAULT_PORT,
    }
    path = Path(__file__).resolve().parent / "brand.json"
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            defaults.update({k: v for k, v in loaded.items() if v not in (None, "")})
    except (OSError, ValueError):
        pass
    return defaults


BRAND = load_brand()
PRODUCT = str(BRAND["productName"])
SERVER_NAME = str(BRAND["registrationName"])
TOOL_PREFIX = str(BRAND["toolPrefix"])
ENV_PREFIX = str(BRAND.get("envPrefix") or f"{TOOL_PREFIX.upper()}_")
EXPECTED_TOOLS = tuple(f"{TOOL_PREFIX}_{t}" for t in ("connection", "run", "extract", "status", "respond", "abort"))


# ─── environment ─────────────────────────────────────────────────────────────


def hermes_home() -> Path:
    override = os.environ.get("HERMES_HOME", "").strip() or os.environ.get("AGENTX_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "").strip()
        if local:
            return Path(local) / "hermes"
    if (Path.home() / ".agentx").is_dir() and not (Path.home() / ".hermes").is_dir():
        return Path.home() / ".agentx"
    return Path.home() / ".hermes"


def node_version(command: str) -> Optional[str]:
    try:
        proc = subprocess.run([command, "--version"], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout.strip() or None if proc.returncode == 0 else None


def node_major(version: Optional[str]) -> Optional[int]:
    if not version:
        return None
    match = re.match(r"v?(\d+)", version)
    return int(match.group(1)) if match else None


def port_listening(port: int, host: str = "127.0.0.1", timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


# ─── Workmate config reading (PyYAML optional) ───────────────────────────────


def _parse_scalar(raw: str) -> Any:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    if value.lower() in ("true", "yes", "on"):
        return True
    if value.lower() in ("false", "no", "off"):
        return False
    return value


def _parse_flow_list(raw: str) -> List[str]:
    inner = raw.strip()[1:-1]
    return [_parse_scalar(item) for item in re.split(r",(?=(?:[^\"']*[\"'][^\"']*[\"'])*[^\"']*$)", inner) if item.strip()]


def _fallback_config(text: str) -> Dict[str, Any]:
    """Read just ``mcp_servers.<name>`` from block-style YAML without PyYAML."""
    lines = text.split("\n")
    start = next((i for i, l in enumerate(lines) if re.match(r"^mcp_servers:\s*(#.*)?$", l)), None)
    servers: Dict[str, Any] = {}
    if start is None:
        return {"mcp_servers": servers}
    block: List[str] = []
    for line in lines[start + 1:]:
        if line and not line[0].isspace() and not line.startswith("#"):
            break
        block.append(line)
    current: Optional[str] = None
    entry: Dict[str, Any] = {}
    pending_list: Optional[str] = None
    pending_map: Optional[str] = None
    for line in block:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if indent == 2 and stripped.endswith(":"):
            current = stripped[:-1].strip()
            entry = servers.setdefault(current, {})
            pending_list = pending_map = None
        elif current is None:
            continue
        elif indent == 4 and ":" in stripped:
            key, _, rest = stripped.partition(":")
            key = key.strip()
            rest = rest.strip()
            pending_list = pending_map = None
            if rest.startswith("["):
                entry[key] = _parse_flow_list(rest)
            elif rest == "" or rest.startswith("#"):
                entry[key] = [] if key == "args" else {}
                if key == "args":
                    pending_list = key
                else:
                    pending_map = key
            else:
                entry[key] = _parse_scalar(rest)
        elif indent >= 6 and stripped.startswith("- ") and pending_list:
            entry[pending_list].append(_parse_scalar(stripped[2:]))
        elif indent >= 6 and pending_map and ":" in stripped:
            k, _, v = stripped.partition(":")
            entry[pending_map][k.strip()] = _parse_scalar(v)
    return {"mcp_servers": servers}


def load_config(path: Path) -> Dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
    except ImportError:
        return _fallback_config(text)
    data = yaml.safe_load(text) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a mapping")
    return data


def entry_enabled(entry: Dict[str, Any]) -> bool:
    enabled = entry.get("enabled", True)
    if isinstance(enabled, str):
        return enabled.strip().lower() in {"true", "1", "yes", "on"}
    return bool(enabled)


def configured_port(entry: Optional[Dict[str, Any]], override: Optional[int]) -> int:
    if override:
        return override
    env = (entry or {}).get("env") or {}
    for key in (f"{ENV_PREFIX}BRIDGE_PORT", "WEBMATE_BRIDGE_PORT", "WEBBRAIN_BRIDGE_PORT"):
        raw = str(env.get(key, "")).strip()
        if raw.isdigit():
            return int(raw)
    return int(BRAND.get("bridgePort") or DEFAULT_PORT)


# ─── per-host registration checks ───────────────────────────────────────────


def check_hermes(home: Path, bundle: Path) -> Dict[str, Any]:
    """Registration state in a Hermes profile; `present` is None when no profile exists."""
    config = home / "config.yaml"
    if not config.is_file():
        return {"host": "hermes", "present": None, "detail": f"no config.yaml at {home}", "entry": None}
    try:
        data = load_config(config)
    except Exception as exc:  # noqa: BLE001
        return {"host": "hermes", "present": False, "detail": f"{config}: {exc}", "entry": None}
    servers = data.get("mcp_servers") or {}
    entry = servers.get(SERVER_NAME) if isinstance(servers, dict) else None
    if not isinstance(entry, dict):
        return {"host": "hermes", "present": False, "detail": f"mcp_servers.{SERVER_NAME} missing in {config}", "entry": None}
    if not entry_enabled(entry):
        return {"host": "hermes", "present": False, "detail": f"mcp_servers.{SERVER_NAME} is disabled in {config}", "entry": entry}
    args = [os.path.expandvars(str(a)) for a in entry.get("args") or []]
    target = next((a for a in args if a.endswith(".mjs") or a.endswith("index.js")), "")
    stale = bool(target) and Path(target).expanduser().resolve() != bundle.resolve() and not Path(target).expanduser().is_file()
    detail = f"{entry.get('command', 'node')} {target}" + (" (path does not exist — re-run setup.py)" if stale else "")
    return {"host": "hermes", "present": not stale, "detail": detail, "entry": entry}


def check_claude(bundle: Path) -> Dict[str, Any]:
    exe = shutil.which("claude")
    if not exe:
        return {"host": "claude", "present": None, "detail": "`claude` CLI not on PATH"}
    try:
        proc = subprocess.run([exe, "mcp", "get", SERVER_NAME], capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"host": "claude", "present": False, "detail": f"claude mcp get failed: {exc}"}
    text = (proc.stdout + proc.stderr).strip()
    if proc.returncode != 0:
        return {"host": "claude", "present": False, "detail": (text.splitlines()[-1] if text else f"exit {proc.returncode}")}
    mentions_bundle = str(bundle) in text
    summary = " | ".join(line.strip() for line in text.splitlines()[:3])[:200]
    return {"host": "claude", "present": True, "detail": summary + ("" if mentions_bundle else " (registered with a different path — re-run setup.py)")}


# ─── report ──────────────────────────────────────────────────────────────────


def run_checks(home: Optional[Path] = None, port: Optional[int] = None) -> Dict[str, Any]:
    skill_dir = Path(__file__).resolve().parent.parent
    bundle = skill_dir / "scripts" / str(BRAND["bundleFile"])
    profile = (home or hermes_home()).expanduser()
    report: Dict[str, Any] = {"skill": str(skill_dir), "checks": [], "hosts": [], "next_steps": [], "ok": False}
    checks: List[Dict[str, Any]] = report["checks"]
    steps: List[str] = report["next_steps"]

    if bundle.is_file():
        checks.append({"name": "server_build", "ok": True, "detail": str(bundle)})
    else:
        checks.append({"name": "server_build", "ok": False, "detail": f"{bundle} does not exist"})
        steps.append("Rebuild the package with `npm run build:skill` in the extension repo's mcp-server/.")

    resolved = shutil.which("node")
    version = node_version(resolved) if resolved else None
    major = node_major(version)
    if not resolved:
        checks.append({"name": "node", "ok": False, "detail": "'node' not found on PATH"})
        steps.append("Install Node.js >= 20 and make sure it is on PATH for your agent.")
    elif major is None or major < MIN_NODE_MAJOR:
        checks.append({"name": "node", "ok": False, "detail": f"{resolved} is {version}; need >= {MIN_NODE_MAJOR}"})
        steps.append("Upgrade Node.js to >= 20.")
    else:
        checks.append({"name": "node", "ok": True, "detail": f"{resolved} {version}"})

    hosts = [check_hermes(profile, bundle), check_claude(bundle)]
    report["hosts"] = hosts
    registered = [h for h in hosts if h["present"]]
    if not registered:
        steps.append("Register the server: `python3 scripts/setup.py` (auto-detects Hermes and Claude Code; "
                     "`--host`, `--home PROFILE_DIR`, `--project DIR` for other cases).")

    wm_entry = hosts[0].get("entry")
    bridge_port = configured_port(wm_entry, port)
    listening = port_listening(bridge_port)
    report["bridge_port"] = bridge_port
    report["bridge_listening"] = listening
    checks.append({
        "name": "bridge_port",
        "ok": True,
        "informational": True,
        "detail": (
            f"127.0.0.1:{bridge_port} listening — the MCP server is up; the extension can attach"
            if listening
            else f"127.0.0.1:{bridge_port} not listening — normal while no agent session is open; the host starts the server on demand"
        ),
    })

    required = [c for c in checks if not c.get("informational")]
    report["ok"] = bool(required) and all(c["ok"] for c in required) and bool(registered)
    if report["ok"]:
        steps.append(
            f"In Chrome: {PRODUCT} → Settings → General → Advanced → Cloud bridge → "
            f"ws://127.0.0.1:{bridge_port}/extension → enable, then call {TOOL_PREFIX}_connection."
        )
    return report


def format_report(report: Dict[str, Any]) -> str:
    lines = [f"{PRODUCT} bridge check ({report['skill']})"]
    for check in report["checks"]:
        mark = "INFO" if check.get("informational") else ("OK " if check["ok"] else "FAIL")
        lines.append(f"  [{mark}] {check['name']}: {check['detail']}")
    for host in report["hosts"]:
        mark = "OK " if host["present"] else ("--  " if host["present"] is None else "FAIL")
        state = "registered" if host["present"] else ("not found" if host["present"] is None else "not registered")
        lines.append(f"  [{mark}] {host['host']}: {state} — {host['detail']}")
    if report["next_steps"]:
        lines.append("Next steps:")
        lines.extend(f"  - {step}" for step in report["next_steps"])
    lines.append("Expected tools: " + ", ".join(f"mcp__{SERVER_NAME}__{t}" for t in EXPECTED_TOOLS))
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--home", type=Path, default=None, help="Hermes profile to inspect (default: $HERMES_HOME or ~/.hermes)")
    parser.add_argument("--port", type=int, default=None, help="bridge port to probe (default: from config, else 17374)")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args(argv)
    report = run_checks(home=args.home, port=args.port)
    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        print(format_report(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
