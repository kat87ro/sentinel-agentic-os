"""Shared JSON store contract — atomic writes + per-path locks + .bak recovery.

Sentinel mutates many JSON files from BOTH request threads and the 15s
heartbeat thread. Bare ``path.write_text(json.dumps(...))`` under that
concurrency loses updates (interleaved read-modify-write) and, on a crash or
disk-full mid-write, truncates the file — and a corrupt store like
``agents_registry.json`` (read first on every tick, no fallback) silently
halts the whole scheduler.

This module gives every store the same contract ``agent_tasks.py`` already has:

  - ``lock_for(path)``    — one reentrant lock per file, so a full
                            read-modify-write can be done atomically.
  - ``atomic_write_json`` — write to a temp file in the same dir, fsync,
                            ``os.replace`` (atomic on POSIX), keeping a ``.bak``
                            of the previous good copy.
  - ``read_json``         — parse with a ``.bak`` fallback on corruption, so a
                            torn read can never silently halt a caller.

Pure functions taking explicit paths → testable against a temp dir.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

_locks: dict = {}
_locks_guard = threading.Lock()


def lock_for(path) -> threading.RLock:
    """Return the process-wide reentrant lock for a given file path."""
    key = str(Path(path))
    with _locks_guard:
        lk = _locks.get(key)
        if lk is None:
            lk = threading.RLock()
            _locks[key] = lk
        return lk


def atomic_write_json(path, data, *, indent: int = 2):
    """Atomically persist ``data`` as JSON to ``path``: write a sibling temp
    file, flush+fsync, keep the prior good copy as ``.bak``, then ``os.replace``
    (atomic rename). A crash/disk-full leaves either the old file or the new
    one intact — never a truncated store."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with lock_for(path):
        with open(tmp, "w") as f:
            json.dump(data, f, indent=indent)
            f.flush()
            os.fsync(f.fileno())
        if path.exists():
            try:
                os.replace(path, path.with_suffix(path.suffix + ".bak"))
            except OSError:
                pass
        os.replace(tmp, path)


def read_json(path, default=None):
    """Parse JSON, falling back to the ``.bak`` on corruption so a torn write
    can never silently surface as an empty/halted store. Returns ``default``
    (or ``{}``) only when neither the file nor its backup is readable."""
    path = Path(path)
    if default is None:
        default = {}
    with lock_for(path):
        if path.exists():
            try:
                return json.loads(path.read_text())
            except Exception:
                bak = path.with_suffix(path.suffix + ".bak")
                if bak.exists():
                    try:
                        return json.loads(bak.read_text())
                    except Exception:
                        pass
                return default
        return default
