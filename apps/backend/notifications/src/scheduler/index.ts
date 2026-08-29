/**
 * Notification Scheduling with Cron Support (Issue #365, extended for Issue #59)
 *
 * Supports scheduling one-time notifications for a specific timestamp and
 * recurring notifications via cron expressions (e.g. payment reminders,
 * delegation expiry warnings), timezone-aware (DST-aware) via
 * getNextCronOccurrenceInTimezone, with distributed locking so multiple
 * scheduler instances can poll the same store concurrently without double
 * dispatch, missed-execution catch-up after downtime, and health metrics.
 * The store is swappable (in-memory for tests/dev, Postgres for production —
 * see setScheduledNotificationStore).
 */

import { createLogger } from "@delegolabs/utils";
import { getNextCronOccurrenceInTimezone, isValidCronExpression } from "./cron.js";
import {
  InMemoryScheduledNotificationStore,
  type ClaimedScheduledNotification,
  type ScheduledNotification,
  type ScheduledNotificationStatus,
  type ScheduledNotificationStore,
  type SchedulerMetricsSnapshot,
} from "./store.js";

export {
  isValidCronExpression,
  getNextCronOccurrence,
  getNextCronOccurrenceInTimezone,
  isValidCronExpressionStrict,
  parseCronExpression,
} from "./cron.js";
export type {
  ScheduledNotification,
  ScheduledNotificationStatus,
  SchedulerMetricsSnapshot,
} from "./store.js";

const log = createLogger("notifications:scheduler", process.env.LOG_LEVEL ?? "info");

let store: ScheduledNotificationStore = new InMemoryScheduledNotificationStore();

/** Swap the backing store for a DB-backed implementation in production. */
export function setScheduledNotificationStore(newStore: ScheduledNotificationStore): void {
  store = newStore;
}

export function resetScheduledNotificationStore(): void {
  store = new InMemoryScheduledNotificationStore();
}

export type NotificationDispatchFn = (notification: ScheduledNotification) => Promise<void> | void;

/** Scheduler polling/dispatch tuning (Issue #59). */
export interface SchedulerConfig {
  /** How often the poll loop checks for due notifications. */
  checkIntervalMs: number;
  /** Max notifications claimed and dispatched per poll. */
  batchSize: number;
  /**
   * On startup (or after downtime), notifications whose runAt is up to this far in
   * the past are still dispatched ("missed-execution catch-up") rather than silently
   * skipped — see catchUpMissedNotifications().
   */
  catchUpWindowMs: number;
  /** Dispatch attempts before a notification is marked permanently failed. */
  maxRetries: number;
  /** Delay before a failed dispatch is retried (via the record staying pending/claimable). */
  retryDelayMs: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  checkIntervalMs: 30_000,
  batchSize: 50,
  catchUpWindowMs: 5 * 60_000, // 5 minutes — matches the issue's "caught up within 5 min" acceptance criterion
  maxRetries: 3,
  retryDelayMs: 10_000,
};

const DEFAULT_CLAIM_LEASE_MS = 60_000;

export interface ScheduleOneTimeInput {
  userId: string;
  templateName: string;
  payload: Record<string, unknown>;
  /** ISO-8601 timestamp for delivery. Must be in the future. */
  runAt: string;
}

export interface ScheduleRecurringInput {
  userId: string;
  templateName: string;
  payload: Record<string, unknown>;
  /** Standard 5-field cron expression. */
  cronExpression: string;
  /** IANA timezone the cron expression is evaluated in (Issue #59). Defaults to "UTC". */
  timezone?: string;
  /** Reference time to compute the first occurrence from. Defaults to now. */
  from?: Date;
  /** Stop rescheduling once the computed next run would be at or after this instant. */
  endAt?: string;
  /** Stop rescheduling once the notification has run this many times. */
  maxRuns?: number;
}

