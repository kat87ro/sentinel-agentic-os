"""Plugins as capability packs.

A plugin is a MANIFEST that bundles real, reusable components and wires them
into the systems agents already use:

  - ``mcp``      : one MCP server definition → registered in the MCP registry,
                   so any agent (or project team) can attach it.
  - ``skills``   : SKILL.md bundles → dropped into skills/, runnable + injectable.
  - ``prompts``  : prompt templates → dropped into prompts/.

Plugins declare a ``config_schema`` (typed fields the operator fills in — paths,
keys, urls), the ``permissions`` they request (shown before install — AI-plugin
best practice: informed consent), a ``version`` and a ``source``. Install is
config-before-enable: a plugin with required config installs DISABLED until the
operator supplies values, then enabling wires the components live. Uninstall is
clean — it removes exactly what it added (tracked component ids), never a
hand-made MCP server or skill it didn't create.

This module is the pure data/manifest layer; server.py owns the actual writes
into the MCP registry / skills dir / prompts dir (so it can resolve the app's
real paths and audit). That keeps plugins testable against temp dirs.
"""
from __future__ import annotations

import json
import re
import time
import zipfile
from pathlib import Path

import jsonstore

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,40}$")

MANIFEST_NAMES = ("plugin.json", "manifest.json")
MAX_BUNDLE_BYTES = 25 * 1024 * 1024     # 25 MB — bundles are config, not binaries
CONFIG_FIELD_TYPES = ("string", "secret", "path", "url", "number", "bool")

# Curated marketplace — the catalog the operator browses. Each entry is a full
# manifest. {{config.KEY}} placeholders in component bodies are substituted with
# the operator's config values at wire time.
MARKETPLACE = [
    {
        "id": "filesystem-mcp",
        "name": "Filesystem Access",
        "version": "1.0.0",
        "source": "modelcontextprotocol",
        "category": "tools",
        "description": "Give agents real file read/write tools via the official "
                       "@modelcontextprotocol/server-filesystem (stdio). The folder you pick is "
                       "the launch root; when an agent runs inside a project, the Claude CLI also "
                       "scopes it to that project's working directory.",
        "permissions": ["Read and write files under the agent's working directory / configured folder"],
        "config_schema": [
            {"key": "root", "label": "Default allowed folder", "type": "path", "required": True,
             "help": "Launch root for the filesystem server. Project-attached agents are additionally scoped to their project folder."},
        ],
        "components": {
            "mcp": {
                "name": "filesystem",
                "transport": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "{{config.root}}"],
            },
        },
    },
    {
        "id": "fetch-mcp",
        "name": "Web Fetch",
        "version": "1.0.0",
        "source": "modelcontextprotocol",
        "category": "tools",
        "description": "Let agents fetch and read web pages / URLs through the MCP fetch server.",
        "permissions": ["Make outbound HTTP requests to URLs the agent chooses"],
        "config_schema": [],
        "components": {
            "mcp": {
                "name": "fetch",
                "transport": "stdio",
                "command": "uvx",
                "args": ["mcp-server-fetch"],
            },
        },
    },
    {
        "id": "git-mcp",
        "name": "Git Tools",
        "version": "1.0.0",
        "source": "modelcontextprotocol",
        "category": "tools",
        "description": "Expose git operations (status, diff, log, commit) on a repo to agents.",
        "permissions": ["Read and modify the git repository at the configured path"],
        "config_schema": [
            {"key": "repo", "label": "Repository path", "type": "path", "required": True},
        ],
        "components": {
            "mcp": {
                "name": "git",
                "transport": "stdio",
                "command": "uvx",
                "args": ["mcp-server-git", "--repository", "{{config.repo}}"],
            },
        },
    },
]

REQUIRED_MANIFEST_KEYS = ("id", "name", "version", "components")


# ─── manifest validation ──────────────────────────────────────────

