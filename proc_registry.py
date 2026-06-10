"""Live LLM subprocess registry — the kill switch's data layer.

Every provider CLI execution (agent task, chat, skill run, reflection) is
registered here for its lifetime: PID, process group, what it's doing and for
whom. The Mission Control "Active Sessions" panel lists these; killing one
terminates the WHOLE process group (CLIs fork children) with SIGTERM, then
SIGKILL after a grace period.

In-memory by design: a process cannot outlive the server that spawned it as a
killable child, and stale "running" agent tasks after a crash are already
handled by agent_tasks.recover() at startup.
"""
from __future__ import annotations

import os
import signal
import threading
import time
import uuid

KILL_GRACE_SECONDS = 3.0
KILLED_MARKER = "killed by operator"

_lock = threading.Lock()
_sessions: dict = {}      # id -> session dict (proc handle kept out of the API view)


def register(proc, kind: str, label: str, agent_id: str = None,
             task_id: str = None, command: str = "") -> str:
    sid = str(uuid.uuid4())[:8]
    with _lock:
        _sessions[sid] = {
            "id": sid,
            "pid": proc.pid,
            "kind": kind,                  # task | chat | project-chat | skill | reflection | agent
            "label": (label or "")[:120],
            "agent_id": agent_id,
            "task_id": task_id,
            "command": (command or "")[:80],
            "started": time.time(),
            "killed": False,
            "_proc": proc,
        }
    return sid


def finish(session_id: str):
    with _lock:
        _sessions.pop(session_id, None)


def was_killed(session_id: str) -> bool:
    with _lock:
        s = _sessions.get(session_id)
        return bool(s and s["killed"])


def _alive(s: dict) -> bool:
    return s["_proc"].poll() is None


def list_active() -> list:
    """Public view of live sessions; finished-but-unreaped entries are purged."""
    with _lock:
        dead = [sid for sid, s in _sessions.items() if not _alive(s)]
        for sid in dead:
            # owner thread is still in communicate(); it will call finish() —
            # we just stop showing it as active
            if _sessions[sid]["killed"]:
                continue
            _sessions.pop(sid, None)
        now = time.time()
        return [{k: v for k, v in s.items() if not k.startswith("_")}
                | {"runtime_seconds": int(now - s["started"])}
                for s in sorted(_sessions.values(), key=lambda x: x["started"])
                if _alive(s)]


def kill(session_id: str, grace: float = KILL_GRACE_SECONDS) -> dict | None:
    """SIGTERM the session's process group; SIGKILL whatever survives the
    grace period. Returns the session view, or None if unknown/already gone."""
    with _lock:
        s = _sessions.get(session_id)
        if not s or not _alive(s):
            return None
        s["killed"] = True
        pid = s["pid"]
    try:
        pgid = os.getpgid(pid)
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pgid = None
    deadline = time.time() + grace
    proc = s["_proc"]
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        time.sleep(0.1)
    if proc.poll() is None and pgid is not None:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return {k: v for k, v in s.items() if not k.startswith("_")}
