let kanbanData = null;
let kanbanTeams = [];
let kanbanProjects = [];
let kanbanOpenRuns = {};   // kanban_id -> queued|running (live agent work)          // teams, for the team filter + role resolution
let kanbanAgentsMap = {};      // agent_id -> agent (for assignee display names)

async function renderKanban() {
  // refresh keeps the previous filters: snapshot before the DOM is rebuilt
  window._kanbanFilterSnap = {
    text: document.getElementById('kanbanFilterInput')?.value || '',
    priority: document.getElementById('kanbanFilterPriority')?.value || 'all',
    category: document.getElementById('kanbanFilterCategory')?.value || 'all',
    team: document.getElementById('kanbanFilterTeam')?.value || 'all',
    project: document.getElementById('kanbanFilterProject')?.value || 'all',
  };
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Kanban Board</div>
        <div class="page-subtitle">Visual task management — track, prioritize, and organize work</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showAddKanbanTask()">+ Add Task</button>
        <button class="btn btn-ghost" onclick="renderKanban()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="kanban-toolbar">
      <input class="form-input" id="kanbanFilterInput" placeholder="Filter tasks..." oninput="filterKanbanTasks()" style="flex:1;max-width:280px">
      <select class="form-select" id="kanbanFilterPriority" onchange="filterKanbanTasks()" style="width:120px">
        <option value="all">All Priorities</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
      <select class="form-select" id="kanbanFilterCategory" onchange="filterKanbanTasks()" style="width:140px">
        <option value="all">All Categories</option>
        <option value="development">Development</option>
        <option value="devops">DevOps</option>
        <option value="study">Study</option>
        <option value="content">Content</option>
        <option value="general">General</option>
      </select>
      <select class="form-select" id="kanbanFilterTeam" onchange="filterKanbanTasks()" style="width:180px">
        <option value="all">All Teams</option>
      </select>
      <select class="form-select" id="kanbanFilterProject" onchange="filterKanbanTasks()" style="width:180px">
        <option value="all">All Projects</option>
      </select>
    </div>
    <div class="kanban-board" id="kanbanBoard">
      <div class="skeleton" style="height:400px"></div>
    </div>
  `;
  // restore static filters now; team/project restore after their options load
  const snap = window._kanbanFilterSnap;
  document.getElementById('kanbanFilterInput').value = snap.text;
  document.getElementById('kanbanFilterPriority').value = snap.priority;
  document.getElementById('kanbanFilterCategory').value = snap.category;
  await loadKanbanData();
}

async function loadKanbanData() {
  try {
    // Pull board + teams + agents together so cards can show assignee names and roles.
    const [data, teamsData, agentsData, projData, agentTaskData] = await Promise.all([
      api.getKanbanBoard(),
      api.getTeams().catch(() => ({ teams: [] })),
      api.getCustomAgents().catch(() => ({ agents: [] })),
      api.getProjects().catch(() => ({ projects: [] })),
      api.getAgentTasks().catch(() => ({ tasks: [] })),
    ]);
    kanbanOpenRuns = {};
    (agentTaskData.tasks || []).forEach(t => {
      if (t.kanban_id && (t.status === 'queued' || t.status === 'running')) {
        kanbanOpenRuns[t.kanban_id] = t.status;
      }
    });
    kanbanData = data;
    kanbanTeams = teamsData.teams || [];
    kanbanProjects = projData.projects || [];
    const projSel = document.getElementById('kanbanFilterProject');
    if (projSel) {
      projSel.innerHTML = '<option value="all">All Projects</option>'
        + kanbanProjects.map(pr => `<option value="${pr.id}">${escapeHtml(pr.name)}</option>`).join('');
      projSel.value = window._kanbanFilterSnap?.project || 'all';
      if (projSel.selectedIndex === -1) projSel.value = 'all';
    }
    kanbanAgentsMap = {};
    (agentsData.agents || []).forEach(a => { kanbanAgentsMap[a.id] = a; });
    const teamSel = document.getElementById('kanbanFilterTeam');
    if (teamSel) {
      const current = teamSel.value;
      teamSel.innerHTML = `<option value="all">All Teams</option>` +
        kanbanTeams.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
      const wanted = window._kanbanFilterSnap?.team || current || 'all';
      teamSel.value = [...teamSel.options].some(o => o.value === wanted) ? wanted : 'all';
    }
    renderKanbanBoard();
  } catch (err) {
    const board = document.getElementById('kanbanBoard');
    if (board) board.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('clipboard', 32)}</div><div class="empty-state-title">Failed to load kanban</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

// Resolve an assignee agent_id to a display name and (within the selected team) a role.
function kanbanAssigneeInfo(task, selectedTeamId) {
  const id = task.assignee;
  if (!id) return null;
  const name = kanbanAgentsMap[id] ? kanbanAgentsMap[id].name : id;
  let role = '';
  const teamId = selectedTeamId && selectedTeamId !== 'all' ? selectedTeamId : task.team_id;
  if (teamId) {
    const team = kanbanTeams.find(t => t.id === teamId);
    const node = team && (team.hierarchy || []).find(n => n.agent_id === id);
    if (node) role = node.role || '';
    if (!role && team && team.manager_id === id) role = 'Lead';
  }
  return { name, role };
}

// Members of a team = manager + every hierarchy agent_id.
function teamMemberIds(teamId) {
  const team = kanbanTeams.find(t => t.id === teamId);
  if (!team) return new Set();
  const ids = new Set((team.hierarchy || []).map(n => n.agent_id));
  if (team.manager_id) ids.add(team.manager_id);
  return ids;
}

function renderKanbanBoard() {
  const board = document.getElementById('kanbanBoard');
  if (!board || !kanbanData) return;
  const columnsObj = kanbanData.columns || {};
  const columns = Object.keys(columnsObj);
  const allTasks = kanbanData.tasks || Object.values(columnsObj).flat();
  const filterText = (document.getElementById('kanbanFilterInput')?.value || '').toLowerCase();
  const filterPriority = document.getElementById('kanbanFilterPriority')?.value || 'all';
  const filterCategory = document.getElementById('kanbanFilterCategory')?.value || 'all';
  const filterTeam = document.getElementById('kanbanFilterTeam')?.value || 'all';
  const filterProject = document.getElementById('kanbanFilterProject')?.value || 'all';
  const teamMembers = filterTeam !== 'all' ? teamMemberIds(filterTeam) : null;
  const columnLabels = { triage: 'Triage', todo: 'To Do', ready: 'Ready', in_progress: 'In Progress', blocked: 'Blocked', done: 'Done', backlog: 'Backlog', review: 'Review' };
  const columnIcons = { triage: icon('search', 14), todo: icon('pencil', 14), ready: icon('check-circle', 14), in_progress: icon('refresh', 14), blocked: icon('ban', 14), done: icon('sparkle', 14), backlog: icon('clipboard', 14), review: icon('search', 14) };
  board.innerHTML = columns.map(col => {
    let colTasks = (columnsObj[col] || []).filter(t => {
      if (filterText) return (t.title || '').toLowerCase().includes(filterText) || (t.body || t.description || '').toLowerCase().includes(filterText);
      return true;
    }).filter(t => filterPriority === 'all' || (t.priority || 'medium') === filterPriority)
      .filter(t => filterCategory === 'all' || (t.category || 'general') === filterCategory)
      .filter(t => !teamMembers || t.team_id === filterTeam || teamMembers.has(t.assignee))
      .filter(t => filterProject === 'all' || t.project_id === filterProject);
    return `
      <div class="kanban-column" data-column="${col}">
        <div class="kanban-column-header">
          <div class="kanban-column-title">
            <span>${columnIcons[col] || icon('pin', 14)}</span>
            ${columnLabels[col] || col}
            <span class="kanban-count">${colTasks.length}</span>
          </div>
        </div>
        <div class="kanban-column-body" ondragover="event.preventDefault()" ondrop="onKanbanDrop(event, '${col}')">
          ${colTasks.length === 0 ? `<div class="kanban-empty">No tasks</div>` :
            colTasks.map(t => `
              <div class="kanban-card" draggable="true" ondragstart="onKanbanDrag(event, '${t.id}')" onclick="showKanbanDetail('${t.id}')">
                <div class="kanban-card-header">
                  <span class="kanban-priority priority-${t.priority || 'medium'}">${t.priority || 'medium'}</span>
                </div>
                <div class="kanban-card-title">${escapeHtml(t.title)}</div>
                ${t.project_id ? `<span class="badge badge-info" style="margin:2px 0">${icon('folder', 10)} ${escapeHtml(kanbanProjectName(t.project_id))}</span>` : ''}
                ${t.body ? `<div class="kanban-card-desc">${escapeHtml(t.body.substring(0, 80))}${t.body.length > 80 ? '...' : ''}</div>` : ''}
                <div class="kanban-card-meta">
                  ${(() => { const info = kanbanAssigneeInfo(t, filterTeam); return info ? `<span>${icon('user', 13)} ${escapeHtml(info.name)}</span>${info.role ? ` <span class="badge badge-info">${escapeHtml(info.role)}</span>` : ''}` : ''; })()}
                </div>
                ${t.status === 'blocked' ? `<div class="kanban-blocked-badge">${icon('ban', 13)} Blocked</div>` : ''}
                ${kanbanOpenRuns[t.id] ? `<div class="state-tag st-working" style="margin-top:6px;display:inline-flex;align-items:center;gap:5px"><span class="dot warn" style="width:5px;height:5px"></span> agent ${kanbanOpenRuns[t.id]}</div>` : ''}
              </div>
            `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function kanbanProjectName(projectId) {
  const pr = kanbanProjects.find(x => x.id === projectId);
  return pr ? pr.name : projectId;
}

function showAddKanbanTask() {
  const modal = document.getElementById('modalContainer');
  modal.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:520px">
        <div class="modal-header">
          <div class="modal-title">Add Kanban Task</div>
          <button class="modal-close" onclick="closeModal()" title="Close">${icon('x', 13)}</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Title *</label>
            <input class="form-input" id="kanbanTitle" placeholder="e.g., Implement login page">
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" id="kanbanDescription" rows="2" placeholder="Brief description"></textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Status</label>
              <select class="form-select" id="kanbanStatus">
                <option value="triage">Triage</option>
                <option value="todo">To Do</option>
                <option value="ready">Ready</option>
                <option value="in_progress">In Progress</option>
                <option value="blocked">Blocked</option>
                <option value="done">Done</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Priority</label>
              <select class="form-select" id="kanbanPriority">
                <option value="low">Low</option>
                <option value="medium" selected>Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Category</label>
              <select class="form-select" id="kanbanCategory">
                <option value="general">General</option>
                <option value="development">Development</option>
                <option value="devops">DevOps</option>
                <option value="study">Study</option>
                <option value="content">Content</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Assigned To</label>
              <input class="form-input" id="kanbanAssigned" placeholder="e.g., opencode" style="text-transform:lowercase">
            </div>
            <div class="form-group">
              <label class="form-label">Target Date</label>
              <input class="form-input" id="kanbanDate" type="date">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Project <span class="text-muted text-xs">(align this task to a project)</span></label>
            <select class="form-select" id="kanbanProject">
              <option value="">— none —</option>
              ${kanbanProjects.map(pr => `<option value="${pr.id}">${escapeHtml(pr.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Tags (comma separated)</label>
            <input class="form-input" id="kanbanTags" placeholder="e.g., frontend, api">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="createKanbanTask()">Add Task</button>
        </div>
      </div>
    </div>
  `;
}

async function createKanbanTask() {
  const title = document.getElementById('kanbanTitle').value.trim();
  if (!title) { showToast('Title is required', 'error'); return; }
  const tagsStr = document.getElementById('kanbanTags').value.trim();
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
  try {
    await api.createKanbanTask({
      title,
      body: document.getElementById('kanbanDescription').value.trim(),
      status: document.getElementById('kanbanStatus').value,
      priority: document.getElementById('kanbanPriority').value,
      assignee: document.getElementById('kanbanAssigned').value.trim(),
      project_id: document.getElementById('kanbanProject').value,
    });
    showToast('Task added to kanban board!', 'success');
    closeModal();
    renderKanban();
  } catch (err) {
    showToast('Failed to create task: ' + err.message, 'error');
  }
}

function showEditKanbanTask(id) {
  const task = kanbanFindTask(id);
  if (!task) { showToast('Task not found — refresh the board', 'error'); return; }
  const statuses = ['triage', 'todo', 'ready', 'in_progress', 'blocked', 'done'];
  showModal('Edit Task', `
    <div class="form-group">
      <label class="form-label">Title *</label>
      <input class="form-input" id="ekTitle" value="${escapeHtml(task.title)}">
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea class="form-textarea" id="ekBody" rows="3">${escapeHtml(task.body || '')}</textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Status</label>
        <select class="form-select" id="ekStatus">
          ${statuses.map(st => `<option value="${st}" ${task.status === st ? 'selected' : ''}>${st.replace('_', ' ')}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Priority</label>
        <select class="form-select" id="ekPriority">
          ${['low', 'medium', 'high'].map(pr => `<option value="${pr}" ${(task.priority || 'medium') === pr ? 'selected' : ''}>${pr}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Assignee</label>
        <input class="form-input" id="ekAssignee" value="${escapeHtml(task.assignee || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">Project</label>
        <select class="form-select" id="ekProject">
          <option value="">— none —</option>
          ${kanbanProjects.map(pr => `<option value="${pr.id}" ${task.project_id === pr.id ? 'selected' : ''}>${escapeHtml(pr.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Dispatch to agent <span class="text-muted text-xs">(wakes it NOW with this task after saving)</span></label>
      <select class="form-select" id="ekWakeAgent">
        <option value="">— don't dispatch —</option>
        ${Object.values(kanbanAgentsMap).map(a => `<option value="${a.id}" ${task.assignee === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
      </select>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveKanbanEdit('${task.id}')">${icon('save', 13)} Save</button>
  `);
}

async function saveKanbanEdit(id) {
  const title = document.getElementById('ekTitle').value.trim();
  if (!title) { showToast('Title is required', 'error'); return; }
  try {
    await api.updateKanbanTask(id, {
      title,
      body: document.getElementById('ekBody').value,
      status: document.getElementById('ekStatus').value,
      priority: document.getElementById('ekPriority').value,
      assignee: document.getElementById('ekAssignee').value.trim(),
      project_id: document.getElementById('ekProject').value,
    });
    const wakeAgent = document.getElementById('ekWakeAgent').value;
    if (wakeAgent) {
      await api.assignKanbanAgent(id, wakeAgent, true);
      showToast('Task updated — agent woken with it (runs in background)', 'success');
      if (typeof updateInboxBadge === 'function') updateInboxBadge();
    } else {
      showToast('Task updated', 'success');
    }
    closeModal();
    renderKanban();   // filters survive via the snapshot
  } catch (err) {
    showToast('Failed to update: ' + err.message, 'error');
  }
}

let kanbanDraggedId = null;
function onKanbanDrag(e, id) {
  kanbanDraggedId = id;
  e.dataTransfer.effectAllowed = 'move';
}
async function onKanbanDrop(e, status) {
  e.preventDefault();
  if (!kanbanDraggedId) return;
  try {
    await api.updateKanbanTask(kanbanDraggedId, { status });
    kanbanDraggedId = null;
    renderKanban();
  } catch (err) {
    showToast('Failed to move task: ' + err.message, 'error');
  }
}

function kanbanFindTask(id) {
  const all = (kanbanData && kanbanData.tasks)
    || Object.values((kanbanData && kanbanData.columns) || {}).flat();
  return all.find(t => t.id === id);
}

function showKanbanDetail(id) {
  const task = kanbanFindTask(id);
  if (!task) return;
  const modal = document.getElementById('modalContainer');
  modal.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:560px">
        <div class="modal-header">
          <div class="modal-title">${escapeHtml(task.title)}</div>
          <button class="modal-close" onclick="closeModal()" title="Close">${icon('x', 13)}</button>
        </div>
        <div class="modal-body">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
            <span class="badge badge-${task.status === 'done' ? 'success' : task.status === 'in_progress' ? 'info' : 'warning'}">${task.status}</span>
            <span class="kanban-priority priority-${task.priority || 'medium'}">${task.priority}</span>
            ${task.status === 'blocked' ? `<span class="badge badge-danger">${icon('ban', 13)} Blocked</span>` : ''}
          </div>
          ${task.body ? `<div style="margin-bottom:12px;color:var(--text-secondary);font-size:13px">${escapeHtml(task.body)}</div>` : ''}
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;font-size:12px">
            ${task.assignee ? `<span>${icon('user', 13)} <strong>${escapeHtml(task.assignee)}</strong></span>` : ''}
            <span>${icon('clock', 13)} <strong>${task.created || 'N/A'}</strong></span>
            ${task.completed_at ? `<span>${icon('check-circle', 13)} <strong>${task.completed_at}</strong></span>` : ''}
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            ${task.status !== 'done' ? `<button class="btn btn-sm btn-primary" onclick="completeKanbanTask('${task.id}')">${icon('check', 13)} Mark Done</button>` : ''}
            ${task.status !== 'blocked' ? `<button class="btn btn-sm btn-ghost" onclick="blockKanbanTask('${task.id}')">${icon('ban', 13)} Block</button>` : `<button class="btn btn-sm btn-ghost" onclick="unblockKanbanTask('${task.id}')">${icon('unlock', 13)} Unblock</button>`}
            <button class="btn btn-sm btn-ghost" onclick="showEditKanbanTask('${task.id}')">${icon('pencil', 13)} Edit</button>
            <button class="btn btn-sm btn-ghost" onclick="deleteKanbanTask('${task.id}')" style="color:var(--red)">${icon('trash', 13)} Delete</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function completeKanbanTask(id) {
  try {
    await api.completeKanbanTask(id);
    closeModal();
    renderKanban();
    showToast('Task completed!', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function blockKanbanTask(id) {
  try {
    await api.blockKanbanTask(id);
    closeModal();
    renderKanban();
    showToast('Task blocked', 'warning');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function unblockKanbanTask(id) {
  try {
    await api.unblockKanbanTask(id);
    closeModal();
    renderKanban();
    showToast('Task unblocked', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function deleteKanbanTask(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await api.deleteKanbanTask(id);
    closeModal();
    renderKanban();
    showToast('Task deleted', 'info');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

function filterKanbanTasks() {
  renderKanbanBoard();
}
