/**
 * CDC pipeline — runs the capture → transform → publish → checkpoint loop.
 *
 * Responsibilities:
 *   - resume from the durable checkpoint on startup (failover/recovery),
 *   - poll the connector for batches and publish them exactly-once,
 *   - advance the checkpoint only after a batch is fully recorded + published,
 *   - expose live metrics + position to the monitoring dashboard,
 *   - support pause/resume and graceful shutdown.
 *
 * The poll loop is a single consumer per slot (logical replication delivers a
 * serial WAL stream), which preserves per-table ordering. Horizontal scale-out
 * is achieved by running one pipeline per slot.
 */

import { createLogger, type Logger } from "@delegolabs/utils";
import type { CDCConfig, CDCMetrics } from "@delegolabs/types";
import type { CDCConnector } from "./connector/types.js";
import type { CdcPublisher } from "./publisher.js";
import { advanceCheckpoint } from "./publisher.js";
import type { ReplicationStateStore } from "./store.js";
import type { CdcMetrics } from "./metrics.js";
import type { MessageBroker } from "./publisher.js";
import { createCdcMetrics } from "./metrics.js";

export interface CdcPipelineOptions {
  config: CDCConfig;
  connector: CDCConnector;
  publisher: CdcPublisher;
  replicationState: ReplicationStateStore;
  broker: MessageBroker;
  log?: Logger;
  /** Poll interval in ms when the source is idle (default 500). */
  pollIntervalMs?: number;
  /** Interval in ms to persist metric snapshots (default 5000). */
  metricsIntervalMs?: number;
  onMetrics?: (metrics: CDCMetrics) => void;
  metrics?: CdcMetrics;
}

export interface CdcPipeline {
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getMetrics(): CDCMetrics;
  isRunning(): boolean;
  position(): { latestLsn: string; lagMs: number };
}

export async function createCdcPipeline(options: CdcPipelineOptions): Promise<CdcPipeline> {
  const log = options.log ?? createLogger("cdc:pipeline", process.env.LOG_LEVEL ?? "info");
  const metrics = options.metrics ?? createCdcMetrics(log);
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const metricsIntervalMs = options.metricsIntervalMs ?? 5000;

  let running = false;
  let paused = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let metricsTimer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const emitMetrics = () => {
    const snapshot = metrics.snapshot(options.config.connector);
    options.onMetrics?.(snapshot);
  };

  const runCycle = async (): Promise<void> => {
    if (stopped || paused || !running) return;

    try {
      const batch = await options.connector.readBatch();
      if (batch && batch.changes.length > 0) {
        const result = await options.publisher.publishBatch(batch);
        // Only advance the durable checkpoint once the whole batch has been
        // recorded AND published. A crash before this point re-reads the same
        // changes, but the dedup table makes them no-ops (exactly-once).
        await advanceCheckpoint(
          options.replicationState,
          options.config.slotName,
          result.confirmedFlushLsn
        );
        const pos = options.connector.position();
        metrics.record(result.published, pos.lagMs, pos.lastEventAt);
        log.info("Pipeline advanced", {
          published: result.published,
          skipped: result.skipped,
          checkpoint: result.confirmedFlushLsn,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      metrics.recordError(message);
      metrics.setStatus("error");
      log.error("Pipeline cycle failed", { error: message });
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(poll, pollIntervalMs);
  };

  const poll = () => {
    if (stopped) return;
    inFlight = runCycle().finally(scheduleNext);
  };

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;

      // Failover / recovery: resume from the durable checkpoint.
      const checkpoint = await options.publisher.getCheckpoint();
      await options.connector.initialize(checkpoint);
      log.info("Pipeline started", { connector: options.config.connector, resumeLsn: checkpoint });

      metrics.setStatus("running");
      emitMetrics();

      metricsTimer = setInterval(() => emitMetrics(), metricsIntervalMs);
      poll();
    },

    async stop(): Promise<void> {
      stopped = true;
      running = false;
      if (timer) clearTimeout(timer);
      if (metricsTimer) clearInterval(metricsTimer);
      await inFlight;
      metrics.setStatus("stopped");
      emitMetrics();
      log.info("Pipeline stopped");
    },

    async pause(): Promise<void> {
      paused = true;
      metrics.setStatus("stopped");
      emitMetrics();
      log.info("Pipeline paused");
    },

    async resume(): Promise<void> {
      paused = false;
      metrics.setStatus("running");
      emitMetrics();
      log.info("Pipeline resumed");
    },

    getMetrics() {
      return metrics.snapshot(options.config.connector);
    },

    isRunning() {
      return !paused && running && !stopped;
    },

    position() {
      const pos = options.connector.position();
      return { latestLsn: pos.latestLsn, lagMs: pos.lagMs };
    },
  };
}
