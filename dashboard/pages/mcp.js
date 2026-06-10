// MCP Servers — manage Model Context Protocol servers + mirror from Claude global

let _mcpCache = [];

async function renderMcp() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">MCP Servers</div>
        <div class="page-subtitle">Manage MCP servers and attach them to agents — passed to MCP-capable CLIs</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showMcpModal()">+ New Server</button>
        <button class="btn btn-ghost" onclick="mirrorMcpUI()">${icon('download', 13)} Mirror from Claude</button>
        <button class="btn btn-ghost" onclick="renderMcp()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="grid grid-2" id="mcpList">${renderSkeleton(2)}</div>
  `;
  try {
    const data = await api.getMcpServers();
    _mcpCache = data.servers || [];
    const list = document.getElementById('mcpList');
    if (!list) return;
    if (_mcpCache.length === 0) {
      list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('puzzle', 32)}</div><div class="empty-state-title">No MCP servers</div><div class="empty-state-desc">Add one, or mirror from your Claude config</div></div>`;
      return;
    }
    list.innerHTML = _mcpCache.map(s => `
      <div class="card">
        <div class="flex items-center justify-between" style="margin-bottom:8px">
          <div class="card-title" style="margin:0">${escapeHtml(s.name)}</div>
          <div style="display:flex;gap:6px">
            <span class="badge badge-info">${escapeHtml(s.transport)}</span>
            <span class="badge ${s.enabled ? 'badge-success' : 'badge-warning'}">${s.enabled ? 'enabled' : 'disabled'}</span>
            ${s.source === 'claude-global' ? '<span class="provider-badge provider-claude">claude-global</span>' : ''}
          </div>
        </div>
        <div class="text-muted text-xs" style="margin-bottom:8px;word-break:break-all">
          ${s.transport === 'stdio'
            ? `<code>${escapeHtml(s.command)} ${escapeHtml((s.args || []).join(' '))}</code>`
            : `<code>${escapeHtml(s.url || '')}</code>`}
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px;padding-top:10px;border-top:1px solid var(--border)">
          <button class="btn btn-sm btn-ghost" onclick="toggleMcp('${s.id}')">${s.enabled ? `${icon('pause', 13)} Disable` : `${icon('play', 13)} Enable`}</button>
          <button class="btn btn-sm btn-ghost" onclick="showMcpModal('${s.id}')">${icon('pencil', 13)} Edit</button>
          <button class="btn btn-sm btn-ghost" onclick="deleteMcp('${s.id}')" style="margin-left:auto;color:var(--red)">${icon('trash', 13)}</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    const list = document.getElementById('mcpList');
    if (list) list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Failed to load</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

function showMcpModal(id) {
  const s = id ? _mcpCache.find(x => x.id === id) : null;
  const tr = s ? s.transport : 'stdio';
  showModal(id ? 'Edit MCP Server' : 'New MCP Server', `
    <div class="form-group">
      <label class="form-label">Name *</label>
      <input class="form-input" id="mcpName" value="${s ? escapeHtml(s.name) : ''}" placeholder="e.g., filesystem">
    </div>
    <div class="form-group">
      <label class="form-label">Transport</label>
      <select class="form-select" id="mcpTransport" onchange="onMcpTransportChange()">
        <option value="stdio" ${tr === 'stdio' ? 'selected' : ''}>stdio (local command)</option>
        <option value="http" ${tr === 'http' ? 'selected' : ''}>http</option>
        <option value="sse" ${tr === 'sse' ? 'selected' : ''}>sse</option>
      </select>
    </div>
    <div id="mcpStdioFields">
      <div class="form-group"><label class="form-label">Command</label>
        <input class="form-input" id="mcpCommand" value="${s ? escapeHtml(s.command || '') : ''}" placeholder="npx"></div>
      <div class="form-group"><label class="form-label">Args (space-separated)</label>
        <input class="form-input" id="mcpArgs" value="${s ? escapeHtml((s.args || []).join(' ')) : ''}" placeholder="-y @modelcontextprotocol/server-filesystem"></div>
    </div>
    <div id="mcpHttpFields">
      <div class="form-group"><label class="form-label">URL</label>
        <input class="form-input" id="mcpUrl" value="${s ? escapeHtml(s.url || '') : ''}" placeholder="https://..."></div>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveMcp('${id || ''}')">${id ? 'Save' : 'Create'}</button>
  `);
  onMcpTransportChange();
}

function onMcpTransportChange() {
  const tr = document.getElementById('mcpTransport').value;
  document.getElementById('mcpStdioFields').style.display = tr === 'stdio' ? 'block' : 'none';
  document.getElementById('mcpHttpFields').style.display = tr === 'stdio' ? 'none' : 'block';
}

async function saveMcp(id) {
  const name = document.getElementById('mcpName').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  const transport = document.getElementById('mcpTransport').value;
  const payload = {
    name, transport,
    command: document.getElementById('mcpCommand').value.trim(),
    args: document.getElementById('mcpArgs').value.trim().split(/\s+/).filter(Boolean),
    url: document.getElementById('mcpUrl').value.trim(),
  };
  try {
    if (id) await api.updateMcpServer(id, payload);
    else await api.createMcpServer(payload);
    showToast('Saved', 'success');
    closeModal();
    renderMcp();
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function toggleMcp(id) {
  try { await api.toggleMcpServer(id); renderMcp(); }
  catch (err) { showToast('Failed: ' + err.message, 'error'); }
}

async function deleteMcp(id) {
  if (!confirm('Delete this MCP server?')) return;
  try { await api.deleteMcpServer(id); showToast('Deleted', 'info'); renderMcp(); }
  catch (err) { showToast('Failed: ' + err.message, 'error'); }
}

async function mirrorMcpUI() {
  showToast('Mirroring MCP servers from Claude...', 'info');
  try {
    const r = await api.mirrorMcp();
    const m = r.summary.mcp || {};
    showToast(`MCP mirror: ${m.imported || 0} imported, ${m.refreshed || 0} refreshed`, 'success');
    renderMcp();
  } catch (err) {
    showToast('Mirror failed: ' + err.message, 'error');
  }
}
