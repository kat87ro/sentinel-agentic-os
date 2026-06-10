// Projects — a real folder + goal + assigned team + project-scoped chat.
// The team's agents answer with memory injected ONLY from this project's
// vault (brain/projects/<slug>/), plus the project goal & folder context.

let _projectsCache = [];
let _projectTeams = [];
let _projectAgents = [];
let _activeProject = null;

async function renderProjects() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Projects</div>
        <div class="page-subtitle">Folder + goal + team — each project chats in its own memory</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showProjectModal()">+ New Project</button>
        <button class="btn btn-ghost" onclick="renderProjects()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="grid grid-3" id="projectList">${renderSkeleton(3)}</div>
    <div id="projectDetail" style="display:none"></div>
  `;
  try {
    const [projData, teamData, agentData] = await Promise.all([
      api.getProjects(),
      api.getTeams().catch(() => ({ teams: [] })),
      api.getCustomAgents().catch(() => ({ agents: [] })),
    ]);
    _projectsCache = projData.projects || [];
    _projectTeams = teamData.teams || [];
    _projectAgents = agentData.agents || [];
    const list = document.getElementById('projectList');
    if (!list) return;
    if (_projectsCache.length === 0) {
      list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('folder', 32)}</div><div class="empty-state-title">No projects yet</div><div class="empty-state-desc">Create a project to give a team a goal, a folder, and its own chat & memory</div></div>`;
      return;
    }
    list.innerHTML = _projectsCache.map(p => {
      const team = _projectTeams.find(t => t.id === p.team_id);
      return `
        <div class="card" style="cursor:pointer" onclick="openProject('${p.id}')">
          <div class="flex items-center gap-2" style="margin-bottom:8px">
            <div class="agent-avatar" style="background:var(--accent-glow);color:var(--accent)">${icon('folder', 16)}</div>
            <div>
              <div class="card-title" style="margin:0">${escapeHtml(p.name)}</div>
              <div class="mono text-xs" style="color:var(--text-faint)">${team ? escapeHtml(team.name) : 'no team'} · ${p.message_count || 0} messages</div>
            </div>
          </div>
          ${p.goal ? `<div class="text-muted text-sm" style="margin-bottom:8px">${icon('target', 12)} ${escapeHtml(p.goal)}</div>` : ''}
          ${p.path ? `<div class="mono text-xs truncate" style="color:var(--text-faint)">${escapeHtml(p.path)}</div>` : ''}
          <div style="display:flex;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border-soft)">
            <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();openProject('${p.id}')">${icon('message', 13)} Open chat</button>
            <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();showProjectModal('${p.id}')">${icon('pencil', 13)}</button>
            <button class="btn btn-sm btn-ghost" style="margin-left:auto;color:var(--crit)" onclick="event.stopPropagation();deleteProjectUI('${p.id}')">${icon('trash', 13)}</button>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    document.getElementById('projectList').innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Failed to load projects</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

function showProjectModal(projectId) {
  const p = projectId ? _projectsCache.find(x => x.id === projectId) : null;
  const teamOptions = ['<option value="">— no team —</option>']
    .concat(_projectTeams.map(t => `<option value="${t.id}" ${p && p.team_id === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)).join('');
  showModal(p ? 'Edit Project' : 'New Project', `
    <div class="form-group">
      <label class="form-label">Name *</label>
      <input class="form-input" id="prjName" placeholder="e.g., Data Platform" value="${p ? escapeHtml(p.name) : ''}">
    </div>
    <div class="form-group">
      <label class="form-label">Project folder <span class="text-muted text-xs">(existing local path — its contents become chat context)</span></label>
      <div style="display:flex;gap:6px">
        <input class="form-input" id="prjPath" style="flex:1" placeholder="/Users/you/repos/my-project" value="${p ? escapeHtml(p.path || '') : ''}">
        <button class="btn btn-ghost" type="button" id="prjBrowseBtn" onclick="pickProjectFolder()">${icon('folder', 13)} Browse…</button>
      </div>
      <div class="form-hint" id="prjBrowseHint"></div>
    </div>
    <div class="form-group">
      <label class="form-label">Project goal</label>
      <textarea class="form-textarea" id="prjGoal" rows="3" placeholder="What does done look like?">${p ? escapeHtml(p.goal || '') : ''}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Assigned team</label>
      <select class="form-select" id="prjTeam">${teamOptions}</select>
      <div class="form-hint">Project chat routes to this team's agents; memory stays scoped to the project</div>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveProjectUI('${projectId || ''}')">${p ? 'Save' : 'Create Project'}</button>
  `);
}

