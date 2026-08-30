// Issue #217 — Processed message deduplication for idempotent workers

import { Pool } from "pg";

export interface ProcessedMessageRecord {
  messageId: string;
  consumer: string;
  processedAt: string;
}

export interface ProcessedMessageStore {
  /**
   * Atomically claims a message for processing.
   * Returns true when this is the first claim (proceed), false on duplicate (skip).
   */
  checkAndMark(messageId: string, consumer: string): Promise<boolean>;
}

/** In-memory store for tests and local development. */
export class InMemoryProcessedMessageStore implements ProcessedMessageStore {
  private readonly processed = new Map<string, ProcessedMessageRecord>();

  async checkAndMark(messageId: string, consumer: string): Promise<boolean> {
    if (this.processed.has(messageId)) {
      return false;
    }

    this.processed.set(messageId, {
      messageId,
      consumer,
      processedAt: new Date().toISOString(),
    });
    return true;
  }

  /** Test helper — returns whether a message id was recorded. */
  has(messageId: string): boolean {
    return this.processed.has(messageId);
  }

  clear(): void {
    this.processed.clear();
  }
}

/**
 * Postgres-backed ProcessedMessageStore (Issue #36 — integration test coverage against
 * real infrastructure). Uses `INSERT ... ON CONFLICT (message_id) DO NOTHING RETURNING
 * message_id` exactly as prescribed above, so the atomic claim happens in a single
 * round-trip and races between concurrent workers resolve to exactly one winner.
 */
export class PostgresProcessedMessageStore implements ProcessedMessageStore {
  constructor(private readonly pool: Pool) {}

  async checkAndMark(messageId: string, consumer: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO processed_messages (message_id, consumer)
       VALUES ($1, $2)
       ON CONFLICT (message_id) DO NOTHING
       RETURNING message_id`,
      [messageId, consumer]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

let processedMessageStore: ProcessedMessageStore = new InMemoryProcessedMessageStore();

/** Swap the backing store for a Postgres implementation in production. */
export function setProcessedMessageStore(store: ProcessedMessageStore): void {
  processedMessageStore = store;
}

export function resetProcessedMessageStore(): void {
  processedMessageStore = new InMemoryProcessedMessageStore();
}

/**
 * Idempotently claims a message for a named consumer.
 * Returns true on first delivery (proceed), false when already processed (skip).
 *
 * Postgres implementations should use
 * `INSERT ... ON CONFLICT (message_id) DO NOTHING RETURNING message_id`.
 *
 * Backed by `processed_messages` (see database/migrations/006_processed_messages.sql).
 */
export async function checkAndMarkProcessed(
  messageId: string,
  consumer: string
): Promise<boolean> {
  if (!messageId || messageId.trim() === "") {
    throw new Error("messageId is required");
  }

  if (!consumer || consumer.trim() === "") {
    throw new Error("consumer is required");
  }

  return processedMessageStore.checkAndMark(messageId, consumer);
}
