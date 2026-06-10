"""Recurring agent tasks — the scheduler data layer.

A schedule is a saved agent task plus a recurrence: either a 5-field cron
expression ("0 9 * * 1-5") or a plain interval in minutes. When it fires, the
server enqueues a normal task into the target agent's queue — budgets, the
heartbeat runtime, delegation and the Kanban mirror all apply unchanged.

Pure data + cron math; execution stays in server.py (the heartbeat ticker
calls due_schedules() and fires them).
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

_lock = threading.RLock()

MIN_INTERVAL_MINUTES = 5            # floor — a schedule must not become a money-burn loop
CRON_FIELD_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 6))   # min hour dom mon dow
_CRON_PART_RE = re.compile(r"^(\*|\d+(-\d+)?)(/\d+)?$")


# ─── cron parsing/matching (5-field subset: * , - /) ─────────────

def _parse_field(field: str, lo: int, hi: int) -> set:
    """One cron field → the set of matching values. Raises ValueError on junk."""
    out = set()
    for part in field.split(","):
        m = _CRON_PART_RE.match(part)
        if not m:
            raise ValueError(f"bad cron part: {part!r}")
        rng, step = m.group(1), int(m.group(3)[1:]) if m.group(3) else 1
        if step < 1:
            raise ValueError(f"bad cron step in: {part!r}")
        if rng == "*":
            start, end = lo, hi
        elif "-" in rng:
            start, end = (int(x) for x in rng.split("-"))
        else:
            start = end = int(rng)
        if not (lo <= start <= end <= hi):
            raise ValueError(f"cron value out of range [{lo}-{hi}]: {part!r}")
        out.update(range(start, end + 1, step))
    return out


def parse_cron(expr: str) -> list:
    fields = (expr or "").split()
    if len(fields) != 5:
        raise ValueError("cron needs 5 fields: minute hour day-of-month month day-of-week")
    return [_parse_field(f, lo, hi) for f, (lo, hi) in zip(fields, CRON_FIELD_RANGES)]


def cron_matches(parsed: list, dt: datetime) -> bool:
    minutes, hours, doms, months, dows = parsed
    # Standard cron quirk: if BOTH dom and dow are restricted, either may match.
    dom_restricted = doms != set(range(1, 32))
    dow_restricted = dows != set(range(0, 7))
    dom_ok = dt.day in doms
    dow_ok = dt.weekday() in dows          # cron 0=Sunday; we use Monday=0 — see note below
    if dom_restricted and dow_restricted:
        day_ok = dom_ok or dow_ok
    else:
        day_ok = dom_ok and dow_ok
    return (dt.minute in minutes and dt.hour in hours
            and dt.month in months and day_ok)


# NOTE on day-of-week: we map 0=Monday … 6=Sunday (Python's weekday()), and the
# UI labels the field accordingly. This avoids the cron 0-vs-7 Sunday ambiguity.

# Scheduling horizon: a 5-field cron that matches at all recurs within 62 days
# (covers every month-day/weekday combination of a yearless cron) — with the
# notable exception of impossible-ish combos like "0 0 31 2 *". Anything with
# no occurrence inside the horizon is treated as UNFIREABLE and rejected by
# validate(), never stored as a silently dead schedule.
CRON_SCAN_HORIZON_MINUTES = 62 * 24 * 60


def next_cron_fire(expr: str, after: float) -> float | None:
    """Next epoch ≥ the minute after `after` that matches, or None when there
    is no occurrence within CRON_SCAN_HORIZON_MINUTES."""
    parsed = parse_cron(expr)
    dt = datetime.fromtimestamp(after).replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(CRON_SCAN_HORIZON_MINUTES):
        if cron_matches(parsed, dt):
            return dt.timestamp()
        dt += timedelta(minutes=1)
    return None


def compute_next_run(schedule: dict, after: float | None = None) -> float | None:
    after = after if after is not None else time.time()
    if schedule.get("cron"):
        return next_cron_fire(schedule["cron"], after)
    minutes = max(MIN_INTERVAL_MINUTES, int(schedule.get("interval_minutes") or 0))
    return after + minutes * 60


# ─── store (atomic save, .bak recovery — same contract as agent_tasks) ──

def _parse_store(text: str) -> dict:
    data = json.loads(text)
    data.setdefault("schedules", [])
    return data


def load_store(path: Path) -> dict:
    with _lock:
        if not path.exists():
            return {"schedules": []}
        try:
            return _parse_store(path.read_text())
        except Exception:
            bak = path.with_suffix(".bak")
            if bak.exists():
                try:
                    return _parse_store(bak.read_text())
                except Exception:
                    pass
            return {"schedules": []}    # schedules are recreatable config, not open work


def save_store(path: Path, data: dict):
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        if path.exists():
            try:
                os.replace(path, path.with_suffix(".bak"))
            except OSError:
                pass
        os.replace(tmp, path)


def validate(name: str, agent_id: str, message: str, cron: str, interval_minutes) -> str | None:
    """Returns an error string, or None when valid."""
    if not (name or "").strip():
        return "name is required"
    if not (agent_id or "").strip():
        return "agent_id is required"
    if not (message or "").strip():
        return "message is required"
    if bool(cron) == bool(interval_minutes):
        return "set exactly one of cron OR interval_minutes"
    if cron:
        try:
            parse_cron(cron)
        except ValueError as e:
            return str(e)
        if next_cron_fire(cron, time.time()) is None:
            return ("cron expression never fires within the 62-day scheduling "
                    "horizon — it would be a dead schedule")
    else:
        try:
            if int(interval_minutes) < MIN_INTERVAL_MINUTES:
                return f"interval must be at least {MIN_INTERVAL_MINUTES} minutes"
        except (TypeError, ValueError):
            return "interval_minutes must be a number"
    return None


def list_schedules(path: Path) -> list:
    return sorted(load_store(path)["schedules"], key=lambda s: s.get("created", 0))


def get_schedule(path: Path, schedule_id: str) -> dict | None:
    return next((s for s in load_store(path)["schedules"] if s["id"] == schedule_id), None)


def create(path: Path, *, name: str, agent_id: str, message: str,
           cron: str = "", interval_minutes=None, project_id: str = None,
           wake: bool = True, enabled: bool = True) -> dict:
    with _lock:
        data = load_store(path)
        sched = {
            "id": str(uuid.uuid4())[:8],
            "name": name.strip(),
            "agent_id": agent_id,
            "message": message.strip(),
            "project_id": project_id or None,
            "cron": (cron or "").strip(),
            "interval_minutes": int(interval_minutes) if interval_minutes else None,
            "wake": bool(wake),
            "enabled": bool(enabled),
            "created": time.time(),
            "last_run": None,
            "last_task_id": None,
            "run_count": 0,
        }
        sched["next_run"] = compute_next_run(sched) if sched["enabled"] else None
        data["schedules"].append(sched)
        save_store(path, data)
        return sched


def update(path: Path, schedule_id: str, fields: dict) -> dict | None:
    """Patch editable fields; recurrence/enabled changes recompute next_run."""
    editable = {"name", "agent_id", "message", "project_id", "cron",
                "interval_minutes", "wake", "enabled"}
    with _lock:
        data = load_store(path)
        for s in data["schedules"]:
            if s["id"] == schedule_id:
                before = (s.get("cron"), s.get("interval_minutes"), s.get("enabled"))
                for k, v in fields.items():
                    if k in editable and v is not None:
                        s[k] = v
                if fields.get("project_id") == "":
                    s["project_id"] = None
                # recurrence is exclusive: setting one clears the other
                if fields.get("cron"):
                    s["interval_minutes"] = None
                elif fields.get("interval_minutes"):
                    s["cron"] = ""
                # Recompute ONLY when timing actually changed — a rename at
                # hour 5 of a 6-hour interval must not push the fire out 6h.
                if (s.get("cron"), s.get("interval_minutes"), s.get("enabled")) != before:
                    s["next_run"] = compute_next_run(s) if s.get("enabled") else None
                save_store(path, data)
                return s
        return None


def delete(path: Path, schedule_id: str) -> bool:
    with _lock:
        data = load_store(path)
        before = len(data["schedules"])
        data["schedules"] = [s for s in data["schedules"] if s["id"] != schedule_id]
        if len(data["schedules"]) == before:
            return False
        save_store(path, data)
        return True


def due_schedules(path: Path, now: float | None = None) -> list:
    now = now if now is not None else time.time()
    return [s for s in load_store(path)["schedules"]
            if s.get("enabled") and s.get("next_run") and s["next_run"] <= now]


def mark_fired(path: Path, schedule_id: str, task_id: str, now: float | None = None) -> dict | None:
    """Record a fire and roll next_run forward — ALWAYS past `now`, so a ticker
    that fell behind fires once, not once per missed slot."""
    now = now if now is not None else time.time()
    with _lock:
        data = load_store(path)
        for s in data["schedules"]:
            if s["id"] == schedule_id:
                s["last_run"] = now
                s["last_task_id"] = task_id
                s["run_count"] = int(s.get("run_count") or 0) + 1
                s["next_run"] = compute_next_run(s, after=now)
                save_store(path, data)
                return s
        return None
