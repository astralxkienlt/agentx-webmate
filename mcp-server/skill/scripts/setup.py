#!/usr/bin/env python3
"""Register the bundled browser-extension MCP server with the agent(s) on this machine.

This skill ships its MCP server as one file (scripts/<brand>-mcp.mjs), so every
host only needs to know how to launch it. Hosts this script understands:

  workmate   AgentX Workmate / Hermes — writes mcp_servers.<name> into the profile's
             config.yaml (Workmate Python API → `agentx` CLI → backed-up direct edit)
  claude     Claude Code — `claude mcp add --transport stdio --scope user <name> -- node <bundle>`
  mcp-json   anything that reads an mcpServers JSON file — writes/merges DIR/.mcp.json

Default (--host auto): register with every host found here, then print the generic
mcpServers JSON for any other host (Codex, Cursor, ...).

Usage:
    python3 setup.py                                  # auto-detect hosts
    python3 setup.py --host claude                    # one host only
    python3 setup.py --host workmate --home PATH      # a specific Workmate profile
    python3 setup.py --project DIR                    # also write DIR/.mcp.json
    python3 setup.py --node /path/to/node             # pin the launcher path
    python3 setup.py --dry-run

Exit status 0 when at least one registration succeeded (or --dry-run), 1 otherwise.
Stdlib only; PyYAML is used for a final validation only when available.
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
HOSTS = ("workmate", "claude", "mcp-json")


# ─── brand ───────────────────────────────────────────────────────────────────


def load_brand() -> Dict[str, object]:
    """Brand facts written next to this script at package-build time (AgentX defaults)."""
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


# ─── locations ───────────────────────────────────────────────────────────────


def default_home() -> Path:
    override = os.environ.get("AGENTX_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "").strip()
        if local:
            return Path(local) / "agentx"
    return Path.home() / ".agentx"


def install_root(home: Path) -> Path:
    """Climb out of accounts/<slug> and profiles/<name> to the install root."""
    path = home
    if path.parent.name == "profiles":
        path = path.parent.parent
    if path.parent.name == "accounts":
        path = path.parent.parent
    return path


def find_node(explicit: Optional[str]) -> Optional[str]:
    candidates: List[str] = [c for c in [explicit, shutil.which("node")] if c]
    candidates += [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        str(Path.home() / ".agentx" / "node" / "bin" / "node"),
    ]
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


def find_agentx_cli(home: Path, explicit: Optional[str]) -> Optional[str]:
    candidates: List[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env_cli = os.environ.get("AGENTX_CLI", "").strip()
    if env_cli:
        candidates.append(Path(env_cli).expanduser())
    found = shutil.which("agentx")
    if found:
        candidates.append(Path(found))
    exe_dir = Path(sys.executable).resolve().parent
    candidates.append(exe_dir / ("agentx.exe" if os.name == "nt" else "agentx"))
    root = install_root(home)
    if os.name == "nt":
        candidates += [root / "agentx-agent" / "venv" / "Scripts" / "agentx.exe", root / "bin" / "agentx.exe"]
    else:
        candidates += [
            root / "agentx-agent" / "venv" / "bin" / "agentx",
            root / "agentx-agent" / ".venv" / "bin" / "agentx",
            root / "bin" / "agentx",
        ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def find_claude(explicit: Optional[str]) -> Optional[str]:
    for candidate in [explicit, os.environ.get("CLAUDE_CLI", "").strip() or None, shutil.which("claude")]:
        if candidate and Path(candidate).is_file():
            return candidate
    if os.name != "nt":
        for candidate in (Path.home() / ".claude" / "local" / "claude", Path("/usr/local/bin/claude")):
            if candidate.is_file():
                return str(candidate)
    return None


def hermes_importable() -> bool:
    try:
        import hermes_cli  # type: ignore  # noqa: F401
        return True
    except Exception:
        return False


# ─── the entry ───────────────────────────────────────────────────────────────


def build_entry(bundle: Path, command: str) -> Dict[str, object]:
    return {"command": command, "args": [str(bundle)], "enabled": True}


def mcp_json_entry(entry: Dict[str, object]) -> Dict[str, object]:
    return {"type": "stdio", "command": entry["command"], "args": list(entry["args"])}  # type: ignore[arg-type]


def entry_block(entry: Dict[str, object], indent: int = 2) -> str:
    """The `<name>:` subtree as block-style YAML at the given indent."""
    pad = " " * indent
    lines = [f"{pad}{NAME}:", f"{pad}  command: {entry['command']}", f"{pad}  args:"]
    lines += [f"{pad}    - \"{a}\"" for a in entry["args"]]  # type: ignore[index]
    lines.append(f"{pad}  enabled: true")
    return "\n".join(lines)


def yaml_snippet(entry: Dict[str, object]) -> str:
    return "mcp_servers:\n" + entry_block(entry)


def entry_present(home: Path) -> bool:
    config = home / "config.yaml"
    if not config.is_file():
        return False
    text = config.read_text(encoding="utf-8", errors="replace")
    return re.search(rf"^mcp_servers:[^\n]*\n(?:[ \t]+[^\n]*\n|\s*\n)*?[ \t]{{2,}}{NAME}:", text, re.M) is not None


# ─── Workmate writers, most-integrated first ─────────────────────────────────


def register_via_api(home: Path, entry: Dict[str, object]) -> Optional[bool]:
    """Use Workmate's own config writer when this interpreter can import it.

    `hermes_cli` is an installed package, but its modules import top-level repo
    modules (`branding`, `hermes_constants`) that only resolve with the repo
    root on sys.path — so put the package's parent there first.
    """
    os.environ["AGENTX_HOME"] = str(home)
    try:
        import hermes_cli  # type: ignore
    except Exception:
        return None
    repo_root = str(Path(hermes_cli.__file__).resolve().parent.parent)
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    try:
        from hermes_cli.mcp_config import _save_mcp_server  # type: ignore
    except Exception:
        return None
    try:
        return bool(_save_mcp_server(NAME, dict(entry)))
    except Exception as exc:  # noqa: BLE001
        print(f"    Workmate API write failed: {exc}")
        return False


def register_via_cli(agentx: str, home: Path, entry: Dict[str, object]) -> bool:
    env = dict(os.environ, AGENTX_HOME=str(home))
    # `mcp add` refuses to overwrite without a TTY (its prompt defaults to "no"),
    # while `mcp remove` proceeds (defaults to "yes") — so drop a stale entry first.
    subprocess.run([agentx, "mcp", "remove", NAME], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False)
    cmd = [agentx, "mcp", "add", NAME, "--command", str(entry["command"]), "--args", *map(str, entry["args"])]  # type: ignore[arg-type]
    # `mcp add` probes the server and then asks "Enable all N tools? [Y/n/select]".
    proc = subprocess.run(cmd, env=env, input="y\n", capture_output=True, text=True, check=False)
    for line in (proc.stdout + proc.stderr).strip().splitlines()[-3:]:
        print(f"    {line.strip()}")
    return proc.returncode == 0 and entry_present(home)


def register_via_text(home: Path, entry: Dict[str, object]) -> bool:
    """Edit config.yaml directly (block-style YAML), keeping a backup."""
    config = home / "config.yaml"
    block = entry_block(entry)
    if not config.is_file():
        home.mkdir(parents=True, exist_ok=True)
        config.write_text(yaml_snippet(entry) + "\n", encoding="utf-8")
        return True

    original = config.read_text(encoding="utf-8")
    lines = original.split("\n")

    def is_top_level(line: str) -> bool:
        return bool(line) and not line[0].isspace() and not line.startswith("#")

    start = next((i for i, l in enumerate(lines) if re.match(r"^mcp_servers:\s*(#.*)?$", l)), None)
    empty_map = next((i for i, l in enumerate(lines) if re.match(r"^mcp_servers:\s*\{\s*\}\s*(#.*)?$", l)), None)
    if start is None and empty_map is not None:
        lines[empty_map] = "mcp_servers:"
        start = empty_map
    if start is None:
        if lines and lines[-1] != "":
            lines.append("")
        lines += ["mcp_servers:", *block.split("\n"), ""]
    else:
        end = next((i for i in range(start + 1, len(lines)) if is_top_level(lines[i])), len(lines))
        body = lines[start + 1:end]
        kept: List[str] = []
        skipping = False
        for line in body:
            if re.match(rf"^  {NAME}:\s*(#.*)?$", line):
                skipping = True
                continue
            if skipping:
                if line.strip() == "" or re.match(r"^ {3,}", line):
                    continue
                skipping = False
            kept.append(line)
        lines[start + 1:end] = block.split("\n") + kept

    text = "\n".join(lines)
    backup = config.with_name(f"{config.name}.bak-{NAME}")
    shutil.copyfile(config, backup)
    config.write_text(text, encoding="utf-8")
    try:
        import yaml  # type: ignore
        parsed = yaml.safe_load(text) or {}
        if not isinstance(parsed.get("mcp_servers", {}).get(NAME), dict):
            raise ValueError("entry not found after write")
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001
        shutil.copyfile(backup, config)
        print(f"    direct edit produced an invalid config ({exc}); restored the backup")
        return False
    return entry_present(home)


def register_workmate(home: Path, entry: Dict[str, object], agentx_explicit: Optional[str]) -> bool:
    print(f"  [workmate] profile {home}")
    written = register_via_api(home, entry)
    method = "Workmate Python API"
    if not written:
        agentx = find_agentx_cli(home, agentx_explicit)
        if agentx:
            method = f"agentx CLI ({agentx})"
            written = register_via_cli(agentx, home, entry)
    if not written:
        method = f"direct edit of config.yaml (backup: config.yaml.bak-{NAME})"
        written = register_via_text(home, entry)
    if written:
        print(f"  [workmate] ✓ mcp_servers.{NAME} written via {method}")
        print(f"  [workmate]   next: new AgentX session or /reload-mcp → tools mcp__{NAME}__{TOOL_PREFIX}_*")
    else:
        print(f"  [workmate] ✗ could not write config; add this to {home / 'config.yaml'}:")
        for line in yaml_snippet(entry).splitlines():
            print(f"      {line}")
    return bool(written)


# ─── Claude Code / generic JSON ──────────────────────────────────────────────


def register_claude(claude: str, entry: Dict[str, object]) -> bool:
    env = dict(os.environ)
    subprocess.run([claude, "mcp", "remove", "--scope", "user", NAME], env=env, capture_output=True, text=True, check=False)
    cmd = [claude, "mcp", "add", "--transport", "stdio", "--scope", "user", NAME, "--", str(entry["command"]), *map(str, entry["args"])]  # type: ignore[arg-type]
    print("  [claude] $ " + " ".join(cmd))
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, check=False)
    for line in (proc.stdout + proc.stderr).strip().splitlines()[-2:]:
        print(f"    {line.strip()}")
    if proc.returncode != 0:
        print(f"  [claude] ✗ registration failed")
        return False
    check = subprocess.run([claude, "mcp", "get", NAME], env=env, capture_output=True, text=True, check=False)
    ok = check.returncode == 0 and str(entry["args"][0]) in (check.stdout + check.stderr)  # type: ignore[index]
    if ok:
        print(f"  [claude] ✓ registered at user scope → restart Claude Code (or /mcp) → tools mcp__{NAME}__{TOOL_PREFIX}_*")
    else:
        print("  [claude] ✗ `claude mcp get` does not show the bundle path")
    return ok


def register_project(project: Path, entry: Dict[str, object]) -> bool:
    path = project / ".mcp.json"
    data: Dict[str, object] = {}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8")) or {}
        except ValueError as exc:
            print(f"  [mcp-json] ✗ {path} is not valid JSON ({exc})")
            return False
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    servers[NAME] = mcp_json_entry(entry)
    data["mcpServers"] = servers
    project.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"  [mcp-json] ✓ wrote {path}")
    return True


# ─── main ────────────────────────────────────────────────────────────────────


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", choices=("auto", *HOSTS), default="auto", help="which host to register with (default: every host found)")
    parser.add_argument("--home", type=Path, default=None, help="Workmate profile (AGENTX_HOME) to write into; default $AGENTX_HOME or ~/.agentx")
    parser.add_argument("--agentx", default=None, help="path to the agentx CLI")
    parser.add_argument("--claude", default=None, help="path to the claude CLI")
    parser.add_argument("--project", type=Path, default=None, help="also write DIR/.mcp.json (project scope for Claude Code and other mcpServers readers)")
    parser.add_argument("--node", default=None, help="path to node to pin (default: bare `node` on PATH)")
    parser.add_argument("--dry-run", action="store_true", help="show what would be registered and stop")
    args = parser.parse_args(argv)

    skill_dir = Path(__file__).resolve().parent.parent
    bundle = skill_dir / "scripts" / BUNDLE_NAME
    print(f"{PRODUCT} — MCP server setup")
    print(f"  skill:  {skill_dir}")
    if not bundle.is_file():
        print(f"  ✗ bundled server missing: {bundle}")
        print("    Rebuild the package with `npm run build:skill` in the extension repo's mcp-server/.")
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
    entry = build_entry(bundle, command)
    generic = json.dumps({"mcpServers": {NAME: mcp_json_entry(entry)}}, indent=2)
    print(f"  node:   {node} (v{major})")

    home = (args.home or default_home()).expanduser().resolve()
    claude = find_claude(args.claude)
    workmate_detected = bool(
        args.home or args.agentx or os.environ.get("AGENTX_HOME")
        or (home / "config.yaml").is_file() or hermes_importable() or find_agentx_cli(home, None)
    )
    wanted = list(HOSTS) if args.host == "auto" else [args.host]
    if args.project is not None and "mcp-json" not in wanted:
        wanted.append("mcp-json")

    plan: List[str] = []
    if "workmate" in wanted and (workmate_detected or args.host == "workmate"):
        plan.append("workmate")
    if "claude" in wanted and (claude or args.host == "claude"):
        plan.append("claude")
    if "mcp-json" in wanted and args.project is not None:
        plan.append("mcp-json")
    print("  hosts:  " + (", ".join(plan) if plan else "none detected"))
    if "workmate" not in plan and "workmate" in wanted and home.is_dir():
        print(f"          (AgentX dir {home} exists but no config.yaml — pass --host workmate --home PROFILE_DIR)")

    if args.dry_run:
        print("  dry run — nothing written. Generic mcpServers entry:")
        print("\n".join(f"    {l}" for l in generic.splitlines()))
        return 0

    results: Dict[str, bool] = {}
    if "workmate" in plan:
        results["workmate"] = register_workmate(home, entry, args.agentx)
    if "claude" in plan:
        if claude:
            results["claude"] = register_claude(claude, entry)
        else:
            print("  [claude] ✗ `claude` CLI not found; install Claude Code or use --project DIR")
            results["claude"] = False
    if "mcp-json" in plan:
        results["mcp-json"] = register_project(args.project.expanduser().resolve(), entry)  # type: ignore[union-attr]

    print("  For any other MCP host, add this entry to its mcpServers config:")
    print("\n".join(f"    {l}" for l in generic.splitlines()))
    print("  Then, in Chrome:")
    print(f"    {PRODUCT} → Settings → General → Advanced → Cloud bridge → {BRIDGE_URL} → enable")
    print(f"    and ask your agent to call {TOOL_PREFIX}_connection. Health check: python3 \"{skill_dir / 'scripts' / 'check_bridge.py'}\"")

    if not results:
        print("  ✗ no host registered automatically (none detected). Use the entry above, or --host/--project.")
        return 1
    return 0 if any(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
