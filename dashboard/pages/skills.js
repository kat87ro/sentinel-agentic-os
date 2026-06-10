async function renderSkills() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Skills Hub</h1>
        <p class="page-subtitle">Browse, run, and monitor skill performance</p>
      </div>
      <div class="btn-group">
        <input id="skillFilter" class="form-input" style="width:200px" placeholder="Filter skills..." oninput="filterSkills()">
        <button class="btn btn-primary" onclick="showNewSkillModal()">+ New Skill</button>
        <button class="btn btn-ghost" onclick="syncSkillsFromClaudeUI()">${icon('download', 13)} Sync from Claude</button>
      </div>
    </div>
    <div class="tabs" id="skillTabs">
      <button class="tab active" data-view="grid" onclick="switchSkillView('grid')">${icon('bar-chart', 13)} Grid</button>
      <button class="tab" data-view="list" onclick="switchSkillView('list')">${icon('clipboard', 13)} List</button>
    </div>
    <div id="skillsContainer"><div class="loading"><div class="loading-spinner"></div></div></div>
    <div id="skillDetail" style="display:none"></div>
  `;

  try {
    const skills = await api.getSkills();
    window._allSkills = skills;
    renderSkillGrid(skills);
  } catch (err) {
    document.getElementById('skillsContainer').innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function renderSkillGrid(skills) {
  const container = document.getElementById('skillsContainer');
  if (!skills || skills.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('zap', 32)}</div><div class="empty-state-title">No skills installed</div></div>`;
    return;
  }
  container.innerHTML = `<div class="grid grid-3" id="skillGrid">${skills.map(s => {
    const lastScore = s.scores && s.scores.length > 0 ? s.scores[s.scores.length - 1] : null;
    const avg = lastScore && lastScore.criteria_scores ? (lastScore.criteria_scores.reduce((a, b) => a + b, 0) / lastScore.criteria_scores.length) : null;
    const icons = [`${icon('zap', 16)}`, `${icon('wrench', 16)}`, `${icon('pencil', 16)}`, `${icon('search', 16)}`, `${icon('refresh', 16)}`, `${icon('target', 16)}`, `${icon('bar-chart', 16)}`, `${icon('wrench', 16)}`, `${icon('zap', 16)}`, `${icon('flask', 16)}`, `${icon('clipboard', 16)}`, `${icon('save', 16)}`, `${icon('dollar', 16)}`, `${icon('refresh', 16)}`, `${icon('palette', 16)}`];
    const iconIdx = s.name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % icons.length;
    const iconHtml = icons[iconIdx];
    const off = s.enabled === false;
    return `<div class="skill-card" data-act="showSkillDetail" data-arg="${escapeHtml(s.name)}" style="${off ? 'opacity:.55' : ''}">
      <div class="skill-card-header">
        <div class="skill-card-icon">${iconHtml}</div>
        <div class="skill-card-name">${escapeHtml(s.name.replace(/-/g, ' '))}</div>
        ${off ? '<span class="badge badge-warning" style="margin-left:auto">off</span>' : ''}
      </div>
      <div class="skill-card-desc">${escapeHtml(s.description ? s.description.slice(0, 120) + (s.description.length > 120 ? '...' : '') : 'No description')}</div>
      <div class="skill-card-footer">
        ${avg !== null ? `<span class="badge badge-success">${(avg * 100).toFixed(0)}%</span>` : '<span class="badge badge-info">New</span>'}
        ${s.has_learnings ? `<span class="badge badge-accent">${icon('book-open', 13)}</span>` : ''}
        ${off ? '' : `<button class="btn btn-sm btn-primary" style="margin-left:auto" data-act="quickRunSkill" data-arg="${escapeHtml(s.name)}">${icon('play', 13)} Run</button>`}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function showNewSkillModal() {
  showModal('New Skill', `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Name (slug) *</label>
        <input class="form-input" id="nsName" placeholder="e.g., release-notes">
        <div class="form-hint">lowercase letters, digits, _ or -</div>
      </div>
      <div class="form-group">
        <label class="form-label">Primary agent</label>
        <select class="form-select" id="nsAgent">
          <option value="auto">Auto-detect</option>
          <option value="opencode">opencode</option>
          <option value="hermes">Hermes</option>
          <option value="gemini">Gemini</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Description *</label>
      <input class="form-input" id="nsDesc" placeholder="One line: what this skill does">
    </div>
    <div class="form-group">
      <label class="form-label">Tags <span class="text-muted text-xs">(comma separated)</span></label>
      <input class="form-input" id="nsTags" placeholder="e.g., docs, release">
    </div>
    <div class="form-group">
      <label class="form-label">SKILL.md body <span class="text-muted text-xs">(optional — a template is scaffolded if empty)</span></label>
      <textarea class="form-textarea" id="nsContent" rows="8" placeholder="## Description&#10;...&#10;&#10;## Process&#10;1. ..."></textarea>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="createSkillUI()">Create Skill</button>
  `);
}

