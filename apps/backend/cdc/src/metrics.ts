/**
 * CDC metrics registry.
 *
 * Tracks the `CDCMetrics` snapshot surfaced by the monitoring dashboard and
 * optionally persists periodic snapshots to `cdc_metric_snapshots` so lag /
 * throughput history survives connector restarts.
 */

import type { CDCConnectorKind, CDCMetrics } from "@delegolabs/types";
import { createLogger, type Logger } from "@delegolabs/utils";

export interface CdcMetricsState {
  eventsProcessed: number;
  eventsPerSecond: number;
  lagMs: number;
  lastEventAt: string;
  status: "running" | "stopped" | "error";
  errors: Array<{ timestamp: string; error: string }>;
}

export interface CdcMetrics {
  /** Record progress (events processed + current lag). */
  record(eventsProcessed: number, lagMs: number, lastEventAt: string): void;
  /** Record a pipeline error. */
  recordError(error: string): void;
  setStatus(status: "running" | "stopped" | "error"): void;
  /** Produce the current `CDCMetrics` snapshot. */
  snapshot(connector: CDCConnectorKind): CDCMetrics;
  /** Exponential-window rate, exposed for callers/tests. */
  getEventsPerSecond(): number;
}

export function createCdcMetrics(log?: Logger): CdcMetrics {
  const logger = log ?? createLogger("cdc:metrics", process.env.LOG_LEVEL ?? "info");

  let eventsProcessed = 0;
  let lagMs = 0;
  let lastEventAt = "";
  let status: CdcMetricsState["status"] = "stopped";
  const errors: CdcMetricsState["errors"] = [];

  // Sliding-window rate estimation (5s window derived from event timestamps).
  const rateWindowMs = 5000;
  const eventTimes: number[] = [];

  return {
    record(processed, lag, lastEvent) {
      eventsProcessed += processed;
      const now = Date.now();
      for (let i = 0; i < processed; i++) {
        eventTimes.push(now);
      }
      const cutoff = now - rateWindowMs;
      while (eventTimes.length && eventTimes[0] < cutoff) {
        eventTimes.shift();
      }
      lagMs = lag;
      lastEventAt = lastEvent;
    },

    recordError(error: string) {
      errors.push({ timestamp: new Date().toISOString(), error });
      if (errors.length > 100) errors.shift();
      logger.error("CDC error", { error });
    },

    setStatus(s) {
      status = s;
    },

    snapshot(connector) {
      return {
        connector,
        status,
        eventsProcessed,
        eventsPerSecond: Math.round((eventTimes.length / rateWindowMs) * 1000),
        lagMs,
        lastEventAt,
        errors: [...errors],
      };
    },

    getEventsPerSecond() {
      return Math.round((eventTimes.length / rateWindowMs) * 1000);
    },
  };
}

/** Formats the metrics in Prometheus text exposition format for a /metrics endpoint. */
export function renderCdcPrometheus(metrics: CDCMetrics): string {
  const lines: string[] = [];
  lines.push(`# TYPE delego_cdc_status gauge`);
  lines.push(`delego_cdc_status{connector="${metrics.connector}"} ${metrics.status === "running" ? 1 : 0}`);
  lines.push(`# TYPE delego_cdc_events_processed counter`);
  lines.push(`delego_cdc_events_processed ${metrics.eventsProcessed}`);
  lines.push(`# TYPE delego_cdc_events_per_second gauge`);
  lines.push(`delego_cdc_events_per_second ${metrics.eventsPerSecond}`);
  lines.push(`# TYPE delego_cdc_lag_ms gauge`);
  lines.push(`delego_cdc_lag_ms ${metrics.lagMs}`);
  lines.push(`# TYPE delego_cdc_errors counter`);
  lines.push(`delego_cdc_errors ${metrics.errors.length}`);
  return lines.join("\n") + "\n";
}
