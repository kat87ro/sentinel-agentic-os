"""MCP server registry + config generation.

Stores MCP (Model Context Protocol) server definitions and renders the standard
``{"mcpServers": {...}}`` config that MCP-capable agent CLIs consume via
``--mcp-config``. The platform manages and mirrors definitions; the CLIs perform
the actual MCP tool calls (pass-through model).

Pure helpers take an explicit ``path`` so they are testable against a temp dir.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

TRANSPORTS = ("stdio", "http", "sse")


def load(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return {"servers": []}
    return {"servers": []}


def save(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def normalize_server(raw: dict) -> dict:
    """Coerce an arbitrary server dict into the registry shape."""
    transport = raw.get("transport") or raw.get("type") or ("stdio" if raw.get("command") else "http")
    if transport not in TRANSPORTS:
        transport = "stdio" if raw.get("command") else "http"
    return {
        "id": raw.get("id") or f"{_slug(raw.get('name', 'mcp'))}_{uuid.uuid4().hex[:6]}",
        "name": raw.get("name", "mcp-server"),
        "transport": transport,
        "command": raw.get("command", ""),
        "args": raw.get("args", []) or [],
        "env": raw.get("env", {}) or {},          # may hold values or key_refs
        "url": raw.get("url", ""),
        "headers": raw.get("headers", {}) or {},
        "enabled": raw.get("enabled", True),
        "scope": raw.get("scope", "user"),
        "source": raw.get("source", "manual"),
    }


def get_by_id(path: Path, server_id: str):
    for s in load(path).get("servers", []):
        if s.get("id") == server_id:
            return s
    return None


def build_mcp_config(servers: list, key_resolver=None) -> dict:
    """Render the standard ``{"mcpServers": {name: cfg}}`` shape for enabled
    servers. ``key_resolver(ref)`` resolves ``secret:``/``env:`` references in
    env values and header values; values that aren't refs pass through."""
    def resolve(v):
        if isinstance(v, str) and key_resolver and (v.startswith("secret:") or v.startswith("env:")):
            return key_resolver(v) or ""
        return v

    out = {}
    for s in servers:
        if not s.get("enabled", True):
            continue
        name = s.get("name")
        if not name:
            continue
        if s.get("transport") == "stdio":
            cfg = {"command": s.get("command", ""), "args": s.get("args", [])}
            env = {k: resolve(v) for k, v in (s.get("env") or {}).items()}
            if env:
                cfg["env"] = env
        else:
            cfg = {"type": s.get("transport", "http"), "url": s.get("url", "")}
            headers = {k: resolve(v) for k, v in (s.get("headers") or {}).items()}
            if headers:
                cfg["headers"] = headers
        out[name] = cfg
    return {"mcpServers": out}


def upsert(path: Path, server: dict, overwrite: bool = False) -> str:
    """Insert or update a server by name. Returns 'imported' | 'refreshed' |
    'skipped'. Hand-made servers (source != the incoming source) are never
    clobbered unless ``overwrite``."""
    data = load(path)
    servers = data.setdefault("servers", [])
    for i, existing in enumerate(servers):
        if existing.get("name") == server.get("name"):
            if not overwrite and existing.get("source") != server.get("source"):
                return "skipped"
            server["id"] = existing.get("id", server.get("id"))
            servers[i] = server
            save(path, data)
            return "refreshed"
    servers.append(server)
    save(path, data)
    return "imported"


def _slug(name: str) -> str:
    base = "".join(c.lower() if c.isalnum() else "_" for c in str(name)).strip("_")
    return "_".join(filter(None, base.split("_"))) or "mcp"
