async function renderGoals() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Goals</div>
        <div class="page-subtitle">Project targets, task lists, and progress tracking</div>
      </div>
      <div class="btn-group">
        <select class="form-select" id="goalFilterProject" style="width:190px" onchange="renderGoalsFiltered()">
          <option value="">All projects</option>
        </select>
        <button class="btn btn-primary" onclick="showCreateGoalModal()">+ New Goal</button>
        <button class="btn btn-ghost" onclick="renderGoals()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="flex gap-3" style="margin-bottom:16px">
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="goalTotalCount">0</div>
        <div class="metric-tile-label">Total Goals</div>
      </div>
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="goalActiveCount">0</div>
        <div class="metric-tile-label">Active</div>
      </div>
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="goalCompleteCount">0</div>
        <div class="metric-tile-label">Completed</div>
      </div>
      <div class="metric-tile" style="flex:1">
        <div class="metric-tile-value" id="goalAvgProgress">0%</div>
        <div class="metric-tile-label">Avg Progress</div>
      </div>
    </div>
    <div class="grid grid-3" id="goalList"></div>
  `;
  try {
    const [data, projData] = await Promise.all([
      api.getGoals(),
      api.getProjects().catch(() => ({ projects: [] })),
    ]);
    window._goalProjects = projData.projects || [];
    const sel = document.getElementById('goalFilterProject');
    if (sel) {
      sel.innerHTML = '<option value="">All projects</option>'
        + window._goalProjects.map(pr => `<option value="${pr.id}">${escapeHtml(pr.name)}</option>`).join('');
      if (window._goalFilterProject) sel.value = window._goalFilterProject;
    }
    let goals = data.goals || [];
    window._allGoals = goals;
    if (window._goalFilterProject) goals = goals.filter(g => g.project_id === window._goalFilterProject);
    const list = document.getElementById('goalList');
    const totalEl = document.getElementById('goalTotalCount');
    const activeEl = document.getElementById('goalActiveCount');
    const completeEl = document.getElementById('goalCompleteCount');
    const avgEl = document.getElementById('goalAvgProgress');
    if (!list) return;
    if (goals.length === 0) {
      list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('target', 32)}</div><div class="empty-state-title">No goals yet</div><div class="empty-state-desc">Create your first goal to start tracking progress</div></div>`;
      if (totalEl) totalEl.textContent = '0';
      if (activeEl) activeEl.textContent = '0';
      if (completeEl) completeEl.textContent = '0';
      if (avgEl) avgEl.textContent = '0%';
      return;
    }
    const active = goals.filter(g => g.status === 'active').length;
    const done = goals.filter(g => g.status === 'completed').length;
    const avgProg = Math.round(goals.reduce((s, g) => s + (g.progress || 0), 0) / goals.length);
    if (totalEl) totalEl.textContent = goals.length;
    if (activeEl) activeEl.textContent = active;
    if (completeEl) completeEl.textContent = done;
    if (avgEl) avgEl.textContent = avgProg + '%';
    list.innerHTML = goals.map(g => `
      <div class="goal-card">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span class="badge badge-${g.status === 'completed' ? 'success' : g.status === 'active' ? 'info' : 'warning'}">${g.status}</span>
          <span class="badge badge-accent">${g.category}</span>
          ${g.project_id ? `<span class="badge badge-info">${icon('folder', 10)} ${escapeHtml(goalProjectName(g.project_id))}</span>` : ''}
          ${g.target_date ? `<span class="text-muted text-xs">${icon('target', 13)} ${g.target_date}</span>` : ''}
        </div>
        <div class="goal-card-title">${escapeHtml(g.title)}</div>
        ${g.description ? `<div class="text-muted text-sm" style="margin-bottom:8px">${escapeHtml(g.description)}</div>` : ''}
        <div class="goal-card-progress">
          <div class="goal-card-progress-bar"><div class="goal-card-progress-fill" style="width:${g.progress || 0}%"></div></div>
          <div class="goal-card-progress-text">${g.task_total != null ? `${g.task_done}/${g.task_total}` : (g.progress || 0) + '%'}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
          ${g.task_total != null ? `<span class="text-muted text-xs mono">${g.progress}% · derived from ${g.task_total} task(s)</span>` : ''}
          <button class="btn btn-sm ${g.status !== 'completed' ? 'btn-primary' : 'btn-ghost'}" style="${g.task_total != null ? 'display:none' : ''}" onclick="updateGoalProgress('${g.id}', ${Math.min((g.progress || 0) + 25, 100)})">
            ${g.status !== 'completed' ? '+25%' : icon('check-circle', 13) + ' Done'}
          </button>
          ${g.status !== 'completed' ? `<button class="btn btn-sm btn-ghost" onclick="completeGoal('${g.id}')">Mark Complete</button>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="showCreateGoalModal('${g.id}')" title="Edit goal">${icon('pencil', 13)}</button>
          <button class="btn btn-sm btn-ghost" onclick="deleteGoal('${g.id}')" style="margin-left:auto;color:var(--red)" title="Delete goal">${icon('trash', 13)}</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast('Failed to load goals: ' + err.message, 'error');
  }
}

