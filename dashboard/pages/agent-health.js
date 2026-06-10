// Agent Health — two honest layers:
//   1. Agents (profiles): live runtime state, queue, task success, budget — with a force-wake.
//   2. Provider engines: is the CLI/API there at all?

let agentHealthInterval = null;

async function renderAgentHealth() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Agent Health</div>
        <div class="page-subtitle">Live agent runtime + provider engine reachability</div>
      </div>
      <div class="btn-group">
        <label class="switch" title="Auto-refresh every 10s">
          <input type="checkbox" id="healthAutoRefresh" checked onchange="toggleHealthAutoRefresh()">
          <span class="switch-slider"></span>
        </label>
        <span class="text-sm text-muted">Auto</span>
        <button class="btn btn-primary" onclick="refreshHealthUI()">${icon('refresh', 13)} Refresh Now</button>
      </div>
    </div>
    <div class="section-title">Agents</div>
    <div id="agentHealthCards" class="grid grid-3" style="margin-bottom:20px">
      <div class="skeleton" style="height:180px"></div>
      <div class="skeleton" style="height:180px"></div>
      <div class="skeleton" style="height:180px"></div>
    </div>
    <div class="section-title">Provider engines</div>
    <div class="card" id="providerHealthCard">
      <div class="loading"><div class="loading-spinner"></div><span>Checking providers…</span></div>
    </div>
  `;
  await refreshHealthUI();
  if (document.getElementById('healthAutoRefresh')?.checked) {
    startHealthAutoRefresh();
  }
}

function startHealthAutoRefresh() {
  stopHealthAutoRefresh();
  agentHealthInterval = setInterval(() => {
    // page changed → stop polling
    if (!document.getElementById('agentHealthCards')) { stopHealthAutoRefresh(); return; }
    refreshHealthUI();
  }, 10000);
}

function stopHealthAutoRefresh() {
  if (agentHealthInterval) { clearInterval(agentHealthInterval); agentHealthInterval = null; }
}

function toggleHealthAutoRefresh() {
  if (document.getElementById('healthAutoRefresh')?.checked) startHealthAutoRefresh();
  else stopHealthAutoRefresh();
}

const AGENT_STATE_META = {
  working: { cls: 'badge-success', dot: 'ok', label: 'working' },
  sleeping: { cls: 'badge-info', dot: 'idle', label: 'sleeping' },
  waiting_input: { cls: 'badge-warning', dot: 'warn', label: 'waiting for you' },
};

function healthNextWake(a) {
  if (a.state === 'working') return 'running now';
  if (a.waiting_input > 0) return 'blocked on your reply (Inbox)';
  if (a.queued > 0 && a.next_wake_in != null) {
    const m = Math.floor(a.next_wake_in / 60), s = a.next_wake_in % 60;
    return `wakes in ${m > 0 ? m + 'm ' : ''}${s}s`;
  }
  if (a.queued > 0) return 'manual wake only';
  return 'queue empty';
}

async function refreshHealthUI() {
  try {
    const data = await api.getAgentHealth();
    const agents = data.agents || [];
    const providers = data.providers || [];

    const cards = document.getElementById('agentHealthCards');
    if (!cards) return;
    cards.innerHTML = agents.length === 0
      ? `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('users', 32)}</div><div class="empty-state-title">No agents</div><div class="empty-state-desc">Create agent profiles on the Agents page</div></div>`
      : agents.map(a => {
        const meta = AGENT_STATE_META[a.state] || AGENT_STATE_META.sleeping;
        const overBudget = a.budget_usd > 0 && a.spent >= a.budget_usd;
        return `
        <div class="card">
          <div class="flex items-center gap-2" style="margin-bottom:10px">
            <span class="dot ${meta.dot}"></span>
            <strong style="font-size:13.5px">${escapeHtml(a.name)}</strong>
            <span class="badge ${meta.cls}" style="margin-left:auto">${meta.label}</span>
          </div>
          <div class="mono text-xs" style="color:var(--text-faint);margin-bottom:10px">
            ${escapeHtml(a.provider)}${a.model ? ' · ' + escapeHtml(a.model) : ''} ·
            heartbeat ${a.heartbeat_seconds > 0 ? a.heartbeat_seconds + 's' : 'manual'}
          </div>
          <div class="grid grid-3" style="gap:8px;margin-bottom:10px;text-align:center">
            <div><div class="mono" style="font-size:16px">${a.queued}</div><div class="text-muted text-xs">queued</div></div>
            <div><div class="mono" style="font-size:16px;color:var(--ok)">${a.tasks_done}</div><div class="text-muted text-xs">done</div></div>
            <div><div class="mono" style="font-size:16px;color:${a.tasks_failed > 0 ? 'var(--crit)' : 'inherit'}">${a.tasks_failed}</div><div class="text-muted text-xs">failed</div></div>
          </div>
          <div class="text-xs" style="margin-bottom:6px">
            ${a.success_rate != null ? `<span class="badge ${a.success_rate >= 80 ? 'badge-success' : a.success_rate >= 50 ? 'badge-warning' : 'badge-danger'}">${a.success_rate}% success</span>` : '<span class="badge badge-neutral">no runs yet</span>'}
            ${a.budget_usd > 0 ? `<span class="badge ${overBudget ? 'badge-danger' : 'badge-neutral'}" title="spend in current ${a.budget_period} window">$${a.spent.toFixed(2)} / $${a.budget_usd.toFixed(2)}/${a.budget_period}</span>` : ''}
          </div>
          <div class="flex items-center" style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
            <span class="text-muted text-xs">${healthNextWake(a)}</span>
            <button class="btn btn-sm ${a.queued > 0 ? 'btn-primary' : 'btn-ghost'}" style="margin-left:auto"
              ${a.state === 'working' ? 'disabled title="already working"' : ''}
              onclick="wakeAgentUI('${a.id}', ${a.queued})">${icon('zap', 12)} Wake now</button>
          </div>
        </div>`;
      }).join('');

    const provCard = document.getElementById('providerHealthCard');
    if (provCard) {
      const online = providers.filter(p => p.status === 'online').length;
      provCard.innerHTML = `
        <div class="flex items-center gap-2" style="margin-bottom:10px">
          <span class="badge ${online === providers.length ? 'badge-success' : online > 0 ? 'badge-warning' : 'badge-danger'}">${online}/${providers.length} reachable</span>
          <span class="text-muted text-xs">checked ${timeAgo(data.updated)}</span>
        </div>
        <div class="table-wrapper"><table>
          <thead><tr><th>Provider</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>${providers.map(p => `
            <tr>
              <td class="mono text-xs">${escapeHtml(p.name || '')}</td>
              <td><span class="badge ${p.status === 'online' ? 'badge-success' : 'badge-danger'}">${escapeHtml(p.status || 'unknown')}</span></td>
              <td class="text-muted text-xs">${escapeHtml(p.detail || p.version || '')}</td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    }
  } catch (err) {
    const cards = document.getElementById('agentHealthCards');
    if (cards) cards.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Failed to load health</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

async function wakeAgentUI(agentId, queued) {
  try {
    const r = await api.wakeAgent(agentId);
    showToast(r.queued > 0
      ? `Agent woken — draining ${r.queued} queued task${r.queued > 1 ? 's' : ''}`
      : 'Agent woken — queue is empty, nothing to do', r.queued > 0 ? 'success' : 'info');
    setTimeout(refreshHealthUI, 800);
  } catch (err) {
    showToast(err.message, 'error');
  }
}