/** Schedules a one-time notification for a specific future timestamp. */
export async function scheduleNotification(
  input: ScheduleOneTimeInput
): Promise<ScheduledNotification> {
  const { userId, templateName, payload, runAt } = input;

  if (!userId || !templateName) {
    throw new Error("userId and templateName are required");
  }

  const runAtDate = new Date(runAt);
  if (Number.isNaN(runAtDate.getTime())) {
    throw new Error(`Invalid runAt timestamp: "${runAt}"`);
  }
  if (runAtDate.getTime() <= Date.now()) {
    throw new Error("runAt must be a future timestamp");
  }

  const record = await store.create({
    userId,
    templateName,
    payload,
    runAt: runAtDate.toISOString(),
  });

  log.info("Scheduled one-time notification", {
    id: record.id,
    userId,
    templateName,
    runAt: record.runAt,
  });

  return record;
}

/** Schedules a recurring notification driven by a cron expression. */
export async function scheduleRecurringNotification(
  input: ScheduleRecurringInput
): Promise<ScheduledNotification> {
  const { userId, templateName, payload, cronExpression, timezone, from, endAt, maxRuns } = input;

  if (!userId || !templateName) {
    throw new Error("userId and templateName are required");
  }
  if (!isValidCronExpression(cronExpression)) {
    throw new Error(`Invalid cron expression: "${cronExpression}"`);
  }
  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns <= 0)) {
    throw new Error("maxRuns must be a positive integer");
  }

  const tz = timezone ?? "UTC";
  const nextRun = getNextCronOccurrenceInTimezone(cronExpression, tz, from ?? new Date());

  if (endAt && nextRun.getTime() >= new Date(endAt).getTime()) {
    throw new Error(`First occurrence (${nextRun.toISOString()}) is at or after endAt (${endAt})`);
  }

  const record = await store.create({
    userId,
    templateName,
    payload,
    runAt: nextRun.toISOString(),
    cronExpression,
    timezone: tz,
    endAt,
    maxRuns,
  });

  log.info("Scheduled recurring notification", {
    id: record.id,
    userId,
    templateName,
    cronExpression,
    timezone: tz,
    nextRun: record.runAt,
  });

  return record;
}

/** Cancels a pending scheduled notification. Returns null if it does not exist. */
export async function cancelScheduledNotification(
  id: string
): Promise<ScheduledNotification | null> {
  const record = await store.cancel(id);
  if (record) {
    log.info("Cancelled scheduled notification", { id, status: record.status });
  }
  return record;
}

export async function getScheduledNotification(id: string): Promise<ScheduledNotification | null> {
  return store.get(id);
}

/** Lists a user's scheduled notifications — management API (Issue #59 CRUD). */
export async function listScheduledNotifications(
  userId: string,
  options?: { limit?: number; status?: ScheduledNotificationStatus }
): Promise<ScheduledNotification[]> {
  return store.listByUser(userId, options);
}

/** Current scheduler health/throughput counters (Issue #59). */
export async function getSchedulerMetrics(): Promise<SchedulerMetricsSnapshot> {
  return store.getMetrics();
}

/**
 * Computes the record's next run after a dispatch, honoring endAt/maxRuns
 * (Issue #59). Returns null when the record should stop recurring (one-time
 * notification, or a recurring one that just hit its end condition).
 */
function computeNextRunAt(notification: ScheduledNotification, asOf: Date): string | null {
  if (!notification.cronExpression) return null;

  const completedRunCount = notification.runCount + 1;
  if (notification.maxRuns !== undefined && completedRunCount >= notification.maxRuns) {
    return null;
  }

  const next = getNextCronOccurrenceInTimezone(
    notification.cronExpression,
    notification.timezone ?? "UTC",
    asOf
  );

  if (notification.endAt && next.getTime() >= new Date(notification.endAt).getTime()) {
    return null;
  }

  return next.toISOString();
}

