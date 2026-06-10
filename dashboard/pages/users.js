// Users — admin management of accounts, roles, and access (RBAC)

const ROLE_OPTIONS = ['viewer', 'operator', 'admin'];

async function renderUsers() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Users</div>
        <div class="page-subtitle">Manage accounts and roles — viewer (read) · operator (run) · admin (full)</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="showUserModal()">+ New User</button>
        <button class="btn btn-ghost" onclick="showChangeOwnPassword()">${icon('key', 13)} Change my password</button>
        <button class="btn btn-ghost" onclick="renderUsers()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div id="userList">${renderSkeleton(3)}</div>
  `;
  try {
    const data = await api.getUsers();
    const users = data.users || [];
    const list = document.getElementById('userList');
    list.innerHTML = `<div style="display:grid;gap:10px">${users.map(u => `
      <div class="card flex items-center justify-between" style="flex-direction:row">
        <div>
          <span class="card-title" style="margin:0">${escapeHtml(u.username)}</span>
          <span class="badge badge-accent" style="margin-left:8px">${escapeHtml(u.role)}</span>
          ${u.disabled ? '<span class="badge badge-danger" style="margin-left:4px">disabled</span>' : ''}
          ${u.must_change ? '<span class="badge badge-warning" style="margin-left:4px">must change pw</span>' : ''}
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <select class="form-select" style="width:130px" onchange="changeUserRole('${u.id}', this.value)">
            ${ROLE_OPTIONS.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-ghost" onclick="toggleUserDisabled('${u.id}', ${!u.disabled})">${u.disabled ? 'Enable' : 'Disable'}</button>
          <button class="btn btn-sm btn-ghost" data-act="deleteUserUI" data-arg="${escapeHtml(u.id)}" data-arg2="${escapeHtml(u.username)}" style="color:var(--red)">${icon('trash', 13)}</button>
        </div>
      </div>`).join('')}</div>`;
  } catch (err) {
    document.getElementById('userList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div>`;
  }
}

function showUserModal() {
  showModal('New User', `
    <div class="form-group"><label class="form-label">Username *</label>
      <input class="form-input" id="newUsername" placeholder="username"></div>
    <div class="form-group"><label class="form-label">Password * (min 6)</label>
      <input class="form-input" id="newPassword" type="password" placeholder="password"></div>
    <div class="form-group"><label class="form-label">Role</label>
      <select class="form-select" id="newRole">${ROLE_OPTIONS.map(r => `<option value="${r}">${r}</option>`).join('')}</select></div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="createUserUI()">Create</button>
  `);
}

async function createUserUI() {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const role = document.getElementById('newRole').value;
  if (!username || password.length < 6) { showToast('Username + 6-char password required', 'error'); return; }
  try {
    await api.createUser({ username, password, role });
    showToast('User created', 'success');
    closeModal();
    renderUsers();
  } catch (err) { showToast('Failed: ' + err.message, 'error'); }
}

async function changeUserRole(id, role) {
  try { await api.updateUser(id, { role }); showToast('Role updated', 'success'); }
  catch (err) { showToast('Failed: ' + err.message, 'error'); renderUsers(); }
}

async function toggleUserDisabled(id, disabled) {
  try { await api.updateUser(id, { disabled }); renderUsers(); }
  catch (err) { showToast('Failed: ' + err.message, 'error'); }
}

async function deleteUserUI(id, username) {
  if (!confirm(`Delete user "${username}"?`)) return;
  try { await api.deleteUser(id); showToast('User deleted', 'info'); renderUsers(); }
  catch (err) { showToast('Failed: ' + err.message, 'error'); }
}

function showChangeOwnPassword() {
  showModal('Change my password', `
    <div class="form-group"><label class="form-label">New password (min 6)</label>
      <input class="form-input" id="ownPw" type="password" placeholder="new password"></div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveOwnPassword()">Save</button>
  `);
}

async function saveOwnPassword() {
  const pw = document.getElementById('ownPw').value;
  if (pw.length < 6) { showToast('Min 6 characters', 'error'); return; }
  try { await api.changePassword(pw); showToast('Password changed', 'success'); closeModal(); }
  catch (err) { showToast('Failed: ' + err.message, 'error'); }
}
