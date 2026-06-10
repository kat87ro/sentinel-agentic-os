// Mission Control — Sentinel OS main workspace.
// Hero command bar (dispatch to any agent profile), stat strip, live agent
// cards (registry + engine health), and an activity stream from the audit log.

const DASH_SLASH = [
  { cmd: '/code', hint: 'write or refactor code', provider: 'opencode' },
  { cmd: '/research', hint: 'research & analysis', provider: 'gemini' },
  { cmd: '/reason', hint: 'deep reasoning task', provider: 'claude' },
  { cmd: '/review', hint: 'review code or a PR', provider: 'codex' },
  { cmd: '/memory', hint: 'recall or schedule', provider: 'hermes' },
];

const PROVIDER_ACCENTS = {
  opencode: 'var(--purple)', hermes: 'var(--warn)', gemini: 'var(--blue)',
  claude: 'var(--accent)', codex: 'var(--ok)',
};

function dashAccent(provider) { return PROVIDER_ACCENTS[provider] || 'var(--accent)'; }
function dashBadge(name) {
  const words = (name || '?').replace(/[_-]/g, ' ').split(' ').filter(Boolean);
  return ((words[0] || '?')[0] + (words[1] ? words[1][0] : (words[0] || '??')[1] || '')).toUpperCase();
}
function dashTint(accent, pct) { return `color-mix(in oklch, ${accent} ${pct}%, transparent)`; }

