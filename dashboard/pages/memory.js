// Memory — mirrors the REAL memory layers the runtime injects:
//   Global vault (brain/*.md) · Project vaults (brain/projects/<slug>/) ·
//   Agent learnings (brain/agents/<id>/learnings.md) · Journal (brain/journal/).
// The injection preview shows exactly what execute_profile would put in front
// of an agent for a given task.

let _memoryConfig = null;
let _memoryOverview = null;
let _memoryTab = 'global';
let _memAgents = [];
let _memProjects = [];

async function renderMemory() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Memory</div>
        <div class="page-subtitle">What agents actually remember — global vault, project vaults, self-learned lessons, journal</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" onclick="showVaultConfig()">${icon('wrench', 13)} Vault Settings</button>
        <button class="btn btn-ghost" onclick="renderMemory()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="kanban-toolbar" style="margin-bottom:14px">
      <input class="form-input" id="memorySearch" placeholder="Search the whole vault..." oninput="searchMemoryUI()" style="flex:1;min-width:220px;max-width:360px">
      <span class="badge" id="memInjectBadge"></span>
      <span class="text-muted text-sm" id="vaultPathHint"></span>
    </div>
    <div id="memorySearchResults"></div>
    <details class="card" style="padding:12px 16px;margin-bottom:14px">
      <summary style="cursor:pointer;font-size:12.5px;font-weight:600">${icon('zap', 13)} Injection preview — see exactly what an agent gets</summary>
      <div class="flex gap-2" style="margin-top:10px;flex-wrap:wrap;align-items:flex-end">
        <div class="form-group" style="margin-bottom:0;min-width:170px">
          <label class="form-label">Agent</label>
          <select class="form-select" id="mpAgent"></select>
        </div>
        <div class="form-group" style="margin-bottom:0;min-width:170px">
          <label class="form-label">Memory scope</label>
          <select class="form-select" id="mpProject"><option value="">Global vault</option></select>
        </div>
        <div class="form-group" style="flex:1;margin-bottom:0;min-width:220px">
          <label class="form-label">Sample task</label>
          <input class="form-input" id="mpTask" placeholder="e.g., review the snake game collision logic">
        </div>
        <button class="btn btn-primary" onclick="previewInjection()">${icon('search', 13)} Preview</button>
      </div>
      <div id="mpResult" style="margin-top:10px"></div>
    </details>
    <div class="tabs" id="memTabs">
      <button class="tab" data-tab="global" onclick="switchMemoryTab('global')">${icon('book-open', 13)} Global</button>
      <button class="tab" data-tab="projects" onclick="switchMemoryTab('projects')">${icon('folder', 13)} Projects</button>
      <button class="tab" data-tab="agents" onclick="switchMemoryTab('agents')">${icon('users', 13)} Agent learnings</button>
      <button class="tab" data-tab="journal" onclick="switchMemoryTab('journal')">${icon('pencil', 13)} Journal</button>
      <button class="tab" data-tab="graph" onclick="switchMemoryTab('graph')">${icon('share', 13)} Graph</button>
    </div>
    <div id="memTabContent">${renderSkeleton(3)}</div>
  `;
  try {
    const [cfg, overview, agents, projects] = await Promise.all([
      api.getMemoryConfig().catch(() => null),
      api.getMemoryOverview(),
      api.getCustomAgents().catch(() => ({ agents: [] })),
      api.getProjects().catch(() => ({ projects: [] })),
    ]);
    _memoryConfig = cfg;
    _memoryOverview = overview;
    _memAgents = agents.agents || [];
    _memProjects = projects.projects || [];
    const hint = document.getElementById('vaultPathHint');
    if (hint && cfg) hint.textContent = `${cfg.resolved}${cfg.is_default ? ' (default)' : ''}`;
    const badge = document.getElementById('memInjectBadge');
    if (badge) {
      badge.className = `badge ${overview.inject_enabled ? 'badge-success' : 'badge-warning'}`;
      badge.textContent = overview.inject_enabled ? 'injection ON' : 'injection OFF';
    }
    document.getElementById('mpAgent').innerHTML =
      _memAgents.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('') || '<option value="">no agents</option>';
    document.getElementById('mpProject').innerHTML =
      '<option value="">Global vault</option>' +
      _memProjects.map(p => `<option value="${p.id}">Project: ${escapeHtml(p.name)}</option>`).join('');
    switchMemoryTab(_memoryTab);
  } catch (err) {
    document.getElementById('memTabContent').innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function switchMemoryTab(tab) {
  _memoryTab = tab;
  document.querySelectorAll('#memTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const box = document.getElementById('memTabContent');
  if (!box || !_memoryOverview) return;
  const o = _memoryOverview;
  if (tab === 'global') {
    box.innerHTML = o.global_files.length === 0
      ? `<div class="empty-state"><div class="empty-state-icon">${icon('cpu', 32)}</div><div class="empty-state-title">No global notes</div></div>`
      : `<div class="grid grid-3">${o.global_files.map(f => memNoteCard(f, f)).join('')}</div>`;
  } else if (tab === 'projects') {
    box.innerHTML = o.projects.length === 0
      ? `<div class="empty-state"><div class="empty-state-icon">${icon('folder', 32)}</div><div class="empty-state-title">No project vaults yet</div><div class="empty-state-desc">Created automatically when you create a project — agents in project chats see ONLY that vault</div></div>`
      : o.projects.map(p => `
        <div class="card" style="margin-bottom:10px">
          <div class="flex items-center gap-2" style="margin-bottom:8px">
            <strong style="font-size:13px">${escapeHtml(p.name)}</strong>
            <span class="mono text-xs" style="color:var(--text-faint)">projects/${escapeHtml(p.slug)}/</span>
            ${p.linked ? '' : '<span class="badge badge-warning" title="No project in the registry uses this folder">orphaned</span>'}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${p.files.length ? p.files.map(f => `<button class="btn btn-sm btn-ghost" data-act="openVaultFile" data-arg="projects/${escapeHtml(p.slug)}/${escapeHtml(f)}">${icon('file-text', 12)} ${escapeHtml(f)}</button>`).join('') : '<span class="text-muted text-xs">empty</span>'}
          </div>
        </div>`).join('');
  } else if (tab === 'agents') {
    box.innerHTML = o.agents.length === 0
      ? `<div class="empty-state"><div class="empty-state-icon">${icon('users', 32)}</div><div class="empty-state-title">No agents</div></div>`
      : `<div class="grid grid-3">${o.agents.map(a => `
        <div class="card" style="cursor:pointer" data-act="openVaultFile" data-arg="agents/${escapeHtml(a.id)}/learnings.md">
          <div class="flex items-center justify-between" style="margin-bottom:6px">
            <span class="card-title" style="margin:0">${escapeHtml(a.name)}</span>
            <span class="badge ${a.lesson_count > 0 ? 'badge-accent' : 'badge-neutral'}">${a.lesson_count} lesson${a.lesson_count === 1 ? '' : 's'}</span>
          </div>
          <div class="text-muted text-xs">agents/${escapeHtml(a.id)}/learnings.md — written by the self-learning loop, injected into prompts</div>
        </div>`).join('')}</div>`;
  } else if (tab === 'journal') {
    box.innerHTML = o.journal.length === 0
      ? `<div class="empty-state"><div class="empty-state-icon">${icon('pencil', 32)}</div><div class="empty-state-title">No journal entries</div></div>`
      : `<div class="grid grid-3">${o.journal.map(d => `
        <div class="card" style="cursor:pointer" data-act="openVaultFile" data-arg="journal/${escapeHtml(d)}.md">
          <span class="card-title" style="margin:0">${escapeHtml(d)}</span>
        </div>`).join('')}</div>`;
  } else if (tab === 'graph') {
    box.innerHTML = renderSkeleton(2);
    api.getMemoryGraph().then(renderMemoryGraph).catch(err => {
      box.innerHTML = `<div class="text-muted text-sm">${escapeHtml(err.message)}</div>`;
    });
  }
}

function memNoteCard(label, file) {
  const stem = file.replace(/\.md$/, '');
  return `<div class="card" style="cursor:pointer" data-act="openNote" data-arg="${escapeHtml(stem)}">
    <span class="card-title" style="margin:0">${escapeHtml(stem.replace(/-/g, ' '))}</span>
    <div class="text-muted text-xs" style="margin-top:4px">${escapeHtml(file)}</div>
  </div>`;
}

async function previewInjection() {
  const agentId = document.getElementById('mpAgent').value;
  if (!agentId) { showToast('No agent selected', 'warning'); return; }
  const out = document.getElementById('mpResult');
  out.innerHTML = `<div class="loading" style="padding:8px"><div class="loading-spinner"></div></div>`;
  try {
    const r = await api.getMemoryPreview(agentId,
      document.getElementById('mpTask').value.trim(),
      document.getElementById('mpProject').value || null);
    out.innerHTML = `
      <div class="text-xs" style="margin-bottom:6px">
        <span class="badge badge-info">scope: ${r.scope}</span>
        <span class="badge ${r.inject_enabled ? 'badge-success' : 'badge-warning'}">vault injection ${r.inject_enabled ? 'on' : 'off'}</span>
      </div>
      <div class="grid grid-2">
        <div>
          <div class="form-label">Vault context (# Relevant memory)</div>
          <pre style="max-height:220px;overflow:auto;font-size:11.5px;white-space:pre-wrap">${escapeHtml(r.memory_context || '(nothing matched — no notes share words with this task)')}</pre>
        </div>
        <div>
          <div class="form-label">Self-learned lessons</div>
          <pre style="max-height:220px;overflow:auto;font-size:11.5px;white-space:pre-wrap">${escapeHtml(r.lessons || '(no lessons yet)')}</pre>
        </div>
      </div>`;
  } catch (err) {
    out.innerHTML = `<div style="color:var(--crit);font-size:12.5px">${escapeHtml(err.message)}</div>`;
  }
}

// ─── Vault file viewer/editor by relative path (project/journal/agent notes) ──

async function openVaultFile(path) {
  try {
    const r = await api.getMemoryFile(path);
    const bodyHtml = linkifyWikilinks(escapeHtml(r.content || ''));
    showModal(escapeHtml(path), `
      <div class="card" style="max-height:340px;overflow:auto;white-space:pre-wrap;font-size:13px">${bodyHtml || '<span class="text-muted">(empty)</span>'}</div>
    `, `
      <button class="btn btn-ghost" onclick="closeModal()">Close</button>
      <button class="btn btn-primary" data-act="editVaultFile" data-arg="${escapeHtml(path)}">${icon('pencil', 13)} Edit</button>
    `);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function editVaultFile(path) {
  let content = '';
  try { content = (await api.getMemoryFile(path)).content || ''; } catch {}
  showModal(`Edit: ${escapeHtml(path)}`, `
    <div class="form-group">
      <label class="form-label">Content (markdown — supports #tags and [[wikilinks]])</label>
      <textarea id="memContent" class="form-textarea" style="min-height:320px;font-size:12px">${escapeHtml(content)}</textarea>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" data-act="saveVaultFile" data-arg="${escapeHtml(path)}">${icon('save', 13)} Save</button>
  `);
}

async function saveVaultFile(path) {
  try {
    await api.updateMemoryFile(path, document.getElementById('memContent').value);
    closeModal();
    showToast('Saved', 'success');
    renderMemory();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ─── Graph / search / note modal / config (vault-wide) ───────────

function renderMemoryGraph(graph) {
  const el = document.getElementById('memTabContent');
  if (!el) return;
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  if (nodes.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('share', 32)}</div><div class="empty-state-title">Empty vault</div></div>`;
    return;
  }
  const outgoing = {};
  edges.forEach(e => { (outgoing[e.from] = outgoing[e.from] || []).push(e.to); });
  el.innerHTML = `
    <div class="card">
      <div class="flex gap-3" style="margin-bottom:12px">
        <div class="metric-tile" style="flex:1"><div class="metric-tile-value">${nodes.length}</div><div class="metric-tile-label">Notes</div></div>
        <div class="metric-tile" style="flex:1"><div class="metric-tile-value">${edges.length}</div><div class="metric-tile-label">Links</div></div>
      </div>
      <div class="org-tree">
        ${nodes.map(n => {
          const outs = outgoing[n.name] || [];
          const back = (graph.backlinks && graph.backlinks[n.name]) || [];
          return `<div class="org-node" style="display:block;padding:6px 0">
            <span class="org-node-name" style="cursor:pointer" data-act="openNote" data-arg="${escapeHtml(n.name)}">${escapeHtml(n.name)}</span>
            ${(n.tags || []).map(t => `<span class="skill-chip">#${escapeHtml(t)}</span>`).join('')}
            ${outs.length ? `<div class="text-muted text-xs" style="margin-left:14px">→ ${outs.map(o => wikiChip(o)).join(' ')}</div>` : ''}
            ${back.length ? `<div class="text-muted text-xs" style="margin-left:14px">← ${back.map(o => wikiChip(o)).join(' ')}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

function wikiChip(name) {
  return `<span class="wikilink" data-act="openNote" data-arg="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
}

// Turn [[target]] / [[target|alias]] into clickable links.
// INVARIANT: the input MUST already be escapeHtml'd (callers pass
// linkifyWikilinks(escapeHtml(body))). Because of that, `target`/`label` are
// escaped fragments — `target` is safe in the double-quoted data-arg attribute
// (a `&quot;`/`&lt;` entity is a value char, never the delimiter, and round-
// trips back to the raw note name via dataset for openNote), and `label` is
// safe in the body text position. Do NOT call this on raw, un-escaped text.
function linkifyWikilinks(escapedText) {
  return escapedText.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
    const target = inner.split('|')[0].split('#')[0].trim();
    const label = inner.includes('|') ? inner.split('|')[1].trim() : inner.trim();
    return `<span class="wikilink" data-act="openNote" data-arg="${target}">${label}</span>`;
  });
}

