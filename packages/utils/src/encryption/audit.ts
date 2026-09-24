/**
 * Key-access audit logging for column-level encryption (#68).
 *
 * Every encrypt/decrypt/rotate that touches a data key is recorded with the
 * encryption context (the AAD used) and the actor role (when supplied).
 * Records are written to an in-memory ring buffer by default so services
 * can get accountability with zero infrastructure; a persistent sink
 * (Postgres `encryption_audit_log` table in migration 038, or the existing
 * hash-chained `audit_log` table) can be plugged in via `setSink`.
 *
 * The audit sink is deliberately *not* the encryption hot path: sinks are
 * awaited when `flush() === 'sync'` or enqueued/best-effort otherwise, and
 * a failing sink never blocks or corrupts an encrypt/decrypt operation.
 */

import type { FieldAccessRole, KeyAccessOperation, KeyAccessRecord } from "@delegolabs/types";
import { createLogger, type Logger } from "../logger.js";
import { randomUUID } from "node:crypto";

export interface KeyAccessAuditSink {
  write(record: KeyAccessRecord): void | Promise<void>;
}

export interface KeyAccessAuditorOptions {
  /** Inject a persisted sink (e.g. Postgres). Defaults to none (memory only). */
  sink?: KeyAccessAuditSink;
  /** Max records retained in memory for `list()`. */
  maxRecords?: number;
}

const defaultAuditorOptions = { maxRecords: 10_000 };

export class KeyAccessAuditor {
  private readonly sink?: KeyAccessAuditSink;
  private readonly maxRecords: number;
  private readonly records: KeyAccessRecord[] = [];
  private readonly log: Logger;

  constructor(options: KeyAccessAuditorOptions = defaultAuditorOptions) {
    this.sink = options.sink;
    this.maxRecords = options.maxRecords ?? defaultAuditorOptions.maxRecords;
    this.log = createLogger("encryption:audit");
  }

  /**
   * Record a key-access event. Best-effort: sink errors are logged, never
   * thrown, so encryption/decryption callers are never blocked by auditing.
   */
  async record(input: {
    operation: KeyAccessOperation;
    keyId: string;
    keyVersion: number;
    table: string;
    column: string;
    context?: Record<string, string>;
    actorRole?: FieldAccessRole;
    success?: boolean;
    error?: string;
  }): Promise<KeyAccessRecord> {
    const record: KeyAccessRecord = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      table: input.table,
      column: input.column,
      operation: input.operation,
      keyId: input.keyId,
      keyVersion: input.keyVersion,
      actorRole: input.actorRole ?? null,
      context: input.context ?? {},
      success: input.success ?? true,
      ...(input.error ? { error: input.error } : {}),
    };

    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }

    if (this.sink) {
      try {
        await this.sink.write(record);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error("Failed to persist key access audit record", {
          table: record.table,
          column: record.column,
          error: message,
        });
      }
    } else if (!record.success) {
      this.log.warn("Key access denied/failed", {
        table: record.table,
        column: record.column,
        operation: record.operation,
        role: record.actorRole ?? undefined,
        error: record.error,
      });
    }

    return record;
  }

  /** In-memory records, newest first. */
  list(): KeyAccessRecord[] {
    return [...this.records].reverse();
  }

  /** Records matching a table/column, newest first. */
  listFor(table: string, column: string): KeyAccessRecord[] {
    return this.list().filter((r) => r.table === table && r.column === column);
  }

  clear(): void {
    this.records.length = 0;
  }

  get size(): number {
    return this.records.length;
  }
}

export type { KeyAccessOperation, KeyAccessRecord };