async function createSkillUI() {
  const name = document.getElementById('nsName').value.trim().toLowerCase();
  const description = document.getElementById('nsDesc').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  if (!description) { showToast('Description is required', 'error'); return; }
  try {
    const r = await api.createSkill({
      name,
      description,
      agent: document.getElementById('nsAgent').value,
      tags: document.getElementById('nsTags').value.split(',').map(t => t.trim()).filter(Boolean),
      content: document.getElementById('nsContent').value,
    });
    closeModal();
    showToast(`Skill "${r.name}" created`, 'success');
    renderSkills();
  } catch (err) {
    showToast('Failed to create skill: ' + err.message, 'error');
  }
}

async function syncSkillsFromClaudeUI() {
  showToast('Mirroring skills from ~/.claude/skills...', 'info');
  try {
    const r = await api.mirrorSkills();
    const s = (r.summary && r.summary.skills) || {};
    showToast(`Skills synced — ${s.imported || 0} imported, ${s.refreshed || 0} refreshed, ${s.skipped || 0} skipped`, 'success');
    renderSkills();
  } catch (err) {
    showToast('Sync failed: ' + err.message, 'error');
  }
}

function switchSkillView(view) {
  document.querySelectorAll('#skillTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'list') {
    const skills = window._allSkills || [];
    document.getElementById('skillsContainer').innerHTML = `<div class="table-wrapper"><table><thead><tr><th>Skill</th><th>Score</th><th>Learnings</th><th></th></tr></thead><tbody>${skills.map(s => {
      const lastScore = s.scores && s.scores.length > 0 ? s.scores[s.scores.length - 1] : null;
      const avg = lastScore && lastScore.criteria_scores ? (lastScore.criteria_scores.reduce((a, b) => a + b, 0) / lastScore.criteria_scores.length) : null;
      return `<tr data-act="showSkillDetail" data-arg="${escapeHtml(s.name)}" style="cursor:pointer">
        <td><strong>${escapeHtml(s.name.replace(/-/g, ' '))}</strong></td>
        <td>${avg !== null ? `<span class="badge badge-success">${(avg * 100).toFixed(0)}%</span>` : '<span class="badge badge-info">—</span>'}</td>
        <td>${s.has_learnings ? `<span class="badge badge-accent">${icon('check', 11)}</span>` : '<span class="badge">—</span>'}</td>
        <td><button class="btn btn-sm btn-primary" data-act="quickRunSkill" data-arg="${escapeHtml(s.name)}" title="Run">${icon('play', 13)}</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  } else {
    renderSkillGrid(window._allSkills || []);
  }
}

function filterSkills() {
  const q = document.getElementById('skillFilter').value.toLowerCase();
  const skills = (window._allSkills || []).filter(s => s.name.toLowerCase().includes(q));
  renderSkillGrid(skills);
}