async function renderDashboard() {
  const content = document.getElementById('pageContent');
  const user = window.currentUser;
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  content.innerHTML = `
    <div class="hello" style="display:flex;align-items:baseline;gap:12px;margin-bottom:16px">
      <h1 style="font-size:21px;font-weight:600;letter-spacing:-0.02em;white-space:nowrap">Mission Control</h1>
      <span class="mono" style="font-size:11.5px;color:var(--text-faint)" id="dashHelloSub">${hello}${user ? ', ' + escapeHtml(user.username) : ''} · control plane</span>
    </div>

    <div class="cmd" style="margin-bottom:16px">
      <div class="cmd-row">
        <div class="cmd-glyph" style="color:oklch(0.16 0.02 256)">${icon('sparkle', 14)}</div>
        <input class="cmd-input" id="dashCmdInput" placeholder="Dispatch an agent…  e.g. “summarize yesterday's audit log”"
          onkeydown="if(event.key==='Enter')dashDispatch()">
        <span class="cmd-model" id="dashCmdTarget"><span class="dot ok" style="width:5px;height:5px"></span>auto-route</span>
        <button class="btn btn-primary btn-sm" onclick="dashDispatch()">Dispatch →</button>
      </div>
      <div class="cmd-slash">
        ${DASH_SLASH.map(s => `<button class="slash" onclick="dashSlash('${s.cmd}')"><b>${s.cmd}</b><small>${s.hint}</small></button>`).join('')}
      </div>
    </div>

    <div class="stats" id="dashStats" style="margin-bottom:18px">
      ${[0, 1, 2, 3].map(() => '<div class="stat"><div class="skeleton" style="height:44px"></div></div>').join('')}
    </div>

    <div class="sec-hd"><h2>Performance</h2><span class="sub" id="dashPerfSub">last 14 days</span><span class="line"></span></div>
    <div id="dashPerfTiles" class="stats" style="margin-bottom:14px"></div>
    <div class="dash-charts" style="margin-bottom:18px">
      <div class="card chart-card"><div class="chart-h">Task throughput <span>done vs failed / day</span></div><div class="chart-box"><canvas id="chartThroughput"></canvas></div></div>
      <div class="card chart-card"><div class="chart-h">Estimated cost <span>$ / day</span></div><div class="chart-box"><canvas id="chartCost"></canvas></div></div>
      <div class="card chart-card"><div class="chart-h">Task status <span>current queue</span></div><div class="chart-box"><canvas id="chartStatus"></canvas></div></div>
      <div class="card chart-card"><div class="chart-h">Top agents <span>finished tasks</span></div><div class="chart-box"><canvas id="chartAgents"></canvas></div></div>
    </div>

    <div class="sec-hd"><h2>Projects</h2><span class="sub" id="dashProjectSub"></span><span class="line"></span></div>
    <div id="dashProjects" style="margin-bottom:18px"><div class="skeleton" style="height:64px"></div></div>

    <div class="sec-hd"><h2>Agents</h2><span class="sub" id="dashAgentSub"></span><span class="line"></span></div>
    <div class="agents-grid" id="dashAgentGrid" style="margin-bottom:18px;max-height:560px;overflow-y:auto;padding-right:4px">${renderSkeleton(2)}</div>

    <div class="sec-hd"><h2>Active sessions</h2><span class="sub" id="dashSessionsSub"></span><span class="line"></span>
      <button class="btn btn-sm btn-ghost" onclick="refreshDashSessions()">${icon('refresh', 12)}</button>
    </div>
    <div class="card" style="padding:10px 14px">
      <div id="dashSessions" style="max-height:420px;overflow-y:auto"><div class="skeleton" style="height:60px;margin:8px 0"></div></div>
    </div>
  `;

  try {
    const [status, skills, audit, registry, projData, teamData, runtimeData] = await Promise.all([
      api.getStatus(),
      api.getSkills().catch(() => []),
      api.getAudit(20).catch(() => ({ entries: [] })),
      api.getCustomAgents().catch(() => ({ agents: [] })),
      api.getProjects().catch(() => ({ projects: [] })),
      api.getTeams().catch(() => ({ teams: [] })),
      api.getAgentsRuntime().catch(() => ({ runtime: {} })),
    ]);

    const engines = status.agents || [];
    const online = engines.filter(a => a.status === 'online').length;
    const agents = registry.agents || [];
    const entries = audit.entries || [];

    document.getElementById('dashStats').innerHTML = `
      <div class="stat">
        <div class="stat-lbl"><span class="dot ${online === engines.length ? 'ok' : online > 0 ? 'warn' : 'crit'}"></span>Engines online</div>
        <div class="stat-val tnum">${online}<small>/${engines.length}</small></div>
      </div>
      <div class="stat">
        <div class="stat-lbl"><span class="dot ok"></span>Agent profiles</div>
        <div class="stat-val tnum">${agents.length}</div>
      </div>
      <div class="stat">
        <div class="stat-lbl"><span class="dot ok"></span>Skills installed</div>
        <div class="stat-val tnum">${status.skills_count || (skills || []).length}</div>
      </div>
      <div class="stat">
        <div class="stat-lbl"><span class="dot ${entries.length ? 'ok' : 'idle'}"></span>Recent events</div>
        <div class="stat-val tnum">${entries.length}</div>
      </div>
    `;

    loadDashCharts();

    renderDashProjects(projData.projects || [], teamData.teams || [],
                       registry.agents || [], runtimeData.runtime || {});
    startDashProjectsRefresh();

    // Agent cards — registry profiles fused with engine health.
    const health = Object.fromEntries(engines.map(e => [e.name, e.status]));
    const sub = document.getElementById('dashAgentSub');
    if (sub) sub.textContent = `${agents.length} profiles · ${online}/${engines.length} engines`;
    const grid = document.getElementById('dashAgentGrid');
    if (agents.length === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">${icon('bot', 32)}</div><div class="empty-state-title">No agents yet</div><div class="empty-state-desc">Create one on the Agents page</div></div>`;
    } else {
      grid.innerHTML = agents.map(a => {
        const acc = dashAccent(a.provider);
        const st = health[a.provider] || 'offline';
        const tag = st === 'online' ? '<span class="state-tag st-streaming">● ready</span>'
          : st === 'warning' ? '<span class="state-tag st-working">needs key</span>'
          : '<span class="state-tag st-offline">offline</span>';
        return `
          <div class="acard ${st === 'online' ? 'streaming' : ''}">
            <div class="acard-top">
              <div class="acard-badge" style="background:${dashTint(acc, 16)};color:${acc};border:1px solid ${dashTint(acc, 38)}">${dashBadge(a.name)}</div>
              <div style="flex:1;min-width:0">
                <div class="acard-nm">${escapeHtml(a.name)}</div>
                <div class="acard-desc">${escapeHtml(a.provider)}${a.model ? ' · ' + escapeHtml(a.model) : ''}</div>
              </div>
              ${tag}
            </div>
            <div class="acard-task truncate">${escapeHtml(a.system_prompt || 'No persona set')}</div>
            <div class="acard-foot">
              <span>${(a.skills || []).slice(0, 3).join(' · ') || '—'}</span>
              <a class="acard-link" style="cursor:pointer;color:var(--accent);font-weight:600" onclick="dashTestAgent('${a.id}')">Dispatch →</a>
            </div>
          </div>`;
      }).join('');
    }

    refreshDashSessions();
    startDashSessionsRefresh();

    window._dashAgents = agents;
  } catch (err) {
    document.getElementById('dashStats').innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty-state" style="border:none;background:transparent"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Connection Error</div><div class="empty-state-desc">${escapeHtml(err.message)}</div><button class="btn btn-primary mt-3" onclick="navigate('dashboard')">Retry</button></div></div>`;
  }
}

