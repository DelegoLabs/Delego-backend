/**
 * Gateway health endpoints (Issue #76)
 *
 * Serves the standard health surface backed by the gateway HealthRegistry:
 *   GET /health            — full aggregate (backward compatible with the SDK)
 *   GET /health/live       — liveness probe (200 while the process is running)
 *   GET /health/ready      — readiness probe (503 when a critical dependency is down)
 *   GET /health/config     — dependency graph definition
 *   GET /health/dashboard  — real-time HTML dashboard
 *   GET /health/metrics    — Prometheus-format metrics
 */

import { createHealthRoutes, json, type Route, type RouteHandler } from "@delegolabs/utils";
import { createGatewayHealthRegistry } from "../src/health.js";

export const gatewayHealthRegistry = createGatewayHealthRegistry();

export function registerHealthRoutes(): Route[] {
  return createHealthRoutes({
    registry: gatewayHealthRegistry,
    serviceName: "gateway",
    version: "0.0.1",
  });
}

/**
 * Backward-compatible health handler matching the original /health contract
 * (always 200, legacy `dependencies` array with postgresql + redis). Kept so
 * existing consumers and the legacy unit suite continue to work; new consumers
 * should use the `/health`, `/health/live`, `/health/ready`, `/health/dashboard`
 * and `/health/metrics` routes.
 */
export const healthHandler: RouteHandler = async (_req, res) => {
  const health = await gatewayHealthRegistry.getServiceHealth("gateway", "0.0.1");

  const dependencies = health.checks
    .filter((c) => c.name === "postgresql" || c.name === "redis")
    .map((c) => ({
      name: c.name,
      status: c.status === "healthy" ? "ok" : "degraded",
      latencyMs: Math.floor(c.latencyMs),
    }));

  json(res, 200, {
    data: {
      status: health.status === "healthy" ? "ok" : "degraded",
      service: "gateway",
      version: "0.0.1",
      timestamp: new Date().toISOString(),
      dependencies,
    },
    error: null,
  });
};
