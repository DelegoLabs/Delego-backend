/**
 * Shared types for the soft-delete pattern (Issue #67).
 *
 * These mirror the data types specified in the issue.
 */

/** The soft-delete contract every entity/table opting into this pattern exposes. */
export interface SoftDeleteMixin {
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;

  softDelete(userId: string, reason?: string): Promise<void>;
  restore(): Promise<void>;
  hardDelete(): Promise<void>;
  isDeleted(): boolean;
}

/** Per-table configuration for how soft delete behaves. */
export interface SoftDeleteOptions {
  /** Soft delete related records (tables with an FK back to this one). */
  cascade: boolean;
  /** Auto hard-delete records this many days after they were soft-deleted. */
  hardDeleteAfterDays?: number;
  /** Require a non-empty `reason` argument to `softDelete`. */
  requireReason: boolean;
}

/** Aggregate counters for a table's soft-delete activity, as named in the issue. */
export interface SoftDeleteMetrics {
  tableName: string;
  softDeletedCount: number;
  restoredCount: number;
  hardDeletedCount: number;
  /** Average time (in hours) between a soft delete and its restore, for records that were restored. */
  avgTimeToRestore: number;
}

/** Minimal `pg`-compatible query surface — matches `pg.Pool`/`pg.PoolClient`/`pg.Client`. */
export interface Queryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** Describes one relationship for cascading soft delete, e.g. `orders.user_id -> users.id`. */
export interface CascadeRelation {
  /** Child table that references the parent being soft-deleted. */
  childTable: string;
  /** Foreign key column on the child table. */
  foreignKeyColumn: string;
}