def validate_manifest(m: dict) -> str | None:
    """Returns an error string, or None when the manifest is well-formed."""
    if not isinstance(m, dict):
        return "manifest must be an object"
    for k in REQUIRED_MANIFEST_KEYS:
        if k not in m:
            return f"manifest missing required key: {k}"
    if not SLUG_RE.match(str(m.get("id", ""))):
        return "id must be a slug: lowercase letters/digits/_/-, 2-41 chars"
    comps = m.get("components") or {}
    if not isinstance(comps, dict) or not comps:
        return "components must be a non-empty object (mcp / skills / prompts)"
    if not (comps.get("mcp") or comps.get("skills") or comps.get("prompts")):
        return "components must declare at least one of: mcp, skills, prompts"
    for f in m.get("config_schema") or []:
        if not f.get("key"):
            return "every config_schema field needs a key"
        if f.get("type", "string") not in CONFIG_FIELD_TYPES:
            return f"config field '{f['key']}' has invalid type '{f.get('type')}'"
    mcp = comps.get("mcp")
    if mcp is not None:
        if not isinstance(mcp, dict) or not mcp.get("name"):
            return "components.mcp needs a name"
        transport = mcp.get("transport", "stdio")
        if transport == "stdio" and not mcp.get("command"):
            return "stdio MCP component needs a command"
        if transport in ("http", "sse") and not mcp.get("url"):
            return f"{transport} MCP component needs a url"
    for s in comps.get("skills") or []:
        if not SLUG_RE.match(str(s.get("slug", ""))):
            return "every skill component needs a valid slug"
    return None


def required_config_keys(manifest: dict) -> list:
    return [f["key"] for f in (manifest.get("config_schema") or []) if f.get("required")]


def missing_config(manifest: dict, config: dict) -> list:
    """Required keys with no (non-empty) value yet."""
    config = config or {}
    return [k for k in required_config_keys(manifest)
            if not str(config.get(k, "")).strip()]


# ─── placeholder substitution ─────────────────────────────────────

_PLACEHOLDER = re.compile(r"\{\{config\.([a-zA-Z0-9_]+)\}\}")


def substitute(value, config: dict):
    """Replace {{config.KEY}} in strings (recursively in lists/dicts)."""
    config = config or {}
    if isinstance(value, str):
        return _PLACEHOLDER.sub(lambda mo: str(config.get(mo.group(1), "")), value)
    if isinstance(value, list):
        return [substitute(v, config) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, config) for k, v in value.items()}
    return value


def rendered_mcp(manifest: dict, config: dict) -> dict | None:
    """The MCP server dict this plugin contributes, with config substituted —
    or None if the plugin has no mcp component."""
    mcp = (manifest.get("components") or {}).get("mcp")
    if not mcp:
        return None
    server = substitute(dict(mcp), config)
    server["source"] = f"plugin:{manifest['id']}"
    return server


# ─── store ────────────────────────────────────────────────────────

def load(path: Path) -> dict:
    data = jsonstore.read_json(path, {"plugins": []})
    data.setdefault("plugins", [])
    return data


def save(path: Path, data: dict):
    jsonstore.atomic_write_json(path, data)


def get(path: Path, plugin_id: str) -> dict | None:
    return next((p for p in load(path)["plugins"] if p["id"] == plugin_id), None)


def record_install(path: Path, manifest: dict, config: dict, enabled: bool,
                   wired: dict, now: float) -> dict:
    """Persist an installed plugin with its config, enabled state, and the ids
    of the components it wired (for clean uninstall). RMW under the file lock so
    concurrent install/enable/uninstall can't lose entries."""
    with jsonstore.lock_for(path):
        data = load(path)
        entry = {
            "id": manifest["id"],
            "name": manifest.get("name", manifest["id"]),
            "version": manifest.get("version", "1.0.0"),
            "source": manifest.get("source", "manual"),
            "description": manifest.get("description", ""),
            "permissions": manifest.get("permissions", []),
            "config_schema": manifest.get("config_schema", []),
            "components": manifest.get("components", {}),
            "config": config or {},
            "enabled": enabled,
            "wired": wired or {},      # {"mcp_server_id":..., "skills":[...], "prompts":[...]}
            "installed": now,
            "updated": now,
        }
        data["plugins"] = [p for p in data["plugins"] if p["id"] != manifest["id"]]
        data["plugins"].append(entry)
        save(path, data)
        return entry


def update_entry(path: Path, plugin_id: str, fields: dict) -> dict | None:
    with jsonstore.lock_for(path):
        data = load(path)
        for p in data["plugins"]:
            if p["id"] == plugin_id:
                p.update(fields)
                p["updated"] = fields.get("updated", time.time())
                save(path, data)
                return p
        return None


def remove(path: Path, plugin_id: str) -> dict | None:
    with jsonstore.lock_for(path):
        data = load(path)
        entry = next((p for p in data["plugins"] if p["id"] == plugin_id), None)
        if not entry:
            return None
        data["plugins"] = [p for p in data["plugins"] if p["id"] != plugin_id]
        save(path, data)
        return entry