async function showSkillDetail(name) {
  document.getElementById('skillsContainer').style.display = 'none';
  document.getElementById('skillTabs').style.display = 'none';
  document.getElementById('skillFilter').style.display = 'none';
  const detail = document.getElementById('skillDetail');
  detail.style.display = 'block';
  detail.innerHTML = `<div class="loading"><div class="loading-spinner"></div></div>`;

  try {
    const skill = await api.getSkill(name);
    const scores = skill.score_history || [];
    const lastScore = scores.length > 0 ? scores[scores.length - 1] : null;
    const avg = lastScore && lastScore.criteria_scores ? (lastScore.criteria_scores.reduce((a, b) => a + b, 0) / lastScore.criteria_scores.length) : null;

    const off = skill.enabled === false;
    detail.innerHTML = `
      <div style="margin-bottom:16px;display:flex;align-items:center;gap:8px">
        <button class="btn btn-ghost" data-act="backToSkills">← Back to Skills</button>
        ${off ? '<span class="badge badge-warning">deactivated</span>'
              : `<button class="btn btn-primary" data-act="quickRunSkill" data-arg="${escapeHtml(name)}">${icon('play', 13)} Run ${escapeHtml(name.replace(/-/g, ' '))}</button>`}
        <button class="btn btn-ghost" data-act="showEditSkillModal" data-arg="${escapeHtml(name)}">${icon('pencil', 13)} Edit</button>
        <button class="btn btn-ghost" data-act="toggleSkillUI" data-arg="${escapeHtml(name)}">${icon('power', 13)} ${off ? 'Activate' : 'Deactivate'}</button>
        <button class="btn btn-ghost" style="color:var(--crit);margin-left:auto" data-act="deleteSkillUI" data-arg="${escapeHtml(name)}">${icon('trash', 13)} Delete</button>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-header"><span class="card-title">${icon('file-text', 13)} SKILL.md</span></div>
          <pre style="max-height:400px;overflow:auto;font-size:12px">${escapeHtml(skill.skill || 'No SKILL.md')}</pre>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">${icon('book-open', 13)} Learnings</span></div>
          <pre style="max-height:400px;overflow:auto;font-size:12px">${escapeHtml(skill.learnings || 'No learnings yet')}</pre>
        </div>
      </div>
      <div class="grid grid-2 mt-3">
        <div class="card">
          <div class="card-header"><span class="card-title">${icon('bar-chart', 13)} Performance</span></div>
          ${scores.length > 0 ? `
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
              ${scores.slice(-10).map(s => `<span class="badge ${(s.total_score || 0) > 0.7 ? 'badge-success' : 'badge-warning'}">${((s.total_score || 0) * 100).toFixed(0)}%</span>`).join('')}
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${(avg || 0) * 100}%"></div></div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:6px">Average: ${avg !== null ? (avg * 100).toFixed(0) : 'N/A'}% (${scores.length} runs)</div>
          ` : '<div style="color:var(--text-muted);font-size:13px">No evaluation scores yet</div>'}
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">${icon('folder', 13)} Context Files</span></div>
          ${skill.context && skill.context.length > 0
            ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${skill.context.map(f => `<span class="badge badge-info">${escapeHtml(f)}</span>`).join('')}</div>`
            : '<div style="color:var(--text-muted);font-size:13px">No context files</div>'}
          ${skill.eval && skill.eval.criteria ? `<div style="margin-top:12px"><strong style="font-size:12px">Eval Criteria:</strong><div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${skill.eval.criteria.map(c => `<span class="badge badge-accent">${escapeHtml(c)}</span>`).join('')}</div></div>` : ''}
        </div>
      </div>
    `;
  } catch (err) {
    detail.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Error</div><div class="empty-state-desc">${escapeHtml(err.message)}</div><button class="btn btn-primary mt-3" onclick="backToSkills()">Back</button></div>`;
  }
}

