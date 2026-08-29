/**
 * OutboxRelay (Issue #33) — drains `service_event_outbox` and publishes to Redis.
 *
 * The outbox (`insertServiceEventOutbox`, migration 005) existed with no relay: nothing
 * drained pending rows, so producers published straight to Redis pub/sub and any crash
 * between the DB commit and the publish call permanently lost the event. This worker
 * closes that gap by batch-polling `pending` rows, publishing each through the existing
 * `RedisPublisher` (src/pubsub/publisher.ts), and marking the row `published` — or
 * retrying with exponential backoff + jitter on failure, and marking it terminally
 * `failed` after `maxAttempts`.
 *
 * Delivery guarantee: at-least-once, not exactly-once. A crash between a successful
 * Redis publish and the `markPublished` write would cause the same row to be
 * re-claimed and re-published on the next poll. Consumers MUST dedupe on the
 * `processed_messages` table (see ../messaging/processed-messages.ts, migration 006)
 * rather than assume the outbox alone gives them exactly-once delivery — this mirrors
 * how contract-event consumers already dedupe today.
 *
 * Multi-instance safety: `claimPendingBatch` (implemented per-store) uses
 * `SELECT ... FOR UPDATE SKIP LOCKED` in the Postgres backing store, so N orchestrator
 * instances can run this relay concurrently and each claimed row is only ever
 * processed by one of them at a time.
 */
import { createLogger, type Logger } from "@delegolabs/utils";
import { RedisPublisher } from "../pubsub/publisher.js";
import type { RedisClient } from "../pubsub/types.js";
import {
  getServiceEventOutboxStore,
  type ServiceEventOutboxRecord,
  type ServiceEventOutboxStore,
} from "./service-event-outbox.js";

const log = createLogger("orchestrator:outbox-relay", process.env.LOG_LEVEL ?? "info");

export interface OutboxRelayMetrics {
  polls: number;
  claimed: number;
  published: number;
  /** Failed attempts that will be retried (row stays `pending`). */
  retried: number;
  /** Rows that exhausted maxAttempts and were marked terminally `failed`. */
  exhausted: number;
}

export interface OutboxRelayOptions {
  store?: ServiceEventOutboxStore;
  /** Redis client used by the underlying RedisPublisher. Required to actually publish. */
  redisClient: RedisClient;
  log?: Logger;
  /** Rows claimed per poll cycle. */
  batchSize?: number;
  /** Poll interval in ms when idle. */
  pollIntervalMs?: number;
  /** Attempts (including the first) before a row is marked terminally `failed`. */
  maxAttempts?: number;
  /** Base delay for exponential backoff between retry attempts, in ms. */
  baseBackoffMs?: number;
  /** Upper bound for the backoff delay, in ms — caps runaway exponential growth. */
  maxBackoffMs?: number;
  onMetrics?: (metrics: OutboxRelayMetrics) => void;
  onError?: (error: Error) => void;
}

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 200;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * Computes the exponential backoff delay for a given attempt count, with full jitter
 * (random value in [0, cappedDelay]) so that a burst of simultaneously-failing rows
 * doesn't retry in lockstep and re-overwhelm a recovering Redis instance.
 */
export function computeBackoffDelayMs(
  attempts: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
  random: () => number = Math.random
): number {
  const exponential = baseBackoffMs * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(exponential, maxBackoffMs);
  return Math.floor(random() * capped);
}

/**
 * Runs a single relay cycle: claims up to `batchSize` due rows and publishes each in
 * turn. Exposed standalone (not just via startOutboxRelay) so tests can drive exact
 * cycles without timers.
 */
export async function runOutboxRelayCycle(
  store: ServiceEventOutboxStore,
  publisher: Pick<RedisPublisher, "publish">,
  options: {
    batchSize?: number;
    maxAttempts?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    log?: Logger;
    now?: () => Date;
  } = {}
): Promise<OutboxRelayMetrics> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const logger = options.log ?? log;
  const now = options.now ?? (() => new Date());

  const metrics: OutboxRelayMetrics = {
    polls: 1,
    claimed: 0,
    published: 0,
    retried: 0,
    exhausted: 0,
  };

  const batch: ServiceEventOutboxRecord[] = await store.claimPendingBatch(batchSize, now());
  metrics.claimed = batch.length;

  if (batch.length === 0) {
    return metrics;
  }

  logger.info("OutboxRelay claimed batch", { count: batch.length });

  for (const row of batch) {
    try {
      const result = await publisher.publish(row.topic, JSON.stringify(row.payload));
      if (!result.delivered) {
        throw new Error(result.error ?? "publish did not report delivery");
      }
      await store.markPublished(row.id, now());
      metrics.published += 1;
      logger.info("OutboxRelay published event", { id: row.id, topic: row.topic });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextAttempts = row.attempts + 1;
      const delayMs = computeBackoffDelayMs(nextAttempts, baseBackoffMs, maxBackoffMs);
      const nextAttemptAt = new Date(now().getTime() + delayMs);

      await store.recordFailure(row.id, message, nextAttemptAt, maxAttempts);

      if (nextAttempts >= maxAttempts) {
        metrics.exhausted += 1;
        logger.error("OutboxRelay exhausted retries, marking failed", {
          id: row.id,
          topic: row.topic,
          attempts: nextAttempts,
          maxAttempts,
          error: message,
        });
      } else {
        metrics.retried += 1;
        logger.warn("OutboxRelay publish failed, will retry", {
          id: row.id,
          topic: row.topic,
          attempts: nextAttempts,
          maxAttempts,
          nextAttemptInMs: delayMs,
          error: message,
        });
      }
    }
  }

  return metrics;
}

export interface OutboxRelayHandle {
  /** Stops polling and resolves once any in-flight batch finishes (graceful shutdown). */
  stop(): Promise<void>;
}

/**
 * Starts the OutboxRelay background worker: polls on an interval, claims a batch,
 * publishes it, and reschedules — indefinitely, until stop() is called.
 *
 * Graceful shutdown: stop() clears the poll timer immediately (no new cycle starts)
 * and then awaits the in-flight cycle promise, so a shutdown never abandons a batch
 * mid-publish or leaves claimed rows stuck until their lease-equivalent (next_attempt_at)
 * expires.
 */
export function startOutboxRelay(options: OutboxRelayOptions): OutboxRelayHandle {
  const store = options.store ?? getServiceEventOutboxStore();
  const publisher = new RedisPublisher(options.redisClient, options.log ?? log);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const logger = options.log ?? log;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(runCycle, pollIntervalMs);
  };

  const runCycle = () => {
    if (stopped) return;
    inFlight = runOutboxRelayCycle(store, publisher, {
      batchSize: options.batchSize,
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
      log: logger,
    })
      .then((metrics) => {
        options.onMetrics?.(metrics);
      })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error("OutboxRelay cycle failed", { error: error.message });
        options.onError?.(error);
      })
      .finally(() => {
        scheduleNext();
      });
  };

  logger.info("OutboxRelay started", { pollIntervalMs, batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE });
  runCycle();

  return {
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Drain: wait for whatever cycle is currently running (if any) to finish
      // publishing/marking its already-claimed batch before returning.
      await inFlight;
      logger.info("OutboxRelay stopped");
    },
  };
}
