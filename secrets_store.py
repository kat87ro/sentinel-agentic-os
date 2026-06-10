"""Encrypted-at-rest secret storage.

Secrets (API keys) live in a gitignored JSON file, each value encrypted with
Fernet. The Fernet key is derived from a master secret (``AGENTIC_OS_SECRET_KEY``
env, or an auto-generated per-install key file). Values are decrypted only
in-process at call time and are never logged or returned by any GET endpoint —
callers use :func:`list_secret_names` to show "set / not set" without exposing
material.

All functions take explicit ``path`` / ``master_key`` so they are pure and
testable against a temp directory.
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken


def _fernet(master_key: str) -> Fernet:
    """Derive a stable urlsafe-base64 Fernet key from any master secret string."""
    digest = hashlib.sha256((master_key or "").encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _load(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return {"secrets": {}}
    return {"secrets": {}}


def _save(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))
    try:
        path.chmod(0o600)
    except OSError:
        pass


def set_secret(path: Path, master_key: str, name: str, value: str) -> None:
    data = _load(path)
    token = _fernet(master_key).encrypt((value or "").encode("utf-8")).decode("ascii")
    data.setdefault("secrets", {})[name] = token
    _save(path, data)


def get_secret(path: Path, master_key: str, name: str) -> Optional[str]:
    token = _load(path).get("secrets", {}).get(name)
    if not token:
        return None
    try:
        return _fernet(master_key).decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None


def delete_secret(path: Path, name: str) -> bool:
    data = _load(path)
    if name in data.get("secrets", {}):
        del data["secrets"][name]
        _save(path, data)
        return True
    return False


def list_secret_names(path: Path) -> list:
    return sorted(_load(path).get("secrets", {}).keys())
