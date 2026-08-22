#!/usr/bin/env python3
"""Register the bundled browser-extension MCP server with AgentX Workmate.

This skill ships the MCP server as a single file (scripts/<brand>-mcp.mjs), so
all AgentX needs is one config entry:

    mcp_servers:
      <name>:
        command: node
        args: ["<this skill>/scripts/<brand>-mcp.mjs"]
        enabled: true

Steps:
  1. Locate the bundle next to this script and check Node.js >= 20.
  2. Write mcp_servers.<name> into the target profile's config.yaml through the
     first method that works:
       a. the Workmate Python API   (this interpreter can import hermes_cli)
       b. the `agentx` CLI          (--agentx, $AGENTX_CLI, PATH, managed venv)
       c. a direct edit of config.yaml (backup kept next to it)
     and otherwise prints the YAML for you to paste.
  3. Print the browser-side steps (Cloud bridge on port 17374).

Usage:
    python3 setup.py                       # register into $AGENTX_HOME (default ~/.agentx)
    python3 setup.py --home PATH           # another profile, e.g. ~/.agentx/accounts/<slug>
    python3 setup.py --agentx /path/to/agentx
    python3 setup.py --node /path/to/node  # pin the launcher path in config
    python3 setup.py --dry-run             # show what would be written

Exit status 0 when the entry was written, 1 otherwise. Stdlib only; no
PyYAML required (used for a final validation only when available).
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

MIN_NODE_MAJOR = 20


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
        import json
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
BUNDLE_NAME = str(BRAND["bundleFile"])
BRIDGE_URL = f"ws://127.0.0.1:{BRAND['bridgePort']}/extension"


# ─── locations ──────────────────────────────────────────────────────────────


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
    candidates: List[str] = []
    if explicit:
        candidates.append(explicit)
    found = shutil.which("node")
    if found:
        candidates.append(found)
    candidates += [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        str(Path.home() / ".agentx" / "node" / "bin" / "node"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
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
    # Running under a venv that has the CLI installed (e.g. a source checkout).
    exe_dir = Path(sys.executable).resolve().parent
    candidates.append(exe_dir / ("agentx.exe" if os.name == "nt" else "agentx"))
    root = install_root(home)
    if os.name == "nt":
        candidates += [
            root / "agentx-agent" / "venv" / "Scripts" / "agentx.exe",
            root / "bin" / "agentx.exe",
        ]
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


# ─── the entry ──────────────────────────────────────────────────────────────


def build_entry(bundle: Path, node: str, pin_node: bool) -> Dict[str, object]:
    return {"command": node if pin_node else "node", "args": [str(bundle)], "enabled": True}


def entry_block(entry: Dict[str, object], indent: int = 2) -> str:
    """The `<name>:` subtree as block-style YAML at the given indent."""
    pad = " " * indent
    lines = [f"{pad}{SERVER_NAME}:", f"{pad}  command: {entry['command']}", f"{pad}  args:"]
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
    return re.search(rf"^mcp_servers:[^\n]*\n(?:[ \t]+[^\n]*\n|\s*\n)*?[ \t]{{2,}}{SERVER_NAME}:", text, re.M) is not None


# ─── writers, most-integrated first ─────────────────────────────────────────


def register_via_api(home: Path, entry: Dict[str, object]) -> Optional[bool]:
    """Use Workmate's own config writer when this interpreter can import it.

    `hermes_cli` is an installed package, but its modules import top-level
    repo modules (`branding`, `hermes_constants`) that only resolve with the
    repo root on sys.path — so put the package's parent there first.
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
        return bool(_save_mcp_server(SERVER_NAME, dict(entry)))
    except Exception as exc:  # noqa: BLE001 - surfaced to the user, then fall through
        print(f"  Workmate API write failed: {exc}")
        return False


def register_via_cli(agentx: str, home: Path, entry: Dict[str, object]) -> bool:
    env = dict(os.environ, AGENTX_HOME=str(home))
    # `mcp add` refuses to overwrite without a TTY (its prompt defaults to "no"),
    # while `mcp remove` proceeds (defaults to "yes") — so drop a stale entry first.
    subprocess.run(
        [agentx, "mcp", "remove", SERVER_NAME],
        env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False,
    )
    cmd = [agentx, "mcp", "add", SERVER_NAME, "--command", str(entry["command"]), "--args", *map(str, entry["args"])]  # type: ignore[arg-type]
    # `mcp add` probes the server and then asks "Enable all N tools? [Y/n/select]".
    proc = subprocess.run(cmd, env=env, input="y\n", capture_output=True, text=True, check=False)
    for line in (proc.stdout + proc.stderr).strip().splitlines()[-4:]:
        print(f"    {line.strip()}")
    return proc.returncode == 0 and entry_present(home)


