"""Mirror the user's global Claude setup into Agentic OS.

Sources (read-only):
  - subagents:  ~/.claude/agents/*.md          → agent registry profiles
  - skills:     ~/.claude/skills/*/SKILL.md     → project skills/<name>/SKILL.md
  - MCP servers: ~/.claude.json + Claude Desktop config → MCP registry

Runs both automatically (scheduled, see server.py) and on demand. Upserts are
non-destructive and keyed by name: items the user authored by hand (no
``source: claude-global``) are never overwritten; previously-mirrored items are
refreshed. Source files that can't be read are skipped silently.
"""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

import mcp_registry

SOURCE = "claude-global"


# ─── frontmatter parsing ──────────────────────────────────────────

def parse_frontmatter(text: str):
    """Return (frontmatter dict, body). Handles simple ``key: value`` and YAML
    folded scalars (``>-`` / ``|``) used in Claude agent descriptions."""
    fm, body = {}, text
    if not text.startswith("---"):
        return fm, text
    lines = text.splitlines()
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return fm, text
    body = "\n".join(lines[end + 1:]).lstrip("\n")
    i = 1
    while i < end:
        raw = lines[i]
        if not raw.strip() or ":" not in raw:
            i += 1
            continue
        key, _, val = raw.partition(":")
        key, val = key.strip(), val.strip()
        if val in (">", ">-", "|", "|-"):  # folded/literal block scalar
            block, i = [], i + 1
            while i < end and (lines[i].startswith((" ", "\t")) or not lines[i].strip()):
                block.append(lines[i].strip())
                i += 1
            fm[key] = " ".join(b for b in block if b).strip()
            continue
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            fm[key] = [v.strip().strip("'\"") for v in inner.split(",") if v.strip()] if inner else []
        else:
            fm[key] = val.strip("'\"")
        i += 1
    return fm, body


def _skills_from_description(desc: str) -> list:
    """Heuristic: pull short keyword-ish tokens from a description for tagging."""
    words = re.findall(r"[A-Za-z][A-Za-z0-9+/-]{2,}", (desc or "").lower())
    stop = {"the", "and", "for", "use", "with", "this", "that", "from", "into", "your"}
    seen, out = set(), []
    for w in words:
        if w in stop or w in seen:
            continue
        seen.add(w)
        out.append(w)
        if len(out) >= 6:
            break
    return out


def _slug(name: str) -> str:
    base = "".join(c.lower() if c.isalnum() else "_" for c in str(name)).strip("_")
    return "_".join(filter(None, base.split("_"))) or "agent"


# ─── agents ───────────────────────────────────────────────────────

def mirror_agents(agents_dir: Path, registry_path: Path, default_model: str, now_iso: str) -> dict:
    summary = {"imported": 0, "refreshed": 0, "skipped": 0}
    if not agents_dir.exists():
        return summary
    reg = _load(registry_path, {"agents": []})
    agents = reg.setdefault("agents", [])
    by_name = {a.get("name"): a for a in agents}

    for f in sorted(agents_dir.glob("*.md")):
        try:
            fm, body = parse_frontmatter(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        name = fm.get("name") or f.stem
        model = fm.get("model", "")
        if not model or model == "inherit":
            model = default_model
        profile = {
            "name": name, "provider": "claude", "model": model,
            "system_prompt": body.strip(),
            "skills": _skills_from_description(fm.get("description", "")),
            "source": SOURCE, "mirrored_at": now_iso,
        }
        existing = by_name.get(name)
        if existing is None:
            profile["id"] = _slug(name) + "_" + uuid.uuid4().hex[:6]
            profile["created"] = now_iso
            profile["updated"] = now_iso
            agents.append(profile)
            summary["imported"] += 1
        elif existing.get("source") != SOURCE:
            summary["skipped"] += 1            # hand-made — never touch
        else:
            existing.update({k: profile[k] for k in
                             ("provider", "model", "system_prompt", "skills", "mirrored_at")})
            existing["updated"] = now_iso
            summary["refreshed"] += 1
    _save(registry_path, reg)
    return summary


# ─── skills ───────────────────────────────────────────────────────

def mirror_skills(skills_src: Path, skills_dst: Path, now_iso: str) -> dict:
    summary = {"imported": 0, "refreshed": 0, "skipped": 0}
    if not skills_src.exists():
        return summary
    for d in sorted(p for p in skills_src.iterdir() if p.is_dir()):
        src = d / "SKILL.md"
        if not src.exists():
            continue
        try:
            fm, body = parse_frontmatter(src.read_text(encoding="utf-8"))
        except Exception:
            continue
        name = fm.get("name") or d.name
        dst_dir = skills_dst / name
        dst = dst_dir / "SKILL.md"
        if dst.exists():
            cur = dst.read_text(encoding="utf-8")
            if f"author: {SOURCE}" not in cur:
                summary["skipped"] += 1        # hand-made project skill — keep
                continue
            action = "refreshed"
        else:
            action = "imported"
        tags = [fm.get("trigger", "").lstrip("/")] if fm.get("trigger") else []
        front = (
            "---\n"
            f"name: {name}\n"
            f"description: {fm.get('description', '')}\n"
            "version: 1.0.0\n"
            f"author: {SOURCE}\n"
            f"tags: [{', '.join(t for t in tags if t)}]\n"
            f"mirrored_at: {now_iso}\n"
            "---\n\n"
        )
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst.write_text(front + body.strip() + "\n", encoding="utf-8")
        summary[action] += 1
    return summary


# ─── MCP servers ──────────────────────────────────────────────────

def extract_mcp_servers(config_paths) -> list:
    """Read MCP server defs from Claude config files (best-effort, tolerant of
    unreadable/missing files). Returns normalized server dicts."""
    found = []
    seen = set()

    def add(name, cfg):
        if not isinstance(cfg, dict) or name in seen:
            return
        seen.add(name)
        found.append(mcp_registry.normalize_server({**cfg, "name": name, "source": SOURCE}))

    for path in config_paths:
        try:
            data = json.loads(Path(path).read_text())
        except Exception:
            continue
        for name, cfg in (data.get("mcpServers") or {}).items():
            add(name, cfg)
        for proj in (data.get("projects") or {}).values():
            for name, cfg in ((proj or {}).get("mcpServers") or {}).items():
                add(name, cfg)
    return found


def mirror_mcp(servers: list, mcp_path: Path) -> dict:
    summary = {"imported": 0, "refreshed": 0, "skipped": 0}
    for s in servers:
        action = mcp_registry.upsert(mcp_path, s)
        summary[action] = summary.get(action, 0) + 1
    return summary


# ─── tiny json helpers ────────────────────────────────────────────

def _load(path: Path, default):
    if Path(path).exists():
        try:
            return json.loads(Path(path).read_text())
        except Exception:
            return default
    return default


def _save(path: Path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2))
