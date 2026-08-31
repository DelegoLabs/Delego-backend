/**
 * Schema evolution handling.
 *
 * Tracks the observed column layout per source table and assigns a monotonically
 * increasing version each time the layout changes (new/dropped columns or a
 * column's decoded type changes). The transformer uses the version a change was
 * observed against so downstream consumers can interpret a payload that was
 * shaped by an older layout.
 *
 * Storage: the postgres store persists versions to `cdc_schema_versions`; an
 * in-memory store backs tests and local dev.
 */

import type { Pool } from "pg";
import { createLogger, type Logger } from "@delegolabs/utils";

export interface SchemaVersion {
  schema: string;
  table: string;
  version: number;
  columns: Record<string, string>;
  detectedAt: string;
}

export interface SchemaEvolutionStore {
  /** Current version for a table, or 0 when unknown. */
  currentVersion(schema: string, table: string): Promise<number>;
  /** Version for a table at a specific version number. */
  getVersion(schema: string, table: string, version: number): Promise<SchemaVersion | null>;
  /** Record a new observed layout, returning the (new) version it was assigned. */
  recordLayout(
    schema: string,
    table: string,
    columns: Record<string, string>
  ): Promise<SchemaVersion>;
}

export class InMemorySchemaEvolutionStore implements SchemaEvolutionStore {
  private readonly versions = new Map<string, SchemaVersion>();
  private readonly current = new Map<string, number>();

  private key(schema: string, table: string): string {
    return `${schema}.${table}`;
  }

  async currentVersion(schema: string, table: string): Promise<number> {
    return this.current.get(this.key(schema, table)) ?? 0;
  }

  async getVersion(
    schema: string,
    table: string,
    version: number
  ): Promise<SchemaVersion | null> {
    return this.versions.get(`${this.key(schema, table)}#${version}`) ?? null;
  }

  async recordLayout(
    schema: string,
    table: string,
    columns: Record<string, string>
  ): Promise<SchemaVersion> {
    const key = this.key(schema, table);
    const prevVersion = this.current.get(key) ?? 0;
    const prev = prevVersion > 0 ? this.versions.get(`${key}#${prevVersion}`) : undefined;
    if (prev && sameLayout(prev.columns, columns)) {
      return prev;
    }
    const version = prevVersion + 1;
    const record: SchemaVersion = {
      schema,
      table,
      version,
      columns,
      detectedAt: new Date().toISOString(),
    };
    this.versions.set(`${key}#${version}`, record);
    this.current.set(key, version);
    return record;
  }
}

export class PostgresSchemaEvolutionStore implements SchemaEvolutionStore {
  private readonly pool: Pool;
  private readonly log: Logger;

  constructor(pool: Pool, log?: Logger) {
    this.pool = pool;
    this.log = log ?? createLogger("cdc:schema-evolution", process.env.LOG_LEVEL ?? "info");
  }

  async currentVersion(schema: string, table: string): Promise<number> {
    const res = await this.pool.query<{ version: number }>(
      `SELECT version FROM cdc_schema_versions
       WHERE schema_name = $1 AND table_name = $2
       ORDER BY version DESC LIMIT 1`,
      [schema, table]
    );
    return res.rows[0]?.version ?? 0;
  }

  async getVersion(
    schema: string,
    table: string,
    version: number
  ): Promise<SchemaVersion | null> {
    const res = await this.pool.query<{
      version: number;
      columns: Record<string, string>;
      detected_at: string;
    }>(
      `SELECT version, columns, detected_at FROM cdc_schema_versions
       WHERE schema_name = $1 AND table_name = $2 AND version = $3`,
      [schema, table, version]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      schema,
      table,
      version: row.version,
      columns: row.columns,
      detectedAt: row.detected_at,
    };
  }

  async recordLayout(
    schema: string,
    table: string,
    columns: Record<string, string>
  ): Promise<SchemaVersion> {
    const current = await this.currentVersion(schema, table);
    if (current > 0) {
      const existing = await this.getVersion(schema, table, current);
      if (existing && sameLayout(existing.columns, columns)) {
        return existing;
      }
    }
    const version = current + 1;
    const detectedAt = new Date().toISOString();
    this.log.info("Schema layout change detected", {
      schema,
      table,
      fromVersion: current,
      toVersion: version,
    });
    await this.pool.query(
      `INSERT INTO cdc_schema_versions (schema_name, table_name, version, columns, detected_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (schema_name, table_name, version) DO NOTHING`,
      [schema, table, version, JSON.stringify(columns), detectedAt]
    );
    return { schema, table, version, columns, detectedAt };
  }
}

function sameLayout(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}
