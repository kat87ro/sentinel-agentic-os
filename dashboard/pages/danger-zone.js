// Danger Zone — manual factory reset. Wipes ALL configuration back to a clean
// install (data, memory, audit, skills, agents, registries, installed plugins).
// backups/ and the encryption key are PRESERVED, and a final safety backup is
// taken automatically before the wipe — so even this is reversible. Triple
// guard: admin-only, type RESET, re-enter the admin password.

let _dzStep = 0;

async function renderDangerZone() {
  _dzStep = 0;
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title" style="color:var(--crit)">${icon('alert', 18)} Danger Zone</h1>
        <p class="page-subtitle">Irreversible platform operations — handle with care</p>
      </div>
    </div>
    <div class="card" style="border-color:var(--crit);max-width:720px">
      <div class="card-header"><span class="card-title" style="color:var(--crit)">Factory reset</span></div>
      <p style="font-size:13px;color:var(--text-dim);line-height:1.6;margin-bottom:14px">
        Wipes the platform back to a <strong>clean install</strong>: all configuration, agents,
        teams, projects, tasks, goals, memory (brain), audit log, installed plugins, and skills.
        After the reset the platform has no users and the <strong>first-run setup wizard</strong> appears.
      </p>
      <div class="card" style="background:var(--bg-2);margin-bottom:14px">
        <div style="display:grid;gap:6px;font-size:12.5px">
          <div>${icon('check', 12)} A <strong>final safety backup</strong> is taken automatically right before the wipe.</div>
          <div>${icon('check', 12)} Existing <strong>backups are kept</strong> — you can restore afterward from the Backups page (re-runs setup first).</div>
          <div>${icon('check', 12)} The encryption key is preserved, so kept backups remain restorable.</div>
        </div>
      </div>
      <div id="dzAction">
        <button class="btn btn-danger" onclick="dzArm()">${icon('alert', 13)} Begin factory reset</button>
      </div>
    </div>
  `;
}

// First warning
function dzArm() {
  document.getElementById('dzAction').innerHTML = `
    <div class="card" style="background:var(--red-dim);border-color:var(--crit);margin-bottom:12px">
      <strong style="color:var(--crit);font-size:13px">${icon('alert', 13)} Warning 1 of 2</strong>
      <p style="font-size:12.5px;color:var(--text-dim);margin-top:6px">This permanently deletes every agent, team, project, goal, task, memory note and your current login. This cannot be undone except by restoring a backup.</p>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-ghost" onclick="renderDangerZone()">Cancel</button>
      <button class="btn btn-danger" onclick="dzConfirm()">I understand — continue</button>
    </div>`;
}

// Second warning + typed confirmation + password
function dzConfirm() {
  document.getElementById('dzAction').innerHTML = `
    <div class="card" style="background:var(--red-dim);border-color:var(--crit);margin-bottom:12px">
      <strong style="color:var(--crit);font-size:13px">${icon('alert', 13)} Warning 2 of 2 — final</strong>
      <p style="font-size:12.5px;color:var(--text-dim);margin-top:6px">Type <code>RESET</code> and your admin password to wipe the platform now.</p>
    </div>
    <div class="form-group">
      <label class="form-label">Type RESET to confirm</label>
      <input class="form-input" id="dzConfirmText" placeholder="RESET" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label">Your admin password</label>
      <input class="form-input" id="dzPassword" type="password" autocomplete="current-password">
    </div>
    <div class="login-error" id="dzError"></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-ghost" onclick="renderDangerZone()">Cancel</button>
      <button class="btn btn-danger" id="dzFinalBtn" onclick="dzExecute()">${icon('trash', 13)} Wipe everything</button>
    </div>`;
}

async function dzExecute() {
  const confirm = document.getElementById('dzConfirmText').value.trim();
  const password = document.getElementById('dzPassword').value;
  const err = document.getElementById('dzError');
  err.textContent = '';
  if (confirm !== 'RESET') { err.textContent = 'Type RESET exactly to confirm'; return; }
  if (!password) { err.textContent = 'Enter your admin password'; return; }
  const btn = document.getElementById('dzFinalBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Backing up & wiping…'; }
  try {
    const r = await api.factoryReset(confirm, password);
    document.getElementById('dzAction').innerHTML = `
      <div class="card" style="border-color:var(--ok)">
        <strong style="color:var(--ok);font-size:13px">${icon('check-circle', 14)} Platform reset complete</strong>
        <p style="font-size:12.5px;color:var(--text-dim);margin-top:6px">
          Safety backup: <code>${escapeHtml(r.safety_backup || '(none)')}</code>.
          Reloading into first-run setup…
        </p>
      </div>`;
    setTimeout(() => window.location.reload(), 2200);
  } catch (ex) {
    err.textContent = ex.message || 'Reset failed';
    if (btn) { btn.disabled = false; btn.textContent = 'Wipe everything'; }
  }
}
