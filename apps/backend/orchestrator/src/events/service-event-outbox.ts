// Issue #216 — Service event outbox for reliable Redis publishing
// Issue #33 — OutboxRelay claim/retry extensions (attempts, next_attempt_at, etc.)

import { randomUUID } from "node:crypto";

export type ServiceEventOutboxStatus = "pending" | "published" | "failed";

export interface ServiceEventOutboxRecord {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  status: ServiceEventOutboxStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertServiceEventOutboxInput {
  topic: string;
  payload: Record<string, unknown>;
  status?: ServiceEventOutboxStatus;
}

/**
 * Persistence boundary for the outbox. `claimPendingBatch` is the relay's core
 * concurrency primitive: it must atomically select and lock a batch of rows so
 * that two relay instances polling concurrently never both claim (and therefore
 * both publish) the same row. The Postgres implementation does this with
 * `SELECT ... FOR UPDATE SKIP LOCKED` inside a single transaction.
 */
export interface ServiceEventOutboxStore {
  insert(input: InsertServiceEventOutboxInput): Promise<ServiceEventOutboxRecord>;
  /**
   * Atomically claims up to `limit` rows that are `pending` (or `failed` and due for
   * retry) with `next_attempt_at <= now`, ordered oldest-first. Rows already locked by
   * another concurrent claim are skipped rather than waited on.
   */
  claimPendingBatch(limit: number, now: Date): Promise<ServiceEventOutboxRecord[]>;
  /** Marks a row published after a successful relay publish. */
  markPublished(id: string, now: Date): Promise<void>;
  /**
   * Records a failed publish attempt. When `attempts` (after increment) reaches
   * `maxAttempts`, the row is marked terminally `failed`; otherwise it stays `pending`
   * with `next_attempt_at` pushed out by the caller's backoff delay so it becomes
   * eligible for another claim later.
   */
  recordFailure(id: string, error: string, nextAttemptAt: Date, maxAttempts: number): Promise<void>;
}

/**
 * Expected publisher behavior:
 *
 * 1. Write the event to `service_event_outbox` in the same DB transaction as the
 *    domain mutation (status defaults to `pending`).
 * 2. A background relay worker (OutboxRelay, see ./outboxRelay.ts) polls rows where
 *    status = `pending`, publishes to Redis using `topic` as the channel, then marks
 *    status `published`.
 * 3. On publish failure, the relay retries with exponential backoff + jitter; after
 *    the configured max attempts the row is marked `failed` for manual replay.
 * 4. Consumers must not rely on the outbox row alone — use `processed_messages`
 *    (Issue #217) for idempotent handling after delivery, since relay retries and
 *    multi-instance claim races both make at-least-once (not exactly-once) delivery
 *    the only guarantee the outbox itself provides.
 */
export class InMemoryServiceEventOutboxStore implements ServiceEventOutboxStore {
  private readonly rows: ServiceEventOutboxRecord[] = [];
  /** Ids currently claimed by an in-flight batch — simulates row-level locking for tests. */
  private readonly claimed = new Set<string>();

  async insert(input: InsertServiceEventOutboxInput): Promise<ServiceEventOutboxRecord> {
    const now = new Date().toISOString();
    const record: ServiceEventOutboxRecord = {
      id: randomUUID(),
      topic: input.topic,
      payload: input.payload,
      status: input.status ?? "pending",
      attempts: 0,
      lastError: null,
      nextAttemptAt: now,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(record);
    return record;
  }

  async claimPendingBatch(limit: number, now: Date): Promise<ServiceEventOutboxRecord[]> {
    const eligible = this.rows
      .filter(
        (row) =>
          row.status === "pending" &&
          !this.claimed.has(row.id) &&
          new Date(row.nextAttemptAt).getTime() <= now.getTime()
      )
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, limit);

    for (const row of eligible) {
      this.claimed.add(row.id);
    }
    return eligible.map((row) => ({ ...row }));
  }

  async markPublished(id: string, now: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.status = "published";
    row.publishedAt = now.toISOString();
    row.updatedAt = now.toISOString();
    this.claimed.delete(id);
  }

  async recordFailure(id: string, error: string, nextAttemptAt: Date, maxAttempts: number): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.attempts += 1;
    row.lastError = error;
    row.updatedAt = new Date().toISOString();
    if (row.attempts >= maxAttempts) {
      row.status = "failed";
    } else {
      row.status = "pending";
      row.nextAttemptAt = nextAttemptAt.toISOString();
    }
    this.claimed.delete(id);
  }

  /** Test helper — returns a snapshot of stored rows. */
  snapshot(): readonly ServiceEventOutboxRecord[] {
    return [...this.rows];
  }

  clear(): void {
    this.rows.length = 0;
    this.claimed.clear();
  }
}

let outboxStore: ServiceEventOutboxStore = new InMemoryServiceEventOutboxStore();

/** Swap the backing store for a Postgres implementation in production. */
export function setServiceEventOutboxStore(store: ServiceEventOutboxStore): void {
  outboxStore = store;
}

export function resetServiceEventOutboxStore(): void {
  outboxStore = new InMemoryServiceEventOutboxStore();
}

/**
 * Inserts a pending outbox row before publishing critical Redis events.
 * Backed by `service_event_outbox` (see database/migrations/005_service_event_outbox.sql).
 */
export async function insertServiceEventOutbox(
  input: InsertServiceEventOutboxInput
): Promise<ServiceEventOutboxRecord> {
  if (!input.topic || input.topic.trim() === "") {
    throw new Error("topic is required");
  }

  if (input.payload == null || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("payload must be a JSON object");
  }

  return outboxStore.insert(input);
}

/** Accessor for OutboxRelay — reads the currently configured store (in-memory or Postgres). */
export function getServiceEventOutboxStore(): ServiceEventOutboxStore {
  return outboxStore;
}
