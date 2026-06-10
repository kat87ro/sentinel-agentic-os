// Agents — create & configure dynamic agent profiles (provider + model + persona + skills)

const AGENT_PROVIDERS = [
  { id: 'gemini', label: 'Gemini', icon: `${icon('cpu', 13)}`, color: 'blue', placeholder: 'gemini-2.5-flash' },
  { id: 'claude', label: 'Claude', icon: `${icon('sparkle', 13)}`, color: 'accent', placeholder: 'claude-sonnet-4-6' },
  { id: 'codex', label: 'Codex', icon: `${icon('orbit', 13)}`, color: 'green', placeholder: 'gpt-5.1-codex' },
  { id: 'opencode', label: 'OpenCode', icon: `${icon('wrench', 13)}`, color: 'purple', placeholder: '(provider default)' },
  { id: 'hermes', label: 'Hermes', icon: `${icon('zap', 13)}`, color: 'green', placeholder: '(provider default)' },
];
// Deliberately excluded engines (overlap rule — one engine per backend):
//   chatgpt → covered by codex (OpenAI; api mode = Chat Completions)
//   antigravity → covered by gemini (Antigravity is a Gemini-powered IDE)
const AGENT_SKILL_OPTIONS = ['research', 'analysis', 'code', 'devops', 'memory', 'schedule', 'reasoning', 'writing', 'review', 'planning'];

let _agentsCache = [];
let _mcpServersCache = [];
let _providersCache = [];   // live registry (built-ins + customs) from /api/providers
let _agentUsage = {};       // per-agent spend in its budget window

function providerMeta(id) {
  const builtin = AGENT_PROVIDERS.find(p => p.id === id);
  if (builtin) return builtin;
  const live = _providersCache.find(p => p.name === id);
  if (live) return { id, label: live.label || id, icon: `${icon('orbit', 13)}`, color: 'accent', placeholder: live.default_model || 'model id' };
  return { id, label: id, icon: `${icon('bot', 13)}`, color: 'accent', placeholder: '' };
}

function providerOptionsList() {
  // Enabled providers from the live registry; falls back to the static list.
  if (_providersCache.length) {
    return _providersCache.filter(p => p.enabled !== false).map(p => providerMeta(p.name));
  }
  return AGENT_PROVIDERS;
}

