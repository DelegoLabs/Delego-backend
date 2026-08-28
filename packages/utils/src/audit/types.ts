/**
 * Shared types for the audit-logging module (Issue #66).
 *
 * These mirror the data types specified in the issue. The corresponding
 * storage lives in `database/migrations/022_audit_log.sql` — an
 * append-only `audit_log` table with DB-level triggers rejecting UPDATE
 * and DELETE, plus a per-table `audit_retention_policies` config table.
 */
export type { Queryable } from "../softDelete/types.js";

export type AuditOperation = "INSERT" | "UPDATE" | "DELETE";

/** One row of the audit log, as named in the issue. */
export interface AuditLogEntry {
  id: string;
  /** Monotonically increasing sequence number (DB BIGSERIAL) — the authoritative chain-order key; see 022_audit_log.sql. */
  sequenceNum: number;
  tableName: string;
  recordId: string;
  operation: AuditOperation;
  userId: string | null;
  sessionId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  changedFields: string[];
  occurredAt: Date;
  transactionId: string;
  /** SHA-256 hex digest of the previous chain entry's `entryHash`, or null for the first entry. */
  prevHash: string | null;
  /** SHA-256 hex digest of this entry's own content chained with `prevHash`. */
  entryHash: string;
}

/** Fields the caller supplies; `id`, `occurredAt`, `prevHash`, and `entryHash` are computed by the store. */
export interface AuditLogEntryInput {
  tableName: string;
  recordId: string;
  operation: AuditOperation;
  userId?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  changedFields?: string[];
  transactionId: string;
}

/** Filtering/pagination options for the audit log query API, as named in the issue. */
export interface AuditQuery {
  tableName?: string;
  recordId?: string;
  operation?: AuditOperation;
  userId?: string;
  /** Inclusive lower bound on `occurredAt`. */
  from?: Date;
  /** Inclusive upper bound on `occurredAt`. */
  to?: Date;
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor` (id of the last row seen). */
  cursor?: string;
  sort?: "asc" | "desc";
}

export interface AuditQueryResult {
  entries: AuditLogEntry[];
  nextCursor: string | null;
}

/**
 * Retention/archival configuration for one table's audit entries
 * (Issue #66's RetentionPolicy type). Enforcement — the actual archival
 * job moving rows to S3/cold storage — is NOT implemented here; see
 * docs/deployment/audit-log-siem-retention.md. This type/table only
 * captures the *policy*, which a future archival job would read.
 */
export interface RetentionPolicy {
  tableName: string;
  retentionDays: number;
  archiveAfterDays: number | null;
  archiveStorage: "s3" | "cold_storage" | null;
  updatedAt: Date;
}

/** Result of walking the hash chain looking for tampering. */
export interface ChainVerificationResult {
  valid: boolean;
  entriesChecked: number;
  /** The id of the first entry whose hash doesn't match, if any. */
  firstBrokenEntryId: string | null;
  reason: string | null;
}
