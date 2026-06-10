// Smart Router — scores YOUR agent profiles for a task (skill tags, persona,
// track record, budget headroom) and dispatches into the winner's queue.

let _routerAgents = [];
let _routerProjects = [];
let _routerSuggestion = null;

async function renderSmartRouter() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Smart Router</div>
        <div class="page-subtitle">Describe a task — agents are ranked by skills, persona, track record and budget; routing queues it for real</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:20px">
      <div class="form-group">
        <label class="form-label">Describe your task</label>
        <textarea class="form-textarea" id="routerTaskInput" rows="3"
          placeholder="e.g., Review the snake game code for bugs and write a test plan"></textarea>
      </div>
      <div class="flex gap-3" style="align-items:flex-end;flex-wrap:wrap">
        <div class="form-group" style="flex:1;min-width:200px;margin-bottom:0">
          <label class="form-label">Agent</label>
          <select class="form-select" id="routerAgentSelect"></select>
        </div>
        <div class="form-group" style="flex:1;min-width:180px;margin-bottom:0">
          <label class="form-label">Project <span class="text-muted text-xs">(optional)</span></label>
          <select class="form-select" id="routerProjectSelect"></select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label">On dispatch</label>
          <select class="form-select" id="routerWakeSelect">
            <option value="true">Wake agent now</option>
            <option value="false">Wait for heartbeat</option>
          </select>
        </div>
        <button class="btn btn-ghost" onclick="suggestAgentUI()">${icon('search', 13)} Suggest</button>
        <button class="btn btn-primary" onclick="routeTaskUI()">${icon('send', 13)} Route Task</button>
      </div>
      <div id="routerResult" style="margin-top:14px"></div>
    </div>
    <div class="section-title">How ranking works</div>
    <div class="card">
      <table>
        <thead><tr><th>Signal</th><th>Weight</th></tr></thead>
        <tbody>
          <tr><td>Agent skill tag appears in the task</td><td class="mono text-xs">+3 per tag</td></tr>
          <tr><td>Task words overlap the agent's persona (system prompt)</td><td class="mono text-xs">+1 each, max +5</td></tr>
          <tr><td>Track record (≥3 finished tasks)</td><td class="mono text-xs">−2 … +2</td></tr>
          <tr><td>Budget window exhausted</td><td class="mono text-xs">−10 (ranked last)</td></tr>
        </tbody>
      </table>
    </div>
  `;
  try {
    const [agents, projects] = await Promise.all([
      api.getCustomAgents().catch(() => ({ agents: [] })),
      api.getProjects().catch(() => ({ projects: [] })),
    ]);
    _routerAgents = agents.agents || [];
    _routerProjects = projects.projects || [];
    document.getElementById('routerAgentSelect').innerHTML =
      ['<option value="">— pick or use Suggest —</option>']
        .concat(_routerAgents.map(a => `<option value="${a.id}">${escapeHtml(a.name)} (${escapeHtml(a.provider)})</option>`)).join('');
    document.getElementById('routerProjectSelect').innerHTML =
      ['<option value="">— none —</option>']
        .concat(_routerProjects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)).join('');
  } catch {}
}

async function suggestAgentUI() {
  const task = document.getElementById('routerTaskInput').value.trim();
  if (!task) { showToast('Describe the task first', 'warning'); return; }
  const out = document.getElementById('routerResult');
  out.innerHTML = `<div class="loading" style="padding:10px"><div class="loading-spinner"></div><span>Scoring agents…</span></div>`;
  try {
    const r = await api.suggestRouter(task);
    _routerSuggestion = r;
    if (!r.suggested) {
      out.innerHTML = `<div class="text-muted text-sm">${escapeHtml(r.message || 'No agents to rank')}</div>`;
      return;
    }
    document.getElementById('routerAgentSelect').value = r.suggested.agent_id;
    out.innerHTML = `
      <div class="flex items-center gap-2" style="margin-bottom:8px">
        <span class="badge ${r.confidence === 'high' ? 'badge-success' : r.confidence === 'medium' ? 'badge-info' : 'badge-warning'}">${r.confidence} confidence</span>
        <strong style="font-size:13px">${escapeHtml(r.suggested.name)}</strong>
        <span class="text-muted text-xs">selected in the dropdown — hit Route Task to dispatch</span>
      </div>
      <div class="table-wrapper"><table>
        <thead><tr><th>#</th><th>Agent</th><th>Score</th><th>Why</th></tr></thead>
        <tbody>${r.ranking.map((row, i) => `
          <tr style="${i === 0 ? 'background:var(--bg-sunken,rgba(0,0,0,.12))' : ''}">
            <td class="mono text-xs">${i + 1}</td>
            <td><strong style="font-size:12.5px">${escapeHtml(row.name)}</strong> <span class="text-muted text-xs">${escapeHtml(row.provider)}</span></td>
            <td class="mono text-xs">${row.score}</td>
            <td class="text-muted text-xs">${row.reasons.length ? row.reasons.map(escapeHtml).join(' · ') : 'no signals'}</td>
          </tr>`).join('')}</tbody>
      </table></div>`;
  } catch (err) {
    out.innerHTML = `<div style="color:var(--crit);font-size:12.5px">${escapeHtml(err.message)}</div>`;
  }
}

async function routeTaskUI() {
  const task = document.getElementById('routerTaskInput').value.trim();
  if (!task) { showToast('Describe the task first', 'warning'); return; }
  let agentId = document.getElementById('routerAgentSelect').value;
  const out = document.getElementById('routerResult');
  try {
    if (!agentId) {
      // no manual pick → ask the router and take its word
      const s = await api.suggestRouter(task);
      if (!s.suggested) { showToast('No agents available to route to', 'error'); return; }
      agentId = s.suggested.agent_id;
      document.getElementById('routerAgentSelect').value = agentId;
    }
    const r = await api.routeTask({
      task,
      agent_id: agentId,
      project_id: document.getElementById('routerProjectSelect').value || null,
      wake: document.getElementById('routerWakeSelect').value === 'true',
    });
    showToast(r.message + (r.woke ? ' — woken now' : ' — picked up on next heartbeat'), 'success');
    out.innerHTML = `
      <div class="card" style="padding:10px 14px">
        ${icon('check-circle', 14)} <strong style="font-size:12.5px">Queued as task ${escapeHtml(r.task.id)}</strong>
        <span class="text-muted text-xs"> — watch it on the Kanban board or under the project's task queue</span>
      </div>`;
  } catch (err) {
    showToast(err.message, 'error');
  }
}
