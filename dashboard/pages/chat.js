async function renderChat() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">AI Chat</h1>
        <p class="page-subtitle">Talk to opencode, Hermes, Gemini, Claude, and Codex</p>
      </div>
      <div class="btn-group">
        <div class="tabs" style="margin:0;border:none">
          <button class="tab active" id="modeChatBtn" onclick="setChatMode('chat')">${icon('message', 13)} Chat</button>
          <button class="tab" id="modeJarvisBtn" onclick="setChatMode('jarvis')">${icon('mic', 13)} Jarvis</button>
        </div>
        <button class="btn" onclick="clearChat()">${icon('trash', 13)} Clear</button>
        <button class="btn" onclick="refreshChat()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div class="chat-layout">
      <div class="chat-sidebar">
        <div class="chat-agents-label">Agents</div>
        <div class="chat-agent" data-agent="orchestrator" onclick="selectAgent('orchestrator')">
          <div class="agent-dot online"></div>
          <div>
            <div class="chat-agent-name">Orchestrator</div>
            <div class="chat-agent-desc">Project + team from a request</div>
          </div>
        </div>
        <div class="chat-agent active" data-agent="opencode" onclick="selectAgent('opencode')">
          <div class="agent-dot online"></div>
          <div>
            <div class="chat-agent-name">opencode</div>
            <div class="chat-agent-desc">Code & DevOps</div>
          </div>
        </div>
        <div class="chat-agent" data-agent="hermes" onclick="selectAgent('hermes')">
          <div class="agent-dot online"></div>
          <div>
            <div class="chat-agent-name">Hermes</div>
            <div class="chat-agent-desc">Memory & Scheduling</div>
          </div>
        </div>
        <div class="chat-agent" data-agent="gemini" onclick="selectAgent('gemini')">
          <div class="agent-dot offline"></div>
          <div>
            <div class="chat-agent-name">Gemini CLI</div>
            <div class="chat-agent-desc">Research & Analysis</div>
          </div>
        </div>
        <div class="chat-agent" data-agent="claude" onclick="selectAgent('claude')">
          <div class="agent-dot offline"></div>
          <div>
            <div class="chat-agent-name">Claude</div>
            <div class="chat-agent-desc">Reasoning & Engineering</div>
          </div>
        </div>
        <div class="chat-agent" data-agent="codex" onclick="selectAgent('codex')">
          <div class="agent-dot offline"></div>
          <div>
            <div class="chat-agent-name">Codex</div>
            <div class="chat-agent-desc">OpenAI Code & Review</div>
          </div>
        </div>
        <div style="margin-top:auto;padding:12px;font-size:11px;color:var(--text-muted);border-top:1px solid var(--border)">
          <div id="chatAgentStatus">opencode • ready</div>
        </div>
      </div>
      <div class="chat-main">
        <div id="jarvisView" class="jv" style="display:none">
          <header class="jv-top">
            <div class="jv-title-wrap">
              <div class="jv-title">J.A.R.V.I.S</div>
              <div class="jv-sub">Just A Rather Very Intelligent System</div>
            </div>
            <div class="jv-clock">
              <div class="jv-time" id="jvTime">--:--:--</div>
              <div class="jv-date" id="jvDate"></div>
            </div>
          </header>
          <div class="jv-body">
            <div class="jv-vitals" id="jvVitals"></div>
            <div class="jv-stage">
              <div class="corner tl"></div><div class="corner tr"></div><div class="corner bl"></div><div class="corner br"></div>
              <div class="reactor idle" id="jvReactor" onclick="jarvisOrbTap()" title="Tap to talk / interrupt">
                ${jarvisReactorSvg()}
                <div class="core"><span class="core-text">J.A.R.V.I.S</span></div>
              </div>
              <div class="jv-status idle" id="jvStatusChip"><span class="glyph"></span><span class="label">STANDBY</span></div>
              <div class="wave" id="jvWave">${Array.from({length:48}).map((_,i)=>`<i style="--h:${(6+Math.abs(Math.sin(i*0.7))*26).toFixed(1)}px;animation-delay:${(i*0.04).toFixed(2)}s"></i>`).join('')}</div>
            </div>
            <div class="jv-side">
              <div class="panel-h">Activity Log<span class="ln"></span></div>
              <div class="log-wrap"><div class="log" id="jvLog"></div></div>
              <div class="panel-h" style="margin-top:8px">Voice & Model<span class="ln"></span></div>
              <div class="jv-cfg">
                <div class="cfg-row"><span class="name">Speech-to-text</span><label class="toggle-sw"><input type="checkbox" id="jvSTT" checked onchange="jarvisToggleSTT()"><span></span></label></div>
                <div class="cfg-row"><span class="name">Spoken replies</span><label class="toggle-sw"><input type="checkbox" id="jvTTS" checked><span></span></label></div>
                <div class="cfg-row"><span class="name">Conversation mode</span><label class="toggle-sw"><input type="checkbox" id="jvAuto" checked><span></span></label></div>
                <div class="cfg-row"><span class="name">Language</span>
                  <select class="cfg-sel" id="jvLang" onchange="jarvisSetLang()"><option value="en-US">English</option><option value="ro-RO">Română</option></select>
                </div>
                <div class="cfg-row"><span class="name">Routing to</span><span class="cfg-pill" id="jvAgentPill">orchestrator</span></div>
              </div>
              <div class="panel-h" style="margin-top:8px">Command Input<span class="ln"></span></div>
              <div class="cmd-wrap">
                <input class="cmd-field" id="jvCmd" placeholder="Type a command or question…" onkeydown="if(event.key==='Enter')jarvisSubmitCmd()">
                <button class="cmd-go" onclick="jarvisSubmitCmd()">${icon('send', 14)}</button>
              </div>
              <div class="jv-controls">
                <button class="ctl mic on" id="jvMicBtn" onclick="jarvisOrbTap()"><span class="micdot"></span><span id="jvMicLabel">Tap to speak</span></button>
                <button class="ctl ctl-ghost" onclick="jarvisStopSpeaking()">${icon('pause', 12)} Stop voice</button>
                <button class="ctl ctl-ghost" onclick="jarvisFullscreen()">⛶ Fullscreen</button>
              </div>
            </div>
          </div>
        </div>
        <div id="chatMessages" class="chat-messages">
          <div class="chat-welcome">
            <div class="chat-welcome-icon">${icon('message', 40)}</div>
            <div class="chat-welcome-title">Sentinel Agentic OS Chat</div>
            <div class="chat-welcome-desc">Select an agent on the left and start a conversation.<br>Each agent has different capabilities — choose the right one for your task.</div>
            <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;justify-content:center">
              <button class="btn btn-sm" onclick="sendQuickPrompt('orchestrator','Create a small project: a pomodoro timer web app in a new folder, assign a suitable team and kick it off')">${icon('sparkle', 13)} Orchestrate</button>
              <button class="btn btn-sm" onclick="sendQuickPrompt('opencode','Check the system status and running processes')">${icon('search', 13)} System Check</button>
              <button class="btn btn-sm" onclick="sendQuickPrompt('hermes','What did I work on recently?')">${icon('cpu', 13)} Recall Memory</button>
              <button class="btn btn-sm" onclick="sendQuickPrompt('gemini','Research the latest trends in AI agents')">${icon('bar-chart', 13)} Research</button>
            </div>
          </div>
        </div>
        <div class="chat-input-area">
          <div class="chat-agent-indicator" id="chatAgentIndicator">opencode</div>
          <textarea id="chatInput" class="chat-input" rows="1" placeholder="Type a message..." onkeydown="handleChatKey(event)"></textarea>
          <button class="btn btn-primary btn-icon" onclick="sendChatMessage()" id="chatSendBtn" title="Send">${icon('send', 13)}</button>
        </div>
      </div>
    </div>
  `;

  window._currentAgent = 'opencode';
  window._chatHistory = [];
  document.getElementById('chatInput').focus();

  // Update agent status indicators
  try {
    const status = await api.getStatus();
    (status.agents || []).forEach(a => {
      const el = document.querySelector(`.chat-agent[data-agent="${a.name}"]`);
      if (el) {
        const dot = el.querySelector('.agent-dot');
        dot.className = `agent-dot ${a.status}`;
      }
    });
    updateAgentStatusText();
  } catch {}

  // Load chat history
  await refreshChat();
}

function selectAgent(agent) {
  window._currentAgent = agent;
  document.querySelectorAll('.chat-agent').forEach(el => el.classList.remove('active'));
  document.querySelector(`.chat-agent[data-agent="${agent}"]`).classList.add('active');
  document.getElementById('chatAgentIndicator').textContent = agent;
  document.getElementById('chatInput').focus();
  updateAgentStatusText();
}

function updateAgentStatusText() {
  const el = document.getElementById('chatAgentStatus');
  if (el && window._currentAgent) {
    const agentEl = document.querySelector(`.chat-agent[data-agent="${window._currentAgent}"]`);
    const dot = agentEl ? agentEl.querySelector('.agent-dot').className : 'offline';
    el.textContent = `${window._currentAgent} • ${dot === 'agent-dot online' ? 'online' : 'offline'}`;
  }
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
  autoResizeTextarea(e.target);
}

function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message) return;

  const agent = window._currentAgent || 'opencode';
  input.value = '';
  input.style.height = 'auto';

  // Add user message to chat
  addChatMessage('user', message, agent);

  // Show typing indicator
  const typingId = showTypingIndicator(agent);

  if (agent === 'orchestrator') {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 360000);
      const r = await api.orchestrate(message, controller);
      clearTimeout(timeoutId);
      removeTypingIndicator(typingId);
      addChatMessage('assistant', r.summary, 'orchestrator');
      if (typeof updateInboxBadge === 'function') updateInboxBadge();
    } catch (err) {
      removeTypingIndicator(typingId);
      addChatMessage('assistant', 'Orchestration failed: ' + (err.name === 'AbortError' ? 'timed out' : err.message), 'orchestrator');
    }
    return;
  }

  try {
    // Client-side timeout: 200s (slightly more than Hermes' 180s backend timeout)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 200000);
    const r = await api.chat(agent, message, controller);
    clearTimeout(timeoutId);
    removeTypingIndicator(typingId);
    addChatMessage('assistant', r.response.content, agent);

    // Store in local history
    window._chatHistory.push({ role: 'user', content: message, agent });
    window._chatHistory.push({ role: 'assistant', content: r.response.content, agent });
  } catch (err) {
    removeTypingIndicator(typingId);
    const msg = err.name === 'AbortError' ? 'Request timed out after 200s' : err.message;
    addChatMessage('assistant', `${icon('alert', 13)} Error: ${msg}`, agent);
  }
}

function addChatMessage(role, content, agent) {
  const container = document.getElementById('chatMessages');
  const welcome = container.querySelector('.chat-welcome');
  if (welcome) welcome.style.display = 'none';

  const msg = document.createElement('div');
  msg.className = `chat-message ${role}`;
  msg.innerHTML = `
    <div class="chat-message-avatar">${role === 'user' ? `${icon('user', 13)}` : `${icon('bot', 13)}`}</div>
    <div class="chat-message-body">
      <div class="chat-message-header">
        <span class="chat-message-agent">${role === 'user' ? 'You' : agent}</span>
        <span class="chat-message-time">just now</span>
      </div>
      <div class="chat-message-content">${escapeHtml(content)}</div>
    </div>
  `;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function showTypingIndicator(agent) {
  const container = document.getElementById('chatMessages');
  const id = 'typing-' + Date.now();
  const div = document.createElement('div');
  div.className = 'chat-message assistant';
  div.id = id;
  div.innerHTML = `
    <div class="chat-message-avatar">${icon('bot', 13)}</div>
    <div class="chat-message-body">
      <div class="chat-message-header">
        <span class="chat-message-agent">${agent}</span>
      </div>
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeTypingIndicator(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

async function refreshChat() {
  try {
    const data = await api.getChatHistory();
    const messages = data.messages || [];
    window._chatHistory = messages;
    renderChatHistory(messages);
  } catch {}
}

function renderChatHistory(messages) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const welcome = container.querySelector('.chat-welcome');
  if (welcome) welcome.style.display = 'none';

  // Remove all existing messages (keep welcome)
  container.querySelectorAll('.chat-message').forEach(el => el.remove());

  if (messages.length === 0) {
    if (welcome) welcome.style.display = '';
    return;
  }

  messages.forEach(msg => {
    const div = document.createElement('div');
    div.className = `chat-message ${msg.role}`;
    div.innerHTML = `
      <div class="chat-message-avatar">${msg.role === 'user' ? `${icon('user', 13)}` : `${icon('bot', 13)}`}</div>
      <div class="chat-message-body">
        <div class="chat-message-header">
          <span class="chat-message-agent">${msg.role === 'user' ? 'You' : msg.agent}</span>
          <span class="chat-message-time">${timeAgo(msg.timestamp)}</span>
        </div>
        <div class="chat-message-content">${escapeHtml(msg.content)}</div>
      </div>
    `;
    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;
}

function clearChat() {
  document.querySelectorAll('#chatMessages .chat-message').forEach(el => el.remove());
  const welcome = document.querySelector('.chat-welcome');
  if (welcome) welcome.style.display = '';
  window._chatHistory = [];
}

function sendQuickPrompt(agent, message) {
  selectAgent(agent);
  document.getElementById('chatInput').value = message;
  sendChatMessage();
}

// ─── J.A.R.V.I.S — Live Agent HUD (Web Speech API) ────────────────
// A full ops-console takeover: arc-reactor core, live vitals gauges fed from
// REAL Sentinel metrics, an activity-log transcript, and a voice loop —
// Listen (SpeechRecognition) → route to the SELECTED agent (orchestrator by
// default) → speak the reply (speechSynthesis). State drives the reactor CSS:
// idle / listening / thinking / speaking. Exchanges also land in the normal
// chat stream so nothing is lost when switching back to Chat.

let _jarvis = { mode: 'chat', state: 'idle', rec: null, lang: 'en-US',
                enteredOnce: false, clockTimer: null, vitalsTimer: null };
const JV_STATUS = { idle: 'STANDBY', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING' };

// Static reactor SVG (ticks, rotating dashed/segmented rings, radar sweep,
// crosshair) — translated from the design's React <Reactor>. Animation is all
// CSS; only the state class on .reactor changes at runtime.
function jarvisReactorSvg() {
  let ticks = '';
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2, long = i % 6 === 0;
    const r1 = long ? 196 : 204, r2 = 214;
    ticks += `<line x1="${(250 + Math.cos(a) * r1).toFixed(1)}" y1="${(250 + Math.sin(a) * r1).toFixed(1)}" x2="${(250 + Math.cos(a) * r2).toFixed(1)}" y2="${(250 + Math.sin(a) * r2).toFixed(1)}" stroke="var(--accent)" stroke-width="${long ? 1.6 : 0.8}" opacity="${long ? 0.55 : 0.28}"/>`;
  }
  const arc = (r, start, end, w, op) => {
    const s = (start / 360) * Math.PI * 2, e = (end / 360) * Math.PI * 2;
    const large = end - start > 180 ? 1 : 0;
    return `<path d="M${(250 + Math.cos(s) * r).toFixed(1)},${(250 + Math.sin(s) * r).toFixed(1)} A${r},${r} 0 ${large} 1 ${(250 + Math.cos(e) * r).toFixed(1)},${(250 + Math.sin(e) * r).toFixed(1)}" fill="none" stroke="var(--accent)" stroke-width="${w}" opacity="${op}" stroke-linecap="round"/>`;
  };
  const dots = [0, 90, 180, 270].map(d => {
    const a = (d / 360) * Math.PI * 2;
    return `<circle cx="${(250 + Math.cos(a) * 158).toFixed(1)}" cy="${(250 + Math.sin(a) * 158).toFixed(1)}" r="2.4" fill="var(--accent)"/>`;
  }).join('');
  return `
    <svg viewBox="0 0 500 500"><g class="spin-slow">${ticks}</g></svg>
    <svg viewBox="0 0 500 500"><g class="spin-cw">
      <circle cx="250" cy="250" r="184" fill="none" stroke="var(--accent)" stroke-width="1" opacity="0.18" stroke-dasharray="2 8"/>
      ${arc(184, 10, 80, 2.5, 0.7)}${arc(184, 200, 250, 2.5, 0.5)}
    </g></svg>
    <svg viewBox="0 0 500 500"><g class="spin-ccw">
      <circle cx="250" cy="250" r="158" fill="none" stroke="var(--accent)" stroke-width="1" opacity="0.22"/>
      ${arc(158, 120, 175, 3, 0.75)}${arc(158, 300, 340, 3, 0.6)}${dots}
    </g></svg>
    <svg viewBox="0 0 500 500"><g class="spin-fast">
      <circle cx="250" cy="250" r="128" fill="none" stroke="var(--accent)" stroke-width="1.2" opacity="0.3" stroke-dasharray="40 14"/>
      ${arc(128, 60, 95, 3.5, 0.85)}
    </g></svg>
    <svg viewBox="0 0 500 500">
      <line x1="250" y1="40" x2="250" y2="120" stroke="var(--accent)" stroke-width="1" opacity="0.22"/>
      <line x1="250" y1="380" x2="250" y2="460" stroke="var(--accent)" stroke-width="1" opacity="0.22"/>
      <line x1="40" y1="250" x2="120" y2="250" stroke="var(--accent)" stroke-width="1" opacity="0.22"/>
      <line x1="380" y1="250" x2="460" y2="250" stroke="var(--accent)" stroke-width="1" opacity="0.22"/>
      <circle class="pulse-ring" cx="250" cy="250" r="110" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.5"/>
      <g class="sweep">
        <defs><linearGradient id="jvSweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.32"/>
        </linearGradient></defs>
        <path d="M250,250 L250,108 A142,142 0 0 1 384,250 Z" fill="url(#jvSweep)" opacity="0.5"/>
        <line x1="250" y1="250" x2="250" y2="108" stroke="var(--accent)" stroke-width="1.4" opacity="0.7"/>
      </g>
    </svg>`;
}

function jarvisVitalChip(label, value, unit, pct, status) {
  const r = 32, c = 2 * Math.PI * r;
  const col = status === 'crit' ? 'var(--crit)' : status === 'warn' ? 'var(--warn)' : 'var(--accent)';
  const off = c - (c * Math.max(0, Math.min(100, pct))) / 100;
  return `<div class="vchip ${status}">
    <div class="vchip-ring">
      <svg viewBox="0 0 76 76">
        <circle cx="38" cy="38" r="${r}" fill="none" stroke="oklch(0.74 0.135 232 / 0.12)" stroke-width="3"/>
        <circle cx="38" cy="38" r="${r}" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round"
          stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 38 38)" style="transition:stroke-dashoffset .6s,stroke .3s"/>
      </svg>
      <div class="vchip-val">${value}${unit || ''}</div>
    </div>
    <div class="vchip-lbl">${label}</div>
  </div>`;
}

function setChatMode(mode) {
  _jarvis.mode = mode;
  const isJarvis = mode === 'jarvis';
  document.getElementById('modeChatBtn').classList.toggle('active', !isJarvis);
  document.getElementById('modeJarvisBtn').classList.toggle('active', isJarvis);
  document.getElementById('jarvisView').style.display = isJarvis ? 'flex' : 'none';
  document.getElementById('chatMessages').style.display = isJarvis ? 'none' : '';
  document.querySelector('.chat-input-area').style.display = isJarvis ? 'none' : '';
  document.querySelector('.chat-sidebar').style.display = isJarvis ? 'none' : '';
  document.querySelector('.page-header').style.display = isJarvis ? 'none' : '';
  if (isJarvis) {
    jarvisStartClock();
    jarvisStartVitals();
    if (!_jarvis.enteredOnce) {
      _jarvis.enteredOnce = true;
      if (!window._jarvisLogged) {
        window._jarvisLogged = true;
        jarvisLog('sys', 'J.A.R.V.I.S online. Routing to the orchestrator.');
        const ok = ('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window);
        jarvisLog('sys', ok ? 'Voice ready — tap the reactor or the mic button to speak.'
                            : 'Voice input unsupported in this browser (use Chrome or Edge). Text command still works.');
      }
    }
    selectAgent(window._currentAgent || 'orchestrator');
    jarvisSyncAgentPill();
  } else {
    jarvisStopAll();
    if (_jarvis.clockTimer) { clearInterval(_jarvis.clockTimer); _jarvis.clockTimer = null; }
    if (_jarvis.vitalsTimer) { clearInterval(_jarvis.vitalsTimer); _jarvis.vitalsTimer = null; }
  }
}

function jarvisSyncAgentPill() {
  const pill = document.getElementById('jvAgentPill');
  if (pill) pill.textContent = window._currentAgent || 'orchestrator';
}

function jarvisStartClock() {
  const tick = () => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const t = document.getElementById('jvTime'), dt = document.getElementById('jvDate');
    if (t) t.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    if (dt) dt.textContent = d.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  };
  tick();
  if (_jarvis.clockTimer) clearInterval(_jarvis.clockTimer);
  _jarvis.clockTimer = setInterval(tick, 1000);
}

// Vitals are REAL Sentinel metrics, not faked CPU gauges: engine
// reachability, live subprocess sessions, queued tasks, working agents.
async function jarvisRefreshVitals() {
  const box = document.getElementById('jvVitals');
  if (!box) return;
  try {
    const [health, sessions, runtime] = await Promise.all([
      api.getAgentHealth().catch(() => ({ providers: [], agents: [] })),
      api.getActiveSessions().catch(() => ({ sessions: [] })),
      api.getAgentsRuntime().catch(() => ({ runtime: {} })),
    ]);
    const provs = health.providers || [];
    const online = provs.filter(p => p.status === 'online').length;
    const engPct = provs.length ? (online / provs.length) * 100 : 0;
    const rt = runtime.runtime || {};
    const working = Object.values(rt).filter(r => r.state === 'working').length;
    const queued = Object.values(rt).reduce((n, r) => n + (r.queued || 0), 0);
    const sessCount = (sessions.sessions || []).length;
    const agentCount = (health.agents || []).length || 1;
    box.innerHTML =
      jarvisVitalChip('ENG', `${online}/${provs.length}`, '', engPct, online === provs.length ? 'ok' : online ? 'warn' : 'crit') +
      jarvisVitalChip('RUN', sessCount, '', Math.min(100, sessCount * 25), sessCount ? 'warn' : 'ok') +
      jarvisVitalChip('QUE', queued, '', Math.min(100, queued * 10), queued ? 'warn' : 'ok') +
      jarvisVitalChip('AGT', working, '', Math.min(100, (working / agentCount) * 100), 'ok') +
      jarvisVitalChip('VOX', _jarvis.state === 'idle' ? 'RDY' : JV_STATUS[_jarvis.state].slice(0, 3), '', _jarvis.state === 'idle' ? 100 : 66, 'ok');
  } catch {}
}

function jarvisStartVitals() {
  jarvisRefreshVitals();
  if (_jarvis.vitalsTimer) clearInterval(_jarvis.vitalsTimer);
  _jarvis.vitalsTimer = setInterval(jarvisRefreshVitals, 5000);
}

function jarvisLog(who, text) {
  const log = document.getElementById('jvLog');
  if (!log) return;
  const line = document.createElement('div');
  line.className = `log-line log-${who}`;
  const tag = who === 'sys' ? 'SYS:' : who === 'you' ? 'You:' : 'Jarvis:';
  line.innerHTML = `<b>${tag}</b> ${escapeHtml(text)}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function jarvisSetState(state) {
  _jarvis.state = state;
  const r = document.getElementById('jvReactor');
  if (r) r.className = `reactor ${state}${state !== 'idle' ? ' active' : ''}`;
  const chip = document.getElementById('jvStatusChip');
  if (chip) { chip.className = `jv-status ${state}`; chip.querySelector('.label').textContent = JV_STATUS[state]; }
  const wave = document.getElementById('jvWave');
  if (wave) wave.classList.toggle('active', state !== 'idle');
  const mic = document.getElementById('jvMicBtn'), lbl = document.getElementById('jvMicLabel');
  if (mic) mic.classList.toggle('listening', state === 'listening');
  if (lbl) lbl.textContent = { idle: 'Tap to speak', listening: 'Listening… (tap to stop)', thinking: 'Working…', speaking: 'Speaking… (tap to stop)' }[state];
}

function jarvisSetLang() {
  _jarvis.lang = document.getElementById('jvLang').value;
}

function jarvisToggleSTT() {
  if (!document.getElementById('jvSTT').checked && _jarvis.state === 'listening') jarvisStopAll();
}

function jarvisFullscreen() {
  const el = document.getElementById('jarvisView');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

function jarvisSubmitCmd() {
  const input = document.getElementById('jvCmd');
  const text = (input.value || '').trim();
  if (!text) return;
  input.value = '';
  jarvisAsk(text);
}

function jarvisOrbTap() {
  if (_jarvis.state === 'listening') { jarvisStopAll(); return; }
  if (_jarvis.state === 'speaking') { jarvisStopSpeaking(); return; }
  if (_jarvis.state === 'thinking') return;
  jarvisListen();
}

function jarvisListen() {
  const sttOn = document.getElementById('jvSTT');
  if (sttOn && !sttOn.checked) { jarvisLog('sys', 'Speech-to-text is off — type a command instead.'); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { jarvisLog('sys', 'Voice input is not supported in this browser — use Chrome or Edge.'); return; }
  const rec = new SR();
  _jarvis.rec = rec;
  rec.lang = _jarvis.lang;
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  jarvisSetState('listening');
  rec.onresult = (e) => {
    finalText = '';
    let interim = '';
    for (const res of e.results) {
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    const chip = document.getElementById('jvStatusChip');
    if (chip) chip.querySelector('.label').textContent = (finalText + interim).trim().slice(0, 32).toUpperCase() || 'LISTENING';
  };
  rec.onerror = (e) => {
    jarvisSetState('idle');
    if (e.error === 'not-allowed') jarvisLog('sys', 'Microphone access denied — allow it in the browser and retry.');
    else if (e.error === 'no-speech') jarvisLog('sys', 'Heard nothing — tap to try again.');
    else jarvisLog('sys', 'Voice error: ' + e.error);
  };
  rec.onend = () => {
    if (_jarvis.state !== 'listening') return;
    const text = finalText.trim();
    if (text) jarvisAsk(text);
    else { jarvisSetState('idle'); jarvisLog('sys', 'Heard nothing — tap to try again.'); }
  };
  try { rec.start(); } catch { /* double-start race */ }
}

async function jarvisAsk(message) {
  const agent = window._currentAgent || 'orchestrator';
  jarvisSyncAgentPill();
  jarvisLog('you', message);
  addChatMessage('user', message, agent);   // shared history with chat mode
  jarvisSetState('thinking');
  let reply;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), agent === 'orchestrator' ? 360000 : 200000);
    if (agent === 'orchestrator') {
      const r = await api.orchestrate(message, controller);
      reply = r.summary;
      if (typeof updateInboxBadge === 'function') updateInboxBadge();
    } else {
      const r = await api.chat(agent, message, controller);
      reply = r.response.content;
    }
    clearTimeout(timeoutId);
  } catch (err) {
    reply = err.name === 'AbortError' ? 'The request timed out.' : 'Error: ' + err.message;
  }
  addChatMessage('assistant', reply, agent);
  jarvisLog('jarvis', reply);
  jarvisSpeak(reply);
}

// Markdown → speakable text: code blocks summarized, syntax stripped.
function jarvisSpeakable(text) {
  return (text || '')
    .replace(/```[\s\S]*?```/g, ' — code omitted — ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jarvisSpeak(text) {
  const ttsOn = document.getElementById('jvTTS');
  const speakText = jarvisSpeakable(text);
  if ((ttsOn && !ttsOn.checked) || !('speechSynthesis' in window) || !speakText) {
    jarvisAfterReply();
    return;
  }
  speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(speakText.slice(0, 1200));
  utt.lang = _jarvis.lang;
  const voice = speechSynthesis.getVoices().find(v => v.lang.startsWith(_jarvis.lang.split('-')[0]));
  if (voice) utt.voice = voice;
  utt.onend = jarvisAfterReply;
  utt.onerror = jarvisAfterReply;
  jarvisSetState('speaking');
  speechSynthesis.speak(utt);
}

function jarvisAfterReply() {
  if (_jarvis.mode !== 'jarvis') return;
  const auto = document.getElementById('jvAuto');
  const sttOn = document.getElementById('jvSTT');
  if (auto && auto.checked && sttOn && sttOn.checked &&
      (('SpeechRecognition' in window) || ('webkitSpeechRecognition' in window))) {
    jarvisListen();
  } else {
    jarvisSetState('idle');
  }
}

function jarvisStopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (_jarvis.state === 'speaking') jarvisSetState('idle');
}

function jarvisStopAll() {
  if (_jarvis.rec) { try { _jarvis.rec.abort(); } catch {} _jarvis.rec = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  jarvisSetState('idle');
}
