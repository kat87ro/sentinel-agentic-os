<div align="center">
  <br/>
  <img src="https://img.shields.io/badge/license-AGPL%20v3-blue.svg" alt="License: AGPL v3"/>
  <img src="https://img.shields.io/badge/python-3.10+-blue.svg" alt="Python 3.10+"/>
  <img src="https://img.shields.io/badge/FastAPI-0.115+-green.svg" alt="FastAPI"/>
  <img src="https://img.shields.io/badge/engines-5-orange.svg" alt="5 Engines"/>
  <img src="https://img.shields.io/badge/dashboard%20pages-25-purple.svg" alt="25 Pages"/>
  <br/><br/>
  <strong>⭐ Enjoying Sentinel? A star would genuinely make my day — and helps others discover it. Thank you! 🙏</strong>
  <br/><br/>
</div>

# Sentinel Agentic OS 🛰

> ## ⚠️ Cost warning — read before you run it
> Sentinel runs autonomous agents on **your own AI-provider API keys**. A 15-second
> heartbeat, scheduled jobs, and multi-agent delegation can consume tokens **with
> no one watching**. The built-in budgets are **estimate-based guardrails, not a
> hard financial cap** — concurrent or automated activity can overshoot before
> enforcement. **You are responsible for all token usage and charges.**
>
> **Before running:** set hard spending limits and billing alerts **on your
> provider's side** (OpenAI/Anthropic/Google/etc.), start with cheap or local
> models, and don't leave it running unattended until you trust your configuration.
> See [DISCLAIMER.md](DISCLAIMER.md). This is **AGPLv3 software provided “as is,”
> with no warranty.**

**A locally-hosted operating system for AI agents.** One dashboard, one memory
layer, one scheduler — coordinating Claude, Codex, Gemini, opencode, and Hermes
into a self-running multi-agent platform. FastAPI backend + a dependency-free
vanilla-JS single-page dashboard. Binds `127.0.0.1`, single-operator by design.

> Most agent tools work in isolation — a terminal for code, a chat for research,
> another thing for memory. Sentinel is the **control plane** that unifies them:
> agents are processes, the heartbeat is the scheduler, the brain is shared
> memory, and every action is audited.

📦 **New here? Read [INSTALL.md](INSTALL.md).** This README explains *what the
platform does*; INSTALL explains *how to stand it up*.

---

## How it works (the mental model)

```
                       ┌───────────────────────────────────────────┐
   Browser SPA  ◀────▶ │   FastAPI server.py  (REST + static SPA)    │
   (dashboard/)        │                                             │
                       │  Auth (argon2 + JWT cookie) · RBAC          │
                       │  ┌─────────────────────────────────────┐    │
                       │  │ Heartbeat ticker (APScheduler, 15s)  │    │
                       │  │  drains each agent's task queue on    │    │
                       │  │  its own thread; runs due schedules   │    │
                       │  │  & backups                            │    │
                       │  └─────────────────────────────────────┘    │
                       │                                             │
                       │  Agent profiles ── route ──▶ Provider       │
                       │  (registry)                  engines (CLI/  │
                       │                              API)           │
                       └───────────────┬─────────────────────────────┘
                                       │
        ┌───────────┬───────────┬──────┴──────┬───────────┬───────────┐
     Claude       Codex       Gemini       opencode      Hermes     custom/
   (reasoning/   (OpenAI     (research/   (code/        (memory/    local
    engineering)  code)       analysis)    DevOps)       sched)     Ollama…)
                                       │
                          ┌────────────┴────────────┐
                       brain/ (shared memory)   data/ (state: tasks,
                       constitution, identity,  projects, kanban, goals,
                       journal, per-project     budgets, audit, secrets)
                       scoped memory
```

- **Agent profiles ≠ providers.** A *profile* (in the registry) is a persona +
  routing + budget; a *provider* is the actual engine (a CLI command or an API).
  Profiles route to providers, so you can have many personas on one engine.
- **Agents sleep; the heartbeat wakes them.** Work is queued as tasks. Every 15s
  the ticker drains each agent's queue **on its own daemon thread** (one slow CLI
  never blocks the others), honoring delegation markers and a per-wake task cap.
- **Everything is a file.** State lives in `data/` (JSON stores with atomic
  writes + per-file locks + `.bak` recovery) and `brain/` (markdown memory).
  Provider secrets are Fernet-encrypted at rest.

---

## The 7-layer architecture

Everything above resolves to **seven core layers**. Each is a real, independent
subsystem (its own module + dashboard surface), but they compose into one loop:
the lower layers *define who the agent is and what it knows*, the middle layers
*decide and do the work*, and the top layers *keep it running and make it better
over time*.