// ─── Projects section: project → team → live agent status chips ───

function dashRuntimeChip(agent, rt) {
  const acc = dashAccent(agent.provider);
  let dot = 'idle', label = 'sleeping';
  if (!rt) { label = 'sleeping'; }
  else if (rt.state === 'working') { dot = 'ok'; label = 'working'; }
  else if (rt.state === 'waiting_input') { dot = 'warn'; label = 'needs you'; }
  else if (rt.queued > 0) {
    dot = 'warn';
    label = rt.next_wake_in != null
      ? `${rt.queued} queued · wakes in ${rt.next_wake_in >= 60 ? Math.ceil(rt.next_wake_in / 60) + 'm' : rt.next_wake_in + 's'}`
      : `${rt.queued} queued · manual wake`;
  }
  return `
    <span class="status-pill" style="gap:6px" title="${escapeHtml(agent.name)} — heartbeat ${rt && rt.heartbeat_seconds ? rt.heartbeat_seconds + 's' : 'manual'}">
      <span class="dot ${dot}"></span>
      <b style="color:${acc};font-weight:600">${escapeHtml(agent.name)}</b>
      <span style="color:var(--text-faint)">${label}</span>
    </span>`;
}

function renderDashProjects(projects, teams, agents, runtime) {
  const box = document.getElementById('dashProjects');
  const sub = document.getElementById('dashProjectSub');
  if (!box) return;
  if (sub) sub.textContent = `${projects.length} project${projects.length === 1 ? '' : 's'}`;
  if (!projects.length) {
    box.innerHTML = `<div class="card"><div class="text-muted text-sm">${icon('folder', 13)} No projects yet — create one on the Projects page to put a team to work.</div></div>`;
    return;
  }
  const agentById = Object.fromEntries(agents.map(a => [a.id, a]));
  box.innerHTML = projects.map(p => {
    const team = teams.find(t => t.id === p.team_id);
    const memberIds = team
      ? Array.from(new Set([team.manager_id].concat((team.hierarchy || []).map(h => h.agent_id))))
      : [];
    const chips = memberIds.map(id => {
      const a = agentById[id];
      return a ? dashRuntimeChip(a, runtime[id]) : '';
    }).join('');
    return `
      <div class="card" style="margin-bottom:10px;cursor:pointer" onclick="navigate('projects')">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div class="acard-badge" style="width:30px;height:30px;background:var(--accent-glow);color:var(--accent);border:1px solid color-mix(in oklch, var(--accent) 38%, transparent)">${icon('folder', 14)}</div>
          <div style="min-width:140px">
            <div style="font-size:13px;font-weight:600">${escapeHtml(p.name)}</div>
            <div class="mono" style="font-size:10px;color:var(--text-faint)">${team ? escapeHtml(team.name) : 'no team'}${p.goal ? ' · ' + escapeHtml(p.goal.slice(0, 60)) : ''}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto">${chips || '<span class="text-muted text-xs">no team assigned</span>'}</div>
        </div>
      </div>`;
  }).join('');
}

let _dashProjTimer = null;
// ─── Performance charts (real metrics from /api/metrics/overview) ──

let _dashCharts = [];
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

