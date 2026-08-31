-- Migration: 029_cdc
-- Description: Change Data Capture (CDC) persistence: idempotent publication outbox,
--              replication slot checkpoint state, publication registry, and metric snapshots.

-- ---------------------------------------------------------------------------
-- cdc_publications
-- Tracks the logical replication publication each connector owns, so the
-- connector can reconcile its config against the database on startup and
-- surface drift/failover state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cdc_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  connector VARCHAR(32) NOT NULL CHECK (connector IN ('debezium', 'logical_replication')),
  tables JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- cdc_replication_state
-- Durable, per-slot checkpoint advanced after each batch fully commits. On
-- restart the connector resumes from `confirmed_flush_lsn` instead of the head
-- of the WAL, which is what makes failover/recovery lossless across restarts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cdc_replication_state (
  slot_name VARCHAR(255) PRIMARY KEY,
  confirmed_flush_lsn TEXT NOT NULL DEFAULT '0/0',
  last_restart_lsn TEXT,
  last_processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- cdc_published_events
-- Transactional outbox + idempotency record. The connector records every event
-- it publishes here, keyed by the connector-native change pointer (slot + LSN
-- + sequence), so a crash after the broker publish but before checkpoint does
-- NOT double-publish: the dedup key already exists on replay.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- cdc_schema_versions
-- Records schema-evolution events (add/alter/drop columns) observed on a
-- source table. The transformer projects events through the version recorded
-- here so that consumers can interpret payloads that were shaped by an older
-- layout.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cdc_schema_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_name VARCHAR(255) NOT NULL,
  table_name VARCHAR(255) NOT NULL,
  version INTEGER NOT NULL,
  columns JSONB NOT NULL DEFAULT '{}',
  detected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (schema_name, table_name, version)
);

-- ---------------------------------------------------------------------------
-- cdc_metric_snapshots
-- Historical metric snapshots that back the CDC monitoring dashboard lag and
-- throughput charts so they survive connector restarts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cdc_metric_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_name VARCHAR(255) NOT NULL,
  events_processed BIGINT NOT NULL DEFAULT 0,
  lag_ms BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL,
  errors JSONB NOT NULL DEFAULT '[]',
  snapshot_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cdc_published_events_slot_lsn
  ON cdc_published_events(slot_name, lsn, seq);

CREATE INDEX IF NOT EXISTS idx_cdc_published_events_event_id
  ON cdc_published_events(event_id);

CREATE INDEX IF NOT EXISTS idx_cdc_schema_versions_table
  ON cdc_schema_versions(schema_name, table_name);

CREATE INDEX IF NOT EXISTS idx_cdc_metric_snapshots_slot_time
  ON cdc_metric_snapshots(slot_name, snapshot_at);

-- Down migration (manual rollback)
-- DROP TABLE IF EXISTS cdc_publications;
-- DROP TABLE IF EXISTS cdc_replication_state;
-- DROP TABLE IF EXISTS cdc_published_events;
-- DROP TABLE IF EXISTS cdc_schema_versions;
-- DROP TABLE IF EXISTS cdc_metric_snapshots;
