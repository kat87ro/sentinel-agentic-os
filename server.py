#!/usr/bin/env python3
"""
Sentinel Agentic OS — FastAPI Backend
Multi-agent orchestration server for opencode, Hermes, Gemini CLI
"""
import argparse
import contextvars
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import memory_vault
import providers
import secrets_store
import mcp_registry
import claude_sync
import budgets
import agent_tasks
import backup_engine
import jsonstore
import learning
import plugins
import proc_registry
import schedules
import auth

app = FastAPI(title="Sentinel Agentic OS", version="1.1.0")

# Load OpenRouter API key from Hermes .env
HERMES_ENV = Path.home() / ".hermes" / ".env"
if HERMES_ENV.exists():
    for line in HERMES_ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            if k == "OPENROUTER_API_KEY":
                os.environ[k] = v  # last value wins (matches shell sourcing)

# Host-header allow-list (defends against DNS-rebinding / Host-spoofing that
# could reach the open pre-setup window). Defaults to localhost only; an
# operator who deliberately binds a routable interface must declare the
# hostnames/IPs they'll serve via AGENTIC_OS_ALLOWED_HOSTS (comma-separated).
_allowed_hosts = [h.strip() for h in
                  os.environ.get("AGENTIC_OS_ALLOWED_HOSTS", "").split(",") if h.strip()]
if not _allowed_hosts:
    _allowed_hosts = ["localhost", "127.0.0.1", "::1", "testserver"]
app.add_middleware(TrustedHostMiddleware, allowed_hosts=_allowed_hosts)

# CORS for local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8080", "http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent.resolve()

# ─── Authentication + RBAC ────────────────────────────────────────
# Auth activates automatically once at least one user exists (bootstrap creates
# an admin on first startup). Until then the API is open (backward compatible /
# safe for a single-user localhost box during setup). When active, every /api/*
# request needs a valid session JWT (httpOnly cookie or Bearer header) and is
# authorized by the central RBAC policy in auth.authorize().
USERS_FILE = BASE_DIR / "data" / "users.json"
AUTH_COOKIE = "agentic_token"
AUTH_PUBLIC_PATHS = ("/api/auth/login", "/api/setup", "/api/health")
# Endpoints still usable while a forced password reset is pending.
MUST_CHANGE_ALLOWED = ("/api/auth/password", "/api/auth/me", "/api/auth/logout")


def secure_cookies(request: Request) -> bool:
    """Mark the session cookie Secure when served over HTTPS (or forced via
    AGENTIC_OS_SECURE_COOKIES=1 for TLS-terminating proxies)."""
    if os.environ.get("AGENTIC_OS_SECURE_COOKIES", "").strip() in ("1", "true", "yes"):
        return True
    return request.url.scheme == "https" or \
        request.headers.get("x-forwarded-proto", "").lower() == "https"


def current_request_token(request: Request):
    token = request.cookies.get(AUTH_COOKIE)
    if not token:
        authz = request.headers.get("authorization", "")
        if authz.lower().startswith("bearer "):
            token = authz[7:].strip()
    return token


@app.middleware("http")
async def require_auth(request: Request, call_next):
    path = request.url.path
    if not path.startswith("/api/") or path in AUTH_PUBLIC_PATHS:
        return await call_next(request)
    if not auth.has_users(USERS_FILE):
        return await call_next(request)  # open mode until the first user exists
    payload = auth.decode_token(get_jwt_secret(), current_request_token(request) or "")
    if not payload:
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    user = auth.find_user(USERS_FILE, payload.get("sub", ""))
    if not user or user.get("disabled"):
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    request.state.user = {"id": user["id"], "username": user["username"], "role": user.get("role", "viewer")}
    _audit_actor.set(user["username"])
    if user.get("must_change") and path not in MUST_CHANGE_ALLOWED:
        return JSONResponse({"detail": "password_change_required"}, status_code=403)
    if not auth.authorize(user.get("role", "viewer"), request.method, path):
        return JSONResponse({"detail": "Forbidden — insufficient role"}, status_code=403)
    return await call_next(request)

# ─── Models ───────────────────────────────────────────────────────

class BrainUpdate(BaseModel):
    content: str

class SkillCreate(BaseModel):
    name: str
    description: str = ""
    content: str = ""              # SKILL.md body; scaffolded if empty
    agent: str = "auto"            # primary agent assignment
    tags: list = []

class SkillRunRequest(BaseModel):
    input: Optional[str] = ""
    agent: Optional[str] = "auto"

class SettingsUpdate(BaseModel):
    settings: dict

class BackupRestoreRequest(BaseModel):
    file: str

class ChatRequest(BaseModel):
    agent: str
    message: str

class CustomAgentCreate(BaseModel):
    name: str
    provider: str
    model: str = ""
    system_prompt: str = ""
    skills: list = []
    mcp_servers: list = []
    budget_usd: float = 0          # 0 = unlimited
    budget_period: str = "day"     # hour | day | month
    heartbeat_seconds: int = 300   # wake interval to check the queue; 0 = manual-wake only

class CustomAgentUpdate(BaseModel):
    name: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    system_prompt: Optional[str] = None
    skills: Optional[list] = None
    mcp_servers: Optional[list] = None
    budget_usd: Optional[float] = None
    budget_period: Optional[str] = None
    heartbeat_seconds: Optional[int] = None

class HierarchyNode(BaseModel):
    agent_id: str
    reports_to: Optional[str] = None
    role: str = "Member"

class TeamCreate(BaseModel):
    name: str
    manager_id: str
    hierarchy: list = []

class TeamUpdate(BaseModel):
    name: Optional[str] = None
    manager_id: Optional[str] = None
    hierarchy: Optional[list] = None

class TaskDispatch(BaseModel):
    title: str = ""
    message: str
    agent_id: Optional[str] = None
    team_id: Optional[str] = None
    priority: str = "medium"

class ProviderConfigUpdate(BaseModel):
    mode: Optional[str] = None          # "cli" | "api"
    default_model: Optional[str] = None
    key_ref: Optional[str] = None       # "env:VAR" | "secret:name"
    label: Optional[str] = None         # custom providers only
    api_format: Optional[str] = None    # custom providers only: openai|anthropic|gemini
    base_url: Optional[str] = None      # custom providers only (openai format)
    cli_template: Optional[str] = None  # custom providers only (cli mode)
    key_optional: Optional[bool] = None # custom providers only
    timeout_seconds: Optional[int] = None  # custom providers: HTTP timeout (local models are slow)

class ProviderCreate(BaseModel):
    name: str                           # slug, e.g. "openrouter"
    label: str = ""
    mode: str = "api"                   # "api" (token) | "cli" (command template)
    api_format: str = "openai"          # openai | anthropic | gemini
    base_url: str = ""                  # for openai-compatible endpoints
    default_model: str = ""
    key_ref: str = ""                   # optional "env:VAR"; secrets via /secret
    cli_template: str = ""              # e.g. "ollama run {model} {prompt}"
    key_optional: bool = False          # local endpoints (Ollama) need no key
    timeout_seconds: int = 120          # HTTP timeout — raise for local CPU models

class ProviderSecretSet(BaseModel):
    value: str

class McpServerCreate(BaseModel):
    name: str
    transport: str = "stdio"
    command: str = ""
    args: list = []
    url: str = ""
    headers: dict = {}
    env: dict = {}
    enabled: bool = True
    scope: str = "user"

class McpServerUpdate(BaseModel):
    name: Optional[str] = None
    transport: Optional[str] = None
    command: Optional[str] = None
    args: Optional[list] = None
    url: Optional[str] = None
    headers: Optional[dict] = None
    env: Optional[dict] = None
    enabled: Optional[bool] = None
    scope: Optional[str] = None

class LoginRequest(BaseModel):
    username: str
    password: str

class PasswordChange(BaseModel):
    password: str

class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "viewer"

class UserUpdate(BaseModel):
    role: Optional[str] = None
    disabled: Optional[bool] = None
    password: Optional[str] = None

# ─── Helper Functions ─────────────────────────────────────────────

def safe_join(base: Path, *parts: str) -> Path:
    """Join untrusted path parts under `base` and guarantee the result stays
    inside `base`. Raises HTTPException(400) on any traversal attempt
    (``..``, absolute paths, symlink escapes)."""
    base_resolved = base.resolve()
    candidate = (base_resolved / Path(*parts)).resolve()
    if candidate != base_resolved and base_resolved not in candidate.parents:
        raise HTTPException(400, "Invalid path")
    return candidate

def read_file(path: Path):
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")

def write_file(path: Path, content: str):
    path.write_text(content, encoding="utf-8")
    return True

def list_dir(path: Path):
    if not path.exists():
        return []
    return sorted([p.name for p in path.iterdir() if not p.name.startswith(".")])

def get_timestamp():
    return datetime.now(timezone.utc).isoformat()

AUDIT_FILE = BASE_DIR / "audit" / "audit.log"

# Who is acting: set per-request by the auth middleware (contextvars propagate
# into FastAPI's sync-endpoint threadpool). Ticker/background threads never
# pass through the middleware and fall back to "system".
_audit_actor = contextvars.ContextVar("audit_actor", default=None)
# Request threads + the heartbeat thread both append; large entries can exceed
# PIPE_BUF where O_APPEND atomicity ends, so serialize JSONL writes.
_audit_lock = threading.Lock()


AUDIT_MAX_BYTES = 5 * 1024 * 1024     # rotate past ~5 MB (keeps one .1 backup)


def append_audit(entry: dict):
    audit_file = AUDIT_FILE
    audit_file.parent.mkdir(parents=True, exist_ok=True)
    entry["timestamp"] = get_timestamp()
    entry["id"] = str(uuid.uuid4())[:8]
    entry.setdefault("actor", _audit_actor.get() or "system")
    with _audit_lock:
        # size-based rotation: an unbounded append-only log eventually OOMs
        # get_audit (which reads the whole file) and bloats the repo.
        try:
            if audit_file.exists() and audit_file.stat().st_size >= AUDIT_MAX_BYTES:
                os.replace(audit_file, audit_file.with_suffix(".log.1"))
        except OSError:
            pass
        with open(audit_file, "a") as f:
            f.write(json.dumps(entry) + "\n")

# ─── Settings & Memory Vault location ─────────────────────────────────

SETTINGS_FILE = BASE_DIR / "data" / "settings.json"


def load_settings() -> dict:
    return jsonstore.read_json(SETTINGS_FILE, {})


def save_settings(data: dict):
    jsonstore.atomic_write_json(SETTINGS_FILE, data)


def mutate_settings(mutator):
    """Atomic read-modify-write of settings.json under its lock — the only safe
    way to change one key while the heartbeat thread (backup-schedule tick) or
    another request may be changing another. ``mutator(settings)`` edits the
    dict in place; the merged result is persisted atomically. Returns it."""
    with jsonstore.lock_for(SETTINGS_FILE):
        data = load_settings()
        mutator(data)
        save_settings(data)
        return data


def get_vault_dir() -> Path:
    """Resolve the memory vault directory. Configurable via
    ``settings.json -> memory.vault_path`` (relative paths are resolved under
    BASE_DIR); defaults to ``brain/``. The configured folder IS the source of
    truth — no mirroring — so an external Obsidian vault can be used directly."""
    vp = (load_settings().get("memory") or {}).get("vault_path")
    if vp:
        p = Path(vp).expanduser()
        if not p.is_absolute():
            p = BASE_DIR / p
        return p.resolve()
    return (BASE_DIR / "brain").resolve()


def journal_dir() -> Path:
    return get_vault_dir() / "journal"


def memory_inject_enabled() -> bool:
    """Whether vault context is injected into agent prompts (default on)."""
    val = (load_settings().get("memory") or {}).get("inject_context", True)
    return bool(val)

# ─── Provider config & secrets ────────────────────────────────────────

SECRETS_FILE = BASE_DIR / "data" / "secrets.json"
MASTER_KEY_FILE = BASE_DIR / "data" / ".master.key"


def get_master_key() -> str:
    """Master secret for encrypting the secret store. Prefers
    ``AGENTIC_OS_SECRET_KEY``; otherwise auto-generates a stable per-install key
    persisted (gitignored, 0600) so secrets survive restarts out of the box."""
    env_key = os.environ.get("AGENTIC_OS_SECRET_KEY", "").strip()
    if env_key:
        return env_key
    if MASTER_KEY_FILE.exists():
        return MASTER_KEY_FILE.read_text().strip()
    key = uuid.uuid4().hex + uuid.uuid4().hex
    MASTER_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    MASTER_KEY_FILE.write_text(key)
    try:
        MASTER_KEY_FILE.chmod(0o600)
    except OSError:
        pass
    return key


def get_jwt_secret() -> str:
    """JWT-signing secret — domain-separated from the Fernet master key so the
    same raw value is never used for two different crypto purposes (sign vs
    encrypt). Prefers an explicit ``AGENTIC_OS_JWT_SECRET`` for true independent
    rotation; otherwise derived deterministically from the master key so it is
    stable per-install without a second stored file."""
    env_key = os.environ.get("AGENTIC_OS_JWT_SECRET", "").strip()
    if env_key:
        return env_key
    return hashlib.sha256(b"agentic-os/jwt/v1:" + get_master_key().encode()).hexdigest()


def get_provider_config(name: str) -> dict:
    """Provider defaults merged with any settings.json overrides."""
    cfg = dict(providers.DEFAULT_PROVIDER_CONFIG.get(name, {"mode": "cli", "default_model": "", "key_ref": ""}))
    override = (load_settings().get("providers") or {}).get(name) or {}
    for k, v in override.items():
        if v is not None:
            cfg[k] = v
    return cfg


def custom_provider_records() -> dict:
    """User-defined providers stored in settings.json -> providers (custom: true).
    Built-ins live in providers.DEFAULT_PROVIDER_CONFIG; customs are data-only —
    adding one is a settings write, never a code change."""
    return {n: c for n, c in (load_settings().get("providers") or {}).items()
            if isinstance(c, dict) and c.get("custom")}


def all_provider_names() -> list:
    return list(ALLOWED_PROVIDERS) + [n for n in custom_provider_records()
                                      if n not in ALLOWED_PROVIDERS]


def provider_enabled(name: str) -> bool:
    return bool(get_provider_config(name).get("enabled", True))


def enabled_provider_names() -> list:
    """Active providers only — deactivated engines disappear from status,
    health, and the online counters until re-enabled."""
    return [n for n in all_provider_names() if provider_enabled(n)]


def set_provider_config(name: str, patch: dict):
    def _apply(settings):
        provs = settings.get("providers") or {}
        cur = provs.get(name) or {}
        cur.update({k: v for k, v in patch.items() if v is not None})
        provs[name] = cur
        settings["providers"] = provs
    mutate_settings(_apply)


def resolve_provider_key(cfg: dict):
    """Resolve an API key from a key_ref: ``env:VAR`` or ``secret:name``."""
    ref = (cfg.get("key_ref") or "").strip()
    if ref.startswith("env:"):
        return os.environ.get(ref[4:], "").strip() or None
    if ref.startswith("secret:"):
        return secrets_store.get_secret(SECRETS_FILE, get_master_key(), ref[7:])
    return None


def resolve_secret_ref(ref: str):
    """Resolve a single secret/env reference for MCP env/header values."""
    if not isinstance(ref, str):
        return ref
    if ref.startswith("env:"):
        return os.environ.get(ref[4:], "")
    if ref.startswith("secret:"):
        return secrets_store.get_secret(SECRETS_FILE, get_master_key(), ref[7:]) or ""
    return ref

# ─── MCP server registry ──────────────────────────────────────────

MCP_SERVERS_FILE = BASE_DIR / "data" / "mcp_servers.json"


def build_mcp_config_file(agent: dict):
    """Write a temp ``--mcp-config`` JSON for the MCP servers attached to this
    agent profile. Returns (path, allowed_tools) where allowed_tools is the list
    of ``mcp__<name>`` prefixes to pre-approve (headless ``claude -p`` denies MCP
    tools unless explicitly allowed). Returns (None, []) when none attached.
    Caller deletes the temp file."""
    ids = (agent or {}).get("mcp_servers") or []
    if not ids:
        return None, []
    all_servers = mcp_registry.load(MCP_SERVERS_FILE).get("servers", [])
    chosen = [s for s in all_servers if s.get("id") in ids and s.get("enabled", True)]
    if not chosen:
        return None, []
    config = mcp_registry.build_mcp_config(chosen, key_resolver=resolve_secret_ref)
    allowed = [f"mcp__{s.get('name')}" for s in chosen if s.get("name")]
    import tempfile
    fd, path = tempfile.mkstemp(prefix="agentic_mcp_", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(config, f)
    return path, allowed

# ─── Agent Registry & Teams (dynamic, state-driven) ──────────────────
# An "agent profile" is a configurable record (provider + model + persona +
# skills) decoupled from the provider executor that actually runs it.

ALLOWED_PROVIDERS = providers.ALLOWED_PROVIDERS
DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6"
DEFAULT_CODEX_MODEL = providers.DEFAULT_PROVIDER_CONFIG["codex"]["default_model"]

AGENTS_REGISTRY_FILE = BASE_DIR / "data" / "agents_registry.json"
AGENT_USAGE_FILE = BASE_DIR / "data" / "agent_usage.json"
AGENT_TASKS_FILE = BASE_DIR / "data" / "agent_tasks.json"
SCHEDULES_FILE = BASE_DIR / "data" / "schedules.json"
INBOX_FILE = BASE_DIR / "data" / "inbox.json"
PROJECTS_FILE = BASE_DIR / "data" / "projects.json"
PROJECT_CHATS_DIR = BASE_DIR / "data" / "project_chats"
TEAMS_FILE = BASE_DIR / "data" / "teams.json"

# Default profiles seeded once so the existing 3-agent UI (chat, health,
# router) keeps working and the new Agents page is populated out of the box.
DEFAULT_AGENTS = [
    {"id": "opencode_default", "name": "OpenCode Core", "provider": "opencode",
     "model": "", "system_prompt": "Code generation, DevOps, and file operations.",
     "skills": ["code", "devops"]},
    {"id": "hermes_default", "name": "Hermes Agent", "provider": "hermes",
     "model": "", "system_prompt": "Persistent memory, scheduling, and messaging.",
     "skills": ["memory", "schedule"]},
    {"id": "gemini_default", "name": "Gemini CLI Core", "provider": "gemini",
     "model": "gemini-2.5-flash", "system_prompt": "Default research and analysis persona.",
     "skills": ["research", "analysis"]},
    {"id": "claude_default", "name": "Claude Core", "provider": "claude",
     "model": DEFAULT_CLAUDE_MODEL, "system_prompt": "General-purpose reasoning and engineering persona.",
     "skills": ["reasoning", "code"]},
    {"id": "codex_default", "name": "Codex Core", "provider": "codex",
     "model": DEFAULT_CODEX_MODEL, "system_prompt": "OpenAI coding and execution persona (Codex CLI / Chat Completions).",
     "skills": ["code", "review"]},
]


def load_agents_registry() -> dict:
    # .bak fallback: a torn registry must never silently halt the heartbeat
    # (the ticker reads this first thing every 15s).
    return jsonstore.read_json(AGENTS_REGISTRY_FILE, {"agents": []})


def save_agents_registry(data: dict):
    jsonstore.atomic_write_json(AGENTS_REGISTRY_FILE, data)


def load_teams() -> dict:
    return jsonstore.read_json(TEAMS_FILE, {"teams": []})


def save_teams(data: dict):
    jsonstore.atomic_write_json(TEAMS_FILE, data)


def get_agent_by_id(agent_id: str):
    for a in load_agents_registry().get("agents", []):
        if a.get("id") == agent_id:
            return a
    return None


def get_team_by_id(team_id: str):
    for t in load_teams().get("teams", []):
        if t.get("id") == team_id:
            return t
    return None


def default_agent_for_provider(provider: str):
    """Resolve the provider's default profile (used by the legacy /api/chat)."""
    for a in load_agents_registry().get("agents", []):
        if a.get("provider") == provider:
            return a
    return {"provider": provider, "model": "", "system_prompt": "", "skills": []}


def slugify_id(name: str) -> str:
    base = "".join(c.lower() if c.isalnum() else "_" for c in name).strip("_")
    base = "_".join(filter(None, base.split("_"))) or "agent"
    return f"{base}_{str(uuid.uuid4())[:6]}"


def seed_default_agents():
    """Ensure every default profile exists (non-destructive upsert by id).
    First run writes all of them; later runs only add defaults introduced by
    upgrades (e.g. codex_default) — user-edited profiles are never touched."""
    now = get_timestamp()
    reg = load_agents_registry()
    existing_ids = {a.get("id") for a in reg.get("agents", [])}
    missing = [a for a in DEFAULT_AGENTS if a["id"] not in existing_ids]
    if not missing and AGENTS_REGISTRY_FILE.exists():
        return
    reg.setdefault("agents", []).extend({**a, "created": now, "updated": now} for a in missing)
    save_agents_registry(reg)


seed_default_agents()

# ─── Agent Discovery (instant filesystem checks) ────────────────────

def claude_cli_authed() -> bool:
    """The `claude` CLI is usable when logged in with a subscription
    (`claude login` → oauthAccount in ~/.claude.json / ~/.claude/.credentials.json)
    or when an ANTHROPIC_API_KEY is exported. Filesystem-only check (no subprocess)."""
    if os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return True
    if (Path.home() / ".claude" / ".credentials.json").exists():
        return True
    cfg = Path.home() / ".claude.json"
    try:
        return cfg.exists() and "oauthAccount" in cfg.read_text()
    except OSError:
        return False


def check_agent(name: str) -> dict:
    """Instant filesystem-based check. No subprocess needed."""
    try:
        if not provider_enabled(name):
            return {"name": name, "status": "disabled"}
        if name not in ALLOWED_PROVIDERS and name in custom_provider_records():
            cfg = get_provider_config(name)
            if cfg.get("mode") == "cli":
                import shlex
                try:
                    head = (shlex.split(cfg.get("cli_template", "")) or [""])[0]
                except ValueError:
                    head = ""
                status = "online" if head and shutil.which(head) else "offline"
            else:
                ok = resolve_provider_key(cfg) or cfg.get("key_optional")
                status = "online" if ok else "warning"
            return {"name": name, "status": status}
        if name == "opencode":
            exists = shutil.which("opencode") is not None
            status = "online" if exists else "offline"
        elif name == "hermes":
            exists = shutil.which("hermes") is not None
            status = "online" if exists else "offline"
        elif name == "gemini":
            # Gemini has valid OAuth tokens logged in
            oauth = Path.home() / ".gemini" / "oauth_creds.json"
            exists = shutil.which("gemini") is not None
            logged_in = oauth.exists() and "ya29" in oauth.read_text()
            status = "online" if exists and logged_in else "offline" if not exists else "warning"
        elif name == "claude":
            # Claude CLI present + authenticated (subscription login or API key),
            # mirroring the gemini OAuth check.
            exists = shutil.which("claude") is not None
            status = "online" if exists and claude_cli_authed() else "warning" if exists else "offline"
        elif name == "codex":
            # Codex CLI present + authenticated (ChatGPT login or OPENAI_API_KEY)
            exists = shutil.which("codex") is not None
            has_auth = (Path.home() / ".codex" / "auth.json").exists() or \
                bool(os.environ.get("OPENAI_API_KEY", "").strip())
            status = "online" if exists and has_auth else "warning" if exists else "offline"
        else:
            status = "offline"
    except Exception:
        status = "offline"
    return {"name": name, "status": status}

# ─── Routes: Status ───────────────────────────────────────────────

@app.get("/api/status")
def get_status():
    agents = [check_agent(a) for a in enabled_provider_names()]
    skills = list_dir(BASE_DIR / "skills")
    return {
        "status": "healthy",
        "agents": agents,
        "skills_count": len(skills),
        "uptime": time.time(),
    }

# ─── Routes: Brain ────────────────────────────────────────────────

@app.get("/api/brain")
def list_brain():
    vault = get_vault_dir()
    files = list_dir(vault)
    brain_data = {}
    for f in files:
        path = vault / f
        if path.is_file():
            brain_data[f] = read_file(path)
    return brain_data

@app.get("/api/brain/{file_name}")
def get_brain_file(file_name: str):
    path = safe_join(get_vault_dir(), file_name)
    if not path.exists() or path.is_dir():
        raise HTTPException(404, "File not found")
    return {"name": file_name, "content": read_file(path)}

@app.put("/api/brain/{file_name}")
def update_brain_file(file_name: str, data: BrainUpdate):
    path = safe_join(get_vault_dir(), file_name)
    write_file(path, data.content)
    append_audit({"action": "brain_update", "file": file_name})
    return {"status": "ok", "file": file_name}

@app.get("/api/memory/overview")
def memory_overview():
    """The real shape of memory: global vault notes, per-project vaults,
    per-agent learnings, journal — exactly what execution can inject."""
    vault = get_vault_dir()
    global_files = sorted(f.name for f in vault.glob("*.md"))
    projects_reg = {p.get("slug"): p for p in load_projects().get("projects", [])}
    proj_out = []
    projects_dir = vault / "projects"
    if projects_dir.exists():
        for d in sorted(projects_dir.iterdir()):
            if d.is_dir():
                proj_out.append({
                    "slug": d.name,
                    "name": projects_reg.get(d.name, {}).get("name", d.name),
                    "linked": d.name in projects_reg,
                    "files": sorted(f.name for f in d.glob("*.md")),
                })
    agents_out = []
    for a in load_agents_registry().get("agents", []):
        text = learning.read_all(learning.learnings_path(vault, a["id"]))
        agents_out.append({
            "id": a["id"], "name": a.get("name", a["id"]),
            "lesson_count": sum(1 for l in text.splitlines() if l.startswith("- ")),
        })
    journal_dir = vault / "journal"
    journal = sorted((f.stem for f in journal_dir.glob("*.md")), reverse=True) \
        if journal_dir.exists() else []
    return {"vault_path": str(vault), "global_files": global_files,
            "projects": proj_out, "agents": agents_out, "journal": journal,
            "inject_enabled": memory_inject_enabled()}


@app.get("/api/memory/file")
def memory_file(path: str = Query(...)):
    """Read any vault note by relative path (projects/<slug>/memory.md,
    journal/<date>.md, agents/<id>/learnings.md) — stems collide across
    project vaults, so the by-name note endpoint is not enough."""
    p = safe_join(get_vault_dir(), path)
    if not p.exists() or p.is_dir() or p.suffix != ".md":
        raise HTTPException(404, "Note not found")
    return {"path": path, "content": read_file(p)}


@app.put("/api/memory/file")
def memory_file_update(data: BrainUpdate, path: str = Query(...)):
    p = safe_join(get_vault_dir(), path)
    if p.suffix != ".md":
        raise HTTPException(400, "only .md notes can be edited")
    write_file(p, data.content)
    append_audit({"action": "brain_update", "file": path})
    return {"status": "ok", "path": path}


@app.get("/api/memory/preview")
def memory_preview(agent_id: str = Query(...), task: str = Query(""),
                   project_id: str = Query(None)):
    """Exactly what execute_profile would inject for this agent + task:
    vault context (global or project-scoped) and the agent's lessons."""
    agent = get_agent_by_id(agent_id)
    if not agent:
        raise HTTPException(404, f"agent '{agent_id}' not found")
    memory_dir = None
    if project_id:
        proj = get_project_by_id(project_id)
        if not proj:
            raise HTTPException(404, f"project '{project_id}' not found")
        memory_dir = project_memory_dir(proj)
    context = build_memory_context(agent, task, memory_dir=memory_dir)
    lessons = learning.read_for_injection(learning.learnings_path(get_vault_dir(), agent_id))
    return {"agent_id": agent_id, "task": task,
            "scope": "project" if memory_dir else "global",
            "inject_enabled": memory_inject_enabled(),
            "memory_context": context, "lessons": lessons}


# ─── Routes: Memory Vault (Obsidian-compatible) ───────────────────

class MemoryConfigUpdate(BaseModel):
    vault_path: Optional[str] = None
    inject_context: Optional[bool] = None


@app.get("/api/memory/graph")
def memory_graph():
    return memory_vault.build_link_graph(get_vault_dir())


@app.get("/api/memory/search")
def memory_search(q: str = Query("")):
    return {"query": q, "results": memory_vault.search_vault(get_vault_dir(), q)}


@app.get("/api/memory/note/{name}")
def memory_note(name: str):
    # Guard the resolved path even though we look up by stem.
    safe_join(get_vault_dir(), f"{name}.md")
    note = memory_vault.read_note(get_vault_dir(), name)
    if not note:
        raise HTTPException(404, "Note not found")
    graph = memory_vault.build_link_graph(get_vault_dir())
    note["backlinks"] = graph["backlinks"].get(name, [])
    return note


@app.get("/api/memory/config")
def memory_get_config():
    mem = load_settings().get("memory") or {}
    return {
        "vault_path": mem.get("vault_path", ""),
        "resolved": str(get_vault_dir()),
        "inject_context": memory_inject_enabled(),
        "is_default": not bool(mem.get("vault_path")),
    }


@app.put("/api/memory/config")
def memory_set_config(data: MemoryConfigUpdate):
    # validate before taking the lock
    if data.vault_path is not None and data.vault_path.strip():
        p = Path(data.vault_path.strip()).expanduser()
        if not p.is_absolute():
            p = BASE_DIR / p
        if not p.resolve().is_dir():
            raise HTTPException(400, "vault_path must be an existing directory")
    def _apply(settings):
        mem = settings.get("memory") or {}
        if data.vault_path is not None:
            vp = data.vault_path.strip()
            if vp:
                mem["vault_path"] = vp
            else:
                mem.pop("vault_path", None)  # revert to default brain/
        if data.inject_context is not None:
            mem["inject_context"] = bool(data.inject_context)
        settings["memory"] = mem
    mutate_settings(_apply)
    append_audit({"action": "memory_config_updated"})
    return memory_get_config()

# ─── Routes: Skills ───────────────────────────────────────────────

@app.get("/api/skills")
def list_skills():
    skills = []
    for d in sorted((BASE_DIR / "skills").iterdir()):
        if d.is_dir() and not d.name.startswith("_"):
            skill_md = read_file(d / "SKILL.md")
            learnings = read_file(d / "learnings.md")
            eval_data = {}
            eval_path = d / "eval.json"
            if eval_path.exists():
                eval_data = json.loads(eval_path.read_text())
            score_history = []
            score_path = d / "score-history.json"
            if score_path.exists():
                score_history = json.loads(score_path.read_text())
            skills.append({
                "name": d.name,
                "description": skill_md[:200] if skill_md else "",
                "has_learnings": bool(learnings),
                "eval_criteria": eval_data.get("criteria", []),
                "scores": score_history,
                "enabled": not (d / ".disabled").exists(),
            })
    return skills

SKILL_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,40}$")


