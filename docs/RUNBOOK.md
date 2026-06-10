# Sentinel Agentic OS — Operations Runbook

Operational reference for running, monitoring, backing up, and recovering a
Sentinel Agentic OS instance. Sentinel is a **single-user, localhost** app
(binds `127.0.0.1`); it is not hardened for multi-tenant or public exposure.

## Run

```bash
./install.sh                 # one-time: venv + deps + dirs
.venv/bin/python server.py   # serves on 127.0.0.1:8899 by default
```

- First launch with **no users** → the dashboard shows the first-run **Setup
  wizard** (creates the admin, platform name, projects root). No console
  password is generated.
- `--host`/`--port` override the bind. **Do not bind `0.0.0.0`** without putting
  an authenticating reverse proxy in front — the setup window and CORS assume
  localhost.

## Health & monitoring

- `GET /api/health` (public, no auth) → `{status, scheduler_running,
  setup_complete, time}`. Use it for a liveness/readiness probe. If
  `scheduler_running` is false the 15s heartbeat (agent wakes, schedules,
  scheduled backups) is not running — restart the process.
- **Audit log**: `audit/audit.log` (JSONL), surfaced on the Audit page with
  actor + category filters. Rotates at ~5 MB to `audit.log.1` (one backup).
- **Active Sessions** (Dashboard): live provider subprocesses with a **Kill**
  button (SIGTERM→SIGKILL the process group) for a hung run, plus a
  **Release** button for a task stuck "running" with no live process.

## Backups

- Manual: Backups page → New Backup. Scheduled: Backups page → Schedule.
- A backup is a `.tar.gz` of all state (`data/ brain/ skills/ agents/ registry/
  standards/ prompts/ audit/`, optional project workspaces). The encryption
  **master key is never included** — same-machine restores are unaffected;
  cross-machine restores re-enter provider API keys once.
- Destinations: local folder, git repo (must be pre-cloned with auth), or
  remote host via `scp` (key-based SSH, pre-trusted).

## Restore

1. Backups page → Restore on the chosen archive (overwrites current state).
2. Reload the dashboard. If users were wiped, the Setup wizard reappears.
3. The heartbeat keeps running during restore; for a clean restore, restart the
   process afterward.

## Factory reset (Danger Zone)

- Wipes `data/ brain/ audit/ skills/ agents/ registry/` back to a clean
  install; **keeps `backups/` and the master key in place** and takes a final
  safety backup first. Triple-guarded (admin + type `RESET` + re-enter
  password). After it completes the Setup wizard reappears.

## Disaster recovery / data integrity

- All JSON stores write **atomically** (temp → fsync → `os.replace`) and keep a
  `.bak` of the prior good copy; reads fall back to `.bak` on corruption. A
  crash or disk-full mid-write leaves either the old or new file intact, never a
  truncated store, and a torn read cannot silently halt the heartbeat.
- Crash recovery: on startup, agent tasks stuck "running" are requeued and
  agents stuck "working" are released (`agent_tasks.recover`).
- If `data/agents_registry.json` is ever lost AND its `.bak` is gone, the
  registry reseeds the built-in agents on next start (`seed_default_agents`).

## Secrets

- Provider API keys are encrypted at rest (Fernet) under `data/.master.key`
  (gitignored, `0600`). Back up the key **separately/securely** if you need
  cross-machine secret portability; otherwise re-enter keys after a restore.
- The JWT signing secret is **derived** from the master key (domain-separated
  SHA-256, `agentic-os/jwt/v1:`), so the two purposes no longer share one raw
  secret. Override the session secret independently with `AGENTIC_OS_JWT_SECRET`
  (rotating it invalidates all live sessions but leaves encrypted secrets intact).

## Network exposure (single-user localhost is the design)

- Sentinel binds `127.0.0.1` by default and assumes a single local operator.
  A `TrustedHostMiddleware` allow-list rejects unexpected `Host` headers
  (defends the public setup window against DNS-rebinding); it defaults to
  localhost. To serve a routable interface you MUST declare hostnames/IPs via
  `AGENTIC_OS_ALLOWED_HOSTS` (comma-separated) **and** front it with TLS + an
  authenticating proxy — starting with a non-loopback `--host` prints a loud
  warning because the public `POST /api/setup` window becomes remotely reachable.

## By-design behaviours to be aware of (accepted, not bugs)

- **Project folder = agent working directory.** An operator who points a project
  at a filesystem path makes that path the agents' auto-edit cwd (claude
  `acceptEdits`, codex `workspace-write`). This is intended for project work but
  is **not a sandbox** — only point projects at directories you accept agents
  editing. Orchestrator-created folders are confined to `projects_root()`.
- **Chat orchestrator planner.** `POST /api/orchestrate` runs a planner pass that
  overrides the target agent's persona for decomposition and bills against the
  `claude_default` budget profile (not the individual agent's). Expected — the
  planner is a system role, not the agent answering in character.

## Known operational limits

- Single process; the heartbeat drains each due agent on its own thread but
  there is no horizontal scaling.
- Budgets/cost are **estimate-based** (~4 chars/token), a guardrail not an
  accounting system; legacy `/api/chat` is metered under `__chat__` and gated
  only if `settings.chat_budget` is set.
- Login has a per-IP brute-force throttle (5 fails → 60s lockout); there is no
  global rate limiter (localhost threat model).