let _searchTimer = null;
function searchMemoryUI() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(async () => {
    const q = document.getElementById('memorySearch').value.trim();
    const out = document.getElementById('memorySearchResults');
    if (!out) return;
    if (!q) { out.innerHTML = ''; return; }
    try {
      const data = await api.searchMemory(q);
      const results = data.results || [];
      out.innerHTML = `<div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin-bottom:8px">${icon('search', 15)} ${results.length} result(s) for "${escapeHtml(q)}"</div>
        ${results.length === 0 ? '<div class="text-muted text-sm">No matches</div>' :
          results.map(r => `<div class="flex items-center gap-3" style="padding:6px 0;border-top:1px solid var(--border)">
            <span class="wikilink" data-act="openNote" data-arg="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
            <span class="badge badge-accent">score ${r.score}</span>
            <span class="text-muted text-xs" style="flex:1">${escapeHtml(r.preview)}</span>
          </div>`).join('')}
      </div>`;
    } catch (err) {
      out.innerHTML = `<div class="text-muted text-sm" style="color:var(--red)">${escapeHtml(err.message)}</div>`;
    }
  }, 250);
}

async function openNote(name) {
  try {
    const note = await api.getMemoryNote(name);
    const tags = (note.tags || []).map(t => `<span class="skill-chip">#${escapeHtml(t)}</span>`).join('');
    const links = (note.links || []).map(wikiChip).join(' ') || '<span class="text-muted text-xs">none</span>';
    const backlinks = (note.backlinks || []).map(wikiChip).join(' ') || '<span class="text-muted text-xs">none</span>';
    const bodyHtml = linkifyWikilinks(escapeHtml(note.body || ''));
    showModal(escapeHtml(name.replace(/-/g, ' ')), `
      ${note.path ? `<div class="mono text-xs" style="color:var(--text-faint);margin-bottom:8px">${escapeHtml(note.path)}</div>` : ''}
      ${tags ? `<div style="margin-bottom:10px">${tags}</div>` : ''}
      <div class="card" style="max-height:320px;overflow:auto;white-space:pre-wrap;font-size:13px">${bodyHtml || '<span class="text-muted">(empty)</span>'}</div>
      <div class="form-group" style="margin-top:12px">
        <label class="form-label">Links →</label><div>${links}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Backlinks ←</label><div>${backlinks}</div>
      </div>
    `, `
      <button class="btn btn-ghost" onclick="closeModal()">Close</button>
      <button class="btn btn-primary" data-act="editVaultFile" data-arg="${escapeHtml(note.path || name + '.md')}">${icon('pencil', 13)} Edit</button>
    `);
  } catch (err) {
    showToast('Failed to open note: ' + err.message, 'error');
  }
}

function showVaultConfig() {
  const cfg = _memoryConfig || { vault_path: '', resolved: '', inject_context: true, is_default: true };
  showModal('Vault Settings', `
    <div class="form-group">
      <label class="form-label">Vault path</label>
      <input class="form-input" id="vaultPath" placeholder="leave empty for default (brain/)" value="${escapeHtml(cfg.vault_path || '')}">
      <div class="text-muted text-xs" style="margin-top:4px">Point at an external Obsidian vault folder, or leave blank to use the built-in <code>brain/</code>. Currently: ${escapeHtml(cfg.resolved || '')}</div>
    </div>
    <div class="form-group">
      <label class="check-chip"><input type="checkbox" id="vaultInject" ${cfg.inject_context ? 'checked' : ''}> Inject relevant memory into agent prompts</label>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveVaultConfig()">Save</button>
  `);
}

async function saveVaultConfig() {
  const payload = {
    vault_path: document.getElementById('vaultPath').value.trim(),
    inject_context: document.getElementById('vaultInject').checked,
  };
  try {
    await api.setMemoryConfig(payload);
    showToast('Vault settings saved', 'success');
    closeModal();
    renderMemory();
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
  }
}