@app.post("/api/skills")
def create_skill(data: SkillCreate):
    """Manually add a skill — scaffolds skills/<slug>/SKILL.md in the standard
    format so it appears in the Skills Hub and is runnable immediately."""
    slug = data.name.strip().lower().replace(" ", "-")
    if not SKILL_SLUG_RE.match(slug):
        raise HTTPException(400, "name must be a slug: lowercase letters/digits/_/-, 2-41 chars")
    skill_dir = safe_join(BASE_DIR / "skills", slug)
    if skill_dir.exists():
        raise HTTPException(400, f"skill '{slug}' already exists")
    title = data.name.strip().replace("-", " ").replace("_", " ").title()
    tags = [t.strip() for t in (data.tags or []) if str(t).strip()]
    body = (data.content or "").strip() or f"""## Description
{data.description.strip() or title}

## When to Use
- Describe the trigger conditions here

## Process
1. Describe the steps here

## Output
Describe the expected output here"""
    md = f"""---
name: {slug}
description: {data.description.strip() or title}
version: 1.0.0
author: manual
tags: [{', '.join(tags)}]
---

# {title}

{body}

## Agent Assignment
- Primary: {data.agent if data.agent in ALLOWED_PROVIDERS else 'auto'}
"""
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(md)
    append_audit({"action": "skill_created", "skill": slug})
    return {"status": "ok", "name": slug}


@app.get("/api/skills/{name}")
def get_skill(name: str):
    path = safe_join(BASE_DIR / "skills", name)
    if not path.exists():
        raise HTTPException(404, "Skill not found")
    return {
        "name": name,
        "skill": read_file(path / "SKILL.md"),
        "learnings": read_file(path / "learnings.md"),
        "eval": json.loads((path / "eval.json").read_text()) if (path / "eval.json").exists() else {},
        "score_history": json.loads((path / "score-history.json").read_text()) if (path / "score-history.json").exists() else [],
        "context": [f.name for f in (path / "context").iterdir()] if (path / "context").exists() else [],
        "enabled": not (path / ".disabled").exists(),
    }


class SkillUpdate(BaseModel):
    content: str


@app.put("/api/skills/{name}")
def update_skill(name: str, data: SkillUpdate):
    """Edit the SKILL.md source directly — the skill IS its markdown."""
    path = safe_join(BASE_DIR / "skills", name)
    if not path.exists():
        raise HTTPException(404, "Skill not found")
    if not data.content.strip():
        raise HTTPException(400, "content cannot be empty")
    (path / "SKILL.md").write_text(data.content)
    append_audit({"action": "skill_updated", "skill": name})
    return {"status": "ok", "name": name}


@app.post("/api/skills/{name}/toggle")
def toggle_skill(name: str):
    """Deactivate/reactivate. A disabled skill stays listed but refuses to run."""
    path = safe_join(BASE_DIR / "skills", name)
    if not path.exists():
        raise HTTPException(404, "Skill not found")
    marker = path / ".disabled"
    if marker.exists():
        marker.unlink()
        enabled = True
    else:
        marker.write_text("disabled via dashboard\n")
        enabled = False
    append_audit({"action": "skill_toggled", "skill": name, "enabled": enabled})
    return {"status": "ok", "name": name, "enabled": enabled}


@app.delete("/api/skills/{name}")
def delete_skill(name: str):
    """Remove the skill folder (SKILL.md, learnings, eval history). Skills
    mirrored from ~/.claude/skills reappear on the next Claude sync — use
    deactivate for those."""
    path = safe_join(BASE_DIR / "skills", name)
    if not path.exists():
        raise HTTPException(404, "Skill not found")
    shutil.rmtree(path)
    append_audit({"action": "skill_deleted", "skill": name})
    return {"status": "deleted", "name": name}


@app.post("/api/skills/{name}/run")
def run_skill(name: str, req: Optional[SkillRunRequest] = None):
    path = safe_join(BASE_DIR / "skills", name)
    if not path.exists():
        raise HTTPException(404, "Skill not found")
    if (path / ".disabled").exists():
        raise HTTPException(400, f"skill '{name}' is deactivated — reactivate it to run")

    agent_choice = req.agent if req else "auto"
    skill_input = req.input if req else ""

    # Read skill files
    skill_md = read_file(path / "SKILL.md")
    learnings = read_file(path / "learnings.md")

    # Determine which agent based on skill type
    if agent_choice == "auto":
        devops_keywords = ["devops", "audit", "deploy", "k8s", "gcp", "infra", "terraform"]
        research_keywords = ["research", "synthesis", "analyze", "search", "compare"]
        if any(k in name for k in devops_keywords):
            agent_choice = "opencode"
        elif any(k in name for k in research_keywords):
            agent_choice = "gemini"
        else:
            # Check SKILL.md for explicit agent assignment
            for line in skill_md.split('\n'):
                line = line.strip()
                if "Primary:" in line:
                    candidate = line.split(":")[-1].strip().lower()
                    if candidate in ALLOWED_PROVIDERS:
                        agent_choice = candidate
                        break
            if agent_choice == "auto":
                agent_choice = "opencode"

    # Build prompt from skill instructions + learnings + user input
    prompt = f"Execute the '{name}' skill.\n\n"
    if skill_md:
        prompt += f"## Skill Instructions\n{skill_md}\n\n"
    if learnings and learnings.strip():
        prompt += f"## Past Learnings\n{learnings}\n\n"
    if skill_input:
        prompt += f"## User Input\n{skill_input}"

    run_id = str(uuid.uuid4())[:8]

    # Execute via agent
    try:
        _exec_ctx.set({"kind": "skill", "agent_id": agent_choice, "label": f"skill: {name}"})
        response_text = execute_agent(agent_choice, prompt)
    except subprocess.TimeoutExpired:
        response_text = f"⏱ Skill '{name}' timed out on agent '{agent_choice}'."
    except FileNotFoundError:
        response_text = f"⚠ Agent '{agent_choice}' CLI not installed. Install it and try again."
    except Exception as e:
        response_text = f"⚠ Error executing skill: {str(e)}"

    # Save output to learnings.md
    timestamp = get_timestamp()[:10]
    existing = read_file(path / "learnings.md")
    new_entry = (
        f"\n## {timestamp} (Run {run_id})\n"
        f"- Agent: {agent_choice}\n"
        f"- Input: {skill_input or '(none)'}\n"
        f"- Output: {response_text[:500]}\n"
    )
    write_file(path / "learnings.md", existing + new_entry)

    # Log execution
    append_audit({
        "action": "skill_run",
        "skill": name,
        "agent": agent_choice,
        "run_id": run_id,
        "output_preview": response_text[:100],
    })

    return {
        "status": "completed",
        "run_id": run_id,
        "skill": name,
        "agent": agent_choice,
        "output": response_text,
        "message": f"Skill '{name}' completed via {agent_choice}",
    }

@app.get("/api/skills/{name}/eval")
def get_skill_eval(name: str):
    path = safe_join(BASE_DIR / "skills", name, "score-history.json")
    if not path.exists():
        return {"scores": []}
    return {"scores": json.loads(path.read_text())}

# ─── Routes: Scheduler ────────────────────────────────────────────

class ScheduleCreate(BaseModel):
    name: str
    agent_id: str
    message: str
    cron: str = ""                       # 5-field cron, OR…
    interval_minutes: Optional[int] = None   # …a plain interval (exclusive)
    project_id: Optional[str] = None
    wake: bool = True                    # wake the agent at fire time vs wait for its heartbeat
    enabled: bool = True


class ScheduleUpdate(BaseModel):
    name: Optional[str] = None
    agent_id: Optional[str] = None
    message: Optional[str] = None
    cron: Optional[str] = None
    interval_minutes: Optional[int] = None
    project_id: Optional[str] = None
    wake: Optional[bool] = None
    enabled: Optional[bool] = None


def _validate_schedule_refs(agent_id: str = None, project_id: str = None):
    if agent_id and not get_agent_by_id(agent_id):
        raise HTTPException(404, f"agent '{agent_id}' not found")
    if project_id and not get_project_by_id(project_id):
        raise HTTPException(404, f"project '{project_id}' not found")


@app.get("/api/scheduler/jobs")
def list_jobs():
    return {"schedules": schedules.list_schedules(SCHEDULES_FILE)}


@app.post("/api/scheduler/jobs")
def create_job(data: ScheduleCreate):
    err = schedules.validate(data.name, data.agent_id, data.message,
                             data.cron, data.interval_minutes)
    if err:
        raise HTTPException(400, err)
    _validate_schedule_refs(data.agent_id, data.project_id)
    sched = schedules.create(SCHEDULES_FILE, name=data.name, agent_id=data.agent_id,
                             message=data.message, cron=data.cron,
                             interval_minutes=data.interval_minutes,
                             project_id=data.project_id, wake=data.wake,
                             enabled=data.enabled)
    append_audit({"action": "schedule_created", "schedule_id": sched["id"],
                  "name": sched["name"], "agent_id": sched["agent_id"],
                  "cron": sched["cron"], "interval_minutes": sched["interval_minutes"]})
    return sched


@app.put("/api/scheduler/jobs/{job_id}")
def update_job(job_id: str, data: ScheduleUpdate):
    cur = schedules.get_schedule(SCHEDULES_FILE, job_id)
    if not cur:
        raise HTTPException(404, "Schedule not found")
    merged = {**cur, **{k: v for k, v in data.model_dump().items() if v is not None}}
    # recurrence after the update, mirroring schedules.update's exclusivity rule
    if data.cron:
        eff_cron, eff_interval = data.cron, None
    elif data.interval_minutes:
        eff_cron, eff_interval = "", data.interval_minutes
    else:
        eff_cron, eff_interval = cur.get("cron"), cur.get("interval_minutes")
    err = schedules.validate(merged["name"], merged["agent_id"], merged["message"],
                             eff_cron, eff_interval)
    if err:
        raise HTTPException(400, err)
    _validate_schedule_refs(data.agent_id, data.project_id)
    sched = schedules.update(SCHEDULES_FILE, job_id, data.model_dump())
    append_audit({"action": "schedule_updated", "schedule_id": job_id})
    return sched


@app.post("/api/scheduler/jobs/{job_id}/toggle")
def toggle_job(job_id: str):
    cur = schedules.get_schedule(SCHEDULES_FILE, job_id)
    if not cur:
        raise HTTPException(404, "Schedule not found")
    sched = schedules.update(SCHEDULES_FILE, job_id, {"enabled": not cur.get("enabled")})
    append_audit({"action": "schedule_toggled", "schedule_id": job_id,
                  "enabled": sched["enabled"]})
    return sched


@app.post("/api/scheduler/jobs/{job_id}/run")
def run_job_now(job_id: str):
    """Fire once immediately (does not consume or shift the recurrence)."""
    sched = schedules.get_schedule(SCHEDULES_FILE, job_id)
    if not sched:
        raise HTTPException(404, "Schedule not found")
    task = _fire_schedule(sched, manual=True)
    if not task:
        raise HTTPException(400, "schedule could not fire — its agent no longer exists")
    return {"status": "fired", "task": task}


@app.delete("/api/scheduler/jobs/{job_id}")
def delete_job(job_id: str):
    if not schedules.delete(SCHEDULES_FILE, job_id):
        raise HTTPException(404, "Schedule not found")
    append_audit({"action": "schedule_deleted", "schedule_id": job_id})
    return {"status": "deleted"}

# ─── Routes: Audit ────────────────────────────────────────────────

@app.get("/api/audit")
def get_audit(limit: int = Query(100, le=500)):
    audit_file = AUDIT_FILE
    if not audit_file.exists():
        return {"entries": []}
    lines = audit_file.read_text().strip().split("\n")
    entries = []
    for l in lines:
        if not l.strip():
            continue
        try:
            entries.append(json.loads(l))
        except json.JSONDecodeError:
            continue   # one corrupt line must not take down the whole trail
    return {"entries": entries[-limit:]}

# ─── Routes: Cost Analytics ───────────────────────────────────────

@app.get("/api/cost")
def get_cost():
    """Real spend, derived from the budget usage ledger (the SAME events that
    gate per-agent budgets). Previously read a separate cost-history.json that
    nothing in production wrote, so the page was always empty."""
    events = budgets.load_ledger(AGENT_USAGE_FILE)
    names = {a["id"]: a.get("name", a["id"])
             for a in load_agents_registry().get("agents", [])}
    names["__chat__"] = "AI Chat"     # synthetic id for the legacy chat path
    entries, daily = [], {}
    for e in events:
        ts = e.get("ts", 0)
        iso = datetime.fromtimestamp(ts).isoformat() if ts else ""
        aid = e.get("agent_id", "")
        cost = float(e.get("cost", 0) or 0)
        entries.append({
            "timestamp": iso,
            "agent": names.get(aid) or (aid if aid.startswith("chat:") else aid) or "—",
            "model": e.get("model", ""),
            "tokens": int(e.get("tokens_in", 0) or 0) + int(e.get("tokens_out", 0) or 0),
            "cost": cost,
        })
        day = iso[:10]
        if day:
            daily[day] = round(daily.get(day, 0) + cost, 6)
    # crude monthly projection: avg daily spend × 30
    proj = round((sum(daily.values()) / len(daily)) * 30, 2) if daily else 0
    return {"entries": entries, "daily_totals": daily,
            "monthly_projection": proj, "free_tier_alerts": []}

# ─── Routes: Plugins (capability packs) ───────────────────────────
# A plugin bundles real components — an MCP server, skill(s), prompt(s) — and
# wiring them in means registering them in the systems agents already use.
# Config-before-enable: required config must be filled before a plugin enables.

PLUGINS_FILE = BASE_DIR / "data" / "plugins.json"
# Where plugin components land (also where the app reads skills/prompts from);
# module globals so tests can isolate them from the shipped dirs.
SKILLS_DIR = BASE_DIR / "skills"
PROMPTS_DIR = BASE_DIR / "prompts"


def _plugin_wire(manifest: dict, config: dict) -> dict:
    """Wire a plugin's components into the live systems. Returns the ids of
    everything created (for clean uninstall). Idempotent per component name.
    Collisions are checked BEFORE any write so a refusal leaves nothing
    half-wired (no orphaned MCP server)."""
    comps = manifest.get("components") or {}
    for skill in comps.get("skills") or []:
        sdir = safe_join(SKILLS_DIR, skill["slug"])
        if sdir.exists() and not (sdir / ".plugin").exists():
            raise HTTPException(409, f"a hand-made skill '{skill['slug']}' already exists — "
                                     f"rename it or the plugin's skill before installing")
    for prompt in comps.get("prompts") or []:
        if safe_join(PROMPTS_DIR, f"{prompt['slug']}.md").exists():
            raise HTTPException(409, f"a prompt '{prompt['slug']}' already exists — "
                                     f"rename it before installing this plugin")
    wired = {"skills": [], "prompts": []}
    server = plugins.rendered_mcp(manifest, config)
    if server:
        normalized = mcp_registry.normalize_server(server)
        reg = mcp_registry.load(MCP_SERVERS_FILE)
        # replace any prior server this same plugin wired (by source tag)
        src = server["source"]
        reg["servers"] = [s for s in reg.get("servers", []) if s.get("source") != src]
        reg["servers"].append(normalized)
        mcp_registry.save(MCP_SERVERS_FILE, reg)
        wired["mcp_server_id"] = normalized["id"]
    for skill in comps.get("skills") or []:
        slug = skill["slug"]
        sdir = safe_join(SKILLS_DIR, slug)
        bundle_dir = skill.get("_bundle_skill_dir")
        if bundle_dir and Path(bundle_dir).is_dir():
            # copy the bundled skill folder verbatim (keeps context files)
            if sdir.exists():
                shutil.rmtree(sdir, ignore_errors=True)
            shutil.copytree(bundle_dir, sdir)
        else:
            sdir.mkdir(parents=True, exist_ok=True)
            (sdir / "SKILL.md").write_text(plugins.substitute(skill.get("skill_md", f"# {slug}\n"), config))
        (sdir / ".plugin").write_text(manifest["id"])   # provenance for clean uninstall
        wired["skills"].append(slug)
    for prompt in comps.get("prompts") or []:
        slug = prompt["slug"]
        pf = safe_join(PROMPTS_DIR, f"{slug}.md")
        pf.parent.mkdir(parents=True, exist_ok=True)
        pf.write_text(plugins.substitute(prompt.get("body", ""), config))
        wired["prompts"].append(slug)
    return wired


def _plugin_unwire(entry: dict):
    """Remove exactly what a plugin wired — never a hand-made server/skill."""
    wired = entry.get("wired") or {}
    sid = wired.get("mcp_server_id")
    if sid:
        reg = mcp_registry.load(MCP_SERVERS_FILE)
        before = len(reg.get("servers", []))
        reg["servers"] = [s for s in reg.get("servers", []) if s.get("id") != sid]
        if len(reg["servers"]) != before:
            mcp_registry.save(MCP_SERVERS_FILE, reg)
        # detach from any agent profiles that referenced it
        agents = load_agents_registry()
        changed = False
        for a in agents.get("agents", []):
            if sid in (a.get("mcp_servers") or []):
                a["mcp_servers"] = [x for x in a["mcp_servers"] if x != sid]
                changed = True
        if changed:
            save_agents_registry(agents)
    for slug in wired.get("skills") or []:
        sdir = SKILLS_DIR / slug
        # only delete if WE planted it (provenance marker matches)
        if (sdir / ".plugin").exists() and (sdir / ".plugin").read_text().strip() == entry["id"]:
            shutil.rmtree(sdir, ignore_errors=True)
    for slug in wired.get("prompts") or []:
        pf = PROMPTS_DIR / f"{slug}.md"
        pf.unlink(missing_ok=True)


@app.get("/api/plugins/catalog")
def plugins_catalog():
    """Marketplace minus already-installed ids."""
    taken = {p["id"] for p in plugins.load(PLUGINS_FILE)["plugins"]}
    return {"catalog": [m for m in plugins.MARKETPLACE if m["id"] not in taken]}


@app.get("/api/plugins")
def list_plugins():
    return plugins.load(PLUGINS_FILE)


class PluginInstall(BaseModel):
    id: str = ""                    # marketplace id …
    manifest: Optional[dict] = None # … or a full custom manifest
    config: dict = {}


