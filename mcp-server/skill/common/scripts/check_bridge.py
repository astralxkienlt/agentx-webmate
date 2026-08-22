#!/usr/bin/env python3
"""Health check for the branded browser-extension MCP bridge.

Answers the four questions that explain nearly every "WebMate tools don't
work" report, without needing a chat session:

1. Is the server registered with the host — ``mcp_servers.<name>`` in AgentX
   Workmate's config.yaml, or ``claude mcp get <name>`` for Claude Code?
2. Does the server it points at exist on disk (was ``mcp-server/`` built)?
3. Is the launcher (``node``) on PATH and new enough (>= 20)?
4. Is anything listening on the bridge port right now?

The port check is informational: the MCP host starts the server for the
duration of a session, so "not listening" between sessions is expected.

Usage:
    python check_bridge.py            # human-readable report
    python check_bridge.py --json     # machine-readable
    python check_bridge.py --config /path/to/config.yaml --port 17374

Exit status is 0 when config, build and node checks pass, 1 otherwise.
Stdlib only; PyYAML is used when available and reported when it is not.
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
    """Brand facts written next to this script at package-build time.

    Falls back to the AgentX WebMate / Workmate values so the script still runs
    from a bare checkout.
    """
    defaults: Dict[str, Any] = {
        "host": "workmate",
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
HOST = str(BRAND.get("host") or "workmate")
PRODUCT = str(BRAND["productName"])
SERVER_NAME = str(BRAND["registrationName"])
TOOL_PREFIX = str(BRAND["toolPrefix"])
EXPECTED_TOOLS = tuple(f"{TOOL_PREFIX}_{t}" for t in ("connection", "run", "extract", "status", "respond", "abort"))


def agentx_home() -> Path:
    """Profile home: ``AGENTX_HOME`` when set, else ``~/.agentx``."""
    override = os.environ.get("AGENTX_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".agentx"


def default_config_path() -> Path:
    return agentx_home() / "config.yaml"


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
    """Read just ``mcp_servers.<name>`` from block-style YAML without PyYAML.

    Good enough for what AgentX and this skill's setup script write (a mapping
    of ``command`` / ``args`` / ``env`` / ``enabled``); anything fancier should
    be read with PyYAML, which this script prefers when it is importable.
    """
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
    """Return the parsed config.yaml (PyYAML when available, else a narrow fallback)."""
    if not path.is_file():
        raise FileNotFoundError(f"config not found: {path}")
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
    except ImportError:
        return _fallback_config(text)
    data = yaml.safe_load(text) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a mapping")
    return data


def server_entry(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    servers = config.get("mcp_servers") or {}
    if not isinstance(servers, dict):
        return None
    entry = servers.get(SERVER_NAME)
    return entry if isinstance(entry, dict) else None


def entry_enabled(entry: Dict[str, Any]) -> bool:
    enabled = entry.get("enabled", True)
    if isinstance(enabled, str):
        return enabled.strip().lower() in {"true", "1", "yes", "on"}
    return bool(enabled)


def server_script(entry: Dict[str, Any]) -> Optional[Path]:
    """The ``dist/index.js`` the entry launches, if it launches one."""
    for arg in entry.get("args") or []:
        text = os.path.expandvars(str(arg))
        if text.endswith("index.js"):
            return Path(text).expanduser()
    return None


def configured_port(entry: Optional[Dict[str, Any]], override: Optional[int]) -> int:
    if override:
        return override
    env = (entry or {}).get("env") or {}
    for key in ("WEBMATE_BRIDGE_PORT", "WEBBRAIN_BRIDGE_PORT"):
        raw = str(env.get(key, "")).strip()
        if raw.isdigit():
            return int(raw)
    return DEFAULT_PORT


def node_version(command: str) -> Optional[str]:
    """``vX.Y.Z`` reported by the launcher, or None when it cannot run."""
    try:
        proc = subprocess.run(
            [command, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def node_major(version: Optional[str]) -> Optional[int]:
    if not version:
        return None
    match = re.match(r"v?(\d+)", version)
    return int(match.group(1)) if match else None


def port_listening(port: int, host: str = "127.0.0.1", timeout: float = 0.5) -> bool:
    """True when a TCP connect to host:port succeeds."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def claude_registration(name: str, claude: Optional[str] = None) -> Dict[str, Any]:
    """Ask the Claude Code CLI whether *name* is registered; never raises."""
    exe = claude or shutil.which("claude")
    if not exe:
        return {"ok": False, "detail": "`claude` CLI not found on PATH"}
    try:
        proc = subprocess.run([exe, "mcp", "get", name], capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "detail": f"claude mcp get failed: {exc}"}
    text = (proc.stdout + proc.stderr).strip()
    if proc.returncode != 0:
        return {"ok": False, "detail": text.splitlines()[-1] if text else f"exit {proc.returncode}"}
    return {"ok": True, "detail": " | ".join(line.strip() for line in text.splitlines()[:3])[:200]}


