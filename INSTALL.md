# Installing Sentinel Agentic OS

This is a **clean deployment bundle** — all source, frontend, default seeds, and
docs, with **no user data** (no users, projects, tasks, keys, or history). On
first launch it generates its own encryption key and drops you into a browser
**Setup Wizard** to create the first admin.

> **Threat model:** Sentinel is designed for a **single operator on localhost**.
> It binds `127.0.0.1` by default. Read [Network exposure](#5-network-exposure-important)
> before binding anything routable.

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Python 3.10+** | `python3 --version`. Core runtime (FastAPI + uvicorn). |
| **pip** | Bundled with Python; `python3 -m ensurepip --upgrade` if missing. |
| **A modern browser** | Chrome/Edge/Safari/Firefox. The dashboard is a single-page app. |
| *(optional)* **Provider CLIs/keys** | You only need the engines you intend to use — see step 4. |

The platform runs with **zero provider credentials** — you can explore the whole
dashboard first and wire up engines later. Nothing leaves the machine until you
configure a provider and run a task.

---

## 2. Install

```bash
cd <this-folder>          # the __deploy bundle
./install.sh              # checks Python, installs deps, creates runtime dirs
```

`install.sh` is non-destructive. It:
- verifies Python/pip,
- installs `requirements.txt` into the active environment,
- probes optional engine CLIs (opencode / Gemini / Hermes) and prints install hints,
- creates the runtime dirs (`data/`, `audit/`, `backups/`).

### Recommended: use a virtual environment

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

---

## 3. First launch & Setup Wizard

```bash
./start.sh                 # or:  python3 server.py --port 8080
```

Then open **http://127.0.0.1:8080**.

Because there are no users yet, the platform is in **OPEN (setup) mode** and the
dashboard shows the **Setup Wizard**. Complete it to:

1. **Create the first admin** (username + password, min 8 chars). This is stored
   hashed with **argon2** — never in plaintext.
2. Set the **platform name** and **projects root** (the parent folder under which
   agent project workspaces are created).

On submit, the server issues your session cookie and you land on the dashboard.
From this moment auth is **active**: every `/api/*` call requires a valid session
and is authorized by RBAC (admin / operator / viewer).

> The first boot also generates `data/.master.key` (Fernet, `0600`) — the local
> encryption key for provider secrets. It is **machine-local and gitignored**.
> Back it up separately only if you need cross-machine secret portability.

---

## 4. Connect provider engines (optional, per engine)

Sentinel orchestrates five engine families. Configure only what you use, from the
**Providers** page in the dashboard.

| Engine | How to enable |
|--------|---------------|
| **Claude** | Install Claude Code CLI, or add an Anthropic API key as a custom provider. |
| **Codex** (OpenAI) | OpenAI/Codex CLI or API key. Covers the ChatGPT/OpenAI backend. |
| **Gemini** | `npm i -g @google/gemini-cli` then `gemini` (OAuth in browser), or a Google API key. |
| **opencode** | `npm i -g @opencode/cli` (Node 18+). Local code/DevOps engine. |
| **Hermes** | NousResearch Hermes agent (memory/scheduling). |
| **Custom / local** | Add from the catalog (OpenRouter, Ollama, Groq, DeepSeek, Mistral, xAI) or fully custom — **token mode** (API key) or **CLI mode** (command template). Ollama runs fully local. |

API keys are encrypted at rest with the master key. Each provider can be
activated/deactivated/deleted from the UI; disabled providers are excluded from
health and routing.

---

## 5. Network exposure (important)

By default the server binds the loopback interface and a `TrustedHost` allow-list
rejects unexpected `Host` headers. To deliberately serve a routable interface:

```bash
# declare the hostnames/IPs you will serve, THEN bind the interface
export AGENTIC_OS_ALLOWED_HOSTS="myhost.local,10.0.0.5"
python3 server.py --host 0.0.0.0 --port 8080
```

A non-loopback `--host` prints a loud warning. If you expose it, you **must**:
- set `AGENTIC_OS_ALLOWED_HOSTS`,
- front it with **TLS + an authenticating reverse proxy**,
- complete first-run setup **immediately** (the setup endpoint is public until
  the first admin exists).

### Environment variables

| Variable | Purpose |
|----------|---------|
| `AGENTIC_OS_ALLOWED_HOSTS` | Comma-separated `Host` allow-list (default: localhost). |
| `AGENTIC_OS_JWT_SECRET` | Override the session-signing secret. By default it is derived (domain-separated SHA-256) from the master key, so sessions and encrypted secrets use independent secrets. Rotating this forces re-login but leaves encrypted secrets intact. |
| `AGENTIC_OS_TOKEN` | Optional static API token accepted via `X-Auth-Token` / `Authorization: Bearer`. |

---

## 6. Verify the install

```bash
# health check (public endpoint)
curl -s http://127.0.0.1:8080/api/health
# → {"status":"ok","scheduler_running":true,"setup_complete":false,...}
```

`setup_complete:false` before you run the wizard is expected. After creating the
admin it flips to `true`.

---

## 7. Operations

| Task | Command / location |
|------|--------------------|
| Start | `./start.sh` or `python3 server.py --port <port>` |
| Stop | `./stop.sh` (graceful SIGTERM, then SIGKILL if needed), or `Ctrl+C` in the foreground |
| Backup | **Backups** page (full `tar.gz` of state; local/git/scp destinations), or `./backup.sh` |
| Restore | **Backups** page → Restore, or `./restore.sh` |
| Factory reset | **Danger Zone** page (triple-guarded; preserves the master key + backups) |
| Runbook (DR, limits) | [`docs/RUNBOOK.md`](docs/RUNBOOK.md) |

---

## 8. Troubleshooting

- **Port already in use** → start with a different `--port`.
- **"Not authenticated" on every call** → setup is complete and you have no
  session; log in again. The session cookie is `agentic_token`.
- **Forgot the admin password** → there is no email reset (single-user localhost).
  Use **Danger Zone → Factory Reset** (re-runs the Setup Wizard, keeps backups),
  or restore from a backup, or — if you must — remove `data/users.json` to drop
  back into OPEN/setup mode (this wipes all accounts).
- **A provider shows unhealthy** → confirm its CLI is installed/on `PATH` or its
  API key is set on the Providers page; disabled providers are skipped on purpose.
- **Heartbeat not running tasks** → check the **Dashboard → Active Sessions** and
  **Agent Health** panels; the scheduler ticks every 15s.

---

## What's in this bundle

```
server.py            FastAPI app (REST API + serves the dashboard)
*.py                 Engine modules: auth, jsonstore, budgets, schedules,
                     plugins, providers, backup_engine, memory_vault, …
dashboard/           Vanilla-JS single-page dashboard (pages/, components, utils)
skills/              Default skill packs (executable, eval-scored)
prompts/             Reusable prompt templates
standards/           Coding-standard profiles
agents/              Engine config templates (gemini/hermes/opencode)
registry/            Plugin registry + marketplace catalog
brain/               Memory-vault seeds (constitution, identity, governance)
docs/                RUNBOOK (operations & disaster recovery)
data/ audit/ backups/   empty runtime dirs (generated on first run)
install.sh start.sh stop.sh backup.sh restore.sh   helper scripts
requirements.txt README.md                         deps + overview
LICENSE.md (AGPLv3) NOTICE.md TRADEMARK.md CONTRIBUTING.md DISCLAIMER.md   legal/governance
```

`data/`, `audit/`, `backups/`, and the personal layers of `brain/` are
gitignored and start empty — this bundle ships **no accounts, keys, projects,
tasks, or history**.
