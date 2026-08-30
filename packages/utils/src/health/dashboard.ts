/**
 * Real-time health dashboard (Issue #76)
 *
 * A self-contained HTML page that polls the service's own `/health` endpoint
 * and renders a live view of every dependency. No external assets are required
 * so it works behind firewalls and on air-gapped Kubernetes clusters.
 */

export function renderDashboard(serviceName: string): string {
  const esc = serviceName.replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc} — Health Dashboard</title>
<style>
  :root { --ok:#16a34a; --degraded:#d97706; --down:#dc2626; --muted:#6b7280; --bg:#0f172a; --card:#1e293b; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color:#e2e8f0; padding:24px; }
  header { display:flex; align-items:center; gap:16px; margin-bottom:20px; flex-wrap:wrap; }
  h1 { font-size:1.4rem; margin:0; }
  .badge { padding:6px 14px; border-radius:999px; font-weight:600; font-size:.85rem; }
  .badge.healthy { background:color-mix(in srgb, var(--ok) 20%, transparent); color:var(--ok); }
  .badge.degraded { background:color-mix(in srgb, var(--degraded) 20%, transparent); color:var(--degraded); }
  .badge.unhealthy { background:color-mix(in srgb, var(--down) 20%, transparent); color:var(--down); }
  .meta { color:var(--muted); font-size:.8rem; margin-left:auto; }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:12px; }
  .card { background:var(--card); border-radius:12px; padding:16px; border-left:4px solid var(--muted); }
  .card.healthy { border-left-color:var(--ok); }
  .card.degraded { border-left-color:var(--degraded); }
  .card.unhealthy { border-left-color:var(--down); }
  .card h3 { margin:0 0 8px; font-size:1rem; display:flex; justify-content:space-between; gap:8px; }
  .card .status { font-size:.78rem; text-transform:uppercase; letter-spacing:.05em; }
  .card .status.healthy { color:var(--ok); }
  .card .status.degraded { color:var(--degraded); }
  .card .status.unhealthy { color:var(--down); }
  .detail { font-size:.8rem; color:var(--muted); }
  .bar { height:6px; border-radius:3px; background:#334155; margin-top:12px; overflow:hidden; }
  .bar > div { height:100%; background:var(--ok); }
  footer { margin-top:20px; color:var(--muted); font-size:.75rem; }
</style>
</head>
<body>
  <header>
    <h1>${esc} — Health Dashboard</h1>
    <span id="overall" class="badge healthy">checking…</span>
    <span class="meta" id="meta"></span>
  </header>
  <div class="grid" id="grid"></div>
  <footer id="footer"></footer>
  <script>
    const STATUS = { healthy: { color: "var(--ok)", label: "healthy" }, degraded: { color: "var(--degraded)", label: "degraded" }, unhealthy: { color: "var(--down)", label: "unhealthy" } };
    async function refresh() {
      try {
        const res = await fetch("/health", { cache: "no-store" });
        const body = await res.json();
        const data = body.data;
        const overall = document.getElementById("overall");
        const meta = document.getElementById("meta");
        const grid = document.getElementById("grid");
        const footer = document.getElementById("footer");

        overall.className = "badge " + (data.status === "ok" ? "healthy" : data.status);
        overall.textContent = data.status;
        meta.textContent = "version " + data.version + " · uptime " + data.uptimeSeconds + "s · " + new Date(data.timestamp).toLocaleTimeString();

        grid.innerHTML = "";
        for (const check of data.checks) {
          const card = document.createElement("div");
          card.className = "card " + check.status;
          const st = STATUS[check.status] || STATUS.unhealthy;
          const latency = Math.round(check.latencyMs) + "ms";
          let details = "";
          if (check.details && check.details.error) {
            details = '<div class="detail">' + escapeHtml(String(check.details.error)) + "</div>";
          }
          card.innerHTML =
            "<h3>" + escapeHtml(check.name) + "<span class='status " + check.status + "' style='color:" + st.color + "'>" + st.label + "</span></h3>" +
            '<div class="detail">latency ' + latency + " · checked " + new Date(check.checkedAt).toLocaleTimeString() + "</div>" +
            details +
            '<div class="bar"><div style="width:' + Math.min(100, check.latencyMs) + '%"></div></div>';
          grid.appendChild(card);
        }

        footer.textContent = "Auto-refreshing every 5s · " + new Date().toLocaleTimeString();
      } catch (err) {
        const overall = document.getElementById("overall");
        overall.className = "badge unhealthy";
        overall.textContent = "unreachable";
        const footer = document.getElementById("footer");
        footer.textContent = "Failed to load health: " + err.message;
      }
    }
    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
    }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}