def register_via_text(home: Path, entry: Dict[str, object]) -> bool:
    """Edit config.yaml directly (block-style YAML), keeping a backup.

    Handles: no config yet; no `mcp_servers:` key; an existing `mcp_servers:`
    block (the entry is inserted right under it, replacing a stale `<name>:`
    subtree); and an empty `mcp_servers: {}` placeholder.
    """
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

    # Locate the mcp_servers: block.
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
        # Drop an existing <name>: subtree (a 2-space key and everything deeper).
        kept: List[str] = []
        skipping = False
        for line in body:
            if re.match(rf"^  {SERVER_NAME}:\s*(#.*)?$", line):
                skipping = True
                continue
            if skipping:
                if line.strip() == "" or re.match(r"^ {3,}", line):
                    continue
                skipping = False
            kept.append(line)
        lines[start + 1:end] = block.split("\n") + kept

    text = "\n".join(lines)
    backup = config.with_name(f"{config.name}.bak-{SERVER_NAME}")
    shutil.copyfile(config, backup)
    config.write_text(text, encoding="utf-8")

    try:  # Validate when PyYAML is around; restore the backup on a broken document.
        import yaml  # type: ignore
        parsed = yaml.safe_load(text) or {}
        if not isinstance(parsed.get("mcp_servers", {}).get(SERVER_NAME), dict):
            raise ValueError("entry not found after write")
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001
        shutil.copyfile(backup, config)
        print(f"  direct edit produced an invalid config ({exc}); restored the backup")
        return False
    return entry_present(home)


# ─── main ───────────────────────────────────────────────────────────────────


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--home", type=Path, default=None, help="AGENTX_HOME to write into (default: $AGENTX_HOME or ~/.agentx)")
    parser.add_argument("--agentx", default=None, help="path to the agentx CLI to use for registration")
    parser.add_argument("--node", default=None, help="path to the node binary to pin in config (default: bare `node` on PATH)")
    parser.add_argument("--dry-run", action="store_true", help="print the entry and stop without writing")
    args = parser.parse_args(argv)

    skill_dir = Path(__file__).resolve().parent.parent
    bundle = skill_dir / "scripts" / BUNDLE_NAME
    home = (args.home or default_home()).expanduser().resolve()

    print(f"{PRODUCT} skill setup")
    print(f"  skill:   {skill_dir}")
    print(f"  profile: {home}")

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
    pin_node = bool(args.node) or shutil.which("node") is None
    print(f"  node:    {node} (v{major}){' — pinned in config' if pin_node else ''}")

    entry = build_entry(bundle, node, pin_node)
    print("  entry:")
    for line in yaml_snippet(entry).splitlines():
        print(f"    {line}")

    if args.dry_run:
        print("  dry run — nothing written.")
        return 0

    method = "Workmate Python API"
    written = register_via_api(home, entry)
    if not written:
        agentx = find_agentx_cli(home, args.agentx)
        if agentx:
            method = f"agentx CLI ({agentx})"
            written = register_via_cli(agentx, home, entry)
    if not written:
        method = f"direct edit of {home / 'config.yaml'} (backup: config.yaml.bak-{SERVER_NAME})"
        written = register_via_text(home, entry)

    if not written:
        print("  ✗ could not write config automatically.")
        print(f"    Add this to {home / 'config.yaml'} (merge under an existing mcp_servers: block):")
        for line in yaml_snippet(entry).splitlines():
            print(f"      {line}")
        print(f"    or run:  agentx mcp add {SERVER_NAME} --command {entry['command']} --args \"{bundle}\"")
        return 1

    print(f"  ✓ mcp_servers.{SERVER_NAME} written via {method}")
    print("Next:")
    print(f"  1. Start a new AgentX session (or /reload-mcp). Tools appear as mcp__{SERVER_NAME}__{TOOL_PREFIX}_*.")
    print(f"  2. Chrome → {PRODUCT} → Settings → General → Advanced → Cloud bridge →")
    print(f"     {BRIDGE_URL} → enable. Status should read Connected while a session runs.")
    print(f"  3. Ask AgentX to call mcp__{SERVER_NAME}__{TOOL_PREFIX}_connection.")
    print(f"  Health check: python3 \"{skill_dir / 'scripts' / 'check_bridge.py'}\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
