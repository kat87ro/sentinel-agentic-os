"""Agent task queue + heartbeat runtime.

Agents sleep by default — they consume nothing while their queue is empty.
Work arrives as queued tasks (operator assignment, or a Lead's [DELEGATE]
lines). A manual operator assignment wakes the target immediately; everything
else waits for the agent's own heartbeat: every ``heartbeat_seconds`` (per
agent, 0 = manual-wake only) a scheduler tick wakes agents that have queued
work and lets them DRAIN their queue, then they sleep again.

Pure data layer: enqueueing, state transitions, wake-due math, and the
[DELEGATE: member] parser. Execution (LLM calls, budget gate, Kanban mirror)
stays in server.py.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

DEFAULT_HEARTBEAT_SECONDS = 300          # 5 minutes
MIN_HEARTBEAT_SECONDS = 30               # floor for non-zero heartbeats
MAX_TASKS_PER_WAKE = 5                   # cap one wake's cost/blast radius
MAX_DELEGATION_DEPTH = 3                 # parent_id hops before delegation is refused
# A "working" agent older than this is treated as stranded (crash/hang) and may
# be re-woken. Must comfortably exceed the WORST-CASE legitimate wake so a slow
# (but live) drain is never re-woken into double execution: up to
# MAX_TASKS_PER_WAKE tasks, each a provider call (~300s) plus a reflection call
# (~300s) → ~50 min. 90 min leaves headroom; a genuinely hung agent still
# recovers on the next restart via recover().
STALE_WORKING_SECONDS = 90 * 60

# One process-wide lock serializes EVERY store mutation (ticker thread +
# request threads share the same JSON file).
_store_lock = threading.RLock()
DELEGATE_MARKER = "[DELEGATE:"
DELEGATE_RE = re.compile(r"^\s*\[DELEGATE:\s*([^\]]+)\]\s*(.+)$", re.MULTILINE)

TASK_STATUSES = ("queued", "running", "done", "needs_input", "failed")
# agent-task state → kanban column (the visible mirror)
KANBAN_MIRROR = {"queued": "todo", "running": "in_progress", "done": "done",
                 "needs_input": "blocked", "failed": "blocked"}


def _parse(text: str) -> dict:
    data = json.loads(text)
    data.setdefault("tasks", [])
    data.setdefault("runtime", {})
    return data


def load_store(path: Path) -> dict:
    """Absent file → empty store. Corrupt file → recover from the .bak written
    on every save; if that also fails, the corrupt file is preserved aside and
    we RAISE — open work is never silently dropped as an empty queue."""
    with _store_lock:
        if not path.exists():
            return {"tasks": [], "runtime": {}}
        try:
            return _parse(path.read_text())
        except Exception:
            bak = path.with_suffix(".bak")
            if bak.exists():
                try:
                    return _parse(bak.read_text())
                except Exception:
                    pass
            preserved = path.with_suffix(".corrupt")
            try:
                os.replace(path, preserved)
            except OSError:
                preserved = path
            raise RuntimeError(
                f"agent task store is corrupt and no backup is readable; "
                f"preserved at {preserved}")


def save_store(path: Path, data: dict):
    """Atomic write (tmp + os.replace) with a .bak of the previous good state."""
    with _store_lock:
        # finished work older than ~14 days is pruned; open work is never dropped
        cutoff = time.time() - 14 * 86400
        data["tasks"] = [t for t in data.get("tasks", [])
                         if t.get("status") in ("queued", "running", "needs_input")
                         or t.get("ts", time.time()) >= cutoff]
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        if path.exists():
            try:
                os.replace(path, path.with_suffix(".bak"))
            except OSError:
                pass
        os.replace(tmp, path)


def enqueue(path: Path, agent_id: str, title: str, message: str,
            project_id: str = None, parent_id: str = None,
            created_by: str = "operator", kanban_id: str = None) -> dict:
  with _store_lock:
    data = load_store(path)
    task = {
        "id": str(uuid.uuid4())[:8],
        "agent_id": agent_id,
        "title": (title or message[:60]).strip(),
        "message": message,
        "project_id": project_id,
        "parent_id": parent_id,
        "created_by": created_by,
        "status": "queued",
        "result": "",
        "kanban_id": kanban_id,
        "ts": time.time(),
    }
    data["tasks"].append(task)
    save_store(path, data)
    return task


def set_status(path: Path, task_id: str, status: str, result: str = None) -> dict | None:
  with _store_lock:
    data = load_store(path)
    for t in data["tasks"]:
        if t["id"] == task_id:
            t["status"] = status
            if result is not None:
                t["result"] = result
            t["updated_ts"] = time.time()
            save_store(path, data)
            return t
    return None


def tasks_for(path: Path, agent_id: str = None, project_id: str = None,
              status: str = None) -> list:
    out = load_store(path).get("tasks", [])
    if agent_id:
        out = [t for t in out if t.get("agent_id") == agent_id]
    if project_id:
        out = [t for t in out if t.get("project_id") == project_id]
    if status:
        out = [t for t in out if t.get("status") == status]
    return sorted(out, key=lambda t: t.get("ts", 0))


def claim_queued(path: Path, agent_id: str) -> list:
    """Atomically flip this agent's queued tasks to running and return them —
    the wake batch. Capped at MAX_TASKS_PER_WAKE so one wake cannot drain an
    unbounded flood of delegations; the remainder waits for the next beat."""
    with _store_lock:
        data = load_store(path)
        claimed = []
        for t in data["tasks"]:
            if len(claimed) >= MAX_TASKS_PER_WAKE:
                break
            if t.get("agent_id") == agent_id and t.get("status") == "queued":
                t["status"] = "running"
                t["updated_ts"] = time.time()
                claimed.append(dict(t))
        if claimed:
            save_store(path, data)
        return claimed


def unlink_kanban(path: Path, kanban_id: str):
    """Detach queue tasks from a deleted card so later status changes can't
    resurrect it through the mirror."""
    with _store_lock:
        data = load_store(path)
        changed = False
        for t in data["tasks"]:
            if t.get("kanban_id") == kanban_id:
                t["kanban_id"] = None
                changed = True
        if changed:
            save_store(path, data)


def delete_task(path: Path, task_id: str) -> dict | None:
    """Remove a TERMINAL task from the store. Open work (queued/running) is
    never deleted — cancel queued, or wait out running."""
    with _store_lock:
        data = load_store(path)
        for t in data["tasks"]:
            if t["id"] == task_id:
                if t.get("status") in ("queued", "running"):
                    return None
                data["tasks"] = [x for x in data["tasks"] if x["id"] != task_id]
                save_store(path, data)
                return t
        return None


def heartbeat_of(agent: dict) -> int:
    try:
        hb = int(agent.get("heartbeat_seconds", DEFAULT_HEARTBEAT_SECONDS))
    except (TypeError, ValueError):
        hb = DEFAULT_HEARTBEAT_SECONDS
    return normalize_heartbeat(hb)


def normalize_heartbeat(hb: int) -> int:
    """0 stays manual-only; anything else is floored to MIN_HEARTBEAT_SECONDS
    so an API caller cannot turn the loop into a tight money-burn."""
    hb = int(hb or 0)
    if hb <= 0:
        return 0
    return max(MIN_HEARTBEAT_SECONDS, hb)


def delegation_chain(path: Path, task_id: str) -> tuple:
    """Walk parent_id links: returns (depth, {agent_ids in the chain}).
    Used to refuse delegation cycles and runaway depth."""
    tasks = {t["id"]: t for t in load_store(path).get("tasks", [])}
    depth, agents, seen = 0, set(), set()
    cur = tasks.get(task_id)
    while cur and cur["id"] not in seen:
        seen.add(cur["id"])
        agents.add(cur.get("agent_id"))
        parent = cur.get("parent_id")
        cur = tasks.get(parent) if parent else None
        depth += 1
    return depth, agents


def mark_wake(path: Path, agent_id: str, state: str = "working"):
  with _store_lock:
    data = load_store(path)
    rt = data["runtime"].setdefault(agent_id, {})
    rt["last_wake"] = time.time()
    rt["state"] = state
    save_store(path, data)


def mark_sleep(path: Path, agent_id: str):
  with _store_lock:
    data = load_store(path)
    rt = data["runtime"].setdefault(agent_id, {})
    rt["state"] = "sleeping"
    rt["last_done"] = time.time()
    save_store(path, data)


def runtime_view(path: Path, agents: list, now: float = None) -> dict:
    """Per-agent live status for the dashboard: state, queued count, next wake."""
    now = now if now is not None else time.time()
    data = load_store(path)
    queued_counts, waiting_counts = {}, {}
    for t in data.get("tasks", []):
        if t.get("status") == "queued":
            queued_counts[t["agent_id"]] = queued_counts.get(t["agent_id"], 0) + 1
        if t.get("status") == "needs_input":
            waiting_counts[t["agent_id"]] = waiting_counts.get(t["agent_id"], 0) + 1
    out = {}
    for a in agents:
        aid = a.get("id")
        rt = data.get("runtime", {}).get(aid, {})
        always = bool(a.get("always_awake"))
        hb = heartbeat_of(a)
        queued = queued_counts.get(aid, 0)
        state = rt.get("state", "sleeping")
        next_wake = None
        if state != "working":
            if waiting_counts.get(aid):
                state = "waiting_input"
            elif queued and always:
                # continuous: drains on the next tick, no interval countdown —
                # must match due_agent_ids so the monitor doesn't claim "next
                # wake in 5 min" for an agent that actually runs every ~15s.
                next_wake = 0
                state = "sleeping"
            elif queued and hb > 0:
                next_wake = max(0, int(rt.get("last_wake", 0) + hb - now))
                state = "sleeping"
            else:
                state = "sleeping"
        out[aid] = {"state": state, "queued": queued,
                    "waiting_input": waiting_counts.get(aid, 0),
                    "heartbeat_seconds": hb,
                    "always_awake": always,
                    "next_wake_in": next_wake,
                    "last_wake": rt.get("last_wake")}
    return out


def due_agent_ids(path: Path, agents: list, now: float = None) -> list:
    """Agents the heartbeat ticker should wake: queued work + interval elapsed.
    heartbeat 0 = manual-wake only, never auto-woken."""
    now = now if now is not None else time.time()
    data = load_store(path)
    queued = {t["agent_id"] for t in data.get("tasks", []) if t.get("status") == "queued"}
    due = []
    for a in agents:
        aid = a.get("id")
        if aid not in queued:
            continue
        # "always_awake" agents ignore the heartbeat interval entirely: they are
        # due on every tick they have queued work (and aren't already draining),
        # i.e. continuous processing. Overrides heartbeat 0 (manual-only) too.
        always = bool(a.get("always_awake"))
        hb = heartbeat_of(a)
        if hb <= 0 and not always:
            continue
        rt = data.get("runtime", {}).get(aid, {})
        if rt.get("state") == "working":
            # crash/hang safety: a wake can't legitimately run this long —
            # treat it as stranded and let the agent wake again. The "working"
            # guard also stops an always_awake agent from double-draining.
            if now - rt.get("last_wake", 0) < STALE_WORKING_SECONDS:
                continue
        if always or now - rt.get("last_wake", 0) >= hb:
            due.append(aid)
    return due


def recover(path: Path) -> dict:
    """Crash recovery (run at startup): tasks stranded in "running" go back to
    "queued" (the process died mid-execution — work is never lost), and agents
    stranded in "working" go back to "sleeping" so the ticker can wake them."""
    with _store_lock:
        if not path.exists():
            return {"requeued": [], "released": []}
        data = load_store(path)
        requeued, released = [], []
        for t in data.get("tasks", []):
            if t.get("status") == "running":
                t["status"] = "queued"
                t["updated_ts"] = time.time()
                requeued.append(t["id"])
        for aid, rt in data.get("runtime", {}).items():
            if rt.get("state") == "working":
                rt["state"] = "sleeping"
                released.append(aid)
        if requeued or released:
            save_store(path, data)
        return {"requeued": requeued, "released": released}


def sweep_stranded(path: Path, live_task_ids: set, live_agent_ids: set,
                   grace_seconds: int = 120, now: float = None) -> dict:
    """LIVE crash/hang recovery (run every heartbeat tick, no restart needed).

    An agent stuck in "working" whose drain produced NO live subprocess is
    stranded — its worker thread/subprocess died or detached without finalizing
    the task (e.g. the server was restarted mid-run, leaving orphaned children).
    Unlike recover() (boot-time, REQUEUES so a clean restart resumes work), the
    live sweep FAILS the orphaned running tasks and frees the agent: there is no
    safe way to know how far a vanished worker got, and silently re-running it
    would risk surprise token spend / double execution. Liveness is judged by
    proc_registry presence (a real drain always has a registered process), with
    a short grace window so a just-started drain — working set, CLI not spawned
    yet — is never swept mid-launch.

    Returns {"failed": [task_id...], "freed": [agent_id...]}.
    """
    now = now if now is not None else time.time()
    with _store_lock:
        if not path.exists():
            return {"failed": [], "freed": []}
        data = load_store(path)
        failed, freed = [], []
        for aid, rt in data.get("runtime", {}).items():
            if rt.get("state") != "working":
                continue
            if aid in live_agent_ids:                          # a live session exists → legit
                continue
            if now - rt.get("last_wake", 0) < grace_seconds:   # just launched → don't race it
                continue
            running = [t for t in data.get("tasks", [])
                       if t.get("agent_id") == aid and t.get("status") == "running"]
            if any(t.get("id") in live_task_ids for t in running):
                continue                                       # something IS live → leave alone
            for t in running:
                t["status"] = "failed"
                t["result"] = ("stranded — the worker exited without finishing "
                               "(auto-released by the live stale sweep)")
                t["updated_ts"] = now
                failed.append(t["id"])
            rt["state"] = "sleeping"
            freed.append(aid)
        if failed or freed:
            save_store(path, data)
        return {"failed": failed, "freed": freed}


def parse_delegations(result: str) -> list:
    """[DELEGATE: <member name>] <subtask> → [(member_name, subtask), ...]"""
    if not result or DELEGATE_MARKER not in result:
        return []
    return [(m.group(1).strip(), m.group(2).strip())
            for m in DELEGATE_RE.finditer(result) if m.group(2).strip()]


def delegate_instruction(members: list) -> str:
    """Injected into a Lead's prompt when it has team members to hand work to.
    members = [{"id", "name", "role"}]"""
    if not members:
        return ""
    roster = "; ".join(f"{m['name']} ({m.get('role', 'Member')})" for m in members)
    return ("Team delegation protocol: your team members are: " + roster + ". "
            "For any subtask that belongs to a teammate, emit one line per "
            "subtask in exactly this format:\n[DELEGATE: <member name>] <subtask>\n"
            "Delegated subtasks are queued and picked up on each member's next "
            "heartbeat — do not do their work yourself.")
