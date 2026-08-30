/**
 * Prometheus-format metrics exporter for health checks (Issue #76).
 */

import type { HealthCheckConfig, HealthMetrics, ServiceHealth } from "./types.js";

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function metricName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:]/g, "_");
}

const STATUS_VALUE: Record<string, number> = {
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
};

/** Renders health state in Prometheus text exposition format. */
export function renderMetrics(
  health: ServiceHealth,
  metrics: HealthMetrics[],
): string {
  const lines: string[] = [];
  const service = escapeLabel(health.service);
  const base = metricName(health.service);

  lines.push(`# HELP ${base}_uptime_seconds Service uptime in seconds.`);
  lines.push(`# TYPE ${base}_uptime_seconds gauge`);
  lines.push(`${base}_uptime_seconds{service="${service}"} ${health.uptimeSeconds}`);

  lines.push(`# HELP ${base}_health_status Overall service health status (0=healthy, 1=degraded, 2=unhealthy).`);
  lines.push(`# TYPE ${base}_health_status gauge`);
  lines.push(`${base}_health_status{service="${service}"} ${STATUS_VALUE[health.status] ?? 2}`);

  for (const metric of metrics) {
    const name = metricName(metric.name);
    const labels = `{service="${service}",check="${escapeLabel(metric.name)}"}`;

    lines.push(`# HELP ${base}_health_check_status Health status of the ${name} dependency (0=healthy, 1=degraded, 2=unhealthy).`);
    lines.push(`# TYPE ${base}_health_check_status gauge`);
    lines.push(`${base}_health_check_status${labels} ${STATUS_VALUE[metric.status] ?? 2}`);

    lines.push(`# HELP ${base}_health_check_latency_ms Last observed latency of the ${name} check in milliseconds.`);
    lines.push(`# TYPE ${base}_health_check_latency_ms gauge`);
    lines.push(`${base}_health_check_latency_ms${labels} ${metric.lastLatencyMs}`);

    lines.push(`# HELP ${base}_health_checks_total Total number of health checks performed for ${name}.`);
    lines.push(`# TYPE ${base}_health_checks_total counter`);
    lines.push(`${base}_health_checks_total${labels} ${metric.total}`);

    lines.push(`# HELP ${base}_health_check_consecutive_failures Consecutive failures for the ${name} check.`);
    lines.push(`# TYPE ${base}_health_check_consecutive_failures gauge`);
    lines.push(`${base}_health_check_consecutive_failures${labels} ${metric.consecutiveFailures}`);
  }

  lines.push("");
  return lines.join("\n");
}

/** Exposes the configured dependency graph as a metric for discoverability. */
export function renderDependencyConfig(config: HealthCheckConfig): string {
  const lines: string[] = [];
  lines.push("# HELP delego_health_dependency_info Static dependency graph configuration.");
  lines.push("# TYPE delego_health_dependency_info gauge");
  for (const dep of config.dependencies) {
    lines.push(
      `delego_health_dependency_info{name="${escapeLabel(dep.name)}",type="${escapeLabel(dep.type)}",critical="${String(dep.critical)}"} 1`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
