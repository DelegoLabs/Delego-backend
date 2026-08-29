/**
 * Transaction Dead Letter Queue (DLQ) with Replay
 * Issue #143
 *
 * Features:
 * - DLQ for permanently failed transactions
 * - Retry policies per failure type
 * - DLQ monitoring and alerting
 * - Admin API for DLQ inspection/replay
 * - Automatic replay for transient failures
 * - DLQ retention policies
 * - Failure categorization (transient, permanent, unknown)
 * - DLQ metrics and dashboards
 */

import { Redis } from "ioredis";
// @ts-ignore
import MockRedis from "ioredis-mock";
import { createLogger } from "@delegolabs/utils";
import type { TransactionRequest } from "@delegolabs/types";
import { classifySubmissionFailure, type SubmissionFailure } from "./submissionFailure.js";

const log = createLogger("wallet:dlq", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeadLetterEntry {
  id: string;
  originalJobId: string;
  request: TransactionRequest;
  failure: {
    code: string;
    message: string;
    category: "transient" | "permanent" | "unknown";
    retryable: boolean;
    txHash?: string;
  };
  attempts: number;
  lastAttemptAt: string;
  createdAt: string;
  nextRetryAt?: string;
  replayCount: number;
  status: "pending" | "retrying" | "replayed" | "archived" | "discarded";
}

export interface RetryPolicy {
  failureCode: string;
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  category: "transient" | "permanent" | "unknown";
}

export interface DLQMetrics {
  totalEntries: number;
  byCategory: Record<string, number>;
  byStatus: Record<string, number>;
  oldestEntryAge: number;
  replaySuccessRate: number;
  avgTimeToResolution: number;
}

export interface DLQAlert {
  type: "growth_threshold" | "replay_failure" | "retention_exceeded";
  message: string;
  timestamp: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DLQ_KEY_PREFIX = "tx:dlq:";
const DLQ_INDEX_KEY = "tx:dlq:index";
const DLQ_METRICS_KEY = "tx:dlq:metrics";
const DLQ_ALERTS_KEY = "tx:dlq:alerts";

const DEFAULT_RETRY_POLICIES: RetryPolicy[] = [
  {
    failureCode: "TX_RPC_TRANSIENT",
    maxRetries: 5,
    backoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 30000,
    category: "transient",
  },
  {
    failureCode: "TX_SEQUENCE_CONFLICT",
    maxRetries: 3,
    backoffMs: 2000,
    backoffMultiplier: 2,
    maxBackoffMs: 15000,
    category: "transient",
  },
  {
    failureCode: "TX_POLL_TIMEOUT",
    maxRetries: 3,
    backoffMs: 5000,
    backoffMultiplier: 2,
    maxBackoffMs: 30000,
    category: "transient",
  },
  {
    failureCode: "TX_MALFORMED_XDR",
    maxRetries: 0,
    backoffMs: 0,
    backoffMultiplier: 1,
    maxBackoffMs: 0,
    category: "permanent",
  },
  {
    failureCode: "TX_AUTH_FAILURE",
    maxRetries: 0,
    backoffMs: 0,
    backoffMultiplier: 1,
    maxBackoffMs: 0,
    category: "permanent",
  },
  {
    failureCode: "TX_SIMULATION_FAILED",
    maxRetries: 2,
    backoffMs: 5000,
    backoffMultiplier: 2,
    maxBackoffMs: 30000,
    category: "unknown",
  },
  {
    failureCode: "TX_EXECUTION_FAILED",
    maxRetries: 0,
    backoffMs: 0,
    backoffMultiplier: 1,
    maxBackoffMs: 0,
    category: "permanent",
  },
  {
    failureCode: "TX_SUBMISSION_REJECTED",
    maxRetries: 1,
    backoffMs: 5000,
    backoffMultiplier: 2,
    maxBackoffMs: 15000,
    category: "unknown",
  },
  {
    failureCode: "TX_SUBMISSION_UNKNOWN",
    maxRetries: 1,
    backoffMs: 5000,
    backoffMultiplier: 2,
    maxBackoffMs: 15000,
    category: "unknown",
  },
];

const RETENTION_DAYS = 30;
const MAX_DLQ_ENTRIES = 10000;
const ALERT_GROWTH_THRESHOLD = 1000;

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------

let retryPolicies: RetryPolicy[] = [...DEFAULT_RETRY_POLICIES];
let redisClient: Redis | null = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initDLQ(redis?: Redis): void {
  redisClient = redis ?? null;
  log.info("Transaction DLQ initialized", {
    retentionDays: RETENTION_DAYS,
    maxEntries: MAX_DLQ_ENTRIES,
  });
}

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

function categorizeFailure(
  code: string
): "transient" | "permanent" | "unknown" {
  const policy = retryPolicies.find((p) => p.failureCode === code);
  return policy?.category ?? "unknown";
}

function getRetryPolicy(failureCode: string): RetryPolicy | undefined {
  return retryPolicies.find((p) => p.failureCode === failureCode);
}

// ---------------------------------------------------------------------------
// DLQ Operations
// ---------------------------------------------------------------------------

export async function addToDLQ(
  id: string,
  originalJobId: string,
  request: TransactionRequest,
  failure: SubmissionFailure,
  attempts: number,
  redis?: Redis
): Promise<DeadLetterEntry> {
  const r = redis ?? redisClient;
  const category = categorizeFailure(failure.code);
  const policy = getRetryPolicy(failure.code);

  const entry: DeadLetterEntry = {
    id,
    originalJobId,
    request,
    failure: {
      code: failure.code,
      message: failure.message,
      category,
      retryable: failure.retryable,
      txHash: failure.txHash,
    },
    attempts,
    lastAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    replayCount: 0,
    status: "pending",
  };

  // Calculate next retry time if retryable
  if (policy && policy.maxRetries > 0) {
    const backoff = Math.min(
      policy.backoffMs * Math.pow(policy.backoffMultiplier, attempts),
      policy.maxBackoffMs
    );
    entry.nextRetryAt = new Date(Date.now() + backoff).toISOString();
  }

  if (r) {
    try {
      const key = `${DLQ_KEY_PREFIX}${id}`;
      await r.set(key, JSON.stringify(entry), "EX", RETENTION_DAYS * 86400);
      await r.zadd(DLQ_INDEX_KEY, Date.now(), id);

      // Check size limits
      const count = await r.zcard(DLQ_INDEX_KEY);
      if (count > MAX_DLQ_ENTRIES) {
        const toEvict = await r.zrange(DLQ_INDEX_KEY, 0, count - MAX_DLQ_ENTRIES - 1);
        const pipeline = r.pipeline();
        for (const evictId of toEvict) {
          pipeline.del(`${DLQ_KEY_PREFIX}${evictId}`);
          pipeline.zrem(DLQ_INDEX_KEY, evictId);
        }
        await pipeline.exec();
      }

      // Check growth threshold for alerts
      if (count >= ALERT_GROWTH_THRESHOLD) {
        await recordAlert(
          {
            type: "growth_threshold",
            message: `DLQ has ${count} entries, exceeding threshold of ${ALERT_GROWTH_THRESHOLD}`,
            timestamp: new Date().toISOString(),
            details: { count, threshold: ALERT_GROWTH_THRESHOLD },
          },
          r
        );
      }
    } catch (err) {
      log.error("Failed to write DLQ entry to Redis", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.warn("Transaction added to DLQ", {
    id,
    originalJobId,
    failureCode: failure.code,
    category,
    attempts,
  });

  return entry;
}

export async function getDLQEntry(
  id: string,
  redis?: Redis
): Promise<DeadLetterEntry | null> {
  const r = redis ?? redisClient;
  if (!r) return null;

  try {
    const key = `${DLQ_KEY_PREFIX}${id}`;
    const json = await r.get(key);
    if (!json) return null;
    return JSON.parse(json) as DeadLetterEntry;
  } catch {
    return null;
  }
}

export async function removeDLQEntry(
  id: string,
  redis?: Redis
): Promise<boolean> {
  const r = redis ?? redisClient;
  if (!r) return false;

  try {
    await r.del(`${DLQ_KEY_PREFIX}${id}`);
    await r.zrem(DLQ_INDEX_KEY, id);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Retry & Replay
// ---------------------------------------------------------------------------

export async function getRetriableEntries(
  redis?: Redis
): Promise<DeadLetterEntry[]> {
  const r = redis ?? redisClient;
  if (!r) return [];

  const ids = await r.zrange(DLQ_INDEX_KEY, 0, -1);
  const retriable: DeadLetterEntry[] = [];
  const now = Date.now();

  for (const id of ids) {
    try {
      const entry = await getDLQEntry(id, r);
      if (!entry) continue;

      if (entry.status !== "pending") continue;

      const policy = getRetryPolicy(entry.failure.code);
      if (!policy || policy.maxRetries <= 0) continue;

      if (entry.attempts >= policy.maxRetries) continue;

      if (entry.nextRetryAt && new Date(entry.nextRetryAt).getTime() > now) {
        continue;
      }

      retriable.push(entry);
    } catch {
      continue;
    }
  }

  return retriable;
}

export async function markAsRetrying(
  id: string,
  redis?: Redis
): Promise<void> {
  const r = redis ?? redisClient;
  if (!r) return;

  const entry = await getDLQEntry(id, r);
  if (!entry) return;

  entry.status = "retrying";
  entry.lastAttemptAt = new Date().toISOString();
  entry.attempts++;

  const policy = getRetryPolicy(entry.failure.code);
  if (policy && entry.attempts < policy.maxRetries) {
    const backoff = Math.min(
      policy.backoffMs * Math.pow(policy.backoffMultiplier, entry.attempts),
      policy.maxBackoffMs
    );
    entry.nextRetryAt = new Date(Date.now() + backoff).toISOString();
  }

  await r.set(`${DLQ_KEY_PREFIX}${id}`, JSON.stringify(entry), "EX", RETENTION_DAYS * 86400);
}

export async function markAsReplayed(
  id: string,
  txHash: string,
  redis?: Redis
): Promise<void> {
  const r = redis ?? redisClient;
  if (!r) return;

  const entry = await getDLQEntry(id, r);
  if (!entry) return;

  entry.status = "replayed";
  entry.replayCount++;
  entry.failure.txHash = txHash;

  await r.set(`${DLQ_KEY_PREFIX}${id}`, JSON.stringify(entry), "EX", RETENTION_DAYS * 86400);
}

export async function markAsArchived(
  id: string,
  redis?: Redis
): Promise<void> {
  const r = redis ?? redisClient;
  if (!r) return;

  const entry = await getDLQEntry(id, r);
  if (!entry) return;

  entry.status = "archived";

  await r.set(`${DLQ_KEY_PREFIX}${id}`, JSON.stringify(entry), "EX", RETENTION_DAYS * 86400);
}

export async function markAsDiscarded(
  id: string,
  redis?: Redis
): Promise<void> {
  const r = redis ?? redisClient;
  if (!r) return;

  const entry = await getDLQEntry(id, r);
  if (!entry) return;

  entry.status = "discarded";

  await r.set(`${DLQ_KEY_PREFIX}${id}`, JSON.stringify(entry), "EX", RETENTION_DAYS * 86400);
}

// ---------------------------------------------------------------------------
// Automatic Replay for Transient Failures
// ---------------------------------------------------------------------------

export async function processAutoReplays(
  replayFn: (request: TransactionRequest) => Promise<string>,
  redis?: Redis
): Promise<{ replayed: number; failed: number; skipped: number }> {
  const r = redis ?? redisClient;
  const retriable = await getRetriableEntries(r);

  let replayed = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of retriable) {
    if (entry.failure.category !== "transient") {
      skipped++;
      continue;
    }

    try {
      await markAsRetrying(entry.id, r);
      const txHash = await replayFn(entry.request);
      await markAsReplayed(entry.id, txHash, r);
      replayed++;

      log.info("DLQ auto-replay succeeded", {
        id: entry.id,
        txHash,
        attempts: entry.attempts,
      });
    } catch (err) {
      failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("DLQ auto-replay failed", {
        id: entry.id,
        error: errMsg,
        attempts: entry.attempts,
      });
    }
  }

  return { replayed, failed, skipped };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export async function getDLQMetrics(
  redis?: Redis
): Promise<DLQMetrics> {
  const r = redis ?? redisClient;

  const totalEntries = r ? await r.zcard(DLQ_INDEX_KEY) : 0;
  const byCategory: Record<string, number> = { transient: 0, permanent: 0, unknown: 0 };
  const byStatus: Record<string, number> = {
    pending: 0,
    retrying: 0,
    replayed: 0,
    archived: 0,
    discarded: 0,
  };

  let oldestEntryAge = 0;
  let replaySuccessCount = 0;
  let totalReplayAttempts = 0;
  let totalResolutionTime = 0;
  let resolvedCount = 0;

  if (r) {
    const ids = await r.zrange(DLQ_INDEX_KEY, 0, -1);
    const now = Date.now();

    for (const id of ids) {
      try {
        const entry = await getDLQEntry(id, r);
        if (!entry) continue;

        byCategory[entry.failure.category] = (byCategory[entry.failure.category] || 0) + 1;
        byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;

        const createdAt = new Date(entry.createdAt).getTime();
        const age = now - createdAt;
        if (age > oldestEntryAge) oldestEntryAge = age;

        if (entry.status === "replayed") {
          replaySuccessCount++;
          totalResolutionTime += now - createdAt;
          resolvedCount++;
        }
        if (entry.replayCount > 0) {
          totalReplayAttempts += entry.replayCount;
        }
      } catch {
        continue;
      }
    }
  }

  return {
    totalEntries,
    byCategory,
    byStatus,
    oldestEntryAge,
    replaySuccessRate: totalReplayAttempts > 0
      ? Number(((replaySuccessCount / totalReplayAttempts) * 100).toFixed(2))
      : 0,
    avgTimeToResolution: resolvedCount > 0
      ? Math.round(totalResolutionTime / resolvedCount)
      : 0,
  };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export async function recordAlert(
  alert: DLQAlert,
  redis?: Redis
): Promise<void> {
  const r = redis ?? redisClient;
  if (!r) return;

  try {
    await r.rpush(DLQ_ALERTS_KEY, JSON.stringify(alert));
    await r.ltrim(DLQ_ALERTS_KEY, -100, -1);
  } catch {}

  log.warn("DLQ alert", { type: alert.type, message: alert.message });
}

export async function getAlerts(
  limit: number = 50,
  redis?: Redis
): Promise<DLQAlert[]> {
  const r = redis ?? redisClient;
  if (!r) return [];

  try {
    const alerts = await r.lrange(DLQ_ALERTS_KEY, -limit, -1);
    return alerts.map((json) => JSON.parse(json) as DLQAlert);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Retention Cleanup
// ---------------------------------------------------------------------------

export async function enforceRetentionPolicy(
  redis?: Redis
): Promise<{ cleaned: number }> {
  const r = redis ?? redisClient;
  if (!r) return { cleaned: 0 };

  const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
  const ids = await r.zrangebyscore(DLQ_INDEX_KEY, 0, cutoff);
  let cleaned = 0;

  const pipeline = r.pipeline();
  for (const id of ids) {
    pipeline.del(`${DLQ_KEY_PREFIX}${id}`);
    pipeline.zrem(DLQ_INDEX_KEY, id);
    cleaned++;
  }

  if (cleaned > 0) {
    await pipeline.exec();
    log.info("DLQ retention cleanup completed", { cleaned });
  }

  return { cleaned };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function setRetryPolicies(policies: RetryPolicy[]): void {
  retryPolicies = policies;
}

export function getRetryPolicies(): RetryPolicy[] {
  return [...retryPolicies];
}

// ---------------------------------------------------------------------------
// Manual Replay (Admin)
// ---------------------------------------------------------------------------

export async function manualReplay(
  id: string,
  replayFn: (request: TransactionRequest) => Promise<string>,
  redis?: Redis
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const r = redis ?? redisClient;
  const entry = await getDLQEntry(id, r);
  if (!entry) {
    return { success: false, error: "DLQ entry not found" };
  }

  try {
    await markAsRetrying(id, r);
    const txHash = await replayFn(entry.request);
    await markAsReplayed(id, txHash, r);

    return { success: true, txHash };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Force Status Updates
// ---------------------------------------------------------------------------

export async function archiveEntry(
  id: string,
  redis?: Redis
): Promise<boolean> {
  const entry = await getDLQEntry(id, redis);
  if (!entry) return false;
  await markAsArchived(id, redis);
  return true;
}

export async function discardEntry(
  id: string,
  redis?: Redis
): Promise<boolean> {
  const entry = await getDLQEntry(id, redis);
  if (!entry) return false;
  await markAsDiscarded(id, redis);
  return true;
}
