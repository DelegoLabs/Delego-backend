/**
 * @delegolabs/cdc — entry point
 *
 * Change Data Capture service. Captures PostgreSQL row changes via logical
 * replication (or Debezium), transforms them into domain events, and publishes
 * them to the Redis bus with exactly-once delivery. Exposes a monitoring
 * dashboard (`/cdc/dashboard`) and metrics (`/metrics`, `/api/v1/cdc/metrics`).
 */

import { createLogger, startHttpServer } from "@delegolabs/utils";
import type { Pool } from "pg";

import { loadCdcRuntimeEnv } from "./config.js";
import { createCdcPool } from "./db.js";
import { createConnector } from "./connector/factory.js";
import {
  createCdcPublisher,
  type CdcPublisher,
  type MessageBroker,
} from "./publisher.js";
import { createRedisBroker } from "./broker.js";
import { createCdcPipeline, type CdcPipeline } from "./pipeline.js";
import { registerCdcRoutes } from "./routes.js";
import { createCdcMetrics } from "./metrics.js";
import {
  PostgresPublishedEventStore,
  PostgresReplicationStateStore,
  type ReplicationStateStore,
} from "./store.js";
import { PostgresSchemaEvolutionStore } from "./schemaEvolution.js";
import { InMemoryPublishedEventStore, InMemoryReplicationStateStore } from "./store.js";
import { InMemorySchemaEvolutionStore } from "./schemaEvolution.js";

const SERVICE_NAME = "cdc";
const log = createLogger(SERVICE_NAME, process.env.LOG_LEVEL ?? "info");

async function main(): Promise<void> {
  const env = loadCdcRuntimeEnv();
  if (!env.config) {
    log.error("CDC configuration is required");
    process.exit(1);
  }
  const config = env.config;
  log.info("Starting CDC service", {
    connector: config.connector,
    slot: config.slotName,
    publication: config.publication,
    port: env.port,
  });

  const pool: Pool = createCdcPool(env.databaseUrl ?? "");
  const metrics = createCdcMetrics(log);

  // Backing stores (Postgres in production, in-memory in test/local).
  const useMemory =
    process.env.NODE_ENV === "test" ||
    process.env.MOCK_PG === "true" ||
    process.env.CI === "true";
  const replicationState: ReplicationStateStore = useMemory
    ? new InMemoryReplicationStateStore()
    : new PostgresReplicationStateStore(pool);
  const publishedEvents = useMemory
    ? new InMemoryPublishedEventStore()
    : new PostgresPublishedEventStore(pool);
  const schemaEvolution = useMemory
    ? new InMemorySchemaEvolutionStore()
    : new PostgresSchemaEvolutionStore(pool);

  const broker: MessageBroker = createRedisBroker();
  const publisher: CdcPublisher = createCdcPublisher({
    slotName: config.slotName,
    broker,
    publishedEvents,
    replicationState,
    schemaEvolution,
    transformOptions: { topicPrefix: env.publishTopicPrefix ?? "cdc" },
  });

  const connector = createConnector({
    config,
    pool,
    debeziumSource: undefined,
  });

  let pipeline: CdcPipeline | undefined;
  try {
    pipeline = await createCdcPipeline({
      config,
      connector,
      publisher,
      replicationState,
      broker,
      metrics,
      pollIntervalMs: Number(process.env.CDC_POLL_INTERVAL_MS ?? 500),
      metricsIntervalMs: env.metricsIntervalMs,
    });
  } catch (err) {
    log.error("Failed to create pipeline", { error: err instanceof Error ? err.message : String(err) });
    await pool.end();
    process.exit(1);
  }

  const routes = registerCdcRoutes({
    config,
    metrics,
    getPositionLsn: () => pipeline?.position() ?? { latestLsn: "0/0", lagMs: 0 },
    onPause: () => pipeline?.pause() ?? Promise.resolve(),
    onResume: () => pipeline?.resume() ?? Promise.resolve(),
  });

  startHttpServer({
    port: env.port ?? 3017,
    serviceName: SERVICE_NAME,
    routes,
  });

  await pipeline.start();

  const shutdown = async (): Promise<void> => {
    log.info("Shutting down CDC pipeline");
    await pipeline?.stop();
    await connector.close();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

main().catch((err) => {
  log.error("CDC service failed to start", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