@app.post("/api/plugins/install")
def install_plugin(data: PluginInstall):
    manifest = data.manifest or next((m for m in plugins.MARKETPLACE if m["id"] == data.id), None)
    if not manifest:
        raise HTTPException(404, f"no marketplace plugin '{data.id}' and no manifest provided")
    return _install_manifest(manifest, data.config, source_label="manifest")


def _install_manifest(manifest: dict, config: dict, source_label: str = "manifest") -> dict:
    """Shared install path for marketplace / custom-manifest / zip-bundle.
    Validates, refuses duplicates, then config-before-enable: wire + enable when
    required config is satisfied, else install disabled awaiting config."""
    err = plugins.validate_manifest(manifest)
    if err:
        raise HTTPException(400, f"invalid plugin manifest: {err}")
    if plugins.get(PLUGINS_FILE, manifest["id"]):
        raise HTTPException(400, f"plugin '{manifest['id']}' is already installed")
    missing = plugins.missing_config(manifest, config)
    enabled = not missing
    wired = _plugin_wire(manifest, config) if enabled else {}
    # don't persist ephemeral bundle temp-paths into plugins.json
    for skill in (manifest.get("components") or {}).get("skills") or []:
        skill.pop("_bundle_skill_dir", None)
    entry = plugins.record_install(PLUGINS_FILE, manifest, config, enabled, wired, time.time())
    append_audit({"action": "plugin_installed", "plugin": manifest["id"],
                  "enabled": enabled, "wired": bool(wired), "source": source_label})
    return {"status": "installed", "plugin": entry,
            "needs_config": missing, "enabled": enabled}


@app.post("/api/plugins/upload")
async def upload_plugin_bundle(file: UploadFile = File(...)):
    """Install a plugin from an uploaded .zip bundle (manifest at root +
    optional skills/<slug>/ and prompts/<slug>.md files). Extracted zip-slip-
    safe to a temp dir, validated, then installed via the shared path."""
    if not (file.filename or "").lower().endswith(".zip"):
        raise HTTPException(400, "upload a .zip bundle")
    tmp = Path(tempfile.mkdtemp(prefix="agentic_plugin_"))
    try:
        zpath = tmp / "bundle.zip"
        data = await file.read()
        zpath.write_bytes(data)
        try:
            root = plugins.extract_bundle(zpath, tmp / "x")
            manifest = plugins.load_bundle_manifest(root)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return _install_manifest(manifest, {}, source_label="bundle-upload")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class PluginConfigure(BaseModel):
    config: dict


@app.put("/api/plugins/{plugin_id}/config")
def configure_plugin(plugin_id: str, data: PluginConfigure):
    entry = plugins.get(PLUGINS_FILE, plugin_id)
    if not entry:
        raise HTTPException(404, "plugin not installed")
    new_config = {**(entry.get("config") or {}), **(data.config or {})}
    # re-wire with the new config if currently enabled
    if entry.get("enabled"):
        _plugin_unwire(entry)
        wired = _plugin_wire(entry, new_config)
        plugins.update_entry(PLUGINS_FILE, plugin_id, {"config": new_config, "wired": wired})
    else:
        plugins.update_entry(PLUGINS_FILE, plugin_id, {"config": new_config})
    append_audit({"action": "plugin_configured", "plugin": plugin_id})
    return {"status": "ok", "plugin": plugins.get(PLUGINS_FILE, plugin_id)}


@app.post("/api/plugins/{plugin_id}/toggle")
def toggle_plugin(plugin_id: str):
    entry = plugins.get(PLUGINS_FILE, plugin_id)
    if not entry:
        raise HTTPException(404, "plugin not installed")
    if not entry.get("enabled"):
        missing = plugins.missing_config(entry, entry.get("config"))
        if missing:
            raise HTTPException(400, f"configure required fields first: {', '.join(missing)}")
        wired = _plugin_wire(entry, entry.get("config"))
        plugins.update_entry(PLUGINS_FILE, plugin_id, {"enabled": True, "wired": wired})
        new_state = True
    else:
        _plugin_unwire(entry)
        plugins.update_entry(PLUGINS_FILE, plugin_id, {"enabled": False, "wired": {}})
        new_state = False
    append_audit({"action": "plugin_toggled", "plugin": plugin_id, "enabled": new_state})
    return {"status": "ok", "enabled": new_state}


@app.delete("/api/plugins/{plugin_id}")
def uninstall_plugin(plugin_id: str):
    entry = plugins.get(PLUGINS_FILE, plugin_id)
    if not entry:
        raise HTTPException(404, "plugin not installed")
    _plugin_unwire(entry)
    plugins.remove(PLUGINS_FILE, plugin_id)
    append_audit({"action": "plugin_uninstalled", "plugin": plugin_id})
    return {"status": "uninstalled", "id": plugin_id}

# ─── Routes: Backup (state archive · destinations · restore · schedule) ──

BACKUPS_DIR = BASE_DIR / "backups"


def _project_workspace_paths() -> list:
    """Absolute, existing project folders — included only when the operator
    asks for workspaces in the backup."""
    out = []
    for p in load_projects().get("projects", []):
        path = (p.get("path") or "").strip()
        if path:
            wp = Path(path).expanduser()
            if wp.is_dir():
                out.append(str(wp))
    return out


def _run_backup(destinations: list, include_workspaces: bool, reason: str) -> dict:
    """Create one archive in the local backups dir, then fan out to each
    destination. The local copy is always kept (it's how restore + history
    work); 'local' destinations additionally copy it elsewhere."""
    archive = backup_engine.create_archive(
        BASE_DIR, BACKUPS_DIR, include_workspaces=include_workspaces,
        project_paths=_project_workspace_paths() if include_workspaces else None)
    results = [backup_engine.deliver(archive, d) for d in (destinations or [])]
    append_audit({"action": "backup_created", "file": archive.name,
                  "size": archive.stat().st_size, "workspaces": include_workspaces,
                  "destinations": [r["type"] for r in results], "reason": reason})
    return {"status": "ok", "file": archive.name, "size": archive.stat().st_size,
            "deliveries": results}


@app.get("/api/backups")
def list_backups():
    return backup_engine.list_archives(BACKUPS_DIR)


class BackupCreate(BaseModel):
    include_workspaces: bool = False
    destinations: list = []          # [{type:'local'|'git'|'scp', ...}]


@app.post("/api/backup")
def create_backup(data: Optional[BackupCreate] = None):
    data = data or BackupCreate()
    bad = [d for d in data.destinations if d.get("type") not in backup_engine.DEST_TYPES]
    if bad:
        raise HTTPException(400, f"unknown destination type(s): {[d.get('type') for d in bad]}")
    return _run_backup(data.destinations, data.include_workspaces, reason="manual")


@app.post("/api/backup/restore")
def restore_backup(data: BackupRestoreRequest):
    if Path(data.file).name != data.file or not data.file.endswith(".tar.gz"):
        raise HTTPException(400, "Invalid backup file name")
    backup_file = safe_join(BACKUPS_DIR, data.file)
    if not backup_file.exists():
        raise HTTPException(404, "Backup file not found")
    try:
        backup_engine.safe_extract(backup_file, BASE_DIR)
    except ValueError as e:
        raise HTTPException(400, str(e))
    append_audit({"action": "backup_restored", "file": data.file})
    return {"status": "restored"}


@app.delete("/api/backups/{name}")
def delete_backup(name: str):
    if Path(name).name != name or not name.endswith(".tar.gz"):
        raise HTTPException(400, "Invalid backup file name")
    f = safe_join(BACKUPS_DIR, name)
    if not f.exists():
        raise HTTPException(404, "Backup file not found")
    f.unlink()
    append_audit({"action": "backup_deleted", "file": name})
    return {"status": "deleted", "name": name}


# Backup schedule — stored in settings.json -> backup_schedule; fired by the
# heartbeat ticker (separate from agent-task schedules — it runs no LLM).
@app.get("/api/backup/schedule")
def get_backup_schedule():
    return load_settings().get("backup_schedule") or {"enabled": False}


class BackupScheduleUpdate(BaseModel):
    enabled: bool = False
    interval_hours: int = 24
    include_workspaces: bool = False
    destinations: list = []


@app.put("/api/backup/schedule")
def set_backup_schedule(data: BackupScheduleUpdate):
    bad = [d for d in data.destinations if d.get("type") not in backup_engine.DEST_TYPES]
    if bad:
        raise HTTPException(400, f"unknown destination type(s): {[d.get('type') for d in bad]}")
    hours = max(1, min(24 * 30, int(data.interval_hours)))
    def _apply(s):
        # preserve last_run from inside the lock (a concurrent tick re-arm
        # landing between a separate read+write could otherwise be lost)
        last_run = (s.get("backup_schedule") or {}).get("last_run")
        s["backup_schedule"] = {
            "enabled": bool(data.enabled), "interval_hours": hours,
            "include_workspaces": bool(data.include_workspaces),
            "destinations": data.destinations,
            "next_run": time.time() + hours * 3600 if data.enabled else None,
            "last_run": last_run}
    sched = mutate_settings(_apply)["backup_schedule"]
    append_audit({"action": "backup_schedule_updated", "enabled": sched["enabled"],
                  "interval_hours": hours})
    return sched


def _backup_schedule_tick():
    """Called from the heartbeat ticker: run a scheduled backup when due.
    Re-arm under the settings lock so a concurrent operator edit isn't lost."""
    sched = load_settings().get("backup_schedule") or {}
    if not sched.get("enabled") or not sched.get("next_run"):
        return
    if sched["next_run"] > time.time():
        return
    try:
        _run_backup(sched.get("destinations", []), sched.get("include_workspaces", False),
                    reason="scheduled")
    except Exception:
        pass
    def _rearm(settings):
        s = settings.get("backup_schedule") or {}
        s["last_run"] = time.time()
        s["next_run"] = time.time() + max(1, min(24 * 30, int(s.get("interval_hours", 24)))) * 3600
        settings["backup_schedule"] = s
    mutate_settings(_rearm)

# ─── Routes: Prompts ──────────────────────────────────────────────

@app.get("/api/prompts")
def list_prompts():
    prompts_dir = BASE_DIR / "prompts"
    prompts = {}
    for f in sorted(prompts_dir.glob("*.md")):
        prompts[f.stem] = read_file(f)
    return prompts

# ─── Routes: Settings ─────────────────────────────────────────────

@app.get("/api/settings")
def get_settings():
    return load_settings()

@app.put("/api/settings")
def update_settings(data: SettingsUpdate):
    # Top-level merge under the settings lock (honors test isolation; safe vs
    # the heartbeat thread's backup-schedule/mirror writes).
    incoming = dict(data.settings)
    def _apply(existing):
        merged_in = dict(incoming)
        if "mirror" in merged_in:   # mirror is a partial patch — keep last_sync markers
            merged = dict(existing.get("mirror") or {})
            merged.update(merged_in["mirror"] or {})
            merged_in["mirror"] = merged
        existing.update(merged_in)
    result = mutate_settings(_apply)
    append_audit({"action": "settings_updated"})
    if "mirror" in incoming:
        reschedule_claude_sync(result.get("mirror") or {})
    return {"status": "ok"}

# ─── Routes: Standards ────────────────────────────────────────────

@app.get("/api/standards")
def list_standards():
    std_dir = BASE_DIR / "standards"
    if not std_dir.exists():
        return {"standards": []}
    standards = []
    index_file = std_dir / "index.yml"
    index_content = read_file(index_file)
    for f in std_dir.glob("*.md"):
        standards.append({
            "name": f.stem,
            "content": read_file(f),
        })
    return {"standards": standards, "index": index_content}

@app.post("/api/standards/discover")
def discover_standards():
    # Honest 501: pattern auto-discovery is not implemented. Previously this
    # claimed "discovery_started" and did nothing. Standards are authored as
    # files under standards/; surface that instead of pretending.
    raise HTTPException(501, "Automatic pattern discovery isn't implemented. "
                             "Add standards as markdown files under standards/ "
                             "(or via the Skills/MCP sync) — they'll appear here.")

# ─── Routes: Chat ─────────────────────────────────────────────────

CHAT_HISTORY_FILE = BASE_DIR / "data" / "chat-history.json"

def load_chat_history():
    return jsonstore.read_json(CHAT_HISTORY_FILE, {"messages": []})

def save_chat_message(msg: dict):
    # RMW under the file lock so concurrent chats can't drop each other's lines
    with jsonstore.lock_for(CHAT_HISTORY_FILE):
        history = load_chat_history()
        history["messages"].append(msg)
        if len(history["messages"]) > 200:
            history["messages"] = history["messages"][-200:]
        jsonstore.atomic_write_json(CHAT_HISTORY_FILE, history)

# What the current execution is doing — set by callers (task loop, chat,
# skills, reflection) in THEIR OWN thread before invoking a provider, read by
# run_cli to register the subprocess as a killable session.
_exec_ctx = contextvars.ContextVar("exec_ctx", default=None)


def run_cli(args: list, timeout: int = 30, cwd: str = None) -> tuple:
    """Single choke point for every provider CLI. The child runs in its own
    process group (so a kill takes out its children too) and is registered as
    an Active Session for the lifetime of the call. A session killed by the
    operator surfaces as (code, out, '⚠ killed by operator…') so the normal
    error classification marks linked tasks failed."""
    ctx = _exec_ctx.get() or {}
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, cwd=cwd or None, start_new_session=True)
    sid = proc_registry.register(proc, kind=ctx.get("kind", "agent"),
                                 label=ctx.get("label", " ".join(args[:2])),
                                 agent_id=ctx.get("agent_id"),
                                 task_id=ctx.get("task_id"), command=args[0])
    try:
        out, err = proc.communicate(timeout=timeout)
        killed = proc_registry.was_killed(sid)
    except subprocess.TimeoutExpired:
        proc_registry.kill(sid)        # no orphaned process groups on timeout
        try:
            proc.communicate(timeout=2)    # reap pipes/zombie before re-raising
        except Exception:
            pass
        raise
    finally:
        proc_registry.finish(sid)
    if killed:
        return proc.returncode, out, f"⚠ {proc_registry.KILLED_MARKER} (Active Sessions)"
    return proc.returncode, out, err

def clean_hermes_output(raw: str) -> str:
    """Strip CLI metadata from Hermes output, returning only the AI response."""
    if not raw:
        return ""
    lines = raw.split('\n')
    in_box = False
    content_lines = []
    for line in lines:
        if '╭─' in line:
            in_box = True
            continue
        if '╰─' in line:
            in_box = False
            continue
        if in_box:
            # Remove ANSI escape codes and leading whitespace
            cleaned = line.strip()
            if cleaned:
                content_lines.append(cleaned)
    if content_lines:
        return '\n'.join(content_lines)
    # Fallback: if no box found, return last non-metadata line
    non_meta = [l.strip() for l in lines if l.strip() and not l.startswith(('Query:', 'Initializing', '──', 'Resume', 'Session:', 'Duration:', 'Messages:'))]
    return '\n'.join(non_meta[-5:]) or raw

def execute_claude(message: str, model: str = "", system_prompt: str = "", timeout: int = 300,
                   mcp_config_path: str = None, workdir: str = None,
                   allowed_mcp_tools: list = None) -> str:
    """Claude provider via the `claude` CLI (print mode), mirroring the gemini
    path. Works with a subscription login (`claude login`) or an exported
    ANTHROPIC_API_KEY — both inherited by the child process. Model is injected
    from the agent profile; persona via --append-system-prompt; attached MCP
    servers via --mcp-config, with their tools pre-approved via --allowedTools
    (headless print mode denies MCP tools otherwise)."""
    if not claude_cli_authed():
        return ("**Claude needs authentication**\n\nRun `claude login` (subscription) "
                "or set `ANTHROPIC_API_KEY` (or configure it on the Providers page) "
                "and try again.")
    args = ["claude", "-p", message, "--model", model or DEFAULT_CLAUDE_MODEL]
    if system_prompt:
        args += ["--append-system-prompt", system_prompt]
    if mcp_config_path:
        args += ["--mcp-config", mcp_config_path]
        if allowed_mcp_tools:
            # pre-approve the attached servers' tools — the operator explicitly
            # attached these, so their tools are trusted for this agent
            args += ["--allowedTools", ",".join(allowed_mcp_tools)]
    if workdir:
        # project workspace: run inside the folder and auto-accept file edits
        # there (acceptEdits — never the dangerous full-skip mode)
        args += ["--permission-mode", "acceptEdits", "--add-dir", workdir]
    try:
        code, out, err = run_cli(args, timeout=timeout, cwd=workdir)
    except subprocess.TimeoutExpired:
        return (f"⏱ Claude timed out.\n\nTry `claude -p \"{message[:60]}\"` directly.\n\n"
                f"**Message:** {message[:100]}")
    if code == 0:
        return (out or "").strip() or f"**Claude**\n\nProcessed your message.\n\n**Message:** {message[:100]}"
    err_msg = (err or "").strip()
    low = err_msg.lower()
    if "api" in low and "key" in low or "auth" in low or "unauthorized" in low or "login" in low:
        return (f"**Claude auth error**\n\nRun `claude login` to re-authenticate "
                f"(or check `ANTHROPIC_API_KEY`).\n\n**Details:** {err_msg[:200]}")
    return err_msg or f"claude returned exit code {code}"


def execute_codex(message: str, model: str = "", system_prompt: str = "", timeout: int = 300,
                  workdir: str = None) -> str:
    """Codex provider via the `codex` CLI (non-interactive `exec`). Persona is
    prepended to the message (no system-prompt flag); auth comes from the CLI's
    ChatGPT login (~/.codex/auth.json) or OPENAI_API_KEY in the env."""
    has_auth = (Path.home() / ".codex" / "auth.json").exists() or \
        bool(os.environ.get("OPENAI_API_KEY", "").strip())
    if not has_auth:
        return ("**Codex needs authentication**\n\nRun `codex login` or set "
                "`OPENAI_API_KEY` (or configure it on the Providers page) and try again.")
    full = (system_prompt.strip() + "\n\n" + message) if system_prompt else message
    args = ["codex", "exec", "--skip-git-repo-check"]
    if workdir:
        args += ["-C", workdir, "--sandbox", "workspace-write"]
    args += ["-m", model or DEFAULT_CODEX_MODEL, full]
    try:
        # -C already sets codex's dir; cwd kept in sync for any relative output
        code, out, err = run_cli(args, timeout=timeout, cwd=workdir)
    except subprocess.TimeoutExpired:
        return (f"⏱ Codex timed out.\n\nTry `codex exec \"{message[:60]}\"` directly.\n\n"
                f"**Message:** {message[:100]}")
    if code == 0:
        return (out or "").strip() or f"**Codex**\n\nProcessed your message.\n\n**Message:** {message[:100]}"
    err_msg = (err or "").strip()
    low = err_msg.lower()
    if "login" in low or "auth" in low or "unauthorized" in low or ("api" in low and "key" in low):
        return f"**Codex auth error**\n\nRun `codex login` or check `OPENAI_API_KEY`.\n\n**Details:** {err_msg[:200]}"
    return err_msg or f"codex returned exit code {code}"


def execute_custom_cli(template: str, message: str, model: str = "", timeout: int = 300) -> str:
    """Run a CUSTOM provider's CLI command template. The template is shlex-split
    first, then {model}/{prompt} placeholders are substituted per argv token —
    the prompt is never re-parsed by a shell (injection-safe)."""
    import shlex
    try:
        tokens = shlex.split(template or "")
    except ValueError as e:
        return f"⚠ Invalid CLI template: {e}"
    if not tokens:
        return "⚠ CLI template is empty — set one on the Providers page."
    args = [t.replace("{model}", model).replace("{prompt}", message) for t in tokens]
    if shutil.which(args[0]) is None:
        return f"⚠ CLI '{args[0]}' is not installed."
    try:
        code, out, err = run_cli(args, timeout=timeout)
    except subprocess.TimeoutExpired:
        return f"⏱ '{args[0]}' timed out.\n\n**Message:** {message[:100]}"
    if code == 0:
        return (out or "").strip() or "(empty response)"
    return (err or "").strip() or f"{args[0]} returned exit code {code}"


def execute_agent(agent: str, message: str, model: str = "", system_prompt: str = "",
                  mcp_config_path: str = None, workdir: str = None,
                  allowed_mcp_tools: list = None) -> str:
    # Persona is prepended to the message for CLIs without a system-prompt flag.
    full = (system_prompt.strip() + "\n\n" + message) if system_prompt else message
    try:
        if agent == "claude":
            return execute_claude(message, model, system_prompt, mcp_config_path=mcp_config_path,
                                  workdir=workdir, allowed_mcp_tools=allowed_mcp_tools)

        if agent == "codex":
            return execute_codex(message, model, system_prompt, workdir=workdir)

        if agent == "opencode":
            try:
                code, out, err = run_cli(["opencode", "run", "--format", "json", full], timeout=30)
            except subprocess.TimeoutExpired:
                return f"⏱ Agent 'opencode' timed out.\n\nOpenCode's model is taking too long. Try running `opencode run \"{message[:60]}\"` directly in your terminal.\n\n**Message:** {message[:100]}"
            if code == 0:
                response_text = ""
                for line in (out or "").split('\n'):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                        if event.get("type") == "text":
                            text = event.get("part", {}).get("text", "")
                            if text:
                                response_text += text + "\n"
                    except (json.JSONDecodeError, KeyError):
                        continue
                if response_text:
                    return response_text.strip()
                return f"**opencode**\n\nProcessed your message.\n\n**Message:** {message[:100]}"
            err_msg = (err or "").strip()
            return err_msg or f"opencode returned exit code {code}"

        elif agent == "hermes":
            try:
                code, out, err = run_cli(["hermes", "chat", "-q", full], timeout=180)
            except subprocess.TimeoutExpired:
                return f"⏱ Hermes timed out.\n\nThe model took too long to respond. Try a shorter query or check your OpenRouter rate limits.\n\n**Message:** {message[:100]}"
            if code == 0:
                cleaned = clean_hermes_output(out or "")
                if cleaned:
                    return cleaned
                # Empty response from model - return useful fallback
                return f"**Hermes**\n\nReceived your message but the model returned an empty response. Try rephrasing your query.\n\n**Message:** {message}"
            err_msg = (err or "").strip()
            if "invalid choice" in err_msg or "usage:" in err_msg:
                return f"**Hermes needs setup**\n\nRun `hermes setup` or check your config.\n\n**Details:** {err_msg[:200]}"
            return err_msg or f"hermes returned exit code {code}"

        elif agent == "gemini":
            for attempt, (args, to) in enumerate([
                (["-y", "-m", model or "gemini-2.5-flash"], 240),
                (["-y"], 90),
            ]):
                try:
                    code, out, err = run_cli(["gemini", *args, full], timeout=to)
                except subprocess.TimeoutExpired:
                    # Do NOT retry on timeout — a timed-out generation may have
                    # already incurred provider cost, and re-running would
                    # double-charge. Only the model-not-found path below retries
                    # (that error means nothing was generated).
                    return f"⏱ Gemini timed out.\n\nTry running `gemini \"{message[:60]}\"` directly.\n\n**Message:** {message[:100]}"
                if code == 0:
                    return (out or "").strip() or f"**Gemini CLI**\n\nProcessed your query.\n\n**Message:** {message}"
                err_msg = (err or "").strip()
                if attempt == 0 and ("model" in err_msg.lower() or "not found" in err_msg.lower()):
                    continue
                if "auth" in err_msg.lower() or "login" in err_msg.lower():
                    return f"**Gemini needs re-auth**\n\nRun `gemini auth login` to re-authenticate.\n\n**Details:** {err_msg[:200]}"
                return err_msg or f"gemini returned exit code {code}"
            return "Gemini CLI did not return a response."

        else:
            return f"Unknown agent: {agent}"
    except subprocess.TimeoutExpired:
        return f"⏱ Agent '{agent}' timed out.\n\nRun `{agent} --help` in your terminal for CLI usage.\n\n**Message:** {message[:100]}"
    except FileNotFoundError:
        return f"⚠ Agent '{agent}' CLI not installed. Install it and try again."
    except Exception as e:
        return f"⚠ Error communicating with {agent}: {str(e)}"


def build_memory_context(agent: dict, message: str, max_chars: int = 4000,
                         memory_dir: Path = None) -> str:
    """Pull relevant vault notes for this task: seed from the agent's skills and
    salient words in the message, expand one hop via [[wikilinks]]. Returns ''
    when injection is disabled or nothing matches. ``memory_dir`` overrides the
    global vault (project-scoped memory)."""
    if not memory_inject_enabled():
        return ""
    seeds = list((agent or {}).get("skills", []) or [])
    seeds += [w.strip(".,!?:;").lower() for w in (message or "").split() if len(w) > 3][:8]
    try:
        return memory_vault.resolve_context(memory_dir or get_vault_dir(), seeds,
                                            depth=1, max_chars=max_chars)
    except Exception:
        return ""


