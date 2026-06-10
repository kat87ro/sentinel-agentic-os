// Scheduler — recurring agent tasks. A schedule fires into the agent's queue
// (budgets/heartbeat/Kanban mirror apply); "wake" controls whether the agent
// is woken at fire time or waits for its own heartbeat.

let _schedCache = [];
let _schedAgents = [];
let _schedProjects = [];

async function renderScheduler() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Scheduler</div>
        <div class="page-subtitle">Recurring agent tasks — cron or interval, fired into the agent's queue</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showScheduleModal()">+ New Schedule</button>
        <button class="btn btn-ghost" onclick="renderScheduler()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div id="schedList"><div class="skeleton" style="height:120px"></div></div>
  `;
  try {
    const [jobs, agents, projects] = await Promise.all([
      api.getJobs(),
      api.getCustomAgents().catch(() => ({ agents: [] })),
      api.getProjects().catch(() => ({ projects: [] })),
    ]);
    _schedCache = jobs.schedules || [];
    _schedAgents = agents.agents || [];
    _schedProjects = projects.projects || [];
    renderScheduleList();
  } catch (err) {
    document.getElementById('schedList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Failed to load schedules</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

function schedAgentName(id) {
  const a = _schedAgents.find(x => x.id === id);
  return a ? a.name : (id || '?');
}

function schedWhen(s) {
  if (s.cron) return `cron ${s.cron}`;
  if (s.interval_minutes) return `every ${s.interval_minutes} min`;
  return '—';
}

function schedTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString();
}

function renderScheduleList() {
  const list = document.getElementById('schedList');
  if (!list) return;
  if (_schedCache.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('clock', 32)}</div><div class="empty-state-title">No schedules</div><div class="empty-state-desc">Create one to run an agent task on a cron or interval — e.g. a daily report or a queue review</div></div>`;
    return;
  }
  list.innerHTML = `<div class="table-wrapper"><table>
    <thead><tr><th>Schedule</th><th>Agent</th><th>Recurrence</th><th>Next run</th><th>Last run</th><th>Runs</th><th>Status</th><th></th></tr></thead>
    <tbody>${_schedCache.map(s => `
      <tr>
        <td>
          <strong style="font-size:12.5px">${escapeHtml(s.name)}</strong>
          <div class="text-muted text-xs truncate" style="max-width:260px" title="${escapeHtml(s.message)}">${escapeHtml(s.message)}</div>
        </td>
        <td class="mono text-xs">${escapeHtml(schedAgentName(s.agent_id))}${s.project_id ? `<div class="text-muted text-xs">project: ${escapeHtml((_schedProjects.find(p => p.id === s.project_id) || {}).name || s.project_id)}</div>` : ''}</td>
        <td class="mono text-xs">${escapeHtml(schedWhen(s))}${s.wake ? '' : '<div class="text-muted text-xs">no wake (heartbeat)</div>'}</td>
        <td class="mono text-xs">${s.enabled ? escapeHtml(schedTime(s.next_run)) : '—'}</td>
        <td class="mono text-xs">${escapeHtml(schedTime(s.last_run))}</td>
        <td class="mono text-xs">${s.run_count || 0}</td>
        <td><span class="badge ${s.enabled ? 'badge-success' : 'badge-warning'}">${s.enabled ? 'active' : 'paused'}</span></td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-ghost" title="Run now" onclick="runScheduleNow('${s.id}')">${icon('play', 13)}</button>
          <button class="btn btn-sm btn-ghost" title="${s.enabled ? 'Pause' : 'Resume'}" onclick="toggleScheduleUI('${s.id}')">${icon(s.enabled ? 'pause' : 'power', 13)}</button>
          <button class="btn btn-sm btn-ghost" title="Edit" onclick="showScheduleModal('${s.id}')">${icon('pencil', 13)}</button>
          <button class="btn btn-sm btn-ghost" title="Delete" style="color:var(--crit)" onclick="deleteScheduleUI('${s.id}')">${icon('trash', 13)}</button>
        </td>
      </tr>`).join('')}</tbody></table></div>`;
}

