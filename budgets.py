"""Per-agent cost budgets — a cumulative $ allowance per rolling window.

An agent profile may carry ``budget_usd`` (float, 0/None = unlimited) and
``budget_period`` ("hour" | "day" | "month"). Every execution is metered into a
usage ledger (estimated tokens × per-model price); once the window's spend
reaches the budget the agent answers only with a limit-reached message until
the window rolls over or the budget is raised. Enforcement happens in
server.execute_profile, which covers every profile-based dispatch path
(tasks, team delegation, project chat, inbox replies). The legacy Chat page
(`POST /api/chat`) talks to raw base providers (not agent profiles), so it is
metered under a synthetic ``__chat__`` id and gated against an OPTIONAL
system-wide ``settings.chat_budget`` ({usd, period}); with no chat_budget set
it is unlimited but still metered (visible in Cost Analytics).

Token counts are estimates (~4 chars/token) — the executors return plain text,
not provider usage objects — so treat the budget as a strong guardrail, not an
accounting system. Prices are $ per 1M tokens (input, output) and can be
overridden in settings.json -> model_prices.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import jsonstore

PERIODS = {"hour": 3600, "day": 86400, "month": 30 * 86400}

# $ per 1M tokens (input, output). Override via settings.json -> model_prices.
DEFAULT_MODEL_PRICES = {
    "claude-fable-5":      (5.00, 25.00),
    "claude-opus-4-8":     (15.00, 75.00),
    "claude-sonnet-4-6":   (3.00, 15.00),
    "claude-haiku-4-5":    (1.00, 5.00),
    "gpt-5.1":             (2.50, 10.00),
    "gpt-5.1-codex":       (2.50, 10.00),
    "gemini-2.5-pro":      (1.25, 10.00),
    "gemini-2.5-flash":    (0.30, 2.50),
    "deepseek-chat":       (0.27, 1.10),
    "_default":            (3.00, 15.00),
}


def estimate_tokens(text: str) -> int:
    return max(1, len(text or "") // 4)


def model_price(model: str, overrides: dict | None = None) -> tuple:
    """Longest-prefix match so dated/variant ids (claude-haiku-4-5-20251001)
    inherit their family price."""
    table = dict(DEFAULT_MODEL_PRICES)
    for k, v in (overrides or {}).items():
        if isinstance(v, (list, tuple)) and len(v) == 2:
            try:
                table[k] = (float(v[0]), float(v[1]))
            except (TypeError, ValueError):
                continue   # one malformed entry must never disable metering
    model = (model or "").lower()
    best = ""
    for name in table:
        if name != "_default" and model.startswith(name) and len(name) > len(best):
            best = name
    return table[best or "_default"]


def estimate_cost(model: str, tokens_in: int, tokens_out: int,
                  overrides: dict | None = None) -> float:
    p_in, p_out = model_price(model, overrides)
    return (tokens_in * p_in + tokens_out * p_out) / 1_000_000


def load_ledger(path: Path) -> list:
    return jsonstore.read_json(path, {"events": []}).get("events", [])


def save_ledger(path: Path, events: list):
    # keep ~1 month of history — enough for the longest window
    cutoff = time.time() - 32 * 86400
    events = [e for e in events if e.get("ts", 0) >= cutoff]
    jsonstore.atomic_write_json(path, {"events": events})


def record_usage(path: Path, agent_id: str, model: str, tokens_in: int,
                 tokens_out: int, cost: float):
    # RMW under the file lock so concurrent agent runs don't drop usage events
    # (the cost guardrail depends on every event being recorded).
    with jsonstore.lock_for(path):
        events = load_ledger(path)
        events.append({"agent_id": agent_id, "model": model, "ts": time.time(),
                       "tokens_in": tokens_in, "tokens_out": tokens_out,
                       "cost": round(cost, 6)})
        save_ledger(path, events)


def spent_in_window(path: Path, agent_id: str, period: str, now: float | None = None) -> float:
    window = PERIODS.get(period, PERIODS["day"])
    start = (now if now is not None else time.time()) - window
    return sum(e.get("cost", 0.0) for e in load_ledger(path)
               if e.get("agent_id") == agent_id and e.get("ts", 0) >= start)


def check_budget(path: Path, agent: dict, now: float | None = None):
    """Return (allowed: bool, spent: float, limit: float, period: str)."""
    limit = float(agent.get("budget_usd") or 0)
    period = agent.get("budget_period") or "day"
    if limit <= 0:
        return True, 0.0, 0.0, period
    spent = spent_in_window(path, agent.get("id", ""), period, now)
    return spent < limit, spent, limit, period


def limit_message(spent: float, limit: float, period: str) -> str:
    label = "rolling 30-day" if period == "month" else period
    return (f"⛔ **Budget limit reached** — this agent has spent "
            f"${spent:.2f} of its ${limit:.2f}/{label} allowance. "
            f"It will respond again when the {label} window rolls over, "
            f"or raise its budget on the Agents page.")
