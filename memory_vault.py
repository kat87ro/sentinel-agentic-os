"""Obsidian-compatible memory vault.

The vault is a plain folder of markdown notes (default: ``brain/``). This module
adds the Obsidian conventions on top — YAML frontmatter, ``#tags``,
``[[wikilinks]]`` and backlinks — plus a lightweight ranked search and a
link-following context resolver used to inject relevant memory into agent
prompts. No database, no heavy YAML dependency: frontmatter is hand-parsed for
the simple ``key: value`` / ``tags: [a, b]`` subset Obsidian writes.

All functions take an explicit ``vault_dir: Path`` so they are trivially
testable against a temp directory.
"""
from __future__ import annotations

import re
from pathlib import Path

WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
# Inline #tag — letters/digits/_/-/ nesting via '/', not starting with a digit
# (so we don't catch '#1' style headings or anchors).
TAG_RE = re.compile(r"(?:^|\s)#([A-Za-z][\w/-]*)")


def parse_note(text: str) -> dict:
    """Parse a note into ``{frontmatter, body, tags, links}``.

    - frontmatter: leading ``---`` YAML block (simple key/value + list subset)
    - tags: from frontmatter ``tags:`` plus inline ``#tag`` tokens
    - links: ``[[target]]`` / ``[[target|alias]]`` / ``[[target#heading]]`` →
      the bare target name
    """
    text = text or ""
    frontmatter: dict = {}
    body = text

    if text.startswith("---"):
        # Find the closing fence on its own line.
        lines = text.splitlines()
        end = None
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                end = i
                break
        if end is not None:
            frontmatter = _parse_frontmatter(lines[1:end])
            body = "\n".join(lines[end + 1:]).lstrip("\n")

    tags = set()
    fm_tags = frontmatter.get("tags")
    if isinstance(fm_tags, list):
        tags.update(str(t).strip() for t in fm_tags if str(t).strip())
    elif isinstance(fm_tags, str):
        tags.update(t.strip() for t in re.split(r"[,\s]+", fm_tags) if t.strip())
    tags.update(m.group(1) for m in TAG_RE.finditer(body))

    links = []
    seen = set()
    for m in WIKILINK_RE.finditer(text):
        target = m.group(1).split("|")[0].split("#")[0].strip()
        if target and target.lower() not in seen:
            seen.add(target.lower())
            links.append(target)

    return {"frontmatter": frontmatter, "body": body, "tags": sorted(tags), "links": links}


def _parse_frontmatter(lines: list) -> dict:
    """Minimal YAML subset: ``key: value`` and ``key: [a, b]`` / ``key:`` + ``- item``."""
    fm: dict = {}
    current_list_key = None
    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue
        if current_list_key and line.lstrip().startswith("- "):
            fm.setdefault(current_list_key, []).append(line.lstrip()[2:].strip())
            continue
        current_list_key = None
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if val == "":
            current_list_key = key
            fm[key] = []
        elif val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            fm[key] = [v.strip().strip("'\"") for v in inner.split(",") if v.strip()] if inner else []
        else:
            fm[key] = val.strip("'\"")
    return fm


def _iter_notes(vault_dir: Path):
    if not vault_dir.exists():
        return
    for p in sorted(vault_dir.rglob("*.md")):
        if any(part.startswith(".") for part in p.parts):
            continue
        yield p


def _note_name(vault_dir: Path, path: Path) -> str:
    """A note's link name is its filename stem (Obsidian resolves by basename)."""
    return path.stem


def read_note(vault_dir: Path, name: str):
    """Return the parsed note for a link-name (filename stem), or None."""
    for p in _iter_notes(vault_dir):
        if _note_name(vault_dir, p) == name:
            parsed = parse_note(p.read_text(encoding="utf-8"))
            parsed["name"] = name
            parsed["path"] = str(p.relative_to(vault_dir))
            return parsed
    return None


def build_link_graph(vault_dir: Path) -> dict:
    """Scan the vault and return ``{nodes, edges, backlinks}``.

    Edges only connect links that resolve to an existing note. Backlinks map a
    note name to the list of notes that reference it.
    """
    notes = {}
    for p in _iter_notes(vault_dir):
        name = _note_name(vault_dir, p)
        notes[name] = parse_note(p.read_text(encoding="utf-8"))

    nodes = [{"name": n, "tags": notes[n]["tags"]} for n in sorted(notes)]
    edges = []
    backlinks: dict = {n: [] for n in notes}
    for src in sorted(notes):
        for target in notes[src]["links"]:
            if target in notes and target != src:
                edges.append({"from": src, "to": target})
                if src not in backlinks[target]:
                    backlinks[target].append(src)
    return {"nodes": nodes, "edges": edges, "backlinks": backlinks}


def search_vault(vault_dir: Path, query: str, limit: int = 25) -> list:
    """Ranked substring/token search across notes (replaces the unimplemented
    FTS5). Title hits weigh more than body hits; results sorted by score."""
    q = (query or "").strip().lower()
    if not q:
        return []
    tokens = [t for t in re.split(r"\s+", q) if t]
    results = []
    for p in _iter_notes(vault_dir):
        name = _note_name(vault_dir, p)
        text = p.read_text(encoding="utf-8")
        low = text.lower()
        name_low = name.lower()
        score = 0
        for tok in tokens:
            if tok in name_low:
                score += 5
            score += low.count(tok)
        if score:
            idx = low.find(tokens[0])
            start = max(0, idx - 40)
            preview = text[start:start + 200].replace("\n", " ").strip()
            results.append({"name": name, "score": score, "preview": preview})
    results.sort(key=lambda r: (-r["score"], r["name"]))
    return results[:limit]


def resolve_context(vault_dir: Path, seeds, depth: int = 1, max_chars: int = 4000) -> str:
    """Given seed note names (or free-text seeds matched via search), follow
    ``[[links]]`` up to ``depth`` hops and return the concatenated note bodies,
    budgeted to ``max_chars``. This is the memory injected into prompts."""
    if not vault_dir.exists():
        return ""
    seeds = [s for s in (seeds or []) if s]
    if not seeds:
        return ""

    # Resolve seeds to concrete note names (exact stem, else best search hit).
    existing = {_note_name(vault_dir, p): p for p in _iter_notes(vault_dir)}
    frontier = []
    for s in seeds:
        if s in existing:
            frontier.append(s)
        else:
            hits = search_vault(vault_dir, s, limit=1)
            if hits:
                frontier.append(hits[0]["name"])

    collected, order = set(), []
    current = list(dict.fromkeys(frontier))
    for _ in range(max(0, depth) + 1):
        nxt = []
        for name in current:
            if name in collected or name not in existing:
                continue
            collected.add(name)
            order.append(name)
            parsed = parse_note(existing[name].read_text(encoding="utf-8"))
            nxt.extend(parsed["links"])
        current = nxt
        if not current:
            break

    chunks, total = [], 0
    for name in order:
        body = parse_note(existing[name].read_text(encoding="utf-8"))["body"].strip()
        block = f"## {name}\n{body}"
        if total + len(block) > max_chars:
            block = block[: max(0, max_chars - total)]
            if block:
                chunks.append(block)
            break
        chunks.append(block)
        total += len(block)
    return "\n\n".join(chunks).strip()
