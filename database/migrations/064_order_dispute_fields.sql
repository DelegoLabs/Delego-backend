-- Migration: 064_order_dispute_fields
-- Description: Persist on-chain dispute references on orders so dispute
-- event handlers can update order state and notify arbiters idempotently.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS evidence_hash TEXT,
  ADD COLUMN IF NOT EXISTS dispute_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS dispute_reason_code INTEGER,
  ADD COLUMN IF NOT EXISTS dispute_ledger_sequence BIGINT,
  ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_dispute_id
  ON orders(dispute_id)
  WHERE dispute_id IS NOT NULL;

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_orders_dispute_id;
-- ALTER TABLE orders
--   DROP COLUMN IF EXISTS disputed_at,
--   DROP COLUMN IF EXISTS dispute_ledger_sequence,
--   DROP COLUMN IF EXISTS dispute_reason_code,
--   DROP COLUMN IF EXISTS dispute_id,
--   DROP COLUMN IF EXISTS evidence_hash;