```
              ┌────────────────────────────────────────┐
              │        7 CORE LAYERS (stacked)           │
              │  Layer 7: Identity / Persona             │  who the agent is
              │  Layer 6: Self-Evolution                 │  gets better over time
              │  Layer 5: Scheduler + Health             │  keeps itself running
              │  Layer 4: Memory Graph                   │  linked knowledge
              │  Layer 3: Skills Hub + Eval              │  what it can do
              │  Layer 2: Business Brain                 │  what it knows
              │  Layer 1: Agent Router                   │  who does the work
              └────────────────────────────────────────┘
```

> The stack is a **conceptual lens on the data flow**, not a strict import
> hierarchy. Identity, Business Brain, and the Memory Graph feed context into the
> Router; the Router dispatches work the Scheduler drives; Self-Evolution feeds
> the outcome back into memory. Read it as a cycle, not a one-way ladder.

| # | Layer | What it is | Why it matters (the benefit) |
|---|-------|-----------|------------------------------|
| **7** | **Identity / Persona** | Per-agent system prompt + persona, on top of a global `constitution.md` / `identity.md`. | Behaviour is **configuration, not code** — many distinct specialists on one engine, all governed by one constitution. Change the persona, not the platform. |
| **6** | **Self-Evolution** | After every task settles, a reflection step extracts lessons to `agents/<id>/learnings.md` and injects them into future prompts. | The system **compounds** — agents stop repeating mistakes and carry forward what worked, without you hand-editing prompts. Toggleable (it costs one extra LLM call per task). |
| **5** | **Scheduler + Health** | 5-field cron / interval jobs fired by the 15s heartbeat, plus two-layer health (engine reachable + agent runtime) and on-demand wake. | The OS is **self-running and observable** — recurring work happens unattended, a hung CLI is visible and killable, and a corrupt store can't silently halt the loop. |
| **4** | **Memory Graph** | A `[[wikilink]]`-connected markdown vault with backlinks and depth-N traversal — global, per-project, and per-agent. | Context is **relational, not a flat dump**: a task seeds from its skills + keywords and pulls in linked notes one hop out, so agents get *relevant* memory, not everything. |
| **3** | **Skills Hub + Eval** | Executable skill packs (`SKILL.md`) that are created/edited from the UI and scored per run with history. | Capabilities are **portable, inspectable, and measurable** — you can see which skills actually perform and improve them, instead of opaque hard-coded behaviour. |
| **2** | **Business Brain** | The global knowledge layer — constitution, identity, business context, recent decisions, constraints — injected into agent context. | Every agent shares **one source of organisational truth and guardrails**, so decisions stay consistent and on-policy across the whole fleet. |
| **1** | **Agent Router** | Scores every agent profile for a task (skill ×3, persona ≤+5, track-record ±2, budget-exhausted −10) and enqueues the work to the winner. | Work goes to the **right agent for explainable reasons** (every score shows its rationale), and budget-exhausted agents are automatically routed around — no manual dispatch, no runaway spend. |

**The compounding benefit:** no single layer is novel on its own — the value is the
loop. Identity + Business Brain + Memory Graph give an agent grounded context;
the Router picks who acts; Skills define what they can do; the Scheduler keeps it
running and healthy; and Self-Evolution feeds the result back into memory so the
next run starts smarter. That closed loop is what turns a pile of CLIs into an
*operating system* for agents.

---

## Feature tour (by dashboard page)

The sidebar groups 25 pages into Main · Projects · Automation · Monitoring · System.

### 🧠 Core & orchestration
| Page | What it does |
|------|--------------|
| **Dashboard** | Mission control — agent roster, active projects, and an **Active Sessions** panel that lists live provider CLI processes and lets an operator **kill** a runaway run (linked tasks then fail through the normal pipeline). |
| **AI Chat** | Talk to any agent or the orchestrator. Includes a **Jarvis voice mode** (Web Speech API, en-US/ro-RO) — speak to an agent, hear it back. The chat orchestrator can turn a single message into a project + a decomposed task plan. Metered under a synthetic ledger id; optionally budget-gated. |
| **Agents** | The agent **profile registry** — persona, system prompt, routed provider, and budget per profile. 5 core profiles ship by default (Claude, Codex, Gemini, opencode, Hermes). |
| **Teams** | Compose agents into a hierarchy (manager + members) shown as an org chart. A project's team Lead receives recalibration tasks when its goal changes. |
| **Smart Router** | Scores agent profiles for a task (skill match ×3, persona fit, track record ±2, budget-exhausted −10) and actually enqueues the work to the winner. |

