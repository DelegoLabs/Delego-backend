/**
 * Postgres-backed persistence for the encryption module (#68).
 *
 * Implements the two storage seams the in-memory defaults cover:
 *  - {@link PostgresEncryptionKeyVersionStore} — `encryption_key_versions`
 *    (migration 038); survives process restarts so a rotation begun by one
 *    replica can be completed by another.
 *  - {@link PostgresKeyAccessAuditSink} — the append-only
 *    `encryption_audit_log` table (migration 038); the DB enforces
 *    immutability via triggers, giving the audit trail its tamper evidence.
 *
 * Uses the same query-builder style as `packages/utils/src/audit/`: plain
 * SQL against a `pg`-compatible Queryable (pool, client, or mock).
 */

import type { KeyAccessRecord } from "./audit.js";
import type { EncryptionKeyVersionRow, EncryptionKeyVersionStore } from "./rotation.js";
import { EncryptionError } from "./cipher.js";
import type { Queryable } from "../softDelete/types.js";

export type { Queryable } from "../softDelete/types.js";

interface EncryptionKeyVersionRowRow extends Record<string, unknown> {
  key_id: string;
  version: number;
  key_provider: string;
  wrapped_key: string;
  activated_at: Date | string;
  status: string;
}

function mapKeyRow(row: EncryptionKeyVersionRowRow): EncryptionKeyVersionRow {
  return {
    keyId: row.key_id,
    version: Number(row.version),
    keyProvider: row.key_provider as EncryptionKeyVersionRow["keyProvider"],
    wrappedKey: row.wrapped_key,
    activatedAt: row.activated_at instanceof Date ? row.activated_at.toISOString() : new Date(row.activated_at).toISOString(),
    status: row.status as EncryptionKeyVersionRow["status"],
  };
}

export class PostgresEncryptionKeyVersionStore implements EncryptionKeyVersionStore {
  constructor(private readonly db: Queryable) {}

  async insert(row: EncryptionKeyVersionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO encryption_key_versions (key_id, version, key_provider, wrapped_key, activated_at, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key_id, version) DO UPDATE
         SET wrapped_key = EXCLUDED.wrapped_key, status = EXCLUDED.status`,
      [
        row.keyId,
        row.version,
        row.keyProvider,
        row.wrappedKey,
        new Date(row.activatedAt),
        row.status,
      ]
    );
  }

  async get(keyId: string, version: number): Promise<EncryptionKeyVersionRow | undefined> {
    const result = await this.db.query<EncryptionKeyVersionRowRow>(
      `SELECT key_id, version, key_provider, wrapped_key, activated_at, status
       FROM encryption_key_versions WHERE key_id = $1 AND version = $2`,
      [keyId, version]
    );
    return result.rows[0] ? mapKeyRow(result.rows[0]) : undefined;
  }

  async list(keyId: string): Promise<EncryptionKeyVersionRow[]> {
    const result = await this.db.query<EncryptionKeyVersionRowRow>(
      `SELECT key_id, version, key_provider, wrapped_key, activated_at, status
       FROM encryption_key_versions WHERE key_id = $1 ORDER BY version ASC`,
      [keyId]
    );
    return result.rows.map(mapKeyRow);
  }

  async updateStatus(keyId: string, version: number, status: EncryptionKeyVersionRow["status"]): Promise<void> {
    await this.db.query(
      `UPDATE encryption_key_versions SET status = $3 WHERE key_id = $1 AND version = $2`,
      [keyId, version, status]
    );
  }
}

export interface PostgresKeyAccessAuditSinkOptions {
  /** On write failure, throw (true) or swallow + rely on in-memory copy (false). Default false. */
  failOpen?: boolean;
}

/**
 * Persists KeyAccessRecords to the append-only `encryption_audit_log` table.
 * The KeyAccessAuditor already catches sink errors; `failOpen: false` (the
 * default) matches its best-effort contract.
 */
export class PostgresKeyAccessAuditSink {
  constructor(
    private readonly db: Queryable,
    private readonly options: PostgresKeyAccessAuditSinkOptions = {}
  ) {}

  async write(record: KeyAccessRecord): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO encryption_audit_log (
           id, occurred_at, operation, table_name, column_name, key_id,
           key_version, actor_role, encryption_context, success, error
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          record.id,
          new Date(record.occurredAt),
          record.operation,
          record.table,
          record.column,
          record.keyId,
          record.keyVersion,
          record.actorRole,
          JSON.stringify(record.context),
          record.success,
          record.error ?? null,
        ]
      );
    } catch (err) {
      if (this.options.failOpen) return;
      const message = err instanceof Error ? err.message : String(err);
      throw new EncryptionError(`Failed to write encryption audit record: ${message}`);
    }
  }
}

export type { EncryptionKeyVersionRow, KeyAccessRecord };