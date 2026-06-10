// Providers — built-in engines (CLI/API mode) + custom API providers
// (OpenAI-compatible / Anthropic / Gemini wire formats). Add, deactivate,
// delete (custom only), set models, and store keys encrypted.

const PROVIDER_META = {
  gemini:   { icon: `${icon('cpu', 13)}`, label: 'Gemini', color: 'blue' },
  claude:   { icon: `${icon('sparkle', 13)}`, label: 'Claude', color: 'accent' },
  codex:    { icon: `${icon('orbit', 13)}`, label: 'Codex', color: 'green' },
  opencode: { icon: `${icon('wrench', 13)}`, label: 'OpenCode', color: 'purple' },
  hermes:   { icon: `${icon('zap', 13)}`, label: 'Hermes', color: 'green' },
};

const API_FORMATS = [
  { id: 'openai', label: 'OpenAI-compatible (OpenRouter, Ollama, Groq…)' },
  { id: 'anthropic', label: 'Anthropic Messages' },
  { id: 'gemini', label: 'Google Gemini' },
];

async function renderProviders() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Providers</div>
        <div class="page-subtitle">Built-in engines + custom API providers — add, deactivate, set keys</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showAddProviderModal()">+ Add Provider</button>
        <button class="btn btn-ghost" onclick="renderProviders()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="grid grid-2" id="providerList" style="align-items:start">${renderSkeleton(4)}</div>
    <div class="sec-hd" style="margin-top:22px"><h2>Platform &amp; Integrations</h2><span class="line"></span></div>
    <div id="platformPanel" class="grid grid-2"><div class="skeleton" style="height:120px"></div></div>
  `;
  loadPlatformPanel();
  try {
    const data = await api.getProviders();
    const list = document.getElementById('providerList');
    if (!list) return;
    list.innerHTML = (data.providers || []).map(p => {
      const m = PROVIDER_META[p.name] || { icon: `${icon('orbit', 13)}`, label: p.label || p.name, color: 'accent' };
      const disabled = p.enabled === false;
      return `
        <div class="card" style="${disabled ? 'opacity:.55' : ''}">
          <div class="flex items-center justify-between" style="margin-bottom:12px">
            <div style="display:flex;align-items:center;gap:10px">
              <div class="agent-avatar" style="background:var(--${m.color}-dim,var(--accent-glow));color:var(--${m.color},var(--accent-light))">${m.icon}</div>
              <div>
                <div class="card-title" style="margin:0">${escapeHtml(m.label)}</div>
                <div style="display:flex;gap:6px;margin-top:2px">
                  ${p.custom ? '<span class="badge badge-accent">custom</span>' : '<span class="badge badge-info">built-in</span>'}
                  ${disabled ? '<span class="badge badge-danger">disabled</span>' : ''}
                </div>
              </div>
            </div>
            <span class="badge ${p.key_set ? 'badge-success' : p.key_optional ? 'badge-info' : 'badge-warning'}">${p.key_set ? `${icon('key', 13)} key set` : p.key_optional ? 'local · no key needed' : 'no key'}</span>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Mode</label>
              <select class="form-select" id="mode_${p.name}" ${p.api_capable || p.custom ? '' : 'disabled'}>
                ${p.custom
                  ? `<option value="api" ${p.mode !== 'cli' ? 'selected' : ''}>API (token)</option>
                     <option value="cli" ${p.mode === 'cli' ? 'selected' : ''}>CLI (command template)</option>`
                  : `<option value="cli" ${p.mode === 'cli' ? 'selected' : ''}>CLI (subprocess)</option>
                     <option value="api" ${p.mode === 'api' ? 'selected' : ''}>API key</option>`}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Default model</label>
              <div style="display:flex;gap:6px">
                <input class="form-input" id="model_${p.name}" style="flex:1" value="${escapeHtml(p.default_model || '')}" placeholder="model id" list="models_${p.name}">
                <datalist id="models_${p.name}"></datalist>
                ${p.custom && p.api_format === 'openai' ? `<button class="btn btn-ghost" type="button" title="List the models this endpoint actually serves (for Ollama: your installed models)" onclick="loadProviderModels('${p.name}')">${icon('download', 13)}</button>` : ''}
              </div>
              <div class="form-hint" id="modelsHint_${p.name}"></div>
            </div>
          </div>
          ${p.custom ? `
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">API format</label>
              <select class="form-select" id="fmt_${p.name}">
                ${API_FORMATS.map(f => `<option value="${f.id}" ${p.api_format === f.id ? 'selected' : ''}>${f.label}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Base URL <span class="text-muted text-xs">(openai format)</span></label>
              <input class="form-input" id="url_${p.name}" value="${escapeHtml(p.base_url || '')}" placeholder="https://openrouter.ai/api/v1">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">CLI command template <span class="text-muted text-xs">(cli mode — must include {prompt})</span></label>
            <input class="form-input" id="cli_${p.name}" value="${escapeHtml(p.cli_template || '')}" placeholder="ollama run {model} {prompt}">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Request timeout (s) <span class="text-muted text-xs">(raise for slow local models, 10–1200)</span></label>
              <input class="form-input" id="timeout_${p.name}" type="number" min="10" max="1200" value="${p.timeout_seconds || 120}">
            </div>
            <div class="form-group" style="display:flex;align-items:flex-end;padding-bottom:6px">
              <label class="check-chip" title="Local OpenAI-compatible servers (Ollama, LM Studio, vLLM) ignore auth">
                <input type="checkbox" id="keyopt_${p.name}" ${p.key_optional ? 'checked' : ''}> Local endpoint — no API key required
              </label>
            </div>
          </div>` : ''}
          ${p.api_capable ? `
          <div class="form-group">
            <label class="form-label">API key ${p.key_set ? '<span class="text-muted text-xs">(configured — leave blank to keep)</span>' : ''}</label>
            <input class="form-input" id="key_${p.name}" type="password" placeholder="paste API key to store (encrypted)">
            <div class="text-muted text-xs" style="margin-top:4px">key_ref: <code>${escapeHtml(p.key_ref || '(none)')}</code></div>
          </div>` : `<div class="text-muted text-xs">CLI-only provider — runs via its installed CLI.</div>`}
          <div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
            <button class="btn btn-sm btn-primary" onclick="saveProvider('${p.name}')">${icon('save', 13)} Save</button>
            <button class="btn btn-sm btn-ghost" onclick="testProviderUI('${p.name}')">${icon('play', 13)} Test</button>
            <button class="btn btn-sm ${disabled ? 'btn-ok' : 'btn-ghost'}" onclick="toggleProviderUI('${p.name}')">${disabled ? `${icon('power', 13)} Activate` : `${icon('pause', 13)} Deactivate`}</button>
            ${p.custom ? `<button class="btn btn-sm btn-ghost" style="color:var(--crit)" onclick="deleteProviderUI('${p.name}')">${icon('trash', 13)}</button>` : ''}
            <span class="text-sm" id="test_${p.name}" style="margin-left:auto"></span>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    const list = document.getElementById('providerList');
    if (list) list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Failed to load providers</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

let _providerCatalog = [];

async function showAddProviderModal() {
  try {
    _providerCatalog = (await api.getProviderCatalog()).catalog || [];
  } catch { _providerCatalog = []; }
  const presetOptions = _providerCatalog.map((c, i) =>
    `<option value="${i}">${escapeHtml(c.label)}</option>`).join('');
  showModal('Add Provider', `
    <div class="form-group">
      <label class="form-label">Provider preset</label>
      <select class="form-select" id="npPreset" onchange="applyProviderPreset()">
        ${presetOptions}
        <option value="custom">Custom…</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Name (slug) *</label>
        <input class="form-input" id="npName" placeholder="e.g., openrouter">
        <div class="form-hint">lowercase letters, digits, _ or -</div>
      </div>
      <div class="form-group">
        <label class="form-label">Display label</label>
        <input class="form-input" id="npLabel" placeholder="e.g., OpenRouter">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Connection mode</label>
      <div class="check-chips">
        <label class="check-chip"><input type="radio" name="npMode" value="api" checked onchange="onProviderModeChange()"> Token (API key)</label>
        <label class="check-chip"><input type="radio" name="npMode" value="cli" onchange="onProviderModeChange()"> CLI command</label>
      </div>
    </div>
    <div id="npApiFields">
      <div class="form-group">
        <label class="form-label">API format *</label>
        <select class="form-select" id="npFormat">
          ${API_FORMATS.map(f => `<option value="${f.id}">${f.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Base URL <span class="text-muted text-xs">(openai format only)</span></label>
          <input class="form-input" id="npUrl" placeholder="https://openrouter.ai/api/v1">
        </div>
        <div class="form-group">
          <label class="form-label">Default model</label>
          <input class="form-input" id="npModel" placeholder="e.g., deepseek/deepseek-chat">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">API key <span class="text-muted text-xs">(stored encrypted; optional for local endpoints)</span></label>
        <input class="form-input" id="npKey" type="password" placeholder="paste API key (or leave blank to add later)">
      </div>
    </div>
    <div id="npCliFields" style="display:none">
      <div class="form-group">
        <label class="form-label">CLI command template *</label>
        <input class="form-input" id="npCliTemplate" placeholder="ollama run {model} {prompt}">
        <div class="form-hint">{model} and {prompt} are substituted as whole arguments — must include {prompt}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Default model</label>
        <input class="form-input" id="npModelCli" placeholder="e.g., llama3.2">
      </div>
    </div>
    <div class="text-muted text-xs">Note: ChatGPT and Antigravity are deliberately excluded — they overlap the built-in Codex and Gemini engines.</div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="createProviderUI()">Add Provider</button>
  `);
  applyProviderPreset();
}

function applyProviderPreset() {
  const sel = document.getElementById('npPreset');
  if (!sel) return;
  const isCustom = sel.value === 'custom';
  const c = isCustom ? null : _providerCatalog[parseInt(sel.value, 10)];
  document.getElementById('npName').value = c ? c.name : '';
  document.getElementById('npLabel').value = c ? c.label : '';
  document.getElementById('npFormat').value = c ? c.api_format : 'openai';
  document.getElementById('npUrl').value = c ? (c.base_url || '') : '';
  document.getElementById('npModel').value = c ? (c.default_model || '') : '';
  document.getElementById('npModelCli').value = c ? (c.default_model || '') : '';
  document.getElementById('npCliTemplate').value = c ? (c.cli_template || '') : '';
  // Local presets (Ollama) need no key — make the field say so instead of nagging.
  const keyInput = document.getElementById('npKey');
  if (keyInput) {
    keyInput.placeholder = c && c.key_optional
      ? 'not required — local server ignores auth'
      : 'paste API key (or leave blank to add later)';
    keyInput.disabled = !!(c && c.key_optional);
  }
  // CLI radio only meaningful when a template exists or fully custom
  const cliRadio = document.querySelector('input[name="npMode"][value="cli"]');
  if (cliRadio) {
    cliRadio.disabled = !(isCustom || (c && c.cli_template));
    if (cliRadio.disabled && cliRadio.checked) {
      document.querySelector('input[name="npMode"][value="api"]').checked = true;
    }
  }
  onProviderModeChange();
}

function onProviderModeChange() {
  const mode = (document.querySelector('input[name="npMode"]:checked') || {}).value || 'api';
  document.getElementById('npApiFields').style.display = mode === 'api' ? '' : 'none';
  document.getElementById('npCliFields').style.display = mode === 'cli' ? '' : 'none';
}

async function createProviderUI() {
  const name = document.getElementById('npName').value.trim().toLowerCase();
  if (!name) { showToast('Name is required', 'error'); return; }
  const mode = (document.querySelector('input[name="npMode"]:checked') || {}).value || 'api';
  const sel = document.getElementById('npPreset');
  const preset = sel && sel.value !== 'custom' ? _providerCatalog[parseInt(sel.value, 10)] : null;
  try {
    await api.createProvider({
      name,
      label: document.getElementById('npLabel').value.trim(),
      mode,
      api_format: document.getElementById('npFormat').value,
      base_url: document.getElementById('npUrl').value.trim(),
      default_model: (mode === 'cli'
        ? document.getElementById('npModelCli').value
        : document.getElementById('npModel').value).trim(),
      cli_template: document.getElementById('npCliTemplate').value.trim(),
      key_optional: !!(preset && preset.key_optional),
    });
    const key = document.getElementById('npKey').value.trim();
    if (mode === 'api' && key) await api.setProviderSecret(name, key);
    closeModal();
    showToast(`Provider "${name}" added`, 'success');
    renderProviders();
  } catch (err) {
    showToast('Failed to add provider: ' + err.message, 'error');
  }
}

async function toggleProviderUI(name) {
  try {
    const r = await api.toggleProvider(name);
    showToast(`${name} ${r.enabled ? 'activated' : 'deactivated'}`, r.enabled ? 'success' : 'info');
    renderProviders();
  } catch (err) {
    showToast('Failed to toggle: ' + err.message, 'error');
  }
}

async function deleteProviderUI(name) {
  if (!confirm(`Delete provider "${name}"? Its encrypted key is removed too.`)) return;
  try {
    await api.deleteProvider(name);
    showToast(`Provider "${name}" deleted`, 'info');
    renderProviders();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveProvider(name) {
  try {
    const mode = document.getElementById(`mode_${name}`).value;
    const default_model = document.getElementById(`model_${name}`).value.trim();
    const patch = { mode, default_model };
    const fmt = document.getElementById(`fmt_${name}`);
    const url = document.getElementById(`url_${name}`);
    const cli = document.getElementById(`cli_${name}`);
    if (fmt) patch.api_format = fmt.value;
    if (url) patch.base_url = url.value.trim();
    if (cli) patch.cli_template = cli.value.trim();
    const timeoutEl = document.getElementById(`timeout_${name}`);
    if (timeoutEl) patch.timeout_seconds = parseInt(timeoutEl.value, 10) || 120;
    const keyOptEl = document.getElementById(`keyopt_${name}`);
    if (keyOptEl) patch.key_optional = keyOptEl.checked;
    await api.updateProvider(name, patch);
    const keyEl = document.getElementById(`key_${name}`);
    if (keyEl && keyEl.value.trim()) {
      await api.setProviderSecret(name, keyEl.value.trim());
      keyEl.value = '';
    }
    showToast(`${name} saved`, 'success');
    renderProviders();
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
  }
}

// Model discovery — for a local Ollama this lists the INSTALLED models, so
// the default-model field becomes a pick-from-reality dropdown (datalist).
async function loadProviderModels(name) {
  const hint = document.getElementById(`modelsHint_${name}`);
  if (hint) hint.textContent = 'querying endpoint…';
  try {
    const r = await api.getProviderModels(name);
    const dl = document.getElementById(`models_${name}`);
    if (dl) dl.innerHTML = r.models.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
    if (hint) hint.textContent = r.count === 0
      ? 'endpoint reachable but serves no models — for Ollama run: ollama pull <model>'
      : `${r.count} model${r.count === 1 ? '' : 's'} available — click the model field to pick`;
    if (r.count > 0) {
      const input = document.getElementById(`model_${name}`);
      if (input && !input.value.trim()) input.value = r.models[0];
      input && input.focus();
    }
  } catch (err) {
    if (hint) { hint.textContent = err.message; hint.style.color = 'var(--crit)'; }
  }
}

async function testProviderUI(name) {
  const el = document.getElementById(`test_${name}`);
  if (el) el.innerHTML = '<span class="text-muted">testing…</span>';
  try {
    const r = await api.testProvider(name);
    if (el) el.innerHTML = r.ok
      ? `<span style="color:var(--green)">${icon('check', 12)} ${escapeHtml(r.detail || 'ok')}</span>`
      : `<span style="color:var(--red)">${icon('x', 12)} ${escapeHtml(r.detail || 'failed')}</span>`;
  } catch (err) {
    if (el) el.innerHTML = `<span style="color:var(--red)">${icon('x', 12)} ${escapeHtml(err.message)}</span>`;
  }
}

// ─── Platform & Integrations (folded in from the removed Settings page) ──
// The few genuinely-global settings that have no better home: platform name,
// the orchestrator's projects-root folder, and Claude global mirror-sync.

async function loadPlatformPanel() {
  const box = document.getElementById('platformPanel');
  if (!box) return;
  try {
    const s = await api.getSettings();
    const platform = s.platform || {};
    const projects = s.projects || {};
    const mirror = s.mirror || {};
    box.innerHTML = `
      <div class="card">
        <div class="card-header"><span class="card-title">${icon('orbit', 13)} Platform</span></div>
        <div class="form-group">
          <label class="form-label">Platform name</label>
          <input class="form-input" id="pfName" placeholder="Sentinel Agentic OS" value="${escapeHtml(platform.name || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Projects root <span class="text-muted text-xs">(where the orchestrator creates project folders)</span></label>
          <div style="display:flex;gap:6px">
            <input class="form-input" id="pfRoot" style="flex:1" placeholder="default: repo parent" value="${escapeHtml(projects.root || '')}">
            <button class="btn btn-ghost" type="button" id="pfRootBrowse" onclick="pickPlatformRoot()">${icon('folder', 13)} Browse…</button>
          </div>
          <div class="form-hint" id="pfRootHint"></div>
        </div>
        <button class="btn btn-primary" onclick="savePlatform()">${icon('save', 13)} Save platform</button>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">${icon('refresh', 13)} Claude global sync</span></div>
        <p style="font-size:12px;color:var(--text-dim);margin-bottom:12px">
          Mirrors your global Claude subagents, skills, and MCP servers into Sentinel.
          ${mirror.last_sync ? `Last sync: <strong>${escapeHtml(mirror.last_sync)}</strong>` : 'Never synced yet.'}
        </p>
        <div class="form-group">
          <label class="switch" style="width:auto;display:flex;align-items:center;gap:10px">
            <input type="checkbox" id="pfAutoSync" ${mirror.auto_sync !== false ? 'checked' : ''}>
            <span class="switch-slider" style="position:relative;display:inline-block;width:40px;height:22px"></span>
            <span style="font-size:13px">Auto-sync from Claude global</span>
          </label>
        </div>
        <div class="form-group">
          <label class="form-label">Interval (minutes)</label>
          <input class="form-input" id="pfSyncInterval" type="number" min="1" value="${mirror.interval_minutes || 10}">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" onclick="saveMirror()">${icon('save', 13)} Save sync</button>
          <button class="btn btn-ghost" onclick="syncNowFromProviders()">${icon('download', 13)} Sync now</button>
        </div>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="text-muted text-sm">Platform settings unavailable: ${escapeHtml(err.message)}</div>`;
  }
}

async function pickPlatformRoot() {
  const btn = document.getElementById('pfRootBrowse');
  const hint = document.getElementById('pfRootHint');
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = 'A Finder dialog just opened — it may be behind this window…';
  try {
    const r = await api.pickFolder();
    if (r.status === 'ok' && r.path) document.getElementById('pfRoot').value = r.path;
    if (hint) hint.textContent = '';
  } catch (err) {
    if (hint) hint.textContent = err.message + ' — you can type the path manually';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function savePlatform() {
  try {
    await api.updateSettings({
      platform: { name: document.getElementById('pfName').value.trim() },
      projects: { root: document.getElementById('pfRoot').value.trim() },
    });
    showToast('Platform settings saved', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function saveMirror() {
  try {
    await api.updateSettings({
      mirror: {
        auto_sync: document.getElementById('pfAutoSync').checked,
        interval_minutes: parseInt(document.getElementById('pfSyncInterval').value, 10) || 10,
      },
    });
    showToast('Sync settings saved', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function syncNowFromProviders() {
  showToast('Syncing from Claude global…', 'info');
  try {
    const r = await api.syncClaude();
    const a = r.summary.agents || {}, sk = r.summary.skills || {}, mc = r.summary.mcp || {};
    showToast(`Synced — agents ${a.imported || 0}+/${a.refreshed || 0}↻, skills ${sk.imported || 0}+/${sk.refreshed || 0}↻, mcp ${mc.imported || 0}+`, 'success');
    loadPlatformPanel();
  } catch (err) { showToast('Sync failed: ' + err.message, 'error'); }
}