### 📂 Projects & work
| Page | What it does |
|------|--------------|
| **Projects** | Each project has a **scoped memory layer** (`brain/projects/<slug>/`) and its folder becomes the agents' working directory (claude `acceptEdits`, codex `workspace-write`). A **Browse** button picks the folder via a home-confined file picker. Agents write real files here — it is a workspace, not a sandbox. |
| **Goals** | Project targets. Progress is **derived** from kanban cards (only `done` counts; `failed` excluded) and auto-syncs to `brain/active-projects.md`. |
| **Kanban** | Visual board (triage → todo → ready → in_progress → blocked → done). Create/move/block/unblock/complete cards; status is validated against the column enum so a card can't vanish. **Decompose** a card into linked child cards (idempotent). Delete is refused while an open run holds the card. |
| **Inbox** | The human-in-the-loop queue. When an agent emits `[NEEDS_INPUT]`, the task parks here; your reply resumes it. |

### ⚙️ Automation
| Page | What it does |
|------|--------------|
| **Scheduler** | Recurring agent tasks — 5-field cron (Mon=0) with a 62-day unfireable-cron guard, or an interval (5-min floor). Fired by the 15s ticker; a manual run doesn't shift the recurrence. Full CRUD. |
| **Skills** | Executable **skill packs** (`skills/<name>/SKILL.md`). Create/edit/deactivate from the UI; run with eval scoring and per-run score history. Ships ~20 skills (code-review, research, systematic-debug, tdd-cycle, project-planner, memory-consolidation, daily-standup, and more). |
| **Plugins** | Plugins are **capability packs**: a manifest bundles an MCP server + skills + prompts + config schema + permissions. Install from the built-in **marketplace** (filesystem / fetch / git MCP) or upload a `.zip` bundle (zip-slip + decompression-bomb guarded). Install wires components into the real MCP/skills/prompts registries with clean provenance-tracked unwiring. |
| **MCP** | Manage Model Context Protocol servers. Proven live: an agent invoking `mcp__filesystem__*` tools — Claude headless runs receive `--allowedTools` so MCP tools are actually usable. |
| **Prompts** | A library of reusable prompt templates (code review, project plan, brainstorm, standup, debug incident, research…). |
| **Standards** | Coding-standard profiles that can be injected into agent context. |

### 📊 Monitoring
| Page | What it does |
|------|--------------|
| **Cost Analytics** | Real spend from the budget ledger — by provider, model, and agent. Estimate-based (~4 chars/token) guardrail, not an accounting system. |
| **Agent Health** | Two-layer health: provider engine availability (CLI/API reachable) + agent runtime state. **Wake** an agent on demand. |
| **Learning Analytics** | Skill evaluation scores, trends, and history. Backed by the self-learning loop: a post-task reflection writes `brain/agents/<id>/learnings.md`, injected into future prompts (admin-toggleable — it adds a metered LLM call per settled task). |
| **Memory** | Mirrors the real memory vault layers (constitution, identity, business brain, decisions, per-project, journal) and previews the exact context injected at session start. |
| **Journal** | Daily markdown entries (`brain/journal/YYYY-MM-DD.md`) with full-text search. |
| **Audit** | Every action logged with an actor (background work attributed to `system`). Rotates at 5 MB. |

### 🔧 System
| Page | What it does |
|------|--------------|
| **Providers** | Add/configure engines from a catalog (OpenRouter, Ollama, Groq, DeepSeek, Mistral, xAI) or fully custom — **token mode** (API key, Fernet-encrypted) or **CLI mode** (command template). Activate/deactivate/delete. Also hosts **Platform & Integrations**: platform name, projects root, and Claude `~/.claude` mirror sync. |
| **Users** | Account management with three RBAC roles — **admin** (everything), **operator** (read all + run/dispatch work), **viewer** (read-only). |
| **Backups** | One-click full state snapshot (`tar.gz` of data/brain/skills/agents/registry/standards/prompts/audit; optional project workspaces; **never the master key**). Destinations: local / git / scp. Restore with path-traversal guards. Schedulable via the heartbeat. |
| **Danger Zone** | Triple-guarded factory reset (admin RBAC + type `RESET` + re-enter password). Auto safety-backup first, preserves `data/.master.key` and `backups/`, then drops back into the Setup Wizard. |

---

## 💰 Budgets & cost control