def run_checks(config_path: Optional[Path] = None, port: Optional[int] = None) -> Dict[str, Any]:
    """Run every check and return a report dict (see ``--json``)."""
    if HOST == "claude":
        return run_checks_claude(port=port)
    path = config_path or default_config_path()
    report: Dict[str, Any] = {
        "config_path": str(path),
        "checks": [],
        "next_steps": [],
        "ok": False,
    }
    checks: List[Dict[str, Any]] = report["checks"]
    steps: List[str] = report["next_steps"]

    entry: Optional[Dict[str, Any]] = None
    try:
        config = load_config(path)
        entry = server_entry(config)
    except Exception as exc:  # noqa: BLE001 - every failure is reported, not raised
        checks.append({"name": "config", "ok": False, "detail": str(exc)})
        steps.append(f"Run `python3 scripts/setup.py` (or `agentx mcp add {SERVER_NAME} --command node --args <skill>/scripts/{BRAND['bundleFile']}`).")
    else:
        if entry is None:
            checks.append({"name": "config", "ok": False, "detail": f"mcp_servers.{SERVER_NAME} is missing"})
            steps.append(f"Run `python3 scripts/setup.py` (or `agentx mcp add {SERVER_NAME} --command node --args <skill>/scripts/{BRAND['bundleFile']}`).")
        elif not entry_enabled(entry):
            checks.append({"name": "config", "ok": False, "detail": f"mcp_servers.{SERVER_NAME} is disabled"})
            steps.append(f"Set mcp_servers.{SERVER_NAME}.enabled: true in {path} (or `agentx mcp enable {SERVER_NAME}`).")
        else:
            command = str(entry.get("command") or "")
            checks.append({
                "name": "config",
                "ok": True,
                "detail": f"{command} {' '.join(str(a) for a in entry.get('args') or [])}".strip(),
            })

    script = server_script(entry) if entry else None
    if entry is not None and entry_enabled(entry):
        if script is None:
            checks.append({"name": "server_build", "ok": False, "detail": "entry does not launch an index.js; cannot locate the server build"})
            steps.append(f"Point mcp_servers.{SERVER_NAME} at <skill>/scripts/{BRAND['bundleFile']}.")
        elif script.is_file():
            checks.append({"name": "server_build", "ok": True, "detail": str(script)})
        else:
            checks.append({"name": "server_build", "ok": False, "detail": f"{script} does not exist"})
            steps.append("Rebuild the skill package (`npm run build:skill` in the extension repo's mcp-server/) or reinstall from the catalog.")

        command = str(entry.get("command") or "node")
        resolved = shutil.which(command)
        version = node_version(resolved) if resolved else None
        major = node_major(version)
        if not resolved:
            checks.append({"name": "node", "ok": False, "detail": f"{command!r} not found on PATH"})
            steps.append("Install Node.js >= 20 and make sure it is on PATH for the AgentX process.")
        elif major is None:
            checks.append({"name": "node", "ok": False, "detail": f"{resolved} did not report a version"})
            steps.append("Reinstall Node.js >= 20.")
        elif major < MIN_NODE_MAJOR:
            checks.append({"name": "node", "ok": False, "detail": f"{resolved} is {version}; need >= {MIN_NODE_MAJOR}"})
            steps.append("Upgrade Node.js to >= 20.")
        else:
            checks.append({"name": "node", "ok": True, "detail": f"{resolved} {version}"})

    bridge_port = configured_port(entry, port)
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
            else f"127.0.0.1:{bridge_port} not listening — normal between sessions; the MCP host starts the server on demand"
        ),
    })

    required = [c for c in checks if not c.get("informational")]
    report["ok"] = bool(required) and all(c["ok"] for c in required)
    if report["ok"]:
        steps.append(
            f"In Chrome: {PRODUCT} → Settings → General → Advanced → Cloud bridge → "
            f"ws://127.0.0.1:{bridge_port}/extension → enable, then call {TOOL_PREFIX}_connection."
        )
    return report