NEEDS_INPUT_MARKER = "[NEEDS_INPUT]"
NEEDS_INPUT_INSTRUCTION = (
    "IMPORTANT — human-in-the-loop protocol: whenever your reply requires an "
    "answer, decision, or missing information from the human before you can "
    "continue, you MUST end your reply with one final line in exactly this "
    "format:\n[NEEDS_INPUT] <your one-sentence question>\n"
    "This routes your question to the human's inbox. Never use the marker when "
    "you are not blocked on the human.")


def load_inbox() -> dict:
    return jsonstore.read_json(INBOX_FILE, {"items": []})


def save_inbox(data: dict):
    jsonstore.atomic_write_json(INBOX_FILE, data)


def scan_for_needs_input(agent: dict, message: str, result: str,
                         source: str = "task", project_id: str = None):
    """If the agent's reply contains [NEEDS_INPUT], file an inbox item. The
    item carries enough context to re-dispatch the conversation on reply."""
    if not result or NEEDS_INPUT_MARKER not in result:
        return None
    question = result.split(NEEDS_INPUT_MARKER, 1)[1].strip().splitlines()
    question = (question[0].strip() if question else "") or "Agent requested input."
    item = {
        "id": str(uuid.uuid4())[:8],
        "agent_id": (agent or {}).get("id", ""),
        "agent_name": (agent or {}).get("name", (agent or {}).get("provider", "agent")),
        "question": question,
        "message": message,
        "result": result,
        "source": source,
        "project_id": project_id,
        "status": "waiting",
        "created": get_timestamp(),
    }
    box = load_inbox()
    box.setdefault("items", []).append(item)
    save_inbox(box)
    append_audit({"action": "inbox_item_created", "agent_id": item["agent_id"], "id": item["id"]})
    return item


# ─── Projects (folder + goal + team + scoped memory + chat) ────────

def load_projects() -> dict:
    return jsonstore.read_json(PROJECTS_FILE, {"projects": []})


def save_projects(data: dict):
    jsonstore.atomic_write_json(PROJECTS_FILE, data)


def get_project_by_id(project_id: str):
    for pr in load_projects().get("projects", []):
        if pr.get("id") == project_id:
            return pr
    return None


