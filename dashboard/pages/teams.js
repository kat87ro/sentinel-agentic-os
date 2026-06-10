// Teams — group agents into reporting hierarchies and visualize the org chart

let _teamAgents = [];   // agent registry, for name/select lookups
let _teamsCache = [];
let _builderRows = [];  // [{agent_id, reports_to, role}] for the create/edit form
let _builderEditId = null;

function agentName(id) {
  const a = _teamAgents.find(x => x.id === id);
  return a ? a.name : id;
}

async function renderTeams() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Teams</div>
        <div class="page-subtitle">Group agents into reporting hierarchies with a manager and org chart</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showTeamModal()">+ New Team</button>
        <button class="btn btn-ghost" onclick="renderTeams()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="grid grid-2" id="teamList">${renderSkeleton(2)}</div>
  `;
  try {
    const [agentsData, teamsData] = await Promise.all([api.getCustomAgents(), api.getTeams()]);
    _teamAgents = agentsData.agents || [];
    _teamsCache = teamsData.teams || [];
    const list = document.getElementById('teamList');
    if (!list) return;
    if (_teamsCache.length === 0) {
      list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('users', 32)}</div><div class="empty-state-title">No teams yet</div><div class="empty-state-desc">Create a team to assign a manager and reporting lines</div></div>`;
      return;
    }
    list.innerHTML = _teamsCache.map(t => `
      <div class="card">
        <div class="flex items-center justify-between" style="margin-bottom:10px">
          <div class="card-title" style="margin:0">${escapeHtml(t.name)}</div>
          <span class="badge badge-accent">${(t.hierarchy || []).length} members</span>
        </div>
        <div class="text-muted text-sm" style="margin-bottom:10px">${icon('shield', 12)} Lead: ${escapeHtml(agentName(t.manager_id))}</div>
        ${renderOrgTree(t)}
        <div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
          <button class="btn btn-sm btn-ghost" onclick="showTeamModal('${t.id}')">${icon('pencil', 13)} Edit</button>
          <button class="btn btn-sm btn-ghost" onclick="deleteTeam('${t.id}')" style="margin-left:auto;color:var(--red)">${icon('trash', 13)}</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    const list = document.getElementById('teamList');
    if (list) list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Failed to load teams</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

// Modern org chart: centered connector tree (manager on top, reports branching
// below) built from the hierarchy's reports_to edges. Node = monogram card with
// provider accent + role.
const TEAM_PROVIDER_ACCENTS = {
  opencode: 'var(--purple)', hermes: 'var(--warn)', gemini: 'var(--blue)',
  claude: 'var(--accent)', codex: 'var(--ok)',
};

function orgMonogram(name) {
  const words = (name || '?').replace(/[_-]/g, ' ').split(' ').filter(Boolean);
  return ((words[0] || '?')[0] + (words[1] ? words[1][0] : (words[0] || '??')[1] || '')).toUpperCase();
}

function orgNodeCard(team, node) {
  const a = _teamAgents.find(x => x.id === node.agent_id) || {};
  const acc = TEAM_PROVIDER_ACCENTS[a.provider] || 'var(--accent)';
  const isLead = node.agent_id === team.manager_id;
  return `
    <div class="org-card ${isLead ? 'org-lead' : ''}">
      <div class="org-card-badge" style="background:color-mix(in oklch, ${acc} 16%, transparent);color:${acc};border:1px solid color-mix(in oklch, ${acc} 38%, transparent)">${orgMonogram(a.name || node.agent_id)}</div>
      <div>
        <div class="org-card-nm">${escapeHtml(a.name || node.agent_id)}</div>
        <div class="org-card-role">${escapeHtml(node.role || (isLead ? 'Lead' : 'Member'))}</div>
      </div>
    </div>`;
}

function renderOrgTree(team) {
  const nodes = team.hierarchy || [];
  if (!nodes.length) return '<div class="text-muted text-sm">No members</div>';
  const seen = new Set();
  const childrenOf = (parent) => nodes.filter(n => (n.reports_to || null) === parent && !seen.has(n.agent_id));

  const renderNode = (node) => {
    seen.add(node.agent_id);
    const kids = childrenOf(node.agent_id);
    return `<li>${orgNodeCard(team, node)}${kids.length ? `<ul>${kids.map(renderNode).join('')}</ul>` : ''}</li>`;
  };

  const roots = childrenOf(null);
  let html = roots.map(renderNode).join('');
  // orphans (unreachable from a root) get their own subtree at top level
  const orphans = nodes.filter(n => !seen.has(n.agent_id));
  html += orphans.map(renderNode).join('');
  return `<div class="orgc"><ul>${html}</ul></div>`;
}

function showTeamModal(teamId) {
  _builderEditId = teamId || null;
  const t = teamId ? _teamsCache.find(x => x.id === teamId) : null;
  _builderRows = t ? JSON.parse(JSON.stringify(t.hierarchy || [])) : [];
  if (_teamAgents.length === 0) { showToast('Create at least one agent first', 'warning'); return; }

  const managerOptions = _teamAgents.map(a =>
    `<option value="${a.id}" ${t && t.manager_id === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');

  showModal(teamId ? 'Edit Team' : 'Create Team', `
    <div class="form-group">
      <label class="form-label">Team Name *</label>
      <input class="form-input" id="teamName" placeholder="e.g., Alpha Engineering Crew" value="${t ? escapeHtml(t.name) : ''}">
    </div>
    <div class="form-group">
      <label class="form-label">Manager (Lead) *</label>
      <select class="form-select" id="teamManager" onchange="syncBuilderManager()">${managerOptions}</select>
    </div>
    <div class="form-group">
      <label class="form-label">Members & Reporting Lines</label>
      <div id="builderRows"></div>
      <button class="btn btn-sm btn-ghost" style="margin-top:8px" onclick="addBuilderRow()">+ Add member</button>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveTeam('${teamId || ''}')">${teamId ? 'Save Changes' : 'Create Team'}</button>
  `);
  syncBuilderManager();
}

// Ensure the manager exists in the hierarchy as the root (reports_to null).
function syncBuilderManager() {
  const mgr = document.getElementById('teamManager').value;
  const existing = _builderRows.find(r => r.agent_id === mgr);
  if (existing) { existing.reports_to = null; if (!existing.role) existing.role = 'Lead'; }
  else _builderRows.unshift({ agent_id: mgr, reports_to: null, role: 'Lead' });
  renderBuilderRows();
}

function addBuilderRow() {
  _builderRows.push({ agent_id: '', reports_to: null, role: 'Member' });
  renderBuilderRows();
}

function removeBuilderRow(idx) {
  _builderRows.splice(idx, 1);
  renderBuilderRows();
}

function renderBuilderRows() {
  const wrap = document.getElementById('builderRows');
  if (!wrap) return;
  const mgr = document.getElementById('teamManager') ? document.getElementById('teamManager').value : null;
  const agentOpt = (sel) => _teamAgents.map(a =>
    `<option value="${a.id}" ${sel === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
  wrap.innerHTML = _builderRows.map((r, i) => {
    const isManager = r.agent_id === mgr;
    const reportsOpt = `<option value="">— none (top) —</option>` + _builderRows
      .filter(o => o.agent_id && o.agent_id !== r.agent_id)
      .map(o => `<option value="${o.agent_id}" ${r.reports_to === o.agent_id ? 'selected' : ''}>${escapeHtml(agentName(o.agent_id))}</option>`).join('');
    return `
      <div class="builder-row">
        <select class="form-select" onchange="updateBuilderRow(${i},'agent_id',this.value)" ${isManager ? 'disabled' : ''}>
          <option value="">— select agent —</option>${agentOpt(r.agent_id)}
        </select>
        <select class="form-select" onchange="updateBuilderRow(${i},'reports_to',this.value)" ${isManager ? 'disabled' : ''}>
          ${isManager ? '<option value="">— Lead —</option>' : reportsOpt}
        </select>
        <input class="form-input" value="${escapeHtml(r.role || '')}" placeholder="role" onchange="updateBuilderRow(${i},'role',this.value)">
        ${isManager ? '<span class="badge badge-accent">Lead</span>' : `<button class="btn btn-sm btn-ghost" onclick="removeBuilderRow(${i})" style="color:var(--red)">${icon('x', 13)}</button>`}
      </div>`;
  }).join('');
}

function updateBuilderRow(idx, field, value) {
  if (!_builderRows[idx]) return;
  _builderRows[idx][field] = field === 'reports_to' ? (value || null) : value;
  if (field === 'agent_id') renderBuilderRows();
}

async function saveTeam(teamId) {
  const name = document.getElementById('teamName').value.trim();
  if (!name) { showToast('Team name is required', 'error'); return; }
  const manager_id = document.getElementById('teamManager').value;
  const hierarchy = _builderRows.filter(r => r.agent_id);
  const payload = { name, manager_id, hierarchy };
  try {
    if (teamId) {
      await api.updateTeam(teamId, payload);
      showToast('Team updated', 'success');
    } else {
      await api.createTeam(payload);
      showToast('Team created', 'success');
    }
    closeModal();
    renderTeams();
  } catch (err) {
    showToast('Failed to save team: ' + err.message, 'error');
  }
}

async function deleteTeam(teamId) {
  if (!confirm('Delete this team?')) return;
  try {
    await api.deleteTeam(teamId);
    showToast('Team deleted', 'info');
    renderTeams();
  } catch (err) {
    showToast('Failed to delete: ' + err.message, 'error');
  }
}
