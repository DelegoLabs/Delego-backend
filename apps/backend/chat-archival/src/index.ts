/**
 * @delegolabs/chat-archival — BullMQ worker for archiving idle chat sessions.
 * Archives chat sessions idle for >30 days to S3 cold storage and prunes hot DB rows.
 */
import { createLogger, createHealthRoutes, startHttpServer, HealthRegistry } from "@delegolabs/utils";
import { Pool } from "pg";
import { PostgresDatabaseService } from "./database.js";
import { S3ChatArchivalService } from "./s3.js";
import { LLMSummarizationService } from "./llm.js";
import { ChatArchivalServiceImpl } from "./service.js";
import { ChatArchivalWorker } from "./worker.js";
import { registerRoutes } from "./routes.js";

const SERVICE_NAME = "chat-archival";
const VERSION = "0.0.1";
const DEFAULT_PORT = 3023;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const port = Number(process.env.CHAT_ARCHIVAL_PORT ?? DEFAULT_PORT);
const log = createLogger(SERVICE_NAME, logLevel);

// Database connection
const connectionString = process.env.DATABASE_URL ?? "";
const pool = connectionString ? new Pool({ connectionString }) : null;

if (!pool) {
  log.warn("DATABASE_URL not configured - service will run in limited mode");
}

// Initialize services
const database = pool ? new PostgresDatabaseService(pool) : null;
const s3 = new S3ChatArchivalService();
const llm = new LLMSummarizationService();

// Create archival service
const archivalService = database
  ? new ChatArchivalServiceImpl(database, s3, llm)
  : null;

// Create and start worker
let worker: ChatArchivalWorker | null = null;
if (archivalService && database) {
  worker = new ChatArchivalWorker(archivalService, {
    concurrency: Number(process.env.CHAT_ARCHIVAL_CONCURRENCY ?? 5),
    olderThanDays: Number(process.env.CHAT_ARCHIVAL_IDLE_DAYS ?? 30),
    batchSize: Number(process.env.CHAT_ARCHIVAL_BATCH_SIZE ?? 100),
    dryRun: process.env.CHAT_ARCHIVAL_DRY_RUN === "true",
  });

  // Schedule periodic batch archival
  const scheduleInterval = Number(process.env.CHAT_ARCHIVAL_SCHEDULE_INTERVAL_MS ?? 24 * 60 * 60 * 1000); // 24 hours
  const olderThanDays = Number(process.env.CHAT_ARCHIVAL_IDLE_DAYS ?? 30);
  const batchSize = Number(process.env.CHAT_ARCHIVAL_BATCH_SIZE ?? 100);
  const dryRun = process.env.CHAT_ARCHIVAL_DRY_RUN === "true";

  setInterval(async () => {
    try {
      log.info("Running scheduled batch archival", { olderThanDays, batchSize, dryRun });
      await worker?.scheduleBatchArchival(olderThanDays, batchSize, dryRun);
    } catch (error) {
      log.error("Scheduled batch archival failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, scheduleInterval);

  // Run initial batch on startup (optional)
  if (process.env.CHAT_ARCHIVAL_RUN_ON_STARTUP === "true") {
    setTimeout(async () => {
      try {
        log.info("Running initial batch archival on startup");
        await worker?.scheduleBatchArchival(olderThanDays, batchSize, dryRun);
      } catch (error) {
        log.error("Initial batch archival failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 5000); // Wait 5 seconds for service to fully initialize
  }
}

// Health check registry
const healthRegistry = new HealthRegistry();
healthRegistry.register(
  "database",
  async () => {
    if (!pool) return { status: "degraded", details: { reason: "no DATABASE_URL configured" } };
    await pool.query("SELECT 1");
    return { status: "healthy" };
  },
  { type: "database", critical: true }
);

healthRegistry.register(
  "redis",
  async () => {
    try {
      const { Redis } = await import("ioredis");
      const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
      await redis.ping();
      await redis.quit();
      return { status: "healthy" };
    } catch (error) {
      return { status: "unhealthy", details: { error: (error as Error).message } };
    }
  },
  { type: "redis", critical: true }
);

healthRegistry.register(
  "s3",
  async () => {
    try {
      const { S3Client, ListBucketsCommand } = await import("@aws-sdk/client-s3");
      const region = process.env.STORAGE_REGION || "auto";
      const endpoint = process.env.STORAGE_ENDPOINT;
      const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID || "dummy-access-key";
      const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY || "dummy-secret-key";

      const config: any = {
        region,
        credentials: { accessKeyId, secretAccessKey },
      };
      if (endpoint) {
        config.endpoint = endpoint;
        config.forcePathStyle = true;
      }

      const client = new S3Client(config);
      await client.send(new ListBucketsCommand({}));
      return { status: "healthy" };
    } catch (error) {
      return { status: "degraded", details: { error: (error as Error).message } };
    }
  },
  { type: "s3", critical: false }
);

const health = createHealthRoutes({
  registry: healthRegistry,
  serviceName: SERVICE_NAME,
  version: VERSION,
});

// Start HTTP server
log.info("Starting chat-archival service", {
  port,
  nodeEnv,
  hasDatabase: pool !== null,
  hasWorker: worker !== null,
});

startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  version: VERSION,
  routes: [...health, ...registerRoutes(worker)],
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  log.info("Shutting down", { signal });
  
  if (worker) {
    await worker.close();
  }
  
  if (pool) {
    await pool.end().catch(() => undefined);
  }
  
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export { archivalService, worker, pool };