async function loadDashCharts() {
  if (typeof Chart === 'undefined') return;   // CDN blocked — skip silently
  try {
    const m = await api.getMetricsOverview(14);
    const s = m.summary || {};
    const tiles = document.getElementById('dashPerfTiles');
    if (tiles) tiles.innerHTML = `
      <div class="stat"><div class="stat-lbl"><span class="dot ok"></span>Tasks done</div><div class="stat-val tnum">${s.tasks_done || 0}<small>/${s.tasks_total || 0}</small></div></div>
      <div class="stat"><div class="stat-lbl"><span class="dot ${s.success_rate == null ? 'idle' : s.success_rate >= 80 ? 'ok' : s.success_rate >= 50 ? 'warn' : 'crit'}"></span>Success rate</div><div class="stat-val tnum">${s.success_rate == null ? '—' : s.success_rate + '<small>%</small>'}</div></div>
      <div class="stat"><div class="stat-lbl"><span class="dot ok"></span>Goal progress</div><div class="stat-val tnum">${s.avg_goal_progress || 0}<small>% · ${s.goals_completed || 0}/${s.goals || 0} done</small></div></div>
      <div class="stat"><div class="stat-lbl"><span class="dot ok"></span>Est. spend (30d)</div><div class="stat-val tnum">$${(s.total_cost || 0).toFixed(2)}</div></div>`;

    _dashCharts.forEach(c => { try { c.destroy(); } catch {} });
    _dashCharts = [];
    const text = cssVar('--text-dim') || '#9aa';
    const grid = 'oklch(0.30 0.016 256 / 0.5)';
    const accent = cssVar('--accent') || '#4aa3e0';
    const ok = cssVar('--ok') || '#3fc';
    const crit = cssVar('--crit') || '#e66';
    const warn = cssVar('--warn') || '#fb2';
    const purple = cssVar('--purple') || '#a7f';
    const axis = (extra = {}) => ({ ticks: { color: text, font: { size: 10 } }, grid: { color: grid }, ...extra });
    const noLegend = { legend: { display: false } };
    const legendBottom = { legend: { position: 'bottom', labels: { color: text, font: { size: 10 }, boxWidth: 12 } } };
    const baseOpts = { responsive: true, maintainAspectRatio: false };
    const dayShort = m.days.map(d => d.slice(5));   // MM-DD

    // 1. Throughput — stacked bars done/failed per day
    _dashCharts.push(new Chart(document.getElementById('chartThroughput'), {
      type: 'bar',
      data: { labels: dayShort, datasets: [
        { label: 'Done', data: m.throughput.done, backgroundColor: ok, stack: 's' },
        { label: 'Failed', data: m.throughput.failed, backgroundColor: crit, stack: 's' },
      ] },
      options: { ...baseOpts, plugins: legendBottom, scales: { x: axis({ stacked: true }), y: axis({ stacked: true, beginAtZero: true, ticks: { precision: 0, color: text } }) } },
    }));

    // 2. Cost — line $/day
    _dashCharts.push(new Chart(document.getElementById('chartCost'), {
      type: 'line',
      data: { labels: dayShort, datasets: [{ label: '$', data: m.cost, borderColor: accent, backgroundColor: 'oklch(0.74 0.135 232 / 0.12)', fill: true, tension: 0.35, pointRadius: 2 }] },
      options: { ...baseOpts, plugins: noLegend, scales: { x: axis(), y: axis({ beginAtZero: true }) } },
    }));

    // 3. Task status — doughnut
    const st = m.task_status || {};
    _dashCharts.push(new Chart(document.getElementById('chartStatus'), {
      type: 'doughnut',
      data: { labels: ['Done', 'Running', 'Queued', 'Blocked', 'Failed'],
        datasets: [{ data: [st.done || 0, st.running || 0, st.queued || 0, st.needs_input || 0, st.failed || 0],
          backgroundColor: [ok, accent, warn, purple, crit], borderWidth: 0 }] },
      options: { ...baseOpts, cutout: '62%', plugins: legendBottom },
    }));

    // 4. Top agents — horizontal bars
    const ta = m.top_agents || [];
    if (ta.length === 0) {
      const box = document.getElementById('chartAgents');
      if (box) box.closest('.chart-box').innerHTML = `<div class="empty-state" style="border:none;background:transparent;padding:20px"><div class="empty-state-icon">${icon('bot', 22)}</div><div class="empty-state-title" style="font-size:12px">No finished tasks yet</div></div>`;
    } else {
      _dashCharts.push(new Chart(document.getElementById('chartAgents'), {
        type: 'bar',
        data: { labels: ta.map(a => a.agent), datasets: [
          { label: 'Done', data: ta.map(a => a.done), backgroundColor: ok, stack: 's' },
          { label: 'Failed', data: ta.map(a => a.failed), backgroundColor: crit, stack: 's' },
        ] },
        options: { ...baseOpts, indexAxis: 'y', plugins: legendBottom, scales: { x: axis({ stacked: true, beginAtZero: true, ticks: { precision: 0, color: text } }), y: axis({ stacked: true }) } },
      }));
    }
  } catch (err) {
    const tiles = document.getElementById('dashPerfTiles');
    if (tiles) tiles.innerHTML = `<div class="text-muted text-sm" style="grid-column:1/-1">Metrics unavailable: ${escapeHtml(err.message)}</div>`;
  }
}