// ─── Folder picker — the NATIVE macOS dialog, opened by the server ──
// A browser page can never read an absolute path from its own file picker
// (sandbox), but this app runs on localhost: the server lives in the
// operator's GUI session and opens a real Finder "choose folder" dialog.

async function pickProjectFolder() {
  const btn = document.getElementById('prjBrowseBtn');
  const hint = document.getElementById('prjBrowseHint');
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = 'A Finder dialog just opened — it may be behind this window…';
  try {
    const r = await api.pickFolder();
    if (r.status === 'ok' && r.path) {
      const input = document.getElementById('prjPath');
      if (input) input.value = r.path;
      if (hint) hint.textContent = '';
    } else if (hint) {
      hint.textContent = '';   // cancelled — nothing to say
    }
  } catch (err) {
    if (hint) hint.textContent = err.message + ' — you can type the path manually';
    showToast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveProjectUI(projectId) {
  const payload = {
    name: document.getElementById('prjName').value.trim(),
    path: document.getElementById('prjPath').value.trim(),
    goal: document.getElementById('prjGoal').value.trim(),
    team_id: document.getElementById('prjTeam').value,
  };
  if (!payload.name) { showToast('Name is required', 'error'); return; }
  try {
    if (projectId) {
      await api.updateProject(projectId, payload);
      showToast('Project updated', 'success');
    } else {
      await api.createProject(payload);
      showToast('Project created — its memory vault is seeded with the goal', 'success');
    }
    closeModal();
    renderProjects();
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
  }
}

async function deleteProjectUI(projectId) {
  if (!confirm('Delete this project? Its memory vault and chat log stay on disk.')) return;
  try {
    await api.deleteProject(projectId);
    showToast('Project deleted (memory kept on disk)', 'info');
    renderProjects();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Project detail: scoped chat ─────────────────────────────────

async function openProject(projectId) {
  _activeProject = _projectsCache.find(p => p.id === projectId);
  if (!_activeProject) return;
  const team = _projectTeams.find(t => t.id === _activeProject.team_id);
  const memberIds = team ? Array.from(new Set([team.manager_id].concat((team.hierarchy || []).map(h => h.agent_id)))) : [];
  document.getElementById('projectList').style.display = 'none';
  const detail = document.getElementById('projectDetail');
  detail.style.display = 'block';
  detail.innerHTML = `
    <div style="margin-bottom:14px;display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost" onclick="closeProject()">← Back</button>
      <div>
        <div style="font-size:15px;font-weight:600">${escapeHtml(_activeProject.name)}</div>
        <div class="mono text-xs" style="color:var(--text-faint)">
          ${_activeProject.goal ? `${escapeHtml(_activeProject.goal)} · ` : ''}${team ? escapeHtml(team.name) : 'no team'} · memory: brain/projects/${escapeHtml(_activeProject.slug)}/
        </div>
      </div>
      ${memberIds.length ? `
      <button class="btn btn-primary" style="margin-left:auto" onclick="showAssignTaskModal()">${icon('zap', 13)} Assign task</button>
      <select class="form-select" id="prjChatAgent" style="width:220px">
        <option value="">${escapeHtml(team.name)} manager (default)</option>
        ${memberIds.map(id => `<option value="${id}">${escapeHtml(projectAgentName(id))}</option>`).join('')}
      </select>` : '<span class="badge badge-warning" style="margin-left:auto">assign a team to chat</span>'}
    </div>
    <div id="prjGoals" style="margin-bottom:12px"></div>
    <div id="prjTaskQueue" style="margin-bottom:12px"></div>
    <div class="card" style="padding:0;display:flex;flex-direction:column;height:560px">
      <div id="prjChatMessages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px"></div>
      <div class="chat-input-area">
        <textarea id="prjChatInput" class="chat-input" rows="1" placeholder="Message the project team…"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendProjectMessage();}"></textarea>
        <button class="btn btn-primary btn-icon" onclick="sendProjectMessage()" title="Send">${icon('send', 14)}</button>
      </div>
    </div>
  `;
  await loadProjectChat();
  loadProjectGoals();
  loadProjectTasks();
}

// ─── Project detail: agent task queue (cancel queued / delete finished) ──

const TASK_STATUS_BADGE = { queued: 'info', running: 'warning', done: 'success', needs_input: 'warning', failed: 'danger' };

async function loadProjectTasks() {
  if (!_activeProject) return;
  try {
    const data = await api.getAgentTasks(`project_id=${encodeURIComponent(_activeProject.id)}`);
    const tasks = (data.tasks || []).slice().reverse();
    const box = document.getElementById('prjTaskQueue');
    if (!box) return;
    if (tasks.length === 0) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <details class="card" style="padding:10px 14px" ${tasks.some(t => t.status === 'queued' || t.status === 'running') ? 'open' : ''}>
        <summary style="cursor:pointer;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:8px">
          ${icon('list', 14)} Task queue <span class="badge badge-neutral">${tasks.length}</span>
          <button class="btn btn-sm btn-ghost" style="margin-left:auto" onclick="event.preventDefault();loadProjectTasks()">${icon('refresh', 12)}</button>
        </summary>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto">
          ${tasks.map(t => `
            <div style="display:flex;align-items:center;gap:10px;font-size:12.5px;padding:6px 8px;border-radius:6px;background:var(--bg-sunken,rgba(0,0,0,.15))">
              <span class="badge badge-${TASK_STATUS_BADGE[t.status] || 'neutral'}">${escapeHtml(t.status)}</span>
              <span class="truncate" style="flex:1" title="${escapeHtml(t.title || t.message || '')}">${escapeHtml(t.title || (t.message || '').slice(0, 60))}</span>
              <span class="mono text-xs" style="color:var(--text-faint)">${escapeHtml(projectAgentName(t.agent_id))} · ${timeAgo(new Date((t.ts || 0) * 1000).toISOString())}</span>
              ${t.status === 'queued'
                ? `<button class="btn btn-sm btn-ghost" style="color:var(--warn)" title="Cancel" onclick="removeProjectTask('${t.id}', true)">${icon('x', 12)}</button>`
                : (t.status === 'running' ? ''
                : `<button class="btn btn-sm btn-ghost" style="color:var(--crit)" title="Delete" onclick="removeProjectTask('${t.id}', false)">${icon('trash', 12)}</button>`)}
            </div>`).join('')}
        </div>
      </details>`;
  } catch {}
}

async function removeProjectTask(taskId, isCancel) {
  if (!confirm(isCancel ? 'Cancel this queued task?' : 'Delete this finished task from the queue history?')) return;
  try {
    await api.cancelAgentTask(taskId);
    showToast(isCancel ? 'Task cancelled' : 'Task deleted', 'info');
    loadProjectTasks();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadProjectGoals() {
  if (!_activeProject) return;
  try {
    const data = await api.getGoals(_activeProject.id);
    const goals = (data.goals || []);
    const box = document.getElementById('prjGoals');
    if (!box) return;
    box.innerHTML = goals.length === 0 ? '' : goals.map(g => `
      <div class="card" style="padding:10px 14px;margin-bottom:6px;display:flex;align-items:center;gap:12px">
        ${icon('target', 14)}
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px;font-weight:600">${escapeHtml(g.title)}</div>
          ${g.description ? `<div class="text-muted text-xs truncate">${escapeHtml(g.description)}</div>` : ''}
        </div>
        <div class="goal-card-progress" style="width:180px;margin:0">
          <div class="goal-card-progress-bar"><div class="goal-card-progress-fill" style="width:${g.progress || 0}%"></div></div>
          <div class="goal-card-progress-text">${g.task_total != null ? `${g.task_done}/${g.task_total}` : (g.progress || 0) + '%'}</div>
        </div>
        <span class="badge badge-${g.status === 'completed' ? 'success' : 'info'}">${g.status}</span>
      </div>`).join('');
  } catch {}
}

// Operator task assignment — wakes the chosen agent immediately (or queues
// for its next heartbeat). Defaults to the team Lead.
function showAssignTaskModal() {
  if (!_activeProject) return;
  const team = _projectTeams.find(t => t.id === _activeProject.team_id);
  if (!team) { showToast('Assign a team to this project first', 'warning'); return; }
  const memberIds = Array.from(new Set([team.manager_id].concat((team.hierarchy || []).map(h => h.agent_id))));
  showModal('Assign Task', `
    <div class="form-group">
      <label class="form-label">Assignee</label>
      <select class="form-select" id="atAgent">
        ${memberIds.map(id => `<option value="${id}" ${id === team.manager_id ? 'selected' : ''}>${escapeHtml(projectAgentName(id))}${id === team.manager_id ? ' (Lead)' : ''}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="atTitle" placeholder="short task title">
    </div>
    <div class="form-group">
      <label class="form-label">Task *</label>
      <textarea class="form-textarea" id="atMessage" rows="4" placeholder="What should the agent do? The Lead can delegate subtasks to teammates with [DELEGATE: name] lines."></textarea>
    </div>
    <div class="form-group">
      <label class="check-chip"><input type="checkbox" id="atWake" checked> Wake the agent now (unchecked = wait for its heartbeat)</label>
    </div>
    <div id="atResult"></div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="assignTaskUI()">${icon('zap', 13)} Assign</button>
  `);
}

async function assignTaskUI() {
  const message = document.getElementById('atMessage').value.trim();
  if (!message) { showToast('Task is required', 'error'); return; }
  const out = document.getElementById('atResult');
  const wake = document.getElementById('atWake').checked;
  try {
    const r = await api.createAgentTask({
      agent_id: document.getElementById('atAgent').value,
      title: document.getElementById('atTitle').value.trim(),
      message,
      project_id: _activeProject.id,
      wake,
    });
    if (!wake) {
      closeModal();
      showToast('Task queued — the agent will pick it up on its next heartbeat', 'success');
      return;
    }
    // Wake runs in the BACKGROUND on the server — poll the task status here
    // instead of hanging; the modal stays closable the whole time.
    showToast('Agent woken — running in the background', 'success');
    out.innerHTML = `<div class="loading" style="padding:14px"><div class="loading-spinner"></div><span id="atPollStatus">running…</span></div>`;
    pollAssignedTask(r.task.id, r.task.agent_id);
    loadProjectChat();
  } catch (err) {
    out.innerHTML = `<div style="color:var(--crit);font-size:12.5px;margin-top:8px">${escapeHtml(err.message)}</div>`;
  }
}

let _atPollTimer = null;
function pollAssignedTask(taskId, agentId) {
  if (_atPollTimer) clearInterval(_atPollTimer);
  const started = Date.now();
  _atPollTimer = setInterval(async () => {
    const statusEl = document.getElementById('atPollStatus');
    if (!statusEl || Date.now() - started > 15 * 60 * 1000) {   // modal closed or 15min
      clearInterval(_atPollTimer); _atPollTimer = null; return;
    }
    try {
      const data = await api.getAgentTasks(`agent_id=${encodeURIComponent(agentId)}`);
      const t = (data.tasks || []).find(x => x.id === taskId);
      if (!t) return;
      if (t.status === 'queued' || t.status === 'running') {
        statusEl.textContent = t.status + '…';
        return;
      }
      clearInterval(_atPollTimer); _atPollTimer = null;
      const out = document.getElementById('atResult');
      if (out) out.innerHTML = `
        <div class="text-xs mono" style="margin:8px 0;color:${t.status === 'done' ? 'var(--ok)' : 'var(--warn)'}">status: ${escapeHtml(t.status)}</div>
        <pre style="max-height:240px;overflow:auto;white-space:pre-wrap">${escapeHtml(t.result || '')}</pre>`;
      loadProjectChat();
      updateInboxBadge();
    } catch {}
  }, 4000);
}

function projectAgentName(agentId) {
  const a = _projectAgents.find(x => x.id === agentId);
  return a ? a.name : (agentId || 'agent');
}

function closeProject() {
  _activeProject = null;
  document.getElementById('projectDetail').style.display = 'none';
  document.getElementById('projectList').style.display = '';
  renderProjects();
}

async function loadProjectChat() {
  if (!_activeProject) return;
  try {
    const data = await api.getProjectChat(_activeProject.id);
    const box = document.getElementById('prjChatMessages');
    if (!box) return;
    const msgs = data.messages || [];
    box.innerHTML = msgs.length === 0
      ? `<div class="empty-state" style="border:none;background:transparent;margin:auto"><div class="empty-state-icon">${icon('message', 32)}</div><div class="empty-state-title">Project chat</div><div class="empty-state-desc">Messages here go to the assigned team with this project's memory only</div></div>`
      : msgs.map(m => `
        <div class="chat-message ${m.role === 'user' ? 'user' : 'assistant'}" style="max-width:88%">
          <div class="chat-message-body">
            <div class="chat-message-header">
              <span class="chat-message-agent">${m.role === 'user' ? 'You' : escapeHtml(projectAgentName(m.agent_id) || 'agent')}</span>
              <span class="chat-message-time">${timeAgo(m.timestamp)}</span>
            </div>
            <div class="chat-message-content">${escapeHtml(m.content)}</div>
          </div>
        </div>`).join('');
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    showToast('Failed to load chat: ' + err.message, 'error');
  }
}

async function sendProjectMessage() {
  if (!_activeProject) return;
  const input = document.getElementById('prjChatInput');
  const message = (input.value || '').trim();
  if (!message) return;
  const agentSel = document.getElementById('prjChatAgent');
  input.value = '';
  const box = document.getElementById('prjChatMessages');
  box.insertAdjacentHTML('beforeend', `
    <div class="chat-message user" style="max-width:88%"><div class="chat-message-body">
      <div class="chat-message-content">${escapeHtml(message)}</div></div></div>
    <div class="chat-message assistant" id="prjPending" style="max-width:88%"><div class="chat-message-body">
      <div class="typing-indicator"><span></span><span></span><span></span></div></div></div>`);
  box.scrollTop = box.scrollHeight;
  try {
    const r = await api.sendProjectChat(_activeProject.id, message, agentSel ? agentSel.value : '');
    document.getElementById('prjPending')?.remove();
    box.insertAdjacentHTML('beforeend', `
      <div class="chat-message assistant" style="max-width:88%"><div class="chat-message-body">
        <div class="chat-message-header"><span class="chat-message-agent">${escapeHtml(r.agent.name)}</span></div>
        <div class="chat-message-content">${escapeHtml(r.result)}</div></div></div>`);
    box.scrollTop = box.scrollHeight;
    updateInboxBadge();   // the reply may have filed a NEEDS_INPUT item
  } catch (err) {
    document.getElementById('prjPending')?.remove();
    showToast('Chat failed: ' + err.message, 'error');
  }
}
