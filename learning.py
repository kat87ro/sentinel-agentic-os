"""Agent self-learning — the data layer.

After every task settles (done OR failed), a cheap reflection call extracts up
to 3 short lessons; they land in <vault>/agents/<agent_id>/learnings.md and are
injected into that agent's future prompts. This module owns the markdown file
format, pruning, and lesson parsing; the reflection LLM call lives in server.py.
"""
from __future__ import annotations

import re
import threading
from pathlib import Path

MAX_LESSONS_PER_TASK = 3
MAX_LESSON_CHARS = 240
MAX_FILE_BYTES = 16_000          # ~hundreds of lessons; oldest sections pruned
INJECT_TAIL_CHARS = 1_600        # newest lessons injected into prompts

_write_lock = threading.Lock()

REFLECTION_PROMPT = """You are a reflection step in an agent runtime. An agent just finished a task. Extract at most {max_lessons} SHORT, actionable lessons that would help this agent do better on FUTURE tasks (techniques that worked, mistakes to avoid, environment quirks).

Rules:
- Reply with ONLY bullet lines starting with "- ", nothing else.
- Each lesson under {max_chars} characters, generalizable (not a restatement of this task's output).
- If there is nothing genuinely worth remembering, reply with exactly: NONE

Task given to the agent:
{message}

Outcome: {status}

Agent's final output (truncated):
{result}"""


def learnings_path(vault_dir: Path, agent_id: str) -> Path:
    return vault_dir / "agents" / agent_id / "learnings.md"


def parse_lessons(text: str) -> list:
    """Bullet lines from a reflection reply; NONE / chatter → []. Defensive:
    models sometimes wrap bullets in preamble — keep only '- ' lines."""
    if not text or "NONE" in text.strip()[:10].upper():
        return []
    out = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("- ") and line[2:].strip():
            out.append(line[2:].strip()[:MAX_LESSON_CHARS])
        if len(out) >= MAX_LESSONS_PER_TASK:
            break
    return out


def append_lessons(path: Path, lessons: list, task_title: str, date: str):
    """One '## <date> — <title>' section per reflection; oldest sections are
    pruned once the file exceeds MAX_FILE_BYTES."""
    if not lessons:
        return
    with _write_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = path.read_text() if path.exists() else "# Learnings\n"
        section = f"\n## {date} — {task_title.strip() or 'task'}\n" + \
                  "".join(f"- {l}\n" for l in lessons)
        content = existing + section
        if len(content.encode()) > MAX_FILE_BYTES:
            content = _prune_oldest(content)
        path.write_text(content)


def _prune_oldest(content: str) -> str:
    header, *sections = re.split(r"\n(?=## )", content)
    while sections and len(("\n".join([header] + sections)).encode()) > MAX_FILE_BYTES:
        sections.pop(0)
    return "\n".join([header.rstrip()] + sections) if sections else header


def read_for_injection(path: Path, max_chars: int = INJECT_TAIL_CHARS) -> str:
    """Newest lessons (tail), cut on a section boundary so we never inject a
    half section."""
    if not path.exists():
        return ""
    text = path.read_text().strip()
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    tail = text[-max_chars:]
    cut = tail.find("\n## ")
    return tail[cut + 1:] if cut != -1 else tail


def read_all(path: Path) -> str:
    return path.read_text() if path.exists() else ""
