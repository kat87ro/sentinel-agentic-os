"""Authentication + RBAC primitives.

Users live in a gitignored JSON store, passwords hashed with argon2. Sessions
are signed JWTs (HS256) using a server master secret. Three roles:
``viewer`` < ``operator`` < ``admin``.

Pure functions take explicit ``path`` / ``secret`` so they are testable.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Optional

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHash

import jsonstore

_ph = PasswordHasher()

ROLES = ("viewer", "operator", "admin")
RANKS = {"viewer": 0, "operator": 1, "admin": 2}
TOKEN_TTL_SECONDS = 12 * 3600


# ─── password hashing ─────────────────────────────────────────────

def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _ph.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHash, Exception):
        return False


# ─── user store ───────────────────────────────────────────────────

def load_users(path: Path) -> dict:
    # .bak-recovering read — a torn users.json must never lock everyone out
    return jsonstore.read_json(path, {"users": []})


def save_users(path: Path, data: dict):
    jsonstore.atomic_write_json(path, data)   # atomic: a crash can't corrupt accounts
    try:
        Path(path).chmod(0o600)
    except OSError:
        pass


def has_users(path: Path) -> bool:
    return len(load_users(path).get("users", [])) > 0


def find_user(path: Path, username: str):
    for u in load_users(path).get("users", []):
        if u.get("username") == username:
            return u
    return None


def create_user(path: Path, username: str, password: str, role: str, now_iso: str,
                must_change: bool = False) -> dict:
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    # RMW under the file lock so concurrent creates can't both pass the
    # duplicate check and append (or clobber each other's write).
    with jsonstore.lock_for(path):
        data = load_users(path)
        if any(u.get("username") == username for u in data.get("users", [])):
            raise ValueError("username already exists")
        user = {
            "id": uuid.uuid4().hex[:8],
            "username": username,
            "password_hash": hash_password(password),
            "role": role,
            "disabled": False,
            "must_change": must_change,
            "created": now_iso,
        }
        data.setdefault("users", []).append(user)
        save_users(path, data)
        return user


def set_password(path: Path, username: str, password: str) -> bool:
    data = load_users(path)
    for u in data.get("users", []):
        if u.get("username") == username:
            u["password_hash"] = hash_password(password)
            u["must_change"] = False
            save_users(path, data)
            return True
    return False


def update_user(path: Path, user_id: str, role: str = None, disabled: bool = None) -> Optional[dict]:
    data = load_users(path)
    for u in data.get("users", []):
        if u.get("id") == user_id:
            if role is not None:
                if role not in ROLES:
                    raise ValueError("invalid role")
                u["role"] = role
            if disabled is not None:
                u["disabled"] = bool(disabled)
            save_users(path, data)
            return u
    return None


def delete_user(path: Path, user_id: str) -> bool:
    data = load_users(path)
    users = data.get("users", [])
    new = [u for u in users if u.get("id") != user_id]
    if len(new) == len(users):
        return False
    data["users"] = new
    save_users(path, data)
    return True


def public_user(u: dict) -> dict:
    """User view without the password hash."""
    return {k: v for k, v in u.items() if k != "password_hash"}


def authenticate(path: Path, username: str, password: str):
    u = find_user(path, username)
    if not u or u.get("disabled"):
        return None
    if not verify_password(u.get("password_hash", ""), password):
        return None
    return u


# ─── JWT sessions ─────────────────────────────────────────────────

def issue_token(secret: str, username: str, role: str, now: int = None, ttl: int = TOKEN_TTL_SECONDS) -> str:
    now = int(now if now is not None else time.time())
    payload = {"sub": username, "role": role, "iat": now, "exp": now + ttl}
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_token(secret: str, token: str):
    try:
        return jwt.decode(token, secret, algorithms=["HS256"])
    except Exception:
        return None


# ─── authorization policy ─────────────────────────────────────────

def authorize(role: str, method: str, path: str) -> bool:
    """Central RBAC policy.
      - admin: everything
      - operator: read everything + run/dispatch work writes
      - viewer: read-only
    Admin-only areas (any method): users, providers, sync, and any /mirror route.
    Management writes (agents/teams/mcp/settings/memory-config/learning-toggle/
    backup) require admin — learning.toggle adds a metered LLM call to every
    settled task system-wide, which is a cost decision, not a work action.
    Work writes (tasks/chat/kanban/goals/journal/skills run/standards) require operator.
    """
    rank = RANKS.get(role, 0)
    # admin-only areas, regardless of method
    if path.startswith(("/api/users", "/api/providers", "/api/sync")) or path.endswith("/mirror"):
        return rank >= 2
    if method in ("POST", "PUT", "PATCH", "DELETE"):
        if path.startswith(("/api/settings", "/api/memory/config", "/api/backup",
                            "/api/custom-agents", "/api/teams", "/api/mcp",
                            "/api/learning/toggle", "/api/system", "/api/plugins")):
            return rank >= 2          # management writes → admin
        return rank >= 1             # work writes → operator+
    return True                      # reads → any authenticated user
