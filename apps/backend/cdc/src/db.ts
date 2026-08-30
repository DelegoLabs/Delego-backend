/**
 * CDC Postgres pool.
 *
 * The CDC service needs a dedicated `pg.Pool` to run slot/publication management
 * and the state/dedup queries. We use the raw `pg` driver (rather than Sequelize)
 * because the logical replication connector operates at the SQL/WAL layer.
 */

import { Pool } from "pg";
import { createLogger, type Logger } from "@delegolabs/utils";

let log: Logger | null = null;
function getLog(): Logger {
  if (!log) log = createLogger("cdc:db", process.env.LOG_LEVEL ?? "info");
  return log;
}

/** Creates the Postgres pool used by the CDC connector + stores. */
export function createCdcPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.CDC_DB_POOL_MAX ?? 5),
    min: Number(process.env.CDC_DB_POOL_MIN ?? 1),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
}

/**
 * Ensures the CDC tables exist. Normally the schema is created by the
 * `database/migrations/029_cdc.sql` migration, but this acts as a belt-and-braces
 * bootstrap for local dev / tests against a fresh database.
 */
export async function ensureCdcSchema(pool: Pool): Promise<void> {
  const logger = getLog();
  logger.info("Ensuring CDC schema exists");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cdc_replication_state (
      slot_name VARCHAR(255) PRIMARY KEY,
      confirmed_flush_lsn TEXT NOT NULL DEFAULT '0/0',
      last_restart_lsn TEXT,
      last_processed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS cdc_published_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_name VARCHAR(255) NOT NULL,
      lsn TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      event_id VARCHAR(255) NOT NULL,
      op VARCHAR(16) NOT NULL,
      schema_name VARCHAR(255) NOT NULL,
      table_name VARCHAR(255) NOT NULL,
      payload JSONB NOT NULL,
      published_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (slot_name, lsn, seq)
    );
    CREATE TABLE IF NOT EXISTS cdc_schema_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      schema_name VARCHAR(255) NOT NULL,
      table_name VARCHAR(255) NOT NULL,
      version INTEGER NOT NULL,
      columns JSONB NOT NULL DEFAULT '{}',
      detected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (schema_name, table_name, version)
    );
    CREATE TABLE IF NOT EXISTS cdc_metric_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_name VARCHAR(255) NOT NULL,
      events_processed BIGINT NOT NULL DEFAULT 0,
      lag_ms BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL,
      errors JSONB NOT NULL DEFAULT '[]',
      snapshot_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  logger.info("CDC schema ensured");
}