# ─── zip bundle install ───────────────────────────────────────────
# A bundle is a .zip with a manifest at root (plugin.json / manifest.json) and,
# optionally, the actual component files:
#     plugin.json
#     skills/<slug>/SKILL.md         (+ any context files in that folder)
#     prompts/<slug>.md
# Skill/prompt components without inline bodies in the manifest are read from
# these bundled files. MCP components are declared inline in the manifest.

def extract_bundle(zip_path: Path, dest_dir: Path) -> Path:
    """Safely extract a plugin .zip into dest_dir (zip-slip guarded). Returns
    the directory holding the manifest (handles a single top-level wrapper
    folder). Raises ValueError on a malformed/oversized/unsafe archive."""
    if zip_path.stat().st_size > MAX_BUNDLE_BYTES:
        raise ValueError(f"bundle exceeds {MAX_BUNDLE_BYTES // (1024 * 1024)} MB limit")
    dest_resolved = dest_dir.resolve()
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        raise ValueError("not a valid .zip file")
    with zf:
        # zip-slip guard for every member up front
        for info in zf.infolist():
            target = (dest_resolved / info.filename).resolve()
            if target != dest_resolved and dest_resolved not in target.parents:
                raise ValueError(f"unsafe path in bundle: {info.filename}")
        # Extract member-by-member, counting ACTUAL decompressed bytes (a zip
        # bomb lies in the header sizes, so trusting info.file_size is not a
        # real guard). Abort the moment real output exceeds the cap.
        dest_dir.mkdir(parents=True, exist_ok=True)
        written = 0
        try:
            for info in zf.infolist():
                out_path = dest_dir / info.filename
                if info.is_dir():
                    out_path.mkdir(parents=True, exist_ok=True)
                    continue
                out_path.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(out_path, "wb") as dst:
                    while True:
                        chunk = src.read(65536)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > MAX_BUNDLE_BYTES:
                            raise ValueError("bundle uncompresses to more than the size limit")
                        dst.write(chunk)
        except zipfile.BadZipFile:
            raise ValueError("corrupt bundle (truncated or CRC mismatch)")
    return _manifest_root(dest_dir)


def _manifest_root(dest_dir: Path) -> Path:
    """Locate the dir containing the manifest — root, or a single wrapper folder
    (the common 'zip of a folder' case)."""
    for name in MANIFEST_NAMES:
        if (dest_dir / name).exists():
            return dest_dir
    children = [c for c in dest_dir.iterdir() if c.is_dir() and not c.name.startswith(("_", "."))]
    if len(children) == 1:
        for name in MANIFEST_NAMES:
            if (children[0] / name).exists():
                return children[0]
    raise ValueError("bundle has no plugin.json / manifest.json at its root")


def load_bundle_manifest(root: Path) -> dict:
    """Read the manifest and inline any file-based skill/prompt bodies so the
    standard install path can wire them. Skills present as folders are flagged
    with _bundle_skill_dir for the caller to copy verbatim (preserves context
    files); single-file skills/prompts are inlined as text."""
    mpath = next((root / n for n in MANIFEST_NAMES if (root / n).exists()), None)
    if not mpath:
        raise ValueError("manifest not found")
    try:
        manifest = json.loads(mpath.read_text())
    except json.JSONDecodeError as e:
        raise ValueError(f"manifest is not valid JSON: {e}")
    # Validate BEFORE touching the filesystem — a traversal slug must never
    # reach a path read, even though install also re-validates downstream.
    err = validate_manifest(manifest)
    if err:
        raise ValueError(err)
    comps = manifest.get("components") or {}
    for skill in comps.get("skills") or []:
        slug = skill.get("slug", "")
        if not SLUG_RE.match(slug):          # belt-and-suspenders on the path component
            continue
        sdir = root / "skills" / slug
        if not skill.get("skill_md") and (sdir / "SKILL.md").exists():
            # mark the bundled folder for verbatim copy (keeps context files)…
            skill["_bundle_skill_dir"] = str(sdir.resolve())
            # …and inline the SKILL.md text as a fallback so a later re-wire
            # (after the temp bundle is gone) can still recreate the skill.
            skill["skill_md"] = (sdir / "SKILL.md").read_text()
    for prompt in comps.get("prompts") or []:
        slug = prompt.get("slug", "")
        if not SLUG_RE.match(slug):
            continue
        pf = root / "prompts" / f"{slug}.md"
        if not prompt.get("body") and pf.exists():
            prompt["body"] = pf.read_text()
    return manifest