function showEditSkillModal(name) {
  api.getSkill(name).then(skill => {
    showModal(`Edit: ${escapeHtml(name.replace(/-/g, ' '))}`, `
      <div class="form-group">
        <label class="form-label">SKILL.md source</label>
        <textarea class="form-textarea mono" id="esContent" rows="18" style="font-size:12px">${escapeHtml(skill.skill || '')}</textarea>
        <div class="form-hint">Frontmatter + body — this is the file agents read when running the skill</div>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-act="saveSkillEdit" data-arg="${escapeHtml(name)}">Save</button>
    `);
  }).catch(err => showToast(err.message, 'error'));
}

async function saveSkillEdit(name) {
  const content = document.getElementById('esContent').value;
  if (!content.trim()) { showToast('SKILL.md cannot be empty', 'error'); return; }
  try {
    await api.updateSkill(name, content);
    closeModal();
    showToast('Skill saved', 'success');
    showSkillDetail(name);
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
  }
}

async function toggleSkillUI(name) {
  try {
    const r = await api.toggleSkill(name);
    showToast(r.enabled ? 'Skill activated' : 'Skill deactivated — it will refuse to run', 'info');
    showSkillDetail(name);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteSkillUI(name) {
  if (!confirm(`Delete skill "${name}"? Its learnings and score history are removed too. Skills mirrored from ~/.claude/skills reappear on the next sync — deactivate those instead.`)) return;
  try {
    await api.deleteSkill(name);
    showToast('Skill deleted', 'info');
    backToSkills();
    renderSkills();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function backToSkills() {
  document.getElementById('skillsContainer').style.display = '';
  document.getElementById('skillTabs').style.display = '';
  document.getElementById('skillFilter').style.display = '';
  document.getElementById('skillDetail').style.display = 'none';
}

async function quickRunSkill(name) {
  const displayName = escapeHtml(name.replace(/-/g, ' '));
  showModal(`Run: ${displayName}`, `
    <div class="form-group">
      <label class="form-label">Input (optional)</label>
      <textarea id="qrsInput" class="form-textarea" rows="3" placeholder="Enter input for ${displayName}..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Agent</label>
      <select id="qrsAgent" class="form-select">
        <option value="auto">Auto-detect</option>
        <option value="opencode">opencode</option>
        <option value="hermes">Hermes</option>
        <option value="gemini">Gemini CLI</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
    </div>
    <div id="skillResult" style="display:none"></div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" data-act="executeSkillRun" data-arg="${escapeHtml(name)}">${icon('play', 13)} Run</button>
  `);
}

async function executeSkillRun(name) {
  const input = document.getElementById('qrsInput').value;
  const agent = document.getElementById('qrsAgent').value;
  const runBtn = document.querySelector('#modalContainer .btn-primary');
  const resultArea = document.getElementById('skillResult');

  if (runBtn) { runBtn.disabled = true; runBtn.textContent = `${icon('loader', 13)} Running...`; }
  if (resultArea) {
    resultArea.style.display = 'block';
    resultArea.innerHTML = '<div class="loading" style="padding:20px"><div class="loading-spinner"></div><span style="margin-left:8px">Executing skill...</span></div>';
  }

  try {
    const r = await api.runSkill(name, input, agent);
    if (resultArea) {
      const outputText = r.output || '(no output)';
      resultArea.innerHTML = `
        <div class="card" style="margin-top:8px">
          <div class="card-header" style="border-color:var(--green-dim)">
            <span class="card-title" style="color:var(--green)">${icon('check', 13)} Completed — ${r.agent} #${r.run_id}</span>
          </div>
          <pre style="max-height:400px;overflow:auto;font-size:12px;white-space:pre-wrap;margin:0;padding:12px;background:var(--bg-code, #1a1a2e);border-radius:0 0 8px 8px">${escapeHtml(outputText)}</pre>
        </div>`;
    }
    if (runBtn) { runBtn.textContent = 'Done'; runBtn.disabled = false; }
  } catch (err) {
    if (resultArea) {
      resultArea.innerHTML = `<div class="empty-state" style="padding:20px"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Error</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
    }
    if (runBtn) { runBtn.textContent = 'Run'; runBtn.disabled = false; }
  }
}
