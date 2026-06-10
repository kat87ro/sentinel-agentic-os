// Backups — a .tar.gz of all platform state (config, memory, skills, agents,
// registries, standards, prompts, audit; optionally project workspaces). The
// encryption master key is never included. Backups can fan out to a local
// folder, a git repo, or a remote host (scp), and can be scheduled.

let _backupDest = { local: false, localFolder: '', git: false, gitRepo: '', gitRemote: 'origin', gitBranch: 'main',
                    scp: false, scpHost: '', scpUser: '', scpPath: '', scpPort: 22, workspaces: false };

async function renderBackups() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Backups</h1>
        <p class="page-subtitle">Full state snapshots — local, git, or remote; restore or schedule</p>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" onclick="showBackupSchedule()">${icon('clock', 13)} Schedule</button>
        <button class="btn btn-primary" onclick="showCreateBackup()">+ New Backup</button>
      </div>
    </div>
    <div id="backupSchedStrip"></div>
    <div id="backupList"><div class="skeleton" style="height:80px"></div></div>
  `;
  loadBackupScheduleStrip();
  try {
    const backups = await api.getBackups();
    const container = document.getElementById('backupList');
    if (backups.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('archive', 32)}</div><div class="empty-state-title">No backups yet</div><div class="empty-state-desc">A backup bundles all configuration, memory and projects into one archive</div><button class="btn btn-primary mt-3" onclick="showCreateBackup()">Create Backup</button></div>`;
      return;
    }
    container.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Name</th><th>Size</th><th>Created</th><th></th></tr></thead>
          <tbody>
            ${backups.map(b => `
              <tr>
                <td class="mono text-xs"><strong>${escapeHtml(b.name)}</strong></td>
                <td>${formatBytes(b.size)}</td>
                <td style="font-size:12px">${formatDate(b.created)}</td>
                <td style="white-space:nowrap;text-align:right">
                  <button class="btn btn-sm btn-ghost" data-act="restoreBackup" data-arg="${escapeHtml(b.name)}">${icon('refresh', 12)} Restore</button>
                  <button class="btn btn-sm btn-ghost" style="color:var(--crit)" data-act="deleteBackupUI" data-arg="${escapeHtml(b.name)}">${icon('trash', 12)}</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div style="font-size:12px;color:var(--text-muted);text-align:right;margin-top:8px">${backups.length} backup${backups.length !== 1 ? 's' : ''} · stored in backups/</div>
    `;
  } catch (err) {
    document.getElementById('backupList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

async function loadBackupScheduleStrip() {
  try {
    const s = await api.getBackupSchedule();
    const strip = document.getElementById('backupSchedStrip');
    if (!strip) return;
    if (s.enabled) {
      const next = s.next_run ? new Date(s.next_run * 1000).toLocaleString() : '—';
      strip.innerHTML = `<div class="card" style="padding:8px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px">
        <span class="dot ok"></span><span class="text-sm">Scheduled every <strong>${s.interval_hours}h</strong>${s.include_workspaces ? ' · incl. workspaces' : ''} · next: <span class="mono text-xs">${escapeHtml(next)}</span></span>
        <button class="btn btn-sm btn-ghost" style="margin-left:auto" onclick="showBackupSchedule()">${icon('wrench', 12)} Edit</button>
      </div>`;
    } else { strip.innerHTML = ''; }
  } catch {}
}

// ─── destination form (shared by create + schedule) ──────────────

function backupDestForm() {
  return `
    <div class="form-group">
      <label class="check-chip"><input type="checkbox" id="bkWorkspaces"> Include project workspace folders <span class="text-muted text-xs">(larger archive)</span></label>
    </div>
    <div class="sec-hd" style="margin:6px 0"><h2 style="font-size:12px">Destinations</h2><span class="line"></span></div>
    <div class="text-muted text-xs" style="margin-bottom:8px">A local copy is always kept for restore. Add extra destinations to push offsite:</div>
    <div class="form-group">
      <label class="check-chip"><input type="checkbox" id="bkLocal" onchange="bkToggle('Local')"> Copy to a local folder</label>
      <div id="bkLocalFields" style="display:none;margin-top:6px">
        <div style="display:flex;gap:6px">
          <input class="form-input" style="flex:1" id="bkLocalFolder" placeholder="/path/to/backup/folder">
          <button class="btn btn-ghost" type="button" onclick="bkPick('bkLocalFolder')">${icon('folder', 12)} Browse…</button>
        </div>
      </div>
    </div>
    <div class="form-group">
      <label class="check-chip"><input type="checkbox" id="bkGit" onchange="bkToggle('Git')"> Push to a git repository</label>
      <div id="bkGitFields" style="display:none;margin-top:6px">
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <input class="form-input" style="flex:1" id="bkGitRepo" placeholder="/path/to/cloned/repo">
          <button class="btn btn-ghost" type="button" onclick="bkPick('bkGitRepo')">${icon('folder', 12)}</button>
        </div>
        <div class="form-row">
          <div class="form-group" style="margin:0"><input class="form-input" id="bkGitRemote" value="origin" placeholder="remote"></div>
          <div class="form-group" style="margin:0"><input class="form-input" id="bkGitBranch" value="main" placeholder="branch"></div>
        </div>
        <div class="form-hint">Repo must already be cloned with its remote + auth (SSH key) configured.</div>
      </div>
    </div>
    <div class="form-group">
      <label class="check-chip"><input type="checkbox" id="bkScp" onchange="bkToggle('Scp')"> Copy to a remote server (scp)</label>
      <div id="bkScpFields" style="display:none;margin-top:6px">
        <div class="form-row">
          <div class="form-group" style="margin:0"><label class="form-label">Host</label><input class="form-input" id="bkScpHost" placeholder="server.example.com"></div>
          <div class="form-group" style="margin:0"><label class="form-label">User</label><input class="form-input" id="bkScpUser" placeholder="optional"></div>
        </div>
        <div class="form-row">
          <div class="form-group" style="margin:0"><label class="form-label">Remote path</label><input class="form-input" id="bkScpPath" placeholder="/backups"></div>
          <div class="form-group" style="margin:0"><label class="form-label">Port</label><input class="form-input" id="bkScpPort" type="number" value="22"></div>
        </div>
        <div class="form-hint">SSH must be key-based and already trusted (no password prompts).</div>
      </div>
    </div>`;
}

function bkToggle(which) {
  const cb = document.getElementById('bk' + which);
  const fields = document.getElementById('bk' + which + 'Fields');
  if (cb && fields) fields.style.display = cb.checked ? '' : 'none';
}

async function bkPick(inputId) {
  try {
    const r = await api.pickFolder();
    if (r.status === 'ok' && r.path) document.getElementById(inputId).value = r.path;
  } catch (err) { showToast(err.message, 'error'); }
}

function collectBackupDestinations() {
  const dests = [];
  if (document.getElementById('bkLocal').checked) {
    const folder = document.getElementById('bkLocalFolder').value.trim();
    if (folder) dests.push({ type: 'local', folder });
  }
  if (document.getElementById('bkGit').checked) {
    dests.push({ type: 'git', repo: document.getElementById('bkGitRepo').value.trim(),
      remote: document.getElementById('bkGitRemote').value.trim() || 'origin',
      branch: document.getElementById('bkGitBranch').value.trim() || 'main' });
  }
  if (document.getElementById('bkScp').checked) {
    dests.push({ type: 'scp', host: document.getElementById('bkScpHost').value.trim(),
      user: document.getElementById('bkScpUser').value.trim(),
      path: document.getElementById('bkScpPath').value.trim(),
      port: parseInt(document.getElementById('bkScpPort').value, 10) || 22 });
  }
  return dests;
}

function showCreateBackup() {
  showModal('New Backup', backupDestForm(), `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" id="bkCreateBtn" onclick="createBackupUI()">Create Backup</button>
  `);
}

async function createBackupUI() {
  const btn = document.getElementById('bkCreateBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Archiving…'; }
  try {
    const r = await api.createBackup({
      include_workspaces: document.getElementById('bkWorkspaces').checked,
      destinations: collectBackupDestinations(),
    });
    closeModal();
    const failed = (r.deliveries || []).filter(d => !d.ok);
    showToast(`Backup created: ${r.file} (${formatBytes(r.size)})`, 'success');
    if (failed.length) showToast(`Some destinations failed: ${failed.map(f => f.type + ' — ' + f.detail).join('; ')}`, 'error');
    renderBackups();
  } catch (err) {
    showToast('Backup failed: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Create Backup'; }
  }
}

async function showBackupSchedule() {
  let s = {};
  try { s = await api.getBackupSchedule(); } catch {}
  showModal('Scheduled Backups', `
    <div class="form-group">
      <label class="switch" style="width:auto;display:flex;align-items:center;gap:10px">
        <input type="checkbox" id="bkSchedEnabled" ${s.enabled ? 'checked' : ''}>
        <span class="switch-slider" style="position:relative;display:inline-block;width:40px;height:22px"></span>
        <span style="font-size:13px">Run backups automatically</span>
      </label>
    </div>
    <div class="form-group">
      <label class="form-label">Every N hours</label>
      <input class="form-input" id="bkSchedInterval" type="number" min="1" max="720" value="${s.interval_hours || 24}">
    </div>
    ${backupDestForm()}
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveBackupSchedule()">Save Schedule</button>
  `);
  // pre-fill destinations/workspaces from saved schedule
  if (s.include_workspaces) document.getElementById('bkWorkspaces').checked = true;
  (s.destinations || []).forEach(d => {
    if (d.type === 'local') { document.getElementById('bkLocal').checked = true; bkToggle('Local'); document.getElementById('bkLocalFolder').value = d.folder || ''; }
    if (d.type === 'git') { document.getElementById('bkGit').checked = true; bkToggle('Git'); document.getElementById('bkGitRepo').value = d.repo || ''; document.getElementById('bkGitRemote').value = d.remote || 'origin'; document.getElementById('bkGitBranch').value = d.branch || 'main'; }
    if (d.type === 'scp') { document.getElementById('bkScp').checked = true; bkToggle('Scp'); document.getElementById('bkScpHost').value = d.host || ''; document.getElementById('bkScpUser').value = d.user || ''; document.getElementById('bkScpPath').value = d.path || ''; document.getElementById('bkScpPort').value = d.port || 22; }
  });
}

async function saveBackupSchedule() {
  try {
    await api.setBackupSchedule({
      enabled: document.getElementById('bkSchedEnabled').checked,
      interval_hours: parseInt(document.getElementById('bkSchedInterval').value, 10) || 24,
      include_workspaces: document.getElementById('bkWorkspaces').checked,
      destinations: collectBackupDestinations(),
    });
    closeModal();
    showToast('Backup schedule saved', 'success');
    loadBackupScheduleStrip();
  } catch (err) { showToast('Failed: ' + err.message, 'error'); }
}

function restoreBackup(name) {
  showModal('Restore Backup', `
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">Restore <strong>${escapeHtml(name)}</strong>? This overwrites current configuration, memory, skills, agents and registries with the archived state.</p>
    <div class="card" style="background:var(--red-dim);border-color:transparent">
      <div class="flex items-center gap-2"><span>${icon('alert', 13)}</span><span style="font-size:13px;font-weight:500">Current state is replaced. Take a fresh backup first if unsure.</span></div>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-danger" data-act="confirmRestore" data-arg="${escapeHtml(name)}">Restore</button>
  `);
}

async function confirmRestore(name) {
  try {
    await api.restoreBackup(name);
    closeModal();
    showToast('Backup restored — reload to see restored state', 'success');
    renderBackups();
  } catch (err) {
    showToast(`Restore failed: ${err.message}`, 'error');
  }
}

async function deleteBackupUI(name) {
  if (!confirm(`Delete backup ${name}? This only removes the local archive.`)) return;
  try {
    await api.deleteBackup(name);
    showToast('Backup deleted', 'info');
    renderBackups();
  } catch (err) { showToast(err.message, 'error'); }
}
