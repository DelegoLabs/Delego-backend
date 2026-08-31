/**
 * CDC HTTP routes.
 *
 * These are served alongside the standard `/health*` routes by `startHttpServer`.
 * The dashboard and metrics endpoints satisfy the monitoring acceptance
 * criteria; the pause/resume endpoints support failover testing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, route, type Route, type RouteHandler } from "@delegolabs/utils";
import type { CDCConfig } from "@delegolabs/types";
import type { CdcMetrics } from "./metrics.js";
import { renderCdcPrometheus } from "./metrics.js";
import { renderCdcDashboard } from "./dashboard.js";

export interface CdcRoutesDeps {
  config: CDCConfig;
  metrics: CdcMetrics;
  getPositionLsn: () => { latestLsn: string; lagMs: number };
  onPause?: () => Promise<void>;
  onResume?: () => Promise<void>;
}

export function registerCdcRoutes(deps: CdcRoutesDeps): Route[] {
  const { metrics } = deps;

  const metricsHandler: RouteHandler = async (_req: IncomingMessage, res: ServerResponse) => {
    json(res, 200, { data: metrics.snapshot(deps.config.connector), error: null });
  };

  const dashboardHandler: RouteHandler = async (_req: IncomingMessage, res: ServerResponse) => {
    const snapshot = metrics.snapshot(deps.config.connector);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderCdcDashboard(snapshot));
  };

  const prometheusHandler: RouteHandler = async (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderCdcPrometheus(metrics.snapshot(deps.config.connector)));
  };

  const configHandler: RouteHandler = async (_req: IncomingMessage, res: ServerResponse) => {
    json(res, 200, {
      data: {
        connector: deps.config.connector,
        database: { ...deps.config.database, password: "***" },
        tables: deps.config.tables.map((t) => ({ ...t })),
        publication: deps.config.publication,
        slotName: deps.config.slotName,
      },
      error: null,
    });
  };

  const positionHandler: RouteHandler = async (_req: IncomingMessage, res: ServerResponse) => {
    json(res, 200, { data: deps.getPositionLsn(), error: null });
  };

  const pauseHandler: RouteHandler = async (_req: IncomingMessage, res: ServerResponse) => {
    if (deps.onPause) await deps.onPause();
    json(res, 200, { data: { status: "paused" }, error: null });
  };

  const resumeHandler: RouteHandler = async (_req: IncomingMessage, res: ServerResponse) => {
    if (deps.onResume) await deps.onResume();
    json(res, 200, { data: { status: "running" }, error: null });
  };

  return [
    route("GET", "/api/v1/cdc/metrics", metricsHandler),
    route("GET", "/api/v1/cdc/config", configHandler),
    route("GET", "/api/v1/cdc/position", positionHandler),
    route("GET", "/api/v1/cdc/dashboard", dashboardHandler),
    route("GET", "/metrics", prometheusHandler),
    route("POST", "/api/v1/cdc/pause", pauseHandler),
    route("POST", "/api/v1/cdc/resume", resumeHandler),
  ];
}
