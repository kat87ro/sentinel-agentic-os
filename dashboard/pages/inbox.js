// Inbox — agents waiting for a human reply ([NEEDS_INPUT] loop).
// Replying re-dispatches the conversation to the same agent and closes the item.

async function renderInbox() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Inbox</div>
        <div class="page-subtitle">Agents waiting for your reply — answer to unblock them</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-ghost" onclick="renderInbox()">${icon('refresh', 13)} Refresh</button>
      </div>
    </div>
    <div id="inboxList"><div class="skeleton" style="height:80px"></div></div>
  `;
  try {
    const data = await api.getInbox();
    const items = data.items || [];
    const list = document.getElementById('inboxList');
    if (!list) return;
    if (items.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('check-circle', 32)}</div><div class="empty-state-title">All caught up</div><div class="empty-state-desc">No agent is waiting on you. Items appear here when an agent ends a reply with [NEEDS_INPUT].</div></div>`;
      return;
    }
    list.innerHTML = items.map(i => `
      <div class="card" style="margin-bottom:12px" id="inbox_${i.id}">
        <div class="flex items-center gap-2" style="margin-bottom:8px">
          <span class="dot warn"></span>
          <strong style="font-size:13px">${escapeHtml(i.agent_name)}</strong>
          <span class="mono text-xs" style="color:var(--text-faint)">${escapeHtml(i.source || 'task')}${i.project_id ? ' · project' : ''} · ${timeAgo(i.created)}</span>
          <button class="btn btn-sm btn-ghost" style="margin-left:auto;color:var(--crit)" onclick="dismissInboxUI('${i.id}')" title="Dismiss">${icon('trash', 13)}</button>
        </div>
        <div style="font-size:13.5px;font-weight:600;margin-bottom:6px">${escapeHtml(i.question)}</div>
        <details style="margin-bottom:10px">
          <summary class="text-muted text-xs" style="cursor:pointer">Original task & full agent reply</summary>
          <div class="text-muted text-sm" style="margin-top:6px"><strong>You asked:</strong> ${escapeHtml(i.message || '')}</div>
          <pre style="margin-top:6px;max-height:200px;overflow:auto;white-space:pre-wrap">${escapeHtml(i.result || '')}</pre>
        </details>
        <div class="quick-run">
          <input class="form-input" id="reply_${i.id}" placeholder="Type your answer…"
            onkeydown="if(event.key==='Enter')replyInboxUI('${i.id}')">
          <button class="btn btn-primary" onclick="replyInboxUI('${i.id}')">${icon('send', 13)} Reply</button>
        </div>
        <div id="replyResult_${i.id}"></div>
      </div>`).join('');
  } catch (err) {
    document.getElementById('inboxList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">Failed to load inbox</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
  }
}

async function replyInboxUI(id) {
  const input = document.getElementById(`reply_${id}`);
  const message = (input.value || '').trim();
  if (!message) { showToast('Type an answer first', 'warning'); return; }
  const out = document.getElementById(`replyResult_${id}`);
  out.innerHTML = `<div class="text-xs" style="margin-top:8px;color:var(--text-faint)">sending…</div>`;
  try {
    const r = await api.replyInbox(id, message);
    // The agent now runs in the BACKGROUND — don't block on it. The item leaves
    // the waiting queue; watch the linked task on the Kanban / project queue.
    showToast(`Answer sent — ${escapeHtml(r.agent?.name || 'the agent')} is continuing in the background`, 'success');
    updateInboxBadge();
    renderInbox();
  } catch (err) {
    out.innerHTML = `<div style="color:var(--crit);font-size:12.5px;margin-top:8px">${escapeHtml(err.message)}</div>`;
  }
}

async function dismissInboxUI(id) {
  if (!confirm('Dismiss this request without answering?')) return;
  try {
    await api.dismissInbox(id);
    showToast('Dismissed', 'info');
    updateInboxBadge();
    renderInbox();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
