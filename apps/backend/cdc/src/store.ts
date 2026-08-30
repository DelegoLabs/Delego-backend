/**
 * CDC persistence stores.
 *
 * Backing stores for:
 *   - replication-state checkpoints per slot (durable resume / failover),
 *   - published-event dedup records (exactly-once publication),
 *   - metric snapshots (dashboard history).
 *
 * Each store has an in-memory implementation for tests/local and a Postgres
 * implementation used in production.
 */

import type { Pool } from "pg";
import { createLogger, type Logger } from "@delegolabs/utils";

// ---------------------------------------------------------------------------
// Replication state
// ---------------------------------------------------------------------------

export interface ReplicationState {
  slotName: string;
  confirmedFlushLsn: string;
  lastProcessedAt?: string;
  updatedAt?: string;
}

export interface ReplicationStateStore {
  get(slotName: string): Promise<ReplicationState | null>;
  /** Advance/upsert the checkpoint for a slot. */
  set(state: ReplicationState): Promise<void>;
}

export class InMemoryReplicationStateStore implements ReplicationStateStore {
  private readonly states = new Map<string, ReplicationState>();

  async get(slotName: string): Promise<ReplicationState | null> {
    return this.states.get(slotName) ?? null;
  }

  async set(state: ReplicationState): Promise<void> {
    this.states.set(state.slotName, {
      ...state,
      lastProcessedAt: state.lastProcessedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  _data(): Map<string, ReplicationState> {
    return this.states;
  }
}

export class PostgresReplicationStateStore implements ReplicationStateStore {
  private readonly pool: Pool;
  private readonly log: Logger;

  constructor(pool: Pool, log?: Logger) {
    this.pool = pool;
    this.log = log ?? createLogger("cdc:state", process.env.LOG_LEVEL ?? "info");
  }

  async get(slotName: string): Promise<ReplicationState | null> {
    const res = await this.pool.query<{
      slot_name: string;
      confirmed_flush_lsn: string;
      last_processed_at: string | null;
      updated_at: string | null;
    }>(
      `SELECT slot_name, confirmed_flush_lsn, last_processed_at, updated_at
       FROM cdc_replication_state WHERE slot_name = $1`,
      [slotName]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      slotName: row.slot_name,
      confirmedFlushLsn: row.confirmed_flush_lsn,
      lastProcessedAt: row.last_processed_at ?? undefined,
      updatedAt: row.updated_at ?? undefined,
    };
  }

  async set(state: ReplicationState): Promise<void> {
    this.log.debug("Advancing replication checkpoint", {
      slot: state.slotName,
      lsn: state.confirmedFlushLsn,
    });
    await this.pool.query(
      `INSERT INTO cdc_replication_state (slot_name, confirmed_flush_lsn, last_processed_at, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (slot_name) DO UPDATE SET
         confirmed_flush_lsn = EXCLUDED.confirmed_flush_lsn,
         last_processed_at = EXCLUDED.last_processed_at,
         updated_at = NOW()`,
      [state.slotName, state.confirmedFlushLsn, state.lastProcessedAt]
    );
  }
}

// ---------------------------------------------------------------------------
// Published-event dedup
// ---------------------------------------------------------------------------

export interface PublishedEventRecord {
  slotName: string;
  lsn: string;
  seq: number;
  eventId: string;
}

export interface PublishedEventStore {
  /**
   * Record an event as published. Returns `true` if newly recorded (this batch
   * should proceed/publish), `false` if it was already recorded (skip — this
   * is a replay after a crash between publish and checkpoint).
   */
  recordAndCheck(event: PublishedEventRecord): Promise<boolean>;
}

export class InMemoryPublishedEventStore implements PublishedEventStore {
  private readonly keys = new Set<string>();

  async recordAndCheck(event: PublishedEventRecord): Promise<boolean> {
    const key = `${event.slotName}:${event.lsn}:${event.seq}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
}

export class PostgresPublishedEventStore implements PublishedEventStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async recordAndCheck(event: PublishedEventRecord): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO cdc_published_events (slot_name, lsn, seq, event_id, op, schema_name, table_name, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (slot_name, lsn, seq) DO NOTHING
       RETURNING id`,
      [
        event.slotName,
        event.lsn,
        event.seq,
        event.eventId,
        "INSERT", // op is informational; events are recorded post-publish
        "",
        "",
        "{}",
      ]
    );
    return (res.rowCount ?? 0) > 0;
  }
}
