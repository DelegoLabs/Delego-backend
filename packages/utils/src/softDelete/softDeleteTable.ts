/**
 * Soft-delete operations for a Postgres table (Issue #67).
 *
 * This is a query-builder style helper, not an ORM: every function takes
 * a `Queryable` (matches `pg.Pool` / `pg.PoolClient` / `pg.Client` — see
 * `Queryable` in ./types.js) and a table name, and returns/executes plain
 * SQL. This matches the rest of the codebase, which talks to Postgres
 * directly via `pg` rather than through an ORM (see
 * `apps/backend/payments/src/escrowCoordinator/paymentRecordStore.ts` for
 * the established pattern this mirrors).
 *
 * Every table that wants soft delete must have added the columns from
 * `database/migrations/024_soft_delete.sql` (`deleted_at`, `deleted_by`,
 * `delete_reason`).
 */
import type { CascadeRelation, Queryable, SoftDeleteMetrics, SoftDeleteOptions } from "./types.js";

const DEFAULT_OPTIONS: SoftDeleteOptions = {
  cascade: false,
  requireReason: false,
};

export class SoftDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoftDeleteError";
  }
}

/** Quote an identifier (table/column name) for safe interpolation. Rejects anything but `[a-zA-Z_][a-zA-Z0-9_]*`. */
function quoteIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new SoftDeleteError(`Invalid identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export interface SoftDeleteTableConfig {
  tableName: string;
  options?: Partial<SoftDeleteOptions>;
  /** Tables (and their FK column) that should also be soft-deleted when this table's row is. */
  cascadeRelations?: CascadeRelation[];
}

/**
 * Soft-delete a single row by primary key `id`.
 *
 * Sets `deleted_at`/`deleted_by`/`delete_reason`. Idempotent: deleting an
 * already-deleted row is a no-op (WHERE clause excludes already-deleted
 * rows) and resolves without error, matching typical DELETE semantics.
 * When `cascadeRelations` is configured and `options.cascade` is true,
 * cascades to each related child table's rows referencing this id.
 */
export async function softDeleteRow(
  db: Queryable,
  config: SoftDeleteTableConfig,
  id: string,
  userId: string,
  reason?: string
): Promise<{ deleted: boolean }> {
  const options = { ...DEFAULT_OPTIONS, ...config.options };
  const table = quoteIdentifier(config.tableName);

  if (options.requireReason && !reason?.trim()) {
    throw new SoftDeleteError(
      `A non-empty reason is required to soft-delete rows in "${config.tableName}"`
    );
  }

  const result = await db.query(
    `UPDATE ${table}
     SET deleted_at = NOW(), deleted_by = $2, delete_reason = $3
     WHERE id = $1 AND deleted_at IS NULL`,
    [id, userId, reason ?? null]
  );

  const deleted = (result.rowCount ?? 0) > 0;

  if (deleted && options.cascade && config.cascadeRelations?.length) {
    for (const relation of config.cascadeRelations) {
      const childTable = quoteIdentifier(relation.childTable);
      const fkColumn = quoteIdentifier(relation.foreignKeyColumn);
      await db.query(
        `UPDATE ${childTable}
         SET deleted_at = NOW(), deleted_by = $2, delete_reason = $3
         WHERE ${fkColumn} = $1 AND deleted_at IS NULL`,
        [id, userId, reason ? `cascade: ${reason}` : "cascade delete from parent"]
      );
    }
  }

  return { deleted };
}

/**
 * Restore a soft-deleted row (clears `deleted_at`/`deleted_by`/`delete_reason`).
 *
 * Restoring an already-active (never deleted, or already restored) row is
 * a no-op that reports `restored: false` rather than throwing, so callers
 * can safely retry.
 */
export async function restoreRow(
  db: Queryable,
  config: SoftDeleteTableConfig,
  id: string
): Promise<{ restored: boolean }> {
  const table = quoteIdentifier(config.tableName);
  const result = await db.query(
    `UPDATE ${table}
     SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
     WHERE id = $1 AND deleted_at IS NOT NULL`,
    [id]
  );
  return { restored: (result.rowCount ?? 0) > 0 };
}

/**
 * Permanently delete a row (GDPR erasure). Requires the caller to pass
 * `confirm: true` — this is the "explicit confirmation" the issue's
 * acceptance criteria calls for, so a hard delete can never happen via an
 * accidental/default call path.
 *
 * By default only soft-deleted rows may be hard-deleted (forcing deletion
 * through the soft-delete step first, so there's always an audit trail of
 * *when* and *why* before permanent erasure). Pass `requireSoftDeletedFirst:
 * false` to allow hard-deleting an active row directly, for callers that
 * have their own justification (e.g. an admin GDPR tool with its own audit
 * trail).
 */
export async function hardDeleteRow(
  db: Queryable,
  config: SoftDeleteTableConfig,
  id: string,
  options: { confirm: true; requireSoftDeletedFirst?: boolean }
): Promise<{ deleted: boolean }> {
  if (options.confirm !== true) {
    throw new SoftDeleteError(
      `hardDeleteRow requires explicit confirm: true (table="${config.tableName}", id="${id}")`
    );
  }

  const table = quoteIdentifier(config.tableName);
  const requireSoftDeletedFirst = options.requireSoftDeletedFirst ?? true;

  const whereClause = requireSoftDeletedFirst
    ? "WHERE id = $1 AND deleted_at IS NOT NULL"
    : "WHERE id = $1";

  const result = await db.query(`DELETE FROM ${table} ${whereClause}`, [id]);
  return { deleted: (result.rowCount ?? 0) > 0 };
}

/** Row shape returned by `findById`/`findAll` helpers below. */
export interface SoftDeleteRow {
  id: string;
  deleted_at: Date | string | null;
  deleted_by: string | null;
  delete_reason: string | null;
  [key: string]: unknown;
}

/**
 * Fetch a single row by id, auto-filtering `deleted_at IS NULL` unless
 * `includeDeleted` is set. This is the "automatic WHERE deleted_at IS NULL
 * filtering" behavior from the issue, applied explicitly per call rather
 * than via ORM-level query middleware (this codebase has no ORM to hook
 * into — see module doc).
 */
export async function findById(
  db: Queryable,
  config: SoftDeleteTableConfig,
  id: string,
  includeDeleted = false
): Promise<SoftDeleteRow | null> {
  const table = quoteIdentifier(config.tableName);
  const whereClause = includeDeleted ? "WHERE id = $1" : "WHERE id = $1 AND deleted_at IS NULL";
  const result = await db.query<SoftDeleteRow>(`SELECT * FROM ${table} ${whereClause}`, [id]);
  return result.rows[0] ?? null;
}

/**
 * Fetch all non-deleted rows (or only deleted rows, via `onlyDeleted`).
 * Simple helper for admin/restore UIs; production listing endpoints with
 * their own filters should build on `withNotDeleted`/`withOnlyDeleted`
 * below rather than this.
 */
export async function findAll(
  db: Queryable,
  config: SoftDeleteTableConfig,
  opts: { onlyDeleted?: boolean; limit?: number; offset?: number } = {}
): Promise<SoftDeleteRow[]> {
  const table = quoteIdentifier(config.tableName);
  const whereClause = opts.onlyDeleted ? "WHERE deleted_at IS NOT NULL" : "WHERE deleted_at IS NULL";
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const result = await db.query<SoftDeleteRow>(
    `SELECT * FROM ${table} ${whereClause} ORDER BY id LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

/** Append ` AND deleted_at IS NULL` to an existing WHERE-less SQL fragment/base query. Helper for hand-written queries that want the standard filter without going through findById/findAll. */
export function withNotDeleted(baseWhereSql: string): string {
  return baseWhereSql.trim().length > 0
    ? `${baseWhereSql} AND deleted_at IS NULL`
    : "deleted_at IS NULL";
}

/** Append ` AND deleted_at IS NOT NULL` — the inverse of `withNotDeleted`, for restore/admin views. */
export function withOnlyDeleted(baseWhereSql: string): string {
  return baseWhereSql.trim().length > 0
    ? `${baseWhereSql} AND deleted_at IS NOT NULL`
    : "deleted_at IS NOT NULL";
}

/**
 * Compute `SoftDeleteMetrics` for a table from its current soft-delete
 * column state. `restoredCount`/`avgTimeToRestore` require an audit trail
 * of restore events (this table alone can't tell "restored" apart from
 * "never deleted" once `deleted_at` is cleared) — when
 * `@delegolabs/utils`'s audit-log module (Issue #66) is wired up for a
 * given table, pass its restore-event rows as `restoreEvents` to get real
 * numbers; otherwise those two fields are reported as 0 rather than
 * guessed at.
 */
export async function collectSoftDeleteMetrics(
  db: Queryable,
  config: SoftDeleteTableConfig,
  restoreEvents: Array<{ deletedAt: Date; restoredAt: Date }> = []
): Promise<SoftDeleteMetrics> {
  const table = quoteIdentifier(config.tableName);
  const result = await db.query<{ soft_deleted_count: string }>(
    `SELECT COUNT(*)::text AS soft_deleted_count FROM ${table} WHERE deleted_at IS NOT NULL`
  );

  const softDeletedCount = Number(result.rows[0]?.soft_deleted_count ?? 0);

  const avgTimeToRestore =
    restoreEvents.length === 0
      ? 0
      : restoreEvents.reduce((sum, e) => {
          const hours = (e.restoredAt.getTime() - e.deletedAt.getTime()) / (1000 * 60 * 60);
          return sum + hours;
        }, 0) / restoreEvents.length;

  return {
    tableName: config.tableName,
    softDeletedCount,
    restoredCount: restoreEvents.length,
    hardDeletedCount: 0,
    avgTimeToRestore,
  };
}
