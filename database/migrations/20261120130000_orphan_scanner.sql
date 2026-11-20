-- Migration: 20261120130000_orphan_scanner
-- Description: Discrepancy detection engine for unmatched Stellar Horizon
--              operations (Issue #621). A user can pay a platform escrow
--              account directly over Horizon without going through the web
--              frontend (or an inbound transaction can fail mid-flight),
--              leaving an "orphaned" on-chain payment with no corresponding
--              `payment_records` row. The orphan scanner crawls incoming
--              Horizon payments to the platform's escrow accounts, tries to
--              match each one to an open pending order (by memo or by
--              buyer address + amount), and quarantines whatever it can't
--              confidently match for manual review.
--
-- Design notes:
--   - `orphan_scanner_checkpoints` — one row per watched escrow account,
--     storing the Horizon `paging_token` cursor the crawler left off at, so
--     a restart resumes instead of rescanning the account's full history.
--   - `orphaned_transaction_quarantine` — every incoming payment the scanner
--     could not confidently link to a pending order, for manual review.
--     `tx_hash` is unique so repeated scans upsert instead of duplicating.

CREATE TABLE IF NOT EXISTS orphan_scanner_checkpoints (
  escrow_account VARCHAR(64) PRIMARY KEY,
  last_cursor VARCHAR(64) NOT NULL DEFAULT '0',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orphaned_transaction_quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash VARCHAR(64) NOT NULL,
  source_account VARCHAR(56) NOT NULL,
  destination_account VARCHAR(56) NOT NULL,
  amount_stroops BIGINT NOT NULL,
  memo TEXT,
  ledger_sequence BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_review',
  matched_order_id UUID REFERENCES orders(id),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by VARCHAR(100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orphan_quarantine_tx_hash
  ON orphaned_transaction_quarantine(tx_hash);

CREATE INDEX IF NOT EXISTS idx_orphan_quarantine_status
  ON orphaned_transaction_quarantine(status);

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_orphan_quarantine_status;
-- DROP INDEX IF EXISTS idx_orphan_quarantine_tx_hash;
-- DROP TABLE IF EXISTS orphaned_transaction_quarantine;
-- DROP TABLE IF EXISTS orphan_scanner_checkpoints;
