-- Migration: 021_soft_delete
-- Description: Add soft-delete columns (deleted_at, deleted_by, delete_reason)
-- to core entity tables, plus a table registry + metrics view (Issue #67).
--
-- Scope: users, wallets, delegations, orders — the primary user-owned
-- entity tables from schema/001_initial.sql. Other tables (event logs,
-- ledgers, saga/workflow state) are intentionally excluded: those are
-- append-only/system-of-record tables where "soft delete" isn't a
-- meaningful operation, and adding unused nullable columns to them would
-- be schema noise without a corresponding behavior.
--
-- Application-level enforcement (auto-filtering deleted_at IS NULL,
-- restore, hard delete, cascade) lives in
-- packages/utils/src/softDelete/softDeleteTable.ts — this migration only
-- adds the storage and the lightweight bookkeeping objects that pure SQL
-- can express (indexes, a metrics view, a registry of which tables opted in).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

ALTER TABLE delegations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

-- Partial indexes: cheap "WHERE deleted_at IS NULL" scans stay fast as
-- tables grow, without indexing the (expected to be small) deleted subset.
CREATE INDEX IF NOT EXISTS idx_users_not_deleted ON users(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wallets_not_deleted ON wallets(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_delegations_not_deleted ON delegations(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_not_deleted ON orders(id) WHERE deleted_at IS NULL;

-- Registry of which tables have opted into the soft-delete pattern and how
-- they're configured. Lets `packages/utils/src/softDelete` (or an admin
-- tool) discover cascade relationships and options without hardcoding them
-- in application code.
CREATE TABLE IF NOT EXISTS soft_delete_registry (
  table_name TEXT PRIMARY KEY,
  cascade_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  hard_delete_after_days INTEGER,
  require_reason BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO soft_delete_registry (table_name, cascade_enabled, require_reason)
VALUES
  ('users', TRUE, TRUE),
  ('wallets', FALSE, TRUE),
  ('delegations', FALSE, FALSE),
  ('orders', FALSE, FALSE)
ON CONFLICT (table_name) DO NOTHING;

-- One row per (table, relation) describing which child tables cascade
-- when a parent row is soft-deleted. Mirrors the FK graph in
-- schema/001_initial.sql for the tables that cascade today (users only,
-- for now: wallets/delegations/orders all reference users).
CREATE TABLE IF NOT EXISTS soft_delete_cascade_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_table TEXT NOT NULL REFERENCES soft_delete_registry(table_name),
  child_table TEXT NOT NULL,
  foreign_key_column TEXT NOT NULL,
  UNIQUE (parent_table, child_table, foreign_key_column)
);

INSERT INTO soft_delete_cascade_relations (parent_table, child_table, foreign_key_column)
VALUES
  ('users', 'wallets', 'user_id'),
  ('users', 'delegations', 'user_id'),
  ('users', 'orders', 'user_id')
ON CONFLICT (parent_table, child_table, foreign_key_column) DO NOTHING;

-- A single view that unions soft-delete counts across all four tables, for
-- a quick operational glance without hitting each table individually.
-- `packages/utils/src/softDelete`'s collectSoftDeleteMetrics() queries a
-- single table per call; this view is the multi-table dashboard equivalent.
CREATE OR REPLACE VIEW soft_delete_metrics AS
  SELECT 'users' AS table_name,
         COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted_count,
         COUNT(*) AS total_count
  FROM users
  UNION ALL
  SELECT 'wallets',
         COUNT(*) FILTER (WHERE deleted_at IS NOT NULL),
         COUNT(*)
  FROM wallets
  UNION ALL
  SELECT 'delegations',
         COUNT(*) FILTER (WHERE deleted_at IS NOT NULL),
         COUNT(*)
  FROM delegations
  UNION ALL
  SELECT 'orders',
         COUNT(*) FILTER (WHERE deleted_at IS NOT NULL),
         COUNT(*)
  FROM orders;

-- Down migration (manual rollback)
-- DROP VIEW IF EXISTS soft_delete_metrics;
-- DROP TABLE IF EXISTS soft_delete_cascade_relations;
-- DROP TABLE IF EXISTS soft_delete_registry;
-- DROP INDEX IF EXISTS idx_orders_not_deleted;
-- DROP INDEX IF EXISTS idx_delegations_not_deleted;
-- DROP INDEX IF EXISTS idx_wallets_not_deleted;
-- DROP INDEX IF EXISTS idx_users_not_deleted;
-- ALTER TABLE orders DROP COLUMN IF EXISTS delete_reason, DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS deleted_at;
-- ALTER TABLE delegations DROP COLUMN IF EXISTS delete_reason, DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS deleted_at;
-- ALTER TABLE wallets DROP COLUMN IF EXISTS delete_reason, DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS deleted_at;
-- ALTER TABLE users DROP COLUMN IF EXISTS delete_reason, DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS deleted_at;
