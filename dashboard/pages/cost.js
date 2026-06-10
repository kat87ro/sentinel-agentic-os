async function renderCost() {
  const content = document.getElementById('pageContent');
  content.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">Cost Analytics</h1>
        <p class="page-subtitle">Real spend across agents — from the live usage ledger</p>
      </div>
      <button class="btn btn-ghost" onclick="renderCost()">${icon('refresh', 13)} Refresh</button>
    </div>
    <div class="grid grid-3 mb-4" id="costStats"></div>
    <div class="grid grid-2">
      <div class="card">
        <div class="card-header"><span class="card-title">Usage by Agent</span></div>
        <div class="chart-container"><canvas id="agentChart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">Usage Over Time</span></div>
        <div class="chart-container"><canvas id="timeChart"></canvas></div>
      </div>
    </div>
    <div class="card mt-3">
      <div class="card-header"><span class="card-title">Recent Cost Entries</span></div>
      <div id="costEntries"><div class="loading"><div class="loading-spinner"></div></div></div>
    </div>
  `;

  try {
    const data = await api.getCost();
    const entries = data.entries || [];
    const totals = data.daily_totals || {};
    const alerts = data.free_tier_alerts || [];

    const totalCost = entries.reduce((s, e) => s + (e.cost || 0), 0);
    const totalTokens = entries.reduce((s, e) => s + (e.tokens || 0), 0);
    const days = Object.keys(totals).length;

    document.getElementById('costStats').innerHTML = `
      <div class="card stat-card"><div class="stat-icon purple">${icon('dollar', 18)}</div><div class="stat-value">$${totalCost.toFixed(4)}</div><div class="stat-label">Total Cost</div></div>
      <div class="card stat-card"><div class="stat-icon blue">${icon('type', 18)}</div><div class="stat-value">${totalTokens.toLocaleString()}</div><div class="stat-label">Total Tokens</div></div>
      <div class="card stat-card"><div class="stat-icon ${alerts.length > 0 ? 'red' : 'green'}">${alerts.length > 0 ? icon('alert', 18) : icon('check', 18)}</div><div class="stat-value">${alerts.length}</div><div class="stat-label">Free Tier Alerts</div></div>
    `;

    const entriesContainer = document.getElementById('costEntries');
    if (entries.length === 0) {
      entriesContainer.innerHTML = `<div class="empty-state" style="padding:20px"><div class="empty-state-icon">${icon('bar-chart', 32)}</div><div class="empty-state-title">No cost data yet</div></div>`;
    } else {
      entriesContainer.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Time</th><th>Agent</th><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead>
            <tbody>
              ${entries.slice(-20).reverse().map(e => `
                <tr>
                  <td style="font-size:12px">${formatDate(e.timestamp)}</td>
                  <td><span class="badge badge-accent">${e.agent}</span></td>
                  <td style="font-size:12px">${e.model}</td>
                  <td>${(e.tokens || 0).toLocaleString()}</td>
                  <td><span class="badge ${(e.cost || 0) > 0 ? 'badge-warning' : 'badge-success'}">$${(e.cost || 0).toFixed(6)}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    if (alerts.length > 0) {
      const header = document.querySelector('.page-header');
      header.insertAdjacentHTML('afterend', `
        <div class="card mb-3" style="border-color:var(--yellow)">
          <div class="flex items-center gap-2">
            <span>${icon('alert', 18)}</span>
            <div>
              <strong style="font-size:13px">Free Tier Alerts</strong>
              ${alerts.map(a => `<div style="font-size:12px;color:var(--text-muted)">${escapeHtml(a)}</div>`).join('')}
            </div>
          </div>
        </div>
      `);
    }

    // Build agent chart
    const agentTotals = {};
    entries.forEach(e => {
      const a = e.agent || 'unknown';
      agentTotals[a] = (agentTotals[a] || 0) + (e.tokens || 0);
    });
    const agentLabels = Object.keys(agentTotals);
    const agentData = Object.values(agentTotals);

    if (entries.length > 0) {
      new Chart(document.getElementById('agentChart'), {
        type: 'doughnut',
        data: { labels: agentLabels, datasets: [{ data: agentData, backgroundColor: ['rgba(108,92,231,0.8)', 'rgba(0,212,170,0.8)', 'rgba(69,170,242,0.8)', 'rgba(255,165,2,0.8)'] }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim(), font: { size: 11 } } } } }
      });

      const timeTotals = {};
      entries.forEach(e => {
        const day = e.timestamp ? e.timestamp.slice(0, 10) : 'unknown';
        timeTotals[day] = (timeTotals[day] || 0) + (e.tokens || 0);
      });
      const timeLabels = Object.keys(timeTotals).sort();
      const timeData = timeLabels.map(d => timeTotals[d]);

      new Chart(document.getElementById('timeChart'), {
        type: 'line',
        data: { labels: timeLabels, datasets: [{ label: 'Tokens', data: timeData, borderColor: 'rgba(108,92,231,0.8)', backgroundColor: 'rgba(108,92,231,0.1)', fill: true, tension: 0.4, pointRadius: 3 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim(), font: { size: 10 } } }, y: { ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim(), font: { size: 10 } } } } }
      });
    }
  } catch (err) {
    document.getElementById('costStats').innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty-state"><div class="empty-state-icon">${icon('alert', 32)}</div><div class="empty-state-title">${escapeHtml(err.message)}</div></div></div>`;
  }
}