async function renderAgents() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Agents</div>
        <div class="page-subtitle">Create and configure agent profiles — provider, model, persona, and skills</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showAgentModal()">+ New Agent</button>
        <button class="btn btn-ghost" onclick="syncClaudeUI()">${icon('download', 13)} Sync from Claude</button>
        <button class="btn btn-ghost" onclick="renderAgents()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="grid grid-3" id="agentList">${renderSkeleton(3)}</div>
  `;
  try {
    const [data, mcpData, provData, usageData] = await Promise.all([
      api.getCustomAgents(),
      api.getMcpServers().catch(() => ({ servers: [] })),
      api.getProviders().catch(() => ({ providers: [] })),
      api.getAgentsUsage().catch(() => ({ usage: {} })),
    ]);
    _agentsCache = data.agents || [];
    _mcpServersCache = mcpData.servers || [];
    _providersCache = provData.providers || [];
    _agentUsage = usageData.usage || {};
    const list = document.getElementById('agentList');
    if (!list) return;
    if (_agentsCache.length === 0) {
      list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('bot', 32)}</div><div class="empty-state-title">No agents yet</div><div class="empty-state-desc">Create your first agent profile to get started</div></div>`;
      return;
    }
    list.innerHTML = _agentsCache.map(a => {
      const m = providerMeta(a.provider);
      const skills = (a.skills || []).map(s => `<span class="skill-chip">${escapeHtml(s)}</span>`).join('');
      return `
        <div class="card agent-card">
          <div class="flex items-center justify-between" style="margin-bottom:10px">
            <div style="display:flex;align-items:center;gap:10px">
              <div class="agent-avatar" style="background:var(--${m.color}-dim,var(--accent-glow));color:var(--${m.color},var(--accent-light))">${m.icon}</div>
              <div>
                <div class="card-title" style="margin:0">${escapeHtml(a.name)}</div>
                <span class="provider-badge provider-${a.provider}">${m.label}${a.model ? ` · ${escapeHtml(a.model)}` : ''}</span>
                ${a.source === 'claude-global' ? '<span class="badge badge-accent" style="margin-left:4px">claude-global</span>' : ''}
              </div>
            </div>
          </div>
          ${(() => { const u = _agentUsage[a.id]; if (!u || !u.budget_usd) return ''; const over = u.spent >= u.budget_usd;
            return `<div class="text-xs mono" style="margin-bottom:8px;color:${over ? 'var(--crit)' : 'var(--text-faint)'}">${icon('dollar', 11)} ${u.spent.toFixed(2)} / ${u.budget_usd.toFixed(2)} per ${u.period}${over ? ' — limit reached' : ''}</div>`; })()}
          ${a.system_prompt ? `<div class="text-muted text-sm" style="margin-bottom:10px;max-height:54px;overflow:hidden">${escapeHtml(a.system_prompt)}</div>` : ''}
          ${skills ? `<div class="skill-chips">${skills}</div>` : ''}
          <div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
            <button class="btn btn-sm btn-primary" onclick="showDispatchModal('${a.id}')">${icon('play', 13)} Test</button>
            <button class="btn btn-sm btn-ghost" onclick="showAgentModal('${a.id}')">${icon('pencil', 13)} Edit</button>
            <button class="btn btn-sm btn-ghost" onclick="deleteAgent('${a.id}')" style="margin-left:auto;color:var(--red)">${icon('trash', 13)}</button>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    const list = document.getElementById('agentList');
    if (list) list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Failed to load agents</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

function showAgentModal(agentId) {
  const a = agentId ? _agentsCache.find(x => x.id === agentId) : null;
  const providerOptions = providerOptionsList().map(p =>
    `<option value="${p.id}" ${a && a.provider === p.id ? 'selected' : ''}>${p.label}</option>`).join('');
  const skillChecks = AGENT_SKILL_OPTIONS.map(s => {
    const checked = a && (a.skills || []).includes(s) ? 'checked' : '';
    return `<label class="check-chip"><input type="checkbox" value="${s}" ${checked}> ${s}</label>`;
  }).join('');
  const extraSkills = a ? (a.skills || []).filter(s => !AGENT_SKILL_OPTIONS.includes(s)).join(', ') : '';

  showModal(agentId ? 'Edit Agent' : 'Create Agent', `
    <div class="form-group">
      <label class="form-label">Name *</label>
      <input class="form-input" id="agentName" placeholder="e.g., Research Specialist" value="${a ? escapeHtml(a.name) : ''}">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Base Engine *</label>
        <select class="form-select" id="agentProvider" onchange="onAgentProviderChange()">${providerOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Model</label>
        <input class="form-input" id="agentModel" placeholder="model id" value="${a ? escapeHtml(a.model || '') : ''}">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">System Prompt / Persona</label>
      <textarea class="form-textarea" id="agentPrompt" rows="4" placeholder="Describe how this agent should behave...">${a ? escapeHtml(a.system_prompt || '') : ''}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Skills</label>
      <div class="check-chips">${skillChecks}</div>
      <input class="form-input" id="agentExtraSkills" style="margin-top:8px" placeholder="extra skills, comma-separated" value="${escapeHtml(extraSkills)}">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Budget (USD, 0 = unlimited)</label>
        <input class="form-input" id="agentBudget" type="number" min="0" step="0.5" value="${a ? (a.budget_usd || 0) : 0}">
      </div>
      <div class="form-group">
        <label class="form-label">Budget period</label>
        <select class="form-select" id="agentBudgetPeriod">
          <option value="hour" ${a && a.budget_period === 'hour' ? 'selected' : ''}>per hour</option>
          <option value="day" ${!a || a.budget_period === 'day' || !a.budget_period ? 'selected' : ''}>per day</option>
          <option value="month" ${a && a.budget_period === 'month' ? 'selected' : ''}>per month (rolling 30 days)</option>
        </select>
        <div class="form-hint">Rolling windows — the spend counter looks back exactly one period</div>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Heartbeat <span class="text-muted text-xs">(how often a sleeping agent wakes to check its task queue)</span></label>
      <select class="form-select" id="agentHeartbeat">
        ${[[0, 'Manual wake only'], [60, 'Every minute'], [300, 'Every 5 minutes'], [900, 'Every 15 minutes'], [3600, 'Every hour']]
          .map(([v, l]) => `<option value="${v}" ${a ? (a.heartbeat_seconds ?? 300) === v ? 'selected' : '' : v === 300 ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Attach MCP servers</label>
      ${_mcpServersCache.length === 0
        ? '<div class="text-muted text-xs">No MCP servers yet — add some on the MCP page.</div>'
        : `<div class="check-chips" id="agentMcpChecks">${_mcpServersCache.map(s => {
            const checked = a && (a.mcp_servers || []).includes(s.id) ? 'checked' : '';
            return `<label class="check-chip"><input type="checkbox" value="${s.id}" ${checked}> ${escapeHtml(s.name)}</label>`;
          }).join('')}</div>`}
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveAgent('${agentId || ''}')">${agentId ? 'Save Changes' : 'Create Agent'}</button>
  `);
  onAgentProviderChange();
}

function onAgentProviderChange() {
  const sel = document.getElementById('agentProvider');
  const model = document.getElementById('agentModel');
  if (sel && model) model.placeholder = providerMeta(sel.value).placeholder;
}

function collectAgentSkills() {
  const checked = Array.from(document.querySelectorAll('.check-chips input:checked')).map(i => i.value);
  const extra = (document.getElementById('agentExtraSkills').value || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return Array.from(new Set([...checked, ...extra]));
}

async function saveAgent(agentId) {
  const name = document.getElementById('agentName').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  const mcp_servers = Array.from(document.querySelectorAll('#agentMcpChecks input:checked')).map(i => i.value);
  const payload = {
    name,
    provider: document.getElementById('agentProvider').value,
    model: document.getElementById('agentModel').value.trim(),
    system_prompt: document.getElementById('agentPrompt').value,
    skills: collectAgentSkills(),
    mcp_servers,
    budget_usd: parseFloat(document.getElementById('agentBudget').value) || 0,
    budget_period: document.getElementById('agentBudgetPeriod').value,
    heartbeat_seconds: parseInt(document.getElementById('agentHeartbeat').value, 10) || 0,
  };
  try {
    if (agentId) {
      await api.updateCustomAgent(agentId, payload);
      showToast('Agent updated', 'success');
    } else {
      await api.createCustomAgent(payload);
      showToast('Agent created', 'success');
    }
    closeModal();
    renderAgents();
  } catch (err) {
    showToast('Failed to save agent: ' + err.message, 'error');
  }
}

async function syncClaudeUI() {
  showToast('Syncing from Claude global (agents + skills + MCP)...', 'info');
  try {
    const r = await api.syncClaude();
    const a = r.summary.agents || {}, s = r.summary.skills || {}, mc = r.summary.mcp || {};
    showToast(`Synced — agents ${a.imported || 0}+/${a.refreshed || 0}↻, skills ${s.imported || 0}+/${s.refreshed || 0}↻, mcp ${mc.imported || 0}+`, 'success');
    renderAgents();
  } catch (err) {
    showToast('Sync failed: ' + err.message, 'error');
  }
}

async function deleteAgent(agentId) {
  if (!confirm('Delete this agent profile?')) return;
  try {
    await api.deleteCustomAgent(agentId);
    showToast('Agent deleted', 'info');
    renderAgents();
  } catch (err) {
    showToast('Failed to delete: ' + err.message, 'error');
  }
}

function showDispatchModal(agentId) {
  const a = _agentsCache.find(x => x.id === agentId);
  showModal(`Test: ${a ? escapeHtml(a.name) : 'Agent'}`, `
    <div class="form-group">
      <label class="form-label">Message</label>
      <textarea class="form-textarea" id="dispatchMsg" rows="3" placeholder="What should this agent do?"></textarea>
    </div>
    <div id="dispatchResult" class="text-muted text-sm"></div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Close</button>
    <button class="btn btn-primary" onclick="runDispatch('${agentId}')">${icon('play', 13)} Run</button>
  `);
}

async function runDispatch(agentId) {
  const msg = document.getElementById('dispatchMsg').value.trim();
  if (!msg) { showToast('Enter a message', 'warning'); return; }
  const out = document.getElementById('dispatchResult');
  out.innerHTML = `<div class="loading"><div class="loading-spinner"></div><span>Running...</span></div>`;
  try {
    const r = await api.dispatchTask({ message: msg, agent_id: agentId });
    out.innerHTML = `<div class="card" style="margin-top:10px;white-space:pre-wrap">${escapeHtml(r.result || '(no output)')}</div>`;
  } catch (err) {
    out.innerHTML = `<div style="color:var(--red)">${escapeHtml(err.message)}</div>`;
  }
}