def run_checks_claude(port: Optional[int] = None) -> Dict[str, Any]:
    """Claude Code variant: registration comes from `claude mcp get`, not config.yaml."""
    report: Dict[str, Any] = {"config_path": f"claude mcp get {SERVER_NAME}", "checks": [], "next_steps": [], "ok": False}
    checks: List[Dict[str, Any]] = report["checks"]
    steps: List[str] = report["next_steps"]

    reg = claude_registration(SERVER_NAME)
    checks.append({"name": "config", "ok": reg["ok"], "detail": reg["detail"]})
    if not reg["ok"]:
        steps.append(
            "Run `python3 scripts/setup_claude.py` (or `claude mcp add --transport stdio --scope user "
            f"{SERVER_NAME} -- node <skill>/scripts/{BRAND['bundleFile']}`)."
        )

    bundle = Path(__file__).resolve().parent / str(BRAND["bundleFile"])
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
        steps.append("Install Node.js >= 20 and make sure it is on PATH for Claude Code.")
    elif major is None or major < MIN_NODE_MAJOR:
        checks.append({"name": "node", "ok": False, "detail": f"{resolved} is {version}; need >= {MIN_NODE_MAJOR}"})
        steps.append("Upgrade Node.js to >= 20.")
    else:
        checks.append({"name": "node", "ok": True, "detail": f"{resolved} {version}"})

    bridge_port = port or int(BRAND.get("bridgePort") or DEFAULT_PORT)
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
            else f"127.0.0.1:{bridge_port} not listening — normal while no Claude Code session is open; it starts the server on demand"
        ),
    })
    required = [c for c in checks if not c.get("informational")]
    report["ok"] = bool(required) and all(c["ok"] for c in required)
    if report["ok"]:
        steps.append(
            f"In Chrome: {PRODUCT} → Settings → General → Advanced → Cloud bridge → "
            f"ws://127.0.0.1:{bridge_port}/extension → enable, then call {TOOL_PREFIX}_connection."
        )
    return report


def format_report(report: Dict[str, Any]) -> str:
    lines = [f"{PRODUCT} bridge check ({report['config_path']})"]
    for check in report["checks"]:
        mark = "OK " if check["ok"] else "FAIL"
        if check.get("informational"):
            mark = "INFO"
        lines.append(f"  [{mark}] {check['name']}: {check['detail']}")
    if report["next_steps"]:
        lines.append("Next steps:")
        lines.extend(f"  - {step}" for step in report["next_steps"])
    lines.append("Expected tools: " + ", ".join(f"mcp__{SERVER_NAME}__{t}" for t in EXPECTED_TOOLS))
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=None, help="config.yaml to inspect (default: $AGENTX_HOME/config.yaml)")
    parser.add_argument("--port", type=int, default=None, help="bridge port to probe (default: from config, else 17374)")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args(argv)

    report = run_checks(config_path=args.config, port=args.port)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(format_report(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
