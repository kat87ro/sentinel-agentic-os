// Learning Analytics — the self-learning loop made visible.
// After every settled task a reflection step distills ≤3 lessons into the
// agent's learnings file (brain/agents/<id>/learnings.md), which is injected
// into its future prompts. This page shows what each agent has learned plus
// the legacy skill evaluation scores.

async function renderLearningAnalytics() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Learning Analytics</div>
        <div class="page-subtitle">What your agents learned from their own tasks — and how it feeds back into their prompts</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" id="learningToggleBtn" onclick="toggleLearningUI()">${icon('power', 13)} …</button>
        <button class="btn btn-ghost" onclick="renderLearningAnalytics()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="section-title">Agent self-learning</div>
    <div id="agentLearningGrid" class="grid grid-2" style="margin-bottom:20px">
      <div class="skeleton" style="height:140px"></div>
      <div class="skeleton" style="height:140px"></div>
    </div>
    <div class="section-title">Skill evaluation scores</div>
    <div id="skillScoresGrid" class="grid grid-3"></div>
  `;
  loadAgentLearning();
  loadSkillScores();
}

async function loadAgentLearning() {
  try {
    const data = await api.getLearningAgents();
    const btn = document.getElementById('learningToggleBtn');
    if (btn) btn.innerHTML = `${icon('power', 13)} Self-learning: ${data.enabled ? 'ON' : 'OFF'}`;
    const grid = document.getElementById('agentLearningGrid');
    if (!grid) return;
    const agents = data.agents || [];
    if (agents.length === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('users', 32)}</div><div class="empty-state-title">No agents</div></div>`;
      return;
    }
    grid.innerHTML = agents.map(a => {
      const terminal = a.tasks_done + a.tasks_failed;
      const rate = terminal ? Math.round(100 * a.tasks_done / terminal) : null;
      return `
      <div class="card">
        <div class="flex items-center gap-2" style="margin-bottom:8px">
          <strong style="font-size:13px">${escapeHtml(a.name)}</strong>
          <span class="mono text-xs" style="color:var(--text-faint)">${escapeHtml(a.provider)}</span>
          <span style="margin-left:auto;display:flex;gap:4px">
            ${(a.recent_outcomes || []).map(s => `<span title="${s}" style="width:8px;height:8px;border-radius:2px;display:inline-block;background:${s === 'done' ? 'var(--ok)' : 'var(--crit)'}"></span>`).join('')}
          </span>
        </div>
        <div class="text-xs" style="margin-bottom:10px">
          <span class="badge badge-accent">${a.lesson_count} lesson${a.lesson_count === 1 ? '' : 's'}</span>
          <span class="badge badge-neutral">${a.reflection_count} reflections</span>
          ${rate != null ? `<span class="badge ${rate >= 80 ? 'badge-success' : rate >= 50 ? 'badge-warning' : 'badge-danger'}">${rate}% success (${terminal})</span>` : '<span class="badge badge-neutral">no finished tasks</span>'}
        </div>
        ${a.learnings
          ? `<details ${a.lesson_count <= 6 ? 'open' : ''}>
               <summary class="text-muted text-xs" style="cursor:pointer">learnings.md — injected into this agent's prompts</summary>
               <pre style="max-height:220px;overflow:auto;font-size:11.5px;white-space:pre-wrap;margin-top:6px">${escapeHtml(a.learnings)}</pre>
             </details>`
          : `<div class="text-muted text-xs">No lessons yet — they appear after the agent finishes tasks${data.enabled ? '' : ' (self-learning is OFF)'}</div>`}
      </div>`;
    }).join('');
  } catch (err) {
    const grid = document.getElementById('agentLearningGrid');
    if (grid) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

async function toggleLearningUI() {
  try {
    const r = await api.toggleLearning();
    showToast(r.enabled
      ? 'Self-learning ON — agents reflect after every finished task (one small metered LLM call each)'
      : 'Self-learning OFF — existing lessons stay and keep being injected', 'info');
    loadAgentLearning();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadSkillScores() {
  try {
    const skillData = await api.getSkillAnalytics();
    const skills = skillData.skills || [];
    const grid = document.getElementById('skillScoresGrid');
    if (!grid) return;
    if (skills.length === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('bar-chart', 32)}</div><div class="empty-state-title">No skill evaluations yet</div><div class="empty-state-desc">Scores appear when skills carry eval.json / score-history.json</div></div>`;
      return;
    }
    grid.innerHTML = skills.map(s => `
      <div class="card">
        <div class="flex items-center justify-between" style="margin-bottom:6px">
          <strong style="font-size:12.5px">${escapeHtml(s.name.replace(/-/g, ' '))}</strong>
          <span class="badge ${s.avg_score >= 0.7 ? 'badge-success' : 'badge-warning'}">${Math.round((s.avg_score || 0) * 100)}%</span>
        </div>
        <div class="text-muted text-xs">${s.total_runs} evaluation${s.total_runs === 1 ? '' : 's'} · last ${Math.round((s.last_score || 0) * 100)}%</div>
      </div>`).join('');
  } catch {}
}
