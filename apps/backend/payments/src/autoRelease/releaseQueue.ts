/**
 * Delayed auto-release job scheduler (Issue #45).
 *
 * When `AutoReleaseConfig.delayMinutes > 0`, the release is not executed
 * synchronously — it's scheduled on a BullMQ-backed queue and executed by a
 * worker once the delay elapses. In test/CI environments (or when Redis is
 * mocked) this falls back to an in-memory pending-job list that tests can
 * advance deterministically via {@link runDueReleaseJobs}, avoiding real
 * timers and a live Redis dependency.
 */

import { createRequire } from "node:module";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:auto-release:queue", process.env.LOG_LEVEL ?? "info");

export const AUTO_RELEASE_QUEUE_NAME = "escrow-auto-release";

export interface ScheduledReleaseJob {
  escrowId: string;
  orderId: string;
  confirmedBy: string;
  timestamp: string;
}

export type ReleaseExecutor = (job: ScheduledReleaseJob) => Promise<void>;

export interface ScheduleResult {
  jobId: string;
  scheduledFor: string;
  backend: "bullmq" | "in-memory";
}

function isMockMode(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.MOCK_REDIS === "true" ||
    process.env.CI === "true"
  );
}

// ---------------------------------------------------------------------------
// In-memory backend (test / CI)
// ---------------------------------------------------------------------------

interface PendingJob {
  id: string;
  job: ScheduledReleaseJob;
  dueAt: number;
  executor: ReleaseExecutor;
}

const pendingJobs = new Map<string, PendingJob>();
let jobCounter = 0;

/** Test helper: run every in-memory job whose delay has elapsed by `now`. */
export async function runDueReleaseJobs(now: number = Date.now()): Promise<number> {
  const due = Array.from(pendingJobs.values()).filter((p) => p.dueAt <= now);
  for (const p of due) {
    pendingJobs.delete(p.id);
    await p.executor(p.job);
  }
  return due.length;
}

/** Test helper: number of jobs still waiting to run. */
export function pendingReleaseJobCount(): number {
  return pendingJobs.size;
}

/** Test helper: clear all in-memory pending jobs between test cases. */
export function resetReleaseQueue(): void {
  pendingJobs.clear();
  jobCounter = 0;
}

// ---------------------------------------------------------------------------
// BullMQ backend (production)
// ---------------------------------------------------------------------------

type BullQueue = {
  add(name: string, data: unknown, opts: { delay: number; jobId?: string }): Promise<{ id?: string }>;
};
type BullWorkerCtor = new (
  name: string,
  processor: (job: { id?: string; data: ScheduledReleaseJob }) => Promise<void>,
  opts: { connection: unknown }
) => unknown;

let bullQueue: BullQueue | null = null;
let globalExecutor: ReleaseExecutor | null = null;

/**
 * Registers the function that processes a scheduled release once its delay
 * elapses. Must be called once at startup (from the auto-release service)
 * before any BullMQ-backed job can be processed.
 */
export function registerReleaseExecutor(executor: ReleaseExecutor): void {
  globalExecutor = executor;
}

function getRedisConnection(): unknown {
  const _require = createRequire(import.meta.url);
  const { Redis } = _require("ioredis") as any;
  return new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
}

function getBullQueue(): BullQueue {
  if (bullQueue) return bullQueue;

  const _require = createRequire(import.meta.url);
  const { Queue, Worker } = _require("bullmq") as { Queue: any; Worker: BullWorkerCtor };
  const connection = getRedisConnection();

  const queue = new Queue(AUTO_RELEASE_QUEUE_NAME, { connection });
  bullQueue = queue;

  // eslint-disable-next-line no-new
  new Worker(
    AUTO_RELEASE_QUEUE_NAME,
    async (job: { id?: string; data: ScheduledReleaseJob }) => {
      if (!globalExecutor) {
        throw new Error("No auto-release executor registered for delayed job processing");
      }
      log.info("Processing delayed auto-release job", { jobId: job.id, escrowId: job.data.escrowId });
      await globalExecutor(job.data);
    },
    { connection }
  );

  return queue;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Schedule a release job to run after `delayMinutes`. Pass `executor`
 * explicitly so callers (and tests) don't depend on global registration in
 * mock mode; the BullMQ backend uses the globally registered executor since
 * its worker may run in a separate process.
 */
export async function scheduleRelease(
  job: ScheduledReleaseJob,
  delayMinutes: number,
  executor: ReleaseExecutor
): Promise<ScheduleResult> {
  const delayMs = Math.max(0, delayMinutes) * 60_000;
  const scheduledFor = new Date(Date.now() + delayMs).toISOString();

  if (isMockMode()) {
    const id = `mem-${++jobCounter}`;
    pendingJobs.set(id, { id, job, dueAt: Date.now() + delayMs, executor });
    log.info("Scheduled auto-release job (in-memory backend)", {
      jobId: id,
      escrowId: job.escrowId,
      delayMinutes,
    });
    return { jobId: id, scheduledFor, backend: "in-memory" };
  }

  registerReleaseExecutor(executor);
  const queue = getBullQueue();
  const bullJob = await queue.add("auto-release", job, {
    delay: delayMs,
    jobId: `${job.escrowId}:${job.timestamp}`,
  });
  log.info("Scheduled auto-release job (BullMQ backend)", {
    jobId: bullJob.id,
    escrowId: job.escrowId,
    delayMinutes,
  });
  return { jobId: String(bullJob.id ?? ""), scheduledFor, backend: "bullmq" };
}
