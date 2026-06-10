// Plugins — capability packs. A plugin bundles real components (an MCP server,
// skills, prompts) and wiring it in registers those into the systems agents
// already use. Config-before-enable: required fields must be set to enable.

let _pluginCatalog = [];

async function renderPlugins() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Plugins</h1>
        <p class="page-subtitle">Capability packs — wire MCP servers, skills & prompts into your agents</p>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showUploadPlugin()">${icon('download', 13)} Upload bundle (.zip)</button>
        <button class="btn btn-ghost" onclick="renderPlugins()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="sec-hd"><h2>Installed</h2><span class="sub" id="pluginInstalledSub"></span><span class="line"></span></div>
    <div id="pluginList"><div class="skeleton" style="height:80px"></div></div>
    <div class="sec-hd" style="margin-top:22px"><h2>Marketplace</h2><span class="line"></span></div>
    <div id="pluginCatalog" class="grid grid-2"><div class="skeleton" style="height:120px"></div></div>
  `;
  try {
    const [installed, catalog] = await Promise.all([api.getPlugins(), api.getPluginCatalog()]);
    _pluginCatalog = catalog.catalog || [];
    renderInstalledPlugins(installed.plugins || []);
    renderPluginCatalog(_pluginCatalog);
  } catch (err) {
    document.getElementById('pluginList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function pluginComponentSummary(p) {
  const c = p.components || {};
  const bits = [];
  if (c.mcp) bits.push(`${icon('puzzle', 11)} MCP: ${escapeHtml(c.mcp.name)}`);
  if ((c.skills || []).length) bits.push(`${icon('zap', 11)} ${c.skills.length} skill${c.skills.length > 1 ? 's' : ''}`);
  if ((c.prompts || []).length) bits.push(`${icon('file-text', 11)} ${c.prompts.length} prompt${c.prompts.length > 1 ? 's' : ''}`);
  return bits.join(' · ') || 'no components';
}

function renderInstalledPlugins(list) {
  const sub = document.getElementById('pluginInstalledSub');
  if (sub) sub.textContent = `${list.length} installed`;
  const box = document.getElementById('pluginList');
  if (!box) return;
  if (list.length === 0) {
    box.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('plug', 32)}</div><div class="empty-state-title">No plugins installed</div><div class="empty-state-desc">Install one from the marketplace below</div></div>`;
    return;
  }
  box.innerHTML = `<div class="grid grid-2">${list.map(p => {
    const needsConfig = (p.config_schema || []).some(f => f.required && !String((p.config || {})[f.key] || '').trim());
    return `
    <div class="card" style="${!p.enabled ? 'opacity:.7' : ''}">
      <div class="flex items-center gap-2" style="margin-bottom:6px">
        <div class="agent-avatar" style="background:var(--accent-glow);color:var(--accent)">${icon('plug', 14)}</div>
        <div style="flex:1;min-width:0">
          <div class="card-title" style="margin:0">${escapeHtml(p.name)}</div>
          <div class="mono text-xs" style="color:var(--text-faint)">v${escapeHtml(p.version)} · ${escapeHtml(p.source || 'manual')}</div>
        </div>
        <span class="badge ${p.enabled ? 'badge-success' : needsConfig ? 'badge-warning' : 'badge-neutral'}">${p.enabled ? 'active' : needsConfig ? 'needs config' : 'disabled'}</span>
      </div>
      <div class="text-muted text-xs" style="margin-bottom:8px">${escapeHtml(p.description || '')}</div>
      <div class="text-xs" style="margin-bottom:10px">${pluginComponentSummary(p)}</div>
      <div style="display:flex;gap:6px;border-top:1px solid var(--border);padding-top:10px">
        ${(p.config_schema || []).length ? `<button class="btn btn-sm btn-ghost" onclick="showPluginConfig('${p.id}')">${icon('wrench', 12)} Configure</button>` : ''}
        <button class="btn btn-sm ${p.enabled ? 'btn-ghost' : 'btn-primary'}" onclick="togglePluginUI('${p.id}')" ${needsConfig && !p.enabled ? 'disabled title="configure required fields first"' : ''}>${p.enabled ? `${icon('pause', 12)} Disable` : `${icon('power', 12)} Enable`}</button>
        <button class="btn btn-sm btn-ghost" style="color:var(--crit);margin-left:auto" data-act="uninstallPluginUI" data-arg="${escapeHtml(p.id)}" data-arg2="${escapeHtml(p.name)}">${icon('trash', 12)}</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderPluginCatalog(catalog) {
  const box = document.getElementById('pluginCatalog');
  if (!box) return;
  if (catalog.length === 0) {
    box.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('check-circle', 28)}</div><div class="empty-state-title" style="font-size:13px">Everything available is installed</div></div>`;
    return;
  }
  box.innerHTML = catalog.map((m, i) => `
    <div class="card">
      <div class="flex items-center gap-2" style="margin-bottom:6px">
        <div class="agent-avatar" style="background:var(--purple-dim,var(--accent-glow));color:var(--purple,var(--accent))">${icon('puzzle', 14)}</div>
        <div style="flex:1;min-width:0">
          <div class="card-title" style="margin:0">${escapeHtml(m.name)}</div>
          <div class="mono text-xs" style="color:var(--text-faint)">v${escapeHtml(m.version)} · ${escapeHtml(m.category || 'plugin')}</div>
        </div>
      </div>
      <div class="text-muted text-xs" style="margin-bottom:8px">${escapeHtml(m.description || '')}</div>
      <div class="text-xs" style="margin-bottom:10px">${pluginComponentSummary(m)}</div>
      <button class="btn btn-sm btn-primary" onclick="showInstallPlugin(${i})">${icon('download', 12)} Install</button>
    </div>`).join('');
}

function pluginConfigFields(schema, current) {
  current = current || {};
  if (!schema || schema.length === 0) return '<div class="text-muted text-sm">No configuration required.</div>';
  return schema.map(f => {
    const val = escapeHtml(String(current[f.key] != null ? current[f.key] : (f.default || '')));
    const isPath = f.type === 'path';
    const inputType = f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text';
    return `
      <div class="form-group">
        <label class="form-label">${escapeHtml(f.label || f.key)}${f.required ? ' *' : ''}</label>
        <div style="display:flex;gap:6px">
          <input class="form-input" style="flex:1" id="pcfg_${f.key}" type="${inputType}" value="${val}" placeholder="${escapeHtml(f.help || '')}">
          ${isPath ? `<button class="btn btn-ghost" type="button" onclick="pluginPickPath('pcfg_${f.key}')">${icon('folder', 12)}</button>` : ''}
        </div>
        ${f.help ? `<div class="form-hint">${escapeHtml(f.help)}</div>` : ''}
      </div>`;
  }).join('');
}

function showInstallPlugin(catalogIdx) {
  const m = _pluginCatalog[catalogIdx];
  if (!m) return;
  const perms = (m.permissions || []);
  showModal(`Install: ${escapeHtml(m.name)}`, `
    <div class="text-muted text-sm" style="margin-bottom:10px">${escapeHtml(m.description || '')}</div>
    <div class="card" style="background:var(--bg-2);margin-bottom:12px">
      <div class="text-xs" style="font-weight:600;margin-bottom:6px">${icon('shield', 12)} This plugin will be able to:</div>
      ${perms.length ? perms.map(p => `<div class="text-muted text-xs">• ${escapeHtml(p)}</div>`).join('') : '<div class="text-muted text-xs">No special permissions.</div>'}
      <div class="text-xs" style="font-weight:600;margin:10px 0 6px">It wires in:</div>
      <div class="text-muted text-xs">${pluginComponentSummary(m)}</div>
    </div>
    <div id="pluginConfigFields">${pluginConfigFields(m.config_schema, {})}</div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="installPluginUI('${m.id}')">Install${(m.config_schema || []).some(f => f.required) ? ' & Enable' : ''}</button>
  `);
}

function collectPluginConfig(schema) {
  const cfg = {};
  (schema || []).forEach(f => {
    const el = document.getElementById(`pcfg_${f.key}`);
    if (el && el.value.trim()) cfg[f.key] = el.value.trim();
  });
  return cfg;
}

async function installPluginUI(id) {
  const m = _pluginCatalog.find(x => x.id === id);
  try {
    const r = await api.installPlugin({ id, config: collectPluginConfig(m && m.config_schema) });
    closeModal();
    showToast(r.enabled ? `${m.name} installed & enabled` : `${m.name} installed — configure required fields to enable`, r.enabled ? 'success' : 'info');
    renderPlugins();
  } catch (err) {
    showToast('Install failed: ' + err.message, 'error');
  }
}

async function showPluginConfig(id) {
  try {
    const data = await api.getPlugins();
    const p = (data.plugins || []).find(x => x.id === id);
    if (!p) return;
    showModal(`Configure: ${escapeHtml(p.name)}`, `
      <div id="pluginConfigFields">${pluginConfigFields(p.config_schema, p.config)}</div>
    `, `
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="savePluginConfig('${id}')">Save</button>
    `);
  } catch (err) { showToast(err.message, 'error'); }
}

async function savePluginConfig(id) {
  const data = await api.getPlugins();
  const p = (data.plugins || []).find(x => x.id === id);
  try {
    await api.configurePlugin(id, collectPluginConfig(p && p.config_schema));
    closeModal();
    showToast('Configuration saved', 'success');
    renderPlugins();
  } catch (err) { showToast('Failed: ' + err.message, 'error'); }
}

async function togglePluginUI(id) {
  try {
    const r = await api.togglePlugin(id);
    showToast(r.enabled ? 'Plugin enabled — components wired in' : 'Plugin disabled', 'info');
    renderPlugins();
  } catch (err) { showToast(err.message, 'error'); }
}

async function uninstallPluginUI(id, name) {
  if (!confirm(`Uninstall "${name}"? Its MCP server, skills and prompts are removed (hand-made items are untouched).`)) return;
  try {
    await api.uninstallPlugin(id);
    showToast('Plugin uninstalled', 'info');
    renderPlugins();
  } catch (err) { showToast(err.message, 'error'); }
}

async function pluginPickPath(inputId) {
  try {
    const r = await api.pickFolder();
    if (r.status === 'ok' && r.path) document.getElementById(inputId).value = r.path;
  } catch (err) { showToast(err.message, 'error'); }
}

// ─── upload a plugin bundle (.zip) ────────────────────────────────

function showUploadPlugin() {
  showModal('Upload plugin bundle', `
    <div class="text-muted text-sm" style="margin-bottom:12px">
      A bundle is a <code>.zip</code> with a manifest at its root and (optionally) the component files:
    </div>
    <pre style="font-size:11.5px;background:var(--bg-2);padding:10px;border-radius:8px;margin-bottom:12px">plugin.json            ← the manifest (required)
skills/&lt;slug&gt;/SKILL.md   ← optional bundled skill(s) + context files
prompts/&lt;slug&gt;.md        ← optional bundled prompt(s)</pre>
    <details style="margin-bottom:12px">
      <summary class="text-muted text-xs" style="cursor:pointer">Example plugin.json</summary>
      <pre style="font-size:11px;background:var(--bg-2);padding:10px;border-radius:8px;margin-top:6px">{
  "id": "my-pack",
  "name": "My Pack",
  "version": "1.0.0",
  "permissions": ["Reads files under the configured folder"],
  "config_schema": [{ "key": "root", "label": "Folder", "type": "path", "required": true }],
  "components": {
    "mcp": { "name": "fs", "transport": "stdio", "command": "npx",
             "args": ["-y", "@modelcontextprotocol/server-filesystem", "{{config.root}}"] },
    "skills": [{ "slug": "my-skill" }],
    "prompts": [{ "slug": "my-prompt" }]
  }
}</pre>
    </details>
    <div class="form-group">
      <label class="form-label">Bundle file</label>
      <input class="form-input" type="file" id="pluginZip" accept=".zip">
    </div>
    <div class="form-hint">If the plugin needs config, it installs disabled — fill the fields then Enable it.</div>
    <div id="pluginUploadResult"></div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" id="pluginUploadBtn" onclick="uploadPluginUI()">Upload & install</button>
  `);
}

async function uploadPluginUI() {
  const input = document.getElementById('pluginZip');
  const out = document.getElementById('pluginUploadResult');
  const btn = document.getElementById('pluginUploadBtn');
  if (!input.files || !input.files[0]) { showToast('Choose a .zip bundle first', 'warning'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  try {
    const fd = new FormData();
    fd.append('file', input.files[0]);
    const r = await fetch('/api/plugins/upload', { method: 'POST', credentials: 'include', body: fd });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || `Upload failed (${r.status})`);
    closeModal();
    showToast(body.enabled ? `Installed & enabled: ${body.plugin.name}`
                           : `Installed: ${body.plugin.name} — configure required fields to enable`,
              body.enabled ? 'success' : 'info');
    renderPlugins();
  } catch (err) {
    if (out) out.innerHTML = `<div style="color:var(--crit);font-size:12.5px;margin-top:8px">${escapeHtml(err.message)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = 'Upload & install'; }
  }
}