function goalProjectName(projectId) {
  const pr = (window._goalProjects || []).find(x => x.id === projectId);
  return pr ? pr.name : projectId;
}

function renderGoalsFiltered() {
  window._goalFilterProject = document.getElementById('goalFilterProject').value;
  renderGoals();
}

function showCreateGoalModal(goalId) {
  const g = goalId ? (window._allGoals || []).find(x => x.id === goalId) : null;
  const modal = document.getElementById('modalContainer');
  modal.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${g ? 'Edit Goal' : 'Create New Goal'}</div>
          <button class="modal-close" onclick="closeModal()" title="Close">${icon('x', 13)}</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Title *</label>
            <input class="form-input" id="goalTitle" placeholder="e.g., Complete CloudMart Phase 2" value="${g ? escapeHtml(g.title) : ''}">
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" id="goalDesc" placeholder="What does this goal involve?" rows="3">${g ? escapeHtml(g.description || '') : ''}</textarea>
          ${g && g.project_id ? `<div class="form-hint">Changing this goal updates the project and queues a recalibration task for the team Lead.</div>` : ''}
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Category</label>
              <select class="form-select" id="goalCategory">
                ${g && !['general','development','study','devops','personal'].includes(g.category) ? `<option value="${escapeHtml(g.category)}" selected>${escapeHtml(g.category)}</option>` : ''}
                <option value="general">General</option>
                <option value="development">Development</option>
                <option value="study">Study</option>
                <option value="devops">DevOps</option>
                <option value="personal">Personal</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Target Date</label>
              <input class="form-input" id="goalDate" type="date" value="${g ? (g.target_date || '') : ''}">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Project <span class="text-muted text-xs">(align this goal to a project)</span></label>
            <select class="form-select" id="goalProject">
              <option value="">— none —</option>
              ${(window._goalProjects || []).map(pr => `<option value="${pr.id}" ${g && g.project_id === pr.id ? 'selected' : ''}>${escapeHtml(pr.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="createGoal('${goalId || ''}')">${g ? 'Save Changes' : 'Create Goal'}</button>
        </div>
      </div>
    </div>
  `;
}

async function createGoal(goalId) {
  const title = document.getElementById('goalTitle').value.trim();
  if (!title) { showToast('Title is required', 'error'); return; }
  const payload = {
    title,
    description: document.getElementById('goalDesc').value.trim(),
    category: document.getElementById('goalCategory').value,
    target_date: document.getElementById('goalDate').value,
    project_id: document.getElementById('goalProject').value,
  };
  try {
    if (goalId) {
      await api.updateGoal(goalId, payload);
      showToast(payload.project_id
        ? 'Goal updated — recalibration queued for the team Lead'
        : 'Goal updated', 'success');
    } else {
      await api.createGoal(payload);
      showToast('Goal created!', 'success');
    }
    closeModal();
    renderGoals();
  } catch (err) {
    showToast('Failed to save goal: ' + err.message, 'error');
  }
}

async function updateGoalProgress(id, progress) {
  try {
    const status = progress >= 100 ? 'completed' : 'active';
    await api.updateGoal(id, { progress, status });
    renderGoals();
  } catch (err) {
    showToast('Failed to update goal: ' + err.message, 'error');
  }
}

async function completeGoal(id) {
  try {
    await api.updateGoal(id, { progress: 100, status: 'completed' });
    showToast('Goal completed!', 'success');
    renderGoals();
  } catch (err) {
    showToast('Failed to complete goal: ' + err.message, 'error');
  }
}

async function deleteGoal(id) {
  if (!confirm('Delete this goal?')) return;
  try {
    await api.deleteGoal(id);
    showToast('Goal deleted', 'info');
    renderGoals();
  } catch (err) {
    showToast('Failed to delete goal: ' + err.message, 'error');
  }
}
