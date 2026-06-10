const pageCache = {};

const PAGE_BASE = '/dashboard/pages/';

async function loadPage(name) {
  if (pageCache[name]) return pageCache[name];
  try {
    await loadScript(`${PAGE_BASE}${name}.js`);
    pageCache[name] = true;
  } catch (err) {
    showToast(`Failed to load page: ${name}`, 'error');
    throw err;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}

async function navigate(page) {
  const hash = page || window.location.hash.slice(1) || 'dashboard';
  if (!hash) { window.location.hash = 'dashboard'; return; }

  // Show loading bar
  const bar = document.getElementById('topLoadingBar');
  if (bar) { bar.classList.add('active'); bar.style.width = '30%'; }

  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navItem = document.querySelector(`[data-page="${hash}"]`);
  if (navItem) navItem.classList.add('active');

  const info = PAGE_TITLES[hash] || { title: 'Unknown', breadcrumb: '' };
  document.getElementById('pageTitle').textContent = info.title;
  document.getElementById('pageBreadcrumb').textContent = info.breadcrumb;

  const content = document.getElementById('pageContent');
  bindActions(content);   // one delegated listener for all pages' data-act handlers
  content.innerHTML = `<div class="loading"><div class="loading-spinner"></div><span>Loading ${info.title}...</span></div>`;

  try {
    await loadPage(hash);
    const renderFn = window[`render${capitalize(hash.replace(/-./g, m => m[1].toUpperCase()))}`];
    if (renderFn) {
      content.innerHTML = '';
      content.className = 'page-content page-enter';
      if (bar) bar.style.width = '70%';
      await renderFn();
      if (bar) { bar.style.width = '100%'; setTimeout(() => { bar.style.width = '0'; bar.classList.remove('active'); }, 400); }
    } else {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('search', 32)}</div><div class="empty-state-title">Page not found</div><div class="empty-state-desc">The page "${hash}" doesn't have a render function</div></div>`;
      if (bar) { bar.style.width = '0'; bar.classList.remove('active'); }
    }
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Failed to load</div><div class="empty-state-desc">${escapeHtml(err.message)}</div><button class="btn btn-primary mt-3" onclick="navigate('dashboard')">Go to Dashboard</button></div>`;
    if (bar) { bar.style.width = '0'; bar.classList.remove('active'); }
  }
}

function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

async function updateAgentStatus() {
  try {
    const status = await api.getStatus();
    const agents = status.agents || [];
    const bar = document.getElementById('agentStatusBar');
    const online = agents.filter(a => a.status === 'online').length;
    const total = agents.length;
    const dot = bar.querySelector('.agent-dot');
    if (online === total) { dot.className = 'agent-dot online'; bar.querySelector('span').textContent = 'All agents online'; }
    else if (online > 0) { dot.className = 'agent-dot warning'; bar.querySelector('span').textContent = `${online}/${total} online`; }
    else { dot.className = 'agent-dot offline'; bar.querySelector('span').textContent = 'All agents offline'; }

    const badge = document.getElementById('skillCount');
    if (badge && status.skills_count !== undefined) badge.textContent = status.skills_count;
    updateTopbarPill(online, total);
    updateInboxBadge();
  } catch {
    const bar = document.getElementById('agentStatusBar');
    if (bar) { bar.querySelector('.agent-dot').className = 'agent-dot offline'; bar.querySelector('span').textContent = 'Disconnected'; }
    updateTopbarPill(0, 0);
  }
}

async function updateInboxBadge() {
  try {
    const r = await api.getInboxCount();
    const badge = document.getElementById('inboxCount');
    if (!badge) return;
    badge.textContent = r.count;
    badge.style.display = r.count > 0 ? '' : 'none';
  } catch {}
}

// ─── Sentinel topbar: status pill + live clock + ⌘K ──────────────

function updateTopbarPill(online, total) {
  const pill = document.getElementById('topbarStatusPill');
  const text = document.getElementById('topbarStatusText');
  if (!pill || !text) return;
  pill.style.display = '';
  const dot = pill.querySelector('.dot');
  if (total > 0 && online === total) { pill.className = 'status-pill pill-ok'; dot.className = 'dot ok'; text.textContent = 'all systems go'; }
  else if (online > 0) { pill.className = 'status-pill pill-warn'; dot.className = 'dot warn'; text.textContent = `${online}/${total} engines online`; }
  else { pill.className = 'status-pill pill-crit'; dot.className = 'dot crit'; text.textContent = total ? 'engines offline' : 'disconnected'; }
}

function startTopbarClock() {
  const el = document.getElementById('topbarClock');
  if (!el) return;
  const pad = n => String(n).padStart(2, '0');
  const tick = () => {
    const d = new Date();
    el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    const search = document.getElementById('globalSearch') || document.querySelector('.cmd-input');
    if (search) { e.preventDefault(); search.focus(); }
  }
});

window.addEventListener('hashchange', () => navigate());
window.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  const ok = await ensureAuth();
  if (!ok) return;            // login screen is shown; stop here
  navigate(window.location.hash.slice(1) || 'dashboard');
  startTopbarClock();
  updateAgentStatus();
  setInterval(updateAgentStatus, 15000);
});

// ─── Auth gate ────────────────────────────────────────────────────

window.currentUser = null;

async function ensureAuth() {
  let me;
  try { me = await api.getMe(); }
  catch { me = { authenticated: false, auth_active: true, user: null }; }
  // No users yet → first-run setup wizard (not the open-mode dashboard).
  if (!me.auth_active && !me.authenticated) { showSetupWizard(); return false; }
  if (me.auth_active && !me.authenticated) { showLoginScreen(); return false; }
  window.currentUser = me.user || null;
  if (window.currentUser && window.currentUser.must_change) { showPasswordChangeScreen(); return false; }
  renderUserChip();
  applyRoleVisibility();
  return true;
}

window.onAuthExpired = function () { showLoginScreen(); };

function showLoginScreen() {
  document.body.innerHTML = `
    <div class="login-overlay">
      <form class="login-card" onsubmit="return doLogin(event)">
        <div class="login-logo"><svg viewBox="0 0 36 36" width="44" height="44" aria-hidden="true"><defs><linearGradient id="lglogin" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3a8ad8"/><stop offset="100%" stop-color="#9b6ad8"/></linearGradient></defs><rect x="3" y="3" width="30" height="30" rx="8" fill="url(#lglogin)"/><path d="M18 9l2.4 5.6L26 17l-5.6 2.4L18 25l-2.4-5.6L10 17l5.6-2.4L18 9z" fill="#10151c"/></svg></div>
        <div class="login-title">Sentinel Agentic OS</div>
        <div class="login-sub">Sign in to continue</div>
        <input class="form-input" id="loginUser" placeholder="Username" autocomplete="username" autofocus>
        <input class="form-input" id="loginPass" type="password" placeholder="Password" autocomplete="current-password">
        <button class="btn btn-primary" type="submit" style="width:100%">Sign in</button>
        <div class="login-error" id="loginError"></div>
      </form>
    </div>`;
}

// ─── First-run setup wizard (shown when no users exist) ───────────
// 3 steps: admin account → platform basics → provider detection → finish.
// Calls the public, single-shot /api/setup which creates the first admin and
// issues a session, so finishing drops straight into the dashboard.

window._setup = { step: 1, data: { username: '', password: '', platform_name: '', projects_root: '' } };

function showSetupWizard() {
  document.body.innerHTML = `
    <div class="login-overlay">
      <div class="setup-card">
        <div class="login-logo"><svg viewBox="0 0 36 36" width="40" height="40" aria-hidden="true"><defs><linearGradient id="lgsetup" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3a8ad8"/><stop offset="100%" stop-color="#9b6ad8"/></linearGradient></defs><rect x="3" y="3" width="30" height="30" rx="8" fill="url(#lgsetup)"/><path d="M18 9l2.4 5.6L26 17l-5.6 2.4L18 25l-2.4-5.6L10 17l5.6-2.4L18 9z" fill="#10151c"/></svg></div>
        <div class="login-title">Welcome to Sentinel Agentic OS</div>
        <div class="login-sub">First-run setup — let's create your admin account</div>
        <div class="setup-steps" id="setupSteps"></div>
        <div id="setupBody"></div>
        <div class="login-error" id="setupError"></div>
      </div>
    </div>`;
  window._setup.step = 1;
  renderSetupStep();
}

function renderSetupStep() {
  const s = window._setup;
  const stepsEl = document.getElementById('setupSteps');
  if (stepsEl) stepsEl.innerHTML = [1, 2, 3].map(n =>
    `<span class="setup-dot ${n === s.step ? 'active' : n < s.step ? 'done' : ''}">${n < s.step ? '✓' : n}</span>`).join('<span class="setup-line"></span>');
  const body = document.getElementById('setupBody');
  const err = document.getElementById('setupError');
  if (err) err.textContent = '';
  if (s.step === 1) {
    body.innerHTML = `
      <div class="setup-h">Administrator account</div>
      <input class="form-input" id="suUser" placeholder="Admin username" autocomplete="username" value="${escapeHtml(s.data.username || '')}" autofocus>
      <input class="form-input" id="suPass" type="password" placeholder="Password (min 8 characters)" autocomplete="new-password">
      <input class="form-input" id="suPass2" type="password" placeholder="Repeat password" autocomplete="new-password">
      <button class="btn btn-primary" style="width:100%" onclick="setupNext()">Continue →</button>`;
  } else if (s.step === 2) {
    body.innerHTML = `
      <div class="setup-h">Platform basics <span class="setup-opt">optional</span></div>
      <input class="form-input" id="suName" placeholder="Platform name (e.g. Sentinel Agentic OS)" value="${escapeHtml(s.data.platform_name || '')}">
      <label class="setup-lbl">Projects root <span>where the orchestrator creates project folders</span></label>
      <div style="display:flex;gap:6px">
        <input class="form-input" id="suRoot" style="flex:1" placeholder="leave blank for the default" value="${escapeHtml(s.data.projects_root || '')}">
        <button class="btn btn-ghost" type="button" id="suRootBtn" onclick="setupPickRoot()">${icon('folder', 13)} Browse…</button>
      </div>
      <div class="form-hint" id="suRootHint"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-ghost" onclick="setupBack()">← Back</button>
        <button class="btn btn-primary" style="flex:1" onclick="setupNext()">Continue →</button>
      </div>`;
  } else {
    body.innerHTML = `
      <div class="setup-h">Engine detection</div>
      <div class="setup-note">These are the provider CLIs / keys detected on this machine. You can configure them anytime on the Providers page.</div>
      <div id="suProviders"><div class="loading" style="padding:14px"><div class="loading-spinner"></div></div></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-ghost" onclick="setupBack()">← Back</button>
        <button class="btn btn-primary" style="flex:1" id="suFinish" onclick="setupFinish()">Finish setup & sign in</button>
      </div>`;
    loadSetupProviders();
  }
}

async function loadSetupProviders() {
  const box = document.getElementById('suProviders');
  try {
    const data = await api.getProviders();
    const provs = data.providers || [];
    box.innerHTML = provs.map(p => {
      const ready = p.key_set || p.mode === 'cli';
      return `<div class="setup-prov">
        <span class="dot ${ready ? 'ok' : 'idle'}"></span>
        <span class="setup-prov-nm">${escapeHtml(p.label || p.name)}</span>
        <span class="setup-prov-tag">${p.custom ? 'custom' : 'built-in'}</span>
        <span class="setup-prov-st">${ready ? 'ready' : 'needs key'}</span>
      </div>`;
    }).join('') || '<div class="text-muted text-sm">No providers detected.</div>';
  } catch (err) {
    box.innerHTML = `<div class="text-muted text-sm">Detection skipped: ${escapeHtml(err.message)}</div>`;
  }
}

function setupBack() {
  if (window._setup.step > 1) { window._setup.step--; renderSetupStep(); }
}

function setupNext() {
  const s = window._setup;
  const err = document.getElementById('setupError');
  if (s.step === 1) {
    const u = document.getElementById('suUser').value.trim();
    const p = document.getElementById('suPass').value;
    const p2 = document.getElementById('suPass2').value;
    if (!u) { err.textContent = 'Username is required'; return; }
    if (p.length < 8) { err.textContent = 'Password must be at least 8 characters'; return; }
    if (p !== p2) { err.textContent = 'Passwords do not match'; return; }
    s.data.username = u; s.data.password = p;
    s.step = 2;
  } else if (s.step === 2) {
    s.data.platform_name = document.getElementById('suName').value.trim();
    s.data.projects_root = document.getElementById('suRoot').value.trim();
    s.step = 3;
  }
  renderSetupStep();
}

async function setupPickRoot() {
  const btn = document.getElementById('suRootBtn');
  const hint = document.getElementById('suRootHint');
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = 'A Finder dialog just opened — it may be behind this window…';
  try {
    const r = await api.pickFolder();
    if (r.status === 'ok' && r.path) document.getElementById('suRoot').value = r.path;
    if (hint) hint.textContent = '';
  } catch (ex) {
    if (hint) hint.textContent = ex.message + ' — type the path manually';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function setupFinish() {
  const s = window._setup;
  const err = document.getElementById('setupError');
  const btn = document.getElementById('suFinish');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    await api.setup(s.data);
    window.location.reload();    // session cookie is set by /api/setup
  } catch (ex) {
    if (err) err.textContent = ex.message || 'Setup failed';
    if (btn) { btn.disabled = false; btn.textContent = 'Finish setup & sign in'; }
  }
}

// Forced first-login password reset (must_change flag). The backend blocks all
// other API calls until the password is changed, so this screen is a hard gate.
function showPasswordChangeScreen() {
  document.body.innerHTML = `
    <div class="login-overlay">
      <form class="login-card" onsubmit="return doForcedPasswordChange(event)">
        <div class="login-logo">${icon('key', 36)}</div>
        <div class="login-title">Set a new password</div>
        <div class="login-sub">Your password must be changed before continuing</div>
        <input class="form-input" id="newPass" type="password" placeholder="New password (min 6 chars)" autocomplete="new-password" autofocus>
        <input class="form-input" id="newPass2" type="password" placeholder="Repeat new password" autocomplete="new-password">
        <button class="btn btn-primary" type="submit" style="width:100%">Change password</button>
        <div class="login-error" id="pwError"></div>
      </form>
    </div>`;
}

async function doForcedPasswordChange(e) {
  e.preventDefault();
  const p1 = document.getElementById('newPass').value;
  const p2 = document.getElementById('newPass2').value;
  const err = document.getElementById('pwError');
  err.textContent = '';
  if (p1.length < 6) { err.textContent = 'Password must be at least 6 characters'; return false; }
  if (p1 !== p2) { err.textContent = 'Passwords do not match'; return false; }
  try {
    await api.changePassword(p1);
    window.location.reload();
  } catch (ex) {
    err.textContent = ex.message || 'Password change failed';
  }
  return false;
}

async function doLogin(e) {
  e.preventDefault();
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  const err = document.getElementById('loginError');
  err.textContent = '';
  try {
    await api.login(u, p);
    window.location.reload();
  } catch (ex) {
    err.textContent = ex.message || 'Login failed';
  }
  return false;
}

function renderUserChip() {
  const bar = document.getElementById('agentStatusBar');
  if (!bar || !window.currentUser) return;
  let chip = document.getElementById('userChip');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'userChip';
    chip.className = 'user-chip';
    bar.parentElement.appendChild(chip);
  }
  const u = window.currentUser;
  chip.innerHTML = `<span class="user-chip-name">${icon('user', 12)} ${u.username}</span>
    <span class="badge badge-accent">${u.role}</span>
    <button class="btn btn-sm btn-ghost" onclick="doLogout()">Logout</button>`;
}

async function doLogout() {
  try { await api.logout(); } catch {}
  window.location.reload();
}

// Hide admin-only nav for non-admins.
function applyRoleVisibility() {
  const role = (window.currentUser && window.currentUser.role) || 'admin';
  const adminOnly = ['providers', 'users'];
  document.querySelectorAll('.nav-item').forEach(el => {
    const page = el.getAttribute('data-page');
    if (adminOnly.includes(page)) el.style.display = role === 'admin' ? '' : 'none';
  });
}
