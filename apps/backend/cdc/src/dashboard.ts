/**
 * CDC monitoring dashboard (HTML).
 *
 * Renders a self-contained status page showing the connector state, throughput,
 * WAL lag, and recent errors — the "Dashboard shows lag" acceptance criterion.
 * It is served at `/cdc/dashboard` and auto-refreshes from the `/api/v1/cdc/metrics`
 * endpoint.
 */

import type { CDCMetrics } from "@delegolabs/types";

export function renderCdcDashboard(metrics: CDCMetrics | null): string {
  const m = metrics ?? {
    connector: "logical_replication",
    status: "stopped",
    eventsProcessed: 0,
    eventsPerSecond: 0,
    lagMs: 0,
    lastEventAt: "",
    errors: [],
  };

  const statusColor = m.status === "running" ? "#16a34a" : m.status === "error" ? "#dc2626" : "#d97706";
  const errorRows = m.errors
    .map((e) => `<tr><td>${escapeHtml(e.timestamp)}</td><td>${escapeHtml(e.error)}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Delego CDC Dashboard</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  header { background:#0f172a; color:#fff; padding: 16px 24px; display:flex; justify-content:space-between; align-items:center; }
  header h1 { font-size: 18px; margin:0; }
  .wrap { max-width: 900px; margin: 24px auto; padding: 0 16px; }
  .cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:16px; }
  .card { background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:18px; }
  .card .label { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:#64748b; }
  .card .value { font-size:26px; font-weight:600; margin-top:6px; }
  .pill { display:inline-block; padding:2px 10px; border-radius:999px; color:#fff; font-weight:600; font-size:12px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; }
  th, td { text-align:left; padding:10px 14px; border-bottom:1px solid #eef2f7; font-size:13px; }
  th { background:#f1f5f9; }
  .section { margin-top: 24px; }
  .section h2 { font-size:15px; margin:0 0 10px; }
  .bar { height:8px; background:#e2e8f0; border-radius:999px; overflow:hidden; margin-top:8px; }
  .bar > div { height:100%; background:#16a34a; }
</style>
</head>
<body>
<header>
  <h1>Delego CDC Dashboard</h1>
  <span id="updated"></span>
</header>
<div class="wrap">
  <div class="cards">
    <div class="card"><div class="label">Connector</div><div class="value">${escapeHtml(m.connector)}</div></div>
    <div class="card"><div class="label">Status</div><div class="value"><span class="pill" style="background:${statusColor}">${escapeHtml(m.status)}</span></div></div>
    <div class="card"><div class="label">Events Processed</div><div class="value">${m.eventsProcessed.toLocaleString()}</div></div>
    <div class="card"><div class="label">Events / sec</div><div class="value">${m.eventsPerSecond.toLocaleString()}</div></div>
    <div class="card"><div class="label">WAL Lag (ms)</div><div class="value" id="lag">${m.lagMs.toLocaleString()}</div>
      <div class="bar"><div id="lagbar" style="width:${Math.min(100, (m.lagMs / 5000) * 100)}%"></div></div>
    </div>
    <div class="card"><div class="label">Last Event</div><div class="value" style="font-size:14px">${escapeHtml(m.lastEventAt || "—")}</div></div>
  </div>

  <div class="section">
    <h2>Recent Errors</h2>
    <table>
      <thead><tr><th>Timestamp</th><th>Error</th></tr></thead>
      <tbody>${errorRows || "<tr><td colspan='2'>No errors</td></tr>"}</tbody>
    </table>
  </div>
</div>
<script>
  async function refresh(){
    try {
      const res = await fetch('/api/v1/cdc/metrics');
      const body = await res.json();
      const m = body.data;
      document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
      // simple number refresh for lag
      document.getElementById('lag').textContent = (m.lagMs||0).toLocaleString();
      document.getElementById('lagbar').style.width = Math.min(100, ((m.lagMs||0)/5000)*100) + '%';
    } catch (e) { console.error(e); }
  }
  setInterval(refresh, 3000);
</script>
</body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