function showScheduleModal(id) {
  const s = id ? _schedCache.find(x => x.id === id) : null;
  if (_schedAgents.length === 0) { showToast('Create an agent first — schedules need a target agent', 'warning'); return; }
  const agentOpts = _schedAgents.map(a =>
    `<option value="${a.id}" ${s && s.agent_id === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
  const projectOpts = ['<option value="">— none —</option>'].concat(_schedProjects.map(p =>
    `<option value="${p.id}" ${s && s.project_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)).join('');
  const mode = s && s.cron ? 'cron' : 'interval';
  showModal(s ? 'Edit Schedule' : 'New Schedule', `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Name *</label>
        <input class="form-input" id="schName" placeholder="e.g., Daily queue review" value="${s ? escapeHtml(s.name) : ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Agent *</label>
        <select class="form-select" id="schAgent">${agentOpts}</select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Task message *</label>
      <textarea class="form-textarea" id="schMessage" rows="3" placeholder="What should the agent do on each run?">${s ? escapeHtml(s.message) : ''}</textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Recurrence</label>
        <select class="form-select" id="schMode" onchange="onSchedModeChange()">
          <option value="interval" ${mode === 'interval' ? 'selected' : ''}>Interval (minutes)</option>
          <option value="cron" ${mode === 'cron' ? 'selected' : ''}>Cron expression</option>
        </select>
      </div>
      <div class="form-group" id="schIntervalGroup">
        <label class="form-label">Every N minutes <span class="text-muted text-xs">(min 5)</span></label>
        <input class="form-input" id="schInterval" type="number" min="5" value="${s && s.interval_minutes ? s.interval_minutes : 60}">
      </div>
      <div class="form-group" id="schCronGroup">
        <label class="form-label">Cron <span class="text-muted text-xs">(min hour dom mon dow · dow: 0=Mon…6=Sun)</span></label>
        <input class="form-input mono" id="schCron" placeholder="0 9 * * 0-4" value="${s ? escapeHtml(s.cron || '') : ''}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Project <span class="text-muted text-xs">(scopes memory + workdir)</span></label>
        <select class="form-select" id="schProject">${projectOpts}</select>
      </div>
      <div class="form-group">
        <label class="form-label">On fire</label>
        <select class="form-select" id="schWake">
          <option value="true" ${!s || s.wake ? 'selected' : ''}>Wake the agent immediately</option>
          <option value="false" ${s && !s.wake ? 'selected' : ''}>Queue only — wait for its heartbeat</option>
        </select>
      </div>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveScheduleUI('${id || ''}')">${s ? 'Save' : 'Create Schedule'}</button>
  `);
  onSchedModeChange();
}

function onSchedModeChange() {
  const mode = document.getElementById('schMode').value;
  document.getElementById('schIntervalGroup').style.display = mode === 'interval' ? '' : 'none';
  document.getElementById('schCronGroup').style.display = mode === 'cron' ? '' : 'none';
}

async function saveScheduleUI(id) {
  const mode = document.getElementById('schMode').value;
  const payload = {
    name: document.getElementById('schName').value.trim(),
    agent_id: document.getElementById('schAgent').value,
    message: document.getElementById('schMessage').value.trim(),
    cron: mode === 'cron' ? document.getElementById('schCron').value.trim() : '',
    interval_minutes: mode === 'interval' ? parseInt(document.getElementById('schInterval').value, 10) : null,
    project_id: document.getElementById('schProject').value || (id ? '' : null),
    wake: document.getElementById('schWake').value === 'true',
  };
  if (!payload.name) { showToast('Name is required', 'error'); return; }
  if (!payload.message) { showToast('Task message is required', 'error'); return; }
  if (mode === 'cron' && !payload.cron) { showToast('Cron expression is required', 'error'); return; }
  try {
    if (id) await api.updateJob(id, payload);
    else await api.createJob(payload);
    closeModal();
    showToast(id ? 'Schedule updated' : 'Schedule created', 'success');
    renderScheduler();
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function toggleScheduleUI(id) {
  try {
    const r = await api.toggleJob(id);
    showToast(r.enabled ? 'Schedule resumed' : 'Schedule paused', 'info');
    renderScheduler();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function runScheduleNow(id) {
  try {
    const r = await api.runJobNow(id);
    showToast(`Fired — task ${r.task.id} queued and agent woken`, 'success');
    renderScheduler();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteScheduleUI(id) {
  if (!confirm('Delete this schedule? Already-queued runs are unaffected.')) return;
  try {
    await api.deleteJob(id);
    showToast('Schedule deleted', 'info');
    renderScheduler();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
