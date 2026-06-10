"""Backup / restore engine.

A backup is a single ``.tar.gz`` of the platform's STATE — config, memory,
skills, agents, registries, standards, prompts, audit — optionally including
the actual project workspace folders. The encryption master key is NEVER
included (a leaked backup must not also leak the secrets it can decrypt);
same-machine restores are unaffected, cross-machine restores re-enter provider
keys once.

Destinations (a backup can fan out to several):
  - local : copy the archive into a chosen folder
  - git   : commit + push the archive to a configured git repo
  - scp   : copy to host:path over SSH (keys must already be set up)

Restore extracts a chosen archive back over BASE_DIR with the usual archive-
member safety checks. Scheduling reuses the existing schedules.py engine via a
dedicated agent-less tick in server.py.

Pure helpers take explicit paths so they are testable against temp dirs;
network/process side effects (git, scp) are isolated in run-* functions that
server.py drives.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import time
from datetime import datetime
from pathlib import Path

# State dirs always included, relative to BASE_DIR. (Project workspaces are
# OUTSIDE base and added separately when requested.)
STATE_DIRS = ("data", "brain", "skills", "agents", "registry", "standards", "prompts", "audit")

# Never archive these — secrets/keys and volatile junk.
EXCLUDE_NAMES = {".master.key", ".DS_Store", "__pycache__", ".corrupt", ".tmp", ".bak"}

DEST_TYPES = ("local", "git", "scp")


def _filter(tarinfo: "tarfile.TarInfo"):
    base = os.path.basename(tarinfo.name)
    if base in EXCLUDE_NAMES or base.endswith((".corrupt", ".tmp", ".bak")):
        return None
    return tarinfo


def create_archive(base_dir: Path, out_dir: Path, *, include_workspaces: bool = False,
                   project_paths: list | None = None, now: float | None = None) -> Path:
    """Write a timestamped .tar.gz of platform state into out_dir and return it.
    ``project_paths`` (absolute dirs) are included under workspaces/<name> when
    ``include_workspaces`` is set."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.fromtimestamp(now if now is not None else time.time()).strftime("%Y%m%d_%H%M%S")
    archive = out_dir / f"agentic-os-{stamp}.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for name in STATE_DIRS:
            d = base_dir / name
            if d.exists():
                tar.add(d, arcname=name, filter=_filter)
        if include_workspaces:
            seen = set()
            for p in (project_paths or []):
                wp = Path(p).expanduser()
                if not wp.is_dir():
                    continue
                arc = f"workspaces/{wp.name}"
                if arc in seen:                       # disambiguate duplicate basenames (deterministic)
                    arc = f"workspaces/{wp.name}-{hashlib.sha1(str(wp).encode()).hexdigest()[:6]}"
                seen.add(arc)
                tar.add(wp, arcname=arc, filter=_filter)
    return archive


def list_archives(out_dir: Path) -> list:
    if not out_dir.exists():
        return []
    rows = []
    for f in sorted(out_dir.glob("*.tar.gz"), reverse=True):
        st = f.stat()
        rows.append({"name": f.name, "size": st.st_size,
                     "created": datetime.fromtimestamp(st.st_mtime).isoformat()})
    return rows


def safe_extract(archive: Path, base_dir: Path):
    """Restore over base_dir, refusing any archive member that would escape it
    (../, absolute, or symlink/hardlink targets outside base)."""
    base_resolved = base_dir.resolve()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            target = (base_resolved / member.name).resolve()
            if target != base_resolved and base_resolved not in target.parents:
                raise ValueError(f"unsafe path in archive: {member.name}")
            if member.issym() or member.islnk():
                link_target = (target.parent / member.linkname).resolve()
                if link_target != base_resolved and base_resolved not in link_target.parents:
                    raise ValueError(f"unsafe link in archive: {member.name}")
        tar.extractall(path=base_dir)


# ─── destinations ─────────────────────────────────────────────────

def deliver_local(archive: Path, folder: str) -> str:
    dest = Path(folder).expanduser()
    if not dest.is_dir():
        raise ValueError(f"destination folder does not exist: {folder}")
    target = dest / archive.name
    if target.resolve() != archive.resolve():
        shutil.copy2(archive, target)
    return str(target)


def _no_option_injection(*values: str):
    """Reject operator-supplied argv values that begin with '-' — even in
    argv (non-shell) form, scp/git parse a leading-dash token as an OPTION
    (e.g. host '-oProxyCommand=...'), which is a command-injection vector."""
    for v in values:
        if isinstance(v, str) and v.startswith("-"):
            raise ValueError(f"value may not start with '-': {v!r}")


def deliver_git(archive: Path, repo_dir: str, remote: str = "origin",
                branch: str = "main", timeout: int = 120) -> str:
    """Copy the archive into a git working tree, commit, and push. The repo must
    already be cloned/inited with the remote + auth configured (SSH key or
    credential helper) — we never handle credentials."""
    _no_option_injection(remote, branch)
    repo = Path(repo_dir).expanduser()
    if not (repo / ".git").is_dir():
        raise ValueError(f"not a git repository: {repo_dir} (clone/init it first)")
    backups_subdir = repo / "backups"
    backups_subdir.mkdir(exist_ok=True)
    shutil.copy2(archive, backups_subdir / archive.name)

    def git(*args):
        r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True,
                           text=True, timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)} failed: {(r.stderr or r.stdout).strip()[:200]}")
        return r.stdout

    git("add", f"backups/{archive.name}")
    # commit may be a no-op only if the file already existed; tolerate that
    r = subprocess.run(["git", "-C", str(repo), "commit", "-m", f"backup {archive.name}"],
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0 and "nothing to commit" not in (r.stdout + r.stderr).lower():
        raise RuntimeError(f"git commit failed: {(r.stderr or r.stdout).strip()[:200]}")
    git("push", remote, branch)   # remote/branch validated (no leading '-')
    return f"{remote}/{branch}:backups/{archive.name}"


def deliver_scp(archive: Path, host: str, remote_path: str, user: str = "",
                port: int = 22, timeout: int = 120) -> str:
    """scp the archive to user@host:remote_path. SSH auth must be key-based and
    already trusted — batch mode refuses interactive password prompts."""
    _no_option_injection(host, user, remote_path)
    target_host = f"{user}@{host}" if user else host
    dest = f"{target_host}:{remote_path.rstrip('/')}/{archive.name}"
    r = subprocess.run(
        ["scp", "-B", "-P", str(int(port)),
         "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
         "--", str(archive), dest],   # -- ends option parsing (scp supports it)
        capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"scp failed: {(r.stderr or r.stdout).strip()[:200]}")
    return dest


def deliver(archive: Path, dest: dict) -> dict:
    """Dispatch one destination spec → {type, ok, detail}."""
    dtype = (dest or {}).get("type", "local")
    try:
        if dtype == "local":
            loc = deliver_local(archive, dest.get("folder", ""))
            return {"type": "local", "ok": True, "detail": loc}
        if dtype == "git":
            loc = deliver_git(archive, dest.get("repo", ""), dest.get("remote", "origin"),
                              dest.get("branch", "main"))
            return {"type": "git", "ok": True, "detail": loc}
        if dtype == "scp":
            loc = deliver_scp(archive, dest.get("host", ""), dest.get("path", ""),
                              dest.get("user", ""), int(dest.get("port", 22)))
            return {"type": "scp", "ok": True, "detail": loc}
        return {"type": dtype, "ok": False, "detail": f"unknown destination type '{dtype}'"}
    except Exception as e:
        return {"type": dtype, "ok": False, "detail": str(e)[:240]}
