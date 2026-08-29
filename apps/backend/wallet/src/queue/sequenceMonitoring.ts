/**
 * Sequence Number Reservation Monitoring & Admin API
 * Issue #140
 *
 * Features:
 * - Metrics for reservation utilization (active, expired, exhausted)
 * - Reservation leak detection and auto-cleanup
 * - Gap detection and alerting
 * - Admin API to view/reserve/force-release reservations
 * - Reservation analytics (avg size, duration, contention)
 * - Reservation pre-warming for high-throughput accounts
 * - Distributed lock monitoring
 * - Sequence number audit trail
 */

import { Redis } from "ioredis";
import { createLogger } from "@delegolabs/utils";
import type { SequenceReservation } from "./txQueue.js";

const log = createLogger("wallet:sequenceMonitoring", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SequenceReservationMetrics {
  account: string;
  activeReservations: number;
  expiredReservations: number;
  exhaustedReservations: number;
  avgReservationSize: number;
  avgReservationDurationMs: number;
  contentionEvents: number;
  lastGapDetectedAt?: string;
}

export interface ReservationAdminAction {
  action: "view" | "force_release" | "pre_warm" | "audit";
  account: string;
  leaseId?: string;
  size?: number;
  reason: string;
}

export interface SequenceGap {
  account: string;
  expectedSequence: string;
  actualSequence: string;
  gapSize: number;
  detectedAt: string;
  resolved: boolean;
}

export interface AuditTrailEntry {
  timestamp: string;
  account: string;
  action: "reserve" | "consume" | "release" | "expire" | "force_release" | "pre_warm" | "gap_detected";
  leaseId?: string;
  sequence?: string;
  details?: string;
}

export interface LockMonitoringInfo {
  account: string;
  lockKey: string;
  acquiredAt: string;
  durationMs: number;
  holder: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDIT_KEY_PREFIX = "seq:audit:";
const METRICS_KEY_PREFIX = "seq:metrics:";
const GAP_KEY_PREFIX = "seq:gaps:";
const LOCK_MONITOR_KEY_PREFIX = "seq:lock_monitor:";
const CONTENTION_KEY_PREFIX = "seq:contention:";
const RETENTION_DAYS = 30;
const MAX_AUDIT_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// Metrics Collection
// ---------------------------------------------------------------------------

export async function getReservationMetrics(
  account: string,
  redis: Redis
): Promise<SequenceReservationMetrics> {
  const key = `seq:reservations:${account}`;
  const reservationsJson = await redis.lrange(key, 0, -1);
  const now = Date.now();

  let active = 0;
  let expired = 0;
  let exhausted = 0;
  let totalSize = 0;
  let totalDurationMs = 0;
  let count = 0;

  for (const json of reservationsJson) {
    try {
      const reservation = JSON.parse(json) as SequenceReservation;
      const expiresAt = parseInt(reservation.expiresAt);
      const createdAt = parseInt(reservation.leaseId.split("-")[0], 36);
      const duration = now - createdAt;
      totalSize += reservation.size;
      totalDurationMs += duration;
      count++;

      if (expiresAt <= now) {
        expired++;
      } else {
        const cursorKey = `seq:res:${reservation.leaseId}:cursor`;
        const cursorStr = await redis.get(cursorKey);
        if (cursorStr) {
          const cursor = BigInt(cursorStr);
          const lastSeq = BigInt(reservation.lastSequence);
          if (cursor > lastSeq) {
            exhausted++;
          } else {
            active++;
          }
        } else {
          active++;
        }
      }
    } catch {
      expired++;
    }
  }

  const contentionKey = `${CONTENTION_KEY_PREFIX}${account}`;
  const contentionEvents = parseInt(await redis.get(contentionKey) || "0");

  const gapKey = `${GAP_KEY_PREFIX}${account}`;
  const lastGapJson = await redis.lindex(gapKey, -1);
  let lastGapDetectedAt: string | undefined;
  if (lastGapJson) {
    try {
      const gap = JSON.parse(lastGapJson) as SequenceGap;
      lastGapDetectedAt = gap.detectedAt;
    } catch {}
  }

  return {
    account,
    activeReservations: active,
    expiredReservations: expired,
    exhaustedReservations: exhausted,
    avgReservationSize: count > 0 ? Math.round(totalSize / count) : 0,
    avgReservationDurationMs: count > 0 ? Math.round(totalDurationMs / count) : 0,
    contentionEvents,
    lastGapDetectedAt,
  };
}

export async function recordContentionEvent(account: string, redis: Redis): Promise<void> {
  const key = `${CONTENTION_KEY_PREFIX}${account}`;
  await redis.incr(key);
  await redis.expire(key, 3600);
}

// ---------------------------------------------------------------------------
// Gap Detection
// ---------------------------------------------------------------------------

export async function detectSequenceGap(
  account: string,
  expectedSequence: string,
  actualSequence: string,
  redis: Redis
): Promise<SequenceGap | null> {
  const expected = BigInt(expectedSequence);
  const actual = BigInt(actualSequence);

  if (actual > expected + 1n) {
    const gap: SequenceGap = {
      account,
      expectedSequence: expectedSequence,
      actualSequence: actualSequence,
      gapSize: Number(actual - expected - 1n),
      detectedAt: new Date().toISOString(),
      resolved: false,
    };

    const gapKey = `${GAP_KEY_PREFIX}${account}`;
    await redis.rpush(gapKey, JSON.stringify(gap));
    await redis.ltrim(gapKey, -100, -1);

    await recordAuditEntry(account, "gap_detected", redis, undefined, undefined,
      `Gap detected: expected ${expectedSequence}, got ${actualSequence}, gap size ${gap.gapSize}`);

    log.warn("Sequence gap detected", {
      account,
      expected: expectedSequence,
      actual: actualSequence,
      gapSize: gap.gapSize,
    });

    return gap;
  }

  return null;
}

export async function getSequenceGaps(
  account: string,
  redis: Redis
): Promise<SequenceGap[]> {
  const gapKey = `${GAP_KEY_PREFIX}${account}`;
  const gapJsons = await redis.lrange(gapKey, 0, -1);
  const gaps: SequenceGap[] = [];

  for (const json of gapJsons) {
    try {
      gaps.push(JSON.parse(json) as SequenceGap);
    } catch {
      continue;
    }
  }

  return gaps;
}

export async function resolveSequenceGap(
  account: string,
  expectedSequence: string,
  redis: Redis
): Promise<boolean> {
  const gapKey = `${GAP_KEY_PREFIX}${account}`;
  const gapJsons = await redis.lrange(gapKey, 0, -1);

  for (const json of gapJsons) {
    try {
      const gap = JSON.parse(json) as SequenceGap;
      if (gap.expectedSequence === expectedSequence && !gap.resolved) {
        gap.resolved = true;
        await redis.lrem(gapKey, 0, json);
        await redis.rpush(gapKey, JSON.stringify(gap));
        await recordAuditEntry(account, "gap_detected", redis, undefined, undefined,
          `Gap resolved for sequence ${expectedSequence}`);
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Leak Detection & Auto-Cleanup
// ---------------------------------------------------------------------------

export async function detectAndCleanupLeakedReservations(
  account: string,
  redis: Redis
): Promise<{ cleaned: number; leaked: SequenceReservation[] }> {
  const key = `seq:reservations:${account}`;
  const reservationsJson = await redis.lrange(key, 0, -1);
  const now = Date.now();
  const leaked: SequenceReservation[] = [];
  let cleaned = 0;

  for (const json of reservationsJson) {
    try {
      const reservation = JSON.parse(json) as SequenceReservation;
      const expiresAt = parseInt(reservation.expiresAt);

      if (expiresAt <= now) {
        leaked.push(reservation);
        await redis.lrem(key, 0, json);

        const cursorKey = `seq:res:${reservation.leaseId}:cursor`;
        await redis.del(cursorKey);

        await recordAuditEntry(account, "expire", redis, reservation.leaseId, undefined,
          `Leaked reservation cleaned: ${reservation.firstSequence}-${reservation.lastSequence}`);

        cleaned++;
      }
    } catch {
      await redis.lrem(key, 0, json);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log.info("Cleaned up leaked reservations", {
      account,
      cleaned,
      leakedCount: leaked.length,
    });
  }

  return { cleaned, leaked };
}

// ---------------------------------------------------------------------------
// Reservation Pre-Warming
// ---------------------------------------------------------------------------

export async function preWarmReservations(
  account: string,
  size: number,
  redis: Redis,
  reserveFn: (address: string, size: number) => Promise<SequenceReservation>
): Promise<SequenceReservation[]> {
  const reservations: SequenceReservation[] = [];

  const existing = await redis.lrange(`seq:reservations:${account}`, 0, -1);
  const existingCount = existing.length;

  const toPreWarm = Math.max(0, 3 - existingCount);

  for (let i = 0; i < toPreWarm; i++) {
    try {
      const reservation = await reserveFn(account, size);
      reservations.push(reservation);

      await recordAuditEntry(account, "pre_warm", redis, reservation.leaseId, undefined,
        `Pre-warmed reservation: ${reservation.firstSequence}-${reservation.lastSequence} (size: ${size})`);

      log.info("Pre-warmed reservation", {
        account,
        leaseId: reservation.leaseId,
        firstSequence: reservation.firstSequence,
        lastSequence: reservation.lastSequence,
      });
    } catch (err) {
      log.error("Failed to pre-warm reservation", {
        account,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  return reservations;
}

// ---------------------------------------------------------------------------
// Lock Monitoring
// ---------------------------------------------------------------------------

export async function monitorLockAcquisition(
  account: string,
  redis: Redis
): Promise<LockMonitoringInfo | null> {
  const lockKey = `seq:lock:${account}`;
  const lockValue = await redis.get(lockKey);

  if (!lockValue) {
    return null;
  }

  const monitorKey = `${LOCK_MONITOR_KEY_PREFIX}${account}`;
  const monitorJson = await redis.get(monitorKey);

  if (monitorJson) {
    try {
      return JSON.parse(monitorJson) as LockMonitoringInfo;
    } catch {}
  }

  return {
    account,
    lockKey,
    acquiredAt: new Date().toISOString(),
    durationMs: 0,
    holder: lockValue,
  };
}

export async function recordLockAcquisition(
  account: string,
  holder: string,
  redis: Redis
): Promise<void> {
  const monitorKey = `${LOCK_MONITOR_KEY_PREFIX}${account}`;
  const info: LockMonitoringInfo = {
    account,
    lockKey: `seq:lock:${account}`,
    acquiredAt: new Date().toISOString(),
    durationMs: 0,
    holder,
  };
  await redis.set(monitorKey, JSON.stringify(info), "PX", 10000);
}

export async function recordLockRelease(account: string, redis: Redis): Promise<void> {
  const monitorKey = `${LOCK_MONITOR_KEY_PREFIX}${account}`;
  await redis.del(monitorKey);
}

// ---------------------------------------------------------------------------
// Audit Trail
// ---------------------------------------------------------------------------

export async function recordAuditEntry(
  account: string,
  action: AuditTrailEntry["action"],
  redis: Redis,
  leaseId?: string,
  sequence?: string,
  details?: string
): Promise<void> {
  const entry: AuditTrailEntry = {
    timestamp: new Date().toISOString(),
    account,
    action,
    leaseId,
    sequence,
    details,
  };

  const key = `${AUDIT_KEY_PREFIX}${account}`;
  await redis.rpush(key, JSON.stringify(entry));
  await redis.ltrim(key, -MAX_AUDIT_ENTRIES, -1);
  await redis.expire(key, RETENTION_DAYS * 86400);
}

export async function getAuditTrail(
  account: string,
  redis: Redis,
  limit: number = 100
): Promise<AuditTrailEntry[]> {
  const key = `${AUDIT_KEY_PREFIX}${account}`;
  const entries = await redis.lrange(key, -limit, -1);
  const auditTrail: AuditTrailEntry[] = [];

  for (const json of entries) {
    try {
      auditTrail.push(JSON.parse(json) as AuditTrailEntry);
    } catch {
      continue;
    }
  }

  return auditTrail.reverse();
}

// ---------------------------------------------------------------------------
// Admin Force Release
// ---------------------------------------------------------------------------

export async function forceReleaseReservation(
  account: string,
  leaseId: string,
  redis: Redis,
  reason: string
): Promise<boolean> {
  const key = `seq:reservations:${account}`;
  const reservationsJson = await redis.lrange(key, 0, -1);

  for (const json of reservationsJson) {
    try {
      const reservation = JSON.parse(json) as SequenceReservation;
      if (reservation.leaseId === leaseId) {
        await redis.lrem(key, 0, json);
        const cursorKey = `seq:res:${leaseId}:cursor`;
        await redis.del(cursorKey);

        await recordAuditEntry(account, "force_release", redis, leaseId, undefined,
          `Force released reservation: ${reservation.firstSequence}-${reservation.lastSequence}. Reason: ${reason}`);

        log.info("Force released reservation", {
          account,
          leaseId,
          firstSequence: reservation.firstSequence,
          lastSequence: reservation.lastSequence,
          reason,
        });

        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Pre-Warm for High-Throughput Accounts
// ---------------------------------------------------------------------------

export async function autoPreWarmHighThroughputAccounts(
  redis: Redis,
  reserveFn: (address: string, size: number) => Promise<SequenceReservation>
): Promise<void> {
  const accountsKey = "seq:high_throughput_accounts";
  const accounts = await redis.smembers(accountsKey);

  for (const account of accounts) {
    try {
      await preWarmReservations(account, 50, redis, reserveFn);
    } catch (err) {
      log.error("Auto pre-warm failed", {
        account,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function markHighThroughputAccount(account: string, redis: Redis): Promise<void> {
  const accountsKey = "seq:high_throughput_accounts";
  await redis.sadd(accountsKey, account);
}

export async function unmarkHighThroughputAccount(account: string, redis: Redis): Promise<void> {
  const accountsKey = "seq:high_throughput_accounts";
  await redis.srem(accountsKey, account);
}