Per-agent **$ allowance** over a rolling hour / day / 30-day window, enforced on
every **profile dispatch** (tasks, teams, projects, inbox) — a budget-exhausted
profile is penalized by the router and blocked at execution. The basic Chat page
talks to raw providers and is metered under a synthetic `__chat__` id, gated only
if you set a chat budget. Cost Analytics reads the **same real ledger** the gate
writes — no separate "test" data model.

---

## 🔐 Security & trust model

Sentinel assumes a **single operator on localhost**. The realistic adversary is
**agent-controlled content reaching your own browser** and **cost runaway on your
own keys** — not a remote attacker. Hardening in place:

- **Auth:** argon2 password hashing, JWT session cookie (`agentic_token`), full
  RBAC on every `/api/*` route. First run shows a **Setup Wizard**; the public
  setup endpoint hard-refuses once any user exists (TOCTOU-safe under a file lock).
- **Secrets:** provider keys Fernet-encrypted under `data/.master.key` (`0600`,
  gitignored). The JWT signing secret is **domain-separated** from the master key
  (independent rotation; `AGENTIC_OS_JWT_SECRET` to override).
- **XSS-hardened:** all agent/file-controlled content rendered via a delegated
  `data-*` action dispatcher (no inline-`onclick` interpolation), bodies escaped.
- **Network:** `TrustedHostMiddleware` allow-list + a loud warning when `--host`
  is non-loopback (`AGENTIC_OS_ALLOWED_HOSTS` to declare served hosts).
- **Data integrity:** every JSON store uses atomic writes (tmp + fsync +
  `os.replace`) + per-file locks + `.bak` recovery, so a torn write can't corrupt
  state or halt the scheduler.
- **Resilience:** per-IP login brute-force throttle, audit-log rotation, bundle
  zip-slip + decompression-bomb guards, scp/git option-injection guards.

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for operations, disaster recovery, and the
accepted by-design behaviours under this threat model.

---

## 🚀 Quick start

**Prerequisites:** Python 3.10+ and `git`. (Provider CLIs/keys are optional — you
can explore the whole dashboard first and wire engines up later.)

### Clone & install

```bash
# 1. Clone the repository
git clone https://github.com/kat87ro/sentinel-agentic-os.git
cd sentinel-agentic-os

# 2. Create and activate a virtual environment (recommended)
python3 -m venv .venv
source .venv/bin/activate                # Windows: .venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt
#   …or use the helper, which also checks Python and creates runtime dirs:
#   ./install.sh

# 4. Start the server
./start.sh                               # → http://127.0.0.1:8080
#   …or directly:  python3 server.py --port 8080

# 5. Open http://127.0.0.1:8080 and complete the Setup Wizard
#    (creates the first admin; the encryption key is generated on first run)

# Stop the server when you're done
./stop.sh
```

> First launch starts in **setup mode** (no users yet) and shows the Setup Wizard.
> After you create the admin, authentication is active on every `/api/*` route.

Full prerequisites, provider-engine setup, network-exposure guidance, and
troubleshooting are in **[INSTALL.md](INSTALL.md)**.

---

## 🧱 Tech stack

- **Backend:** Python 3.10+, FastAPI, uvicorn, APScheduler, Pydantic, cryptography
  (Fernet), PyJWT, argon2-cffi, httpx.
- **Frontend:** dependency-free vanilla-JS SPA (no build step) — `dashboard/`.
- **Storage:** JSON document stores + markdown memory vault on the local
  filesystem. No external database required.

---

## 📄 License

**GNU AGPLv3 — © 2026 Catalin-Adrian Tudor.** This is free, open-source software:
you may use, study, modify, and self-host it under the terms of the [GNU Affero
General Public License v3.0](LICENSE.md). Because it's the *Affero* GPL, if you run
a modified version as a network service, you must make your modified source
available to its users. See [NOTICE.md](NOTICE.md) for attribution and
[CONTRIBUTING.md](CONTRIBUTING.md) — a CLA is required to contribute.

The **name and logo are trademarks** and are not covered by the code license — see
[TRADEMARK.md](TRADEMARK.md) (forks must rebrand). A separate **commercial edition**
is offered under proprietary terms; for commercial licensing, hosted, or enterprise
use, contact **catalin.adrian.tudor@gmail.com**.

> ⚠️ **Cost disclaimer:** the Software runs on **your** AI-provider keys and the
> author is **not responsible for any token usage, bursts, or charges** it incurs
> — the in-app budgets are estimate-based guardrails, not a hard financial cap.
> You are responsible for your own provider-side spending limits and for
> supervising automated activity. See [DISCLAIMER.md](DISCLAIMER.md).
