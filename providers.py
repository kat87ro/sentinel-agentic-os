"""Provider execution backends and configuration defaults.

Each provider runs in one of two modes:
  - ``cli``  — shell out to the provider's CLI (handled in server.execute_agent)
  - ``api``  — call the provider's HTTP API directly (Claude / Gemini here)

This module is pure: the API executors take an explicit ``api_key`` so they
carry no knowledge of the secret store or settings. server.py resolves config +
key and chooses the path.
"""
from __future__ import annotations

import httpx

ALLOWED_PROVIDERS = ["gemini", "claude", "codex", "opencode", "hermes"]

# Providers deliberately NOT onboarded because they fully overlap an existing
# one (one engine per backend — the metadata-driven rule). Kept here so a
# future "add provider X" request gets a clear answer instead of a duplicate.
EXCLUDED_PROVIDERS = {
    "chatgpt":     "overlaps 'codex' — same OpenAI backend; codex covers CLI mode "
                   "and api mode hits the OpenAI Chat Completions API (ChatGPT models).",
    "antigravity": "overlaps 'gemini' — Antigravity is a Gemini-powered IDE, not a "
                   "headless engine; the gemini provider covers CLI and API modes.",
}

# Providers that support mode="api" (direct HTTP) in addition to CLI.
API_CAPABLE = ("claude", "gemini", "codex")

# Wire formats a CUSTOM provider can speak. "openai" + a base_url covers most
# of the ecosystem (OpenRouter, Ollama, Groq, DeepSeek, Mistral, vLLM, ...).
API_FORMATS = ("openai", "anthropic", "gemini")

# Predefined catalog for the "Add Provider" flow — data-only presets. Each can
# run in token (api) mode; entries with a cli_template can also run in cli mode
# ({model} / {prompt} placeholders are substituted as whole argv tokens).
PROVIDER_CATALOG = [
    {"name": "openrouter", "label": "OpenRouter", "api_format": "openai",
     "base_url": "https://openrouter.ai/api/v1", "default_model": "deepseek/deepseek-chat",
     "key_ref": "env:OPENROUTER_API_KEY"},
    {"name": "ollama", "label": "Ollama (local)", "api_format": "openai",
     "base_url": "http://localhost:11434/v1", "default_model": "llama3.2",
     "key_optional": True, "cli_template": "ollama run {model} {prompt}"},
    {"name": "groq", "label": "Groq", "api_format": "openai",
     "base_url": "https://api.groq.com/openai/v1", "default_model": "llama-3.3-70b-versatile",
     "key_ref": "env:GROQ_API_KEY"},
    {"name": "deepseek", "label": "DeepSeek", "api_format": "openai",
     "base_url": "https://api.deepseek.com/v1", "default_model": "deepseek-chat",
     "key_ref": "env:DEEPSEEK_API_KEY"},
    {"name": "mistral", "label": "Mistral", "api_format": "openai",
     "base_url": "https://api.mistral.ai/v1", "default_model": "mistral-large-latest",
     "key_ref": "env:MISTRAL_API_KEY"},
    {"name": "xai", "label": "xAI Grok", "api_format": "openai",
     "base_url": "https://api.x.ai/v1", "default_model": "grok-4",
     "key_ref": "env:XAI_API_KEY"},
]

# Curated model lists for the built-in CLI providers (no discovery endpoint to
# query, unlike openai-format customs). Drives the model dropdown on the Agents
# page — the UI always keeps a free-text escape hatch, so a stale list is an
# inconvenience, not a blocker. Claude IDs are current aliases as of 2026-06
# (aliases are complete as-is; never append date suffixes).
KNOWN_MODELS = {
    "claude": [
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
    ],
    "gemini": [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
    ],
    "codex": [
        "gpt-5.1-codex",
        "gpt-5.1-codex-mini",
        "gpt-5.1",
    ],
    "opencode": [],
    "hermes": [],
}

# Default per-provider config; merged over by settings.json -> providers.
DEFAULT_PROVIDER_CONFIG = {
    "claude":   {"mode": "cli", "default_model": "claude-sonnet-4-6", "key_ref": "env:ANTHROPIC_API_KEY"},
    "gemini":   {"mode": "cli", "default_model": "gemini-2.5-flash",  "key_ref": "env:GEMINI_API_KEY"},
    "codex":    {"mode": "cli", "default_model": "gpt-5.1-codex",     "key_ref": "env:OPENAI_API_KEY"},
    "opencode": {"mode": "cli", "default_model": "", "key_ref": ""},
    "hermes":   {"mode": "cli", "default_model": "", "key_ref": ""},
}

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"


def execute_claude_api(message: str, model: str, system_prompt: str, api_key: str,
                       timeout: int = 120, max_tokens: int = 2048) -> str:
    """Anthropic Messages API. Returns the assistant text or a friendly error."""
    if not api_key:
        return "**Claude API key not set** — add one on the Providers page or set ANTHROPIC_API_KEY."
    payload = {
        "model": model or DEFAULT_PROVIDER_CONFIG["claude"]["default_model"],
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": message}],
    }
    if system_prompt:
        payload["system"] = system_prompt
    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }
    try:
        r = httpx.post(ANTHROPIC_URL, json=payload, headers=headers, timeout=timeout)
    except httpx.HTTPError as e:
        return f"⚠ Claude API request failed: {e}"
    if r.status_code != 200:
        detail = _err_detail(r)
        if r.status_code in (401, 403):
            return f"**Claude auth error** — check the API key.\n\n{detail}"
        return f"Claude API error {r.status_code}: {detail}"
    try:
        parts = r.json().get("content", [])
        text = "".join(p.get("text", "") for p in parts if p.get("type") == "text")
        return text.strip() or "(empty response)"
    except Exception as e:
        return f"⚠ Could not parse Claude response: {e}"


