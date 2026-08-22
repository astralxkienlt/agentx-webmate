#!/usr/bin/env python3
"""Register the bundled browser-extension MCP server with Claude Code.

The skill ships the server as one file (scripts/<brand>-mcp.mjs); Claude Code
just needs to know how to launch it. Two ways, pick one:

  user scope (default) — available in every project:
      claude mcp add --transport stdio --scope user <name> -- node <abs path>/scripts/<brand>-mcp.mjs
  project scope — a .mcp.json next to the code you are working on:
      python3 setup_claude.py --project /path/to/project

Usage:
    python3 setup_claude.py                 # user scope via the `claude` CLI
    python3 setup_claude.py --project DIR   # write/merge DIR/.mcp.json instead
    python3 setup_claude.py --claude /path/to/claude
    python3 setup_claude.py --dry-run

Exit status 0 when registered, 1 otherwise. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

MIN_NODE_MAJOR = 20


def load_brand() -> Dict[str, object]:
    defaults: Dict[str, object] = {
        "productName": "AgentX WebMate",
        "registrationName": "webmate",
        "toolPrefix": "webmate",
        "bundleFile": "agentx-webmate-mcp.mjs",
        "bridgePort": 17374,
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
NAME = str(BRAND["registrationName"])
TOOL_PREFIX = str(BRAND["toolPrefix"])
BUNDLE_NAME = str(BRAND["bundleFile"])
BRIDGE_URL = f"ws://127.0.0.1:{BRAND['bridgePort']}/extension"


def find_node(explicit: Optional[str]) -> Optional[str]:
    candidates: List[str] = [c for c in [explicit, shutil.which("node")] if c]
    candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    return None


def node_major(node: str) -> Optional[int]:
    try:
        proc = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"v?(\d+)", proc.stdout.strip())
    return int(match.group(1)) if match else None


def find_claude(explicit: Optional[str]) -> Optional[str]:
    for candidate in [explicit, os.environ.get("CLAUDE_CLI", "").strip() or None, shutil.which("claude")]:
        if candidate and Path(candidate).is_file():
            return candidate
    if os.name != "nt":
        for candidate in (Path.home() / ".claude" / "local" / "claude", Path("/usr/local/bin/claude")):
            if candidate.is_file():
                return str(candidate)
    return None


def server_entry(bundle: Path, command: str) -> Dict[str, object]:
    return {"type": "stdio", "command": command, "args": [str(bundle)]}


def register_user_scope(claude: str, bundle: Path, command: str) -> bool:
    env = dict(os.environ)
    # Replace any stale entry (different path) — remove is harmless when absent.
    subprocess.run([claude, "mcp", "remove", "--scope", "user", NAME], env=env, capture_output=True, text=True, check=False)
    cmd = [claude, "mcp", "add", "--transport", "stdio", "--scope", "user", NAME, "--", command, str(bundle)]
    print("  $ " + " ".join(cmd))
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, check=False)
    for line in (proc.stdout + proc.stderr).strip().splitlines()[-3:]:
        print(f"    {line.strip()}")
    if proc.returncode != 0:
        return False
    check = subprocess.run([claude, "mcp", "get", NAME], env=env, capture_output=True, text=True, check=False)
    return check.returncode == 0 and str(bundle) in (check.stdout + check.stderr)


def register_project(project: Path, bundle: Path, command: str) -> bool:
    path = project / ".mcp.json"
    data: Dict[str, object] = {}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8")) or {}
        except ValueError as exc:
            print(f"  ✗ {path} is not valid JSON ({exc}); fix it or pick another project")
            return False
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    servers[NAME] = server_entry(bundle, command)
    data["mcpServers"] = servers
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"  ✓ wrote {path}")
    return True


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", type=Path, default=None, help="register in DIR/.mcp.json (project scope) instead of user scope")
    parser.add_argument("--claude", default=None, help="path to the claude CLI")
    parser.add_argument("--node", default=None, help="path to node to pin in the registration (default: bare `node`)")
    parser.add_argument("--dry-run", action="store_true", help="print the registration and stop")
    args = parser.parse_args(argv)

    skill_dir = Path(__file__).resolve().parent.parent
    bundle = skill_dir / "scripts" / BUNDLE_NAME
    print(f"{PRODUCT} — Claude Code setup")
    print(f"  skill:  {skill_dir}")
    if not bundle.is_file():
        print(f"  ✗ bundled server missing: {bundle}")
        return 1

    node = find_node(args.node)
    if not node:
        print("  ✗ node not found. Install Node.js >= 20 (https://nodejs.org) and re-run.")
        return 1
    major = node_major(node)
    if major is None or major < MIN_NODE_MAJOR:
        print(f"  ✗ {node} reports {major}; Node.js >= {MIN_NODE_MAJOR} is required.")
        return 1
    command = node if (args.node or shutil.which("node") is None) else "node"
    print(f"  node:   {node} (v{major})")
    print(f"  entry:  {json.dumps({'mcpServers': {NAME: server_entry(bundle, command)}})}")

    if args.dry_run:
        print("  dry run — nothing written.")
        return 0

    if args.project is not None:
        ok = register_project(args.project.expanduser().resolve(), bundle, command)
    else:
        claude = find_claude(args.claude)
        if not claude:
            print("  ✗ `claude` CLI not found. Install Claude Code, or use --project DIR to write .mcp.json.")
            print(f"    Manual: claude mcp add --transport stdio --scope user {NAME} -- {command} \"{bundle}\"")
            return 1
        ok = register_user_scope(claude, bundle, command)

    if not ok:
        print("  ✗ registration failed. Manual command:")
        print(f"    claude mcp add --transport stdio --scope user {NAME} -- {command} \"{bundle}\"")
        return 1

    print(f"  ✓ registered as '{NAME}'. Tools: mcp__{NAME}__{TOOL_PREFIX}_run, _extract, _status, _respond, _abort, _connection")
    print("Next:")
    print("  1. Restart Claude Code (or run /mcp and reconnect) so the server is started.")
    print(f"  2. Chrome → {PRODUCT} → Settings → General → Advanced → Cloud bridge → {BRIDGE_URL} → enable.")
    print(f"  3. In Claude Code: /{NAME} or ask it to call mcp__{NAME}__{TOOL_PREFIX}_connection.")
    print(f"  Health check: python3 \"{skill_dir / 'scripts' / 'check_bridge.py'}\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
