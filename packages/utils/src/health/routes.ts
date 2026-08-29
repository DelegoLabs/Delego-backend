/**
 * Health-check routes (Issue #76)
 *
 * Creates the standard health endpoints for any service that uses the shared
 * @delegolabs/utils HTTP server:
 *
 *   GET /health            — full aggregate health (backward compatible with the SDK)
 *   GET /health/live       — liveness probe (200 while the process is running)
 *   GET /health/ready      — readiness probe (503 when a critical dependency is down)
 *   GET /health/dashboard  — real-time HTML health dashboard
 *   GET /health/metrics    — Prometheus-format metrics
 *   GET /health/config     — effective HealthCheckConfig (dependency definitions)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, route, type Route } from "../http.js";
import type { HealthStatus } from "./types.js";
import type { HealthRegistry } from "./registry.js";
import { renderMetrics } from "./metrics.js";
import { renderDashboard } from "./dashboard.js";

export interface HealthRouteOptions {
  registry: HealthRegistry;
  serviceName: string;
  version?: string;
  /** Extra Prometheus text appended to GET /health/metrics (lock/business metrics). */
  extraMetrics?: () => string;
}

function aggregateToLegacy(status: HealthStatus): "ok" | "degraded" | "down" {
  if (status === "unhealthy") return "down";
  if (status === "degraded") return "degraded";
  return "ok";
}

function sendDashboard(res: ServerResponse, serviceName: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(renderDashboard(serviceName));
}

async function sendMetrics(
  res: ServerResponse,
  serviceName: string,
  version: string,
  registry: HealthRegistry,
  extraMetrics?: () => string,
): Promise<void> {
  const health = await registry.getServiceHealth(serviceName, version);
  res.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const extra = extraMetrics?.() ?? "";
  res.end(renderMetrics(health, registry.getMetrics()) + extra);
}

/**
 * Registers all standard health routes for a service.
 * Injected fetch/health functions keep the routes unit-testable.
 */
export function createHealthRoutes(options: HealthRouteOptions): Route[] {
  const { registry, serviceName, version = "0.0.1", extraMetrics } = options;

  return [
    route("GET", "/health/live", (_req: IncomingMessage, res: ServerResponse) => {
      json(res, 200, {
        data: {
          status: "ok",
          service: serviceName,
          version,
          timestamp: new Date().toISOString(),
          uptimeSeconds: registry.getUptimeSeconds(),
        },
        error: null,
      });
    }),

    route("GET", "/health/ready", async (_req: IncomingMessage, res: ServerResponse) => {
      const health = await registry.getServiceHealth(serviceName, version, { readiness: true });
      const ready = health.status !== "unhealthy";
      json(res, ready ? 200 : 503, {
        data: {
          ...health,
          // Keep the aggregated status readable for probes while exposing the
          // raw "unhealthy" only via the HTTP status code.
          status: aggregateToLegacy(health.status),
        },
        error: null,
      });
    }),

    route("GET", "/health", async (_req: IncomingMessage, res: ServerResponse) => {
      const health = await registry.getServiceHealth(serviceName, version);
      json(res, 200, {
        data: {
          ...health,
          status: aggregateToLegacy(health.status),
          timestamp: new Date().toISOString(),
        },
        error: null,
      });
    }),

    route("GET", "/health/config", (_req: IncomingMessage, res: ServerResponse) => {
      json(res, 200, { data: registry.getConfig(), error: null });
    }),

    route("GET", "/health/dashboard", (_req: IncomingMessage, res: ServerResponse) => {
      sendDashboard(res, serviceName);
    }),

    route("GET", "/health/metrics", async (_req: IncomingMessage, res: ServerResponse) => {
      await sendMetrics(res, serviceName, version, registry, extraMetrics);
    }),
  ];
}