// ─── Active sessions: live subprocess monitor + kill switch ───────

let _dashSessTimer = null;
const SESSION_KIND_BADGE = { task: 'badge-info', chat: 'badge-accent', skill: 'badge-success', reflection: 'badge-neutral', agent: 'badge-neutral' };

function fmtRuntime(s) {
  const m = Math.floor(s / 60), sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

async function refreshDashSessions() {
  const box = document.getElementById('dashSessions');
  if (!box) return;
  try {
    const data = await api.getActiveSessions();
    const sessions = data.sessions || [];
    const stranded = data.stranded || [];
    const sub = document.getElementById('dashSessionsSub');
    if (sub) sub.textContent = `${sessions.length} running${stranded.length ? ` · ${stranded.length} stranded` : ''}`;
    if (sessions.length === 0 && stranded.length === 0) {
      box.innerHTML = `<div class="empty-state" style="border:none;background:transparent;padding:18px"><div class="empty-state-icon" style="font-size:24px">${icon('check-circle', 22)}</div><div class="empty-state-title" style="font-size:13px">No active sessions</div><div class="empty-state-desc" style="font-size:12px">Live LLM runs appear here the moment an agent starts working — kill anything that hangs</div></div>`;
      return;
    }
    box.innerHTML = sessions.map(s => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border)">
        <span class="dot ok" style="animation:pulseDot 1.6s infinite"></span>
        <span class="badge ${SESSION_KIND_BADGE[s.kind] || 'badge-neutral'}">${escapeHtml(s.kind)}</span>
        <div style="flex:1;min-width:0">
          <div class="truncate" style="font-size:12.5px;font-weight:600" title="${escapeHtml(s.label)}">${escapeHtml(s.label || '(no label)')}</div>
          <div class="mono text-xs" style="color:var(--text-faint)">${escapeHtml(s.agent_name || '—')} · ${escapeHtml(s.command)} · pid ${s.pid}${s.task_id ? ` · task ${s.task_id}` : ''}</div>
        </div>
        <span class="mono text-xs" title="runtime">${fmtRuntime(s.runtime_seconds)}</span>
        <button class="btn btn-sm btn-ghost" style="color:var(--crit)" title="Kill this run (SIGTERM, then SIGKILL)" onclick="killSessionUI('${s.id}')">${icon('x', 13)} Kill</button>
      </div>`).join('') +
      stranded.map(t => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border);opacity:.8">
        <span class="dot warn"></span>
        <span class="badge badge-warning">stranded</span>
        <div style="flex:1;min-width:0">
          <div class="truncate" style="font-size:12.5px;font-weight:600">${escapeHtml(t.title || t.task_id)}</div>
          <div class="mono text-xs" style="color:var(--text-faint)">${escapeHtml(t.agent_name || '—')} · task ${t.task_id} marked running but no live process</div>
        </div>
        <button class="btn btn-sm btn-ghost" style="color:var(--warn)" title="Mark failed and free the agent" onclick="releaseTaskUI('${t.task_id}')">${icon('refresh', 13)} Release</button>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="text-muted text-sm" style="padding:10px">${escapeHtml(err.message)}</div>`;
  }
}

function startDashSessionsRefresh() {
  if (_dashSessTimer) clearInterval(_dashSessTimer);
  _dashSessTimer = setInterval(() => {
    if (!document.getElementById('dashSessions')) { clearInterval(_dashSessTimer); _dashSessTimer = null; return; }
    refreshDashSessions();
  }, 5000);
}

async function killSessionUI(id) {
  if (!confirm('Kill this run? Its process group is terminated and any linked task is marked failed.')) return;
  try {
    await api.killSession(id);
    showToast('Session killed — linked task will settle as failed', 'info');
    setTimeout(refreshDashSessions, 600);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function releaseTaskUI(taskId) {
  if (!confirm('Release this stranded task? It is marked failed so the agent and goal math stop waiting on it.')) return;
  try {
    await api.releaseTask(taskId);
    showToast('Task released', 'info');
    setTimeout(refreshDashSessions, 400);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function startDashProjectsRefresh() {
  if (_dashProjTimer) clearInterval(_dashProjTimer);
  _dashProjTimer = setInterval(async () => {
    const box = document.getElementById('dashProjects');
    if (!box) { clearInterval(_dashProjTimer); _dashProjTimer = null; return; }
    try {
      const [projData, teamData, agentData, runtimeData] = await Promise.all([
        api.getProjects(), api.getTeams(), api.getCustomAgents(), api.getAgentsRuntime(),
      ]);
      renderDashProjects(projData.projects || [], teamData.teams || [],
                         agentData.agents || [], runtimeData.runtime || {});
    } catch {}
  }, 15000);
}

function dashSlash(cmd) {
  const input = document.getElementById('dashCmdInput');
  input.value = cmd + ' ';
  input.focus();
  const s = DASH_SLASH.find(x => x.cmd === cmd);
  const target = document.getElementById('dashCmdTarget');
  if (s && target) target.innerHTML = `<span class="dot ok" style="width:5px;height:5px"></span>${s.provider}`;
}

function dashAgentForProvider(provider) {
  const agents = window._dashAgents || [];
  return agents.find(a => a.id === `${provider}_default`) || agents.find(a => a.provider === provider);
}

async function dashDispatch() {
  const input = document.getElementById('dashCmdInput');
  const raw = (input.value || '').trim();
  if (!raw) { showToast('Type a task to dispatch', 'warning'); return; }

  const slash = DASH_SLASH.find(s => raw.startsWith(s.cmd));
  const message = slash ? raw.slice(slash.cmd.length).trim() || slash.hint : raw;
  let agent = slash ? dashAgentForProvider(slash.provider) : null;

  if (!agent) {
    // auto-route: ask the smart router, fall back to claude/opencode default
    try {
      const r = await api.suggestRouter(message);
      agent = dashAgentForProvider((r.suggestion && r.suggestion.agent) || r.agent || '');
    } catch {}
    agent = agent || dashAgentForProvider('claude') || dashAgentForProvider('opencode') || (window._dashAgents || [])[0];
  }
  if (!agent) { showToast('No agent profiles available', 'error'); return; }

  showModal(`Dispatched → ${escapeHtml(agent.name)}`, `
    <div class="mono text-muted text-xs" style="margin-bottom:10px">${escapeHtml(agent.provider)}${agent.model ? ' · ' + escapeHtml(agent.model) : ''}</div>
    <div id="dashDispatchOut"><div class="loading" style="padding:24px"><div class="loading-spinner"></div><span>Running…</span></div></div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Close</button>`);
  input.value = '';

  try {
    const r = await api.dispatchTask({ message, agent_id: agent.id });
    const out = document.getElementById('dashDispatchOut');
    if (out) out.innerHTML = `<pre style="max-height:380px;overflow:auto;white-space:pre-wrap">${escapeHtml(r.result || '(no output)')}</pre>`;
  } catch (err) {
    const out = document.getElementById('dashDispatchOut');
    if (out) out.innerHTML = `<div style="color:var(--crit);font-size:12.5px">${escapeHtml(err.message)}</div>`;
  }
}

function dashTestAgent(agentId) {
  const a = (window._dashAgents || []).find(x => x.id === agentId);
  if (!a) return;
  const input = document.getElementById('dashCmdInput');
  const slash = DASH_SLASH.find(s => s.provider === a.provider);
  if (slash) dashSlash(slash.cmd);
  else input.focus();
}

// Quick Run (legacy helper, still used by other pages)
async function runQuickSkill() {
  showModal('Quick Run Skill', `
    <div class="form-group">
      <label class="form-label">Skill Name</label>
      <select id="qrSkill" class="form-select">
        <option value="">Select a skill...</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Input (optional)</label>
      <textarea id="qrInput" class="form-textarea" rows="3" placeholder="Enter input for the skill..."></textarea>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="executeQuickRun()">▶ Run Skill</button>
  `);

  try {
    const skills = await api.getSkills();
    const select = document.getElementById('qrSkill');
    skills.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name.replace(/-/g, ' ');
      select.appendChild(opt);
    });
  } catch {}
}

async function executeQuickRun() {
  const name = document.getElementById('qrSkill').value;
  const input = document.getElementById('qrInput').value;
  if (!name) { showToast('Please select a skill', 'warning'); return; }
  try {
    const r = await api.runSkill(name, input);
    closeModal();
    showToast(`"${name}" dispatched to ${r.agent} #${r.run_id}`, 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}
