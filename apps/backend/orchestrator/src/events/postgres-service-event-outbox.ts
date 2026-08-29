/**
 * Postgres-backed ServiceEventOutboxStore (Issue #33)
 *
 * Backs `service_event_outbox` (database/migrations/005_service_event_outbox.sql,
 * extended with retry/claim columns by 017_service_event_outbox_relay.sql).
 *
 * `claimPendingBatch` uses `SELECT ... FOR UPDATE SKIP LOCKED` inside a single
 * transaction so that multiple orchestrator instances can run OutboxRelay
 * concurrently without two of them claiming (and therefore double-publishing)
 * the same row — a competing transaction just skips rows already locked by
 * another in-flight claim instead of blocking on them.
 */
import type { Pool, PoolClient } from "pg";
import type {
  InsertServiceEventOutboxInput,
  ServiceEventOutboxRecord,
  ServiceEventOutboxStatus,
  ServiceEventOutboxStore,
} from "./service-event-outbox.js";

interface OutboxRow {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  status: ServiceEventOutboxStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: OutboxRow): ServiceEventOutboxRecord {
  return {
    id: row.id,
    topic: row.topic,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresServiceEventOutboxStore implements ServiceEventOutboxStore {
  constructor(private readonly pool: Pool) {}

  async insert(input: InsertServiceEventOutboxInput): Promise<ServiceEventOutboxRecord> {
    const { rows } = await this.pool.query<OutboxRow>(
      `INSERT INTO service_event_outbox (topic, payload, status)
       VALUES ($1, $2::jsonb, $3)
       RETURNING *`,
      [input.topic, JSON.stringify(input.payload), input.status ?? "pending"]
    );
    return toRecord(rows[0]);
  }

  async claimPendingBatch(limit: number, now: Date): Promise<ServiceEventOutboxRecord[]> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE SKIP LOCKED: rows already locked by a concurrent relay's in-flight
      // transaction are excluded from the result set rather than blocking this query.
      const { rows } = await client.query<OutboxRow>(
        `SELECT * FROM service_event_outbox
         WHERE status = 'pending' AND next_attempt_at <= $1
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit]
      );

      if (rows.length === 0) {
        await client.query("COMMIT");
        return [];
      }

      // Bump updated_at while still holding the row locks so a concurrent claim batch
      // (which only reads next_attempt_at/status, both untouched here) cannot mistake
      // an in-flight claim for one that was never picked up.
      const ids = rows.map((r) => r.id);
      await client.query(
        `UPDATE service_event_outbox SET updated_at = $1 WHERE id = ANY($2::uuid[])`,
        [now, ids]
      );

      await client.query("COMMIT");
      return rows.map(toRecord);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async markPublished(id: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE service_event_outbox
       SET status = 'published', published_at = $2, updated_at = $2
       WHERE id = $1`,
      [id, now]
    );
  }

  async recordFailure(id: string, error: string, nextAttemptAt: Date, maxAttempts: number): Promise<void> {
    await this.pool.query(
      `UPDATE service_event_outbox
       SET attempts = attempts + 1,
           last_error = $2,
           updated_at = NOW(),
           status = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'pending' END,
           next_attempt_at = CASE WHEN attempts + 1 >= $4 THEN next_attempt_at ELSE $3 END
       WHERE id = $1`,
      [id, error, nextAttemptAt, maxAttempts]
    );
  }
}
