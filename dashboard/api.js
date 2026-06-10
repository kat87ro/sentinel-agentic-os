// Shared response handler: surface 401 (auth expired) to the login gate.
async function _handle(r) {
  if (r.status === 401 && typeof window.onAuthExpired === 'function') window.onAuthExpired();
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `Request failed: ${r.status}`); }
  return r.json();
}

const api = {
  async get(path) {
    return _handle(await fetch(path, { credentials: 'include' }));
  },
  async post(path, body = {}, controller) {
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' };
    if (controller) opts.signal = controller.signal;
    return _handle(await fetch(path, opts));
  },
  async put(path, body = {}) {
    return _handle(await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' }));
  },
  async patch(path, body = {}) {
    return _handle(await fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' }));
  },
  async del(path) {
    return _handle(await fetch(path, { method: 'DELETE', credentials: 'include' }));
  },
  // Auth & users
  setup: (data) => api.post('/api/setup', data),
  factoryReset: (confirm, password) => api.post('/api/system/factory-reset', { confirm, password }),
  login: (username, password) => api.post('/api/auth/login', { username, password }),
  logout: () => api.post('/api/auth/logout', {}),
  getMe: () => api.get('/api/auth/me'),
  changePassword: (password) => api.put('/api/auth/password', { password }),
  getUsers: () => api.get('/api/users'),
  createUser: (data) => api.post('/api/users', data),
  updateUser: (id, data) => api.put(`/api/users/${encodeURIComponent(id)}`, data),
  deleteUser: (id) => api.del(`/api/users/${encodeURIComponent(id)}`),
  getStatus: () => api.get('/api/status'),
  getBrain: () => api.get('/api/brain'),
  getBrainFile: (name) => api.get(`/api/brain/${encodeURIComponent(name)}`),
  updateBrainFile: (name, content) => api.put(`/api/brain/${encodeURIComponent(name)}`, { content }),
  getSkills: () => api.get('/api/skills'),
  createSkill: (data) => api.post('/api/skills', data),
  getSkill: (name) => api.get(`/api/skills/${encodeURIComponent(name)}`),
  updateSkill: (name, content) => api.put(`/api/skills/${encodeURIComponent(name)}`, { content }),
  toggleSkill: (name) => api.post(`/api/skills/${encodeURIComponent(name)}/toggle`, {}),
  deleteSkill: (name) => api.del(`/api/skills/${encodeURIComponent(name)}`),
  runSkill: (name, input = '', agent = 'auto') => api.post(`/api/skills/${encodeURIComponent(name)}/run`, { input, agent }),
  getSkillEval: (name) => api.get(`/api/skills/${encodeURIComponent(name)}/eval`),
  getJobs: () => api.get('/api/scheduler/jobs'),
  createJob: (job) => api.post('/api/scheduler/jobs', job),
  updateJob: (id, data) => api.put(`/api/scheduler/jobs/${encodeURIComponent(id)}`, data),
  toggleJob: (id) => api.post(`/api/scheduler/jobs/${encodeURIComponent(id)}/toggle`, {}),
  runJobNow: (id) => api.post(`/api/scheduler/jobs/${encodeURIComponent(id)}/run`, {}),
  deleteJob: (id) => api.del(`/api/scheduler/jobs/${encodeURIComponent(id)}`),
  getAudit: (limit = 100) => api.get(`/api/audit?limit=${limit}`),
  getCost: () => api.get('/api/cost'),
  getPlugins: () => api.get('/api/plugins'),
  getPluginCatalog: () => api.get('/api/plugins/catalog'),
  installPlugin: (data) => api.post('/api/plugins/install', data),
  configurePlugin: (id, config) => api.put(`/api/plugins/${encodeURIComponent(id)}/config`, { config }),
  togglePlugin: (id) => api.post(`/api/plugins/${encodeURIComponent(id)}/toggle`, {}),
  uninstallPlugin: (id) => api.del(`/api/plugins/${encodeURIComponent(id)}`),
  getBackups: () => api.get('/api/backups'),
  createBackup: (data = {}) => api.post('/api/backup', data),
  restoreBackup: (file) => api.post('/api/backup/restore', { file }),
  deleteBackup: (name) => api.del(`/api/backups/${encodeURIComponent(name)}`),
  getBackupSchedule: () => api.get('/api/backup/schedule'),
  setBackupSchedule: (data) => api.put('/api/backup/schedule', data),
  getPrompts: () => api.get('/api/prompts'),
  getSettings: () => api.get('/api/settings'),
  updateSettings: (settings) => api.put('/api/settings', { settings }),
  getStandards: () => api.get('/api/standards'),
  discoverStandards: () => api.post('/api/standards/discover'),
  chat: (agent, message, controller) => api.post('/api/chat', { agent, message }, controller),
  orchestrate: (message, controller) => api.post('/api/orchestrate', { message }, controller),
  getChatHistory: () => api.get('/api/chat/history'),
  // Kanban
  getKanbanBoard: (status) => api.get(status ? `/api/kanban/board?status=${encodeURIComponent(status)}` : '/api/kanban/board'),
  getKanbanTask: (id) => api.get(`/api/kanban/tasks/${encodeURIComponent(id)}`),
  createKanbanTask: (data) => api.post('/api/kanban/tasks', data),
  updateKanbanTask: (id, data) => api.patch(`/api/kanban/tasks/${encodeURIComponent(id)}`, data),
  deleteKanbanTask: (id) => api.del(`/api/kanban/tasks/${encodeURIComponent(id)}`),
  assignKanbanAgent: (id, agentId, wake = true) => api.post(`/api/kanban/tasks/${encodeURIComponent(id)}/assign-agent`, { agent_id: agentId, wake }),
  completeKanbanTask: (id, summary) => api.post(`/api/kanban/tasks/${encodeURIComponent(id)}/complete`, { summary }),
  blockKanbanTask: (id, reason) => api.post(`/api/kanban/tasks/${encodeURIComponent(id)}/block`, { reason }),
  unblockKanbanTask: (id) => api.post(`/api/kanban/tasks/${encodeURIComponent(id)}/unblock`, {}),
  addKanbanComment: (id, message) => api.post(`/api/kanban/tasks/${encodeURIComponent(id)}/comments`, { message }),
  linkKanbanTasks: (parentId, childId) => api.post('/api/kanban/links', { parent_id: parentId, child_id: childId }),
  unlinkKanbanTasks: (parentId, childId) => api.del(`/api/kanban/links?parent_id=${encodeURIComponent(parentId)}&child_id=${encodeURIComponent(childId)}`),
  dispatchKanban: () => api.post('/api/kanban/dispatch', {}),
  specifyKanbanTask: (id) => api.post(`/api/kanban/tasks/${encodeURIComponent(id)}/specify`, {}),
  decomposeKanbanTask: (id) => api.post(`/api/kanban/tasks/${encodeURIComponent(id)}/decompose`, {}),
  // Goals
  getGoals: (projectId) => api.get('/api/goals' + (projectId ? `?project_id=${encodeURIComponent(projectId)}` : '')),
  createGoal: (data) => api.post('/api/goals', data),
  updateGoal: (id, data) => api.put(`/api/goals/${encodeURIComponent(id)}`, data),
  deleteGoal: (id) => api.del(`/api/goals/${encodeURIComponent(id)}`),
  // Journal
  getJournalEntries: () => api.get('/api/journal/entries'),
  getJournalEntry: (date) => api.get(`/api/journal/entries/${encodeURIComponent(date)}`),
  saveJournalEntry: (date, content) => api.put(`/api/journal/entries/${encodeURIComponent(date)}`, { content }),
  searchJournal: (query) => api.get(`/api/journal/search?q=${encodeURIComponent(query)}`),
  // Agent Health
  getAgentHealth: () => api.get('/api/agents/health'),
  wakeAgent: (id) => api.post(`/api/agents/${encodeURIComponent(id)}/wake`, {}),
  // Smart Router
  suggestRouter: (task) => api.post('/api/router/suggest', { task }),
  routeTask: (data) => api.post('/api/router/route', data),
  // Learning Analytics + self-learning
  getSkillAnalytics: () => api.get('/api/analytics/skills'),
  getTrendAnalytics: () => api.get('/api/analytics/trends'),
  getLearningAgents: () => api.get('/api/learning/agents'),
  toggleLearning: () => api.post('/api/learning/toggle', {}),
  // Custom Agents (dynamic registry)
  getCustomAgents: () => api.get('/api/custom-agents'),
  getAgentsUsage: () => api.get('/api/custom-agents/usage'),
  createCustomAgent: (data) => api.post('/api/custom-agents', data),
  updateCustomAgent: (id, data) => api.put(`/api/custom-agents/${encodeURIComponent(id)}`, data),
  deleteCustomAgent: (id) => api.del(`/api/custom-agents/${encodeURIComponent(id)}`),
  // Teams (hierarchy)
  getTeams: () => api.get('/api/teams'),
  createTeam: (data) => api.post('/api/teams', data),
  updateTeam: (id, data) => api.put(`/api/teams/${encodeURIComponent(id)}`, data),
  deleteTeam: (id) => api.del(`/api/teams/${encodeURIComponent(id)}`),
  // Inbox (agents waiting for a human reply)
  getInbox: () => api.get('/api/inbox'),
  getInboxCount: () => api.get('/api/inbox/count'),
  replyInbox: (id, message) => api.post(`/api/inbox/${encodeURIComponent(id)}/reply`, { message }),
  dismissInbox: (id) => api.del(`/api/inbox/${encodeURIComponent(id)}`),
  // Projects (folder + goal + team + scoped chat)
  getProjects: () => api.get('/api/projects'),
  createProject: (data) => api.post('/api/projects', data),
  updateProject: (id, data) => api.put(`/api/projects/${encodeURIComponent(id)}`, data),
  deleteProject: (id) => api.del(`/api/projects/${encodeURIComponent(id)}`),
  getProjectChat: (id) => api.get(`/api/projects/${encodeURIComponent(id)}/chat`),
  sendProjectChat: (id, message, agentId) => api.post(`/api/projects/${encodeURIComponent(id)}/chat`, { message, agent_id: agentId || null }),
  startProject: (id) => api.post(`/api/projects/${encodeURIComponent(id)}/start`, {}),
  // Agent task queue + heartbeat runtime
  getAgentTasks: (params = '') => api.get('/api/agent-tasks' + (params ? '?' + params : '')),
  createAgentTask: (data) => api.post('/api/agent-tasks', data),
  cancelAgentTask: (id) => api.del(`/api/agent-tasks/${encodeURIComponent(id)}`),
  getAgentsRuntime: () => api.get('/api/agents/runtime'),
  getMetricsOverview: (days = 14) => api.get(`/api/metrics/overview?days=${days}`),
  // Active sessions (live subprocess monitor + kill switch)
  getActiveSessions: () => api.get('/api/sessions/active'),
  killSession: (id) => api.post(`/api/sessions/${encodeURIComponent(id)}/kill`, {}),
  releaseTask: (id) => api.post(`/api/agent-tasks/${encodeURIComponent(id)}/release`, {}),
  // Filesystem browse (project folder picker)
  browseDirs: (path) => api.get(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  pickFolder: () => api.post('/api/fs/pick-folder', {}),
  // Task dispatch
  dispatchTask: (data) => api.post('/api/tasks', data),
  // MCP servers
  getMcpServers: () => api.get('/api/mcp/servers'),
  createMcpServer: (data) => api.post('/api/mcp/servers', data),
  updateMcpServer: (id, data) => api.put(`/api/mcp/servers/${encodeURIComponent(id)}`, data),
  deleteMcpServer: (id) => api.del(`/api/mcp/servers/${encodeURIComponent(id)}`),
  toggleMcpServer: (id) => api.post(`/api/mcp/servers/${encodeURIComponent(id)}/toggle`, {}),
  // Claude global mirroring
  syncClaude: () => api.post('/api/sync/claude', {}),
  mirrorAgents: () => api.post('/api/custom-agents/mirror', {}),
  mirrorSkills: () => api.post('/api/skills/mirror', {}),
  mirrorMcp: () => api.post('/api/mcp/mirror', {}),
  getSyncStatus: () => api.get('/api/sync/status'),
  // Providers (CLI / API mode + secrets + custom registry)
  getProviders: () => api.get('/api/providers'),
  getProviderCatalog: () => api.get('/api/providers/catalog'),
  createProvider: (data) => api.post('/api/providers', data),
  updateProvider: (name, data) => api.put(`/api/providers/${encodeURIComponent(name)}`, data),
  deleteProvider: (name) => api.del(`/api/providers/${encodeURIComponent(name)}`),
  toggleProvider: (name) => api.post(`/api/providers/${encodeURIComponent(name)}/toggle`, {}),
  setProviderSecret: (name, value) => api.post(`/api/providers/${encodeURIComponent(name)}/secret`, { value }),
  testProvider: (name) => api.post(`/api/providers/${encodeURIComponent(name)}/test`, {}),
  getProviderModels: (name) => api.get(`/api/providers/${encodeURIComponent(name)}/models`),
  // Memory Vault (Obsidian-compatible)
  getMemoryOverview: () => api.get('/api/memory/overview'),
  getMemoryFile: (path) => api.get(`/api/memory/file?path=${encodeURIComponent(path)}`),
  updateMemoryFile: (path, content) => api.put(`/api/memory/file?path=${encodeURIComponent(path)}`, { content }),
  getMemoryPreview: (agentId, task, projectId) => api.get(`/api/memory/preview?agent_id=${encodeURIComponent(agentId)}&task=${encodeURIComponent(task || '')}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}`),
  getMemoryGraph: () => api.get('/api/memory/graph'),
  getMemoryNote: (name) => api.get(`/api/memory/note/${encodeURIComponent(name)}`),
  searchMemory: (q) => api.get(`/api/memory/search?q=${encodeURIComponent(q)}`),
  getMemoryConfig: () => api.get('/api/memory/config'),
  setMemoryConfig: (data) => api.put('/api/memory/config', data),
  // Spec-named aliases
  fetchCustomAgents: () => api.get('/api/custom-agents'),
  saveCustomAgent: (data) => api.post('/api/custom-agents', data),
  fetchTeams: () => api.get('/api/teams'),
  saveTeam: (data) => api.post('/api/teams', data),
};
