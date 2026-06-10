// Audit Log — append-only trail of everything the OS and its operators did.
// Categories are derived from the action prefix; every row expands to the
// full JSON entry.

const AUDIT_CATEGORIES = {
  auth: ['login', 'login_failed', 'logout'],
  agents: ['agent_created', 'agent_updated', 'agent_deleted', 'agent_health_refreshed'],
  tasks: ['agent_task_queued', 'agent_task_processed', 'agent_task_cancelled', 'agent_task_deleted',
          'delegation_depth_exceeded', 'delegation_unresolved', 'delegation_cycle_refused',
          'task_routed', 'team_task_dispatched'],
  budget: ['budget_blocked'],
  schedules: ['schedule_created', 'schedule_updated', 'schedule_toggled', 'schedule_deleted',
              'schedule_fired', 'schedule_orphaned_disabled'],
  kanban: ['kanban_task_created', 'kanban_task_updated', 'kanban_task_completed', 'kanban_task_blocked',
           'kanban_task_unblocked', 'kanban_task_deleted', 'kanban_link_added', 'kanban_assigned_to_agent'],
  projects: ['project_created', 'project_updated', 'project_deleted', 'project_chat',
             'orchestrated', 'orchestrate_unknown_team'],
  goals: ['goal_created', 'goal_updated', 'goal_deleted', 'goal_recalibration_queued'],
  teams: ['team_created', 'team_updated', 'team_deleted'],
  providers: ['provider_created', 'provider_updated', 'provider_deleted', 'provider_toggled', 'provider_secret_set'],
  skills: ['skill_run', 'skill_created', 'skill_updated', 'skill_toggled', 'skill_deleted'],
  system: ['settings_updated', 'backup_created', 'backup_restored', 'plugin_installed',
           'brain_update', 'memory_config_updated', 'claude_sync'],
};

const AUDIT_BADGE = {
  auth: 'badge-accent', agents: 'badge-info', tasks: 'badge-success', budget: 'badge-danger',
  schedules: 'badge-info', kanban: 'badge-info', projects: 'badge-success', goals: 'badge-success',
  teams: 'badge-info', providers: 'badge-warning', skills: 'badge-success', system: 'badge-warning',
};

function auditCategory(action) {
  for (const [cat, actions] of Object.entries(AUDIT_CATEGORIES)) {
    if (actions.includes(action)) return cat;
  }
  return 'other';
}

// One-line human summary from the entry's context fields (id/timestamp/action/actor excluded).
function auditSummary(e) {
  const skip = new Set(['id', 'timestamp', 'action', 'actor']);
  const parts = [];
  for (const [k, v] of Object.entries(e)) {
    if (skip.has(k) || v === null || v === undefined || v === '') continue;
    parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return parts.join(' · ').slice(0, 160);
}

async function renderAudit() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Audit Log</h1>
        <p class="page-subtitle">Who did what, when — operators and agents alike</p>
      </div>
      <div class="btn-group">
        <button class="btn" onclick="refreshAudit()">${icon('refresh', 13)} Refresh</button>
        <button class="btn" onclick="clearAuditFilters()">${icon('x', 13)} Clear Filters</button>
      </div>
    </div>
    <div class="flex gap-2 mb-3" style="flex-wrap:wrap">
      <input id="auditFilter" class="form-input" style="width:200px" placeholder="Filter by keyword..." oninput="applyAuditFilter()">
      <select id="auditCategoryFilter" class="form-select" style="width:150px" onchange="applyAuditFilter()">
        <option value="">All categories</option>
        ${Object.keys(AUDIT_CATEGORIES).map(c => `<option value="${c}">${c}</option>`).join('')}
        <option value="other">other</option>
      </select>
      <select id="auditActorFilter" class="form-select" style="width:150px" onchange="applyAuditFilter()">
        <option value="">All actors</option>
      </select>
    </div>
    <div id="auditTable"><div class="loading"><div class="loading-spinner"></div></div></div>
  `;

  await refreshAudit();
}

let _allAuditEntries = [];

async function refreshAudit() {
  const container = document.getElementById('auditTable');
  container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';
  try {
    const r = await api.getAudit(300);
    _allAuditEntries = (r.entries || []).reverse();   // newest first
    const actors = Array.from(new Set(_allAuditEntries.map(e => e.actor).filter(Boolean))).sort();
    const actorSel = document.getElementById('auditActorFilter');
    if (actorSel) {
      const cur = actorSel.value;
      actorSel.innerHTML = '<option value="">All actors</option>' +
        actors.map(a => `<option value="${escapeHtml(a)}" ${a === cur ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('');
    }
    applyAuditFilter();
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function applyAuditFilter() {
  const q = (document.getElementById('auditFilter').value || '').toLowerCase();
  const cat = document.getElementById('auditCategoryFilter').value;
  const actor = document.getElementById('auditActorFilter').value;
  let filtered = _allAuditEntries;
  if (q) filtered = filtered.filter(e => JSON.stringify(e).toLowerCase().includes(q));
  if (cat) filtered = filtered.filter(e => auditCategory(e.action) === cat);
  if (actor) filtered = filtered.filter(e => e.actor === actor);

  const container = document.getElementById('auditTable');
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('inbox', 32)}</div><div class="empty-state-title">No audit entries found</div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead><tr><th style="width:30px"></th><th>Time</th><th>Category</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead>
        <tbody>
          ${filtered.slice(0, 150).map((e, i) => {
            const cat = auditCategory(e.action);
            return `
            <tr style="cursor:pointer" onclick="toggleAuditRow(${i})">
              <td class="text-muted text-xs">▸</td>
              <td style="font-size:12px;white-space:nowrap">${formatDate(e.timestamp)}</td>
              <td><span class="badge ${AUDIT_BADGE[cat] || 'badge-neutral'}">${cat}</span></td>
              <td class="mono text-xs">${escapeHtml(e.action || '')}</td>
              <td class="mono text-xs">${escapeHtml(e.actor || '')}</td>
              <td style="font-size:12px;color:var(--text-muted)" class="truncate">${escapeHtml(auditSummary(e))}</td>
            </tr>
            <tr id="auditDetail_${i}" style="display:none">
              <td></td>
              <td colspan="5"><pre class="mono" style="font-size:11.5px;white-space:pre-wrap;margin:4px 0;max-height:200px;overflow:auto">${escapeHtml(JSON.stringify(e, null, 2))}</pre></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--text-muted);text-align:right;margin-top:8px">${filtered.length > 150 ? 'Showing 150 of ' : ''}${filtered.length} entries</div>
  `;
}

function toggleAuditRow(i) {
  const row = document.getElementById(`auditDetail_${i}`);
  if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
}

function clearAuditFilters() {
  document.getElementById('auditFilter').value = '';
  document.getElementById('auditCategoryFilter').value = '';
  document.getElementById('auditActorFilter').value = '';
  applyAuditFilter();
}