def execute_gemini_api(message: str, model: str, system_prompt: str, api_key: str,
                       timeout: int = 60) -> str:
    """Google Generative Language API (generateContent)."""
    if not api_key:
        return "**Gemini API key not set** — add one on the Providers page or set GEMINI_API_KEY."
    model = model or DEFAULT_PROVIDER_CONFIG["gemini"]["default_model"]
    url = GEMINI_URL.format(model=model)
    payload = {"contents": [{"role": "user", "parts": [{"text": message}]}]}
    if system_prompt:
        payload["systemInstruction"] = {"parts": [{"text": system_prompt}]}
    try:
        r = httpx.post(url, params={"key": api_key}, json=payload, timeout=timeout)
    except httpx.HTTPError as e:
        return f"⚠ Gemini API request failed: {e}"
    if r.status_code != 200:
        detail = _err_detail(r)
        if r.status_code in (401, 403):
            return f"**Gemini auth error** — check the API key.\n\n{detail}"
        return f"Gemini API error {r.status_code}: {detail}"
    try:
        cands = r.json().get("candidates", [])
        if not cands:
            return "(no candidates returned)"
        parts = cands[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)
        return text.strip() or "(empty response)"
    except Exception as e:
        return f"⚠ Could not parse Gemini response: {e}"


def execute_openai_api(message: str, model: str, system_prompt: str, api_key: str,
                       timeout: int = 120, max_tokens: int = 2048,
                       base_url: str = "") -> str:
    """OpenAI Chat Completions API — the api mode of the ``codex`` provider
    (covers ChatGPT models; see EXCLUDED_PROVIDERS). Custom providers reuse it
    with their own ``base_url`` (any OpenAI-compatible endpoint)."""
    if not api_key:
        return "**OpenAI API key not set** — add one on the Providers page or set OPENAI_API_KEY."
    msgs = []
    if system_prompt:
        msgs.append({"role": "system", "content": system_prompt})
    msgs.append({"role": "user", "content": message})
    payload = {
        "model": model or DEFAULT_PROVIDER_CONFIG["codex"]["default_model"],
        "max_completion_tokens": max_tokens,
        "messages": msgs,
    }
    headers = {"Authorization": f"Bearer {api_key}", "content-type": "application/json"}
    url = (base_url.rstrip("/") + "/chat/completions") if base_url else OPENAI_URL
    try:
        r = httpx.post(url, json=payload, headers=headers, timeout=timeout)
    except httpx.HTTPError as e:
        return f"⚠ OpenAI API request failed: {e}"
    if r.status_code != 200:
        detail = _err_detail(r)
        if r.status_code in (401, 403):
            return f"**OpenAI auth error** — check the API key.\n\n{detail}"
        return f"OpenAI API error {r.status_code}: {detail}"
    try:
        choices = r.json().get("choices", [])
        if not choices:
            return "(no choices returned)"
        text = (choices[0].get("message") or {}).get("content") or ""
        return text.strip() or "(empty response)"
    except Exception as e:
        return f"⚠ Could not parse OpenAI response: {e}"


def execute_api(api_format: str, message: str, model: str, system_prompt: str,
                api_key: str, base_url: str = "", timeout: int = 120) -> str:
    """Dispatch to the right wire-format executor — used by CUSTOM providers."""
    if api_format == "anthropic":
        return execute_claude_api(message, model, system_prompt, api_key, timeout=timeout)
    if api_format == "gemini":
        return execute_gemini_api(message, model, system_prompt, api_key, timeout=timeout)
    return execute_openai_api(message, model, system_prompt, api_key,
                              timeout=timeout, base_url=base_url)


def list_models(api_format: str, base_url: str, api_key: str = "",
                timeout: int = 15) -> list:
    """Model discovery for OPENAI-format providers: GET {base_url}/models.
    Works for local servers (Ollama, LM Studio, vLLM — Ollama exposes its
    installed models here) and hosted ones (OpenRouter, Groq) with a key.
    Anthropic/Gemini formats have no comparable public listing — raises
    ValueError so the caller can answer honestly."""
    if api_format != "openai":
        raise ValueError(f"model discovery is only supported for the 'openai' "
                         f"API format (got '{api_format}')")
    if not base_url:
        raise ValueError("provider has no base_url configured")
    headers = {"content-type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    # fail fast on a non-listening host (connect=5s) instead of holding the
    # operator's discovery click for the full read window
    r = httpx.get(base_url.rstrip("/") + "/models", headers=headers,
                  timeout=httpx.Timeout(timeout, connect=5))
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {_err_detail(r)}")
    body = r.json()
    items = body.get("data") if isinstance(body, dict) else body
    out = []
    for m in items or []:
        mid = m.get("id") if isinstance(m, dict) else str(m)
        if mid:
            out.append(mid)
    return sorted(out)


def _err_detail(r) -> str:
    try:
        body = r.json()
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                return str(err.get("message") or err)[:300]
            return str(err or body)[:300]
    except Exception:
        pass
    return (r.text or "")[:300]