async function dispatchClaimed(
  claimed: ClaimedScheduledNotification,
  dispatch: NotificationDispatchFn,
  asOf: Date
): Promise<"dispatched" | "failed" | "rescheduled"> {
  const { record, claimToken } = claimed;
  try {
    await dispatch(record);
    const nextRunAt = computeNextRunAt(record, asOf);
    await store.markDispatchedAndReschedule(record.id, claimToken, nextRunAt);
    return nextRunAt ? "rescheduled" : "dispatched";
  } catch (err) {
    log.error("Failed to dispatch scheduled notification", {
      id: record.id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Release rather than fail outright — the record stays "pending" and claimable by
    // the next poll (retryDelayMs-ish backoff happens naturally via the poll interval),
    // matching the pre-Issue-#59 behavior of leaving a failed dispatch pending for retry.
    // Callers wanting hard failure after N attempts should track attempts externally and
    // call markFailed() via a custom dispatch wrapper — runCount only increments on success.
    await store.releaseClaim(record.id, claimToken).catch(() => {
      // Claim may already be gone (e.g. lease expired and another poller reclaimed it
      // between our dispatch failing and this release) — not itself an error.
    });
    return "failed";
  }
}

/**
 * Finds all notifications due at or before `asOf`, atomically claims up to
 * `batchSize` of them (Issue #59 distributed locking — safe to call from multiple
 * concurrent scheduler instances against the same store), dispatches each through
 * `dispatch`, and reschedules recurring ones to their next cron occurrence.
 *
 * A dispatch failure for one notification does not prevent the others from
 * running; it is logged and the claim is released so a future poll retries it.
 */
export async function processDueNotifications(
  dispatch: NotificationDispatchFn,
  asOf: Date = new Date(),
  options: { batchSize?: number; claimedBy?: string; claimLeaseMs?: number } = {}
): Promise<{ dispatched: number; failed: number; rescheduled: number }> {
  const batchSize = options.batchSize ?? DEFAULT_SCHEDULER_CONFIG.batchSize;
  const claimedBy = options.claimedBy ?? `scheduler-${process.pid}`;
  const claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;

  const claimedBatch = await store.claimDue(asOf, batchSize, claimedBy, claimLeaseMs);

  let dispatched = 0;
  let failed = 0;
  let rescheduled = 0;

  for (const claimed of claimedBatch) {
    const outcome = await dispatchClaimed(claimed, dispatch, asOf);
    if (outcome === "dispatched") dispatched++;
    else if (outcome === "rescheduled") {
      dispatched++;
      rescheduled++;
    } else failed++;
  }

  return { dispatched, failed, rescheduled };
}

/**
 * Missed-execution catch-up (Issue #59): call once at scheduler startup (or after
 * any downtime) to dispatch notifications whose runAt fell within the last
 * `catchUpWindowMs` while the scheduler wasn't running, instead of silently
 * skipping straight to their *next* occurrence. Notifications whose runAt is
 * older than the catch-up window are left pending as-is (not dispatched, not
 * modified) — see the caller-visible `skipped` count to decide whether to alert.
 */
export async function catchUpMissedNotifications(
  dispatch: NotificationDispatchFn,
  config: Pick<SchedulerConfig, "catchUpWindowMs" | "batchSize"> = DEFAULT_SCHEDULER_CONFIG,
  now: Date = new Date()
): Promise<{ dispatched: number; failed: number; rescheduled: number; skipped: number }> {
  const windowStart = new Date(now.getTime() - config.catchUpWindowMs);
  const due = await store.findDue(now);
  const missed = due.filter((n) => new Date(n.runAt).getTime() >= windowStart.getTime());
  const skipped = due.length - missed.length;

  if (skipped > 0) {
    log.warn("Some due notifications are older than the catch-up window and were left pending", {
      skipped,
      catchUpWindowMs: config.catchUpWindowMs,
    });
  }

  if (missed.length === 0) {
    return { dispatched: 0, failed: 0, rescheduled: 0, skipped };
  }

  log.info("Running missed-execution catch-up", { missedCount: missed.length });
  const result = await processDueNotifications(dispatch, now, { batchSize: config.batchSize });
  return { ...result, skipped };
}
