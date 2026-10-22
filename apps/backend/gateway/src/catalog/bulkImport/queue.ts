/**
 * BullMQ wiring for merchant bulk catalog imports.
 *
 * Logical queue: merchant:catalog:bulk_import. BullMQ rejects ":" in queue
 * names (it is the Redis key separator), so the physical name uses dashes.
 */

import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { createLogger } from "@delegolabs/utils";
import { sequelize } from "../../db.js";
import { getRedisClient } from "../../rateLimit/redisClient.js";
import { Merchant } from "../../models/index.js";
import { redisConnectionFromUrl } from "../../../../notifications/src/restock/queue.js";
import { triggerRestockIfReplenished } from "../routes.js";
import { HttpImageVerifier } from "./imageVerifier.js";
import { BulkImportFatalError, byteLimit, processBulkCatalogImport } from "./processor.js";
import { BulkCatalogProgressStore, type ProgressRedis } from "./progressStore.js";
import { SequelizeCatalogRepository } from "./repository.js";
import { safeHttpsRequest, UnsafeUrlError } from "./safeFetch.js";
import type { BulkCatalogJobData, BulkCatalogJobStatus } from "./types.js";

const log = createLogger("gateway:catalog:bulk-import", process.env.LOG_LEVEL ?? "info");

export const BULK_CATALOG_IMPORT_QUEUE = "merchant-catalog-bulk_import";

const JOB_ATTEMPTS = 3;
const CSV_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_CSV_BYTES = Number(process.env.CATALOG_IMPORT_MAX_BYTES ?? 200 * 1024 * 1024);
const MAX_CSV_ROWS = Number(process.env.CATALOG_IMPORT_MAX_ROWS ?? 1_000_000);

let queue: Queue<BulkCatalogJobData> | null = null;

function getQueue(): Queue<BulkCatalogJobData> {
  if (!queue) {
    queue = new Queue<BulkCatalogJobData>(BULK_CATALOG_IMPORT_QUEUE, {
      connection: redisConnectionFromUrl(),
      defaultJobOptions: {
        attempts: JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: 15_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    });
  }
  return queue;
}

export function getProgressStore(): BulkCatalogProgressStore {
  return new BulkCatalogProgressStore(getRedisClient() as unknown as ProgressRedis);
}

export async function enqueueBulkCatalogImport(data: BulkCatalogJobData): Promise<void> {
  // jobId = our job id, so a double-submitted enqueue can't start two imports.
  await getQueue().add("import-csv", data, { jobId: data.jobId });
}

async function publishCatalogImportProgress(
  userId: string,
  jobId: string,
  status: BulkCatalogJobStatus,
): Promise<void> {
  const progress = status.progress;
  const event = {
    topic: `user:${userId}`,
    type: "catalog_import_progress",
    payload: {
      jobId,
      state: status.state,
      progress: {
        totalRows: progress.totalRows,
        processedRows: progress.processedRows,
        successCount: progress.successCount,
        errorCount: progress.errorCount,
      },
    },
    publishedAt: new Date().toISOString(),
  };

  try {
    // The notifications service subscribes to this literal Redis channel.
    await getRedisClient().publish("notifications:*", JSON.stringify(event));
  } catch (err) {
    log.error("Failed to publish bulk catalog import progress", {
      jobId,
      merchantId: status.merchantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function openCsvStream(url: string) {
  let response;
  try {
    response = await safeHttpsRequest(url, { method: "GET", timeoutMs: CSV_DOWNLOAD_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new BulkImportFatalError(err.message);
    throw err;
  }

  const status = response.statusCode ?? 0;
  if (status !== 200) {
    response.resume();
    const message = `CSV download failed with HTTP ${status}`;
    // 4xx (expired presigned URL, missing file) won't fix itself; 5xx might.
    throw status >= 400 && status < 500 ? new BulkImportFatalError(message) : new Error(message);
  }
  return response.pipe(byteLimit(MAX_CSV_BYTES));
}

export interface BulkCatalogWorkerHandle {
  close(): Promise<void>;
}

export function startBulkCatalogImportWorker(): BulkCatalogWorkerHandle {
  const repository = new SequelizeCatalogRepository(sequelize);
  const progressStore = getProgressStore();

  const worker = new Worker<BulkCatalogJobData, BulkCatalogJobStatus>(
    BULK_CATALOG_IMPORT_QUEUE,
    async (job: Job<BulkCatalogJobData>) => {
      const attempts = job.opts.attempts ?? 1;
      try {
        const merchant = await Merchant.findByPk(job.data.merchantId, { attributes: ["ownerUserId"] });
        const status = await processBulkCatalogImport(
          job.data,
          {
            openCsvStream,
            repository,
            // Fresh verifier per job: its URL cache is scoped to one catalog.
            imageVerifier: new HttpImageVerifier(),
            progressStore,
            onStockTransition: (t) =>
              triggerRestockIfReplenished(t.productId, t.previousStock, t.currentStock),
            maxRows: MAX_CSV_ROWS,
          },
          {
            isFinalAttempt: job.attemptsMade + 1 >= attempts,
            async onProgress(s) {
              await job.updateProgress(s.progress);
              if (merchant?.ownerUserId) {
                await publishCatalogImportProgress(merchant.ownerUserId, job.data.jobId, s);
              }
            },
          },
        );
        log.info("Bulk catalog import completed", {
          jobId: job.data.jobId,
          merchantId: job.data.merchantId,
          totalRows: status.progress.totalRows,
          successCount: status.progress.successCount,
          errorCount: status.progress.errorCount,
        });
        return status;
      } catch (err) {
        if (err instanceof BulkImportFatalError) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
    {
      connection: redisConnectionFromUrl(),
      concurrency: Number(process.env.CATALOG_IMPORT_CONCURRENCY ?? 2),
      // Large batches with image checks can run long; keep the job lock alive.
      lockDuration: 120_000,
    },
  );

  worker.on("failed", (job, err) => {
    log.error("Bulk catalog import attempt failed", {
      jobId: job?.data.jobId,
      merchantId: job?.data.merchantId,
      attempt: job?.attemptsMade,
      error: err.message,
    });
  });

  log.info("Bulk catalog import worker started", { queue: BULK_CATALOG_IMPORT_QUEUE });

  return {
    async close() {
      await worker.close();
      await queue?.close();
      queue = null;
    },
  };
}