def project_memory_dir(project: dict) -> Path:
    """Each project gets its own vault under brain/projects/<slug>/ — the team's
    agents see ONLY this memory in project chats."""
    d = get_vault_dir() / "projects" / project.get("slug", project.get("id", "project"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_chat_file(project_id: str) -> Path:
    PROJECT_CHATS_DIR.mkdir(parents=True, exist_ok=True)
    return safe_join(PROJECT_CHATS_DIR, f"{project_id}.json")


def load_project_chat(project_id: str) -> list:
    # .bak-recovering read for parity with the atomic write side
    return jsonstore.read_json(project_chat_file(project_id), {"messages": []}).get("messages", [])


def append_project_chat(project_id: str, role: str, content: str, agent_id: str = None):
    f = project_chat_file(project_id)
    with jsonstore.lock_for(f):   # concurrent agent replies + operator msgs
        msgs = load_project_chat(project_id)
        msgs.append({"id": str(uuid.uuid4())[:8], "role": role, "content": content,
                     "agent_id": agent_id, "timestamp": get_timestamp()})
        jsonstore.atomic_write_json(f, {"messages": msgs[-500:]})


def project_context_prompt(project: dict) -> str:
    """Goal + a shallow listing of the project's real folder, prepended to the
    agent's persona for project chats."""
    parts = [f"# Project: {project.get('name', '')}"]
    if project.get("goal"):
        parts.append(f"Goal: {project['goal']}")
    path = (project.get("path") or "").strip()
    if path:
        d = Path(path).expanduser()
        if d.is_dir():
            entries = sorted(e.name + ("/" if e.is_dir() else "") for e in d.iterdir()
                             if not e.name.startswith("."))[:40]
            parts.append(f"Project folder: {d} — this is your working directory; "
                         f"create and edit files there directly.\nTop-level contents: "
                         + ", ".join(entries))
    return "\n".join(parts)


# ─── Agent task queue + heartbeat runtime ─────────────────────────
# Agents sleep until their heartbeat finds queued work (or an operator wakes
# them by assigning directly). Leads distribute subtasks via [DELEGATE: name]
# lines; every queue task is mirrored onto the Kanban board.

_queue_lock = threading.Lock()


def _team_for_lead(agent_id: str, project_id: str = None):
    """The team this agent manages — preferring the project's team — plus its
    member roster (lead excluded). Returns (team, members)."""
    teams = load_teams().get("teams", [])
    candidates = [t for t in teams if t.get("manager_id") == agent_id]
    if project_id:
        proj = get_project_by_id(project_id)
        if proj:
            for t in candidates:
                if t.get("id") == proj.get("team_id"):
                    candidates = [t]
                    break
    team = candidates[0] if candidates else None
    if not team:
        return None, []
    members = []
    for node in team.get("hierarchy", []):
        if node.get("agent_id") == agent_id:
            continue
        a = get_agent_by_id(node.get("agent_id"))
        if a:
            members.append({"id": a["id"], "name": a.get("name", a["id"]),
                            "role": node.get("role", "Member")})
    return team, members


def _with_runtime_persona(agent: dict, project_id: str = None) -> dict:
    """Copy of the profile with project context + (for leads) the delegation
    roster injected — per call, never persisted."""
    scoped = dict(agent)
    extras = []
    if project_id:
        proj = get_project_by_id(project_id)
        if proj:
            extras.append(project_context_prompt(proj))
    _, members = _team_for_lead(agent.get("id", ""), project_id)
    if members:
        extras.append(agent_tasks.delegate_instruction(members))
    if extras:
        scoped["system_prompt"] = ("\n\n".join(extras) + "\n\n"
                                   + (agent.get("system_prompt") or "")).strip()
    return scoped


def _mirror_kanban(task: dict):
    """Keep the Kanban card in lockstep with the queue task's state."""
    if not task.get("kanban_id"):
        return
    f = KANBAN_DIR / f"{task['kanban_id']}.json"
    if not f.exists():
        return
    try:
        card = json.loads(f.read_text())
    except Exception:
        return
    card["status"] = agent_tasks.KANBAN_MIRROR.get(task.get("status"), "todo")
    if task.get("result"):
        card["result"] = task["result"]
    card["updated"] = get_timestamp()
    save_kanban_task(card)


def queue_agent_task(agent: dict, title: str, message: str, project_id: str = None,
                     parent_id: str = None, created_by: str = "operator") -> dict:
    """Queue work for an agent (sleeping until wake) + create its Kanban mirror."""
    now = get_timestamp()
    card = {
        "id": str(uuid.uuid4())[:8],
        "title": (title or message[:60]).strip(),
        "body": message,
        "status": "todo",
        "priority": "medium",
        "assignee": agent["id"],
        "team_id": None,
        "project_id": project_id,
        "comments": [], "links": [],
        "created": now, "updated": now,
    }
    if project_id:
        proj = get_project_by_id(project_id)
        team = get_team_by_id(proj.get("team_id", "")) if proj else None
        if team:
            card["team_id"] = team["id"]
    save_kanban_task(card)
    task = agent_tasks.enqueue(AGENT_TASKS_FILE, agent["id"], title, message,
                               project_id=project_id, parent_id=parent_id,
                               created_by=created_by, kanban_id=card["id"])
    append_audit({"action": "agent_task_queued", "agent_id": agent["id"],
                  "task_id": task["id"], "created_by": created_by})
    return task


def scan_for_delegations(agent: dict, result: str, project_id: str = None,
                         parent_task_id: str = None) -> list:
    """Turn a Lead's [DELEGATE: member] lines into queued tasks for teammates.
    Members stay asleep — their own heartbeat picks the work up."""
    pairs = agent_tasks.parse_delegations(result)
    if not pairs:
        return []
    # Loop guard: walk the parent chain. Past MAX_DELEGATION_DEPTH hops, or to
    # an agent already in the chain (A→B→A cycles), delegation is refused and
    # audited — the budget gate is a backstop, not the guard.
    depth, chain_agents = (0, set())
    if parent_task_id:
        depth, chain_agents = agent_tasks.delegation_chain(AGENT_TASKS_FILE, parent_task_id)
    if depth >= agent_tasks.MAX_DELEGATION_DEPTH:
        append_audit({"action": "delegation_depth_exceeded", "agent_id": agent.get("id"),
                      "depth": depth, "dropped": len(pairs)})
        return []
    chain_agents.add(agent.get("id"))
    _, members = _team_for_lead(agent.get("id", ""), project_id)
    by_name = {m["name"].lower(): m for m in members}
    by_id = {m["id"]: m for m in members}
    created = []
    for name, subtask in pairs:
        member = by_name.get(name.lower()) or by_id.get(name)
        if not member:   # unknown member named — surface, don't silently drop
            append_audit({"action": "delegation_unresolved", "agent_id": agent.get("id"),
                          "member": name})
            continue
        if member["id"] in chain_agents:   # cycle — refuse, audit
            append_audit({"action": "delegation_cycle_refused", "agent_id": agent.get("id"),
                          "member": member["id"]})
            continue
        target = get_agent_by_id(member["id"])
        created.append(queue_agent_task(target, subtask[:60], subtask,
                                        project_id=project_id, parent_id=parent_task_id,
                                        created_by=f"delegated:{agent.get('id')}"))
    return created


def learning_enabled() -> bool:
    """Global self-learning switch: settings.json -> learning.enabled (default on)."""
    return bool(load_settings().get("learning", {}).get("enabled", True))


def reflect_on_task(agent: dict, task: dict, result: str, status: str):
    """The self-learning step: one small extra LLM call per settled task that
    distills ≤3 lessons into the agent's learnings file. Metered against the
    agent's budget; skipped silently when the budget window is exhausted (the
    real work always outranks reflection)."""
    if not learning_enabled():
        return
    provider = (agent or {}).get("provider", "")
    if provider not in all_provider_names():
        return
    cfg = get_provider_config(provider)
    if not cfg.get("enabled", True):
        return
    allowed, _, _, _ = budgets.check_budget(AGENT_USAGE_FILE, agent or {})
    if not allowed:
        return
    prompt = learning.REFLECTION_PROMPT.format(
        max_lessons=learning.MAX_LESSONS_PER_TASK,
        max_chars=learning.MAX_LESSON_CHARS,
        message=(task.get("message") or "")[:1500],
        status=status,
        result=(result or "")[:2000])
    model = (agent or {}).get("model", "") or cfg.get("default_model", "") or ""
    try:
        _exec_ctx.set({"kind": "reflection", "agent_id": (agent or {}).get("id"),
                       "task_id": task.get("id"),
                       "label": f"reflecting on: {task.get('title', '')[:40]}"})
        reply = _dispatch_to_provider(provider, cfg, agent, prompt, model,
                                      "You extract lessons. Bullets only.")
    except Exception:
        return
    try:
        tin = budgets.estimate_tokens(prompt)
        tout = budgets.estimate_tokens(reply)
        cost = budgets.estimate_cost(model, tin, tout, load_settings().get("model_prices"))
        budgets.record_usage(AGENT_USAGE_FILE, (agent or {}).get("id", ""), model, tin, tout, cost)
    except Exception:
        pass
    lessons = learning.parse_lessons(reply)
    if not lessons:
        return
    learning.append_lessons(
        learning.learnings_path(get_vault_dir(), agent["id"]),
        lessons, task.get("title", ""), get_timestamp()[:10])
    append_audit({"action": "agent_reflected", "agent_id": agent["id"],
                  "task_id": task.get("id"), "lessons": len(lessons)})


def process_agent_queue(agent_id: str) -> list:
    """Wake an agent: claim and DRAIN its queued tasks one by one. Budget gate
    applies per task inside execute_profile; a limit-reached reply marks the
    task failed without burning the rest of the window."""
    agent = get_agent_by_id(agent_id)
    if not agent:
        return []
    with _queue_lock:
        claimed = agent_tasks.claim_queued(AGENT_TASKS_FILE, agent_id)
        if not claimed:
            return []
        agent_tasks.mark_wake(AGENT_TASKS_FILE, agent_id)
    processed = []
    for t in claimed:
        _mirror_kanban(t)
        memory_dir, workdir = None, None
        if t.get("project_id"):
            proj = get_project_by_id(t["project_id"])
            if proj:
                memory_dir = project_memory_dir(proj)
                pp = (proj.get("path") or "").strip()
                if pp and Path(pp).expanduser().is_dir():
                    workdir = str(Path(pp).expanduser())
        scoped = _with_runtime_persona(agent, t.get("project_id"))
        _exec_ctx.set({"kind": "task", "agent_id": agent_id, "task_id": t["id"],
                       "label": t.get("title") or t["message"][:60]})
        result = execute_profile(scoped, t["message"], memory_dir=memory_dir, workdir=workdir)
        if "Budget limit reached" in result or result.lstrip().startswith(("⏱", "⚠")):
            status = "failed"
        elif NEEDS_INPUT_MARKER in result:
            status = "needs_input"
            scan_for_needs_input(agent, t["message"], result,
                                 source="heartbeat", project_id=t.get("project_id"))
        else:
            status = "done"
        delegated = scan_for_delegations(agent, result, t.get("project_id"), t["id"])
        updated = agent_tasks.set_status(AGENT_TASKS_FILE, t["id"], status, result=result)
        if updated:
            _mirror_kanban(updated)
        if status in ("done", "failed"):
            try:
                reflect_on_task(agent, t, result, status)
            except Exception:
                pass    # learning must never break the work loop
        if t.get("project_id"):
            append_project_chat(t["project_id"], "assistant",
                                f"[{t['title']}]\n{result}", agent_id=agent_id)
        processed.append({"task_id": t["id"], "status": status,
                          "delegated": len(delegated), "result": result})
        append_audit({"action": "agent_task_processed", "agent_id": agent_id,
                      "task_id": t["id"], "status": status, "delegated": len(delegated)})
    agent_tasks.mark_sleep(AGENT_TASKS_FILE, agent_id)
    return processed


def _fire_schedule(sched: dict, manual: bool = False) -> dict | None:
    """One schedule firing → one queued agent task (+ Kanban mirror). Manual
    runs don't shift the recurrence. Returns the task, or None if the target
    agent vanished (schedule is auto-disabled so it can't error every tick)."""
    agent = get_agent_by_id(sched.get("agent_id", ""))
    if not agent:
        schedules.update(SCHEDULES_FILE, sched["id"], {"enabled": False})
        append_audit({"action": "schedule_orphaned_disabled", "schedule_id": sched["id"],
                      "agent_id": sched.get("agent_id")})
        return None
    project_id = sched.get("project_id")
    if project_id and not get_project_by_id(project_id):
        project_id = None     # project deleted since — run unscoped rather than fail forever
    task = queue_agent_task(agent, sched.get("name", ""), sched.get("message", ""),
                            project_id=project_id,
                            created_by=f"schedule:{sched['id']}")
    if not manual:
        rolled = schedules.mark_fired(SCHEDULES_FILE, sched["id"], task["id"])
        # A cron with no further occurrence in the horizon must not linger as
        # a silently dead schedule — disable it and say so.
        if rolled and rolled.get("enabled") and rolled.get("next_run") is None:
            schedules.update(SCHEDULES_FILE, sched["id"], {"enabled": False})
            append_audit({"action": "schedule_exhausted_disabled",
                          "schedule_id": sched["id"], "name": sched.get("name", "")})
    append_audit({"action": "schedule_fired", "schedule_id": sched["id"],
                  "name": sched.get("name", ""), "task_id": task["id"],
                  "agent_id": agent["id"], "manual": manual})
    if sched.get("wake", True) or manual:
        threading.Thread(target=_safe_process_queue, args=(agent["id"],),
                         daemon=True).start()
    return task


def _heartbeat_tick():
    """Scheduler tick (~15s): fire due schedules into agent queues, then wake
    every agent whose heartbeat has elapsed and who has queued work. Sleeping
    agents with empty queues cost nothing."""
    try:
        try:
            _backup_schedule_tick()
        except Exception:
            pass
        for sched in schedules.due_schedules(SCHEDULES_FILE):
            try:
                _fire_schedule(sched)
            except Exception:
                pass
        agents = load_agents_registry().get("agents", [])
        # Drain each due agent on its OWN daemon thread so a slow/hung provider
        # CLI can't block sibling agents or the schedule loop. The per-agent
        # claim lock + "working" runtime state (due_agent_ids skips agents
        # already working) prevent a later tick from double-dispatching the
        # same agent while its thread is still running.
        for aid in agent_tasks.due_agent_ids(AGENT_TASKS_FILE, agents):
            threading.Thread(target=_safe_process_queue, args=(aid,), daemon=True).start()
    except Exception:
        pass


def execute_profile(agent: dict, message: str, memory_dir: Path = None,
                    workdir: str = None) -> str:
    """Run a request against a resolved agent profile — model, persona, and
    vault memory injected; budget-gated and usage-metered. ``memory_dir``
    scopes memory injection to a specific vault (project chats)."""
    provider = (agent or {}).get("provider", "")
    if provider not in all_provider_names():
        return f"Unknown provider: {provider}"
    cfg = get_provider_config(provider)
    if not cfg.get("enabled", True):
        return f"**Provider '{provider}' is disabled** — re-enable it on the Providers page."

    # Hard budget gate — agents cannot bypass their $ allowance.
    allowed, spent, limit, period = budgets.check_budget(AGENT_USAGE_FILE, agent or {})
    if not allowed:
        append_audit({"action": "budget_blocked", "agent_id": (agent or {}).get("id"),
                      "spent": round(spent, 4), "limit": limit, "period": period})
        return budgets.limit_message(spent, limit, period)

    system_prompt = (agent or {}).get("system_prompt", "") or ""
    context = build_memory_context(agent, message, memory_dir=memory_dir)
    if context:
        system_prompt = (f"# Relevant memory (from your knowledge vault)\n{context}\n\n"
                         + system_prompt).strip()
    # Self-learning: lessons this agent extracted from its own past tasks.
    lessons = learning.read_for_injection(
        learning.learnings_path(get_vault_dir(), (agent or {}).get("id", "")))
    if lessons:
        system_prompt = (system_prompt
                         + "\n\n# Lessons from your past tasks (apply where relevant)\n"
                         + lessons).strip()
    system_prompt = (system_prompt + "\n\n" + NEEDS_INPUT_INSTRUCTION).strip()

    if _exec_ctx.get() is None:    # callers with richer context set it themselves
        _exec_ctx.set({"kind": "agent", "agent_id": (agent or {}).get("id"),
                       "label": message[:60]})
    model = (agent or {}).get("model", "") or cfg.get("default_model", "") or ""
    result = _dispatch_to_provider(provider, cfg, agent, message, model, system_prompt,
                                   workdir=workdir)

    # Meter usage (estimates — guardrail, not accounting).
    try:
        tin = budgets.estimate_tokens(system_prompt) + budgets.estimate_tokens(message)
        tout = budgets.estimate_tokens(result)
        cost = budgets.estimate_cost(model, tin, tout, load_settings().get("model_prices"))
        budgets.record_usage(AGENT_USAGE_FILE, (agent or {}).get("id", ""), model, tin, tout, cost)
    except Exception:
        pass
    return result


def _dispatch_to_provider(provider: str, cfg: dict, agent: dict, message: str,
                          model: str, system_prompt: str, workdir: str = None) -> str:
    # Custom provider — token (api) or CLI-template mode.
    if cfg.get("custom"):
        if cfg.get("mode") == "cli":
            full = (system_prompt.strip() + "\n\n" + message) if system_prompt else message
            return execute_custom_cli(cfg.get("cli_template", ""), full, model)
        api_key = resolve_provider_key(cfg)
        if not api_key and cfg.get("key_optional"):
            api_key = "not-required"   # local OpenAI-compatible endpoints ignore auth
        return providers.execute_api(cfg.get("api_format", "openai"), message, model,
                                     system_prompt, api_key, cfg.get("base_url", ""),
                                     timeout=_clamp_provider_timeout(cfg.get("timeout_seconds")))

    # API mode (Claude / Gemini / Codex) — call the HTTP API directly with the resolved key.
    if cfg.get("mode") == "api" and provider in providers.API_CAPABLE:
        api_key = resolve_provider_key(cfg)
        if provider == "claude":
            return providers.execute_claude_api(message, model, system_prompt, api_key)
        if provider == "codex":
            return providers.execute_openai_api(message, model, system_prompt, api_key)
        return providers.execute_gemini_api(message, model, system_prompt, api_key)

    # CLI mode (default for all providers). Attach MCP servers for claude.
    mcp_path, allowed_mcp = build_mcp_config_file(agent) if provider == "claude" else (None, [])
    try:
        return execute_agent(provider, message, model=model, system_prompt=system_prompt,
                             mcp_config_path=mcp_path, workdir=workdir,
                             allowed_mcp_tools=allowed_mcp)
    finally:
        if mcp_path:
            try:
                os.remove(mcp_path)
            except OSError:
                pass

@app.post("/api/chat")
def chat(req: ChatRequest):
    agent = req.agent.lower().strip()
    if agent not in ALLOWED_PROVIDERS:
        raise HTTPException(400, f"Agent must be one of: {', '.join(ALLOWED_PROVIDERS)}")

    user_msg = {
        "id": str(uuid.uuid4())[:8],
        "role": "user",
        "agent": agent,
        "content": req.message,
        "timestamp": get_timestamp(),
    }
    save_chat_message(user_msg)

    # Budget gate + metering for the legacy chat path. Chat targets a bare
    # provider (not a per-agent profile), so spend is gated against an optional
    # system-wide chat budget (settings.chat_budget) and ALWAYS metered under a
    # synthetic "__chat__" id so it appears in Cost Analytics and counts toward
    # the window — previously this path was un-gated and off-ledger entirely.
    chat_budget = load_settings().get("chat_budget") or {}
    chat_agent = {"id": "__chat__", "budget_usd": float(chat_budget.get("usd") or 0),
                  "budget_period": chat_budget.get("period") or "day"}
    allowed, spent, limit, period = budgets.check_budget(AGENT_USAGE_FILE, chat_agent)
    if not allowed:
        response_text = budgets.limit_message(spent, limit, period)
        append_audit({"action": "budget_blocked", "agent_id": "__chat__",
                      "spent": round(spent, 4), "limit": limit, "period": period})
    else:
        _exec_ctx.set({"kind": "chat", "agent_id": agent, "label": req.message[:60]})
        response_text = execute_agent(agent, req.message)
        try:
            model = get_provider_config(agent).get("default_model", "") or ""
            tin = budgets.estimate_tokens(req.message)
            tout = budgets.estimate_tokens(response_text)
            cost = budgets.estimate_cost(model, tin, tout, load_settings().get("model_prices"))
            budgets.record_usage(AGENT_USAGE_FILE, "__chat__", model, tin, tout, cost)
        except Exception:
            pass

    agent_msg = {
        "id": str(uuid.uuid4())[:8],
        "role": "assistant",
        "agent": agent,
        "content": response_text,
        "timestamp": get_timestamp(),
    }
    save_chat_message(agent_msg)

    append_audit({"action": "chat_message", "agent": agent, "msg_preview": req.message[:50]})

    return {"status": "ok", "response": agent_msg}

@app.get("/api/chat/history")
def get_chat_history():
    return load_chat_history()

# ─── Routes: Auth & Users ─────────────────────────────────────────

def bootstrap_admin():
    """First run no longer auto-creates an admin. With no users the platform
    is in OPEN mode and the dashboard shows the first-run Setup wizard, which
    POSTs to /api/setup to create the first admin in the browser. Here we just
    announce that setup is pending."""
    if auth.has_users(USERS_FILE):
        return
    print("\n" + "=" * 60)
    print(" Sentinel Agentic OS — no admin yet")
    print("   Open the dashboard to complete first-run setup.")
    print("=" * 60 + "\n", flush=True)


class SetupRequest(BaseModel):
    username: str
    password: str
    platform_name: Optional[str] = ""
    projects_root: Optional[str] = ""


@app.post("/api/setup")
def first_run_setup(data: SetupRequest, request: Request):
    """First-run bootstrap. PUBLIC but single-shot: hard-refuses once any user
    exists (so it can never be used to mint a second admin). Creates the first
    admin (no forced password change — they just chose it), saves platform
    name + projects root, and issues a session so the wizard drops straight
    into the dashboard.

    SECURITY NOTE: this path is in AUTH_PUBLIC_PATHS (skips the auth
    middleware), so the has_users() guard is the ONLY protection. That is
    sufficient because the server binds 127.0.0.1 with CORS locked to
    localhost — the only window is pre-first-user on the operator's own
    machine. If this is ever exposed on 0.0.0.0, the brief setup window
    becomes a real race and must be gated differently."""
    # Validate inputs BEFORE taking the lock (cheap rejects shouldn't serialize).
    username = data.username.strip()
    if not username:
        raise HTTPException(400, "username is required")
    if len(data.password) < 8:
        raise HTTPException(400, "password must be at least 8 characters")
    root = (data.projects_root or "").strip()
    if root:
        rp = Path(root).expanduser()
        if not rp.is_dir():
            raise HTTPException(400, f"projects root '{root}' is not an existing folder")
    # TOCTOU guard: the has_users() check and create_user() must be atomic so two
    # concurrent setup posts can't both pass the guard and mint two admins. The
    # lock is the same per-file RLock create_user takes internally (reentrant).
    with jsonstore.lock_for(USERS_FILE):
        if auth.has_users(USERS_FILE):
            raise HTTPException(403, "setup already complete — an admin account exists")
        auth.create_user(USERS_FILE, username, data.password, "admin", get_timestamp(),
                         must_change=False)
    def _apply(settings):
        if (data.platform_name or "").strip():
            settings.setdefault("platform", {})["name"] = data.platform_name.strip()
        if root:
            settings.setdefault("projects", {})["root"] = str(Path(root).expanduser())
    mutate_settings(_apply)
    token = auth.issue_token(get_jwt_secret(), username, "admin")
    resp = JSONResponse({"status": "ok", "username": username})
    resp.set_cookie(AUTH_COOKIE, token, httponly=True, samesite="lax",
                    secure=secure_cookies(request), max_age=auth.TOKEN_TTL_SECONDS)
    append_audit({"action": "platform_setup_completed", "username": username, "actor": username})
    return resp


# Brute-force throttle: per-IP failed-login tracking. Localhost-only, so this
# is a guard against a runaway script/another local process hammering login,
# not a network attacker — kept simple (in-memory, sliding window).
_login_fails: dict = {}
_login_lock = threading.Lock()
LOGIN_MAX_FAILS = 5
LOGIN_WINDOW = 300        # 5 min
LOGIN_LOCKOUT = 60        # lock the IP for 60s after MAX fails


def _login_check(ip: str):
    now = time.time()
    with _login_lock:
        rec = _login_fails.get(ip)
        if rec and rec["count"] >= LOGIN_MAX_FAILS and now - rec["first"] < LOGIN_LOCKOUT:
            return False
        return True


def _login_record_fail(ip: str):
    now = time.time()
    with _login_lock:
        rec = _login_fails.get(ip)
        if not rec or now - rec["first"] > LOGIN_WINDOW:
            _login_fails[ip] = {"count": 1, "first": now}
        else:
            rec["count"] += 1
            if rec["count"] >= LOGIN_MAX_FAILS:
                rec["first"] = now   # start the lockout window


def _login_clear(ip: str):
    with _login_lock:
        _login_fails.pop(ip, None)


@app.post("/api/auth/login")
def auth_login(data: LoginRequest, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    if not _login_check(client_ip):
        append_audit({"action": "login_throttled", "username": data.username,
                      "actor": data.username, "ip": client_ip})
        raise HTTPException(429, "Too many failed attempts — wait a minute and try again")
    user = auth.authenticate(USERS_FILE, data.username, data.password)
    if not user:
        _login_record_fail(client_ip)
        append_audit({"action": "login_failed", "username": data.username,
                      "actor": data.username, "ip": client_ip})
        raise HTTPException(401, "Invalid username or password")
    _login_clear(client_ip)
    token = auth.issue_token(get_jwt_secret(), user["username"], user.get("role", "viewer"))
    resp = JSONResponse({"user": auth.public_user(user)})
    resp.set_cookie(AUTH_COOKIE, token, httponly=True, samesite="lax",
                    secure=secure_cookies(request), max_age=auth.TOKEN_TTL_SECONDS)
    append_audit({"action": "login", "username": user["username"],
                  "actor": user["username"], "ip": client_ip,
                  "role": user.get("role", "viewer")})
    return resp


# ─── Factory reset (Danger Zone) ──────────────────────────────────

# Wiped on reset (relative to BASE_DIR): state, identity, memory, audit, agents,
# registry, and skills (Claude-mirrored ones resync on next start). data/ is
# wiped but its .master.key is preserved in place across the wipe (see
# factory_reset_wipe) so kept backups stay decryptable. backups/ is never
# touched — reset stays reversible.
FACTORY_RESET_DIRS = ("data", "brain", "audit", "skills", "agents", "registry")


def factory_reset_wipe(base_dir: Path) -> list:
    """Delete the reset target dirs under base_dir. backups/ is never touched,
    and the encryption master key (data/.master.key) is PRESERVED across the
    wipe so kept backups stay decryptable — it's read out before data/ is
    removed and rewritten (0600) afterward. Returns the paths removed. Pure
    (takes base_dir) so it's testable against a temp dir."""
    key_path = base_dir / "data" / ".master.key"
    key_bytes = key_path.read_bytes() if key_path.exists() else None
    removed = []
    for name in FACTORY_RESET_DIRS:
        d = base_dir / name
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
            removed.append(name)
    if key_bytes is not None:
        key_path.parent.mkdir(parents=True, exist_ok=True)
        key_path.write_bytes(key_bytes)
        try:
            os.chmod(key_path, 0o600)
        except OSError:
            pass
    return removed


class FactoryResetRequest(BaseModel):
    confirm: str           # must equal "RESET"
    password: str          # current admin's password, re-verified


@app.post("/api/system/factory-reset")
def factory_reset(data: FactoryResetRequest, request: Request):
    """Wipe ALL configuration back to a clean install. Guarded three ways:
    admin-only (RBAC), must type RESET, and must re-enter the current admin
    password. Takes one final automatic backup FIRST, so even this is
    reversible from backups/. After the wipe the platform has no users → the
    next dashboard load shows the first-run setup wizard."""
    user = getattr(request.state, "user", None)
    # In open mode (no users yet) there's nothing to reset.
    if not user or not auth.has_users(USERS_FILE):
        raise HTTPException(400, "nothing to reset — platform has no configuration yet")
    if data.confirm != "RESET":
        raise HTTPException(400, 'type RESET to confirm')
    if not auth.authenticate(USERS_FILE, user["username"], data.password):
        raise HTTPException(403, "password does not match — reset refused")
    # 1) final safety backup (best-effort; never blocks the reset)
    safety = None
    try:
        safety = backup_engine.create_archive(BASE_DIR, BACKUPS_DIR).name
    except Exception:
        pass
    append_audit({"action": "factory_reset", "actor": user["username"], "safety_backup": safety})
    # 2) wipe
    removed = factory_reset_wipe(BASE_DIR)
    resp = JSONResponse({"status": "reset", "removed": removed, "safety_backup": safety})
    resp.delete_cookie(AUTH_COOKIE)    # session is meaningless now
    return resp


@app.post("/api/auth/logout")
def auth_logout(request: Request):
    user = getattr(request.state, "user", None)
    append_audit({"action": "logout", "username": (user or {}).get("username", "unknown")})
    resp = JSONResponse({"status": "logged_out"})
    resp.delete_cookie(AUTH_COOKIE)
    return resp


@app.get("/api/auth/me")
def auth_me(request: Request):
    user = getattr(request.state, "user", None)
    if user:
        full = auth.find_user(USERS_FILE, user["username"])
        return {"authenticated": True, "auth_active": True, "user": auth.public_user(full or {})}
    return {"authenticated": False, "auth_active": auth.has_users(USERS_FILE), "user": None}


@app.put("/api/auth/password")
def auth_change_password(data: PasswordChange, request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Not authenticated")
    if not data.password.strip() or len(data.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    auth.set_password(USERS_FILE, user["username"], data.password)
    append_audit({"action": "password_changed", "username": user["username"]})
    return {"status": "ok"}


@app.get("/api/users")
def list_users():
    return {"users": [auth.public_user(u) for u in auth.load_users(USERS_FILE).get("users", [])]}


@app.post("/api/users")
def create_user_endpoint(data: UserCreate):
    if data.role not in auth.ROLES:
        raise HTTPException(400, f"role must be one of: {', '.join(auth.ROLES)}")
    if not data.username.strip() or len(data.password) < 6:
        raise HTTPException(400, "username required; password >= 6 chars")
    try:
        u = auth.create_user(USERS_FILE, data.username.strip(), data.password, data.role, get_timestamp())
    except ValueError as e:
        raise HTTPException(400, str(e))
    append_audit({"action": "user_created", "username": u["username"], "role": u["role"]})
    return auth.public_user(u)


@app.put("/api/users/{user_id}")
def update_user_endpoint(user_id: str, data: UserUpdate, request: Request):
    if data.password is not None:
        users = auth.load_users(USERS_FILE).get("users", [])
        target = next((u for u in users if u.get("id") == user_id), None)
        if not target:
            raise HTTPException(404, "User not found")
        if len(data.password) < 6:
            raise HTTPException(400, "Password must be >= 6 chars")
        auth.set_password(USERS_FILE, target["username"], data.password)
    try:
        u = auth.update_user(USERS_FILE, user_id, role=data.role, disabled=data.disabled)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not u:
        raise HTTPException(404, "User not found")
    append_audit({"action": "user_updated", "user_id": user_id})
    return auth.public_user(u)


@app.delete("/api/users/{user_id}")
def delete_user_endpoint(user_id: str, request: Request):
    me = getattr(request.state, "user", None)
    if me and me.get("id") == user_id:
        raise HTTPException(400, "You cannot delete your own account")
    # Don't allow deleting the last admin.
    users = auth.load_users(USERS_FILE).get("users", [])
    target = next((u for u in users if u.get("id") == user_id), None)
    if target and target.get("role") == "admin":
        admins = [u for u in users if u.get("role") == "admin" and not u.get("disabled")]
        if len(admins) <= 1:
            raise HTTPException(400, "Cannot delete the last admin")
    if not auth.delete_user(USERS_FILE, user_id):
        raise HTTPException(404, "User not found")
    append_audit({"action": "user_deleted", "user_id": user_id})
    return {"status": "deleted", "id": user_id}

# ─── Routes: Custom Agents (dynamic registry) ─────────────────────

@app.get("/api/custom-agents")
def list_custom_agents():
    return load_agents_registry()


@app.get("/api/custom-agents/usage")
def agents_usage():
    """Per-agent spend in its own budget window (estimates)."""
    out = {}
    for a in load_agents_registry().get("agents", []):
        period = a.get("budget_period") or "day"
        out[a["id"]] = {
            "spent": round(budgets.spent_in_window(AGENT_USAGE_FILE, a["id"], period), 4),
            "budget_usd": float(a.get("budget_usd") or 0),
            "period": period,
        }
    return {"usage": out}


@app.post("/api/custom-agents")
def create_custom_agent(data: CustomAgentCreate):
    if data.provider not in all_provider_names():
        raise HTTPException(400, f"provider must be one of: {', '.join(all_provider_names())}")
    if not data.name.strip():
        raise HTTPException(400, "name is required")
    reg = load_agents_registry()
    now = get_timestamp()
    agent = {
        "id": slugify_id(data.name),
        "name": data.name.strip(),
        "provider": data.provider,
        "model": data.model.strip(),
        "system_prompt": data.system_prompt,
        "skills": data.skills or [],
        "mcp_servers": data.mcp_servers or [],
        "budget_usd": max(0.0, float(data.budget_usd or 0)),
        "budget_period": data.budget_period if data.budget_period in budgets.PERIODS else "day",
        "heartbeat_seconds": agent_tasks.normalize_heartbeat(data.heartbeat_seconds),
        "created": now,
        "updated": now,
    }
    reg.setdefault("agents", []).append(agent)
    save_agents_registry(reg)
    append_audit({"action": "agent_created", "agent_id": agent["id"], "provider": agent["provider"]})
    return agent


@app.put("/api/custom-agents/{agent_id}")
def update_custom_agent(agent_id: str, data: CustomAgentUpdate):
    reg = load_agents_registry()
    agents = reg.get("agents", [])
    for a in agents:
        if a.get("id") == agent_id:
            if data.provider is not None:
                if data.provider not in all_provider_names():
                    raise HTTPException(400, f"provider must be one of: {', '.join(all_provider_names())}")
                a["provider"] = data.provider
            if data.name is not None:
                a["name"] = data.name.strip()
            if data.model is not None:
                a["model"] = data.model.strip()
            if data.system_prompt is not None:
                a["system_prompt"] = data.system_prompt
            if data.skills is not None:
                a["skills"] = data.skills
            if data.mcp_servers is not None:
                a["mcp_servers"] = data.mcp_servers
            if data.budget_usd is not None:
                a["budget_usd"] = max(0.0, float(data.budget_usd))
            if data.budget_period is not None:
                if data.budget_period not in budgets.PERIODS:
                    raise HTTPException(400, f"budget_period must be one of: {', '.join(budgets.PERIODS)}")
                a["budget_period"] = data.budget_period
            if data.heartbeat_seconds is not None:
                a["heartbeat_seconds"] = agent_tasks.normalize_heartbeat(data.heartbeat_seconds)
            a["updated"] = get_timestamp()
            save_agents_registry(reg)
            append_audit({"action": "agent_updated", "agent_id": agent_id})
            return a
    raise HTTPException(404, "Agent not found")


@app.delete("/api/custom-agents/{agent_id}")
def delete_custom_agent(agent_id: str):
    reg = load_agents_registry()
    agents = reg.get("agents", [])
    new_agents = [a for a in agents if a.get("id") != agent_id]
    if len(new_agents) == len(agents):
        raise HTTPException(404, "Agent not found")
    reg["agents"] = new_agents
    save_agents_registry(reg)
    append_audit({"action": "agent_deleted", "agent_id": agent_id})
    return {"status": "deleted", "id": agent_id}

# ─── Routes: Teams (hierarchy) ────────────────────────────────────

def _validate_hierarchy(manager_id: str, hierarchy: list):
    """Every referenced agent_id / reports_to must exist in the registry."""
    known = {a.get("id") for a in load_agents_registry().get("agents", [])}
    if manager_id not in known:
        raise HTTPException(400, f"manager_id '{manager_id}' is not a known agent")
    node_ids = set()
    for node in hierarchy or []:
        aid = node.get("agent_id")
        if aid not in known:
            raise HTTPException(400, f"hierarchy agent_id '{aid}' is not a known agent")
        node_ids.add(aid)
    for node in hierarchy or []:
        rt = node.get("reports_to")
        if rt is not None and rt not in node_ids and rt not in known:
            raise HTTPException(400, f"reports_to '{rt}' is not a known agent")


def build_delegation_chain(team: dict) -> list:
    """Order the hierarchy as a manager-led delegation chain: the manager
    first, then members ordered by their distance from the manager along
    `reports_to` edges."""
    hierarchy = team.get("hierarchy", []) or []
    by_id = {n.get("agent_id"): n for n in hierarchy}
    agent_names = {a["id"]: a.get("name", a["id"]) for a in load_agents_registry().get("agents", [])}

    def depth(node):
        d, seen, cur = 0, set(), node.get("reports_to")
        while cur and cur in by_id and cur not in seen:
            seen.add(cur)
            d += 1
            cur = by_id[cur].get("reports_to")
        return d

    ordered = sorted(hierarchy, key=lambda n: (depth(n), n.get("agent_id", "")))
    return [{
        "agent_id": n.get("agent_id"),
        "name": agent_names.get(n.get("agent_id"), n.get("agent_id")),
        "role": n.get("role", "Member"),
        "reports_to": n.get("reports_to"),
    } for n in ordered]


@app.get("/api/teams")
def list_teams():
    return load_teams()


@app.post("/api/teams")
def create_team(data: TeamCreate):
    if not data.name.strip():
        raise HTTPException(400, "name is required")
    _validate_hierarchy(data.manager_id, data.hierarchy)
    teams = load_teams()
    now = get_timestamp()
    team = {
        "id": slugify_id(data.name),
        "name": data.name.strip(),
        "manager_id": data.manager_id,
        "hierarchy": data.hierarchy or [],
        "created": now,
        "updated": now,
    }
    teams.setdefault("teams", []).append(team)
    save_teams(teams)
    append_audit({"action": "team_created", "team_id": team["id"]})
    return team


@app.put("/api/teams/{team_id}")
def update_team(team_id: str, data: TeamUpdate):
    teams = load_teams()
    for t in teams.get("teams", []):
        if t.get("id") == team_id:
            manager = data.manager_id if data.manager_id is not None else t["manager_id"]
            hierarchy = data.hierarchy if data.hierarchy is not None else t["hierarchy"]
            _validate_hierarchy(manager, hierarchy)
            if data.name is not None:
                t["name"] = data.name.strip()
            t["manager_id"] = manager
            t["hierarchy"] = hierarchy
            t["updated"] = get_timestamp()
            save_teams(teams)
            append_audit({"action": "team_updated", "team_id": team_id})
            return t
    raise HTTPException(404, "Team not found")


@app.delete("/api/teams/{team_id}")
def delete_team(team_id: str):
    teams = load_teams()
    existing = teams.get("teams", [])
    new_teams = [t for t in existing if t.get("id") != team_id]
    if len(new_teams) == len(existing):
        raise HTTPException(404, "Team not found")
    teams["teams"] = new_teams
    save_teams(teams)
    append_audit({"action": "team_deleted", "team_id": team_id})
    return {"status": "deleted", "id": team_id}

# ─── Routes: Task Dispatch ────────────────────────────────────────

@app.post("/api/tasks")
def dispatch_task(data: TaskDispatch):
    if not data.message.strip():
        raise HTTPException(400, "message is required")

    # 1) Direct single-agent dispatch (agent_id wins if both supplied).
    if data.agent_id:
        agent = get_agent_by_id(data.agent_id)
        if not agent:
            raise HTTPException(404, f"agent_id '{data.agent_id}' not found")
        result = execute_profile(agent, data.message)
        append_audit({"action": "task_dispatched", "agent_id": agent["id"]})
        scan_for_needs_input(agent, data.message, result, source="task")
        return {
            "mode": "agent",
            "agent": {"id": agent["id"], "name": agent.get("name"), "provider": agent.get("provider")},
            "result": result,
        }

    # 2) Team dispatch — manager-led with a logged delegation chain.
    if data.team_id:
        team = get_team_by_id(data.team_id)
        if not team:
            raise HTTPException(404, f"team_id '{data.team_id}' not found")
        manager = get_agent_by_id(team["manager_id"])
        if not manager:
            raise HTTPException(400, f"team manager '{team['manager_id']}' is not a known agent")
        chain = build_delegation_chain(team)
        result = execute_profile(manager, data.message)
        now = get_timestamp()
        task = {
            "id": str(uuid.uuid4())[:8],
            "title": data.title or data.message[:60],
            "body": data.message,
            "status": "in_progress",
            "priority": data.priority,
            "assignee": manager["id"],
            "team_id": team["id"],
            "delegation_chain": chain,
            "result": result,
            "comments": [],
            "links": [],
            "created": now,
            "updated": now,
        }
        save_kanban_task(task)
        scan_for_needs_input(manager, data.message, result, source="team")
        append_audit({"action": "team_task_dispatched", "team_id": team["id"], "manager_id": manager["id"]})
        return {
            "mode": "team",
            "team": {"id": team["id"], "name": team.get("name")},
            "manager": {"id": manager["id"], "name": manager.get("name")},
            "delegation_chain": chain,
            "result": result,
            "task_id": task["id"],
        }

    raise HTTPException(400, "Provide either agent_id or team_id")

# ─── Routes: Projects ──────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    path: str = ""           # real local folder the project points at (optional)
    goal: str = ""
    team_id: str = ""

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    path: Optional[str] = None
    goal: Optional[str] = None
    team_id: Optional[str] = None

class ProjectChatRequest(BaseModel):
    message: str
    agent_id: Optional[str] = None   # defaults to the team manager


def _validate_project_fields(path: str = None, team_id: str = None):
    # TRUST BOUNDARY: the project path is operator-chosen BY DESIGN and becomes
    # the agents' WORKING DIRECTORY during project tasks/chat — Claude runs
    # there with --permission-mode acceptEdits (auto-accepts file edits inside
    # --add-dir; NOT an OS sandbox), Codex under --sandbox workspace-write (a
    # real sandbox). Containment is therefore asymmetric across providers: do
    # not point projects at sensitive directories. LLM-proposed paths (the
    # orchestrator) are additionally confined to projects_root().
    if path:
        d = Path(path).expanduser()
        if not d.is_dir():
            raise HTTPException(400, f"path '{path}' is not an existing directory")
    if team_id and not get_team_by_id(team_id):
        raise HTTPException(400, f"team '{team_id}' not found")


@app.get("/api/projects")
def list_projects():
    data = load_projects()
    for pr in data.get("projects", []):
        pr["message_count"] = len(load_project_chat(pr["id"]))
    return data


@app.post("/api/projects")
def create_project(data: ProjectCreate):
    if not data.name.strip():
        raise HTTPException(400, "name is required")
    _validate_project_fields(data.path.strip(), data.team_id.strip())
    slug = "".join(c.lower() if c.isalnum() else "-" for c in data.name.strip()).strip("-") or "project"
    projects = load_projects()
    if any(pr.get("slug") == slug for pr in projects.get("projects", [])):
        raise HTTPException(400, f"project '{slug}' already exists")
    now = get_timestamp()
    project = {
        "id": str(uuid.uuid4())[:8], "slug": slug, "name": data.name.strip(),
        "path": data.path.strip(), "goal": data.goal.strip(),
        "team_id": data.team_id.strip(), "created": now, "updated": now,
    }
    projects.setdefault("projects", []).append(project)
    save_projects(projects)
    # Seed the project's scoped memory vault with its goal note.
    mem = project_memory_dir(project)
    goal_note = mem / "project-goal.md"
    if not goal_note.exists():
        goal_note.write_text(f"""---
title: {project['name']} — Goal
tags: [project, goal]
created: {now}
---

# {project['name']}

{project['goal'] or 'No goal set yet.'}
""")
    # Goal alignment: a project created with a goal also appears on the Goals
    # page as a linked, trackable goal.
    if project["goal"]:
        goals = load_goals()
        goals.append({
            "id": str(uuid.uuid4())[:8],
            "title": project["name"],
            "description": project["goal"],
            "category": "project",
            "target_date": "",
            "project_id": project["id"],
            "status": "active",
            "progress": 0,
            "created": now,
            "updated": now,
        })
        save_goals(goals)
    append_audit({"action": "project_created", "project_id": project["id"], "name": project["name"]})
    return project


@app.put("/api/projects/{project_id}")
def update_project(project_id: str, data: ProjectUpdate):
    _validate_project_fields((data.path or "").strip() or None, (data.team_id or "").strip() or None)
    projects = load_projects()
    for pr in projects.get("projects", []):
        if pr.get("id") == project_id:
            old_goal = pr.get("goal", "")
            for field in ("name", "path", "goal", "team_id"):
                val = getattr(data, field)
                if val is not None:
                    pr[field] = val.strip()
            pr["updated"] = get_timestamp()
            save_projects(projects)
            if data.goal is not None and data.goal.strip() != old_goal:
                # sync the linked goal entry + recalibrate the team's plan
                goals = load_goals()
                for g in goals:
                    if g.get("project_id") == project_id:
                        g["description"] = data.goal.strip()
                        g["updated"] = get_timestamp()
                save_goals(goals)
                trigger_goal_recalibration(pr, old_goal, data.goal.strip())
            append_audit({"action": "project_updated", "project_id": project_id})
            return pr
    raise HTTPException(404, "Project not found")


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str):
    projects = load_projects()
    items = projects.get("projects", [])
    target = next((pr for pr in items if pr.get("id") == project_id), None)
    if not target:
        raise HTTPException(404, "Project not found")
    projects["projects"] = [pr for pr in items if pr.get("id") != project_id]
    save_projects(projects)
    # Linked goals are kept but unlinked (project_id cleared) so they remain
    # visible in the Goals list rather than silently never matching a filter.
    goals = load_goals()
    unlinked = 0
    for g in goals:
        if g.get("project_id") == project_id:
            g["project_id"] = ""
            unlinked += 1
    if unlinked:
        save_goals(goals)
    # Reversible by construction: the project's memory vault and chat log stay
    # on disk (brain/projects/<slug>/, data/project_chats/) for manual recovery.
    append_audit({"action": "project_deleted", "project_id": project_id, "goals_unlinked": unlinked})
    return {"status": "deleted", "id": project_id,
            "note": f"project memory and chat history kept on disk; {unlinked} linked goal(s) unlinked"}


@app.get("/api/projects/{project_id}/chat")
def get_project_chat(project_id: str):
    if not get_project_by_id(project_id):
        raise HTTPException(404, "Project not found")
    return {"messages": load_project_chat(project_id)}


@app.post("/api/projects/{project_id}/chat")
def project_chat(project_id: str, data: ProjectChatRequest):
    """Project-scoped chat: routed to the assigned team's agents, with memory
    injection restricted to this project's vault."""
    project = get_project_by_id(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if not data.message.strip():
        raise HTTPException(400, "message is required")

    agent = get_agent_by_id(data.agent_id) if data.agent_id else None
    if data.agent_id and not agent:
        raise HTTPException(400, f"agent '{data.agent_id}' not found")
    if agent is None:
        team = get_team_by_id(project.get("team_id", ""))
        if not team:
            raise HTTPException(400, "Project has no team assigned — set one first")
        agent = get_agent_by_id(team.get("manager_id", ""))
        if not agent:
            raise HTTPException(400, "Team manager is not a known agent")

    # Project context rides in front of the agent persona for this call only.
    scoped = dict(agent)
    scoped["system_prompt"] = (project_context_prompt(project) + "\n\n"
                               + (agent.get("system_prompt") or "")).strip()
    append_project_chat(project_id, "user", data.message.strip(), agent_id=None)
    pp = (project.get("path") or "").strip()
    workdir = str(Path(pp).expanduser()) if pp and Path(pp).expanduser().is_dir() else None
    result = execute_profile(scoped, data.message.strip(),
                             memory_dir=project_memory_dir(project), workdir=workdir)
    append_project_chat(project_id, "assistant", result, agent_id=agent["id"])
    scan_for_needs_input(agent, data.message.strip(), result,
                         source="project", project_id=project_id)
    append_audit({"action": "project_chat", "project_id": project_id, "agent_id": agent["id"]})
    return {"agent": {"id": agent["id"], "name": agent.get("name")}, "result": result}

# ─── Routes: Agent task queue + runtime ────────────────────────────

class AgentTaskCreate(BaseModel):
    agent_id: str
    message: str
    title: str = ""
    project_id: Optional[str] = None
    wake: bool = True       # operator assignment wakes the agent immediately


@app.get("/api/agent-tasks")
def list_agent_tasks(agent_id: str = Query(None), project_id: str = Query(None),
                     status: str = Query(None)):
    return {"tasks": agent_tasks.tasks_for(AGENT_TASKS_FILE, agent_id, project_id, status)}


@app.post("/api/agent-tasks")
def create_agent_task(data: AgentTaskCreate):
    """Operator assignment. wake=true (default) wakes the agent NOW — but in a
    BACKGROUND thread: an LLM run takes minutes and must never hang the HTTP
    request. Poll GET /api/agent-tasks for the task's status. wake=false
    leaves it for the agent's next heartbeat."""
    if not data.message.strip():
        raise HTTPException(400, "message is required")
    agent = get_agent_by_id(data.agent_id)
    if not agent:
        raise HTTPException(404, f"agent '{data.agent_id}' not found")
    if data.project_id and not get_project_by_id(data.project_id):
        raise HTTPException(404, f"project '{data.project_id}' not found")
    task = queue_agent_task(agent, data.title, data.message.strip(),
                            project_id=data.project_id)
    if data.wake:
        threading.Thread(target=_safe_process_queue, args=(agent["id"],),
                         daemon=True).start()
    return {"task": task, "woke": bool(data.wake)}


def _safe_process_queue(agent_id: str):
    try:
        process_agent_queue(agent_id)
    except Exception:
        pass


@app.delete("/api/agent-tasks/{task_id}")
def cancel_agent_task(task_id: str):
    """queued → cancelled (kept as failed, mirrored). Terminal
    (done/failed/needs_input) → deleted from the store. running → protected."""
    t = next((t for t in agent_tasks.tasks_for(AGENT_TASKS_FILE) if t["id"] == task_id), None)
    if not t:
        raise HTTPException(404, "Task not found")
    if t.get("status") == "running":
        raise HTTPException(400, "a running task cannot be cancelled or deleted — wait for it to finish")
    if t.get("status") == "queued":
        updated = agent_tasks.set_status(AGENT_TASKS_FILE, task_id, "failed", result="cancelled by operator")
        _mirror_kanban(updated)
        append_audit({"action": "agent_task_cancelled", "task_id": task_id,
                      "agent_id": t.get("agent_id"), "title": t.get("title", "")})
        return {"status": "cancelled", "id": task_id}
    agent_tasks.delete_task(AGENT_TASKS_FILE, task_id)
    append_audit({"action": "agent_task_deleted", "task_id": task_id,
                  "agent_id": t.get("agent_id"), "title": t.get("title", ""),
                  "was_status": t.get("status")})
    return {"status": "deleted", "id": task_id}


# ─── Routes: Filesystem browse (project folder picker) ──────────

@app.get("/api/fs/dirs")
def fs_dirs(path: str = Query("")):
    """Directory listing for the project-folder Browse modal. Confined to the
    user's home directory — browsers cannot hand a web page an absolute path,
    so the server walks the tree instead. Hidden folders are excluded; files
    are not listed (we only ever pick folders)."""
    home = Path.home().resolve()
    target = (Path(path).expanduser().resolve() if path.strip() else home)
    if target != home and home not in target.parents:
        raise HTTPException(400, "browsing is confined to your home directory")
    if not target.is_dir():
        raise HTTPException(404, "not a directory")
    dirs = []
    try:
        for d in target.iterdir():
            try:
                if d.is_dir() and not d.name.startswith("."):
                    dirs.append(d.name)
            except OSError:
                continue
    except PermissionError:
        raise HTTPException(403, "permission denied")
    dirs.sort()
    return {"path": str(target),
            "parent": str(target.parent) if target != home else None,
            "dirs": dirs}


@app.post("/api/fs/pick-folder")
def fs_pick_folder():
    """Open the NATIVE macOS folder picker and return the chosen absolute
    path. Possible only because this is a localhost app — the server runs in
    the operator's own GUI session, so it can show a real Finder dialog that
    a sandboxed browser page never could. Cancelling returns status=cancelled."""
    if sys.platform != "darwin":
        raise HTTPException(501, "native folder picker is only available on macOS — type the path instead")
    script = ('POSIX path of (choose folder with prompt '
              '"Select the project folder for Sentinel Agentic OS")')
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True,
                           text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return {"status": "cancelled", "path": None}
    if r.returncode != 0:
        if "User canceled" in (r.stderr or "") or "(-128)" in (r.stderr or ""):
            return {"status": "cancelled", "path": None}
        raise HTTPException(500, (r.stderr or "folder picker failed").strip()[:200])
    path = (r.stdout or "").strip().rstrip("/")
    if not path:
        return {"status": "cancelled", "path": None}
    return {"status": "ok", "path": path}


# ─── Routes: Active Sessions (live subprocess monitor + kill switch) ──

@app.get("/api/sessions/active")
def active_sessions():
    """Live LLM subprocess runs (killable) + stranded tasks: tasks stuck in
    "running" with NO live process behind them (server restarted mid-run, or
    the process died without the worker updating state). API-mode provider
    calls are plain HTTP requests — they don't appear here and time out on
    their own."""
    live = proc_registry.list_active()
    agents = {a["id"]: a.get("name", a["id"])
              for a in load_agents_registry().get("agents", [])}
    for s in live:
        s["agent_name"] = agents.get(s.get("agent_id"), s.get("agent_id") or "—")
    live_task_ids = {s.get("task_id") for s in live if s.get("task_id")}
    stranded = [
        {"task_id": t["id"], "agent_id": t.get("agent_id"),
         "agent_name": agents.get(t.get("agent_id"), t.get("agent_id")),
         "title": t.get("title", ""),
         "since": t.get("updated_ts") or t.get("ts")}
        for t in agent_tasks.tasks_for(AGENT_TASKS_FILE, status="running")
        if t["id"] not in live_task_ids
    ]
    return {"sessions": live, "stranded": stranded}


@app.post("/api/sessions/{session_id}/kill")
def kill_session(session_id: str):
    """Terminate a hung/unwanted run: SIGTERM its whole process group, SIGKILL
    after grace. The worker thread then finishes naturally with a '⚠ killed by
    operator' result, so a linked agent task is marked failed through the
    normal pipeline — no racing double-writes on the task store."""
    s = proc_registry.kill(session_id)
    if not s:
        raise HTTPException(404, "session not found or already finished")
    append_audit({"action": "session_killed", "session_id": session_id,
                  "pid": s["pid"], "kind": s["kind"], "agent_id": s.get("agent_id"),
                  "task_id": s.get("task_id"), "label": s.get("label", "")})
    return {"status": "killed", "session": s}


@app.post("/api/agent-tasks/{task_id}/release")
def release_stranded_task(task_id: str):
    """A 'running' task with no live process is a corpse — release it to
    failed so the mirror and goal math stop counting it as in-flight."""
    t = next((t for t in agent_tasks.tasks_for(AGENT_TASKS_FILE) if t["id"] == task_id), None)
    if not t:
        raise HTTPException(404, "Task not found")
    if t.get("status") != "running":
        raise HTTPException(400, f"only running tasks can be released (status: {t['status']})")
    if any(s.get("task_id") == task_id for s in proc_registry.list_active()):
        raise HTTPException(409, "a live process is still working on this task — kill the session instead")
    updated = agent_tasks.set_status(AGENT_TASKS_FILE, task_id, "failed",
                                     result="released by operator (stranded run)")
    _mirror_kanban(updated)
    agent_tasks.mark_sleep(AGENT_TASKS_FILE, t.get("agent_id"))
    append_audit({"action": "agent_task_released", "task_id": task_id,
                  "agent_id": t.get("agent_id")})
    return {"status": "released", "id": task_id}


@app.get("/api/agents/runtime")
def agents_runtime():
    """Live sleep/wake status per agent for the dashboard."""
    agents = load_agents_registry().get("agents", [])
    return {"runtime": agent_tasks.runtime_view(AGENT_TASKS_FILE, agents)}


@app.get("/api/metrics/overview")
def metrics_overview(days: int = Query(14, ge=1, le=60)):
    """Aggregated performance metrics for the Dashboard charts — ALL derived
    from real stores (agent task queue, usage ledger, goals, kanban). Nothing
    is synthesized: empty stores yield zeros, not demo data."""
    now = time.time()
    day_secs = 86400
    # local day buckets (oldest → newest) so the x-axis reads left-to-right
    buckets = []
    for i in range(days - 1, -1, -1):
        d = datetime.fromtimestamp(now - i * day_secs)
        buckets.append(d.strftime("%Y-%m-%d"))
    idx = {label: n for n, label in enumerate(buckets)}

    def day_label(ts):
        if not ts:
            return None
        try:
            return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
        except (OSError, ValueError, OverflowError):
            return None

    # ── tasks: status breakdown + per-day done/failed throughput ──
    tasks = agent_tasks.tasks_for(AGENT_TASKS_FILE)
    status_counts = {"queued": 0, "running": 0, "done": 0, "needs_input": 0, "failed": 0}
    done_series = [0] * days
    failed_series = [0] * days
    per_agent = {}
    for t in tasks:
        st = t.get("status", "queued")
        if st in status_counts:
            status_counts[st] += 1
        ts = t.get("updated_ts") or t.get("ts")
        lbl = day_label(ts)
        if lbl in idx:
            if st == "done":
                done_series[idx[lbl]] += 1
            elif st == "failed":
                failed_series[idx[lbl]] += 1
        if st in ("done", "failed"):
            a = t.get("agent_id") or "—"
            rec = per_agent.setdefault(a, {"done": 0, "failed": 0})
            rec[st] += 1

    # ── cost + token usage per day (from the budget ledger) ──
    cost_series = [0.0] * days
    tokens_series = [0] * days
    total_cost = 0.0
    for e in budgets.load_ledger(AGENT_USAGE_FILE):
        lbl = day_label(e.get("ts"))
        c = float(e.get("cost", 0) or 0)
        total_cost += c
        if lbl in idx:
            cost_series[idx[lbl]] += c
            tokens_series[idx[lbl]] += int(e.get("tokens_in", 0) or 0) + int(e.get("tokens_out", 0) or 0)
    cost_series = [round(c, 4) for c in cost_series]

    # ── agent profiles ranked by finished tasks ──
    agent_names = {a["id"]: a.get("name", a["id"]) for a in load_agents_registry().get("agents", [])}
    top_agents = sorted(
        ({"agent": agent_names.get(aid, aid), "done": v["done"], "failed": v["failed"]}
         for aid, v in per_agent.items()),
        key=lambda r: r["done"] + r["failed"], reverse=True)[:8]

    # ── goals + projects rollup ──
    goals = [goal_task_progress(g) for g in load_goals()]
    goal_done = sum(1 for g in goals if g.get("status") == "completed")
    avg_goal = round(sum(g.get("progress", 0) for g in goals) / len(goals)) if goals else 0
    projects = load_projects().get("projects", [])

    terminal = status_counts["done"] + status_counts["failed"]
    return {
        "days": buckets,
        "summary": {
            "projects": len(projects),
            "goals": len(goals),
            "goals_completed": goal_done,
            "avg_goal_progress": avg_goal,
            "tasks_total": len(tasks),
            "tasks_done": status_counts["done"],
            "tasks_failed": status_counts["failed"],
            "success_rate": round(100 * status_counts["done"] / terminal) if terminal else None,
            "total_cost": round(total_cost, 4),
        },
        "task_status": status_counts,
        "throughput": {"done": done_series, "failed": failed_series},
        "cost": cost_series,
        "tokens": tokens_series,
        "top_agents": top_agents,
    }

# ─── Routes: Orchestrator (chat message → project + team + tasks) ──

class OrchestrateRequest(BaseModel):
    message: str


ORCHESTRATE_PROMPT = """You are the orchestrator of a multi-agent OS. Parse the user's request into a plan.

Available agents (id | name | provider):
{agents}

Existing teams (id | name | manager):
{teams}

Respond with ONLY a JSON object (no prose, no code fences):
{{
  "project_name": "...",                     // short name
  "goal": "...",                             // one-paragraph goal incl. concrete acceptance criteria
  "folder_path": "..." or "",                // absolute path if the user named one, else ""
  "team_id": "..." or "",                    // reuse an existing team id if one clearly fits, else ""
  "new_team": {{                             // only when team_id is ""
    "name": "...",
    "manager_id": "<agent id for the lead>",
    "members": [{{"agent_id": "...", "role": "..."}}]   // 2-4 members incl. the lead
  }},
  "first_task": {{"title": "...", "message": "..."}}    // the kickoff task for the Lead; tell the
                                             // Lead to delegate implementation/review to members
}}

User request:
{message}"""


def projects_root() -> Path:
    """Root under which the ORCHESTRATOR may create project folders
    (LLM-proposed paths are confined here; operator-created projects may point
    anywhere by design). Configurable via settings.json -> projects.root."""
    cfg = (load_settings().get("projects") or {}).get("root")
    if cfg:
        return Path(cfg).expanduser().resolve()
    return BASE_DIR.parent.parent.resolve()


@app.post("/api/orchestrate")
def orchestrate(data: OrchestrateRequest):
    """One chat message → project + team + first task queued to the Lead
    (picked up by its heartbeat within seconds)."""
    if not data.message.strip():
        raise HTTPException(400, "message is required")
    agents = load_agents_registry().get("agents", [])
    teams = load_teams().get("teams", [])
    prompt = ORCHESTRATE_PROMPT.format(
        agents="\n".join(f"{a['id']} | {a.get('name')} | {a.get('provider')}" for a in agents),
        teams="\n".join(f"{t['id']} | {t.get('name')} | {t.get('manager_id')}" for t in teams) or "(none)",
        message=data.message.strip())
    planner = get_agent_by_id("claude_default") or (agents[0] if agents else None)
    if not planner:
        raise HTTPException(400, "No agents available to plan with")
    raw = execute_profile({**planner, "system_prompt": "You output only valid JSON."}, prompt)
    try:
        plan = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
    except Exception:
        raise HTTPException(502, f"Planner returned unparseable output: {raw[:300]}")

    # 1) team — reuse or create
    team = get_team_by_id(plan.get("team_id") or "")
    if plan.get("team_id") and not team:
        append_audit({"action": "orchestrate_unknown_team", "team_id": plan["team_id"]})
    if not team and plan.get("new_team"):
        nt = plan["new_team"]
        members = [m for m in nt.get("members", []) if get_agent_by_id(m.get("agent_id"))]
        if not get_agent_by_id(nt.get("manager_id")) or not members:
            raise HTTPException(502, "Planner proposed unknown agents for the team")
        hierarchy = [{"agent_id": m["agent_id"],
                      "reports_to": None if m["agent_id"] == nt["manager_id"] else nt["manager_id"],
                      "role": m.get("role", "Member")} for m in members]
        if not any(h["agent_id"] == nt["manager_id"] for h in hierarchy):
            hierarchy.insert(0, {"agent_id": nt["manager_id"], "reports_to": None, "role": "Lead"})
        teams_data = load_teams()
        team = {"id": slugify_id(nt.get("name", "team")), "name": nt.get("name", "Team"),
                "manager_id": nt["manager_id"], "hierarchy": hierarchy,
                "created": get_timestamp(), "updated": get_timestamp()}
        teams_data.setdefault("teams", []).append(team)
        save_teams(teams_data)
    if not team:
        raise HTTPException(502, "Planner produced no usable team")

    # 2) project folder — LLM-proposed paths are CONFINED to projects_root():
    # the planner parses free text, so an injected/typo'd absolute path must
    # never create directories outside the configured root.
    folder = (plan.get("folder_path") or "").strip()
    if folder:
        resolved = Path(folder).expanduser().resolve()
        root = projects_root()
        if resolved != root and root not in resolved.parents:
            raise HTTPException(400, f"planner proposed a folder outside the projects root "
                                     f"({root}) — create the project manually if intended: {resolved}")
        resolved.mkdir(parents=True, exist_ok=True)
        folder = str(resolved)
    project = create_project(ProjectCreate(
        name=plan.get("project_name", "Untitled Project"),
        path=folder, goal=plan.get("goal", ""), team_id=team["id"]))

    # 3) kickoff task → queued for the Lead; its heartbeat picks it up
    ft = plan.get("first_task") or {}
    lead = get_agent_by_id(team["manager_id"])
    task = queue_agent_task(lead, ft.get("title", "Kick off"),
                            ft.get("message", data.message.strip()),
                            project_id=project["id"], created_by="orchestrator")
    append_audit({"action": "orchestrated", "project_id": project["id"], "team_id": team["id"]})
    return {"project": project, "team": {"id": team["id"], "name": team["name"]},
            "task": task,
            "summary": (f"Project “{project['name']}” created with team “{team['name']}” "
                        f"({len(team['hierarchy'])} members). Kickoff task queued to the Lead — "
                        f"it will wake on its next heartbeat, delegate to the team, and progress "
                        f"appears in the Dashboard Projects section, Kanban, and your Inbox.")}

# ─── Routes: Inbox (agents waiting for a human reply) ─────────────

class InboxReply(BaseModel):
    message: str


@app.get("/api/inbox")
def list_inbox(include_answered: bool = Query(False)):
    items = load_inbox().get("items", [])
    if not include_answered:
        items = [i for i in items if i.get("status") == "waiting"]
    return {"items": sorted(items, key=lambda i: i.get("created", ""), reverse=True)}


@app.get("/api/inbox/count")
def inbox_count():
    return {"count": sum(1 for i in load_inbox().get("items", [])
                         if i.get("status") == "waiting")}


@app.post("/api/inbox/{item_id}/reply")
def reply_inbox(item_id: str, data: InboxReply):
    """Close the loop: the user's answer is re-dispatched to the same agent
    together with the original context; the item is marked answered."""
    if not data.message.strip():
        raise HTTPException(400, "message is required")
    box = load_inbox()
    item = next((i for i in box.get("items", []) if i.get("id") == item_id), None)
    if not item:
        raise HTTPException(404, "Inbox item not found")
    if item.get("status") != "waiting":
        raise HTTPException(400, "Item is already answered")
    agent = get_agent_by_id(item.get("agent_id"))
    if not agent:
        raise HTTPException(400, f"agent '{item.get('agent_id')}' no longer exists")
    followup = (f"Earlier you were asked:\n{item.get('message', '')}\n\n"
                f"You replied and asked the human:\n{item.get('question', '')}\n\n"
                f"The human's answer is:\n{data.message.strip()}\n\n"
                f"Continue the task with this information.")
    memory_dir = None
    if item.get("project_id"):
        proj = get_project_by_id(item["project_id"])
        if proj:
            memory_dir = project_memory_dir(proj)
    result = execute_profile(agent, followup, memory_dir=memory_dir)
    item["status"] = "answered"
    item["reply"] = data.message.strip()
    item["followup_result"] = result
    item["answered"] = get_timestamp()
    save_inbox(box)
    # a follow-up may itself need input again
    scan_for_needs_input(agent, followup, result,
                         source=item.get("source", "task"), project_id=item.get("project_id"))
    if item.get("project_id"):
        append_project_chat(item["project_id"], "user", data.message.strip(), agent_id=None)
        append_project_chat(item["project_id"], "assistant", result, agent_id=agent["id"])
    append_audit({"action": "inbox_replied", "id": item_id, "agent_id": agent["id"]})
    return {"status": "answered", "result": result}


@app.delete("/api/inbox/{item_id}")
def dismiss_inbox(item_id: str):
    box = load_inbox()
    items = box.get("items", [])
    new_items = [i for i in items if i.get("id") != item_id]
    if len(new_items) == len(items):
        raise HTTPException(404, "Inbox item not found")
    box["items"] = new_items
    save_inbox(box)
    append_audit({"action": "inbox_dismissed", "id": item_id})
    return {"status": "dismissed", "id": item_id}

# ─── Routes: Providers (CLI ↔ API mode + secrets) ─────────────────

@app.get("/api/providers")
def list_providers():
    """Return each provider's config + whether a key is available. Key material
    is NEVER returned — only a boolean. Built-ins first, then customs."""
    out = []
    customs = custom_provider_records()
    for name in all_provider_names():
        cfg = get_provider_config(name)
        is_custom = name in customs
        out.append({
            "name": name,
            "label": cfg.get("label", "") or name,
            "mode": cfg.get("mode", "cli"),
            "default_model": cfg.get("default_model", ""),
            "key_ref": cfg.get("key_ref", ""),
            "key_set": resolve_provider_key(cfg) is not None,
            "api_capable": is_custom or name in providers.API_CAPABLE,
            "custom": is_custom,
            "enabled": bool(cfg.get("enabled", True)),
            "api_format": cfg.get("api_format", "openai") if is_custom else "",
            "base_url": cfg.get("base_url", "") if is_custom else "",
            "cli_template": cfg.get("cli_template", "") if is_custom else "",
            "key_optional": bool(cfg.get("key_optional")) if is_custom else False,
            "timeout_seconds": _clamp_provider_timeout(cfg.get("timeout_seconds")) if is_custom else None,
        })
    return {"providers": out}


PROVIDER_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,29}$")

# HTTP timeout bounds for custom providers — local CPU models are slow (raise
# it), but a runaway request must never hold a worker for more than 20 min.
PROVIDER_TIMEOUT_DEFAULT = 120
PROVIDER_TIMEOUT_MIN, PROVIDER_TIMEOUT_MAX = 10, 1200


def _clamp_provider_timeout(value) -> int:
    try:
        return max(PROVIDER_TIMEOUT_MIN, min(PROVIDER_TIMEOUT_MAX, int(value)))
    except (TypeError, ValueError):
        return PROVIDER_TIMEOUT_DEFAULT


@app.get("/api/providers/catalog")
def provider_catalog():
    """Predefined Add-Provider presets, minus ones already registered."""
    taken = set(all_provider_names())
    return {"catalog": [c for c in providers.PROVIDER_CATALOG if c["name"] not in taken]}


@app.post("/api/providers")
def create_provider(data: ProviderCreate):
    """Add a CUSTOM provider (API-only) — a data-only operation. Built-in
    engines stay code-backed; ChatGPT/Antigravity remain excluded by the
    overlap rule (see providers.EXCLUDED_PROVIDERS)."""
    name = data.name.strip().lower()
    if not PROVIDER_SLUG_RE.match(name):
        raise HTTPException(400, "name must be a slug: lowercase letters/digits/_/-, 2-30 chars")
    if name in providers.EXCLUDED_PROVIDERS:
        raise HTTPException(400, f"'{name}' is deliberately excluded: {providers.EXCLUDED_PROVIDERS[name]}")
    if name in all_provider_names():
        raise HTTPException(400, f"provider '{name}' already exists")
    if data.mode not in ("api", "cli"):
        raise HTTPException(400, "mode must be 'api' (token) or 'cli'")
    if data.mode == "cli" and "{prompt}" not in data.cli_template:
        raise HTTPException(400, "cli mode needs a cli_template containing {prompt}")
    if data.api_format not in providers.API_FORMATS:
        raise HTTPException(400, f"api_format must be one of: {', '.join(providers.API_FORMATS)}")
    if data.key_ref and not data.key_ref.startswith(("env:", "secret:")):
        raise HTTPException(400, "key_ref must start with 'env:' or 'secret:'")
    set_provider_config(name, {
        "custom": True, "enabled": True, "mode": data.mode,
        "label": data.label.strip() or name,
        "api_format": data.api_format,
        "base_url": data.base_url.strip(),
        "default_model": data.default_model.strip(),
        "key_ref": data.key_ref.strip(),
        "cli_template": data.cli_template.strip(),
        "key_optional": bool(data.key_optional),
        "timeout_seconds": _clamp_provider_timeout(data.timeout_seconds),
    })
    append_audit({"action": "provider_created", "provider": name})
    return {"status": "ok", "name": name}


@app.delete("/api/providers/{name}")
def delete_provider(name: str):
    """Delete a CUSTOM provider. Built-ins can only be deactivated. Blocked
    while agent profiles still reference it (reversible-by-construction)."""
    if name in providers.ALLOWED_PROVIDERS:
        raise HTTPException(400, f"'{name}' is a built-in engine — deactivate it instead of deleting")
    if name not in custom_provider_records():
        raise HTTPException(404, "Unknown provider")
    users_of = [a.get("name") for a in load_agents_registry().get("agents", [])
                if a.get("provider") == name]
    if users_of:
        raise HTTPException(400, f"provider '{name}' is used by {len(users_of)} agent(s): "
                                 f"{', '.join(users_of[:5])} — reassign or delete them first")
    mutate_settings(lambda s: (s.get("providers") or {}).pop(name, None))
    secrets_store.delete_secret(SECRETS_FILE, f"provider_{name}")
    append_audit({"action": "provider_deleted", "provider": name})
    return {"status": "deleted", "name": name}


@app.post("/api/providers/{name}/toggle")
def toggle_provider(name: str):
    """Activate/deactivate any provider (built-in or custom)."""
    if name not in all_provider_names():
        raise HTTPException(404, "Unknown provider")
    enabled = not get_provider_config(name).get("enabled", True)
    set_provider_config(name, {"enabled": enabled})
    append_audit({"action": "provider_toggled", "provider": name, "enabled": enabled})
    return {"name": name, "enabled": enabled}


@app.put("/api/providers/{name}")
def update_provider(name: str, data: ProviderConfigUpdate):
    if name not in all_provider_names():
        raise HTTPException(404, "Unknown provider")
    is_custom = name in custom_provider_records()
    if data.mode is not None and data.mode not in ("cli", "api"):
        raise HTTPException(400, "mode must be 'cli' or 'api'")
    if data.mode == "api" and not is_custom and name not in providers.API_CAPABLE:
        raise HTTPException(400, f"API mode is not available for '{name}'")
    if data.api_format is not None and data.api_format not in providers.API_FORMATS:
        raise HTTPException(400, f"api_format must be one of: {', '.join(providers.API_FORMATS)}")
    if data.key_ref is not None and data.key_ref and not (
        data.key_ref.startswith("env:") or data.key_ref.startswith("secret:")):
        raise HTTPException(400, "key_ref must start with 'env:' or 'secret:'")
    patch = {"mode": data.mode, "default_model": data.default_model, "key_ref": data.key_ref}
    if is_custom:
        patch.update({"label": data.label, "api_format": data.api_format,
                      "base_url": data.base_url, "cli_template": data.cli_template,
                      "key_optional": data.key_optional,
                      "timeout_seconds": _clamp_provider_timeout(data.timeout_seconds)
                                         if data.timeout_seconds is not None else None})
        # Effective-config check: switching to (or staying in) cli mode requires
        # a usable template — mirror the create_provider rule.
        cur = get_provider_config(name)
        eff_mode = data.mode if data.mode is not None else cur.get("mode", "api")
        eff_tpl = data.cli_template if data.cli_template is not None else cur.get("cli_template", "")
        if eff_mode == "cli" and "{prompt}" not in (eff_tpl or ""):
            raise HTTPException(400, "cli mode needs a cli_template containing {prompt}")
    set_provider_config(name, patch)
    append_audit({"action": "provider_updated", "provider": name})
    cfg = get_provider_config(name)
    return {"name": name, "mode": cfg.get("mode"), "default_model": cfg.get("default_model"),
            "key_ref": cfg.get("key_ref"), "key_set": resolve_provider_key(cfg) is not None}


@app.post("/api/providers/{name}/secret")
def set_provider_secret(name: str, data: ProviderSecretSet):
    if name not in all_provider_names():
        raise HTTPException(404, "Unknown provider")
    if not data.value.strip():
        raise HTTPException(400, "value is required")
    secret_name = f"provider_{name}"
    secrets_store.set_secret(SECRETS_FILE, get_master_key(), secret_name, data.value.strip())
    # Point the provider at the encrypted secret.
    set_provider_config(name, {"key_ref": f"secret:{secret_name}"})
    append_audit({"action": "provider_secret_set", "provider": name})  # value never logged
    return {"status": "ok", "name": name, "key_set": True}


@app.get("/api/providers/{name}/models")
def provider_models(name: str):
    """Model discovery: list what the provider's endpoint actually serves.
    For a local Ollama this is the set of INSTALLED models (GET /v1/models),
    so the operator picks from reality instead of typing names blind. Only
    openai-format custom providers — others answer honestly with 400."""
    if name not in custom_provider_records():
        raise HTTPException(404, "Unknown custom provider")
    cfg = get_provider_config(name)
    key = resolve_provider_key(cfg) or ("not-required" if cfg.get("key_optional") else "")
    try:
        models = providers.list_models(cfg.get("api_format", "openai"),
                                       cfg.get("base_url", ""), key)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"could not reach {cfg.get('base_url', '(no url)')}: {str(e)[:200]}")
    return {"name": name, "models": models, "count": len(models)}


@app.post("/api/providers/{name}/test")
def test_provider(name: str):
    if name not in all_provider_names():
        raise HTTPException(404, "Unknown provider")
    cfg = get_provider_config(name)
    mode = cfg.get("mode", "cli")
    if not cfg.get("enabled", True):
        return {"ok": False, "mode": mode, "detail": "Provider is disabled."}
    if cfg.get("custom"):
        if cfg.get("mode") == "cli":
            status = check_agent(name)["status"]
            return {"ok": status == "online", "mode": "cli", "detail": f"CLI status: {status}"}
        key = resolve_provider_key(cfg)
        if not key:
            if not cfg.get("key_optional"):
                return {"ok": False, "mode": "api", "detail": "No API key configured."}
            key = "not-required"   # local endpoints (Ollama/LM Studio) ignore auth
        out = providers.execute_api(cfg.get("api_format", "openai"), "ping",
                                    cfg.get("default_model", ""), "", key,
                                    cfg.get("base_url", ""), timeout=30)
        ok = not out.lstrip().startswith(("**", "\u26a0", "Claude API error", "Gemini API error", "OpenAI API error"))
        return {"ok": ok, "mode": "api", "detail": out[:300]}
    if mode == "api" and name in providers.API_CAPABLE:
        key = resolve_provider_key(cfg)
        if not key:
            return {"ok": False, "mode": mode, "detail": "No API key configured."}
        if name == "claude":
            out = providers.execute_claude_api("ping", cfg.get("default_model", ""), "", key, timeout=30, max_tokens=16)
        elif name == "codex":
            out = providers.execute_openai_api("ping", cfg.get("default_model", ""), "", key, timeout=30, max_tokens=16)
        else:
            out = providers.execute_gemini_api("ping", cfg.get("default_model", ""), "", key, timeout=30)
        ok = not out.lstrip().startswith(("**", "⚠", "Claude API error", "Gemini API error", "OpenAI API error"))
        return {"ok": ok, "mode": mode, "detail": out[:300]}
    # CLI mode — report discovery status.
    status = check_agent(name)["status"]
    return {"ok": status == "online", "mode": mode, "detail": f"CLI status: {status}"}

# ─── Routes: MCP servers ──────────────────────────────────────────

@app.get("/api/mcp/servers")
def list_mcp_servers():
    return mcp_registry.load(MCP_SERVERS_FILE)


@app.post("/api/mcp/servers")
def create_mcp_server(data: McpServerCreate):
    if data.transport not in mcp_registry.TRANSPORTS:
        raise HTTPException(400, f"transport must be one of: {', '.join(mcp_registry.TRANSPORTS)}")
    if not data.name.strip():
        raise HTTPException(400, "name is required")
    server = mcp_registry.normalize_server({**data.model_dump(), "source": "manual"})
    reg = mcp_registry.load(MCP_SERVERS_FILE)
    reg.setdefault("servers", []).append(server)
    mcp_registry.save(MCP_SERVERS_FILE, reg)
    append_audit({"action": "mcp_server_created", "name": server["name"]})
    return server


@app.put("/api/mcp/servers/{server_id}")
def update_mcp_server(server_id: str, data: McpServerUpdate):
    reg = mcp_registry.load(MCP_SERVERS_FILE)
    for i, s in enumerate(reg.get("servers", [])):
        if s.get("id") == server_id:
            patch = {k: v for k, v in data.model_dump().items() if v is not None}
            if "transport" in patch and patch["transport"] not in mcp_registry.TRANSPORTS:
                raise HTTPException(400, "invalid transport")
            s.update(patch)
            reg["servers"][i] = s
            mcp_registry.save(MCP_SERVERS_FILE, reg)
            append_audit({"action": "mcp_server_updated", "id": server_id})
            return s
    raise HTTPException(404, "MCP server not found")


@app.delete("/api/mcp/servers/{server_id}")
def delete_mcp_server(server_id: str):
    reg = mcp_registry.load(MCP_SERVERS_FILE)
    servers = reg.get("servers", [])
    new = [s for s in servers if s.get("id") != server_id]
    if len(new) == len(servers):
        raise HTTPException(404, "MCP server not found")
    reg["servers"] = new
    mcp_registry.save(MCP_SERVERS_FILE, reg)
    append_audit({"action": "mcp_server_deleted", "id": server_id})
    return {"status": "deleted", "id": server_id}


@app.post("/api/mcp/servers/{server_id}/toggle")
def toggle_mcp_server(server_id: str):
    reg = mcp_registry.load(MCP_SERVERS_FILE)
    for s in reg.get("servers", []):
        if s.get("id") == server_id:
            s["enabled"] = not s.get("enabled", True)
            mcp_registry.save(MCP_SERVERS_FILE, reg)
            return {"id": server_id, "enabled": s["enabled"]}
    raise HTTPException(404, "MCP server not found")

# ─── Routes: Claude global mirroring (automatic + manual) ─────────

CLAUDE_AGENTS_DIR = Path.home() / ".claude" / "agents"
CLAUDE_SKILLS_DIR = Path.home() / ".claude" / "skills"
CLAUDE_MCP_CONFIGS = [
    Path.home() / ".claude.json",
    Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json",
]
PROJECT_SKILLS_DIR = BASE_DIR / "skills"


def run_claude_sync(do_agents=True, do_skills=True, do_mcp=True) -> dict:
    """Mirror global Claude subagents, skills, and MCP servers. Non-destructive
    upserts; returns a per-category summary."""
    now = get_timestamp()
    out = {}
    if do_agents:
        out["agents"] = claude_sync.mirror_agents(
            CLAUDE_AGENTS_DIR, AGENTS_REGISTRY_FILE, DEFAULT_CLAUDE_MODEL, now)
    if do_skills:
        out["skills"] = claude_sync.mirror_skills(CLAUDE_SKILLS_DIR, PROJECT_SKILLS_DIR, now)
    if do_mcp:
        servers = claude_sync.extract_mcp_servers(CLAUDE_MCP_CONFIGS)
        out["mcp"] = claude_sync.mirror_mcp(servers, MCP_SERVERS_FILE)
    # record last-sync marker in settings (ticker-side write — lock vs operator edits)
    def _mark(settings):
        mirror = settings.get("mirror") or {}
        mirror["last_sync"] = now
        mirror["last_summary"] = out
        settings["mirror"] = mirror
    mutate_settings(_mark)
    append_audit({"action": "claude_sync", "summary": out})
    return out


@app.post("/api/sync/claude")
def sync_claude():
    return {"status": "ok", "summary": run_claude_sync()}


@app.post("/api/custom-agents/mirror")
def mirror_agents_only():
    return {"status": "ok", "summary": run_claude_sync(do_agents=True, do_skills=False, do_mcp=False)}


@app.post("/api/skills/mirror")
def mirror_skills_only():
    return {"status": "ok", "summary": run_claude_sync(do_agents=False, do_skills=True, do_mcp=False)}


@app.post("/api/mcp/mirror")
def mirror_mcp_only():
    return {"status": "ok", "summary": run_claude_sync(do_agents=False, do_skills=False, do_mcp=True)}


@app.get("/api/sync/status")
def sync_status():
    mirror = load_settings().get("mirror") or {}
    return {
        "auto_sync": mirror.get("auto_sync", True),
        "interval_minutes": mirror.get("interval_minutes", 10),
        "last_sync": mirror.get("last_sync"),
        "last_summary": mirror.get("last_summary", {}),
    }

# ═══════════════════════════════════════════════════════════════════
# v0.2.0 — New Feature Endpoints
# ═══════════════════════════════════════════════════════════════════

# ─── Models ─────────────────────────────────────────────────────

class KanbanTaskCreate(BaseModel):
    title: str
    body: str = ""
    status: str = "triage"
    priority: str = "medium"
    assignee: str = ""
    team_id: str = ""
    project_id: str = ""

class KanbanTaskUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    assignee: Optional[str] = None
    team_id: Optional[str] = None
    project_id: Optional[str] = None

class KanbanComplete(BaseModel):
    summary: str = ""

class KanbanBlock(BaseModel):
    reason: str = ""

class KanbanCommentCreate(BaseModel):
    message: str

class KanbanLinkCreate(BaseModel):
    parent_id: str
    child_id: str

class GoalCreate(BaseModel):
    title: str
    description: str = ""
    category: str = "general"
    target_date: str = ""
    project_id: str = ""           # align a goal to a project (optional)

class GoalUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    target_date: Optional[str] = None
    progress: Optional[int] = None
    status: Optional[str] = None
    project_id: Optional[str] = None

class JournalSave(BaseModel):
    content: str

class RouterSuggest(BaseModel):
    task: str

class RouterRoute(BaseModel):
    task: str
    agent_id: str
    title: str = ""
    project_id: Optional[str] = None
    wake: bool = True

# ─── Data Helpers ───────────────────────────────────────────────

KANBAN_DIR = BASE_DIR / "data" / "kanban"
# The board renders exactly these columns; a card whose status is none of them
# is created/moved but never shown → it silently vanishes. Validate against this.
KANBAN_COLUMNS = ("triage", "todo", "ready", "in_progress", "blocked", "done")
GOALS_FILE = BASE_DIR / "data" / "goals.json"
# Journal lives inside the configurable memory vault — see journal_dir().

def ensure_dir(d: Path):
    d.mkdir(parents=True, exist_ok=True)

def load_kanban_tasks():
    ensure_dir(KANBAN_DIR)
    tasks = []
    for f in sorted(KANBAN_DIR.glob("*.json")):
        # a single corrupt card must not 500 the whole board/goals — skip it
        card = jsonstore.read_json(f, None)
        if card:
            tasks.append(card)
    return tasks

def save_kanban_task(task: dict):
    ensure_dir(KANBAN_DIR)
    jsonstore.atomic_write_json(KANBAN_DIR / f"{task['id']}.json", task)

def load_goals():
    return jsonstore.read_json(GOALS_FILE, [])

def save_goals(goals: list):
    jsonstore.atomic_write_json(GOALS_FILE, goals)

# ─── Routes: Kanban Board (13 endpoints) ────────────────────────

@app.get("/api/kanban/board")
def kanban_board(status: Optional[str] = None, team_id: Optional[str] = None,
                 project_id: Optional[str] = None):
    try:
        tasks = load_kanban_tasks()
        if status:
            tasks = [t for t in tasks if t.get("status") == status]
        if project_id:
            tasks = [t for t in tasks if t.get("project_id") == project_id]
        if team_id:
            team = get_team_by_id(team_id)
            members = {n.get("agent_id") for n in (team or {}).get("hierarchy", [])}
            if team:
                members.add(team.get("manager_id"))
            tasks = [t for t in tasks
                     if t.get("team_id") == team_id or t.get("assignee") in members]
        columns = {c: [] for c in KANBAN_COLUMNS}
        for t in tasks:
            s = t.get("status", "triage")
            if s in columns:
                columns[s].append(t)
        return {"columns": columns, "total": len(tasks)}
    except Exception as e:
        return {"error": str(e), "columns": {}, "total": 0}

@app.get("/api/kanban/tasks/{task_id}")
def kanban_get_task(task_id: str):
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    return json.loads(path.read_text())

@app.post("/api/kanban/tasks")
def kanban_create_task(data: KanbanTaskCreate):
    if data.project_id and not get_project_by_id(data.project_id):
        raise HTTPException(404, f"project '{data.project_id}' not found")
    if data.status not in KANBAN_COLUMNS:
        raise HTTPException(400, f"status must be one of {KANBAN_COLUMNS}")
    try:
        task = {
            "id": str(uuid.uuid4())[:8],
            "title": data.title,
            "body": data.body,
            "status": data.status,
            "priority": data.priority,
            "assignee": data.assignee,
            "team_id": data.team_id,
            "project_id": data.project_id,
            "comments": [],
            "links": [],
            "created": get_timestamp(),
            "updated": get_timestamp(),
        }
        save_kanban_task(task)
        append_audit({"action": "kanban_task_created", "title": data.title})
        return task
    except Exception as e:
        raise HTTPException(500, str(e))

@app.patch("/api/kanban/tasks/{task_id}")
def kanban_update_task(task_id: str, data: KanbanTaskUpdate):
    # project re-alignment: explicit "" clears the link; unknown project → 404
    if data.project_id and not get_project_by_id(data.project_id):
        raise HTTPException(404, f"project '{data.project_id}' not found")
    # reject a move to a non-existent column so the card can't vanish from the board
    if data.status is not None and data.status not in KANBAN_COLUMNS:
        raise HTTPException(400, f"status must be one of {KANBAN_COLUMNS}")
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    for field in ["title", "body", "status", "priority", "assignee", "team_id", "project_id"]:
        val = getattr(data, field, None)
        if val is not None:
            task[field] = val
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    append_audit({"action": "kanban_task_updated", "task_id": task_id})
    return task

@app.post("/api/kanban/tasks/{task_id}/complete")
def kanban_complete_task(task_id: str, data: KanbanComplete):
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    task["status"] = "done"
    task["summary"] = data.summary
    task["completed_at"] = get_timestamp()
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    append_audit({"action": "kanban_task_completed", "task_id": task_id})
    return task

@app.post("/api/kanban/tasks/{task_id}/block")
def kanban_block_task(task_id: str, data: KanbanBlock):
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    task["status"] = "blocked"
    task["block_reason"] = data.reason
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    append_audit({"action": "kanban_task_blocked", "task_id": task_id})
    return task

@app.post("/api/kanban/tasks/{task_id}/unblock")
def kanban_unblock_task(task_id: str):
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    task["status"] = "ready"
    task["block_reason"] = ""
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    append_audit({"action": "kanban_task_unblocked", "task_id": task_id})
    return task

@app.post("/api/kanban/tasks/{task_id}/comments")
def kanban_add_comment(task_id: str, data: KanbanCommentCreate):
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    comment = {
        "id": str(uuid.uuid4())[:8],
        "message": data.message,
        "timestamp": get_timestamp(),
    }
    task.setdefault("comments", []).append(comment)
    task["updated"] = get_timestamp()
    save_kanban_task(task)
    return task

@app.post("/api/kanban/links")
def kanban_add_link(data: KanbanLinkCreate):
    for tid in [data.parent_id, data.child_id]:
        path = KANBAN_DIR / f"{tid}.json"
        if not path.exists():
            raise HTTPException(404, f"Task {tid} not found")
        t = json.loads(path.read_text())
        t.setdefault("links", [])
        link = {"parent": data.parent_id, "child": data.child_id}
        if link not in t["links"]:
            t["links"].append(link)
        t["updated"] = get_timestamp()
        save_kanban_task(t)
    append_audit({"action": "kanban_link_added", "parent": data.parent_id, "child": data.child_id})
    return {"status": "linked"}

@app.delete("/api/kanban/links")
def kanban_remove_link(parent_id: str = Query(...), child_id: str = Query(...)):
    for tid in [parent_id, child_id]:
        path = KANBAN_DIR / f"{tid}.json"
        if path.exists():
            t = json.loads(path.read_text())
            t.setdefault("links", [])
            t["links"] = [l for l in t["links"] if not (l.get("parent") == parent_id and l.get("child") == child_id)]
            t["updated"] = get_timestamp()
            save_kanban_task(t)
    return {"status": "unlinked"}

@app.delete("/api/kanban/tasks/{task_id}")
def kanban_delete_task(task_id: str):
    """Delete a card. Refused while an agent run is open on it — cancel that
    first. Terminal linked queue tasks are unlinked (kept for history/cost),
    and links on other cards pointing here are pruned."""
    path = safe_join(KANBAN_DIR, f"{task_id}.json")
    if not path.exists():
        raise HTTPException(404, "Task not found")
    open_runs = [t for t in agent_tasks.tasks_for(AGENT_TASKS_FILE)
                 if t.get("kanban_id") == task_id and t.get("status") in ("queued", "running")]
    if open_runs:
        raise HTTPException(409, f"an agent is on this card "
                                 f"(task {open_runs[0]['id']}, status {open_runs[0]['status']}) — "
                                 f"cancel it first")
    card = json.loads(path.read_text())
    agent_tasks.unlink_kanban(AGENT_TASKS_FILE, task_id)
    path.unlink()
    # prune dangling links on other cards
    for f in KANBAN_DIR.glob("*.json"):
        try:
            t = json.loads(f.read_text())
        except Exception:
            continue
        links = t.get("links") or []
        kept = [l for l in links if task_id not in (l.get("parent"), l.get("child"))]
        if len(kept) != len(links):
            t["links"] = kept
            save_kanban_task(t)
    append_audit({"action": "kanban_task_deleted", "task_id": task_id,
                  "title": card.get("title", "")})
    return {"status": "deleted", "id": task_id}


class KanbanAssignAgent(BaseModel):
    agent_id: str
    wake: bool = True


@app.post("/api/kanban/tasks/{task_id}/assign-agent")
def kanban_assign_agent(task_id: str, data: KanbanAssignAgent):
    """(Re)dispatch an existing Kanban card to an agent. The queue task is
    LINKED to this card (no duplicate mirror) and the agent is woken in the
    background (wake=true) or left for its heartbeat."""
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    agent = get_agent_by_id(data.agent_id)
    if not agent:
        raise HTTPException(404, f"agent '{data.agent_id}' not found")
    # Dedup guard: one open run per card — a second dispatch (double-click,
    # impatience) must not spawn parallel agents on the same work.
    open_runs = [t for t in agent_tasks.tasks_for(AGENT_TASKS_FILE)
                 if t.get("kanban_id") == task_id and t.get("status") in ("queued", "running")]
    if open_runs:
        raise HTTPException(409, f"an agent is already on this card "
                                 f"(task {open_runs[0]['id']}, status {open_runs[0]['status']}) — "
                                 f"wait for it to finish or cancel it first")
    card = json.loads(path.read_text())
    message = (card.get("body") or "").strip() or card.get("title", "")
    task = agent_tasks.enqueue(AGENT_TASKS_FILE, agent["id"], card.get("title", ""),
                               message, project_id=card.get("project_id") or None,
                               created_by="kanban-edit", kanban_id=card["id"])
    card["assignee"] = agent["id"]
    card["status"] = "todo"
    card["updated"] = get_timestamp()
    save_kanban_task(card)
    if data.wake:
        threading.Thread(target=_safe_process_queue, args=(agent["id"],),
                         daemon=True).start()
    append_audit({"action": "kanban_assigned_to_agent", "task_id": task_id,
                  "agent_id": agent["id"], "woke": bool(data.wake)})
    return {"task": task, "woke": bool(data.wake)}


@app.post("/api/kanban/dispatch")
def kanban_dispatch():
    append_audit({"action": "kanban_dispatch_triggered"})
    return {"status": "dispatch_triggered", "message": "Dispatcher notified"}

@app.post("/api/kanban/tasks/{task_id}/specify")
def kanban_specify_task(task_id: str):
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    if task.get("status") == "triage":
        task["status"] = "todo"
        task["updated"] = get_timestamp()
        save_kanban_task(task)
    return task

@app.post("/api/kanban/tasks/{task_id}/decompose")
def kanban_decompose_task(task_id: str):
    path = KANBAN_DIR / f"{task_id}.json"
    if not path.exists():
        raise HTTPException(404, "Task not found")
    task = json.loads(path.read_text())
    # Idempotent on re-run: a child already exists for a subtask line if some
    # card carries a parent-link to this task whose body matches the line. Only
    # NEW lines get a child, so decomposing twice never duplicates.
    existing = [t for t in load_kanban_tasks()
                if any(l.get("parent") == task_id for l in (t.get("links") or []))]
    already = {t.get("body", "").strip() for t in existing}
    child_links = task.get("links") or []
    existing_child_ids = {l.get("child") for l in child_links if l.get("child")}
    children = []
    for subtask in task.get("body", "").split("\n"):
        subtask = subtask.strip().lstrip("-* ").strip()
        if not subtask or subtask in already:
            continue
        already.add(subtask)
        child = {
            "id": str(uuid.uuid4())[:8],
            "title": subtask[:80],
            "body": subtask,
            "status": "todo",
            "priority": task.get("priority", "medium"),
            "assignee": "",
            "project_id": task.get("project_id", ""),
            "team_id": task.get("team_id", ""),
            "comments": [],
            "links": [{"parent": task_id, "child": ""}],
            "created": get_timestamp(),
            "updated": get_timestamp(),
        }
        child["links"][0]["child"] = child["id"]
        save_kanban_task(child)
        children.append(child)
        # record the parent → child link on the parent card too
        if child["id"] not in existing_child_ids:
            child_links.append({"parent": task_id, "child": child["id"]})
            existing_child_ids.add(child["id"])
    if children:
        task["links"] = child_links
        task["updated"] = get_timestamp()
        save_kanban_task(task)
    append_audit({"action": "kanban_task_decomposed", "task_id": task_id,
                  "new_children": len(children)})
    return {"parent": task_id, "children": children}

# ─── Routes: Goals (4 endpoints) ─────────────────────────────────

def trigger_goal_recalibration(project: dict, old_goal: str, new_goal: str):
    """A changed goal wakes nobody by itself — it queues a recalibration task
    for the project's team Lead, picked up on the Lead's next heartbeat. The
    Lead reviews open work against the new goal and re-delegates as needed."""
    team = get_team_by_id((project or {}).get("team_id", ""))
    lead = get_agent_by_id(team.get("manager_id", "")) if team else None
    if not lead:
        return None
    open_tasks = [t for t in agent_tasks.tasks_for(AGENT_TASKS_FILE, project_id=project["id"])
                  if t.get("status") in ("queued", "running", "needs_input")]
    listing = "\n".join(f"- [{t['status']}] {t['title']} (assignee: {t['agent_id']})"
                         for t in open_tasks) or "(no open tasks)"
    msg = (f"The goal of project “{project.get('name')}” has CHANGED.\n\n"
           f"Previous goal:\n{old_goal or '(none)'}\n\nNew goal:\n{new_goal}\n\n"
           f"Open tasks right now:\n{listing}\n\n"
           f"As the team Lead, recalibrate the plan: decide which open tasks are "
           f"still valid, which need changing, and what new work is required. "
           f"Delegate adjusted/new subtasks to your team members with the "
           f"delegation protocol. If a human decision is required, use [NEEDS_INPUT].")
    task = queue_agent_task(lead, f"Recalibrate: goal changed for {project.get('name')}",
                            msg, project_id=project["id"], created_by="goal-change")
    append_audit({"action": "goal_recalibration_queued", "project_id": project["id"],
                  "task_id": task["id"]})
    return task


def goal_task_progress(goal: dict) -> dict:
    """For project-linked goals, progress is DERIVED from the project's task
    counts: only cards with status == "done" count toward progress, over a total
    that excludes "failed" cards. Manual progress still applies to unlinked goals
    or projects with no tasks yet."""
    pid = goal.get("project_id")
    if not pid:
        return goal
    tasks = [t for t in load_kanban_tasks() if t.get("project_id") == pid
             and t.get("status") != "failed"]
    if not tasks:
        return goal
    done = sum(1 for t in tasks if t.get("status") == "done")   # ONLY Done counts
    goal = dict(goal)
    goal["task_total"] = len(tasks)
    goal["task_done"] = done
    goal["progress"] = round(done * 100 / len(tasks))
    if goal["progress"] >= 100 and goal.get("status") == "active":
        goal["status"] = "completed"   # derived, read-only — never persisted
    return goal


@app.get("/api/goals")
def list_goals(project_id: Optional[str] = None):
    try:
        goals = [goal_task_progress(g) for g in load_goals()]
        if project_id:
            goals = [g for g in goals if g.get("project_id") == project_id]
        return {"goals": goals}
    except Exception as e:
        return {"goals": [], "error": str(e)}

@app.post("/api/goals")
def create_goal(data: GoalCreate):
    if data.project_id and not get_project_by_id(data.project_id):
        raise HTTPException(404, f"project '{data.project_id}' not found")
    try:
        goals = load_goals()
        goal = {
            "id": str(uuid.uuid4())[:8],
            "title": data.title,
            "description": data.description,
            "category": data.category,
            "target_date": data.target_date,
            "project_id": data.project_id,
            "status": "active",
            "progress": 0,
            "created": get_timestamp(),
            "updated": get_timestamp(),
        }
        goals.append(goal)
        save_goals(goals)
        # Auto-sync to brain/active-projects.md
        active_path = BASE_DIR / "brain" / "active-projects.md"
        if active_path.exists():
            existing = active_path.read_text()
            existing += f"\n- [{goal['title']}](goal:{goal['id']}) — {goal['description'][:80]}\n"
            active_path.write_text(existing)
        append_audit({"action": "goal_created", "title": data.title})
        return goal
    except Exception as e:
        raise HTTPException(500, str(e))

@app.put("/api/goals/{goal_id}")
def update_goal(goal_id: str, data: GoalUpdate):
    if data.project_id and not get_project_by_id(data.project_id):
        raise HTTPException(404, f"project '{data.project_id}' not found")
    try:
        goals = load_goals()
        for g in goals:
            if g["id"] == goal_id:
                old_desc = g.get("description", "")
                for field in ["title", "description", "category", "target_date", "progress", "status", "project_id"]:
                    val = getattr(data, field, None)
                    if val is not None:
                        g[field] = val
                # Goal change on a project-linked goal: keep project.goal in
                # sync and queue a Lead recalibration of the open tasks.
                if (data.description is not None and data.description != old_desc
                        and g.get("project_id")):
                    project = get_project_by_id(g["project_id"])
                    if project:
                        projects = load_projects()
                        for pr in projects.get("projects", []):
                            if pr["id"] == project["id"]:
                                pr["goal"] = data.description
                                pr["updated"] = get_timestamp()
                        save_projects(projects)
                        trigger_goal_recalibration(project, old_desc, data.description)
                g["updated"] = get_timestamp()
                save_goals(goals)
                append_audit({"action": "goal_updated", "goal_id": goal_id,
                              "title": g.get("title", "")})
                return g
        raise HTTPException(404, "Goal not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))

@app.delete("/api/goals/{goal_id}")
def delete_goal(goal_id: str):
    try:
        goals = load_goals()
        goals = [g for g in goals if g["id"] != goal_id]
        save_goals(goals)
        append_audit({"action": "goal_deleted", "goal_id": goal_id})
        return {"status": "deleted"}
    except Exception as e:
        raise HTTPException(500, str(e))

# ─── Routes: Journal (4 endpoints) ───────────────────────────────

@app.get("/api/journal/entries")
def list_journal_entries():
    try:
        ensure_dir(journal_dir())
        entries = []
        for f in sorted(journal_dir().glob("*.md"), reverse=True):
            entries.append({
                "date": f.stem,
                "preview": f.read_text()[:200],
                "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
            })
        return {"entries": entries}
    except Exception as e:
        return {"entries": [], "error": str(e)}

@app.get("/api/journal/entries/{entry_date}")
def get_journal_entry(entry_date: str):
    try:
        ensure_dir(journal_dir())
        path = safe_join(journal_dir(), f"{entry_date}.md")
        content = path.read_text() if path.exists() else ""
        return {"date": entry_date, "content": content}
    except Exception as e:
        return {"date": entry_date, "content": "", "error": str(e)}

@app.put("/api/journal/entries/{entry_date}")
def save_journal_entry(entry_date: str, data: JournalSave):
    try:
        ensure_dir(journal_dir())
        path = safe_join(journal_dir(), f"{entry_date}.md")
        path.write_text(data.content)
        append_audit({"action": "journal_saved", "date": entry_date})
        return {"status": "saved", "date": entry_date}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.get("/api/journal/search")
def search_journal(q: str = Query("")):
    try:
        ensure_dir(journal_dir())
        if not q:
            return {"results": []}
        results = []
        for f in journal_dir().glob("*.md"):
            content = f.read_text()
            if q.lower() in content.lower():
                results.append({"date": f.stem, "preview": content[:200]})
        return {"results": results, "query": q}
    except Exception as e:
        return {"results": [], "error": str(e)}

# ─── Routes: Agent Health (3 endpoints) ──────────────────────────

@app.get("/api/agents/health")
def get_agent_health():
    """Two honest layers: provider reachability (is the engine CLI/API there?)
    and agent profiles' live runtime — state, queue, task success, budget."""
    try:
        providers_health = [check_agent(name) for name in enabled_provider_names()]
        agents = load_agents_registry().get("agents", [])
        runtime = agent_tasks.runtime_view(AGENT_TASKS_FILE, agents)
        all_tasks = agent_tasks.tasks_for(AGENT_TASKS_FILE)
        out = []
        for a in agents:
            mine = [t for t in all_tasks if t.get("agent_id") == a["id"]]
            done = sum(1 for t in mine if t.get("status") == "done")
            failed = sum(1 for t in mine if t.get("status") == "failed")
            terminal = done + failed
            period = a.get("budget_period") or "day"
            rt = runtime.get(a["id"], {})
            out.append({
                "id": a["id"], "name": a.get("name", a["id"]),
                "provider": a.get("provider", ""), "model": a.get("model", ""),
                "state": rt.get("state", "sleeping"),
                "queued": rt.get("queued", 0),
                "waiting_input": rt.get("waiting_input", 0),
                "heartbeat_seconds": rt.get("heartbeat_seconds"),
                "next_wake_in": rt.get("next_wake_in"),
                "last_wake": rt.get("last_wake"),
                "tasks_done": done, "tasks_failed": failed,
                "success_rate": round(100 * done / terminal) if terminal else None,
                "spent": round(budgets.spent_in_window(AGENT_USAGE_FILE, a["id"], period), 4),
                "budget_usd": float(a.get("budget_usd") or 0),
                "budget_period": period,
            })
        return {"providers": providers_health, "agents": out, "updated": get_timestamp()}
    except Exception as e:
        return {"providers": [], "agents": [], "error": str(e), "updated": get_timestamp()}


@app.post("/api/agents/{agent_id}/wake")
def wake_agent(agent_id: str):
    """Operator-forced wake: drain the agent's queue NOW in a background
    thread, regardless of its heartbeat. No queued work → nothing happens."""
    agent = get_agent_by_id(agent_id)
    if not agent:
        raise HTTPException(404, f"agent '{agent_id}' not found")
    queued = agent_tasks.tasks_for(AGENT_TASKS_FILE, agent_id=agent_id, status="queued")
    threading.Thread(target=_safe_process_queue, args=(agent_id,), daemon=True).start()
    append_audit({"action": "agent_woken", "agent_id": agent_id, "queued": len(queued)})
    return {"status": "woken", "agent_id": agent_id, "queued": len(queued)}

# ─── Routes: Smart Router ────────────────────────────────────────
# Scores YOUR agent profiles (skill tags, persona, track record, budget
# headroom) instead of hardcoded provider buckets, and "route" actually
# enqueues the task into the winner's queue.

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9_-]{2,}")


def score_agents_for_task(task: str) -> list:
    """Rank agent profiles for a task. Transparent additive scoring:
    skill-tag hit ×3, persona keyword hit ×1 (capped 5), track record ±2,
    budget exhausted −10 (effectively last). Returns ranked rows w/ reasons."""
    words = set(_WORD_RE.findall(task.lower()))
    agents = load_agents_registry().get("agents", [])
    all_tasks = agent_tasks.tasks_for(AGENT_TASKS_FILE)
    rows = []
    for a in agents:
        reasons = []
        score = 0.0
        tags = [str(t).lower() for t in (a.get("skills") or [])]
        tag_hits = [t for t in tags if t in words or any(t in w for w in words)]
        if tag_hits:
            score += 3 * len(tag_hits)
            reasons.append(f"skill match: {', '.join(tag_hits)}")
        persona_words = set(_WORD_RE.findall((a.get("system_prompt") or "").lower()))
        overlap = len(words & persona_words)
        if overlap:
            bonus = min(5, overlap)
            score += bonus
            reasons.append(f"persona overlap: {overlap} terms")
        mine = [t for t in all_tasks if t.get("agent_id") == a["id"]]
        done = sum(1 for t in mine if t.get("status") == "done")
        failed = sum(1 for t in mine if t.get("status") == "failed")
        if done + failed >= 3:
            rate = done / (done + failed)
            score += (rate - 0.5) * 4   # ±2
            reasons.append(f"track record: {round(rate * 100)}% over {done + failed} tasks")
        allowed, spent, limit, period = budgets.check_budget(AGENT_USAGE_FILE, a)
        if not allowed:
            score -= 10
            reasons.append(f"budget exhausted (${spent:.2f}/${limit:.2f}/{period})")
        rows.append({"agent_id": a["id"], "name": a.get("name", a["id"]),
                     "provider": a.get("provider", ""), "score": round(score, 2),
                     "reasons": reasons, "budget_ok": allowed})
    rows.sort(key=lambda r: r["score"], reverse=True)
    return rows


@app.post("/api/router/suggest")
def router_suggest(data: RouterSuggest):
    if not data.task.strip():
        raise HTTPException(400, "task is required")
    ranked = score_agents_for_task(data.task)
    if not ranked:
        return {"suggested": None, "ranking": [], "confidence": "none",
                "message": "no agent profiles exist yet"}
    best = ranked[0]
    spread = best["score"] - (ranked[1]["score"] if len(ranked) > 1 else 0)
    confidence = ("high" if best["score"] >= 3 and spread >= 2
                  else "medium" if best["score"] > 0 else "low")
    return {"suggested": best, "ranking": ranked, "confidence": confidence}


@app.post("/api/router/route")
def router_route(data: RouterRoute):
    """Routing IS dispatch: the task lands in the agent's queue (+ Kanban
    mirror) and the agent is optionally woken immediately."""
    if not data.task.strip():
        raise HTTPException(400, "task is required")
    agent = get_agent_by_id(data.agent_id)
    if not agent:
        raise HTTPException(404, f"agent '{data.agent_id}' not found")
    if data.project_id and not get_project_by_id(data.project_id):
        raise HTTPException(404, f"project '{data.project_id}' not found")
    task = queue_agent_task(agent, data.title or data.task[:60], data.task,
                            project_id=data.project_id, created_by="router")
    if data.wake:
        threading.Thread(target=_safe_process_queue, args=(agent["id"],),
                         daemon=True).start()
    append_audit({"action": "task_routed", "agent_id": agent["id"],
                  "task_id": task["id"], "woke": bool(data.wake),
                  "task_preview": data.task[:50]})
    return {"status": "routed", "task": task, "agent_id": agent["id"],
            "woke": bool(data.wake),
            "message": f"Task queued for {agent.get('name', agent['id'])}"}

# ─── Routes: Self-learning (agent lessons) ──────────────────────

@app.get("/api/learning/agents")
def learning_agents():
    """Per-agent self-learning view: extracted lessons + task track record."""
    agents = load_agents_registry().get("agents", [])
    all_tasks = agent_tasks.tasks_for(AGENT_TASKS_FILE)
    out = []
    for a in agents:
        text = learning.read_all(learning.learnings_path(get_vault_dir(), a["id"]))
        mine = [t for t in all_tasks if t.get("agent_id") == a["id"]
                and t.get("status") in ("done", "failed")]
        mine.sort(key=lambda t: t.get("updated_ts") or t.get("ts", 0))
        out.append({
            "id": a["id"], "name": a.get("name", a["id"]),
            "provider": a.get("provider", ""),
            "learnings": text,
            "lesson_count": sum(1 for l in text.splitlines() if l.startswith("- ")),
            "reflection_count": sum(1 for l in text.splitlines() if l.startswith("## ")),
            "tasks_done": sum(1 for t in mine if t["status"] == "done"),
            "tasks_failed": sum(1 for t in mine if t["status"] == "failed"),
            "recent_outcomes": [t["status"] for t in mine[-10:]],
        })
    return {"agents": out, "enabled": learning_enabled()}


@app.post("/api/learning/toggle")
def learning_toggle():
    settings = load_settings()
    cur = bool(settings.get("learning", {}).get("enabled", True))
    mutate_settings(lambda s: s.setdefault("learning", {}).update({"enabled": not cur}))
    append_audit({"action": "learning_toggled", "enabled": not cur})
    return {"enabled": not cur}


# ─── Routes: Learning Analytics (2 endpoints) ───────────────────

@app.get("/api/analytics/skills")
def get_skill_analytics():
    try:
        skills_dir = BASE_DIR / "skills"
        analytics = []
        for d in sorted(skills_dir.iterdir()):
            if d.is_dir() and not d.name.startswith("_"):
                eval_path = d / "eval.json"
                score_path = d / "score-history.json"
                scores = json.loads(score_path.read_text()) if score_path.exists() else []
                eval_data = json.loads(eval_path.read_text()) if eval_path.exists() else {}
                avg_score = sum(s.get("score", 0) for s in scores) / len(scores) if scores else 0
                analytics.append({
                    "name": d.name,
                    "total_runs": len(scores),
                    "avg_score": round(avg_score, 1),
                    "last_score": scores[-1].get("score", 0) if scores else 0,
                    "trend": "up" if len(scores) >= 2 and scores[-1].get("score", 0) > scores[-2].get("score", 0) else "down" if len(scores) >= 2 else "stable",
                })
        return {"skills": sorted(analytics, key=lambda x: x["total_runs"], reverse=True)}
    except Exception as e:
        return {"skills": [], "error": str(e)}

@app.get("/api/analytics/trends")
def get_trend_analytics():
    try:
        skills_dir = BASE_DIR / "skills"
        trends = []
        for d in sorted(skills_dir.iterdir()):
            if d.is_dir() and not d.name.startswith("_"):
                score_path = d / "score-history.json"
                scores = json.loads(score_path.read_text()) if score_path.exists() else []
                if scores:
                    trends.append({
                        "name": d.name,
                        "scores": [s.get("score", 0) for s in scores[-10:]],
                        "labels": [s.get("date", "") for s in scores[-10:]],
                    })
        return {"trends": trends}
    except Exception as e:
        return {"trends": [], "error": str(e)}

# ─── Routes: Dashboard Static Files ──────────────────────────────

dashboard_dir = BASE_DIR / "dashboard"
if dashboard_dir.exists():
    app.mount("/dashboard", StaticFiles(directory=str(dashboard_dir)), name="dashboard")

@app.get("/api/health")
def health():
    """Liveness/readiness probe — public, no auth. Reports the heartbeat
    scheduler state and whether setup is complete, so a supervisor can detect
    a wedged process or a fresh (unconfigured) install."""
    sched_running = bool(_scheduler and getattr(_scheduler, "running", False))
    return {
        "status": "ok",
        "scheduler_running": sched_running,
        "setup_complete": auth.has_users(USERS_FILE),
        "time": get_timestamp(),
    }


@app.get("/", response_class=HTMLResponse)
def index():
    html_file = BASE_DIR / "dashboard" / "index.html"
    if html_file.exists():
        content = html_file.read_text()
        content = content.replace('href="styles.css"', 'href="/dashboard/styles.css"')
        content = content.replace('src="utils.js"', 'src="/dashboard/utils.js"')
        content = content.replace('src="api.js"', 'src="/dashboard/api.js"')
        content = content.replace('src="app.js"', 'src="/dashboard/app.js"')
        content = content.replace('pages/', '/dashboard/pages/')
        return HTMLResponse(content=content)
    return HTMLResponse("<h1>Sentinel Agentic OS</h1><p>Dashboard not built yet. Run <code>./install.sh</code> first.</p>")

# ─── Favicon ──────────────────────────────────────────────────────

FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6c5ce7"/><stop offset="100%" stop-color="#fd79a8"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><polygon points="16,6 24,11 24,21 16,26 8,21 8,11" fill="none" stroke="white" stroke-width="2" stroke-linejoin="round"/><circle cx="16" cy="16" r="3" fill="white"/></svg>'

@app.get("/favicon.ico")
def favicon():
    return Response(content=FAVICON_SVG, media_type="image/svg+xml")

@app.get("/favicon.svg")
def favicon_svg():
    return Response(content=FAVICON_SVG, media_type="image/svg+xml")

# ─── Auto-sync scheduler (mirror global Claude → here) ────────────

_scheduler = None


def _safe_sync():
    try:
        run_claude_sync()
    except Exception:
        pass


def reschedule_claude_sync(mirror: dict):
    """Apply mirror.auto_sync / mirror.interval_minutes to the running
    scheduler so Settings changes take effect without a restart."""
    global _scheduler
    try:
        if not mirror.get("auto_sync", True):
            if _scheduler:
                try:
                    _scheduler.remove_job("claude_sync")
                except Exception:
                    pass
            return
        interval = int(mirror.get("interval_minutes", 10) or 10)
        if _scheduler is None:
            from apscheduler.schedulers.background import BackgroundScheduler
            _scheduler = BackgroundScheduler(daemon=True)
            _scheduler.start()
        _scheduler.add_job(_safe_sync, "interval", minutes=max(1, interval), id="claude_sync",
                           replace_existing=True)
    except Exception:
        pass


@app.on_event("startup")
def _on_startup():
    """Bootstrap the admin account, start the heartbeat ticker (always on —
    a no-op scan when no queue has work), then schedule Claude mirroring."""
    global _scheduler
    try:
        bootstrap_admin()
    except Exception as e:
        print(f"[auth] bootstrap skipped: {e}", flush=True)
    try:
        if _scheduler is None:
            from apscheduler.schedulers.background import BackgroundScheduler
            _scheduler = BackgroundScheduler(daemon=True)
            _scheduler.start()
        _scheduler.add_job(_heartbeat_tick, "interval", seconds=15,
                           id="agent_heartbeat", replace_existing=True)
    except Exception:
        pass
    try:
        rec = agent_tasks.recover(AGENT_TASKS_FILE)
        if rec["requeued"] or rec["released"]:
            append_audit({"action": "runtime_recovered", **rec})
            print(f"[heartbeat] recovered after restart: requeued={rec['requeued']} "
                  f"released={rec['released']}", flush=True)
        # reconcile kanban mirrors with current task states (restarts can
        # interrupt a mirror write)
        for t in agent_tasks.tasks_for(AGENT_TASKS_FILE):
            _mirror_kanban(t)
    except Exception:
        pass
    mirror = load_settings().get("mirror") or {}
    if not mirror.get("auto_sync", True):
        return
    _safe_sync()
    reschedule_claude_sync(mirror)

# ─── Main ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("\n" + "!" * 70)
        print("WARNING: binding a NON-LOOPBACK interface (%s)." % args.host)
        print("Sentinel's threat model is single-user localhost. Exposing it on a")
        print("routable interface makes the pre-setup window (no admin yet) and the")
        print("dashboard reachable from the network. If this is intentional:")
        print("  - set AGENTIC_OS_ALLOWED_HOSTS to your served hostname(s)/IP(s),")
        print("  - put it behind TLS + an authenticating reverse proxy,")
        print("  - complete first-run setup IMMEDIATELY (the setup endpoint is public).")
        print("!" * 70 + "\n")
    uvicorn.run(app, host=args.host, port=args.port)
