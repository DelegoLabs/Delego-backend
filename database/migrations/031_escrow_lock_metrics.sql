-- Migration: 017_escrow_lock_metrics
-- Description: Lock metrics tracking for escrow funding lock optimization (#147)

CREATE TABLE IF NOT EXISTS escrow_lock_metrics (
  id SERIAL PRIMARY KEY,
  escrow_id VARCHAR(128) NOT NULL,
  lock_type VARCHAR(32) NOT NULL DEFAULT 'adaptive',
  acquisitions INT NOT NULL DEFAULT 0,
  waits INT NOT NULL DEFAULT 0,
  avg_wait_ms NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_wait_ms NUMERIC(12,2) NOT NULL DEFAULT 0,
  contentions INT NOT NULL DEFAULT 0,
  timeouts INT NOT NULL DEFAULT 0,
  stolen_locks INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_lock_metrics_escrow_id
  ON escrow_lock_metrics(escrow_id);

CREATE INDEX IF NOT EXISTS idx_escrow_lock_metrics_contentions
  ON escrow_lock_metrics(contentions DESC);

CREATE INDEX IF NOT EXISTS idx_escrow_lock_metrics_updated_at
  ON escrow_lock_metrics(updated_at DESC);

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_escrow_lock_metrics_updated_at;
-- DROP INDEX IF EXISTS idx_escrow_lock_metrics_contentions;
-- DROP INDEX IF EXISTS idx_escrow_lock_metrics_escrow_id;
-- DROP TABLE IF EXISTS escrow_lock_metrics;
