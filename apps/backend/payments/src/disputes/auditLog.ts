/**
 * Immutable audit log for dispute and partial-refund state transitions (Issue #46).
 *
 * Entries are append-only — the store interface intentionally exposes no
 * update/delete methods. Postgres-backed (`dispute_audit_log` from migration
 * 016) in production; in-memory by default for tests/local dev.
 */

import { Pool } from "pg";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:disputes:audit", process.env.LOG_LEVEL ?? "info");

export interface AuditLogEntry {
  disputeId?: string;
  escrowId: string;
  eventType: string;
  actor?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogStore {
  append(entry: Omit<AuditLogEntry, "createdAt">): Promise<AuditLogEntry>;
  listForDispute(disputeId: string): Promise<AuditLogEntry[]>;
}

export class InMemoryAuditLogStore implements AuditLogStore {
  private readonly entries: AuditLogEntry[] = [];

  async append(entry: Omit<AuditLogEntry, "createdAt">): Promise<AuditLogEntry> {
    const full: AuditLogEntry = { ...entry, createdAt: new Date().toISOString() };
    this.entries.push(full);
    return full;
  }

  async listForDispute(disputeId: string): Promise<AuditLogEntry[]> {
    return this.entries.filter((e) => e.disputeId === disputeId);
  }
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

export function _setPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export function _resetPoolForTesting(): void {
  pool = null;
}

export class PostgresAuditLogStore implements AuditLogStore {
  async append(entry: Omit<AuditLogEntry, "createdAt">): Promise<AuditLogEntry> {
    const { rows } = await getPool().query<{ created_at: Date }>(
      `INSERT INTO dispute_audit_log (dispute_id, escrow_id, event_type, actor, details)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING created_at`,
      [entry.disputeId ?? null, entry.escrowId, entry.eventType, entry.actor ?? null, JSON.stringify(entry.details)]
    );
    return { ...entry, createdAt: rows[0].created_at.toISOString() };
  }

  async listForDispute(disputeId: string): Promise<AuditLogEntry[]> {
    const { rows } = await getPool().query<{
      dispute_id: string | null;
      escrow_id: string;
      event_type: string;
      actor: string | null;
      details: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT dispute_id, escrow_id, event_type, actor, details, created_at
       FROM dispute_audit_log
       WHERE dispute_id = $1
       ORDER BY created_at ASC`,
      [disputeId]
    );
    return rows.map((r) => ({
      disputeId: r.dispute_id ?? undefined,
      escrowId: r.escrow_id,
      eventType: r.event_type,
      actor: r.actor ?? undefined,
      details: r.details,
      createdAt: r.created_at.toISOString(),
    }));
  }
}

let store: AuditLogStore = new InMemoryAuditLogStore();

export function setAuditLogStore(newStore: AuditLogStore): void {
  store = newStore;
}

export function resetAuditLogStore(): void {
  store = new InMemoryAuditLogStore();
}

export function enablePostgresAuditLogStore(): void {
  store = new PostgresAuditLogStore();
  log.info("Audit log store switched to PostgreSQL backend");
}

/** Appends one immutable audit record. Never throws — a logging failure must not block the caller's transaction. */
export async function recordAuditEvent(
  entry: Omit<AuditLogEntry, "createdAt">
): Promise<void> {
  try {
    await store.append(entry);
  } catch (err) {
    log.error("Failed to record audit log entry", {
      escrowId: entry.escrowId,
      disputeId: entry.disputeId,
      eventType: entry.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function listAuditLogForDispute(disputeId: string): Promise<AuditLogEntry[]> {
  return store.listForDispute(disputeId);
}
